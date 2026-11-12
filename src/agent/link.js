// Agent <-> bot link: pairing, hello, the long-poll loop with backoff, ack and state. Node built-ins only.
import { randomBytes } from 'node:crypto';
import { CMD, POLL_MS } from './protocol.js';

export const AGENT_VERSION = '1.0.0';
const DEF = { min: 1000, max: 30000 }; // reconnect backoff 1 -> 30 s

// one-time pairing with a token (install command) or a 6-digit code -> { ok, deviceId, secret, user } | { ok: false, status, error }
export async function pair(server, body, fetchFn = fetch) {
  try {
    const res = await fetchFn(`${server}/api/agent/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    const j = await res.json().catch(() => ({}));
    return res.ok && j.deviceId && j.secret ? { ok: true, deviceId: j.deviceId, secret: j.secret, user: j.user ?? null } : { ok: false, status: res.status, error: j.error };
  } catch (e) { return { ok: false, status: 0, error: e.message }; }
}

export class Link {
  // cred = { deviceId, secret }; getState() -> { displays, display }; onCmd(cmd) is not awaited (the poll keeps going);
  // onStatus(kind, data): 'online' { user } | 'offline' { wait, error } | 'replaced' | 'revoked'
  constructor({ server, cred, info, getState, onCmd, onStatus, T, fetchFn = fetch }) {
    Object.assign(this, { server, cred, info, getState, onCmd, onStatus, fetchFn });
    this.T = { ...DEF, ...T };
    this.state = 'idle'; // idle | run | replaced | revoked | stopped
  }

  get auth() { return { Authorization: `Bearer ${this.cred.deviceId}.${this.cred.secret}` }; }

  async #call(method, path, body, ms) {
    const res = await this.fetchFn(this.server + path, {
      method, headers: { ...this.auth, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any([this.ac.signal, AbortSignal.timeout(ms)]),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  }

  // a new session each run: the newest connection of this user wins on the bot
  start() {
    this.state = 'run'; this.helloed = false;
    this.ac = new AbortController();
    this.session = randomBytes(16).toString('base64url');
    return (this.loop = this.#run());
  }

  // after 'replaced' (key r): take the user's active slot back
  resume() { return this.state === 'replaced' ? this.start() : null; }

  async stop() {
    if (this.state === 'run' || this.state === 'replaced') this.state = 'stopped';
    this.ac?.abort();
    await this.loop;
  }

  #end(kind) { this.state = kind; this.onStatus(kind); }

  #sleep(ms) {
    return new Promise((r) => {
      const sig = this.ac.signal;
      const onAbort = () => { clearTimeout(t); r(); };
      const t = setTimeout(() => { sig.removeEventListener('abort', onAbort); r(); }, ms); // don't pile listeners on the long-lived signal
      sig.addEventListener('abort', onAbort, { once: true });
    });
  }

  async #run() {
    const ac = this.ac;
    let wait = this.T.min, down = false;
    while (this.state === 'run' && this.ac === ac) {
      try {
        if (!this.helloed) {
          const r = await this.#call('POST', '/api/agent/hello', { session: this.session, ...this.info, ...this.getState() }, 15000);
          if (r.status === 401) return this.#end('revoked');
          if (r.status !== 200) throw new Error(`hello ${r.status}`);
          this.helloed = true; this.user = r.json.user ?? null; down = false; wait = this.T.min;
          this.onStatus('online', { user: this.user });
        }
        const r = await this.#call('GET', `/api/agent/poll?s=${encodeURIComponent(this.session)}`, null, POLL_MS + 10000);
        if (r.status === 401) return this.#end('revoked');
        if (r.status === 409) return this.#end('replaced');
        if (r.status === 404) { this.helloed = false; await this.#sleep(this.T.min); continue; } // the bot forgot this session (restart)
        if (r.status !== 200) throw new Error(`poll ${r.status}`);
        if (down) { down = false; this.onStatus('online', { user: this.user }); }
        wait = this.T.min;
        for (const c of r.json.cmds ?? []) {
          if (c?.type === CMD.replaced) return this.#end('replaced');
          if (c?.type === CMD.revoked) return this.#end('revoked');
          Promise.resolve(this.onCmd(c)).catch(() => {}); // a slow `start` (ffmpeg's first frame) must not block polling
        }
      } catch (e) {
        if (this.state !== 'run' || this.ac !== ac) return;
        down = true;
        this.onStatus('offline', { wait, error: e.message });
        await this.#sleep(wait);
        wait = Math.min(wait * 2, this.T.max);
      }
    }
  }

  // best effort, 3 tries; `detail` is a human-readable reason for failures (additive to the contract)
  async ack(id, ok, error, detail) {
    for (let i = 0; i < 3 && this.state !== 'stopped'; i++) {
      try {
        const r = await this.#call('POST', '/api/agent/ack', { s: this.session, id, ok, ...(error ? { error } : {}), ...(detail ? { detail: String(detail).slice(0, 300) } : {}) }, 10000);
        if (r.status < 500) return r.status === 200;
      } catch { /* retry */ }
      await this.#sleep(this.T.min);
    }
    return false;
  }

  async sendState() {
    try { await this.#call('POST', '/api/agent/state', { s: this.session, ...this.getState() }, 10000); } catch { /* next hello carries it */ }
  }
}
