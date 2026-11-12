// Agent program (src/agent/*) against a fake bot (node:http) and a fake ffmpeg (a node script). Offline; never captures a screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Capture, buildArgs, ffmpegPath, pruneRecordings } from '../src/agent/capture.js';
import { AREA_MISS, DESKTOP, areaInput, discordCrop, inputArgs, parseMac, parseWin, pickDisplay } from '../src/agent/displays.js';
import { PassThrough } from 'node:stream';
import { Link } from '../src/agent/link.js';
import { loadConfig, normalizeServer, parseArgs, runAgent, saveConfig } from '../src/agent/main.js';
import { ACK_ERROR } from '../src/agent/protocol.js';
import { hms } from '../src/agent/ui.js';

const tmp = mkdtempSync(join(tmpdir(), 'dra-test-'));
const FAKE = join(tmp, 'fake-ffmpeg.mjs');
writeFileSync(FAKE, `
const mode = process.env.FAKE_MODE || 'ok';
if (mode === 'die') { process.stderr.write('boom: no screen\\n'); process.exit(1); }
if (mode === 'silent') { process.stdin.resume(); setInterval(() => {}, 1000); }
else {
  process.stdout.write('HEAD'); let i = 0;
  const t = setInterval(() => process.stdout.write('<' + String(i++).padStart(6, '0') + '>'), 20);
  process.stdin.on('data', (d) => { if (String(d).includes('q')) { clearInterval(t); process.stdout.write('TAIL', () => process.exit(0)); } });
}`);
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const waitFor = async (cond, ms = 4000) => {
  for (const until = Date.now() + ms; Date.now() < until;) { if (await cond()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error(`timeout waiting for: ${cond}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readBody = (req) => new Promise((r) => { const p = []; req.on('data', (c) => p.push(c)); req.on('end', () => r(Buffer.concat(p))); });

// the bot, as far as the agent can see it (contract: plan §5.2 + the capture API)
async function fakeBot() {
  const st = {
    hello: [], polls: 0, acks: [], states: [], pairs: [], starts: [], chunks: [], stops: [], cmds: [],
    stopFlag: false, chunkCode: 0, startCode: 200, pollMode: '', badSeq: -1,
    result: { ready: true, url: 'https://drive.google.com/x' },
  };
  const srv = http.createServer(async (req, res) => {
    const body = await readBody(req), u = new URL(req.url, 'http://x');
    const J = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const j = () => { try { return JSON.parse(body.toString()); } catch { return {}; } };
    const auth = req.headers.authorization;
    if (u.pathname === '/api/agent/pair') {
      const b = j(); st.pairs.push(b);
      return b.code === '123456' || b.token === 'GOODTOKEN' ? J(200, { deviceId: 'dev1', secret: 's3cr3t', user: { id: '1', tag: 'tester' } }) : J(410, { error: 'code' });
    }
    if (u.pathname.startsWith('/api/agent/')) {
      if (auth !== 'Bearer dev1.s3cr3t') return J(401, { error: 'auth' });
      if (u.pathname.endsWith('/hello')) { st.hello.push(j()); return J(200, { user: { id: '1', tag: 'tester' }, pollMs: 25000 }); }
      if (u.pathname.endsWith('/ack')) { st.acks.push(j()); return J(200, { ok: true }); }
      if (u.pathname.endsWith('/state')) { st.states.push(j()); return J(200, { ok: true }); }
      if (u.pathname.endsWith('/poll')) {
        st.polls++;
        if (st.pollMode === 'replaced') return J(409, { replaced: true });
        if (st.pollMode === 'revoked') return J(401, { error: 'auth' });
        if (st.cmds.length) return J(200, { cmds: st.cmds.splice(0) });
        const t = setTimeout(() => J(200, { cmds: [] }), 100);
        return res.on('close', () => clearTimeout(t));
      }
    }
    const m = /^\/api\/capture\/([\w-]+)\/(start|status|stop|result|chunk\/(\d+))$/.exec(u.pathname);
    if (m) {
      if (m[2] === 'start') { st.starts.push({ id: m[1], ...j() }); return st.startCode === 200 ? J(200, { session: 'SESS', chunkMs: 100, videoBps: 2e6 }) : J(st.startCode, { stop: true }); }
      if (auth !== 'Bearer SESS') return J(401, { error: 'auth' });
      if (m[3] !== undefined) {
        if (Number(m[3]) === st.badSeq) return J(400, { error: 'bad' }); // refused for good: a gap on the bot
        st.chunks.push({ seq: Number(m[3]), buf: body, type: req.headers['content-type'] });
        return st.chunkCode ? J(st.chunkCode, { stop: true }) : J(200, { ok: true, stop: st.stopFlag });
      }
      if (m[2] === 'status') return J(200, { state: 'live', stop: st.stopFlag });
      if (m[2] === 'stop') { st.stops.push(j()); return J(200, { ok: true, stop: true }); }
      if (m[2] === 'result') return J(200, st.result);
    }
    J(404, {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { st, url: `http://127.0.0.1:${srv.address().port}`, close: () => { srv.closeAllConnections(); srv.close(); } };
}

const START = { id: 'c1', type: 'start', capId: 'cap1', token: 'cap1.x.y', maxMs: 60000, chunkMs: 100, videoBps: 2e6, room: 'r', by: 'u', ask: false };
const TCAP = { first: 1500, status: 50, result: 30, resultMax: 3000, drain: 2000, quit: 1500, kill: 3000, retry: 20, offline: 5000 };

// a running agent wired to the fake bot, a fake keyboard and a capturing stdout
async function boot(bot, { mode = 'ok', platform = 'linux', paired = true, T = {}, argv = [], env = {} } = {}) {
  const home = mkdtempSync(join(tmp, 'home-'));
  if (paired) saveConfig(home, { server: bot.url, deviceId: 'dev1', secret: 's3cr3t', user: { id: '1', tag: 'tester' } });
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, resume() {}, pause() {}, setEncoding() {} });
  const o = { out: '', spawns: [], home, stdin };
  const stdout = { isTTY: false, write(s) { o.out += s; return true; } };
  o.agent = await runAgent({
    argv: ['--server', bot.url, ...argv], home, platform, stdin, stdout, env: typeof env === 'function' ? env(home) : env, notifyFn() {},
    T: { link: { min: 10, max: 40 }, capture: TCAP, ask: 400, ...T },
    listDisplaysFn: async () => (platform === 'darwin' ? [{ id: '1', name: 'จอ 1' }] : [DESKTOP]),
    spawnFn: (bin, args, opt) => { o.spawns.push(args); return spawn(process.execPath, [FAKE, ...args], { ...opt, env: { ...process.env, FAKE_MODE: mode } }); },
  });
  o.file = (id = 'cap1') => join(home, 'recordings', `${id}.mp4`);
  return o;
}
const cleanup = async (o, bot) => { await o.agent.shutdown(); bot.close(); };

test('displays: parsers, picking and ffmpeg input args per OS', () => {
  const mac = parseMac('[AVFoundation indev @ 0x1] [0] FaceTime HD Camera\n[AVFoundation indev @ 0x1] [2] Capture screen 0\n[AVFoundation indev @ 0x1] [3] Capture screen 1');
  assert.deepEqual(mac, [{ id: '2', name: 'จอ 1', screen: 0 }, { id: '3', name: 'จอ 2', screen: 1 }]);
  const win = parseWin('0,0,1920,1080,True\r\n1920,0,1280,720,False\r\nnoise');
  assert.equal(win.length, 2);
  assert.equal(win[0].id, '0,0,1920,1080');
  assert.match(win[0].name, /หลัก/);
  assert.equal(pickDisplay(mac, undefined).id, '2');
  assert.equal(pickDisplay(mac, '3').id, '3');
  assert.equal(pickDisplay(mac, '9'), undefined); // a vanished display is never replaced silently
  assert.deepEqual(inputArgs('darwin', mac[1], 15), ['-f', 'avfoundation', '-capture_cursor', '1', '-framerate', '15', '-i', '3:none']);
  assert.deepEqual(inputArgs('win32', DESKTOP, 15), ['-f', 'gdigrab', '-framerate', '15', '-i', 'desktop']);
  assert.deepEqual(inputArgs('win32', win[1], 10), ['-f', 'gdigrab', '-framerate', '10', '-offset_x', '1920', '-offset_y', '0', '-video_size', '1280x720', '-i', 'desktop']);
  assert.equal(inputArgs('darwin', undefined), null);
  assert.equal(inputArgs('linux', DESKTOP)[1], 'x11grab');
  const a = buildArgs('darwin', ['-i', 'x']);
  assert.ok(a.includes('h264_videotoolbox') && a.at(-1) === 'pipe:1' && a.includes('frag_keyframe+empty_moov+default_base_moof'));
  assert.ok(buildArgs('win32', ['-i', 'x']).includes('libx264'));
  // a crop (capture area 'discord' on macOS) goes before the scale in the same -vf
  const c = buildArgs('darwin', ['-i', 'x'], 'crop=10:10:0:0');
  assert.match(c[c.indexOf('-vf') + 1], /^crop=10:10:0:0,scale=/);
});

test('capture area discord: gdigrab title on Windows, a crop on macOS, the whole screen with a note otherwise (faked lookups)', async () => {
  const calls = [];
  const fake = (out) => async (cmd, args) => { calls.push([cmd, args]); return out; };
  // area screen (or an old bot without area): no lookup at all
  assert.deepEqual(await areaInput({ platform: 'win32', display: DESKTOP, fps: 15, area: 'screen', runFn: fake('x') }), { input: inputArgs('win32', DESKTOP, 15) });
  assert.deepEqual(await areaInput({ platform: 'win32', display: DESKTOP, fps: 15, runFn: fake('x') }), { input: inputArgs('win32', DESKTOP, 15) });
  assert.equal(calls.length, 0);
  // Windows: the title resolved at start, passed as one argv item (no shell)
  const w = await areaInput({ platform: 'win32', display: DESKTOP, fps: 10, area: 'discord', runFn: fake('#general | My Server - Discord\r\n') });
  assert.deepEqual(w, { input: ['-f', 'gdigrab', '-framerate', '10', '-i', 'title=#general | My Server - Discord'] });
  assert.equal(calls[0][0], 'powershell');
  assert.match(calls[0][1].join(' '), /Get-Process Discord/);
  assert.deepEqual(await areaInput({ platform: 'win32', display: DESKTOP, area: 'discord', runFn: fake('\r\n') }), { input: inputArgs('win32', DESKTOP, 15), note: AREA_MISS });
  // macOS: the biggest Discord window on the chosen display, as fractions (Retina-proof), even sizes
  const mac = { id: '3', name: 'จอ 2', screen: 1 };
  const info = { screens: [{ x: 0, y: 0, w: 1440, h: 900 }, { x: 1440, y: 0, w: 1920, h: 1080 }],
    wins: [{ X: 100, Y: 100, Width: 400, Height: 300 }, { X: 1440 + 480, Y: 270, Width: 960, Height: 540 }] };
  const m = await areaInput({ platform: 'darwin', display: mac, area: 'discord', runFn: fake(`junk\n${JSON.stringify(info)}\n`) });
  assert.deepEqual(m.input, inputArgs('darwin', mac, 15));
  assert.equal(m.crop, 'crop=trunc(iw*0.5/2)*2:trunc(ih*0.5/2)*2:trunc(iw*0.25):trunc(ih*0.25)');
  assert.equal(calls.at(-1)[0], 'osascript');
  assert.doesNotMatch(calls.at(-1)[1].join(' '), /System Events/, 'no Accessibility / Automation permission needed');
  assert.equal(discordCrop(info, 0), 'crop=trunc(iw*0.27778/2)*2:trunc(ih*0.33333/2)*2:trunc(iw*0.06944):trunc(ih*0.11111)');
  assert.equal(discordCrop({ screens: info.screens, wins: [{ X: 5000, Y: 0, Width: 10, Height: 10 }] }, 0), null, 'off this display');
  assert.deepEqual(await areaInput({ platform: 'darwin', display: mac, area: 'discord', runFn: fake('{"screens":[],"wins":[]}') }),
    { input: inputArgs('darwin', mac, 15), note: AREA_MISS });
  assert.deepEqual(await areaInput({ platform: 'darwin', display: mac, area: 'discord', runFn: async () => { throw new Error('denied'); } }),
    { input: inputArgs('darwin', mac, 15), note: AREA_MISS });
  // Linux: never a window, the whole screen with a note
  const l = await areaInput({ platform: 'linux', display: DESKTOP, area: 'discord', runFn: fake('') });
  assert.deepEqual(l.input, inputArgs('linux', DESKTOP, 15));
  assert.match(l.note, /อัดทั้งจอแทน/);
});

test('helpers: ffmpegPath priority, args, server url rule, hms', () => {
  assert.equal(ffmpegPath({ env: { DRA_FFMPEG: '/x/ff' }, dir: '/h' }), '/x/ff');
  assert.equal(ffmpegPath({ env: {}, dir: '/h', platform: 'linux', exists: (p) => p === '/h/bin/ffmpeg' }), '/h/bin/ffmpeg');
  assert.equal(ffmpegPath({ env: {}, dir: '/h', platform: 'win32', exists: (p) => p.endsWith('ffmpeg.exe') }).endsWith('ffmpeg.exe'), true);
  assert.equal(ffmpegPath({ env: {}, dir: '/h', exists: () => false }), 'ffmpeg', 'dev run (no DRA_HOME): PATH');
  assert.equal(ffmpegPath({ env: { DRA_HOME: '/h' }, dir: '/h', exists: () => false }), null, 'installed: never PATH');
  assert.equal(ffmpegPath({ env: { DRA_HOME: '/h' }, dir: '/h', platform: 'linux', exists: () => true }), join('/h', 'bin', 'ffmpeg'));
  const a = parseArgs(['--server=https://a.b', '--code', '123456', '--consent', '--fps', '10', '--pair-only']);
  assert.deepEqual([a.server, a.code, a.consent, a.fps, a.pairOnly, a.bad], ['https://a.b', '123456', true, '10', true, []]);
  assert.deepEqual(parseArgs(['--nope', '--fps', '999']).bad, ['--nope', '--fps 999']);
  assert.deepEqual(parseArgs(['--ask', '--no-ask']).bad, ['--ask', '--no-ask'], 'ask-first flags are gone');
  assert.equal(normalizeServer('https://rec.example.com/x'), 'https://rec.example.com');
  assert.equal(normalizeServer('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  assert.equal(normalizeServer('http://rec.example.com'), null);
  assert.equal(normalizeServer('nonsense'), null);
  assert.equal(hms(3723000), '01:02:03');
});

test('pair: config written with mode 0600, secret only there; wrong code and non-https refused', async () => {
  const bot = await fakeBot();
  const home = mkdtempSync(join(tmp, 'home-'));
  const stdout = { isTTY: false, write(s) { stdout.out += s; return true; }, out: '' };
  const base = { home, stdout, stdin: { isTTY: false }, env: {}, notifyFn() {} };
  const bad = await runAgent({ ...base, argv: ['--server', bot.url, '--code', '000000', '--consent'] });
  assert.equal(await bad.done, 1);
  assert.match(stdout.out, /รหัสไม่ถูกต้อง/);
  assert.equal(loadConfig(home), null);
  const ok = await runAgent({ ...base, argv: ['--server', bot.url, '--code', '123456', '--pair-only', '--consent'] });
  assert.equal(await ok.done, 0);
  const cfg = loadConfig(home);
  assert.deepEqual([cfg.deviceId, cfg.secret, cfg.server, cfg.consent], ['dev1', 's3cr3t', bot.url, true]);
  if (process.platform !== 'win32') assert.equal(statSync(join(home, 'config.json')).mode & 0o777, 0o600);
  assert.match(stdout.out, /tester/);
  assert.ok(!stdout.out.includes('s3cr3t'));
  assert.equal(bot.st.hello.length, 0); // --pair-only never connects
  assert.equal(bot.st.pairs.at(-1).os, process.platform);
  const http_ = await runAgent({ ...base, argv: ['--server', 'http://example.com', '--code', '1'] });
  assert.equal(await http_.done, 2);
  assert.match(stdout.out, /https/);
  bot.close();
});

test('idle agent polls but never spawns ffmpeg (case 21)', async () => {
  const bot = await fakeBot(), o = await boot(bot);
  try {
    await sleep(700);
    assert.ok(bot.st.polls >= 3, `polls ${bot.st.polls}`);
    assert.equal(bot.st.hello.length, 1);
    assert.deepEqual([o.spawns.length, bot.st.starts.length, bot.st.chunks.length], [0, 0, 0]);
    assert.deepEqual(bot.st.hello[0].displays, [DESKTOP]);
    assert.match(o.out, /⚪ พร้อม — เชื่อมกับ 127\.0\.0\.1:\d+ ในชื่อ tester/);
    assert.ok(!o.out.includes('🔴'));
  } finally { await cleanup(o, bot); }
});

test('start -> claim -> chunks in order -> server stop -> POST stop; local copy removed after the result', async () => {
  const bot = await fakeBot(), o = await boot(bot);
  try {
    bot.st.cmds.push(START);
    await waitFor(() => bot.st.acks.length === 1);
    assert.deepEqual(bot.st.acks[0], { s: bot.st.hello[0].session, id: 'c1', ok: true });
    assert.deepEqual([bot.st.starts[0].id, bot.st.starts[0].token, bot.st.starts[0].mime], ['cap1', 'cap1.x.y', 'video/mp4;codecs=avc1']);
    assert.ok(o.spawns[0].includes('pipe:1') && o.spawns[0].includes('x11grab'));
    assert.match(o.out, /🔴 กำลังอัดจอ 00:00:0\d · กด s เพื่อหยุด/);
    await waitFor(() => bot.st.chunks.length >= 4);
    bot.st.stopFlag = true; // the bot asks to stop (via a chunk/status reply)
    await waitFor(() => bot.st.stops.length === 1);
    const seqs = bot.st.chunks.map((c) => c.seq);
    assert.deepEqual(seqs, seqs.map((_, i) => i), 'contiguous, in order, from 0');
    assert.equal(bot.st.stops[0].reason, 'agent');
    assert.equal(bot.st.stops[0].last, seqs.length - 1);
    assert.ok(bot.st.chunks.every((c) => c.type === 'video/mp4'));
    const all = Buffer.concat(bot.st.chunks.map((c) => c.buf)).toString();
    assert.ok(all.startsWith('HEAD') && all.endsWith('TAIL'), 'ffmpeg got q and flushed its tail');
    await waitFor(() => !existsSync(o.file()));
    assert.match(o.out, /ลบไฟล์ในเครื่องแล้ว/);
    assert.ok(!o.out.includes('s3cr3t') && !o.out.includes('cap1.x.y'), 'no secret or token printed');
    assert.equal(o.agent.recording, null);
    bot.st.stopFlag = false; bot.st.cmds.push({ ...START, id: 'c2', capId: 'cap2' }); // idle again: a new start works
    await waitFor(() => bot.st.acks.length === 2);
    assert.equal(bot.st.acks[1].ok, true);
  } finally { await cleanup(o, bot); }
});

test('server `stop` command ends the capture', async () => {
  const bot = await fakeBot(), o = await boot(bot);
  try {
    bot.st.cmds.push(START);
    await waitFor(() => bot.st.chunks.length >= 2);
    bot.st.cmds.push({ id: 's1', type: 'stop', capId: 'other' }); // not ours: ignored
    await sleep(150);
    assert.equal(bot.st.stops.length, 0);
    bot.st.cmds.push({ id: 's2', type: 'stop', capId: 'cap1' });
    await waitFor(() => bot.st.stops.length === 1);
  } finally { await cleanup(o, bot); }
});

test('never asks: an old bot\'s ask flag and an old config with askFirst true record at once; the config drops askFirst; key a does nothing', async () => {
  const bot = await fakeBot();
  const o = await boot(bot, { env: (home) => (saveConfig(home, { ...loadConfig(home), askFirst: true }), {}) });
  try {
    assert.equal(loadConfig(o.home).askFirst, undefined, 'dropped on the next save (startup)');
    await waitFor(() => bot.st.hello.length === 1);
    assert.equal('askFirst' in bot.st.hello[0], false, 'not reported to the bot');
    o.stdin.emit('data', 'a'); // the old toggle key
    await sleep(100);
    assert.equal(bot.st.states.length, 0);
    assert.equal(loadConfig(o.home).askFirst, undefined);
    bot.st.cmds.push({ ...START, ask: true });
    await waitFor(() => bot.st.acks.length === 1);
    assert.equal(bot.st.acks[0].ok, true);
    assert.equal(o.spawns.length, 1);
    assert.doesNotMatch(o.out, /\(y\/N\)|ถามก่อน/);
  } finally { await cleanup(o, bot); }
});

test('area discord on a machine that cannot find the window: records the whole screen, the ack carries the Thai note', async () => {
  const bot = await fakeBot(), o = await boot(bot); // linux: no window capture
  try {
    bot.st.cmds.push({ ...START, area: 'discord' });
    await waitFor(() => bot.st.acks.length === 1);
    assert.equal(bot.st.acks[0].ok, true);
    assert.match(bot.st.acks[0].detail, /อัดทั้งจอแทน/);
    assert.equal(o.spawns.length, 1);
  } finally { await cleanup(o, bot); }
});

test('local stop key s -> stop reason "agent"; q quits', async () => {
  const bot = await fakeBot(), o = await boot(bot);
  try {
    bot.st.cmds.push(START);
    await waitFor(() => bot.st.chunks.length >= 2);
    o.stdin.emit('data', 's');
    await waitFor(() => bot.st.stops.length === 1);
    assert.equal(bot.st.stops[0].reason, 'agent');
    await waitFor(() => /⚪ พร้อม/.test(o.out.split('🔴').at(-1)));
    o.stdin.emit('data', 'q');
    assert.equal(await o.agent.done, 0);
  } finally { await cleanup(o, bot); }
});

test('Ctrl+C while recording sends reason "unload" then exits', async () => {
  const bot = await fakeBot(), o = await boot(bot);
  try {
    bot.st.cmds.push(START);
    await waitFor(() => bot.st.chunks.length >= 2);
    o.stdin.emit('data', '\x03');
    assert.equal(await o.agent.done, 0);
    assert.equal(bot.st.stops[0].reason, 'unload');
  } finally { await cleanup(o, bot); }
});

test('410 mid-way: capture stops, the local file is kept and its path printed', async () => {
  const bot = await fakeBot(), o = await boot(bot);
  try {
    bot.st.cmds.push(START);
    await waitFor(() => bot.st.chunks.length >= 3);
    bot.st.chunkCode = 410;
    await waitFor(() => o.out.includes('เก็บไฟล์ในเครื่องไว้ที่'));
    assert.ok(o.out.includes(o.file()));
    assert.ok(existsSync(o.file()) && statSync(o.file()).size > 4);
    assert.equal(o.agent.recording, null);
  } finally { await cleanup(o, bot); }
});

test('replaced: stops polling and says so; r takes the slot back with a new session', async () => {
  const bot = await fakeBot(), o = await boot(bot);
  try {
    await waitFor(() => bot.st.polls >= 1);
    bot.st.pollMode = 'replaced';
    await waitFor(() => o.out.includes('กด r เพื่อใช้เครื่องนี้'));
    const n = bot.st.polls;
    await sleep(300);
    assert.equal(bot.st.polls, n, 'no more polls');
    bot.st.pollMode = '';
    o.stdin.emit('data', 'r');
    await waitFor(() => bot.st.hello.length === 2);
    assert.notEqual(bot.st.hello[0].session, bot.st.hello[1].session);
    await waitFor(() => bot.st.polls > n);
  } finally { await cleanup(o, bot); }
});

test('revoked: credentials deleted, agent exits', async () => {
  const bot = await fakeBot(), o = await boot(bot);
  try {
    await waitFor(() => bot.st.polls >= 1);
    bot.st.pollMode = 'revoked';
    assert.equal(await o.agent.done, 0);
    const cfg = loadConfig(o.home);
    assert.ok(!cfg.deviceId && !cfg.secret);
    assert.match(o.out, /ยกเลิกการเชื่อมต่อ/);
  } finally { await cleanup(o, bot); }
});

test('offline: backoff doubles from min to max on ECONNREFUSED and recovers', async () => {
  const s = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r)); // nothing listens here now
  const events = [];
  const link = new Link({
    server: `http://127.0.0.1:${port}`, cred: { deviceId: 'dev1', secret: 's3cr3t' }, info: {}, getState: () => ({}),
    onCmd() {}, onStatus: (k, d) => events.push([k, d?.wait]), T: { min: 10, max: 40 },
  });
  link.start();
  await waitFor(() => events.length >= 5);
  assert.deepEqual(events.slice(0, 5).map((e) => e[1]), [10, 20, 40, 40, 40]);
  assert.ok(events.every((e) => e[0] === 'offline'));
  await link.stop();
});

test('ffmpeg dies at once: ack ffmpeg with the stderr tail, nothing claimed', async () => {
  const bot = await fakeBot(), o = await boot(bot, { mode: 'die' });
  try {
    bot.st.cmds.push(START);
    await waitFor(() => bot.st.acks.length === 1);
    assert.deepEqual([bot.st.acks[0].ok, bot.st.acks[0].error], [false, ACK_ERROR.ffmpeg]);
    assert.match(bot.st.acks[0].detail, /boom/);
    assert.equal(bot.st.starts.length, 0);
    assert.ok(!existsSync(o.file()));
    assert.equal(o.agent.recording, null);
  } finally { await cleanup(o, bot); }
});

test('no frames in time: ack ffmpeg; on macOS with the Screen Recording help', async () => {
  for (const platform of ['linux', 'darwin']) {
    const bot = await fakeBot(), o = await boot(bot, { mode: 'silent', platform, T: { capture: { ...TCAP, first: 250 } } });
    try {
      bot.st.cmds.push(START);
      await waitFor(() => bot.st.acks.length === 1);
      assert.equal(bot.st.acks[0].error, ACK_ERROR.ffmpeg);
      if (platform === 'darwin') { assert.match(bot.st.acks[0].detail, /Screen Recording/); assert.ok(o.spawns[0].includes('avfoundation') && o.spawns[0].includes('1:none')); }
      assert.equal(bot.st.starts.length, 0);
    } finally { await cleanup(o, bot); }
  }
});

test('the bot refuses the claim: ack ffmpeg, no local file left', async () => {
  const bot = await fakeBot(), o = await boot(bot);
  try {
    bot.st.startCode = 410;
    bot.st.cmds.push(START);
    await waitFor(() => bot.st.acks.length === 1);
    assert.equal(bot.st.acks[0].ok, false);
    assert.match(bot.st.acks[0].detail, /410/);
    await sleep(50);
    assert.ok(!existsSync(o.file()));
    assert.equal(bot.st.chunks.length, 0);
  } finally { await cleanup(o, bot); }
});

test('a second start while recording is acked busy', async () => {
  const bot = await fakeBot(), o = await boot(bot);
  try {
    bot.st.cmds.push(START);
    await waitFor(() => bot.st.acks.length === 1);
    bot.st.cmds.push({ ...START, id: 'c2', capId: 'cap2' });
    await waitFor(() => bot.st.acks.length === 2);
    assert.deepEqual([bot.st.acks[1].ok, bot.st.acks[1].error], [false, ACK_ERROR.busy]);
    assert.equal(o.spawns.length, 1);
  } finally { await cleanup(o, bot); }
});

test('Capture rejects a hostile capId (no path traversal into the local copy)', () => {
  assert.throws(() => new Capture({ server: 'http://x', cmd: { capId: '../../etc/x' }, dir: tmp }), /capId/);
});

test('installed agent without its bundled ffmpeg: start acked ffmpeg, nothing spawned', async () => {
  const bot = await fakeBot(), o = await boot(bot, { env: (home) => ({ DRA_HOME: home }) });
  try {
    assert.match(o.out, /ไม่พบ ffmpeg ของตัวอัด/);
    bot.st.cmds.push(START);
    await waitFor(() => bot.st.acks.length === 1);
    assert.deepEqual([bot.st.acks[0].ok, bot.st.acks[0].error], [false, ACK_ERROR.ffmpeg]);
    assert.match(bot.st.acks[0].detail, /ติดตั้ง/);
    assert.equal(o.spawns.length, 0);
  } finally { await cleanup(o, bot); }
});

test('the local copy is deleted once the bot says received (before any result), kept when never confirmed', async () => {
  const bot = await fakeBot(), o = await boot(bot);
  try {
    bot.st.result = { ready: false, url: null, received: true };
    bot.st.cmds.push(START);
    await waitFor(() => bot.st.chunks.length >= 3);
    o.stdin.emit('data', 's');
    await waitFor(() => !existsSync(o.file()));
    assert.match(o.out, /ลบไฟล์ในเครื่องแล้ว/);
  } finally { await cleanup(o, bot); }
  const bot2 = await fakeBot(), o2 = await boot(bot2, { T: { capture: { ...TCAP, resultMax: 200 } } });
  try {
    bot2.st.result = { ready: false, url: null, received: false };
    bot2.st.cmds.push(START);
    await waitFor(() => bot2.st.chunks.length >= 3);
    o2.stdin.emit('data', 's');
    await waitFor(() => o2.out.includes('เก็บไฟล์ในเครื่องไว้ที่'));
    assert.match(o2.out, /no result/);
    assert.ok(existsSync(o2.file()));
  } finally { await cleanup(o2, bot2); }
});

test('a chunk the bot refused: the local copy is kept even if the bot says received', async () => {
  const bot = await fakeBot(), o = await boot(bot);
  try {
    bot.st.result = { ready: true, url: null, received: true };
    bot.st.badSeq = 1;
    bot.st.cmds.push(START);
    await waitFor(() => bot.st.chunks.length >= 3);
    o.stdin.emit('data', 's');
    await waitFor(() => o.out.includes('เก็บไฟล์ในเครื่องไว้ที่'));
    assert.match(o.out, /chunks lost/);
    assert.ok(existsSync(o.file()));
  } finally { await cleanup(o, bot); }
});

test('pruneRecordings: only capture files older than 7 days go; startup runs it', async () => {
  const home = mkdtempSync(join(tmp, 'prune-'));
  const rec = join(home, 'recordings');
  mkdirSync(rec);
  const old = (Date.now() - 8 * 24 * 3600e3) / 1000;
  for (const f of ['old1.mp4', 'old2.mp4', 'new.mp4', 'notes.txt', 'x y.mp4']) writeFileSync(join(rec, f), 'x');
  for (const f of ['old1.mp4', 'old2.mp4', 'notes.txt', 'x y.mp4']) utimesSync(join(rec, f), old, old);
  assert.equal(pruneRecordings(home), 2);
  assert.deepEqual(['old1.mp4', 'old2.mp4', 'new.mp4', 'notes.txt', 'x y.mp4'].map((f) => existsSync(join(rec, f))), [false, false, true, true, true]);
  assert.equal(pruneRecordings(join(home, 'nothing-here')), 0);
  // at startup
  const home2 = mkdtempSync(join(tmp, 'prune2-'));
  mkdirSync(join(home2, 'recordings'));
  writeFileSync(join(home2, 'recordings', 'stale.mp4'), 'x');
  utimesSync(join(home2, 'recordings', 'stale.mp4'), old, old);
  const bot2 = await fakeBot();
  saveConfig(home2, { server: bot2.url, deviceId: 'dev1', secret: 's3cr3t' });
  const out = { s: '' };
  const a = await runAgent({ argv: ['--server', bot2.url], home: home2, env: {}, stdin: { isTTY: false }, stdout: { isTTY: false, write(t) { out.s += t; return true; } },
    listDisplaysFn: async () => [DESKTOP], notifyFn() {}, T: { link: { min: 10, max: 40 } } });
  try {
    assert.ok(!existsSync(join(home2, 'recordings', 'stale.mp4')));
    assert.match(out.s, /เก่ากว่า 7 วัน/);
  } finally { await a.shutdown(); bot2.close(); }
});

test('installers pair through DRA_TOKEN with --pair-only (not argv); without --pair-only it is ignored', async () => {
  const bot = await fakeBot();
  const home = mkdtempSync(join(tmp, 'home-'));
  const stdout = { isTTY: false, write(t) { stdout.out += t; return true; }, out: '' };
  const base = { home, stdout, stdin: { isTTY: false }, notifyFn() {} };
  const ignored = await runAgent({ ...base, argv: ['--server', bot.url], env: { DRA_TOKEN: 'GOODTOKEN' } });
  assert.equal(await ignored.done, 2, 'a stray DRA_TOKEN never pairs a normal run');
  assert.equal(bot.st.pairs.length, 0);
  // without --consent and no terminal to ask on: nothing is paired, the token is not spent
  const noTty = await runAgent({ ...base, argv: ['--server', bot.url, '--pair-only'], env: { DRA_TOKEN: 'GOODTOKEN' } });
  assert.equal(await noTty.done, 0);
  assert.equal(bot.st.pairs.length, 0);
  assert.match(stdout.out, /ยกเลิกการติดตั้ง ไม่ได้ติดตั้งอะไร/);
  const ok = await runAgent({ ...base, argv: ['--server', bot.url, '--pair-only', '--consent'], env: { DRA_TOKEN: 'GOODTOKEN' } });
  assert.equal(await ok.done, 0);
  assert.equal(bot.st.pairs.at(-1).token, 'GOODTOKEN');
  assert.equal(loadConfig(home).secret, 's3cr3t');
  assert.ok(!stdout.out.includes('GOODTOKEN'));
  const dev = await runAgent({ ...base, argv: ['--server', bot.url, '--token', 'GOODTOKEN', '--pair-only'], env: {} });
  assert.equal(await dev.done, 0, '--token still works for developers (an existing config counts as agreed)');
  assert.equal(bot.st.pairs.length, 2);
  bot.close();
});

test('first pairing from a terminal asks once: n pairs nothing, y pairs and stores consent; a config from before is never asked', async () => {
  const bot = await fakeBot();
  const run = async (home, answer) => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    const stdout = { isTTY: false, write(t) { stdout.out += t; return true; }, out: '' };
    if (answer !== null) setTimeout(() => stdin.write(`${answer}\n`), 20);
    const a = await runAgent({ home, stdout, stdin, env: {}, notifyFn() {}, argv: ['--server', bot.url, '--code', '123456', '--pair-only'] });
    return { code: await a.done, out: stdout.out };
  };
  const h1 = mkdtempSync(join(tmp, 'home-'));
  const no = await run(h1, 'n');
  assert.equal(no.code, 0);
  assert.match(no.out, /ให้บอทอัดจอเครื่องนี้ไหม\? \(y\/N\)/);
  assert.match(no.out, /ยกเลิกการติดตั้ง ไม่ได้ติดตั้งอะไร/);
  assert.equal(bot.st.pairs.length, 0);
  assert.equal(loadConfig(h1), null);
  const yes = await run(h1, 'y');
  assert.equal(yes.code, 0);
  assert.equal(bot.st.pairs.length, 1);
  assert.equal(loadConfig(h1).consent, true);
  // an install from before this change (config without consent): pairing again never asks
  const h2 = mkdtempSync(join(tmp, 'home-'));
  saveConfig(h2, { server: bot.url, deviceId: 'old', secret: 'x' });
  const again = await run(h2, null);
  assert.equal(again.code, 0);
  assert.doesNotMatch(again.out, /y\/N/);
  assert.equal(bot.st.pairs.length, 2);
  bot.close();
});

test('an empty answer at the 6-digit code prompt exits 2 with a Thai message, no crash and no config written', async () => {
  const bot = await fakeBot();
  const home = mkdtempSync(join(tmp, 'home-'));
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  const stdout = { isTTY: false, write(t) { stdout.out += t; return true; }, out: '' };
  setTimeout(() => stdin.write('\n'), 20);
  const a = await runAgent({ home, stdout, stdin, env: {}, notifyFn() {}, argv: ['--server', bot.url] });
  assert.equal(await a.done, 2);
  assert.match(stdout.out, /ไม่ได้ใส่รหัส/);
  assert.equal(bot.st.pairs.length, 0);
  assert.equal(loadConfig(home), null);
  bot.close();
});
