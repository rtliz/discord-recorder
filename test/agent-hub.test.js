import { tmp } from './helpers/env.js';
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// offline matrix for src/agent-hub.js + the /agent and /api/agent routes of src/capture-server.js (real HTTP, port 0)

const freePort = () => new Promise((res) => {
  const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => res(port)); });
});
const PORT = await freePort();
const FILE = join(tmp, 'data', 'agents.json');
Object.assign(process.env, { PUBLIC_URL: `http://localhost:${PORT}`, AGENTS_FILE: FILE });
const { AgentHub, T, hub: singleton } = await import('../src/agent-hub.js');
const { startCaptureServer, loadAgentAssets } = await import('../src/capture-server.js');
const { CMD, ACK_ERROR, CHUNK_MS, PROTOCOL, ACK_MS } = await import('../src/agent/protocol.js');

const DEF = { ...T };
const B = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 2000) => { for (const end = Date.now() + ms; !fn();) { if (Date.now() > end) throw new Error('timeout'); await sleep(5); } };
const j = async (r) => [r.status, await r.json().catch(() => null)];
const post = (path, body, headers = {}) => fetch(`${B}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
}).then(j);
const auth = (c) => ({ authorization: `Bearer ${c.deviceId}.${c.secret}` });
const raw = (path, method = 'GET') => new Promise((res, rej) => { // no URL normalisation (fetch would resolve ../)
  http.request({ host: '127.0.0.1', port: PORT, path, method }, (r) => {
    let body = '';
    r.on('data', (d) => { body += d; }).on('end', () => res([r.statusCode, body, r.headers]));
  }).on('error', rej).end();
});

// a fake agent dir: two JS files, install scripts and pins
const AGENT_DIR = join(tmp, 'agent-src');
mkdirSync(AGENT_DIR, { recursive: true });
writeFileSync(join(AGENT_DIR, 'main.js'), 'export const main = 1;\n');
writeFileSync(join(AGENT_DIR, 'link.js'), 'export const link = 2;\n');
writeFileSync(join(AGENT_DIR, 'notes.txt'), 'not served');
writeFileSync(join(AGENT_DIR, 'install.sh'), '#!/bin/sh\nSERVER="__SERVER__"\necho "$SERVER" __SERVER__\n');
writeFileSync(join(AGENT_DIR, 'install.ps1'), '$Server = "__SERVER__"\n');
const PINS = { node: { version: '22.0.0', 'darwin-arm64': { url: 'https://nodejs.org/x.tgz', sha256: 'a'.repeat(64) } }, ffmpeg: { version: '7' } };
writeFileSync(join(AGENT_DIR, 'pins.json'), JSON.stringify(PINS));
const sha = (b) => createHash('sha256').update(b).digest('hex');

// a capture the hub can command (duck-typed BrowserCapture)
let capN = 0;
const fakeCap = () => {
  const capId = `cap${String(++capN).padStart(19, '0')}`;
  let resolveExit;
  return {
    capId, state: 'offered', stopRequested: false,
    exited: new Promise((r) => { resolveExit = r; }),
    link: (ms) => `http://localhost:${PORT}/capture/${capId}.${(Date.now() + ms).toString(36)}.${'s'.repeat(43)}`,
    exit() { this.stopRequested = true; resolveExit(); },
  };
};

describe('agent hub', () => {
  let server, hub;
  const logs = [];
  const orig = {};

  before(async () => {
    hub = new AgentHub({ file: FILE });
    const assets = { html: 'x', js: 'x', css: 'x', agent: loadAgentAssets(AGENT_DIR, 'https://rec.example.com') };
    server = startCaptureServer(PORT, { assets, agents: hub });
    await new Promise((r) => server.once('listening', r));
    for (const k of ['log', 'error', 'warn', 'info']) { // collected for the "no secrets in logs" check
      orig[k] = console[k];
      console[k] = (...a) => { logs.push(a.map(String).join(' ')); };
    }
  });
  after(() => {
    Object.assign(console, orig);
    hub._reset();
    server.closeAllConnections();
    server.close();
  });
  beforeEach(async () => {
    await hub.writing;
    hub._reset();
    rmSync(FILE, { force: true });
    hub.onChange = null;
    Object.assign(T, DEF);
    delete process.env.AGENT_CODE_PAIRING;
  });

  const pairNew = async (userId = 'u1', name = 'mac') => {
    const p = hub.newPairing(userId, 'g1', `${userId}#tag`);
    const [st, body] = await post('/api/agent/pair', { token: p.token, name, os: 'darwin', version: '1' });
    assert.equal(st, 200);
    return body;
  };
  const hello = (c, session = 'session-1', extra = {}) =>
    post('/api/agent/hello', { session, name: 'mac', os: 'darwin', version: '1', displays: [], askFirst: false, ...extra }, auth(c));
  const poll = (c, s = 'session-1') => fetch(`${B}/api/agent/poll?s=${s}`, { headers: auth(c) }).then(j);
  const ack = (c, body, s = 'session-1') => post('/api/agent/ack', { s, ...body }, auth(c));
  const online = async (userId = 'u1', session = 'session-1') => {
    const c = await pairNew(userId);
    assert.equal((await hello(c, session))[0], 200);
    return c;
  };
  // park a poll, wait until the hub has it; -> [the poll's promise] (wrapped: await would unwrap it)
  const parked = async (c, userId = 'u1', s = 'session-1') => {
    const p = poll(c, s);
    await until(() => hub.sess.get(userId)?.parked);
    return [p];
  };

  test('pair with the install token works once, the second use gets 410', async () => {
    const p = hub.newPairing('u1', 'g1', 'alice');
    assert.match(p.token, /^[A-Za-z0-9_-]{22}$/); // 16 bytes base64url
    assert.match(p.code, /^\d{6}$/);
    assert.ok(p.expires > Date.now() + T.pair - 1000);
    const [st, c] = await post('/api/agent/pair', { token: p.token, name: 'mac', os: 'darwin', version: '1' });
    assert.equal(st, 200);
    assert.match(c.deviceId, /^[A-Za-z0-9_-]{22}$/);
    assert.match(c.secret, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(c.user, { id: 'u1', tag: 'alice' });
    assert.equal(c.protocol, PROTOCOL);
    assert.deepEqual(await post('/api/agent/pair', { token: p.token }), [410, { error: 'code' }]);
    assert.deepEqual(await post('/api/agent/pair', { code: p.code }), [410, { error: 'code' }], 'token and code die together');
    const [hs, hb] = await hello(c);
    assert.equal(hs, 200);
    assert.deepEqual(hb, { user: { id: 'u1', tag: 'alice' }, pollMs: T.poll, protocol: PROTOCOL });
  });

  test('pair with the 6-digit code; a new pairing replaces the old; expired codes are refused', async () => {
    const first = hub.newPairing('u1', 'g1');
    const p = hub.newPairing('u1', 'g1');
    assert.equal((await post('/api/agent/pair', { token: first.token }))[0], 410, 'replaced pairing is dead');
    const [st, c] = await post('/api/agent/pair', { code: p.code, name: 'pc' });
    assert.equal(st, 200);
    assert.equal(hub.devices('u1')[0].deviceId, c.deviceId);
    T.pair = 20;
    const q = hub.newPairing('u2', 'g1');
    await sleep(40);
    assert.equal((await post('/api/agent/pair', { code: q.code }))[0], 410);
    assert.equal((await post('/api/agent/pair', { token: q.token }))[0], 410);
  });

  test('codes are unique among live pairings', () => {
    const codes = new Set(Array.from({ length: 300 }, (_, i) => hub.newPairing(`u${i}`, 'g').code));
    assert.equal(codes.size, 300);
  });

  test('a code dies after 5 wrong attempts', async () => {
    const p = hub.newPairing('u1', 'g1');
    const wrong = p.code === '000000' ? '000001' : '000000';
    for (let i = 0; i < 5; i++) assert.deepEqual(await post('/api/agent/pair', { code: wrong }), [410, { error: 'code' }]);
    assert.deepEqual(await post('/api/agent/pair', { code: p.code }), [410, { error: 'code' }]);
    assert.equal((await post('/api/agent/pair', { token: p.token }))[0], 200, 'the 128-bit token still works');
  });

  test('the global bucket answers 429 to code attempts after 30 failures a minute', async () => {
    // token misses and malformed codes can't guess a code: they never fill the bucket
    for (let i = 0; i < 40; i++) assert.equal((await post('/api/agent/pair', { token: `nope${i}` }))[0], 410);
    for (let i = 0; i < 40; i++) assert.equal((await post('/api/agent/pair', { code: '12345x' }))[0], 410);
    assert.equal(hub.fails.length, 0);
    for (let i = 0; i < 40; i++) assert.equal((await post('/api/agent/pair', { code: String(100000 + i) }))[0], i < 30 ? 410 : 429);
    assert.equal(hub.fails.length, 30, 'capped');
    const p = hub.newPairing('u1', 'g1');
    assert.deepEqual(await post('/api/agent/pair', { code: p.code }), [429, { error: 'slow down' }]);
    assert.equal((await post('/api/agent/pair', { token: p.token }))[0], 200, 'token pairing is never locked out');
    T.window = 1;
    await sleep(5);
    assert.equal((await post('/api/agent/pair', { code: '999999' }))[0], 410, 'the window slides');
  });

  test('AGENT_CODE_PAIRING=false: no code issued, codes refused', async () => {
    process.env.AGENT_CODE_PAIRING = 'false';
    const p = hub.newPairing('u1', 'g1');
    assert.equal(p.code, null);
    assert.equal((await post('/api/agent/pair', { code: '123456' }))[0], 410);
    assert.equal((await post('/api/agent/pair', { token: p.token }))[0], 200);
  });

  test('bad pair bodies', async () => {
    assert.equal((await post('/api/agent/pair', { name: 'x' }))[0], 400);
    const r = await fetch(`${B}/api/agent/pair`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    assert.equal(r.status, 415);
    assert.equal((await post('/api/agent/pair', { token: 'x', pad: 'y'.repeat(5000) }))[0], 413);
    assert.equal((await fetch(`${B}/api/agent/pair`)).status, 405);
    assert.equal((await fetch(`${B}/api/agent/nope`)).status, 404);
  });

  test('a request with an Origin header (a web page) gets 403', async () => {
    const p = hub.newPairing('u1', 'g1');
    assert.deepEqual(await post('/api/agent/pair', { token: p.token }, { origin: `http://localhost:${PORT}` }), [403, { error: 'origin' }]);
    assert.equal((await post('/api/agent/pair', { token: p.token }))[0], 200, 'the token was not spent');
  });

  test('a bad bearer gets 401', async () => {
    const c = await pairNew();
    assert.deepEqual(await hello({ ...c, secret: 'A'.repeat(43) }), [401, { error: 'auth' }]);
    assert.deepEqual(await hello({ ...c, deviceId: 'B'.repeat(22) }), [401, { error: 'auth' }]);
    assert.deepEqual(await hello({ deviceId: 'x', secret: 'y' }), [401, { error: 'auth' }]);
    assert.equal((await fetch(`${B}/api/agent/poll?s=session-1`)).status, 401);
    assert.equal((await hello(c, 'bad session!'))[0], 400);
  });

  test('the per-device bucket answers 429 after a burst of 20', async () => {
    const c = await online();
    for (let i = 0; i < 19; i++) assert.equal((await post('/api/agent/state', { s: 'session-1', askFirst: false }, auth(c)))[0], 200);
    assert.deepEqual(await post('/api/agent/state', { s: 'session-1' }, auth(c)), [429, { error: 'slow down' }]);
  });

  test('hello + parked poll gets a start command within 50 ms; ack ok resolves start()', async () => {
    const c = await online();
    assert.deepEqual(hub.online('u1'), { deviceId: c.deviceId, name: 'mac' });
    const [p] = await parked(c);
    const cap = fakeCap();
    const t0 = Date.now();
    const started = hub.start('u1', cap, { maxMs: 60000, room: 'Meeting', by: 'bob', area: 'discord' });
    const [st, { cmds }] = await p;
    assert.equal(st, 200);
    assert.ok(Date.now() - t0 < 50, `took ${Date.now() - t0} ms`);
    assert.equal(cmds.length, 1);
    const [cmd] = cmds;
    assert.equal(cmd.type, CMD.start);
    assert.match(cmd.token, new RegExp(`^${cap.capId}\\.[0-9a-z]+\\.s{43}$`));
    assert.deepEqual({ ...cmd, id: 0, token: 0 },
      { id: 0, token: 0, type: 'start', capId: cap.capId, maxMs: 60000, chunkMs: CHUNK_MS, videoBps: 2_000_000, room: 'Meeting', by: 'bob', area: 'discord' });
    assert.deepEqual(await ack(c, { id: cmd.id, ok: true, detail: 'หาหน้าต่าง Discord ไม่เจอ อัดทั้งจอแทน' }), [200, { ok: true }]);
    assert.deepEqual(await started, { ok: true, note: 'หาหน้าต่าง Discord ไม่เจอ อัดทั้งจอแทน' }, 'an ok ack carries the agent\'s note');
    assert.deepEqual(await ack(c, { id: cmd.id, ok: true }), [404, { error: 'cmd' }], 'a second ack is late');
  });

  test('a command queued while no poll is parked is delivered on the next poll', async () => {
    const c = await online();
    assert.equal(hub.stop('u1', 'capA'), true);
    const [, { cmds }] = await poll(c);
    assert.deepEqual(cmds.map((x) => [x.type, x.capId]), [['stop', 'capA']]);
    assert.equal(hub.stop('nobody', 'capA'), false);
  });

  test('a parked poll times out with no commands', async () => {
    T.poll = 60;
    const c = await online();
    const t0 = Date.now();
    assert.deepEqual(await poll(c), [200, { cmds: [] }]);
    assert.ok(Date.now() - t0 >= 50);
    assert.ok(hub.online('u1'), 'still online right after a poll');
  });

  test('newest wins: a second device replaces the first (parked -> replaced, next poll 409)', async () => {
    const a = await online();
    const [pa] = await parked(a);
    const b = await pairNew('u1', 'pc');
    assert.equal((await hello(b, 'session-b'))[0], 200);
    assert.deepEqual(await pa, [200, { cmds: [{ type: 'replaced' }] }]);
    assert.deepEqual(await poll(a), [409, { replaced: true }]);
    assert.equal(hub.online('u1').deviceId, b.deviceId);
    assert.deepEqual(hub.devices('u1').map((d) => [d.deviceId, d.active]).sort(),
      [[a.deviceId, false], [b.deviceId, true]].sort());
    // the replaced device takes over again with an explicit hello ("r")
    assert.equal((await hello(a, 'session-1'))[0], 200);
    assert.equal(hub.online('u1').deviceId, a.deviceId);
    assert.deepEqual(await poll(b, 'session-b'), [409, { replaced: true }]);
  });

  test('newest wins across two sessions on one device; the same session after a blip continues', async () => {
    const c = await online();
    hub.stop('u1', 'capQ'); // queued for session-1
    assert.equal((await hello(c, 'session-1'))[0], 200, 'same session again: nothing replaced');
    assert.deepEqual((await poll(c))[1].cmds.map((x) => x.capId), ['capQ'], 'the queue survived');
    const [p1] = await parked(c);
    assert.equal((await hello(c, 'session-2'))[0], 200);
    assert.deepEqual(await p1, [200, { cmds: [{ type: 'replaced' }] }]);
    assert.deepEqual(await poll(c, 'session-1'), [409, { replaced: true }]);
    assert.deepEqual(await poll(c, 'session-unknown'), [404, { error: 'session' }], 'unknown (bot restarted): say hello again');
  });

  test('revoke: the parked poll gets revoked, then 401; others cannot revoke my device', async () => {
    const c = await online();
    const other = await pairNew('u2');
    const [p] = await parked(c);
    assert.equal(hub.revoke('u2', c.deviceId), 0, 'not theirs');
    assert.equal(hub.revoke('u1', c.deviceId), 1);
    assert.deepEqual(await p, [200, { cmds: [{ type: 'revoked' }] }]);
    assert.deepEqual(await poll(c), [401, { error: 'auth' }]);
    assert.equal(hub.online('u1'), null);
    assert.deepEqual(hub.devices('u1'), []);
    assert.equal(hub.devices('u2').length, 1);
    await pairNew('u2');
    assert.equal(hub.revoke('u2', 'all'), 2);
    assert.equal((await hello(other))[0], 401);
  });

  test('pairing stores the guild; allDevices lists every user (with userId); revokeDevice ends the live session', async () => {
    const c = await online();
    const other = await pairNew('u2');
    const stored = JSON.parse(readFileSync(FILE, 'utf8')).devices;
    assert.equal(stored[c.deviceId].guildId, 'g1', 'the server /agent was used in');
    hub.devs[other.deviceId].lastSeen -= 1000; delete hub.devs[other.deviceId].guildId; // an old record
    const all = hub.allDevices();
    assert.deepEqual(all.map((d) => [d.deviceId, d.userId, d.guildId, d.active]), [[c.deviceId, 'u1', 'g1', true], [other.deviceId, 'u2', null, false]]);
    assert.ok(all.every((d) => !('hash' in d) && !('secret' in d)), 'no secret material');
    const [p] = await parked(c);
    assert.equal(hub.revokeDevice('nope'), null);
    assert.equal(hub.revokeDevice('__proto__'), null);
    assert.deepEqual(hub.revokeDevice(c.deviceId), { userId: 'u1', name: 'mac' });
    assert.deepEqual(await p, [200, { cmds: [{ type: 'revoked' }] }]);
    assert.deepEqual(await poll(c), [401, { error: 'auth' }]);
    assert.equal(hub.online('u1'), null);
    assert.equal(hub.revokeDevice(c.deviceId), null, 'already gone');
    assert.deepEqual(hub.allDevices().map((d) => d.deviceId), [other.deviceId]);
    await hub.writing;
    assert.ok(!(c.deviceId in JSON.parse(readFileSync(FILE, 'utf8')).devices), 'saved');
  });

  test('start: declined, agent busy and ffmpeg pass through (with detail)', async () => {
    const c = await online();
    for (const [error, detail] of [['declined'], ['busy'], ['ffmpeg', 'Permission denied']]) {
      const [p] = await parked(c);
      const started = hub.start('u1', fakeCap(), {});
      const [, { cmds: [cmd] }] = await p;
      assert.deepEqual(await ack(c, { id: cmd.id, ok: false, error, detail }), [200, { ok: true }]);
      assert.deepEqual(await started, { ok: false, error, ...(detail ? { detail } : {}) });
    }
    const [p] = await parked(c);
    const started = hub.start('u1', fakeCap(), {});
    const [, { cmds: [cmd] }] = await p;
    assert.equal((await ack(c, { id: cmd.id, ok: false, error: 'offline' }))[0], 400, 'offline is hub-only');
    assert.equal((await ack(c, { id: cmd.id, ok: false }))[0], 400);
    await ack(c, { id: cmd.id, ok: true });
    assert.deepEqual(await started, { ok: true });
  });

  test('no ask budget: every start waits T.ack (ask-first removed)', () => {
    assert.equal(DEF.ask, undefined);
    assert.equal(DEF.ack, ACK_MS);
  });

  test('area: anything but discord is sent as screen', async () => {
    const c = await online();
    const [p] = await parked(c);
    const started = hub.start('u1', fakeCap(), { area: 'weird' });
    const [, { cmds: [cmd] }] = await p;
    assert.equal(cmd.area, 'screen');
    await ack(c, { id: cmd.id, ok: true });
    assert.deepEqual(await started, { ok: true });
  });

  test('pair answers 500 and keeps no device when the store cannot be written', async () => {
    const blocker = join(tmp, 'store-blocker');
    writeFileSync(blocker, 'a file where a directory should be');
    const was = hub.file;
    await hub.load();
    hub.file = join(blocker, 'agents.json');
    try {
      const p = hub.newPairing('u1', 'g1');
      assert.deepEqual(await post('/api/agent/pair', { token: p.token, name: 'mac' }), [500, { error: 'store' }]);
      assert.deepEqual(hub.devices('u1'), []);
    } finally { hub.file = was; }
  });

  test('at most 10 devices per user: the least recently seen is dropped (its session revoked)', async () => {
    const first = await online();
    const [p] = await parked(first);
    hub.devs[first.deviceId].lastSeen = 1; hub.seen.delete(first.deviceId); // seen long ago (the active session does not count)
    const rest = [];
    for (let i = 0; i < 9; i++) rest.push(await pairNew('u1', `m${i}`));
    assert.equal(hub.devices('u1').length, 10);
    assert.equal(hub.sess.get('u1').deviceId, first.deviceId, 'still the active one');
    const last = await pairNew('u1', 'newest');
    const ids = hub.devices('u1').map((d) => d.deviceId);
    assert.equal(ids.length, 10);
    assert.ok(!ids.includes(first.deviceId) && ids.includes(last.deviceId));
    assert.deepEqual(await p, [200, { cmds: [{ type: 'revoked' }] }]);
    assert.equal((await hello(first))[0], 401);
    await hub.writing;
    assert.equal(Object.keys(JSON.parse(readFileSync(FILE, 'utf8')).devices).length, 10);
    await pairNew('u2'); // other users are counted on their own
    assert.equal(hub.devices('u1').length, 10);
  });

  test('a restarted agent (same device, new session) is not busy: a quiet capture ends at once', async () => {
    const c = await online();
    const cap = fakeCap();
    const exits = [];
    cap.exit = function (...a) { exits.push(a); this.stopRequested = true; };
    let [p] = await parked(c);
    const started = hub.start('u1', cap, {});
    await ack(c, { id: (await p)[1].cmds[0].id, ok: true });
    assert.deepEqual(await started, { ok: true });
    cap.state = 'live';
    cap.lastSeen = Date.now() - 7000; // no chunk for more than 2 chunk lengths
    assert.deepEqual(await hub.start('u1', fakeCap(), {}), { ok: false, error: 'busy' });
    assert.equal((await hello(c, 'session-new'))[0], 200); // the process crashed and came back
    assert.equal(hub.busy.size, 0);
    assert.deepEqual(exits, [['⚠️ ตัวอัดถูกเปิดใหม่ระหว่างอัด', true, 'gone']]);
    [p] = await parked(c, 'u1', 'session-new');
    const again = hub.start('u1', fakeCap(), {});
    await ack(c, { id: (await p)[1].cmds[0].id, ok: true }, 'session-new');
    assert.deepEqual(await again, { ok: true });
  });

  test('a new session on the same device keeps a healthy live capture (a second process, "r"): still busy', async () => {
    const c = await online();
    const cap = fakeCap();
    let exited = false;
    cap.exit = () => { exited = true; };
    const [p] = await parked(c);
    const started = hub.start('u1', cap, {});
    await ack(c, { id: (await p)[1].cmds[0].id, ok: true });
    await started;
    cap.state = 'live';
    cap.lastSeen = Date.now(); // a chunk just arrived
    assert.equal((await hello(c, 'session-new'))[0], 200);
    assert.equal(exited, false);
    assert.equal(hub.busy.size, 1);
    assert.deepEqual(await hub.start('u1', fakeCap(), {}), { ok: false, error: 'busy' });
  });

  test('another device taking over does not end the first device\'s recording', async () => {
    const a = await online();
    const cap = fakeCap();
    let exited = false;
    cap.exit = () => { exited = true; };
    const [p] = await parked(a);
    const started = hub.start('u1', cap, {});
    await ack(a, { id: (await p)[1].cmds[0].id, ok: true });
    await started;
    cap.state = 'live';
    const b = await pairNew('u1', 'pc');
    assert.equal((await hello(b, 'session-b'))[0], 200);
    assert.equal(exited, false);
    assert.equal(hub.busy.get(a.deviceId), cap);
  });

  test('start: timeout (and a stop is queued); an old agent sending askFirst gets no longer budget and no ask flag', async () => {
    Object.assign(T, { ack: 40 });
    const c = await online();
    assert.equal((await hello(c, 'session-1', { askFirst: true }))[0], 200, 'an old agent\'s hello with askFirst is accepted');
    const cap = fakeCap();
    assert.deepEqual(await hub.start('u1', cap, {}), { ok: false, error: ACK_ERROR.timeout });
    const [, { cmds }] = await poll(c);
    assert.deepEqual(cmds.map((x) => [x.type, x.capId]), [['start', cap.capId], ['stop', cap.capId]]);
    assert.equal(cmds[0].ask, undefined);
    // the state route still takes askFirst (no 400) and ignores it
    assert.equal((await post('/api/agent/state', { s: 'session-1', askFirst: true, displays: [{ id: 1 }], display: 1 }, auth(c)))[0], 200);
    assert.deepEqual(hub.online('u1'), { deviceId: c.deviceId, name: 'mac' });
    const [p] = await parked(c);
    const started = hub.start('u1', fakeCap(), {});
    const [, { cmds: [cmd] }] = await p;
    assert.equal(cmd.ask, undefined);
    await sleep(100); // past T.ack: an old agent's prompt is not waited for
    assert.deepEqual(await started, { ok: false, error: ACK_ERROR.timeout });
  });

  test('start: busy from the hub while recording, free again after the capture stops', async () => {
    const c = await online();
    const cap = fakeCap();
    let [p] = await parked(c);
    const started = hub.start('u1', cap, {});
    const pending = await hub.start('u1', fakeCap(), {});
    assert.deepEqual(pending, { ok: false, error: 'busy' }, 'busy while the first ack is pending');
    await ack(c, { id: (await p)[1].cmds[0].id, ok: true });
    assert.deepEqual(await started, { ok: true });
    assert.deepEqual(await hub.start('u1', fakeCap(), {}), { ok: false, error: 'busy' });
    cap.exit();
    await sleep(0);
    [p] = await parked(c);
    const again = hub.start('u1', fakeCap(), {});
    await ack(c, { id: (await p)[1].cmds[0].id, ok: true });
    assert.deepEqual(await again, { ok: true });
  });

  test('start: offline without a session, offline when replaced before the ack', async () => {
    assert.deepEqual(await hub.start('u1', fakeCap(), {}), { ok: false, error: 'offline' });
    const c = await online();
    const [p] = await parked(c);
    const started = hub.start('u1', fakeCap(), {});
    await p;
    assert.equal((await hello(c, 'session-2'))[0], 200);
    assert.deepEqual(await started, { ok: false, error: 'offline' });
  });

  test('online() flips after GONE (shrunk); onChange fires only on transitions', async () => {
    Object.assign(T, { poll: 20, gone: 80 });
    const seen = [];
    hub.onChange = (u, on) => seen.push([u, on]);
    const c = await online();
    await poll(c);
    await poll(c);
    assert.ok(hub.online('u1'));
    assert.deepEqual(seen, [['u1', true]]);
    await until(() => seen.length === 2, 1000);
    assert.equal(hub.online('u1'), null);
    assert.deepEqual(seen, [['u1', true], ['u1', false]]);
    assert.deepEqual(await hub.start('u1', fakeCap(), {}), { ok: false, error: 'offline' });
    const p = poll(c); // back: a parked poll is online
    await until(() => seen.length === 3);
    assert.deepEqual(seen[2], ['u1', true]);
    await p;
  });

  test('a hung-up parked poll leaves the session online until GONE', async () => {
    Object.assign(T, { gone: 80 });
    const c = await online();
    const ac = new AbortController();
    const p = fetch(`${B}/api/agent/poll?s=session-1`, { headers: auth(c), signal: ac.signal }).catch(() => 'aborted');
    await until(() => hub.sess.get('u1')?.parked);
    ac.abort();
    assert.equal(await p, 'aborted');
    await until(() => !hub.sess.get('u1').parked);
    assert.ok(hub.online('u1'));
    await until(() => !hub.online('u1'), 1000);
  });

  test('the store survives a reload, keeps only hashes (0600), and prunes stale devices', async () => {
    const p = hub.newPairing('u1', 'g1', 'alice');
    const [, c] = await post('/api/agent/pair', { token: p.token, name: 'mac', os: 'darwin' });
    await hub.writing;
    const text = readFileSync(FILE, 'utf8');
    assert.ok(!text.includes(c.secret), 'secret on disk');
    assert.ok(!text.includes(p.token) && !text.includes(p.code), 'pairing on disk');
    assert.equal(JSON.parse(text).devices[c.deviceId].hash, sha(c.secret));
    if (process.platform !== 'win32') assert.equal(statSync(FILE).mode & 0o777, 0o600);
    // an old device in the file is dropped at load
    const data = JSON.parse(text);
    data.devices['O'.repeat(22)] = { userId: 'u9', hash: 'b'.repeat(64), name: 'old', os: 'x', createdAt: 0, lastSeen: Date.now() - T.prune - 1000 };
    data.devices.broken = { userId: 'u9' };
    writeFileSync(FILE, JSON.stringify(data));
    const h2 = new AgentHub({ file: FILE });
    await h2.load();
    await h2.load(); // idempotent
    assert.deepEqual(h2.devices('u1').map((d) => [d.deviceId, d.name, d.os]), [[c.deviceId, 'mac', 'darwin']]);
    assert.deepEqual(h2.devices('u9'), []);
    await h2.writing;
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(FILE, 'utf8')).devices), [c.deviceId]);
    // the HTTP hub re-reads the file after _reset: the credentials still work
    hub._reset();
    assert.equal((await hello(c))[0], 200);
    assert.deepEqual((await hello(c))[1].user, { id: 'u1', tag: 'alice' });
  });

  test('a corrupt store is moved aside, not overwritten', async () => {
    const f = join(tmp, 'corrupt', 'agents.json');
    mkdirSync(join(tmp, 'corrupt'), { recursive: true });
    writeFileSync(f, '{nope');
    const h = new AgentHub({ file: f });
    await h.load();
    assert.ok(!existsSync(f));
    assert.deepEqual(h.devs, {});
  });

  test('/agent/files serves only the allowlist; ../ and unknown names are 404', async () => {
    const [st, body, headers] = await raw('/agent/files/main.js');
    assert.equal(st, 200);
    assert.equal(body, 'export const main = 1;\n');
    assert.match(headers['content-type'], /^text\/javascript/);
    for (const path of ['/agent/files/../x', '/agent/files/../../package.json', '/agent/files/%2e%2e%2fpins.json',
      '/agent/files/notes.txt', '/agent/files/pins.json', '/agent/files/', '/agent/files/constructor', '/agent/files/__proto__',
      '/agent/nope', '/agent/toString']) {
      assert.equal((await raw(path))[0], 404, path);
    }
    assert.equal((await raw('/agent/files/main.js', 'POST'))[0], 405);
    assert.equal((await raw('/agent/files/main.js', 'HEAD'))[0], 200);
  });

  test('manifest lists the agent files with their sha256 plus the pins', async () => {
    const [st, m] = await fetch(`${B}/agent/manifest.json`).then(j);
    assert.equal(st, 200);
    assert.deepEqual(m.files, [
      { name: 'link.js', sha256: sha('export const link = 2;\n') },
      { name: 'main.js', sha256: sha('export const main = 1;\n') },
    ]);
    assert.match(m.version, /^[0-9a-f]{12}$/);
    assert.equal(m.protocol, PROTOCOL);
    assert.deepEqual({ node: m.node, ffmpeg: m.ffmpeg }, PINS);
  });

  test('an unsafe server URL: the install scripts are not served at all', () => {
    for (const bad of ["https://x.example.com'; rm -rf ~; '", 'https://x.example.com/$(id)', 'https://a b', 'javascript:alert(1)', '']) {
      const a = loadAgentAssets(AGENT_DIR, bad);
      assert.equal(a.scripts.size, 0, bad);
      assert.ok(a.files.size > 0, 'agent files and manifest still load');
    }
    assert.equal(loadAgentAssets(AGENT_DIR, 'http://[::1]:8080/rec').scripts.size, 2);
  });

  test('install scripts are served with __SERVER__ replaced', async () => {
    const [st, sh] = await raw('/agent/install.sh');
    assert.equal(st, 200);
    assert.equal(sh, '#!/bin/sh\nSERVER="https://rec.example.com"\necho "$SERVER" https://rec.example.com\n');
    assert.equal((await raw('/agent/install.ps1'))[1], '$Server = "https://rec.example.com"\n');
  });

  test('the real src/agent dir loads (protocol.js is in the manifest, missing install/pins are fine)', () => {
    const a = loadAgentAssets();
    assert.ok(a.files.has('protocol.js'));
    const m = JSON.parse(a.manifest);
    assert.ok(m.files.some((f) => f.name === 'protocol.js'));
    for (const f of a.files.keys()) assert.match(f, /^[a-z][a-z0-9-]*\.js$/);
    assert.equal(singleton.file, FILE, 'the singleton reads AGENTS_FILE');
  });

  test('no token, code or secret appears in the logs', async () => {
    logs.length = 0;
    const p = hub.newPairing('u1', 'g1', 'alice');
    await post('/api/agent/pair', { code: '000000' === p.code ? '000001' : '000000' });
    const [, c] = await post('/api/agent/pair', { token: p.token, name: 'mac' });
    await hello(c);
    const [pp] = await parked(c);
    const started = hub.start('u1', fakeCap(), {});
    const [, { cmds: [cmd] }] = await pp;
    await ack(c, { id: cmd.id, ok: true });
    await started;
    await hello({ ...c, secret: 'Z'.repeat(43) });
    hub.revoke('u1', 'all');
    assert.ok(logs.length > 0, 'pairing logs something');
    const all = logs.join('\n');
    for (const secret of [p.token, p.code, c.secret, cmd.token]) assert.ok(!all.includes(secret), 'secret in logs');
  });
});

test('capture server without agent assets: /agent/* is 404, /api/agent still routes to the hub', async () => {
  const port = await freePort();
  const h = new AgentHub({ file: join(tmp, 'other', 'agents.json') });
  const s = startCaptureServer(port, { assets: { html: 'x', js: 'x', css: 'x' }, agents: h });
  await new Promise((r) => s.once('listening', r));
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/agent/manifest.json`)).status, 404);
    const r = await fetch(`http://127.0.0.1:${port}/api/agent/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"token":"x"}' });
    assert.equal(r.status, 410);
  } finally {
    s.closeAllConnections();
    s.close();
  }
});

test('POST /api/capture/<id>/stop accepts reason agent (the agent\'s local stop key)', async () => {
  const { BrowserCapture } = await import('../src/browser-capture.js');
  const { AGENT_MIME, STOP_REASON } = await import('../src/agent/protocol.js');
  const port = await freePort();
  const s = startCaptureServer(port, { assets: { html: 'x', js: 'x', css: 'x' }, agents: new AgentHub({ file: join(tmp, 'x3', 'agents.json') }) });
  await new Promise((r) => s.once('listening', r));
  const base = `http://127.0.0.1:${port}`;
  const rec = new BrowserCapture(join(tmp, 'cap-agent'), { guildId: 'g', owner: 'u', offerMs: 0, via: 'agent' });
  try {
    const token = rec.link().split('/capture/')[1];
    const [st, claim] = await post2(base, `/api/capture/${rec.capId}/start`, { token, mime: AGENT_MIME });
    assert.equal(st, 200);
    const bearer = { authorization: `Bearer ${claim.session}` };
    assert.equal((await post2(base, `/api/capture/${rec.capId}/stop`, { reason: 'bogus' }, bearer))[0], 400);
    assert.deepEqual(await post2(base, `/api/capture/${rec.capId}/stop`, { reason: STOP_REASON.local, last: -1 }, bearer), [200, { ok: true, stop: true }]);
    assert.equal(rec.pageReason, 'agent');
    assert.equal(rec.exitKind, 'local');
  } finally {
    rec.exit('test', false);
    s.closeAllConnections();
    s.close();
  }
});
const post2 = (base, path, body, headers = {}) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
}).then(j);
