import './helpers/env.js';
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadBot, waitFor, sleep, scene, resetFakes } from './helpers/bot.js';
import { fakeInteraction, fakeMember, moveMember, parts, ids } from './helpers/fakes.js';
import { startSession, waitCard } from './helpers/session.js';
import { assertDiscordLimits } from './helpers/limits.js';

// panel, nickname, restart cleanup and logs for sessions and agents (plan B3; §9 cases 4, 20) in browser-capture mode

const { bot, logs, uploads, fire, agents, composed, share } = await loadBot({ SCREEN_ENABLED: 'false', PUBLIC_URL: 'http://localhost:1' });
const { T } = await import('../src/browser-capture.js');
const { updateSettings, getSettings } = await import('../src/settings.js');
Object.assign(T, { drainMax: 50, silent: 50, poll: 5 });
const WAIT = bot.T.wait;
const { voice, screen } = bot;
const content = (p) => p?.content ?? '';
const lastOf = (m) => m.edits.at(-1) ?? m.payload;
const press = async (s, customId, extra) => {
  const i = fakeInteraction({ guild: s.guild, member: s.member, channel: s.text, customId, ...extra });
  await fire('interactionCreate', i);
  return i;
};
const panelOf = (s) => { const p = bot.panel(s.guild); assertDiscordLimits(p, 'panel'); return p; };
const nick = (s) => s.guild.members.me.nickname;
const cardScene = async () => {
  const s = scene(bot, { name: 'Alice' });
  await updateSettings(s.guild.id, { shareCards: true, minMembers: 2, minShareSeconds: 0, mode: 'agent' });
  s.b = fakeMember(s.guild, { name: 'Bob' });
  moveMember(s.b, { channel: s.room });
  return s;
};

beforeEach(() => {
  bot._reset(); bot.client.guilds.cache.clear(); resetFakes();
  uploads.length = 0; logs.err.length = 0; logs.out.length = 0; composed.calls.length = 0; bot.T.wait = WAIT;
});
after(() => bot._reset());

describe('panel (D12 and session states)', () => {
  test('idle: 🎙️ อัดเสียง, 🖥️ อัดจอ (agent), 🌐 อัดผ่านเบราว์เซอร์; no host-Mac button; the cards line, who has an agent online', async () => {
    const s = await cardScene();
    let p = panelOf(s);
    assert.deepEqual(ids(p).slice(0, 3), ['record:start', 'screen:me', 'screen:link']);
    assert.deepEqual(parts(p).slice(0, 3).map((c) => c.label), ['🎙️ อัดเสียง', '🖥️ อัดจอ', '🌐 อัดผ่านเบราว์เซอร์']);
    assert.ok(!ids(p).includes('screen:start'));
    assert.match(content(p), /📣 เมื่อมีคนแชร์จอ: \*\*ส่งการ์ด\*\*/);
    assert.ok(!/ตัวอัดออนไลน์/.test(content(p)));
    agents.setOnline(s.b.id);
    p = panelOf(s);
    assert.match(content(p), new RegExp(`🟢 ตัวอัดออนไลน์: <@${s.b.id}>`));
  });

  test('(old flow) a manual 🖥️ is public at once: the panel shows the room audio and the pending screen, then live', async () => {
    const s = await cardScene();
    s.guild.members.me.nickname = 'Keep';
    agents.setOnline(s.member.id);
    agents.startMode = 'hold';
    const i = fakeInteraction({ guild: s.guild, member: s.member, channel: s.text, customId: 'screen:me' });
    const done = fire('interactionCreate', i);
    await waitFor(() => agents.pending.length === 1, 'machine told');
    await waitFor(() => voice.has(s.guild.id), 'room audio at once');
    assert.match(content(panelOf(s)), new RegExp(`🔴 อัดเสียงในห้อง \\*\\*Meeting\\*\\* · 🟡 รอเริ่มอัดจอของ <@${s.member.id}>`));
    await waitFor(() => nick(s) === 'Alice - 🔴 กำลังอัดเสียง', 'tagged as recording audio');
    agents.ack('ok');
    await done;
    const sess = await waitFor(() => screen.get(s.guild.id)?.cur && screen.get(s.guild.id), 'live');
    assert.match(content(panelOf(s)), new RegExp(`🔴 อัดจอของ <@${s.member.id}>`));
    await waitFor(() => nick(s) === 'Alice - 🔴 กำลังอัดหน้าจอ', 'tagged with the presser');
    await press(s, `screen:stop:${sess.began}`, { message: sess.card });
    await waitFor(() => !screen.has(s.guild.id) && nick(s) === 'Keep', 'restored');
  });

  test('share session: starting, live, switching, waiting, finishing all fit Discord limits', async () => {
    const s = await cardScene();
    agents.setOnline(s.member.id);
    agents.setOnline(s.b.id);
    share(s.member);
    share(s.b);
    agents.startMode = 'hold';
    const card = await waitCard(bot, s);
    const pressing = press(s, `screen:rec:${s.member.id}`, { message: card });
    await waitFor(() => agents.pending.length === 1, 'asked');
    let p = panelOf(s);
    assert.match(content(p), /🟡 รอเริ่มอัดจอของ/);
    agents.ack('ok');
    await pressing;
    const sess = await waitFor(() => screen.get(s.guild.id)?.cur && screen.get(s.guild.id), 'live');
    await waitFor(() => voice.has(s.guild.id), 'room joined');
    p = panelOf(s);
    assert.match(content(p), new RegExp(`🔴 อัดจอของ <@${s.member.id}> · ห้อง \\*\\*Meeting\\*\\*`));
    assert.ok(ids(p).includes('screen:stop') && !ids(p).includes('record:start'), 'one red stop, no 🎙️');
    share(s.member, false);
    await waitFor(() => sess.state === 'waiting', 'waiting');
    p = panelOf(s);
    assert.match(content(p), /⏸️ รอเลือกจอถัดไปในห้อง \*\*Meeting\*\* · เสียงยังอัดอยู่/);
    await press(s, `screen:stop:${sess.began}`, { message: sess.card });
    await waitFor(() => !screen.has(s.guild.id), 'finished');
    assert.match(content(panelOf(s)), /ยังไม่ได้อัด/);
  });
});

describe('nickname (D13)', () => {
  test('X live → waiting (the presser, voice) → Y live → restored after', async () => {
    const s = await cardScene();
    s.guild.members.me.nickname = 'Keep';
    agents.setOnline(s.member.id);
    agents.setOnline(s.b.id);
    share(s.b);
    const sess = await startSession(bot, s, { sharer: s.member });
    await waitFor(() => nick(s) === 'Alice - 🔴 กำลังอัดหน้าจอ', 'X');
    share(s.member, false);
    await waitFor(() => sess.state === 'waiting', 'waiting');
    await waitFor(() => nick(s) === 'Alice - 🔴 กำลังอัดเสียง', 'the presser, voice only');
    await press(s, `screen:cont:${sess.began}.${s.b.id}`, { message: sess.card });
    await waitFor(() => sess.cur?.owner === s.b.id, 'Y live');
    await waitFor(() => nick(s) === 'Bob - 🔴 กำลังอัดหน้าจอ', 'Y');
    await press(s, `screen:stop:${sess.began}`, { message: sess.card });
    await waitFor(() => !screen.has(s.guild.id) && nick(s) === 'Keep', 'restored');
  });
});

describe('restart cleanup', () => {
  test('a live session card is marked ⚠️ and forgotten', async () => {
    const s = await cardScene();
    agents.setOnline(s.member.id);
    const sess = await startSession(bot, s);
    const g = s.guild.id;
    const card = sess.card;
    assert.deepEqual(getSettings(g).cards, [[card.channelId, card.id]]);
    bot._reset();
    await fire('clientReady', bot.client);
    await waitFor(() => /บอทรีสตาร์ทระหว่างอัด/.test(content(lastOf(card))), 'session card marked');
    assert.deepEqual(lastOf(card).components, []);
    await waitFor(() => getSettings(g).cards.length === 0, 'list cleared');
    assert.ok(!(getSettings(g).roomCards ?? []).some(([, m]) => m === card.id), 'the session card is not a room card');
    bot._reset();
  });
});

describe('logs', () => {
  test('one line per agent transition, one per press / start / end; nothing secret', async () => {
    const s = await cardScene();
    agents.setOnline(s.member.id);
    agents.setOnline(s.member.id); // no transition: no line
    const sess = await startSession(bot, s);
    await press(s, `screen:stop:${sess.began}`, { message: sess.card });
    await waitFor(() => !screen.has(s.guild.id) && /^[✅❌⚪]/.test(content(lastOf(sess.card))), 'done');
    const out = logs.out.join('\n');
    assert.equal(logs.out.filter((x) => /🟢 ตัวอัดของ/.test(x)).length, 1);
    assert.equal(logs.out.filter((x) => /กดอัดจอของ/.test(x)).length, 1, 'the press');
    assert.equal(logs.out.filter((x) => /🎥 อัดจอของ .*\(ตัวอัด\)/.test(x)).length, 1, 'the start, once');
    assert.equal(logs.out.filter((x) => /🎞️ รวมไฟล์|ส่งผลอัดห้อง/.test(x)).length, 2, 'compose + delivery');
    assert.ok(!/token|secret|Bearer|\/capture\/[A-Za-z0-9_-]{20,}/i.test(out), 'no token or link in the log');
  });

  test('a removed room card is logged', async () => {
    const s = await cardScene();
    agents.setOnline(s.b.id);
    share(s.b);
    await waitCard(bot, s);
    share(s.b, false);
    await waitFor(() => logs.out.some((x) => /🗑️ ลบการ์ดแชร์จอ ห้อง Meeting/.test(x)), 'card removed line');
  });
});
