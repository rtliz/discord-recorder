import './helpers/env.js';
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadBot, waitFor, sleep, scene, resetFakes } from './helpers/bot.js';
import { fakeInteraction, fakeMember, moveMember, FakeVoiceRecorder } from './helpers/fakes.js';
import { pressRec, waitCard, startSession } from './helpers/session.js';
import { assertDiscordLimits } from './helpers/limits.js';

// fixes after QA/review of the agent batch: 🖥️ vs the mode setting, the join/screen race, cardSkip only while
// sharing, an expired 🔴 press, one config patch table, cleanup of a dropped agent segment, the /agent area line
const { bot, logs, fire, agents } = await loadBot({ SCREEN_ENABLED: 'false', PUBLIC_URL: 'http://localhost:1' });
const { T } = await import('../src/browser-capture.js');
const { updateSettings, getSettings } = await import('../src/settings.js');
const { applyConfig } = await import('../src/config-ui.js');
Object.assign(T, { drainMax: 50, silent: 50, poll: 5 });
const { screen, voice, cardSkip, roomCards } = bot;
const content = (p) => p?.content ?? '';
const lastOf = (m) => m.edits.at(-1) ?? m.payload;
const press = async (s, customId, extra) => { const i = fakeInteraction({ guild: s.guild, member: s.member, channel: s.text, customId, ...extra }); await fire('interactionCreate', i); return i; };
const share = (m, on = true) => bot.client.listeners('voiceStateUpdate')[0](...moveMember(m, { streaming: on }));
const cardsOn = (s, extra = {}) => updateSettings(s.guild.id, { shareMode: 'card', minMembers: 1, minShareSeconds: 0, mode: 'agent', ...extra });

beforeEach(() => { bot._reset(); bot.client.guilds.cache.clear(); resetFakes(); logs.err.length = 0; logs.out.length = 0; });
after(() => bot._reset());

describe('D1: browser mode never commands an agent on a share start', () => {
  test('🔴 with mode=browser and the sharer\'s agent online: the card link, no agent call', async () => {
    const s = scene(bot, { name: 'Alice' });
    await cardsOn(s, { mode: 'browser' });
    agents.setOnline(s.member.id);
    const sess = await startSession(bot, s);
    assert.equal(sess.cur.source, 'link');
    assert.equal(agents.calls.length, 0);
  });
});

describe('D2: the join and the first screen, in either order', () => {
  test('agent declines -> link (unopened), THEN the join fails: cancelled, the sharer skipped', async () => {
    const s = scene(bot, { name: 'Alice' });
    const g = s.guild.id;
    await cardsOn(s);
    agents.setOnline(s.member.id);
    agents.startMode = 'declined';
    let failJoin;
    FakeVoiceRecorder.startHook = () => new Promise((_, rej) => { failJoin = () => rej(new Error('join timeout')); });
    share(s.member);
    pressRec(bot, s).catch(() => {});
    const sess = await waitFor(() => screen.get(g)?.cur?.source === 'link' && failJoin && screen.get(g), 'fell back to the link');
    failJoin();
    await waitFor(() => sess.finished, 'cancelled');
    await sess.cardQ;
    assert.equal(screen.has(g), false);
    assert.equal(voice.has(g), false);
    assert.match(content(lastOf(sess.card)), /^⚪ \*\*ไม่ได้อัด\*\* — ❌ บอทเข้าห้องเสียง \*\*Meeting\*\* ไม่ได้: join timeout/);
    assert.ok(cardSkip.get(g)?.has(s.member.id), 'not offered again until they re-share');
  });

  test('the join fails while the agent ack is pending, then the agent records: the video goes on with one note', async () => {
    const s = scene(bot, { name: 'Alice' });
    const g = s.guild.id;
    await cardsOn(s);
    agents.setOnline(s.member.id);
    agents.startMode = 'hold';
    FakeVoiceRecorder.startHook = () => { throw new Error('join timeout'); };
    share(s.member);
    pressRec(bot, s).catch(() => {});
    await waitFor(() => agents.pending.length, 'held');
    const sess = screen.get(g);
    await waitFor(() => sess.joinState === 'fail', 'join failed');
    assert.equal(sess.notes, '', 'decided only once the screen is known');
    agents.ack('ok');
    await waitFor(() => sess.cur?.source === 'agent', 'agent live');
    await sleep(20);
    assert.equal(sess.finished, false);
    assert.equal(sess.notes.match(/อัดแค่ภาพจอ ไม่มีเสียงในห้อง/g)?.length, 1);
  });
});

describe('R1: cardSkip only while the user still shares', () => {
  test('🖥️ without sharing, ⏹️, then a real share: their card appears', async () => {
    const s = scene(bot, { name: 'Alice' });
    const g = s.guild.id;
    await cardsOn(s);
    s.b = fakeMember(s.guild, { name: 'Bob' }); moveMember(s.b, { channel: s.room });
    agents.setOnline(s.member.id);
    await press(s, 'screen:me');
    const sess = await waitFor(() => screen.get(g)?.cur && voice.get(g) && screen.get(g), 'manual session live');
    await sess.cardQ;
    await press(s, `screen:stop:${sess.began}`, { message: sess.card });
    await waitFor(() => /^✅/.test(content(lastOf(sess.card))), 'delivered');
    assert.equal(cardSkip.get(g)?.has(s.member.id) ?? false, false);
    share(s.member);
    await waitFor(() => roomCards.get(s.room.id)?.sharers?.includes(s.member.id), 'card for the new share');
  });
});

describe('R2: 🔴 whose deferUpdate rejects (10062)', () => {
  test('the session still starts and can be stopped; nothing stuck', async () => {
    const s = scene(bot, { name: 'Alice' });
    const g = s.guild.id;
    await cardsOn(s);
    agents.setOnline(s.member.id);
    share(s.member);
    const card = await waitCard(bot, s);
    const i = fakeInteraction({ guild: s.guild, member: s.member, channel: s.text, customId: `screen:rec:${s.member.id}`, message: card });
    i.deferUpdate = async () => { throw Object.assign(new Error('Unknown interaction'), { code: 10062 }); };
    await fire('interactionCreate', i);
    const sess = await waitFor(() => screen.get(g)?.cur && voice.get(g) && screen.get(g), 'live');
    assert.equal(sess.cur.source, 'agent');
    await sess.cardQ;
    await press(s, `screen:stop:${sess.began}`, { message: sess.card });
    await waitFor(() => /^✅/.test(content(lastOf(sess.card))), 'delivered');
    assert.equal(screen.has(g), false);
    assert.equal(voice.has(g), false);
  });
});

describe('R3: one config patch table', () => {
  test('handleConfig rejects empty / NaN numbers, filters days, ignores unknown who / unavailable mode', async () => {
    const s = scene(bot, { name: 'Alice' });
    const g = s.guild.id;
    await updateSettings(g, { minMembers: 2, from: 9, days: [1] });
    const sel = (id, values) => press(s, id, { kind: 'select', values });
    assert.ok((await sel('config:min', [''])).deferredUpdate, 'nothing saved');
    await sel('config:from', ['abc']);
    await sel('config:who', ['anyone']);
    await sel('config:mode', ['screen']); // a host-Mac mode isn't offered with PUBLIC_URL
    let st = getSettings(g);
    assert.deepEqual([st.minMembers, st.from, st.anyoneRecords, st.mode], [2, 9, false, 'agent']);
    await sel('config:days', ['9', '2', '2', 'x', '0']);
    await sel('config:min', ['3']);
    st = getSettings(g);
    assert.deepEqual([st.days, st.minMembers], [[0, 2], 3]);
  });

  test('applyConfig: the stricter checks; mode follows the offered modes (host Mac without PUBLIC_URL)', () => {
    const mac = { browser: false, modes: ['screen', 'window'] };
    assert.deepEqual(applyConfig('config:mode', ['window'], {}, mac), { mode: 'window' });
    assert.equal(applyConfig('config:mode', ['agent'], {}, mac), null);
    assert.equal(applyConfig('config:max', [' '], {}), null);
    assert.equal(applyConfig('config:to', [undefined], {}), null);
    assert.equal(applyConfig('config:who', ['anyone'], {}), null);
    assert.deepEqual(applyConfig('config:days', ['7', '-1', '1.5', '6'], {}), { days: [6] });
  });
});

describe('nit: an agent segment dropped in its ack window', () => {
  test('claimed, ⏹️ before the ack: its recording dir is removed', async () => {
    const s = scene(bot, { name: 'Alice' });
    const g = s.guild.id;
    await cardsOn(s);
    agents.setOnline(s.member.id);
    agents.startMode = 'hold';
    share(s.member);
    pressRec(bot, s).catch(() => {});
    await waitFor(() => agents.pending.length, 'held');
    const sess = screen.get(g), cap = agents.pending[0].capture;
    cap.claim(cap.link().split('/capture/')[1], 'video/mp4'); // the agent claims before its ack
    await waitFor(() => existsSync(cap.dir), 'dir created');
    await waitFor(() => sess.joinState === 'ok', 'joined');
    await press(s, `screen:stop:${sess.began}`, { message: sess.card });
    await waitFor(() => sess.finished, 'finished');
    agents.ack('ok');
    await waitFor(() => !existsSync(cap.dir), 'dir removed');
    assert.ok(cap.result, 'the agent hears there is no link');
  });
});

describe('the /agent reply: expiry only, plus start/uninstall commands, whatever the area', () => {
  test('no area or privacy footnote (the installer says it); the start and uninstall commands are there', async () => {
    const s = scene(bot, { name: 'Alice' });
    await updateSettings(s.guild.id, { area: 'discord' });
    const i = await press(s, undefined, { kind: 'slash', command: 'agent' });
    assert.doesNotMatch(content(i.replies[0]), /หน้าต่าง Discord|ทั้งจอที่เลือก/);
    assert.match(content(i.replies[0]), /### 🍎 macOS[^]*start\.command[^]*uninstall\.command[^]*### 🪟 Windows[^]*start\.cmd[^]*uninstall\.cmd[^]*เชื่อมใหม่/);
    assertDiscordLimits(i.replies[0], '/agent');
  });
});
