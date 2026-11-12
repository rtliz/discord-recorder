import { randomBytes, randomInt, createHash, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir, rename, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PROTOCOL, POLL_MS, GONE_MS, ACK_MS, CHUNK_MS, CMD, ACK_ERROR, AREA } from './agent/protocol.js';

// the bot side of the recorder agents: pairing, device store, long-poll sessions, start/stop commands
// node built-ins only, no discord.js (index.js and capture-server.js import this, never the reverse)
// Never log tokens, codes, secrets or Authorization headers.

// timings in ms; exported so tests can shrink them (production values are the defaults here)
export const T = {
  poll: POLL_MS,             // a parked GET /api/agent/poll is answered {cmds:[]} after this
  gone: GONE_MS,             // the active session counts as offline this long after its last poll (unless one is parked)
  ack: ACK_MS,               // start() waits this long for the ack
  pair: 10 * 60000,          // pairing token / 6-digit code lifetime
  seen: 10 * 60000,          // lastSeen is written to the store at most this often
  prune: 90 * 24 * 3600000,  // devices unseen this long are dropped at load
  window: 60000,             // the global pairing-failure bucket counts failures over this window
  old: 3600000,              // a replaced session is remembered (409 instead of 404) this long
};

// the signed capture token the agent claims with (the same one the page gets in its /capture/<token> link)
// duck-typed: any object with link(ms) -> '<PUBLIC_URL>/capture/<token>' (BrowserCapture); no import of browser-capture.js
export const capToken = (capture, ms) => capture.link(ms).split('/capture/').pop();

const PAIR_FAILS = 30;   // global wrong 6-digit code attempts per T.window before code attempts get 429
const CODE_FAILS = 5;    // wrong code attempts while a code is live before that code dies
const MAX_DEVICES = 10;  // per user: pairing an 11th drops the least recently seen
const CODE = /^\d{6}$/;
const VIDEO_BPS = 2_000_000; // same as BrowserCapture.claim
const MAX_BODY = 4096;
const BEARER = /^Bearer ([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
const SESSION = /^[A-Za-z0-9_-]{8,64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const AGENT_ERRORS = Object.values(ACK_ERROR).filter((e) => e !== ACK_ERROR.offline); // offline is hub-only

const sha = (s) => createHash('sha256').update(s).digest();
const rid = (n) => randomBytes(n).toString('base64url');
const str = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '');
// thrown errors carry the HTTP answer; capture-server's catch sends {status, body}
const fail = (status, body = { error: 'rejected' }) => Object.assign(new Error(`http ${status}`), { status, body });

const BASE = { 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const send = (res, status, body, headers = {}) => {
  if (res.headersSent || res.destroyed) return false;
  res.writeHead(status, { ...BASE, ...headers });
  res.end(body);
  return true;
};
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });

// small JSON object body (≤4 KB: hello carries the display list)
async function readJson(req) {
  if (!/^application\/json(\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw fail(415);
  let size = 0;
  const parts = [];
  for await (const c of req) {
    if ((size += c.length) > MAX_BODY) throw fail(413);
    parts.push(c);
  }
  try {
    const v = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch { /* falls through */ }
  throw fail(400);
}

export class AgentHub {
  // file: the device store, {devices:{[deviceId]:{userId, tag, hash, name, os, createdAt, lastSeen, guildId?}}}
  // guildId: the server /agent was used in (records paired before it was added have none)
  constructor({ file = process.env.AGENTS_FILE || 'data/agents.json' } = {}) {
    this.file = file;
    this.onChange = null; // (userId, online:boolean) => {}, set by index.js; fires on transitions only
    this.devs = {};
    this.writing = Promise.resolve(true);
    this.loaded = null;
    this.init();
  }

  init() {
    Object.assign(this, {
      pairs: new Map(),   // userId -> {userId, guildId, tag, token, code, expires, codeFails}
      tokens: new Map(),  // token -> pairing
      codes: new Map(),   // code -> pairing
      fails: [],          // timestamps of wrong 6-digit code attempts (global bucket, at most PAIR_FAILS kept)
      sess: new Map(),    // userId -> the active session
      old: new Map(),     // `${deviceId}.${session}` -> replacedAt
      buckets: new Map(), // deviceId -> {n, t}
      busy: new Map(),    // deviceId -> capture it was told to record (or is starting)
      seen: new Map(),    // deviceId -> last request (memory; the store gets it every T.seen)
      was: new Map(),     // userId -> last online value reported to onChange
    });
  }

  // reads the store (prunes stale devices); idempotent, index.js awaits it once at startup
  load() {
    this.loaded ??= this.read().catch((e) => { this.loaded = null; throw e; });
    return this.loaded;
  }

  async read() {
    await this.writing;
    let text = null;
    try { text = await readFile(this.file, 'utf8'); } catch (e) {
      if (e.code !== 'ENOENT') throw new Error(`อ่าน ${this.file} ไม่ได้: ${e.message}`);
    }
    let devices = {};
    if (text !== null) {
      try {
        devices = JSON.parse(text).devices;
        if (!devices || typeof devices !== 'object' || Array.isArray(devices)) throw new Error('no devices object');
      } catch (e) { // keep it aside instead of overwriting every pairing on the next save
        const aside = `${this.file}.corrupt-${Date.now()}`;
        await rename(this.file, aside).catch(() => {});
        console.error(`${this.file} เสีย (${e.message}) ย้ายไปไว้ที่ ${aside} ทุกคนต้องจับคู่ตัวอัดใหม่`);
        devices = {};
      }
    }
    const now = Date.now();
    let dropped = 0;
    this.devs = {};
    for (const [id, d] of Object.entries(devices)) {
      const ok = d && typeof d.userId === 'string' && HEX64.test(d.hash ?? '') && Number.isFinite(d.lastSeen);
      if (ok && now - d.lastSeen < T.prune) this.devs[id] = d; else dropped++;
    }
    if (dropped) await this.save();
  }

  // serialized, atomic (fsync a tmp file, then rename), 0600; resolves false on failure
  save() {
    const data = JSON.stringify({ devices: this.devs }, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      const fh = await open(tmp, 'w', 0o600);
      try {
        await fh.writeFile(data);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, this.file);
      return true;
    }).catch((e) => {
      console.error(`บันทึกเครื่องตัวอัดไม่ได้: ${e.message}`);
      return false;
    });
    return this.writing;
  }

  // --- pairing -------------------------------------------------------------------

  dropPairing(p) {
    if (!p) return;
    this.pairs.delete(p.userId);
    this.tokens.delete(p.token);
    if (p.code) this.codes.delete(p.code);
  }

  purge() {
    const now = Date.now();
    for (const p of [...this.pairs.values()]) if (p.expires <= now) this.dropPairing(p);
  }

  // -> {token, code, expires}; replaces that user's previous pairing. code is null when AGENT_CODE_PAIRING=false.
  // tag (additive): the user's Discord tag, returned to the agent on pair/hello
  newPairing(userId, guildId, tag = null) {
    this.dropPairing(this.pairs.get(userId));
    this.purge();
    let code = null;
    if (process.env.AGENT_CODE_PAIRING !== 'false') {
      do code = String(randomInt(0, 1e6)).padStart(6, '0'); while (this.codes.has(code));
    }
    const p = { userId, guildId, tag, token: rid(16), code, expires: Date.now() + T.pair, codeFails: 0 };
    this.pairs.set(userId, p);
    this.tokens.set(p.token, p);
    if (code) this.codes.set(code, p);
    return { token: p.token, code, expires: p.expires };
  }

  async pair(req, res) {
    const b = await readJson(req);
    const byCode = typeof b.code === 'string';
    if (typeof b.token !== 'string' && !byCode) throw fail(400, { error: 'body' });
    const now = Date.now();
    this.fails = this.fails.filter((t) => now - t < T.window);
    // only the 6-digit code is guessable; a 128-bit token is never locked out by someone else's flood
    if (byCode && this.fails.length >= PAIR_FAILS) return json(res, 429, { error: 'slow down' });
    this.purge();
    const p = byCode
      ? (process.env.AGENT_CODE_PAIRING !== 'false' && this.codes.get(b.code)) || null
      : this.tokens.get(b.token) ?? null;
    if (!p) {
      // only well-formed codes count (a token miss or junk can't guess anything); capped, the window filter drains it
      if (byCode && CODE.test(b.code)) {
        if (this.fails.length < PAIR_FAILS) this.fails.push(now);
        // A miss can't be pinned on one code, so it counts against every live code: CODE_FAILS misses kill them all.
        // Kept on purpose (guessing stays bounded per code); the cost is that 5 junk tries void other users' codes,
        // who then press /agent again. The install token (the normal path) is never affected.
        for (const q of [...this.codes.values()]) if (++q.codeFails >= CODE_FAILS) { this.codes.delete(q.code); q.code = null; }
      }
      return json(res, 410, { error: 'code' });
    }
    this.dropPairing(p); // single use: check-and-set, no await since the lookup
    const deviceId = rid(16), secret = rid(32);
    const name = str(b.name, 64) || 'ตัวอัด';
    this.devs[deviceId] = { userId: p.userId, tag: p.tag, hash: sha(secret).toString('hex'), name, os: str(b.os, 32), createdAt: now, lastSeen: now,
      ...(typeof p.guildId === 'string' ? { guildId: p.guildId } : {}) }; // additive: an older bot reading the store ignores it
    // keep the newest MAX_DEVICES of this user: the new one plus the 9 seen most recently
    const evict = this.devices(p.userId).filter((d) => d.deviceId !== deviceId).slice(MAX_DEVICES - 1).map((d) => d.deviceId);
    const evicted = Object.fromEntries(evict.map((id) => [id, this.devs[id]]));
    for (const id of evict) delete this.devs[id];
    if (!(await this.save())) { // a secret the store lost would die on the next restart: the agent must not keep it
      delete this.devs[deviceId];
      Object.assign(this.devs, evicted);
      return json(res, 500, { error: 'store' });
    }
    if (evict.length) this.forget(p.userId, evict);
    console.log(`ตัวอัด: จับคู่เครื่อง "${name}" กับผู้ใช้ ${p.userId}`);
    return json(res, 200, { deviceId, secret, user: { id: p.userId, tag: p.tag }, protocol: PROTOCOL });
  }

  // --- devices -------------------------------------------------------------------

  // -> [{deviceId, name, os, lastSeen, active}], newest first
  devices(userId) {
    const on = this.online(userId);
    return Object.entries(this.devs).filter(([, d]) => d.userId === userId)
      .map(([deviceId, d]) => ({ deviceId, name: d.name, os: d.os, lastSeen: Math.max(d.lastSeen, this.seen.get(deviceId) ?? 0), active: on?.deviceId === deviceId }))
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  // every user's devices (for a server admin; index.js scopes them) -> [{deviceId, userId, guildId|null, name, os, lastSeen, active}], newest first
  allDevices() {
    return Object.entries(this.devs)
      .map(([deviceId, d]) => ({ deviceId, userId: d.userId, guildId: typeof d.guildId === 'string' ? d.guildId : null, name: d.name, os: d.os,
        lastSeen: Math.max(d.lastSeen, this.seen.get(deviceId) ?? 0), active: this.online(d.userId)?.deviceId === deviceId }))
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  // one device by id, whoever owns it -> {userId, name} | null; like revoke(): its live session is told 'revoked'
  revokeDevice(deviceId) {
    const d = typeof deviceId === 'string' && Object.hasOwn(this.devs, deviceId) ? this.devs[deviceId] : null;
    if (!d) return null;
    this.forget(d.userId, [deviceId]);
    this.save();
    return { userId: d.userId, name: d.name };
  }

  // deviceId or 'all' -> number revoked; only that user's own devices; a parked poll is answered {cmds:[{type:'revoked'}]}
  revoke(userId, which) {
    const ids = Object.keys(this.devs).filter((id) => this.devs[id].userId === userId && (which === 'all' || id === which));
    if (ids.length) {
      this.forget(userId, ids);
      this.save();
    }
    return ids.length;
  }

  // drops the user's devices from memory (the caller saves); an active session on one of them is told it was revoked
  forget(userId, ids) {
    for (const id of ids) {
      delete this.devs[id];
      for (const m of [this.busy, this.buckets, this.seen]) m.delete(id);
    }
    const s = this.sess.get(userId);
    if (s && ids.includes(s.deviceId)) this.end(s, CMD.revoked);
    this.notify(userId);
  }

  // Bearer deviceId.secret -> [deviceId, device]; secrets are compared as sha256 with timingSafeEqual
  auth(req) {
    const m = BEARER.exec(req.headers.authorization ?? '');
    const d = m && Object.hasOwn(this.devs, m[1]) ? this.devs[m[1]] : null;
    if (!d || !timingSafeEqual(sha(m[2]), Buffer.from(d.hash, 'hex'))) throw fail(401, { error: 'auth' });
    const id = m[1], now = Date.now();
    // per-device token bucket (20, +1/s), like the capture API's; a long-poll counts once
    const b = this.buckets.get(id) ?? { n: 20, t: now };
    b.n = Math.min(20, b.n + (now - b.t) / 1000);
    b.t = now;
    this.buckets.set(id, b);
    if (b.n < 1) throw fail(429, { error: 'slow down' });
    b.n -= 1;
    this.seen.set(id, now);
    if (now - d.lastSeen >= T.seen) {
      d.lastSeen = now;
      this.save();
    }
    return [id, d];
  }

  // --- sessions ------------------------------------------------------------------

  // -> {deviceId, name} | null; online = the active session has a poll parked or polled within T.gone
  online(userId) {
    const s = this.sess.get(userId);
    if (!s || !(s.parked || Date.now() - s.lastPoll < T.gone)) return null;
    return { deviceId: s.deviceId, name: s.name };
  }

  notify(userId) {
    const on = Boolean(this.online(userId));
    if (on === (this.was.get(userId) ?? false)) return;
    if (on) this.was.set(userId, true); else this.was.delete(userId);
    try { this.onChange?.(userId, on); } catch (e) { console.error(e); }
  }

  // re-check online once the session could have gone quiet for T.gone
  armGone(s) {
    clearTimeout(s.goneTimer);
    s.goneTimer = setTimeout(() => this.notify(s.userId), T.gone + 5);
    s.goneTimer.unref?.();
  }

  // answers the parked poll (if any) with cmds
  answer(s, cmds) {
    const p = s.parked;
    if (!p) return false;
    clearTimeout(p.timer);
    s.parked = null;
    s.lastPoll = Date.now();
    if (!json(p.res, 200, { cmds })) s.queue.unshift(...cmds); // hung up just now: the next poll gets them
    this.armGone(s);
    return true;
  }

  // queue a command; a parked poll gets it (with anything queued before) at once
  push(s, cmd) {
    s.queue.push(cmd);
    if (s.parked) this.answer(s, s.queue.splice(0));
  }

  // the session is over (replaced by a newer one, or its device revoked): pending starts fail offline
  end(s, type) {
    if (this.sess.get(s.userId) === s) this.sess.delete(s.userId);
    if (type === CMD.replaced) {
      const now = Date.now();
      for (const [k, t] of this.old) if (now - t > T.old) this.old.delete(k);
      this.old.set(`${s.deviceId}.${s.id}`, now);
    }
    clearTimeout(s.goneTimer);
    for (const a of [...s.acks.values()]) a.done({ ok: false, error: ACK_ERROR.offline });
    this.answer(s, [{ type }]);
    clearTimeout(s.goneTimer); // answer re-arms it
  }

  // the request's session must be the user's active one: 409 if it was replaced, 404 if unknown (e.g. bot restart:
  // the agent says hello again with the same session)
  mine(id, d, sid) {
    const s = this.sess.get(d.userId);
    if (s && s.deviceId === id && s.id === sid) return s;
    if (this.old.has(`${id}.${sid}`)) throw fail(409, { replaced: true });
    throw fail(404, { error: 'session' });
  }

  async hello(req, res) {
    const [id, d] = this.auth(req);
    const b = await readJson(req);
    if (typeof b.session !== 'string' || !SESSION.test(b.session)) throw fail(400, { error: 'session' });
    let s = this.sess.get(d.userId);
    if (!s || s.deviceId !== id || s.id !== b.session) { // newest wins; the same device + session after a blip continues
      if (s) this.end(s, CMD.replaced);
      // the same device with a new session may be a restarted agent (crash, q and run again): its old capture is gone and
      // would answer busy until the heartbeat, so a capture that has gone quiet ends now. A healthy one is kept: Link.start()
      // makes a new random session on every run (also "r"), and two processes can share one config; the old process keeps
      // uploading with its own bearer
      const cur = s?.deviceId === id && this.busy.get(id);
      if (cur && cur.state === 'live' && Date.now() - (cur.lastSeen ?? 0) > 2 * CHUNK_MS) {
        this.busy.delete(id);
        cur.exit?.('⚠️ ตัวอัดถูกเปิดใหม่ระหว่างอัด', true, 'gone');
      }
      this.old.delete(`${id}.${b.session}`); // an explicit hello (e.g. "r" on a replaced agent) takes over again
      s = { userId: d.userId, deviceId: id, id: b.session, queue: [], acks: new Map(), parked: null, goneTimer: null };
      this.sess.set(d.userId, s);
    }
    const name = str(b.name, 64) || d.name, os = str(b.os, 32) || d.os;
    Object.assign(s, {
      name, os, version: str(b.version, 32), lastPoll: Date.now(),
      displays: Array.isArray(b.displays) ? b.displays.slice(0, 16) : [],
      display: ['string', 'number'].includes(typeof b.display) ? b.display : null,
    });
    if (name !== d.name || os !== d.os) {
      Object.assign(d, { name, os });
      this.save();
    }
    this.armGone(s);
    this.notify(d.userId);
    return json(res, 200, { user: { id: d.userId, tag: d.tag ?? null }, pollMs: T.poll, protocol: PROTOCOL });
  }

  poll(req, res) {
    const [id, d] = this.auth(req);
    const s = this.mine(id, d, new URL(req.url ?? '', 'http://x').searchParams.get('s') ?? '');
    this.answer(s, []); // a second poll on the same session supersedes the parked one
    s.lastPoll = Date.now();
    if (s.queue.length) {
      json(res, 200, { cmds: s.queue.splice(0) });
      this.armGone(s);
      return this.notify(s.userId);
    }
    const timer = setTimeout(() => this.answer(s, []), T.poll);
    s.parked = { res, timer };
    res.on('close', () => { // the agent hung up: count from now
      if (s.parked?.res !== res) return;
      clearTimeout(timer);
      s.parked = null;
      s.lastPoll = Date.now();
      this.armGone(s);
    });
    this.notify(s.userId);
  }

  async ack(req, res) {
    const [id, d] = this.auth(req);
    const b = await readJson(req);
    const s = this.mine(id, d, b.s);
    if (b.ok !== true && !AGENT_ERRORS.includes(b.error)) throw fail(400, { error: 'error' });
    const a = typeof b.id === 'string' ? s.acks.get(b.id) : null;
    if (!a) return json(res, 404, { error: 'cmd' }); // late (timed out) or unknown
    const detail = str(b.detail, 300);
    a.done(b.ok === true ? { ok: true, ...(detail ? { note: detail } : {}) } : { ok: false, error: b.error, ...(detail ? { detail } : {}) });
    return json(res, 200, { ok: true });
  }

  async state(req, res) {
    const [id, d] = this.auth(req);
    const b = await readJson(req);
    const s = this.mine(id, d, b.s);
    if (Array.isArray(b.displays)) s.displays = b.displays.slice(0, 16);
    if (['string', 'number'].includes(typeof b.display)) s.display = b.display;
    return json(res, 200, { ok: true });
  }

  // --- commands (index.js) -------------------------------------------------------

  // capture: a BrowserCapture (via:'agent'); opts {maxMs, room, by, area}; an ok ack may carry `note` (e.g. whole screen
  // instead of the Discord window)
  // -> Promise<{ok:true} | {ok:false, error, detail?}> with error one of ACK_ERROR (busy/offline from the hub itself)
  async start(userId, capture, { maxMs = 0, room = '', by = '', area = AREA.screen } = {}) {
    const s = this.sess.get(userId);
    if (!s || !this.online(userId)) return { ok: false, error: ACK_ERROR.offline };
    const cur = this.busy.get(s.deviceId);
    if (cur && cur !== capture && !cur.stopRequested && cur.state !== 'done') return { ok: false, error: ACK_ERROR.busy };
    this.busy.set(s.deviceId, capture); // reserved synchronously: a second start meanwhile is busy
    Promise.resolve(capture.exited).then(() => this.busy.get(s.deviceId) === capture && this.busy.delete(s.deviceId), () => {});
    const id = rid(8);
    const cmd = { id, type: CMD.start, capId: capture.capId, token: capToken(capture, T.pair), maxMs, chunkMs: CHUNK_MS, videoBps: VIDEO_BPS, room, by, area: area === AREA.discord ? AREA.discord : AREA.screen };
    return new Promise((resolve) => {
      const done = (r) => {
        if (!s.acks.delete(id)) return;
        clearTimeout(timer);
        if (!r.ok && this.busy.get(s.deviceId) === capture) this.busy.delete(s.deviceId);
        // too late for us: if the agent starts anyway it must stop (its claim also fails once index.js stops the capture)
        if (r.error === ACK_ERROR.timeout) this.push(s, { id: rid(8), type: CMD.stop, capId: capture.capId });
        resolve(r);
      };
      const timer = setTimeout(() => done({ ok: false, error: ACK_ERROR.timeout }), T.ack);
      timer.unref?.();
      s.acks.set(id, { done });
      this.push(s, cmd);
    });
  }

  // best effort, no ack awaited; -> whether a session got the command
  stop(userId, capId) {
    for (const [dev, c] of this.busy) if (c.capId === capId && this.devs[dev]?.userId === userId) this.busy.delete(dev);
    const s = this.sess.get(userId);
    if (!s) return false;
    this.push(s, { id: rid(8), type: CMD.stop, capId });
    return true;
  }

  // --- HTTP ----------------------------------------------------------------------

  // entry for /agent/* and /api/agent/* (capture-server.js); agent = loadAgentAssets() or null (static routes 404)
  async handle(req, res, path, agent = null) {
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const allow = (m) => m === method || (send(res, 405, '', { Allow: m, Connection: 'close' }), false);

    if (path.startsWith('/agent/')) { // public, generic, no secrets
      const name = path.slice('/agent/'.length);
      const hit = !agent ? null
        : name === 'manifest.json' ? [agent.manifest, 'application/json; charset=utf-8']
          : name.startsWith('files/') ? [agent.files.get(name.slice('files/'.length)), 'text/javascript; charset=utf-8']
            : [agent.scripts.get(name), 'text/plain; charset=utf-8'];
      if (!hit?.[0]) return send(res, 404, '');
      return allow('GET') && send(res, 200, hit[0], { 'Content-Type': hit[1] });
    }

    // agents are not browsers: any Origin means a web page is trying, refuse before reading anything
    if (req.headers.origin !== undefined) throw fail(403, { error: 'origin' });
    const route = { pair: 'POST', hello: 'POST', poll: 'GET', ack: 'POST', state: 'POST' };
    const r = path.slice('/api/agent/'.length);
    if (!Object.hasOwn(route, r)) return send(res, 404, '');
    if (!allow(route[r])) return;
    await this.load();
    return this[r](req, res);
  }

  // tests: forget sessions, pairings, timers and parked polls (the store is re-read on the next load)
  _reset() {
    for (const s of [...this.sess.values()]) {
      clearTimeout(s.goneTimer);
      for (const a of [...s.acks.values()]) a.done({ ok: false, error: ACK_ERROR.offline });
      this.answer(s, []);
      clearTimeout(s.goneTimer);
    }
    this.init();
    this.devs = {};
    this.loaded = null;
  }
}

// the one hub the bot uses (index.js: deps.agents = hub; capture-server.js routes to it)
export const hub = new AgentHub();
