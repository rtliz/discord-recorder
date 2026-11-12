import { randomBytes, createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readdir, rename, rm, unlink } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline, finished } from 'node:stream/promises';
import { once } from 'node:events';

// records the sharer's screen through a page in their own browser (getDisplayMedia + MediaRecorder);
// the page uploads numbered chunks over HTTP (capture-server.js), stop() remuxes them into one file.
// Same shape as ScreenRecorder for index.js: stop() -> file path, exited, stopping, what.

export const publicUrl = (process.env.PUBLIC_URL ?? '').replace(/\/+$/, '');
export const captureEnabled = Boolean(publicUrl);
const MB = 1024 * 1024;
const MAX_BYTES = (Number(process.env.CAPTURE_MAX_MB) || 3072) * MB;     // one capture
// all captures still holding chunks on disk; k8s emptyDir is 20Gi and finalizing needs about as much again
const TOTAL_BYTES = (Number(process.env.CAPTURE_TOTAL_MB) || 8192) * MB;
let totalBytes = 0;
const KEY = randomBytes(32); // per process: a restart invalidates every link, which is fine (recordings die too)
// timings in ms; exported so tests can shrink them (production values are the defaults here)
export const T = { offer: 5 * 60000, link: 10 * 60000, dead: 45000, keep: 10 * 60000, beat: 5000, drainMax: 35000, silent: 15000, poll: 200 };

const registry = new Map(); // capId -> BrowserCapture, for the HTTP server
export const lookup = (capId) => registry.get(capId);

// error carrying the HTTP status (and JSON body) the server should answer with
const fail = (status, body = {}) => Object.assign(new Error(`http ${status}`), { status, body });
const sha = (s) => createHash('sha256').update(s).digest();
const sign = (capId, guildId, userId, exp) =>
  createHmac('sha256', KEY).update(`v1|${capId}|${guildId}|${userId}|${exp}`).digest('base64url');
const TOKEN = /^([A-Za-z0-9_-]{22})\.([0-9a-z]{1,11})\.([A-Za-z0-9_-]{43})$/;

// token -> its capture while the token is genuine and unexpired, else null (state is not checked here)
export function checkToken(token) {
  const m = TOKEN.exec(String(token ?? ''));
  if (!m) return null;
  const [, capId, exp, sig] = m;
  const rec = registry.get(capId);
  if (!rec || parseInt(exp, 36) <= Date.now()) return null;
  return timingSafeEqual(Buffer.from(sig), Buffer.from(sign(capId, rec.guildId, rec.owner, exp))) ? rec : null;
}
export const tokenCapId = (token) => TOKEN.exec(String(token ?? ''))?.[1] ?? null;

// one module-wide heartbeat: a live page that stopped polling is treated as closed
let beat;
const startBeat = () => {
  beat ??= setInterval(() => {
    for (const rec of registry.values()) {
      if (rec.state === 'live' && Date.now() - rec.lastSeen > T.dead) rec.exit(rec.via === 'agent' ? '⚠️ ตัวอัดหลุด (ปิดเครื่องหรือเน็ตหลุด)' : '⚠️ หน้าอัดจอถูกปิดหรือเน็ตหลุด', true, 'gone');
    }
  }, T.beat).unref();
};

// missing seqs in 0..last as runs: [0,1,2,5,6,9] last 9 -> 2 runs (3-4, 7-8)
const gaps = (have, last) => {
  let runs = 0;
  for (let s = 0, inGap = false; s <= last; s++) {
    if (!have.has(s)) { if (!inGap) runs++; inGap = true; } else inGap = false;
  }
  return runs;
};

export class BrowserCapture {
  constructor(dir, { guildId, owner, offerMs = T.offer, via = 'page' }) {
    Object.assign(this, {
      dir, guildId, owner, via, chunks: join(dir, 'chunks'),
      capId: randomBytes(16).toString('base64url'), kind: 'browser', what: via === 'agent' ? 'จอ (ตัวอัด)' : 'จอ (เบราว์เซอร์)',
      state: 'offered', bytes: 0, maxSeq: -1, lastSeen: Date.now(), notes: '',
      writes: new Set(), have: new Set(), inflight: new Set(), onLive: null,
    });
    this.exited = new Promise((r) => { this.resolveExit = r; });
    registry.set(this.capId, this);
    startBeat();
    if (offerMs) { // 0 = no expiry: ends only through stop()/exit()
      this.offerEnd = Date.now() + offerMs;
      this.offerTimer = setTimeout(() => this.state === 'offered' && this.exit('ไม่มีใครกดอัดจอภายใน 5 นาที'), offerMs);
      this.offerTimer.unref?.();
    }
  }

  // ended on its own (offer expired, page closed/stopped, size cap): index.js finishes it with this reason;
  // every self-exit is skip-worthy, the sharer has to stop sharing in Discord before being offered again
  // exitKind tells index.js why without parsing text: 'local' the owner stopped it (or the offer lapsed),
  // 'gone' the page/agent vanished or closed, 'cap' a size limit
  exit(reason, skip = true, kind = 'local') {
    if (this.exitReason || this.stopping) return;
    Object.assign(this, { exitReason: reason, exitSkip: skip, exitKind: kind, stopRequested: true });
    clearTimeout(this.offerTimer);
    this.resolveExit();
  }

  // fresh signed link each call; only usable while offered, and only once (claim)
  link(ms = T.link) {
    const exp = (Date.now() + ms).toString(36);
    return `${publicUrl}/capture/${this.capId}.${exp}.${sign(this.capId, this.guildId, this.owner, exp)}`;
  }

  // --- called by capture-server.js ---------------------------------------------

  claim(token, mime) {
    if (checkToken(token) !== this) throw fail(410, { stop: true });
    if (this.state === 'live' || this.state === 'stopping') throw fail(409);
    if (this.state !== 'offered' || this.stopRequested) throw fail(410, { stop: true });
    // check-and-set with no await in between: a second tab can't claim too
    const session = randomBytes(32).toString('base64url');
    const h264 = /^video\/mp4|h264|avc1/i.test(mime);
    Object.assign(this, {
      state: 'live', liveAt: Date.now(), lastSeen: Date.now(), session: sha(session), mime,
      input: mime.startsWith('video/mp4') ? 'mp4' : 'matroska', h264,
    });
    clearTimeout(this.offerTimer);
    this.ready = mkdir(this.chunks, { recursive: true });
    this.ready.catch(() => {}); // surfaced by the first chunk write
    try { Promise.resolve(this.onLive?.()).catch(console.error); } catch (e) { console.error(e); }
    return { session, chunkMs: 3000, videoBps: 2_000_000 };
  }

  authed(bearer) {
    return Boolean(this.session && bearer) && timingSafeEqual(sha(bearer), this.session);
  }

  seen() { this.lastSeen = Date.now(); }

  status() {
    this.seen();
    return { state: this.state, stop: Boolean(this.stopRequested) };
  }

  // stores one chunk; idempotent per seq so the page can retry blindly
  async putChunk(seq, stream, len) {
    if (this.state !== 'live' && this.state !== 'stopping') throw fail(410, { stop: true });
    if (seq > this.maxSeq + 50) throw fail(400);
    this.seen();
    if (this.have.has(seq)) { await finished(stream.resume()); return { ok: true, stop: Boolean(this.stopRequested) }; }
    if (this.inflight.has(seq)) throw fail(409);
    if (this.bytes + len > MAX_BYTES || totalBytes + len > TOTAL_BYTES) {
      this.exit(this.bytes + len > MAX_BYTES ? '⚠️ ไฟล์ใหญ่ถึงขีดจำกัด' : '⚠️ พื้นที่เก็บไฟล์ของบอทเต็ม', true, 'cap');
      throw fail(413, { stop: true });
    }
    this.bytes += len; // reserved now so parallel uploads can't overshoot the caps together
    totalBytes += len;
    this.inflight.add(seq);
    const write = this.writeChunk(seq, stream, len);
    this.writes.add(write);
    try {
      await write;
    } catch (e) {
      this.bytes -= len;
      totalBytes -= len;
      throw e;
    } finally {
      this.writes.delete(write);
      this.inflight.delete(seq);
    }
    this.have.add(seq);
    this.maxSeq = Math.max(this.maxSeq, seq);
    this.seen();
    return { ok: true, stop: Boolean(this.stopRequested) };
  }

  async writeChunk(seq, stream, len) {
    await this.ready;
    const base = join(this.chunks, String(seq).padStart(6, '0'));
    let n = 0;
    const count = new Transform({
      transform(c, _, cb) { n += c.length; cb(n > len ? fail(400) : null, c); },
    });
    try {
      await pipeline(stream, count, createWriteStream(`${base}.part`));
      if (n !== len) throw fail(400);
      await rename(`${base}.part`, `${base}.bin`);
    } catch (e) {
      await unlink(`${base}.part`).catch(() => {});
      throw e.status ? e : fail(400);
    }
  }

  // the page/agent says it stopped: reason 'page' | 'ended' | 'unload' | 'agent', last = its last seq
  pageStop(reason, last) {
    if (this.state !== 'live' && this.state !== 'stopping') throw fail(410, { stop: true });
    this.seen();
    // a bogus "last" must not invent thousands of gaps
    if (Number.isInteger(last) && last >= -1 && last <= this.maxSeq + 50) this.pageLast = last;
    this.pageReason = reason;
    const agent = this.via === 'agent';
    this.exit({
      page: '⏹️ หยุดจากหน้าอัดจอ',
      ended: '⏹️ เลิกแชร์จอในเบราว์เซอร์',
      agent: '⏹️ เจ้าของเครื่องกดหยุดที่ตัวอัด',
    }[reason] ?? (agent ? '⚠️ ตัวอัดถูกปิด' : '⚠️ หน้าอัดจอถูกปิด'),
    true, ['page', 'ended', 'agent'].includes(reason) ? 'local' : 'gone');
    return { ok: true, stop: true };
  }

  // --- called by index.js ------------------------------------------------------

  stop() {
    this.stopping = true; // synchronously, before any await
    this.stopRequested = true;
    this.stopP ??= this.finish();
    return this.stopP;
  }

  async finish() {
    clearTimeout(this.offerTimer);
    try {
      if (!this.liveAt) return null; // never claimed: nothing recorded
      this.state = 'stopping';
      // let the page flush MediaRecorder and its queue (it drains up to 30 s): wait for its stop, 35 s,
      // or a page that's already gone (nothing heard for 15 s). An agent gets 45 s: a slow uplink has a longer tail.
      const t0 = Date.now(), max = T.drainMax * (this.via === 'agent' ? 45 / 35 : 1);
      while (this.pageReason == null && Date.now() - t0 < max && Date.now() - this.lastSeen < T.silent) {
        await new Promise((r) => setTimeout(r, T.poll));
      }
      while (this.writes.size) await Promise.allSettled([...this.writes]);
      this.state = 'finalizing'; // no await since the loop's empty check: every later upload gets 410
      try {
        const out = await this.finalize();
        // the agent may delete its local copy now (/result {received}); not when chunks were missing
        this.received = !this.gapped;
        return out;
      } catch (e) {
        await rm(this.chunks, { recursive: true, force: true }); // nothing usable left in them
        throw e;
      }
    } finally {
      totalBytes -= this.bytes; // chunks are gone (merged or removed): free the shared budget
      this.bytes = 0;
      this.state = 'done';
      this.resolveExit(); // nobody waits on a ghost
      setTimeout(() => registry.delete(this.capId), T.keep).unref();
    }
  }

  async finalize() {
    const files = (await readdir(this.chunks).catch(() => []))
      .filter((f) => /^\d{6}\.bin$/.test(f)).map((f) => parseInt(f, 10)).sort((a, b) => a - b);
    const have = new Set(files);
    if (!have.has(0)) throw new Error('ไม่ได้รับวิดีโอจากเบราว์เซอร์');
    const missing = this.gapped = gaps(have, Math.max(this.pageLast ?? -1, this.maxSeq));
    if (missing) this.notes += `\n⚠️ วิดีโอขาดหาย ${missing} ช่วง`;
    const paths = files.map((s) => join(this.chunks, `${String(s).padStart(6, '0')}.bin`));
    const ext = this.h264 ? 'mp4' : 'webm';
    const out = join(this.dir, `screen.${ext}`);
    // remux only, never re-encode video; H.264 -> mp4 (audio to AAC), VP8/VP9 -> webm as-is
    const args = ['-y', '-fflags', '+genpts+discardcorrupt', '-err_detect', 'ignore_err',
      '-f', this.input, '-i', 'pipe:0', '-map', '0',
      ...(this.h264 ? ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'] : ['-c', 'copy']), out];
    const err = await ffmpeg(args, paths);
    if (err == null) {
      await rm(this.chunks, { recursive: true, force: true });
      return out;
    }
    console.error(`capture ${this.capId}: ffmpeg failed\n${err}`);
    // remux failed: the chunks concatenated are still the browser's own file, often playable
    const raw = join(this.dir, `screen-raw.${this.input === 'mp4' ? 'mp4' : 'webm'}`); // the browser's container
    await unlink(out).catch(() => {}); // ffmpeg's partial output: no half file next to the raw one
    const ws = createWriteStream(raw);
    await feed(paths, ws);
    ws.end();
    await finished(ws);
    this.notes += '\n⚠️ แปลงไฟล์ไม่สำเร็จ ส่งไฟล์ดิบแทน';
    await rm(this.chunks, { recursive: true, force: true });
    return raw;
  }
}

// writes the files into one stream in order, honouring backpressure (pipeline with end:false would
// leave listeners behind on the target for every chunk)
async function feed(paths, ws) {
  const closed = once(ws, 'close').then(() => { throw new Error('closed'); });
  closed.catch(() => {});
  for (const p of paths) {
    for await (const b of createReadStream(p)) {
      if (ws.destroyed) throw new Error('closed');
      if (!ws.write(b)) await Promise.race([once(ws, 'drain'), closed]);
    }
  }
}

// feeds the chunk files into ffmpeg's stdin in order; resolves null on success, else ffmpeg's stderr tail
async function ffmpeg(args, paths) {
  const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
  const exit = new Promise((r) => { proc.on('close', r); proc.on('error', (e) => { err += e.message; r(-1); }); });
  proc.stdin.on('error', () => {}); // EPIPE when ffmpeg quits early; its exit code tells the story
  const killer = setTimeout(() => proc.kill('SIGKILL'), 15 * 60000);
  await feed(paths, proc.stdin).catch(() => {}); // ffmpeg gone: its exit code below tells why
  proc.stdin.end();
  const code = await exit;
  clearTimeout(killer);
  return code === 0 ? null : err || `exit ${code}`;
}
