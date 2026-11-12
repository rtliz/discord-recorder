import './helpers/env.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadBot, waitFor, scene, resetFakes } from './helpers/bot.js';
import { fakeInteraction, fakeMember, moveMember, parts, ids, FakeScreenRecorder } from './helpers/fakes.js';
import { assertDiscordLimits } from './helpers/limits.js';
import { startSession } from './helpers/session.js';

// index.js flows with the host-Mac screen (ffmpeg) modes and no browser capture

const { bot, uploads, fire } = await loadBot({ SCREEN_ENABLED: 'true', PUBLIC_URL: '' });
const { updateSettings, getSettings } = await import('../src/settings.js');
const { voice, screen } = bot;
const content = (p) => p?.content ?? '';
const lastEdit = (m) => m.edits.at(-1) ?? m.payload;

beforeEach(() => { bot._reset(); bot.client.guilds.cache.clear(); resetFakes(); uploads.length = 0; }); // checkAuto sweeps every cached guild
after(() => bot._reset());

test('panel offers 🖥️ อัดจอ (not 🎥) and fits limits', () => {
  const s = scene(bot);
  const p = bot.panel(s.guild);
  assert.ok(ids(p).includes('screen:start'));
  assert.ok(!ids(p).includes('screen:me'));
  assertDiscordLimits(p, 'mac idle');
});

test('manual 🖥️: card from the deferred reply, the bot joins the presser\'s room, stop → video + audio', async () => {
  const s = scene(bot);
  const i = fakeInteraction({ guild: s.guild, member: s.member, channel: s.text, customId: 'screen:start' });
  await fire('interactionCreate', i);
  const g = s.guild.id;
  const rec = screen.get(g);
  assert.equal(rec.kind, 'mac');
  await waitFor(() => rec.paired && voice.get(g) === rec.paired, 'paired voice');
  await rec.cardQ;
  assert.equal(rec.card, i.replyMessage);
  assert.equal(s.text.sent.length, 0);
  const stop = fakeInteraction({ guild: s.guild, member: s.member, channel: s.text, customId: `screen:stop:${rec.began}`, message: rec.card });
  await fire('interactionCreate', stop);
  const result = lastEdit(rec.card);
  assert.match(content(result), /^✅/);
  assert.equal(parts(result).filter((c) => c.url).length, 2); // video (audio inside), folder
  assert.equal(voice.size + screen.size, 0);
});

test('auto: a share in a full room starts the screen + room audio; share ends → result (press-to-start)', async () => {
  const s = scene(bot);
  const g = s.guild.id;
  await updateSettings(g, { shareCards: true, minMembers: 2, minShareSeconds: 0, mode: 'screen' });
  moveMember(fakeMember(s.guild, { name: 'B' }), { channel: s.room });
  fire('voiceStateUpdate', ...moveMember(s.member, { streaming: true }));
  await waitFor(() => bot.roomCards.get(s.room.id)?.card, 'room card');
  assert.equal(FakeScreenRecorder.instances.length + voice.size, 0, 'a share alone starts nothing');
  const sess = await startSession(bot, s); // 🔴: the host Mac records (no agent), the bot joins
  assert.equal(sess.cur.rec.kind, 'mac');
  assert.equal(sess.cur.owner, s.member.id);
  assert.match(content(lastEdit(sess.card)), new RegExp(`^🔴 \\*\\*กำลังอัดจอเครื่องบอท\\*\\* — <@${s.member.id}> แชร์จอ ในห้อง \\*\\*Meeting\\*\\*`));
  fire('voiceStateUpdate', ...moveMember(s.member, { streaming: false }));
  await waitFor(() => !screen.has(g) && /^✅/.test(content(lastEdit(sess.card))), 'result');
  assert.equal(voice.size, 0);
  assert.ok(FakeScreenRecorder.instances[0].stopped);
});

test('ffmpeg dying on its own ends the recording with a warning', async () => {
  const s = scene(bot);
  await fire('interactionCreate', fakeInteraction({ guild: s.guild, member: s.member, channel: s.text, customId: 'screen:start' }));
  const g = s.guild.id;
  const rec = screen.get(g);
  await waitFor(() => rec.paired, 'paired');
  FakeScreenRecorder.instances[0].die();
  await waitFor(() => !screen.has(g) && /ffmpeg หยุดเอง/.test(content(lastEdit(rec.card))), 'warned result');
});

test('a second screen start while one runs is refused', async () => {
  const s = scene(bot);
  await fire('interactionCreate', fakeInteraction({ guild: s.guild, member: s.member, channel: s.text, customId: 'screen:start' }));
  await waitFor(() => screen.get(s.guild.id)?.paired, 'paired');
  const again = fakeInteraction({ guild: s.guild, member: s.member, channel: s.text, customId: 'screen:start' });
  await fire('interactionCreate', again);
  assert.match(content(again.replies[0]), /กำลังอัดจออยู่แล้ว/);
  assert.equal(FakeScreenRecorder.instances.length, 1);
});

// --- step 5 ---

const press = (s, customId, extra = {}) => {
  const i = fakeInteraction({ guild: s.guild, member: s.member, channel: s.text, customId, ...extra });
  return fire('interactionCreate', i).then(() => i);
};

test('U15 (new quick page): host Mac only: the share select (auto records the host Mac), no อัดจอด้วย / กรอบอัด selects', async () => {
  const s = scene(bot);
  const i = await press(s, 'config:open');
  assertDiscordLimits(i.replies[0], 'mac quick page');
  const ids = parts(i.replies[0]).map((c) => c.custom_id);
  assert.ok(ids.includes('config:share'));
  assert.ok(!ids.includes('config:mode') && !ids.includes('config:area'), 'agent / browser / area need PUBLIC_URL');
  const p = await press(s, 'config:cards'); // an old message's toggle still works
  assertDiscordLimits(p.updates[0], 'mac quick page after the toggle');
  await press(s, 'config:share-auto');
  assert.equal(getSettings(s.guild.id).shareMode, 'auto', 'auto works on the host Mac too (old flow)');
});

test('U24/U3: the Mac live card, with and without the room audio', async () => {
  const s = scene(bot);
  const i = await press(s, 'screen:start');
  const rec = screen.get(s.guild.id);
  await waitFor(() => rec.paired, 'paired');
  await rec.cardQ;
  const live = lastEdit(rec.card);
  assert.match(content(live), /^🔴 \*\*กำลังอัดจอเครื่องบอท\*\* · เริ่ม <t:\d+:R>\n-# บอทอัดเสียงทุกคนในห้องด้วย$/);
  assert.equal(parts(live)[0].label, '⏹️ หยุดอัด');
  assertDiscordLimits(bot.panel(s.guild), 'mac live paired');
  assert.deepEqual(ids(bot.panel(s.guild)).slice(0, 1), ['screen:stop']);
  assert.equal(parts(bot.panel(s.guild))[0].label, '⏹️ หยุดอัด');
  assert.ok(i.deferred);
});

test('U13/U8: a failed pair for a manual Mac recording: named error, 🎙️ offered meanwhile', async () => {
  const { FakeVoiceRecorder } = await import('./helpers/fakes.js');
  const s = scene(bot);
  FakeVoiceRecorder.startHook = () => { throw new Error('join timeout'); };
  await press(s, 'screen:start');
  const rec = screen.get(s.guild.id);
  await waitFor(() => s.room.sent.some((m) => /ไม่ได้/.test(content(m.payload))) || s.text.sent.some((m) => /ไม่ได้/.test(content(m.payload))), 'error');
  const err = [...s.room.sent, ...s.text.sent].map((m) => content(m.payload)).find((t) => /ไม่ได้/.test(t));
  assert.equal(err, '❌ บอทเข้าห้องเสียง **Meeting** ไม่ได้: join timeout');
  assert.deepEqual(ids(bot.panel(s.guild)).slice(0, 2), ['record:start', 'screen:stop']);
  await press(s, `screen:stop:${rec.began}`, { message: rec.card });
});

test('U16: with anyoneRecords a guest may start 🖥️ but not open settings', async () => {
  const s = scene(bot, { admin: false });
  await updateSettings(s.guild.id, { anyoneRecords: true });
  assert.match(content((await press(s, 'config:open')).replies[0]), /ตั้งค่าได้เฉพาะผู้ดูแล/);
  await press(s, 'screen:start');
  assert.ok(screen.has(s.guild.id));
});
