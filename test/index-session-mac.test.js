import './helpers/env.js';
import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadBot, waitFor, sleep, scene, resetFakes } from './helpers/bot.js';
import { fakeMember, moveMember, parts, FakeScreenRecorder } from './helpers/fakes.js';
import { pressOn, pressRec, startSession } from './helpers/session.js';
import { assertDiscordLimits } from './helpers/limits.js';

// D10 on a bot without PUBLIC_URL: the host Mac is the only screen source (agents and links need PUBLIC_URL; with it
// the host-Mac modes are hidden, see index-edge-hybrid)

const { bot, uploads, agents, composed, share } = await loadBot({ SCREEN_ENABLED: 'true' });
const { T } = await import('../src/browser-capture.js');
const { updateSettings } = await import('../src/settings.js');
Object.assign(T, { drainMax: 50, silent: 50, poll: 5 });
const { voice, screen } = bot;
const content = (p) => p?.content ?? '';
const lastOf = (m) => m.edits.at(-1) ?? m.payload;
const labels = (p) => parts(p).map((c) => c.label);
const press = (s, customId, extra) => pressOn(bot, s, customId, extra);
const cardScene = async (mode = 'screen') => {
  const s = scene(bot, { name: 'Alice' });
  await updateSettings(s.guild.id, { shareCards: true, minMembers: 2, minShareSeconds: 0, mode });
  s.b = fakeMember(s.guild, { name: 'Bob' });
  moveMember(s.b, { channel: s.room });
  return s;
};
const done = (s, sess) => waitFor(() => !screen.has(s.guild.id) && /^✅/.test(content(lastOf(sess.card))), 'result');

beforeEach(() => { bot._reset(); bot.client.guilds.cache.clear(); resetFakes(); uploads.length = 0; composed.calls.length = 0; });
afterEach(() => sleep(40));
after(() => bot._reset());

test('host Mac only: 🔴 records the host Mac, never an agent (even one online)', async () => {
  const s = await cardScene('screen');
  agents.setOnline(s.member.id);
  const sess = await startSession(bot, s);
  assert.equal(sess.cur.source, 'mac');
  assert.equal(agents.calls.length, 0);
  assert.equal(FakeScreenRecorder.instances.length, 1);
  assertDiscordLimits(lastOf(sess.card), 'mac session card');
  await press(s, `screen:stop:${sess.began}`, { message: sess.card });
  await done(s, sess);
  assert.equal(composed.calls[0].segments.length, 1);
});

test('D10: the host Mac busy elsewhere: a 🔴 is refused with the busy text', async () => {
  const a = await cardScene('screen');
  await startSession(bot, a);
  const b = await cardScene('screen');
  share(b.member);
  const i = await pressRec(bot, b);
  assert.match(content(i.replies[0]), /จอเครื่องบอทกำลังถูกอัดอยู่/);
  assert.equal(screen.has(b.guild.id), false);
});

test('(old flow) host Mac, auto mode: a share records the host Mac by itself and the bot joins at once', async () => {
  const s = await cardScene('screen');
  await updateSettings(s.guild.id, { shareMode: 'auto' });
  share(s.member);
  const sess = await waitFor(() => screen.get(s.guild.id)?.cur && screen.get(s.guild.id).paired && screen.get(s.guild.id), 'auto Mac');
  assert.ok(sess.auto);
  assert.equal(sess.cur.source, 'mac');
  assert.equal(voice.size, 1);
  share(s.member, false);
  await done(s, sess);
});

test('🔁 on the Mac to someone without an agent: same recorder, only whose share it is changes', async () => {
  const s = await cardScene('screen');
  const sess = await startSession(bot, s);
  share(s.b);
  await waitFor(() => labels(lastOf(sess.card)).includes('🔁 สลับไปอัด Bob'), '🔁');
  await press(s, `screen:switch:${sess.began}.${s.b.id}`, { message: sess.card });
  assert.equal(sess.cur.owner, s.b.id);
  assert.equal(sess.segments.length, 1);
  assert.equal(FakeScreenRecorder.instances.length, 1);
  share(s.member, false); // Alice stopping no longer matters
  await sleep(30);
  assert.equal(sess.state, 'live');
  share(s.b, false); // Bob does
  await done(s, sess);
});

test('🔴 ต่อ on the Mac after the wait started: a new Mac segment', async () => {
  const s = await cardScene('screen');
  const sess = await startSession(bot, s);
  share(s.b);
  share(s.member, false);
  await waitFor(() => sess.state === 'waiting', 'waiting');
  await waitFor(() => FakeScreenRecorder.instances[0].stopped, 'first file written');
  await sleep(10);
  await press(s, `screen:cont:${sess.began}.${s.b.id}`, { message: sess.card });
  await waitFor(() => sess.state === 'live' && sess.cur.owner === s.b.id, 'B on the Mac');
  assert.equal(FakeScreenRecorder.instances.length, 2);
  assert.equal(voice.size, 1);
  await press(s, `screen:stop:${sess.began}`, { message: sess.card });
  await done(s, sess);
});
