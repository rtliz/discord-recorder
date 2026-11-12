import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fixtures, hasFfmpeg } from './helpers/fixtures.js';

// offline matrix for src/browser-capture.js + src/capture-server.js (no Discord, no Chrome)

const freePort = () => new Promise((res) => {
  const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => res(port)); });
});
const PORT = await freePort(); // random, never 8080; PUBLIC_URL's origin must match it (Origin check)
Object.assign(process.env, {
  PUBLIC_URL: `http://localhost:${PORT}`,
  CAPTURE_MAX_MB: '0.5', // per capture
  CAPTURE_TOTAL_MB: '0.7', // shared budget
});
const { BrowserCapture, lookup, checkToken, T } = await import('../src/browser-capture.js');
const { startCaptureServer } = await import('../src/capture-server.js');

// scaled timings (production values are T's defaults); dead stays long and is shrunk per test, because
// the heartbeat would otherwise kill captures that sit idle between slow assertions
Object.assign(T, { beat: 50, drainMax: 800, silent: 300, poll: 25 });
const withT = async (patch, fn) => {
  const old = Object.fromEntries(Object.keys(patch).map((k) => [k, T[k]]));
  Object.assign(T, patch);
  try { return await fn(); } finally { Object.assign(T, old); }
};

const B = `http://127.0.0.1:${PORT}`;
const ORIGIN = `http://localhost:${PORT}`;
const MIME_WEBM = 'video/webm;codecs=vp8,opus';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 2000) => { for (const end = Date.now() + ms; !fn();) { if (Date.now() > end) throw new Error('timeout'); await sleep(5); } };
const all = (a) => a.map((_, i) => i);
const shuffle = (a) => a.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);

describe('browser capture', { skip: !hasFfmpeg() && 'ffmpeg not installed' }, () => {
  let server, OUT, fx, n = 0, warned = false;
  const onWarn = (w) => { if (w.name === 'MaxListenersExceededWarning') warned = true; };

  before(async () => {
    OUT = mkdtempSync(join(tmpdir(), 'cap-test-'));
    fx = fixtures();
    const assets = { html: '<!doctype html><title>stub</title>', js: 'console.log(1)', css: 'body{}' };
    server = startCaptureServer(PORT, { assets });
    await new Promise((r) => server.once('listening', r));
    process.on('warning', onWarn);
  });
  after(() => {
    process.off('warning', onWarn);
    server.closeAllConnections();
    server.close();
    rmSync(OUT, { recursive: true, force: true });
  });

  const fresh = (opts = {}) => {
    const rec = new BrowserCapture(join(OUT, `rec${++n}`), { guildId: 'g', owner: 'u', ...opts });
    rec.lived = 0;
    rec.onLive = () => { rec.lived++; };
    return rec;
  };
  const tokenOf = (rec) => rec.link().split('/capture/')[1];
  const j = async (r) => [r.status, await r.json().catch(() => null)];
  const start = async (rec, mime, token = tokenOf(rec)) => j(await fetch(`${B}/api/capture/${rec.capId}/start`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, mime }),
  }));
  const put = async (rec, seq, buf, session, extra = {}) => j(await fetch(`${B}/api/capture/${rec.capId}/chunk/${seq}`, {
    method: 'PUT', headers: { authorization: `Bearer ${session}`, 'content-type': 'video/webm', ...extra }, body: buf,
  }));
  const pstop = (rec, session, last, reason = 'page') => fetch(`${B}/api/capture/${rec.capId}/stop`, {
    method: 'POST', headers: { authorization: `Bearer ${session}`, 'content-type': 'application/json' }, body: JSON.stringify({ reason, last }),
  });
  const get = (path, headers) => fetch(`${B}${path}`, { headers });
  const status = (rec, session) => get(`/api/capture/${rec.capId}/status`, { authorization: `Bearer ${session}` });
  // raw http for what fetch refuses to send or would normalize (odd paths, Content-Length lies, chunked bodies)
  const raw = (path, { method = 'GET', headers = {}, body, hold = false } = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method, headers }, (res) => {
      res.resume();
      resolve(res.statusCode);
      r.on('error', () => {});
      r.destroy();
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    if (!hold) r.end();
  });
  const probe = (file) => {
    const p = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name', '-of', 'compact', file], { encoding: 'utf8' });
    const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
    return { info: p.stdout.trim().replace(/\n/g, ' | '), decodeErrors: dec.stderr.trim().split('\n').filter(Boolean).length, code: p.status };
  };

  // full upload: order = chunk indexes to upload; direct = feed rec.putChunk (skips HTTP and its 20-token bucket)
  async function scenario(parts, mime, order, { direct = false } = {}) {
    const rec = fresh();
    const [st, claim] = await start(rec, mime);
    for (const i of order) {
      if (direct) await rec.putChunk(i, Readable.from([parts[i]]), parts[i].length);
      else assert.equal((await put(rec, i, parts[i], claim.session))[0], 200);
    }
    if (direct) rec.pageStop('page', parts.length - 1);
    else await pstop(rec, claim.session, parts.length - 1);
    try {
      const file = await rec.stop();
      return { rec, st, file, notes: rec.notes, probe: probe(file) };
    } catch (e) {
      return { rec, st, error: e.message };
    }
  }

  describe('finalize', () => {
    test('webm in order -> playable, onLive once, chunks removed', async () => {
      const r = await scenario(fx.webm, MIME_WEBM, all(fx.webm));
      assert.ok(r.file.endsWith('screen.webm'));
      assert.equal(r.probe.code, 0);
      assert.equal(r.notes, '');
      assert.equal(r.rec.lived, 1);
      assert.equal(r.rec.received, true, 'whole video finalized: the agent may drop its copy');
      assert.equal(r.st, 200);
      assert.ok(r.rec.liveAt > 0);
      assert.ok(!existsSync(join(r.rec.dir, 'chunks')));
    });
    test('mp4 (h264) in order -> screen.mp4 playable', async () => {
      const r = await scenario(fx.mp4, 'video/mp4;codecs=avc1.42E01F,mp4a.40.2', all(fx.mp4));
      assert.ok(r.file.endsWith('screen.mp4'), r.file ?? r.error);
      assert.equal(r.probe.code, 0);
      assert.equal(r.notes, '');
    });
    test('webm shuffled -> same as in order', async () => {
      const r = await scenario(fx.webm, MIME_WEBM, shuffle(all(fx.webm)));
      assert.equal(r.probe.code, 0);
      assert.equal(r.notes, '');
    });
    test('mp4 shuffled -> same', async () => {
      const r = await scenario(fx.mp4, 'video/mp4', shuffle(all(fx.mp4)));
      assert.equal(r.probe.code, 0);
      assert.equal(r.notes, '');
    });
    test('webm middle chunk dropped -> output + note', async () => {
      const r = await scenario(fx.webm, MIME_WEBM, all(fx.webm).filter((i) => i !== 3));
      assert.ok(r.file, r.error);
      assert.match(r.notes, /ขาดหาย 1 ช่วง/);
      assert.equal(r.rec.received, false, 'a gap: the agent keeps its copy');
    });
    test('mp4 middle chunk dropped -> output + note', async () => {
      const r = await scenario(fx.mp4, 'video/mp4', all(fx.mp4).filter((i) => i !== 2));
      assert.ok(r.file, r.error);
      assert.match(r.notes, /ขาดหาย/);
    });
    test('chunk 0 dropped -> error, chunks dir removed', async () => {
      const r = await scenario(fx.webm, MIME_WEBM, all(fx.webm).slice(1));
      assert.equal(r.error, 'ไม่ได้รับวิดีโอจากเบราว์เซอร์');
      assert.ok(!r.rec.received);
      assert.ok(!existsSync(join(r.rec.dir, 'chunks')));
    });
    test('no chunks -> error', async () => {
      const r = await scenario(fx.webm, 'video/webm;codecs=vp9,opus', []);
      assert.equal(r.error, 'ไม่ได้รับวิดีโอจากเบราว์เซอร์');
    });
    test('40 small webm chunks -> playable, no listener leak', async () => {
      const r = await scenario(fx.webmSmall, MIME_WEBM, all(fx.webmSmall), { direct: true });
      assert.equal(r.probe.code, 0);
      assert.equal(r.notes, '');
      assert.equal(warned, false);
    });
    test('40 small mp4 chunks -> playable', async () => {
      const r = await scenario(fx.mp4Small, 'video/mp4', all(fx.mp4Small), { direct: true });
      assert.equal(r.probe.code, 0);
      assert.equal(r.notes, '');
    });
    test('ffmpeg fails -> screen-raw + note, no partial files', async () => {
      const rec = fresh();
      const [, c] = await start(rec, 'video/webm');
      await put(rec, 0, Buffer.alloc(5000, 7), c.session);
      await pstop(rec, c.session, 0);
      const file = await rec.stop();
      assert.ok(file.endsWith('screen-raw.webm'));
      assert.match(rec.notes, /ส่งไฟล์ดิบแทน/);
      assert.ok(!existsSync(join(rec.dir, 'screen.webm')) && !existsSync(join(rec.dir, 'chunks')), readdirSync(rec.dir).join(','));
    });
  });

  describe('size caps', () => {
    const junk = Buffer.alloc(100000, 7);
    test('CAPTURE_MAX_MB reached -> 413 + exit reason, still finalizes', async () => {
      const rc = fresh();
      const [, c] = await start(rc, 'video/webm');
      const codes = [];
      for (let i = 0; i < 6; i++) codes.push((await put(rc, i, junk, c.session))[0]);
      await rc.exited;
      assert.ok(codes.includes(413), codes.join(','));
      assert.equal(rc.exitReason, '⚠️ ไฟล์ใหญ่ถึงขีดจำกัด');
      assert.ok(rc.exitSkip);
      assert.ok(await rc.stop());
    });
    test('shared budget -> 413 + reason (before the per-capture cap), freed after finalize', async () => {
      const a = fresh(), b = fresh();
      const [, ca] = await start(a, 'video/webm'), [, cb] = await start(b, 'video/webm');
      for (let i = 0; i < 4; i++) await put(a, i, junk, ca.session);
      const codes = [];
      for (let i = 0; i < 6; i++) codes.push((await put(b, i, junk, cb.session))[0]);
      assert.ok(codes.includes(413), codes.join(','));
      assert.equal(b.exitReason, '⚠️ พื้นที่เก็บไฟล์ของบอทเต็ม');
      assert.ok(!a.exitReason);
      await Promise.all([a.stop(), b.stop()]);
      const c = fresh();
      const [, cc] = await start(c, 'video/webm');
      const codes2 = [];
      for (let i = 0; i < 5; i++) codes2.push((await put(c, i, junk, cc.session))[0]);
      assert.deepEqual(codes2, [200, 200, 200, 200, 200]);
      await pstop(c, cc.session, 4);
      await c.stop();
    });
  });

  describe('protocol / security', () => {
    let rec, token, S, claim;
    before(async () => {
      rec = fresh();
      token = tokenOf(rec);
    });
    after(async () => { await rec.stop(); });

    test('GET page with valid token 200 (does not claim)', async () => {
      assert.equal((await get(`/capture/${token}`)).status, 200);
      assert.equal(rec.state, 'offered');
    });
    test('HEAD page has CSP / Referrer / no-store / nosniff / Permissions-Policy', async () => {
      const h = (await fetch(`${B}/capture/${token}`, { method: 'HEAD' })).headers;
      assert.match(h.get('content-security-policy'), /^default-src 'none'/);
      assert.equal(h.get('referrer-policy'), 'no-referrer');
      assert.equal(h.get('cache-control'), 'no-store');
      assert.equal(h.get('x-content-type-options'), 'nosniff');
      assert.equal(h.get('permissions-policy'), 'display-capture=(self)');
    });
    test('tampered token: start 410, page 410', async () => {
      const tampered = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
      assert.equal((await start(rec, 'video/webm', tampered))[0], 410);
      assert.equal((await get(`/capture/${tampered}`)).status, 410);
    });
    test('bad mime -> 400', async () => {
      assert.equal((await start(rec, 'video/webm;codecs=vp8,opus;evil'))[0], 400);
    });
    test('first start 200, second 409, page after claim 410', async () => {
      const [s1, c] = await start(rec, MIME_WEBM, token);
      const [s2] = await start(rec, MIME_WEBM, token);
      assert.deepEqual([s1, s2], [200, 409]);
      assert.equal((await get(`/capture/${token}`)).status, 410);
      claim = c;
      S = c.session;
    });
    test('claim returns chunkMs / videoBps / 43-char session', () => {
      assert.equal(claim.chunkMs, 3000);
      assert.equal(claim.videoBps, 2000000);
      assert.equal(S.length, 43);
    });
    test('duplicate seq -> 200 ok', async () => {
      const [c0] = await put(rec, 0, fx.webm[0], S);
      const [cd, body] = await put(rec, 0, fx.webm[0], S);
      assert.deepEqual([c0, cd, body.ok], [200, 200, true]);
    });
    test('bad bearer -> 401', async () => {
      assert.equal((await put(rec, 1, fx.webm[1], 'x'.repeat(43)))[0], 401);
    });
    test('no Content-Length (chunked) -> 411', async () => {
      const code = await raw(`/api/capture/${rec.capId}/chunk/1`, {
        method: 'PUT', headers: { authorization: `Bearer ${S}`, 'content-type': 'video/webm' }, body: 'abc',
      });
      assert.equal(code, 411);
    });
    test('Content-Length > 16 MiB -> 413', async () => {
      const code = await raw(`/api/capture/${rec.capId}/chunk/1`, {
        method: 'PUT', hold: true, body: 'abc',
        headers: { authorization: `Bearer ${S}`, 'content-type': 'video/webm', 'content-length': '20000000' },
      });
      assert.equal(code, 413);
    });
    test('seq abc -> 400', async () => {
      assert.equal((await put(rec, 'abc', Buffer.from('abc'), S))[0], 400);
    });
    test('seq ../x (path kept as is) -> 404', async () => {
      const code = await raw(`/api/capture/${rec.capId}/chunk/../x`, {
        method: 'PUT', headers: { authorization: `Bearer ${S}`, 'content-type': 'video/webm', 'content-length': '3' }, body: 'abc',
      });
      assert.equal(code, 404);
    });
    test('seq > maxSeq+50 -> 400', async () => {
      assert.equal((await put(rec, 60, fx.webm[1], S))[0], 400);
    });
    test('wrong content-type -> 415', async () => {
      assert.equal((await put(rec, 1, fx.webm[1], S, { 'content-type': 'text/plain' }))[0], 415);
    });
    test('Origin evil (PUT) -> 403, own -> 200', async () => {
      assert.equal((await put(rec, 1, fx.webm[1], S, { origin: 'https://evil.example' }))[0], 403);
      assert.equal((await put(rec, 1, fx.webm[1], S, { origin: ORIGIN }))[0], 200);
    });
    test('Origin evil (POST start) -> 403', async () => {
      const r = await fetch(`${B}/api/capture/${rec.capId}/start`, {
        method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}',
      });
      assert.equal(r.status, 403);
    });
    test('unknown capId -> 404', async () => {
      assert.equal((await get(`/api/capture/${'A'.repeat(22)}/status`)).status, 404);
    });
    test('GET /capture/x/../../etc/passwd (path kept as is) -> 404', async () => {
      assert.equal(await raw('/capture/x/../../etc/passwd'), 404);
    });
    test('GET /static/ -> 404, capture.js 200 text/javascript', async () => {
      assert.equal((await get('/static/')).status, 404);
      const r = await get('/static/capture.js');
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type'), /^text\/javascript/);
    });
    test('/healthz 200; DELETE /healthz 405; GET chunk route 405; OPTIONS 405 (no CORS)', async () => {
      assert.equal((await get('/healthz')).status, 200);
      assert.equal((await fetch(`${B}/healthz`, { method: 'DELETE' })).status, 405);
      assert.equal((await get(`/api/capture/${rec.capId}/chunk/1`)).status, 405);
      const o = await fetch(`${B}/api/capture/${rec.capId}/start`, { method: 'OPTIONS' });
      assert.equal(o.status, 405);
      assert.equal(o.headers.get('access-control-allow-origin'), null);
    });
    test('30 fast status calls -> some 429 (per-capture bucket)', async () => {
      const r2 = fresh();
      const [, c] = await start(r2, 'video/webm');
      const codes = await Promise.all(Array.from({ length: 30 }, () => status(r2, c.session).then((x) => x.status)));
      assert.ok(codes.includes(429) && codes.includes(200), codes.join(','));
      await r2.stop().catch(() => {}); // claimed, no chunks: finalize throws
    });
    test('no global lockout: 150 bad links + 50 unknown capIds, then a real start works', async () => {
      for (let i = 0; i < 150; i++) await get(`/capture/${'A'.repeat(22)}.abc.${'B'.repeat(43)}`);
      for (let i = 0; i < 50; i++) await get(`/api/capture/${'A'.repeat(22)}/status`);
      const r5 = fresh();
      assert.equal((await start(r5, 'video/webm'))[0], 200);
      assert.equal((await get('/healthz')).status, 200);
      await r5.stop().catch(() => {});
    });
  });

  describe('stop paths', () => {
    test('stop(): status says stop:true / stopping, uploads still accepted, resolves after page ack, then 410', async () => {
      const rec = fresh();
      const [, c] = await start(rec, MIME_WEBM);
      const S = c.session;
      await put(rec, 0, fx.webm[0], S);
      const stopP = rec.stop(); // index presses the button: the page should see stop:true
      const st = await (await status(rec, S)).json();
      assert.deepEqual(st, { state: 'stopping', stop: true });
      assert.equal((await put(rec, 1, fx.webm[1], S))[0], 200);
      await pstop(rec, S, 1);
      assert.ok(await stopP);
      assert.equal(rec.state, 'done');
      const [late, body] = await put(rec, 2, fx.webm[2], S);
      assert.deepEqual([late, body.stop], [410, true]);
      assert.equal((await status(rec, S)).status, 410);
    });
    test('stop() before claim -> null, state done', async () => {
      const r2 = fresh();
      assert.equal(await r2.stop(), null);
      assert.equal(r2.state, 'done');
      assert.ok(!r2.liveAt);
    });
    test('page stop (ended) -> exited with reason + skip; stop() then returns fast', async () => {
      const r3 = fresh();
      const [, c] = await start(r3, 'video/webm');
      await put(r3, 0, fx.webm[0], c.session);
      await pstop(r3, c.session, 0, 'ended');
      await r3.exited;
      assert.equal(r3.exitReason, '⏹️ เลิกแชร์จอในเบราว์เซอร์');
      assert.equal(r3.exitSkip, true);
      assert.ok(!r3.stopping);
      const t0 = Date.now();
      assert.ok(await r3.stop());
      assert.ok(Date.now() - t0 < T.silent, `${Date.now() - t0} ms`);
    });
    test('silent page: stop() waits ~T.silent then finalizes', async () => {
      const r4 = fresh();
      const [, c] = await start(r4, 'video/webm');
      await put(r4, 0, fx.webm[0], c.session);
      const t0 = Date.now();
      assert.ok(await r4.stop());
      const ms = Date.now() - t0;
      assert.ok(ms >= T.silent - 60 && ms < T.drainMax + 700, `${ms} ms`);
    });
    test('live page: stop() waits ~T.drainMax for its drain', async () => {
      const r6 = fresh();
      const [, c] = await start(r6, 'video/webm');
      await put(r6, 0, fx.webm[0], c.session);
      const talk = setInterval(() => status(r6, c.session).catch(() => {}), 100);
      const t0 = Date.now();
      await r6.stop();
      clearInterval(talk);
      const ms = Date.now() - t0;
      assert.ok(ms >= T.drainMax - 60 && ms < T.drainMax + 700, `${ms} ms`);
    });
    test('live agent: stop() waits 45/35 of T.drainMax (slow uplinks have a longer tail)', async () => {
      const ra = fresh({ via: 'agent' });
      const [, c] = await start(ra, 'video/webm');
      await put(ra, 0, fx.webm[0], c.session);
      const talk = setInterval(() => status(ra, c.session).catch(() => {}), 100);
      const t0 = Date.now();
      await ra.stop();
      clearInterval(talk);
      const ms = Date.now() - t0, want = T.drainMax * 45 / 35;
      assert.ok(ms >= want - 60 && ms < want + 700, `${ms} ms`);
    });
    test('heartbeat: idle live page -> exit with reason, skip, stop:true', async () => {
      await withT({ dead: 400 }, async () => {
        const rec = fresh();
        const [, c] = await start(rec, MIME_WEBM);
        await put(rec, 0, fx.webm[0], c.session);
        const t0 = Date.now();
        await rec.exited;
        const ms = Date.now() - t0;
        assert.equal(rec.exitReason, '⚠️ หน้าอัดจอถูกปิดหรือเน็ตหลุด');
        assert.ok(rec.exitSkip);
        assert.ok(rec.status().stop);
        assert.ok(ms >= 330 && ms < 1500, `${ms} ms`);
        await rec.stop().catch(() => {});
      });
    });
  });

  describe('/result', () => {
    test('401 without / with a wrong bearer; ready false then true with the url', async () => {
      const rec = fresh();
      const [, c] = await start(rec, 'video/webm');
      const path = `/api/capture/${rec.capId}/result`;
      assert.equal((await get(path)).status, 401);
      assert.equal((await get(path, { authorization: `Bearer ${'x'.repeat(43)}` })).status, 401);
      const h = { authorization: `Bearer ${c.session}` };
      assert.deepEqual(await (await get(path, h)).json(), { ready: false, url: null, received: false });
      rec.received = true; // finalized: long before compose and upload are done
      assert.deepEqual(await (await get(path, h)).json(), { ready: false, url: null, received: true });
      rec.result = { url: 'https://drive.google.com/file/d/x/view' };
      assert.deepEqual(await (await get(path, h)).json(), { ready: true, url: 'https://drive.google.com/file/d/x/view', received: true });
      rec.result = { url: null }; // delivered without a link: ready, nothing to open
      assert.deepEqual(await (await get(path, h)).json(), { ready: true, url: null, received: true });
      await rec.stop().catch(() => {});
    });
    test('R15: after KEEP the registry entry is gone -> 404 (a long Drive upload loses the page)', async () => {
      await withT({ keep: 100 }, async () => {
        const rec = fresh();
        const id = rec.capId;
        await rec.stop();
        await sleep(250);
        assert.equal(lookup(id), undefined);
        assert.equal((await get(`/api/capture/${id}/result`, { authorization: `Bearer ${'x'.repeat(43)}` })).status, 404);
      });
    });
  });

  describe('offer / link timing', () => {
    test('offerMs: 0 never expires (no timer) until stop()', async () => {
      const rec = fresh({ offerMs: 0 });
      assert.equal(rec.offerTimer, undefined);
      await sleep(300);
      assert.equal(rec.state, 'offered');
      assert.equal(rec.exitReason, undefined);
      const [s] = await start(rec, 'video/webm'); // still claimable
      assert.equal(s, 200);
      await rec.stop().catch(() => {});
    });
    test('offerMs: 0 offer still ends through exit()/stop() while offered', async () => {
      const rec = fresh({ offerMs: 0 });
      rec.exit('x');
      await rec.exited;
      assert.equal(rec.exitReason, 'x');
      assert.equal(await rec.stop(), null);
    });
    test('offerMs expiry exits the unclaimed offer with the 5-minute reason + skip', async () => {
      const rec = fresh({ offerMs: 60 });
      assert.ok(rec.offerTimer);
      await rec.exited;
      assert.equal(rec.exitReason, 'ไม่มีใครกดอัดจอภายใน 5 นาที');
      assert.equal(rec.exitSkip, true);
      assert.equal(await rec.stop(), null);
    });
    test('default offerMs is T.offer (timer armed, cleared by stop)', async () => {
      const rec = fresh();
      assert.ok(rec.offerTimer);
      await rec.stop();
      assert.equal(rec.exitReason, undefined);
    });
    test('link() defaults to T.link; link(ms) sets its own expiry', async () => {
      const rec = fresh({ offerMs: 0 });
      const exp = (t) => parseInt(t.split('.')[1], 36);
      const now = Date.now();
      assert.ok(Math.abs(exp(tokenOf(rec)) - (now + T.link)) < 2000);
      assert.ok(Math.abs(exp(rec.link(3600_000).split('/capture/')[1]) - (now + 3600_000)) < 2000);
      await rec.stop();
    });
    test('link(ms) expires: checkToken null, page 410, start 410; a longer link still works', async () => {
      const rec = fresh({ offerMs: 0 });
      const short = rec.link(40).split('/capture/')[1];
      const dead = rec.link(-1000).split('/capture/')[1];
      const long = rec.link(60000).split('/capture/')[1];
      assert.equal(checkToken(dead), null);
      assert.equal((await get(`/capture/${dead}`)).status, 410);
      assert.equal((await start(rec, 'video/webm', dead))[0], 410);
      assert.equal(checkToken(short), rec);
      await sleep(80);
      assert.equal(checkToken(short), null);
      assert.equal((await get(`/capture/${short}`)).status, 410);
      assert.equal(checkToken(long), rec);
      assert.equal((await start(rec, 'video/webm', long))[0], 200);
      await rec.stop().catch(() => {});
    });
  });

  describe('voice-only fallback (U20)', () => {
    const voice = async (rec, token = tokenOf(rec), headers = {}) => j(await fetch(`${B}/api/capture/${rec.capId}/voice`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ token }),
    }));
    const withCb = (cb, opts) => Object.assign(fresh(opts), { calls: 0, onVoiceOnly(r) { this.calls++; assert.equal(r, this); return cb(r); } });

    test('manual: { paired:false } -> 200, state voice, offer timer cleared, page/start/second voice 410', async () => {
      const rec = withCb(() => ({ paired: false }), { offerMs: 60 });
      assert.deepEqual(await voice(rec), [200, { ok: true, paired: false }]);
      assert.equal(rec.calls, 1);
      assert.equal(rec.state, 'voice');
      await sleep(120); // past offerMs: the cleared timer must not exit it
      assert.equal(rec.exitReason, undefined);
      assert.deepEqual(await voice(rec), [410, { stop: true }]); // single use
      assert.equal(rec.calls, 1);
      assert.equal((await get(`/capture/${tokenOf(rec)}`)).status, 410);
      assert.equal((await start(rec, 'video/webm'))[0], 410);
      assert.equal(rec.lived, 0);
      assert.equal(await rec.stop(), null); // nothing recorded by the page
      assert.equal(rec.state, 'done');
    });
    test('auto: async { paired:true } -> 200 paired', async () => {
      const rec = withCb(async () => { await sleep(30); return { paired: true }; });
      assert.deepEqual(await voice(rec), [200, { ok: true, paired: true }]);
      assert.equal(rec.state, 'voice');
      await rec.stop();
    });
    test('novoice -> 409 novoice; back to offered, link still claimable from a computer', async () => {
      const rec = withCb(() => ({ error: 'novoice' }));
      assert.deepEqual(await voice(rec), [409, { error: 'novoice' }]);
      assert.equal(rec.state, 'offered');
      assert.deepEqual(await voice(rec), [410, { stop: true }]); // still single use
      assert.equal(rec.calls, 1);
      assert.equal((await start(rec, 'video/webm'))[0], 200);
      await rec.stop().catch(() => {});
    });
    test('unset callback / throw / junk result -> 409 voice, offered again', async () => {
      const bad = [null, () => { throw new Error('join failed'); }, async () => { throw new Error('x'); }, () => undefined, () => ({ ok: true }), () => ({ error: 'other' })];
      const err = console.error;
      console.error = () => {}; // the throws are logged on purpose
      try {
        for (const cb of bad) {
          const rec = fresh();
          rec.onVoiceOnly = cb;
          assert.deepEqual(await voice(rec), [409, { error: 'voice' }], String(cb));
          assert.equal(rec.state, 'offered');
          assert.equal(rec.exitReason, undefined);
          await rec.stop();
        }
      } finally { console.error = err; }
    });
    test('offer expires during a failed callback -> exits with the 5-minute reason', async () => {
      const rec = withCb(async () => { await sleep(120); return { error: 'novoice' }; }, { offerMs: 60 });
      assert.equal((await voice(rec))[0], 409);
      assert.equal(rec.exitReason, 'ไม่มีใครกดอัดจอภายใน 5 นาที');
      assert.equal(await rec.stop(), null);
    });
    test('concurrent calls: one callback, the other 410; claim during the callback 410', async () => {
      let go;
      const rec = withCb(() => new Promise((r) => { go = r; }));
      const a = voice(rec);
      await until(() => rec.state === 'voice');
      assert.deepEqual(await voice(rec), [410, { stop: true }]);
      assert.equal((await start(rec, 'video/webm'))[0], 410);
      go({ paired: false });
      assert.deepEqual(await a, [200, { ok: true, paired: false }]);
      assert.equal(rec.calls, 1);
      await rec.stop();
    });
    test('410 after claim; after stop(); after exit()', async () => {
      const claimed = withCb(() => ({ paired: false }));
      assert.equal((await start(claimed, 'video/webm'))[0], 200);
      assert.deepEqual(await voice(claimed), [410, { stop: true }]);
      const stopped = withCb(() => ({ paired: false }));
      const tok = tokenOf(stopped);
      await stopped.stop();
      assert.deepEqual(await voice(stopped, tok), [410, { stop: true }]);
      const exited = withCb(() => ({ paired: false }));
      exited.exit('x');
      assert.deepEqual(await voice(exited), [410, { stop: true }]);
      assert.equal(claimed.calls + stopped.calls + exited.calls, 0);
      await claimed.stop().catch(() => {}); await exited.stop();
    });
    test('bad token: tampered 410, other capture 400, expired 410, missing 400; callback never runs', async () => {
      const rec = withCb(() => ({ paired: false }), { offerMs: 0 });
      const other = fresh({ offerMs: 0 });
      const t = tokenOf(rec);
      assert.deepEqual(await voice(rec, `${t.slice(0, -1)}${t.at(-1) === 'A' ? 'B' : 'A'}`), [410, { stop: true }]);
      assert.deepEqual(await voice(rec, tokenOf(other)), [400, { error: 'token' }]);
      assert.deepEqual(await voice(rec, rec.link(-1000).split('/capture/')[1]), [410, { stop: true }]);
      assert.equal((await voice(rec, 42))[0], 400);
      assert.equal(rec.calls, 0);
      assert.equal(rec.state, 'offered');
      await rec.stop(); await other.stop();
    });
    test('HTTP rules: evil Origin 403, own 200; GET 405; non-JSON 415; >1 KB 413; unknown capId 404', async () => {
      const evil = withCb(() => ({ paired: false }));
      assert.deepEqual(await voice(evil, tokenOf(evil), { origin: 'https://evil.example' }), [403, { error: 'origin' }]);
      assert.deepEqual(await voice(evil, tokenOf(evil), { origin: ORIGIN }), [200, { ok: true, paired: false }]);
      const rec = withCb(() => ({ paired: false }));
      const path = `/api/capture/${rec.capId}/voice`;
      assert.equal((await get(path)).status, 405);
      assert.equal(await raw(path, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }), 415);
      assert.equal(await raw(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'x'.repeat(2000) }) }), 413);
      assert.equal((await fetch(`${B}/api/capture/${'A'.repeat(22)}/voice`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
      assert.equal(rec.calls, 0);
      await evil.stop(); await rec.stop();
    });
    test('rate-limited by the per-capture bucket: 30 fast calls -> some 429', async () => {
      const rec = withCb(() => ({ paired: false }));
      const codes = await Promise.all(Array.from({ length: 30 }, () => voice(rec, 'x').then(([s]) => s)));
      assert.ok(codes.includes(429), codes.join(','));
      assert.equal(rec.calls, 0);
      await rec.stop();
    });
  });

  describe('busy port (child processes)', () => {
    test('health-only keeps running; capture mode exits 1', async () => {
      const blocker = net.createServer().listen(0);
      await new Promise((r) => blocker.once('listening', r));
      const busy = blocker.address().port;
      const mod = new URL('../src/capture-server.js', import.meta.url).href;
      const child = (env) => new Promise((res) => {
        const code = `const { startCaptureServer } = await import(${JSON.stringify(mod)});
          startCaptureServer(${busy}, process.env.PUBLIC_URL ? { assets: { html: 'x', js: 'x', css: 'x' } } : {});
          setTimeout(() => { console.log('ALIVE'); process.exit(0); }, 1000);`;
        execFile(process.execPath, ['--input-type=module', '-e', code], { env: { PATH: process.env.PATH, ...env } },
          (err, stdout, stderr) => res({ code: err?.code ?? 0, out: stdout + stderr }));
      });
      try {
        const [h1, h2] = await Promise.all([child({}), child({ PUBLIC_URL: `http://localhost:${busy}` })]);
        assert.equal(h1.code, 0, h1.out);
        assert.match(h1.out, /ALIVE/);
        assert.match(h1.out, new RegExp(`health server: เปิดพอร์ต ${busy} ไม่ได้ \\(EADDRINUSE\\)`));
        assert.equal(h2.code, 1, h2.out);
        assert.doesNotMatch(h2.out, /ALIVE/);
        assert.match(h2.out, new RegExp(`capture server: เปิดพอร์ต ${busy} ไม่ได้ \\(EADDRINUSE\\)`));
      } finally {
        blocker.close();
      }
    });
  });

  describe('via: agent (texts and exitKind)', () => {
    const live = async (opts) => {
      const rec = fresh(opts);
      const [, c] = await start(rec, MIME_WEBM);
      await put(rec, 0, fx.webm[0], c.session);
      return rec;
    };
    test('what differs, default via is page', () => {
      assert.equal(fresh({ via: 'agent' }).what, 'จอ (ตัวอัด)');
      assert.equal(fresh({ via: 'agent' }).via, 'agent');
      assert.equal(fresh().what, 'จอ (เบราว์เซอร์)');
      assert.equal(fresh().via, 'page');
    });
    test('agent: stop reasons -> texts + exitKind', async () => {
      const want = { agent: ['⏹️ เจ้าของเครื่องกดหยุดที่ตัวอัด', 'local'], unload: ['⚠️ ตัวอัดถูกปิด', 'gone'],
        page: ['⏹️ หยุดจากหน้าอัดจอ', 'local'], ended: ['⏹️ เลิกแชร์จอในเบราว์เซอร์', 'local'] };
      for (const [reason, [text, kind]] of Object.entries(want)) {
        const rec = await live({ via: 'agent' });
        assert.equal(rec.pageStop(reason, 0).stop, true);
        assert.equal(rec.exitReason, text, reason);
        assert.equal(rec.exitKind, kind, reason);
        assert.ok(rec.exitSkip);
        await rec.stop().catch(() => {});
      }
    });
    test('browser page: unload text unchanged, agent reason falls to kind local', async () => {
      const a = await live();
      a.pageStop('unload', 0);
      assert.equal(a.exitReason, '⚠️ หน้าอัดจอถูกปิด');
      assert.equal(a.exitKind, 'gone');
      const b = await live();
      b.pageStop('page', 0);
      assert.equal(b.exitReason, '⏹️ หยุดจากหน้าอัดจอ');
      assert.equal(b.exitKind, 'local');
      await Promise.all([a.stop().catch(() => {}), b.stop().catch(() => {})]);
    });
    test('heartbeat: agent text + gone; page text unchanged + gone', async () => {
      await withT({ dead: 300 }, async () => {
        const a = await live({ via: 'agent' });
        const p = await live();
        await Promise.all([a.exited, p.exited]);
        assert.equal(a.exitReason, '⚠️ ตัวอัดหลุด (ปิดเครื่องหรือเน็ตหลุด)');
        assert.equal(a.exitKind, 'gone');
        assert.equal(p.exitReason, '⚠️ หน้าอัดจอถูกปิดหรือเน็ตหลุด');
        assert.equal(p.exitKind, 'gone');
        await Promise.all([a.stop().catch(() => {}), p.stop().catch(() => {})]);
      });
    });
    test('exitKind: size cap -> cap; offer expiry and plain exit() -> local', async () => {
      const rec = await live({ via: 'agent' });
      const big = Buffer.alloc(600 * 1024);
      await assert.rejects(rec.putChunk(1, Readable.from([big]), big.length), { status: 413 });
      assert.equal(rec.exitKind, 'cap');
      await rec.stop().catch(() => {});
      const o = fresh({ offerMs: 40 });
      await o.exited;
      assert.equal(o.exitKind, 'local');
      const x = fresh({ offerMs: 0 });
      x.exit('x');
      assert.equal(x.exitKind, 'local');
      assert.equal(fresh().exitKind, undefined);
    });
  });
});
