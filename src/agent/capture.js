// One screen capture: ffmpeg -> fragmented mp4 on stdout -> numbered chunks PUT to the bot's capture API
// (the same protocol as src/capture/page.js). Node built-ins only.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ACK_ERROR, AGENT_MIME, CHUNK_MS, STOP_REASON } from './protocol.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms) => { let t; return Promise.race([p, new Promise((r) => { t = setTimeout(r, ms); })]).finally(() => clearTimeout(t)); };
const DEF = { first: 8000, status: 5000, result: 3000, resultMax: 20 * 60e3, drain: 30000, quit: 5000, kill: 8000, retry: 1000, offline: 5 * 60e3, cap: 64 * 1048576 };
const ENDED = new Set([401, 404, 410, 413]); // the server ended this capture for good (as in page.js)
const PART = 8 * 1048576; // the server rejects chunks over 16 MB
const MAC_HELP = 'ffmpeg ไม่ส่งภาพมา: macOS ยังไม่อนุญาต Screen Recording ให้โปรแกรม Terminal — เปิดที่ System Settings > Privacy & Security > Screen & System Audio Recording แล้วปิดเปิด Terminal ใหม่';

// DRA_FFMPEG, else the bundled binary, else ffmpeg on PATH only for a developer run (no DRA_HOME). An installed agent
// (start.command / start.cmd set DRA_HOME) never falls back to some other ffmpeg: null, the caller refuses to record.
export const ffmpegPath = ({ env = process.env, dir, platform = process.platform, exists = existsSync } = {}) => {
  if (env.DRA_FFMPEG) return env.DRA_FFMPEG;
  const b = join(dir ?? '', 'bin', platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (dir && exists(b)) return b;
  return env.DRA_HOME ? null : 'ffmpeg';
};

// local copies the bot never confirmed are kept, but not forever: at startup drop <dir>/recordings/<capId>.mp4 older than maxMs
export function pruneRecordings(dir, maxMs = 7 * 24 * 3600e3, now = Date.now()) {
  const rec = join(dir, 'recordings');
  let names = [], n = 0;
  try { names = readdirSync(rec); } catch { return 0; }
  for (const f of names) {
    if (!/^[A-Za-z0-9_-]{1,64}\.mp4$/.test(f)) continue; // only what Capture writes
    try { if (now - statSync(join(rec, f)).mtimeMs > maxMs) { unlinkSync(join(rec, f)); n++; } } catch { /* gone or busy */ }
  }
  return n;
}

// scale: cap the width at 1920 and keep both sides even (yuv420p needs it)
const VF = "scale='trunc(min(1920,iw)/2)*2':-2";
// crop: an ffmpeg crop filter (capture area 'discord' on macOS), applied before the scale
export const buildArgs = (platform, input, crop = null) => [
  '-hide_banner', '-nostats', ...input, '-vf', crop ? `${crop},${VF}` : VF,
  ...(platform === 'darwin' ? ['-c:v', 'h264_videotoolbox', '-b:v', '2500k'] : ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '28']),
  '-pix_fmt', 'yuv420p', '-g', '30', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', 'pipe:1',
];

export class Capture {
  // cmd = the bot's `start` command; args = full ffmpeg args (buildArgs); dir = agent home (local copy in <dir>/recordings)
  constructor({ server, cmd, bin, args, dir, platform = process.platform, T, spawnFn = spawn, fetchFn = fetch, log = () => {} }) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(cmd?.capId ?? '')) throw new Error('capId');
    Object.assign(this, { server, cmd, bin, args, platform, spawnFn, fetchFn, log, capId: cmd.capId });
    this.T = { ...DEF, ...T };
    this.api = `${server}/api/capture/${cmd.capId}`;
    this.file = join(dir, 'recordings', `${cmd.capId}.mp4`);
    Object.assign(this, { n: 0, pending: [], pendingBytes: 0, queue: [], queued: 0, sentBytes: 0, sent0: false, dropped: 0, lost: 0, tail: '', session: '' });
    Object.assign(this, { live: false, dead: false, over: false, endStatus: 0, closedFlag: false, uploading: null, lastOk: 0, startedAt: 0 });
    this.finished = new Promise((r) => { this.fin = r; }); // recording over and flushed: { reason }
    this.final = new Promise((r) => { this.fin2 = r; });   // bot's result known: { kept, file, why }
  }

  get auth() { return { Authorization: `Bearer ${this.session}` }; }

  // -> { ok: true } once ffmpeg produced bytes AND the bot accepted the claim, else { ok: false, error, detail }
  async start() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    this.tee = createWriteStream(this.file, { mode: 0o600 }); // local copy (D17)
    this.tee.on('error', () => { this.tee = null; }); // a full disk must not kill the upload
    let p;
    try { p = this.p = this.spawnFn(this.bin, this.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); } catch (e) { return this.#fail(e.message); }
    this.closed = new Promise((r) => {
      p.once('close', () => { this.closedFlag = true; r(); });
      p.once('error', (e) => { this.spawnErr = e; this.closedFlag = true; r(); });
    });
    p.stdin.on('error', () => {});
    p.stderr.on('data', (d) => { this.tail = (this.tail + d).slice(-2000); });
    p.stdout.on('data', (d) => this.#data(d));
    this.closed.then(() => { if (this.live && !this.over && !this.stopP) this.#crashed(); });

    let t;
    const first = await new Promise((res) => {
      this.gotFirst = () => res(true);
      this.closed.then(() => res(false));
      t = setTimeout(() => res(null), this.T.first);
    });
    clearTimeout(t);
    if (first !== true) {
      const help = first === null && this.platform === 'darwin' ? MAC_HELP : null;
      await this.#kill();
      return this.#fail(help ?? (this.tail.trim().slice(-400) || this.spawnErr?.message || (first === null ? 'ffmpeg ไม่ส่งภาพมา' : 'ffmpeg หยุดทำงาน')));
    }
    const r = await this.#claim();
    if (!r.ok) { await this.#kill(); return this.#fail(r.detail); }
    Object.assign(this, { session: r.cfg.session, live: true, startedAt: Date.now(), lastOk: Date.now() });
    const ms = Number(r.cfg.chunkMs ?? this.cmd.chunkMs ?? CHUNK_MS);
    this.chunkT = setInterval(() => this.#cut(), Math.min(Math.max(ms || CHUNK_MS, 100), 10000));
    this.statusT = setInterval(() => this.#status(), this.T.status);
    if (this.cmd.maxMs > 0) this.maxT = setTimeout(() => this.stop(STOP_REASON.local), this.cmd.maxMs + 60000); // failsafe if the bot is gone
    this.#cut(); // chunk 0 (the mp4 header) right away
    if (this.closedFlag) this.#crashed();
    return { ok: true };
  }

  async #claim() {
    try {
      const res = await this.fetchFn(`${this.api}/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ token: this.cmd.token, mime: AGENT_MIME }),
      });
      if (!res.ok) return { ok: false, detail: `บอทไม่รับการอัดนี้ (${res.status})` };
      const cfg = await res.json().catch(() => ({}));
      return typeof cfg.session === 'string' && cfg.session ? { ok: true, cfg } : { ok: false, detail: 'บอทตอบผิดรูปแบบ' };
    } catch { return { ok: false, detail: 'เชื่อมต่อบอทไม่ได้' }; }
  }

  #fail(detail) {
    const rm = () => { try { unlinkSync(this.file); } catch { /* never created */ } };
    const tee = this.tee; this.tee = null;
    if (tee) { tee.once('close', rm); tee.destroy(); } // the file may only be created once the stream opens
    rm();
    this.fin({ reason: 'failed' }); this.fin2({ kept: false, file: this.file, why: 'failed' });
    return { ok: false, error: ACK_ERROR.ffmpeg, detail };
  }

  #data(d) {
    this.tee?.write(d);
    this.pending.push(d); this.pendingBytes += d.length;
    this.gotFirst?.(); this.gotFirst = null;
  }

  #cut() {
    if (!this.pendingBytes) return;
    const all = Buffer.concat(this.pending);
    this.pending = []; this.pendingBytes = 0;
    for (let o = 0; o < all.length; o += PART) {
      const buf = all.subarray(o, o + PART);
      this.queue.push({ seq: this.n++, buf }); this.queued += buf.length;
    }
    // memory cap: drop the oldest queued chunk that is not in flight (index 0) and not the header; the server notes the gap
    while (this.queued > this.T.cap) {
      const i = this.queue.findIndex((q, k) => k > 0 && q.seq);
      if (i < 0) break;
      this.queued -= this.queue[i].buf.length; this.queue.splice(i, 1); this.dropped++;
    }
    this.pump();
  }

  pump() {
    if (this.uploading) return this.uploading;
    this.uploading = (async () => {
      while (this.queue.length) { await this.#upload(this.queue[0]); this.queued -= this.queue[0].buf.length; this.queue.shift(); }
    })().finally(() => { this.uploading = null; });
    return this.uploading;
  }

  // chunk 0 holds the container header and is retried for as long as the capture lives; others give up after ~23 s
  async #upload(item) {
    for (let i = 0; ; i++) {
      if (this.dead || this.over) return;
      try {
        const res = await this.fetchFn(`${this.api}/chunk/${item.seq}`, {
          method: 'PUT', headers: { ...this.auth, 'Content-Type': 'video/mp4' }, body: item.buf, signal: AbortSignal.timeout(30000),
        });
        if (ENDED.has(res.status)) return this.#ended(res.status);
        if (res.ok) {
          this.lastOk = Date.now(); this.sentBytes += item.buf.length;
          if (item.seq === 0) this.sent0 = true;
          if ((await res.json().catch(() => ({}))).stop) this.stop(STOP_REASON.local);
          return;
        }
        if (res.status >= 400 && res.status < 500 && ![409, 429].includes(res.status)) { this.lost++; return; }
      } catch { /* network error: retry */ }
      if (item.seq !== 0 && i >= 5) { this.lost++; return; } // the bot's copy has a gap: keep ours
      await sleep(Math.min(this.T.retry * 2 ** i, this.T.retry * 8));
    }
  }

  async #status() {
    if (this.dead || this.over || this.polling) return;
    this.polling = true;
    try {
      const res = await this.fetchFn(`${this.api}/status`, { headers: this.auth, signal: AbortSignal.timeout(10000) });
      if (ENDED.has(res.status)) return this.#ended(res.status);
      if (res.ok) { this.lastOk = Date.now(); if ((await res.json().catch(() => ({}))).stop) this.stop(STOP_REASON.local); }
    } catch { /* offline: the server heartbeat decides */ } finally { this.polling = false; }
    if (!this.dead && !this.over && Date.now() - this.lastOk > this.T.offline) this.#ended(0); // the bot is gone for good
  }

  #ended(status) {
    if (this.dead) return;
    this.dead = true; this.endStatus = status;
    this.stop(STOP_REASON.local); // not awaited: may run inside the uploader that stop() waits for
  }

  #crashed() {
    this.crashed = true;
    this.log(`ffmpeg หยุดทำงานเอง: ${this.tail.trim().slice(-300)}`);
    this.stop(STOP_REASON.quit);
  }

  async #kill() {
    if (!this.p || this.closedFlag) return;
    this.p.kill('SIGKILL');
    await this.closed;
  }

  // 'q' on stdin lets ffmpeg finish the last fragment; escalate if it does not exit
  async #quit() {
    const p = this.p;
    if (!p || this.closedFlag) return;
    try { p.stdin.write('q'); p.stdin.end(); } catch { /* already gone */ }
    const t1 = setTimeout(() => p.kill('SIGINT'), this.T.quit), t2 = setTimeout(() => p.kill('SIGKILL'), this.T.kill);
    await this.closed;
    clearTimeout(t1); clearTimeout(t2);
  }

  // before the claim finished: abandon it (start() then reports a failure)
  cancel() { if (!this.live) this.p?.kill('SIGKILL'); }

  stop(reason = STOP_REASON.local) {
    if (!this.live) { this.cancel(); return this.finished; }
    this.stopP ??= this.#stop(reason);
    return this.stopP;
  }

  async #stop(reason) {
    clearInterval(this.chunkT); clearInterval(this.statusT); clearTimeout(this.maxT);
    await this.#quit();
    this.tee?.end();
    this.#cut();
    if (!this.dead) await within(this.pump(), this.T.drain);
    this.over = true;
    const posted = this.endStatus !== 401 && this.endStatus !== 404 && await this.#postStop(reason);
    this.fin({ reason, crashed: Boolean(this.crashed), tail: this.crashed ? this.tail.trim().slice(-300) : '' });
    this.#result(posted);
    return { file: this.file };
  }

  async #postStop(reason) {
    for (let i = 0; i < 3; i++) {
      try {
        const res = await this.fetchFn(`${this.api}/stop`, {
          method: 'POST', headers: { ...this.auth, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
          body: JSON.stringify({ reason, last: this.n - 1 }),
        });
        return res.ok;
      } catch { await sleep(this.T.retry); }
    }
    return false;
  }

  // D17: the local copy is deleted only once the bot confirms it holds the whole video: `received` (finalized with no
  // gaps, long before compose and upload end) or a finished result. Any other end keeps it (pruneRecordings: 7 days).
  async #result(posted) {
    let why = this.dead ? `server ${this.endStatus}` : !posted ? 'stop not delivered' : !this.sent0 ? 'first chunk not sent'
      : this.dropped || this.lost ? 'chunks lost' : '';
    if (!why) {
      why = 'no result';
      for (const until = Date.now() + this.T.resultMax; Date.now() < until;) {
        await sleep(this.T.result);
        try {
          const res = await this.fetchFn(`${this.api}/result`, { headers: this.auth, signal: AbortSignal.timeout(10000) });
          if (res.status === 401 || res.status === 404) { why = `server ${res.status}`; break; }
          if (!res.ok) continue;
          const r = await res.json();
          if (!r.ready && !r.received) continue;
          try { unlinkSync(this.file); } catch { /* already gone */ }
          return this.fin2({ kept: false, file: this.file, why: '', url: r.url ?? null });
        } catch { /* offline: keep waiting */ }
      }
    }
    this.fin2({ kept: true, file: this.file, why });
  }
}
