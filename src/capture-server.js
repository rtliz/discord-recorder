import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { publicUrl, lookup, checkToken, tokenCapId } from './browser-capture.js';

// the HTTP side of browser capture: the page, its two assets, and the upload API.
// No static file serving: the three assets are read once here and served from memory.

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; "
  + "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const BASE = { 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const PAGE = { ...BASE, 'Content-Security-Policy': CSP, 'Permissions-Policy': 'display-capture=(self)' };
const GONE_HTML = '<!doctype html><html lang="th"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
  + '<title>ลิงก์ใช้ไม่ได้</title><link rel="stylesheet" href="/static/capture.css">'
  + '<body><main class="card"><p class="msg err" id="gone">ลิงก์นี้ใช้ไม่ได้แล้ว (หมดเวลา ถูกเปิดไปแล้ว หรือบอทรีสตาร์ท) — กลับไป Discord แล้วกด 🎥 อีกครั้ง</p></main></body></html>';
const CAP_ID = /^[A-Za-z0-9_-]{22}$/;
const MIME = /^video\/(webm|mp4)(;\s*codecs="?[a-z0-9.,]+"?)?$/i;
const MAX_CHUNK = 16 * 1024 * 1024;

const loadAssets = () => {
  const read = (name) => {
    const path = fileURLToPath(new URL(`./capture/${name}`, import.meta.url));
    try { return readFileSync(path); } catch (e) { throw new Error(`capture page asset missing: ${path} (${e.code})`); }
  };
  return { html: read('page.html'), js: read('page.js'), css: read('page.css') };
};

// per capture token bucket (20, +1/s) shared by chunk, status, result and voice
const buckets = new WeakMap();
const takeToken = (rec) => {
  const now = Date.now(), b = buckets.get(rec) ?? { n: 20, t: now };
  b.n = Math.min(20, b.n + (now - b.t) / 1000);
  b.t = now;
  buckets.set(rec, b);
  if (b.n < 1) return false;
  b.n -= 1;
  return true;
};

// no global lockout here (anyone could trip it for everyone): per-IP limits are nginx's job (k8s/ingress.yaml);
// tokens are 256-bit HMACs and sessions 256-bit random, so guessing is not a concern

const send = (res, status, body, headers = {}) => {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { ...BASE, ...headers });
  res.end(body);
};
const json = (res, status, obj, close = false) =>
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', ...(close ? { Connection: 'close' } : {}) });

// small JSON body (≤1 KB, application/json)
async function readJson(req) {
  if (!/^application\/json(\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw Object.assign(new Error(), { status: 415 });
  let size = 0;
  const parts = [];
  for await (const c of req) {
    if ((size += c.length) > 1024) throw Object.assign(new Error(), { status: 413 });
    parts.push(c);
  }
  try {
    const v = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch { /* falls through */ }
  throw Object.assign(new Error(), { status: 400 });
}

const bearer = (req) => /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1];

// without PUBLIC_URL only /healthz is served (k8s probes), no assets are loaded
export function startCaptureServer(port, { assets = publicUrl ? loadAssets() : null } = {}) {
  const { origin, hostname, protocol } = new URL(publicUrl || 'http://localhost');
  if (publicUrl && protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(hostname)) {
    console.warn(`PUBLIC_URL is not https: browsers allow screen capture only on https or localhost`);
  }
  const statics = assets ? {
    '/static/capture.js': [assets.js, 'text/javascript; charset=utf-8'],
    '/static/capture.css': [assets.css, 'text/css; charset=utf-8'],
  } : {};

  async function handle(req, res) {
    const path = (req.url ?? '').split('?')[0];
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const allow = (...m) => {
      if (m.includes(method)) return true;
      send(res, 405, '', { Allow: m.join(', '), Connection: 'close' });
      return false;
    };

    if (path === '/healthz') return allow('GET') && send(res, 200, 'ok', { 'Content-Type': 'text/plain' });
    if (!assets) return send(res, 404, ''); // capture off: health only
    if (statics[path]) {
      const [body, type] = statics[path];
      return allow('GET') && send(res, 200, body, { 'Content-Type': type });
    }

    if (path.startsWith('/capture/')) {
      if (!allow('GET')) return;
      const token = path.slice('/capture/'.length);
      // a token-shaped path or the bare /capture/ (reload after the page hid the token) gets the friendly page
      if (token && !tokenCapId(token)) return send(res, 404, '');
      const rec = checkToken(token);
      if (!rec || rec.state !== 'offered' || rec.stopRequested) {
        return send(res, 410, GONE_HTML, { ...PAGE, 'Content-Type': 'text/html; charset=utf-8' });
      }
      return send(res, 200, assets.html, { ...PAGE, 'Content-Type': 'text/html; charset=utf-8' });
    }

    const m = /^\/api\/capture\/([^/]+)\/(start|voice|status|stop|result|chunk\/([^/]+))$/.exec(path);
    if (!m) return send(res, 404, '');
    const [, capId, action, seqText] = m;
    const route = action.startsWith('chunk/') ? 'chunk' : action;
    if (!allow({ start: 'POST', voice: 'POST', stop: 'POST', status: 'GET', result: 'GET', chunk: 'PUT' }[route])) return;
    const upload = route === 'chunk';
    // POST/PUT from a browser must come from our own page
    if (method !== 'GET' && req.headers.origin !== undefined && req.headers.origin !== origin) return json(res, 403, { error: 'origin' }, true);
    const rec = CAP_ID.test(capId) ? lookup(capId) : null;
    if (!rec) return json(res, 404, { error: 'not found' }, true); // e.g. the bot restarted: the page gives up

    if (route === 'start') {
      const body = await readJson(req);
      if (typeof body.token !== 'string' || tokenCapId(body.token) !== capId) return json(res, 400, { error: 'token' });
      if (typeof body.mime !== 'string' || body.mime.length > 100 || !MIME.test(body.mime)) return json(res, 400, { error: 'mime' });
      return json(res, 200, rec.claim(body.token, body.mime));
    }

    // a phone can't capture: the bot records the voice room instead (BrowserCapture.voiceOnly)
    if (route === 'voice') {
      if (!takeToken(rec)) return json(res, 429, { error: 'slow down' }, true);
      const body = await readJson(req);
      if (typeof body.token !== 'string' || tokenCapId(body.token) !== capId) return json(res, 400, { error: 'token' });
      return json(res, 200, await rec.voiceOnly(body.token));
    }

    // after stopping, the page waits here for the delivered file (Drive link) to open it
    if (route === 'result') {
      if (!takeToken(rec)) return json(res, 429, { error: 'slow down' });
      if (!rec.authed(bearer(req))) return json(res, 401, { error: 'auth' });
      return json(res, 200, { ready: Boolean(rec.result), url: rec.result?.url ?? null });
    }
    if (rec.state === 'finalizing' || rec.state === 'done') return json(res, 410, { stop: true }, upload);
    if (route !== 'stop' && !takeToken(rec)) return json(res, 429, { error: 'slow down' }, upload);
    if (!rec.authed(bearer(req))) return json(res, 401, { error: 'auth' }, upload);

    if (route === 'status') return json(res, 200, rec.status());
    if (route === 'stop') {
      const body = await readJson(req);
      if (!['page', 'ended', 'unload'].includes(body.reason)) return json(res, 400, { error: 'reason' });
      return json(res, 200, rec.pageStop(body.reason, body.last));
    }

    // chunk upload: raw bytes, Content-Length required
    if (!/^\d{1,6}$/.test(seqText)) return json(res, 400, { error: 'seq' }, true);
    if (!/^video\//i.test(req.headers['content-type'] ?? '')) return json(res, 415, { error: 'type' }, true);
    const cl = req.headers['content-length'];
    if (cl === undefined || !/^\d+$/.test(cl)) return json(res, 411, { error: 'length' }, true);
    const len = Number(cl);
    if (len > MAX_CHUNK) return json(res, 413, { error: 'too large' }, true);
    return json(res, 200, await rec.putChunk(Number(seqText), req, len));
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (e.status) {
        // the request body may be unread: close instead of reusing the connection
        return json(res, e.status, e.body ?? { error: 'rejected' }, !req.readableEnded);
      }
      console.error(`capture server: ${e.stack ?? e}`); // never includes the URL (tokens)
      json(res, 500, { error: 'server' }, true);
    });
  });
  Object.assign(server, { requestTimeout: 120000, headersTimeout: 20000, keepAliveTimeout: 5000, maxConnections: 64 });
  server.on('clientError', (_, socket) => socket.destroy());
  // e.g. EADDRINUSE: health-only can live without its port, browser capture can't (links would lead nowhere)
  server.on('error', (e) => {
    if (!assets) return console.error(`health server: เปิดพอร์ต ${port} ไม่ได้ (${e.code ?? e.message}), /healthz ปิดอยู่ บอททำงานต่อ`);
    console.error(`capture server: เปิดพอร์ต ${port} ไม่ได้ (${e.code ?? e.message}) — browser capture cannot work, exiting. `
      + 'Free the port or change HTTP_PORT');
    process.exit(1);
  });
  server.listen(port, '0.0.0.0', () => console.log(`${assets ? 'capture' : 'health'} server on :${port}`));
  return server;
}
