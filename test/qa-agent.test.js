import { tmp } from './helpers/env.js';
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { join } from 'node:path';
import { loadBot, waitFor, sleep, scene, resetFakes } from './helpers/bot.js';
import { fakeMember, moveMember, parts, ids, FakeVoiceRecorder } from './helpers/fakes.js';
import { waitCard, pressOn, pressRec, startSession } from './helpers/session.js';

// QA extras for the recorder agent + press-to-start sessions: races, rule 6 (one file) corners, pairing security.

const { bot, logs, uploads, agents, composed, share } = await loadBot({ SCREEN_ENABLED: 'false', PUBLIC_URL: 'http://localhost:1' });
const { T } = await import('../src/browser-capture.js');
const { updateSettings } = await import('../src/settings.js');
const { AgentHub, T: HT } = await import('../src/agent-hub.js');
Object.assign(T, { drainMax: 50, silent: 50, poll: 5 });
const WAIT = bot.T.wait;
const { voice, screen } = bot;
const content = (p) => p?.content ?? '';
const lastOf = (m) => m.edits.at(-1) ?? m.payload;
const press = (s, customId, extra) => pressOn(bot, s, customId, extra);
const labels = (p) => parts(p).map((c) => c.label);
const cardScene = async (patch = {}, opts = {}) => {
  const s = scene(bot, { name: 'Alice', ...opts });
  await updateSettings(s.guild.id, { shareCards: true, minMembers: 2, minShareSeconds: 0, mode: 'agent', ...patch });
  s.b = fakeMember(s.guild, { name: 'Bob' });
  moveMember(s.b, { channel: s.room });
  return s;
};
const resultOf = async (s, sess) => {
  await waitFor(() => !screen.has(s.guild.id) && !voice.has(s.guild.id) && /^[✅❌⚪]/.test(content(lastOf(sess.card))), 'result');
  await sleep(40);
  return lastOf(sess.card);
};
// A records (agent), B shares on top, both have agents
const two = async () => {
  const s = await cardScene();
  agents.setOnline(s.member.id);
  agents.setOnline(s.b.id);
  const sess = await startSession(bot, s);
  share(s.b);
  await waitFor(() => ids(lastOf(sess.card)).includes(`screen:switch:${sess.began}.${s.b.id}`), '🔁 B');
  return [s, sess];
};

beforeEach(() => {
  bot._reset(); bot.client.guilds.cache.clear(); resetFakes();
  uploads.length = 0; logs.err.length = 0; composed.calls.length = 0; bot.deps.composeFails = null; bot.T.wait = WAIT;
});
after(() => bot._reset());

describe('session races', () => {
  test('(old flow) ⏹️ while the machine is being told, then a late ack ok: the room audio joined at once ends cleanly, the machine is told to stop', async () => {
    const s = await cardScene();
    agents.setOnline(s.b.id, { askFirst: true });
    agents.startMode = 'hold';
    share(s.b);
    const pressing = pressRec(bot, s, s.b.id);
    const g = s.guild.id;
    const sess = await waitFor(() => screen.get(g), 'reserved');
    await waitFor(() => agents.pending.length === 1 && sess.paired, 'commanded and joined');
    await press(s, `screen:stop:${sess.began}`, { message: sess.card });
    assert.ok(!screen.has(g), 'ended');
    agents.ack('ok');
    await pressing;
    await sleep(60);
    assert.equal(screen.size + voice.size, 0);
    assert.ok(FakeVoiceRecorder.instances[0].stopped, 'the bot left');
    assert.equal(composed.calls.length, 0, 'no video was recorded');
    assert.ok(agents.stops.some((x) => x.userId === s.b.id), 'the machine is told to stop');
    assert.ok(!logs.err.length, `unexpected errors: ${logs.err.join('|')}`);
  });

  test('the sharer stops sharing while the first ack is pending: ends cleanly after the ack, one result, bot leaves', async () => {
    const s = await cardScene();
    agents.setOnline(s.b.id, { askFirst: true });
    agents.startMode = 'hold';
    share(s.b);
    const pressing = pressRec(bot, s, s.b.id);
    const g = s.guild.id;
    const sess = await waitFor(() => screen.get(g), 'reserved');
    await waitFor(() => agents.pending.length === 1, 'asked');
    share(s.b, false);
    await sleep(30);
    assert.equal(screen.get(g), sess, 'still starting, not killed mid-ack');
    agents.ack('ok');
    await pressing;
    await resultOf(s, sess);
    assert.equal(screen.size + voice.size, 0);
    assert.ok(FakeVoiceRecorder.instances.every((v) => v.stopped), 'every room recorder stopped');
    assert.ok(!logs.err.length, `unexpected errors: ${logs.err.join('|')}`);
  });

  test('two different sharers pressed in the same tick: one session, one machine commanded', async () => {
    const s = await cardScene();
    agents.setOnline(s.member.id);
    agents.setOnline(s.b.id);
    share(s.member);
    share(s.b);
    await waitFor(() => bot.roomCards.get(s.room.id)?.sharers.length === 2, 'both');
    const card = await waitCard(bot, s);
    const [x, y] = await Promise.all([press(s, `screen:rec:${s.member.id}`, { message: card }), press(s, `screen:rec:${s.b.id}`, { message: card })]);
    const refused = [x, y].filter((i) => i.replies.length);
    assert.equal(refused.length, 1);
    assert.match(content(refused[0].replies[0]), /^กำลังอัดอยู่แล้ว/);
    assert.equal(agents.calls.length, 1, 'viewer / second machine never commanded');
  });

  test('a 🔁 candidate who is not the current screen cannot ⏹️ the session; a guest cannot 🔁', async () => {
    const [s, sess] = await two();
    const bobNoRights = await press(s, `screen:stop:${sess.began}`, { member: s.b, message: sess.card });
    assert.match(content(bobNoRights.replies[0]), /^🔒/, 'B shares but is not the recorded screen');
    const guest = fakeMember(s.guild, { name: 'Guest' });
    const g2 = await press(s, `screen:switch:${sess.began}.${s.b.id}`, { member: guest, message: sess.card });
    assert.match(content(g2.replies[0]), /^🔒/);
    assert.equal(agents.calls.length, 1, 'refused presses commanded no machine');
  });

  test('the agent of B drops during the 2-minute wait: 🔴 ต่อ falls back to the card link, never silently to nothing', async () => {
    const [s, sess] = await two();
    share(s.member, false);
    await waitFor(() => sess.state === 'waiting', 'waiting');
    agents.setOnline(s.b.id, false);
    await press(s, `screen:cont:${sess.began}.${s.b.id}`, { message: sess.card });
    await waitFor(() => sess.state === 'live', 'live again');
    assert.equal(sess.cur.source, 'link');
    await sess.cardQ;
    assert.ok(parts(lastOf(sess.card)).some((c) => c.url), 'the card carries the link for B');
    assert.equal(FakeVoiceRecorder.instances.length, 1, 'voice unbroken');
  });

  test('stale 🔴 for a second room that is busy: refused with the busy text, no machine commanded', async () => {
    const s = await cardScene();
    agents.setOnline(s.member.id);
    await startSession(bot, s);
    const { fakeVoiceChannel } = await import('./helpers/fakes.js');
    const room2 = fakeVoiceChannel(s.guild, { name: 'Lobby' });
    const c = fakeMember(s.guild, { name: 'Carol' });
    agents.setOnline(c.id);
    moveMember(fakeMember(s.guild, { name: 'Dan' }), { channel: room2 });
    moveMember(c, { channel: room2 });
    share(c);
    const card2 = await waitCard(bot, s, room2);
    const i = await press(s, `screen:rec:${c.id}`, { message: card2 });
    assert.match(content(i.replies[0]), /ทีละห้อง/);
    assert.equal(agents.calls.length, 1);
  });
});

describe('rule 6: one output file', () => {
  // one session with two segments (A then B), then the end
  const twoSegments = async (silent) => {
    const [s, sess] = await two();
    await press(s, `screen:switch:${sess.began}.${s.b.id}`, { message: sess.card });
    await waitFor(() => sess.cur?.owner === s.b.id, 'B current');
    if (silent) FakeVoiceRecorder.instances[0].nobodySpoke = true;
    await press(s, `screen:stop:${sess.began}`, { message: sess.card });
    return [s, sess, await resultOf(s, sess)];
  };

  test('two segments with room audio: one meeting file', async () => {
    const [, , out] = await twoSegments(false);
    assert.equal(composed.calls.length, 1);
    assert.equal(uploads.length, 1);
    assert.match(content(out), /^✅/);
  });

  test('two segments in a room where nobody spoke: still one meeting file (video only)', async () => {
    const [, , out] = await twoSegments(true);
    assert.equal(composed.calls.length, 1, 'compose must run for 2 video segments even without audio');
    assert.equal(uploads.length, 1, 'one file delivered');
    assert.ok(!/⚠️/.test(content(out)));
    assert.equal(composed.calls[0].audio, null);
    const first = Math.min(...composed.calls[0].segments.map((x) => x.start));
    assert.ok(composed.calls[0].audioStart <= first, 'the origin is not after the first video (nothing trimmed)');
  });

  test('compose fails with 4 segments: at most 3 videos + voice, link buttons <= 5, a note about the rest', async () => {
    const [s, sess] = await two();
    for (const to of [s.b.id, s.member.id, s.b.id]) { // A -> B -> A -> B
      await press(s, `screen:switch:${sess.began}.${to}`, { message: sess.card });
      await waitFor(() => sess.cur?.owner === to && !sess.pending, `switched to ${to}`);
    }
    assert.equal(sess.segments.length, 4);
    bot.deps.composeFails = new Error('ffmpeg boom');
    await press(s, `screen:stop:${sess.began}`, { message: sess.card });
    const out = await resultOf(s, sess);
    assert.match(content(out), /รวมเป็นไฟล์เดียวไม่สำเร็จ/);
    assert.match(content(out), /มีวิดีโอ 4 ช่วง/);
    assert.ok(parts(out).length <= 5, `${parts(out).length} buttons`);
    assert.equal(uploads.length, 4, '3 videos + voice');
  });
});

describe('manual session vs share cards', () => {
  test('after a manual 🎥 ends, someone who kept sharing is offered a card (they were never offered one during it)', async () => {
    const s = await cardScene();
    agents.setOnline(s.member.id);
    const c = fakeMember(s.guild, { name: 'Carol' });
    moveMember(c, { channel: s.room });
    const i = (await import('./helpers/fakes.js')).fakeInteraction({ guild: s.guild, member: s.member, channel: s.text, customId: 'screen:me' });
    await bot.client.listeners('interactionCreate')[0](i);
    const g = s.guild.id;
    const sess = await waitFor(() => screen.get(g)?.cur && voice.get(g) && screen.get(g), 'manual live');
    await sess.cardQ;
    share(c);
    await sleep(40);
    assert.ok(!bot.roomCards.has(s.room.id), 'no room card inside the session room');
    await press(s, `screen:stop:${sess.began}`, { message: sess.card });
    await resultOf(s, sess);
    await sleep(60);
    assert.ok(bot.roomCards.has(s.room.id), 'Carol still shares and nothing recorded her: she should get a card');
  });
});

// --- pairing security on the real hub, over HTTP (no Discord, no capture server) -----------------------------

describe('hub pairing security', () => {
  const FILE = join(tmp, 'qa-agents.json');
  let hub, server, base;
  const out = [];
  const origLog = { log: console.log, error: console.error };
  const fail = (e) => ({ status: e.status ?? 500, body: e.body ?? { error: 'server' } });
  const req = (path, { method = 'POST', body, headers = {} } = {}) => new Promise((res, rej) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request(base + path, { method, headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, (rr) => {
      let t = '';
      rr.on('data', (d) => { t += d; }).on('end', () => res([rr.statusCode, t ? JSON.parse(t) : null]));
    });
    r.on('error', rej);
    r.end(data);
  });
  const auth = (c) => ({ authorization: `Bearer ${c.deviceId}.${c.secret}` });

  test('setup', async () => {
    hub = new AgentHub({ file: FILE });
    server = http.createServer(async (rq, rs) => {
      try { await hub.handle(rq, rs, new URL(rq.url, 'http://x').pathname, null); } catch (e) {
        const { status, body } = fail(e);
        rs.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    console.log = (...a) => out.push(a.join(' '));
    console.error = (...a) => out.push(a.join(' '));
  });

  test('the same token used by two requests at once pairs exactly one device', async () => {
    const p = hub.newPairing('u1', 'g1', 'alice');
    const rs = await Promise.all([1, 2, 3, 4].map((n) => req('/api/agent/pair', { body: { token: p.token, name: `m${n}` } })));
    assert.equal(rs.filter(([s]) => s === 200).length, 1);
    assert.equal(rs.filter(([s]) => s === 410).length, 3);
    assert.equal(hub.devices('u1').length, 1);
  });

  test('an expired token is refused (410) and leaves no device', async () => {
    const was = HT.pair;
    HT.pair = 5;
    const p = hub.newPairing('u2', 'g1');
    HT.pair = was;
    await sleep(15);
    assert.deepEqual(await req('/api/agent/pair', { body: { token: p.token } }), [410, { error: 'code' }]);
    assert.equal(hub.devices('u2').length, 0);
  });

  test('every authed route refuses an Origin header, even with valid credentials', async () => {
    const p = hub.newPairing('u3', 'g1');
    const [, c] = await req('/api/agent/pair', { body: { token: p.token, name: 'x' } });
    for (const [path, method, body] of [['/api/agent/hello', 'POST', { session: 'session-1' }], ['/api/agent/poll?s=session-1', 'GET'],
      ['/api/agent/ack', 'POST', { s: 'session-1', id: 'x', ok: true }], ['/api/agent/state', 'POST', { s: 'session-1' }]]) {
      const [st] = await req(path, { method, body, headers: { ...auth(c), origin: 'https://evil.example' } });
      assert.equal(st, 403, path);
    }
    const [st] = await req('/api/agent/hello', { body: { session: 'session-1' }, headers: auth(c) });
    assert.equal(st, 200, 'without Origin it works');
  });

  test('a replaced session cannot ack or change state (409), a revoked device gets 401 everywhere', async () => {
    const p = hub.newPairing('u4', 'g1');
    const [, c] = await req('/api/agent/pair', { body: { token: p.token, name: 'x' } });
    await req('/api/agent/hello', { body: { session: 'session-aaaa' }, headers: auth(c) });
    await req('/api/agent/hello', { body: { session: 'session-bbbb' }, headers: auth(c) }); // same device, new process: newest wins
    assert.equal((await req('/api/agent/ack', { body: { s: 'session-aaaa', id: 'x', ok: true }, headers: auth(c) }))[0], 409);
    assert.equal((await req('/api/agent/state', { body: { s: 'session-aaaa', askFirst: true }, headers: auth(c) }))[0], 409);
    assert.deepEqual(Object.keys(hub.online('u4')).sort(), ['deviceId', 'name'], 'askFirst is never kept (old agents may still send it)');
    assert.equal(hub.revoke('u4', 'all'), 1);
    for (const [path, method, body] of [['/api/agent/hello', 'POST', { session: 'session-bbbb' }], ['/api/agent/poll?s=session-bbbb', 'GET'],
      ['/api/agent/ack', 'POST', { s: 'session-bbbb', id: 'x', ok: true }], ['/api/agent/state', 'POST', { s: 'session-bbbb' }]]) {
      assert.equal((await req(path, { method, body, headers: auth(c) }))[0], 401, path);
    }
  });

  test('a bot restart (store reloaded, sessions gone): the old session polls 404 and a new hello with the same id works', async () => {
    const p = hub.newPairing('u5', 'g1');
    const [, c] = await req('/api/agent/pair', { body: { token: p.token, name: 'x' } });
    await req('/api/agent/hello', { body: { session: 'session-rest' }, headers: auth(c) });
    await hub.writing;
    hub._reset();
    assert.equal((await req('/api/agent/poll?s=session-rest', { method: 'GET', headers: auth(c) }))[0], 404);
    assert.equal((await req('/api/agent/hello', { body: { session: 'session-rest' }, headers: auth(c) }))[0], 200);
    assert.ok(hub.online('u5'));
  });

  test('hostile device names and sessions: control characters stripped, odd session ids refused, huge body 413', async () => {
    const p = hub.newPairing('u6', 'g1');
    const [st, c] = await req('/api/agent/pair', { body: { token: p.token, name: 'a\u0000b\nc\u001b[31m' + 'x'.repeat(200), os: 'x'.repeat(100) } });
    assert.equal(st, 200);
    const d = hub.devices('u6')[0];
    assert.ok(d.name.length <= 64 && !/[\u0000-\u001f]/.test(d.name));
    assert.equal((await req('/api/agent/hello', { body: { session: '../../etc' }, headers: auth(c) }))[0], 400);
    assert.equal((await req('/api/agent/hello', { body: { session: 'session-ok', displays: 'x'.repeat(5000) }, headers: auth(c) }))[0], 413);
  });

  test('no pairing token / code / secret ends up in the logs', async () => {
    const p = hub.newPairing('u7', 'g1');
    const [, c] = await req('/api/agent/pair', { body: { token: p.token, name: 'x' } });
    await req('/api/agent/hello', { body: { session: 'session-log' }, headers: auth(c) });
    await req('/api/agent/pair', { body: { code: '123456' } });
    hub.revoke('u7', 'all');
    const all = out.join('\n');
    for (const secret of [p.token, p.code, c.secret]) assert.ok(!all.includes(secret));
  });

  test('teardown', async () => {
    Object.assign(console, origLog);
    hub._reset();
    server.closeAllConnections();
    server.close();
  });
});
