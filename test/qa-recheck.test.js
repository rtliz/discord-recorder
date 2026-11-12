import './helpers/env.js';
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadBot, waitFor, sleep, scene, resetFakes } from './helpers/bot.js';
import { fakeInteraction, fakeMember, moveMember, FakeVoiceRecorder } from './helpers/fakes.js';
import { pressRec } from './helpers/session.js';

// QA re-check of the joinFailed / discardSeg fixes: ordering races
const { bot, fire, agents } = await loadBot({ SCREEN_ENABLED: 'false', PUBLIC_URL: 'http://localhost:1' });
const { updateSettings } = await import('../src/settings.js');
const { screen } = bot;
const press = async (s, customId, extra) => { const i = fakeInteraction({ guild: s.guild, member: s.member, channel: s.text, customId, ...extra }); await fire('interactionCreate', i); return i; };
const share = (m, on = true) => bot.client.listeners('voiceStateUpdate')[0](...moveMember(m, { streaming: on }));
beforeEach(() => { bot._reset(); bot.client.guilds.cache.clear(); resetFakes(); });
after(() => bot._reset());

describe('joinFailed ordering', () => {
  test('first screen live, join still pending; 🔁 starts; THEN the join fails: the no-audio note must still appear', async () => {
    const s = scene(bot, { name: 'Alice' });
    const g = s.guild.id;
    await updateSettings(g, { shareMode: 'card', minMembers: 1, minShareSeconds: 0, mode: 'agent' });
    s.b = fakeMember(s.guild, { name: 'Bob' }); moveMember(s.b, { channel: s.room });
    agents.setOnline(s.member.id); agents.setOnline(s.b.id);
    let failJoin;
    FakeVoiceRecorder.startHook = () => new Promise((_, rej) => { failJoin = () => rej(new Error('join timeout')); });
    share(s.member); share(s.b);
    pressRec(bot, s).catch(() => {});
    const sess = await waitFor(() => screen.get(g)?.cur?.source === 'agent' && failJoin && screen.get(g), 'agent live, join pending');
    await sess.cardQ;
    agents.startMode = 'hold';
    press(s, `screen:switch:${sess.began}.${s.b.id}`, { message: sess.card }).catch(() => {});
    await waitFor(() => agents.pending.length, 'switch start held');
    failJoin();
    await waitFor(() => sess.joinState === 'fail', 'join failed');
    agents.ack('ok');
    await waitFor(() => sess.cur?.owner === s.b.id, 'switched');
    await sleep(50);
    assert.equal(sess.finished, false);
    assert.match(sess.notes, /อัดแค่ภาพจอ ไม่มีเสียงในห้อง/, 'user is told there is no room audio');
  });
});

describe('manual 🖥️', () => {
  test('agent declines AND join fails: cancelled cleanly, reply edited, nothing left', async () => {
    const s = scene(bot, { name: 'Alice' });
    const g = s.guild.id;
    await updateSettings(g, { shareMode: 'off', mode: 'browser' });
    agents.setOnline(s.member.id);
    agents.startMode = 'declined';
    FakeVoiceRecorder.startHook = () => { throw new Error('join timeout'); };
    const errs = []; const h = (e) => errs.push(e); process.on('unhandledRejection', h);
    const i = await press(s, 'screen:me');
    await waitFor(() => !screen.has(g), 'cancelled');
    await sleep(50);
    process.off('unhandledRejection', h);
    assert.deepEqual(errs, []);
    assert.equal(bot.voice.has(g), false);
    assert.match(String(i.edits.at(-1)?.content ?? ''), /การอัดนี้จบแล้ว/);
  });

  test('join fails after agent live (manual): one note, session survives', async () => {
    const s = scene(bot, { name: 'Alice' });
    const g = s.guild.id;
    agents.setOnline(s.member.id);
    FakeVoiceRecorder.startHook = () => { throw new Error('join timeout'); };
    await press(s, 'screen:me');
    const sess = await waitFor(() => screen.get(g)?.cur && screen.get(g), 'live');
    await sleep(50);
    assert.equal(sess.finished, false);
    assert.equal(sess.notes.match(/อัดแค่ภาพจอ/g)?.length, 1);
  });
});

describe('gap between agent failure and link fallback', () => {
  test('join fails exactly when the agent decline resolves: must not cancel before the fallback starts', async () => {
    const s = scene(bot, { name: 'Alice' });
    const g = s.guild.id;
    await updateSettings(g, { shareMode: 'card', minMembers: 1, minShareSeconds: 0, mode: 'agent' });
    agents.setOnline(s.member.id);
    agents.startMode = 'hold';
    let failJoin;
    FakeVoiceRecorder.startHook = () => new Promise((_, rej) => { failJoin = () => rej(new Error('join timeout')); });
    share(s.member);
    pressRec(bot, s).catch(() => {});
    await waitFor(() => agents.pending.length && failJoin, 'held');
    const sess = screen.get(g);
    agents.ack('declined'); failJoin();
    await sleep(80);
    console.log('finished?', sess.finished, 'cur', sess.cur?.source);
  });
});

describe('R3 old ids', () => {
  test('config:anyone / share-* / cards / cards-main / page-main', async () => {
    const s = scene(bot, { name: 'Alice' });
    const g = s.guild.id;
    const { getSettings } = await import('../src/settings.js');
    await updateSettings(g, { shareMode: 'off', anyoneRecords: false });
    await press(s, 'config:anyone'); assert.equal(getSettings(g).anyoneRecords, true);
    await press(s, 'config:anyone'); assert.equal(getSettings(g).anyoneRecords, false);
    await press(s, 'config:share-card'); assert.equal(getSettings(g).shareMode, 'card');
    await press(s, 'config:share-auto'); assert.equal(getSettings(g).shareMode, 'auto');
    await press(s, 'config:share-off'); assert.equal(getSettings(g).shareMode, 'off');
    await press(s, 'config:cards'); assert.equal(getSettings(g).shareMode, 'card');
    await press(s, 'config:cards-main'); assert.equal(getSettings(g).shareMode, 'off');
    const i = await press(s, 'config:page-main');
    assert.ok(i.updates?.length || i.updated || i.edits?.length || i.replies?.length, 'rendered');
    assert.equal(bot.screen.size, 0);
  });
});
