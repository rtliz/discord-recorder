import './helpers/env.js';
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { loadBot, waitFor, sleep, scene, resetFakes } from './helpers/bot.js';
import { fakeMember, moveMember, parts, ids, FakeVoiceRecorder } from './helpers/fakes.js';
import { roomCardOf, waitCard, pressOn, pressRec, startSession } from './helpers/session.js';
import { assertDiscordLimits } from './helpers/limits.js';

// press-to-start share sessions (plan B1, §9 cases 1-3, 7-17, 20) in browser-capture mode with FakeAgentHub:
// a share only posts a room card; a 🔴 press records the sharer's own machine (agent) or offers the card link,
// the bot joins for the room audio, and the end composes one meeting file

const { bot, logs, uploads, fire, agents, composed, share } = await loadBot({ SCREEN_ENABLED: 'false', PUBLIC_URL: 'http://localhost:1' });
const { T } = await import('../src/browser-capture.js');
const { updateSettings, getSettings } = await import('../src/settings.js');
Object.assign(T, { drainMax: 50, silent: 50, poll: 5 }); // a page that never talks: finish fast
const WAIT = bot.T.wait;

const { voice, screen } = bot;
const content = (p) => p?.content ?? '';
const lastOf = (m) => m.edits.at(-1) ?? m.payload;
const isEphemeral = (p) => Boolean(p?.flags & MessageFlags.Ephemeral);
const tokenOf = (rec) => rec.link().split('/capture/')[1];
const goLive = (rec) => { // the card link opened on a computer: claim, and a finalize without ffmpeg
  rec.finalize = async () => `${rec.dir}/screen.webm`;
  return rec.claim(tokenOf(rec), 'video/webm');
};
const press = (s, customId, extra) => pressOn(bot, s, customId, extra);
const labels = (p) => parts(p).map((c) => c.label);
const settle = (ms = 40) => sleep(ms);
// a server in browser mode with cards on, the presser (admin) A and a second person B in the room
const cardScene = async (patch = {}, opts = {}) => {
  const s = scene(bot, { name: 'Alice', ...opts });
  await updateSettings(s.guild.id, { shareCards: true, minMembers: 2, minShareSeconds: 0, mode: 'agent', ...patch });
  s.b = fakeMember(s.guild, { name: 'Bob' });
  moveMember(s.b, { channel: s.room });
  return s;
};
// the result card: the session's card once it shows ✅/❌
const resultOf = async (s, sess, what = 'result') => {
  await waitFor(() => !screen.has(s.guild.id) && !voice.has(s.guild.id) && /^[✅❌⚪]/.test(content(lastOf(sess.card))), what);
  await settle();
  return lastOf(sess.card);
};

beforeEach(() => {
  bot._reset(); bot.client.guilds.cache.clear(); resetFakes();
  uploads.length = 0; logs.err.length = 0; composed.calls.length = 0; bot.deps.composeFails = null; bot.T.wait = WAIT;
});
after(() => bot._reset());

describe('case 1: a share alone records nothing', () => {
  test('room card pinging the sharer, no voice join, no recorder; unshare deletes the card', async () => {
    const s = await cardScene();
    share(s.member);
    const card = await waitCard(bot, s);
    await bot.roomCards.get(s.room.id).cardQ;
    assert.equal(s.room.sent.length, 1, 'posted in the voice channel chat');
    assert.equal(content(card.payload), `🖥️ <@${s.member.id}> กำลังแชร์จอใน **Meeting** · กด 🔴 เพื่ออัด\n-# ยังไม่ได้อัดอะไร`);
    assert.deepEqual(card.payload.allowedMentions, { parse: [], users: [s.member.id] });
    assert.deepEqual(ids(card.payload), [`screen:rec:${s.member.id}`, "agent:install"]);
    assert.deepEqual(labels(card.payload), ['🔴 เริ่มอัด', '📥 ติดตั้งตัวอัด']);
    assert.equal(parts(card.payload)[0].style, 3, 'green, not a red stop: nothing started');
    assertDiscordLimits(card.payload, 'room card');
    assert.equal(screen.size + voice.size + FakeVoiceRecorder.instances.length + agents.calls.length, 0, 'nothing records');
    assert.deepEqual(getSettings(s.guild.id).roomCards, [[card.channelId, card.id]]);
    share(s.member, false);
    await waitFor(() => card.deleted, 'card deleted');
    await waitFor(() => getSettings(s.guild.id).roomCards.length === 0, 'forgotten');
    assert.ok(!bot.roomCards.has(s.room.id));
  });

  test('two sharers: one card, one 🔴 per sharer named; one stops → only the other', async () => {
    const s = await cardScene();
    share(s.member);
    share(s.b);
    await waitFor(() => bot.roomCards.get(s.room.id)?.sharers.length === 2, 'both');
    const rc = bot.roomCards.get(s.room.id);
    await rc.cardQ;
    const p = lastOf(rc.card);
    assert.deepEqual(ids(p), [`screen:rec:${s.member.id}`, `screen:rec:${s.b.id}`, 'agent:install']);
    assert.deepEqual(labels(p), ['🔴 อัด Alice', '🔴 อัด Bob', '📥 ติดตั้งตัวอัด']);
    assert.equal(s.room.sent.length, 1, 'one card per room');
    share(s.member, false);
    await waitFor(() => bot.roomCards.get(s.room.id)?.sharers.join() === s.b.id, 'B only');
    await rc.cardQ;
    assert.deepEqual(labels(lastOf(rc.card)), ['🔴 เริ่มอัด', '📥 ติดตั้งตัวอัด']);
  });

  test('filters: cards off, too few people, an unwatched room, a short share → no card', async () => {
    const s = await cardScene({ shareCards: false });
    share(s.member);
    await settle();
    assert.equal(s.room.sent.length, 0, 'cards off');
    await updateSettings(s.guild.id, { shareCards: true, minMembers: 3 });
    share(s.member, false); share(s.member);
    await settle();
    assert.equal(s.room.sent.length, 0, 'minMembers');
    await updateSettings(s.guild.id, { minMembers: 2, channels: ['elsewhere'] });
    share(s.member, false); share(s.member);
    await settle();
    assert.equal(s.room.sent.length, 0, 'not watched');
    await updateSettings(s.guild.id, { channels: [], minShareSeconds: 0.05 });
    share(s.member, false); share(s.member);
    await settle(10);
    assert.equal(s.room.sent.length, 0, 'not yet: shared too briefly');
    await waitCard(bot, s); // the recheck after minShareSeconds
  });

  test('toggling cards off deletes the card; on again reposts it', async () => {
    const s = await cardScene();
    share(s.member);
    const card = await waitCard(bot, s);
    await press(s, 'config:cards');
    assert.equal(getSettings(s.guild.id).shareCards, false);
    await waitFor(() => card.deleted, 'deleted');
    await press(s, 'config:cards');
    await waitFor(() => roomCardOf(bot, s.room) && roomCardOf(bot, s.room) !== card, 'reposted');
  });
});

describe('case 2: 🔴 with the sharer\'s agent online', () => {
  test('agent start → bot joins → live card on the same message; ⏹️ → one meeting file', async () => {
    const s = await cardScene();
    agents.setOnline(s.b.id);
    const sess = await startSession(bot, s, { sharer: s.b });
    const g = s.guild.id;
    assert.equal(agents.calls.length, 1);
    const call = agents.calls[0];
    assert.equal(call.userId, s.b.id, 'only the sharer\'s machine');
    assert.equal(call.by, 'Alice', 'who pressed, for display');
    assert.equal(call.room, 'Meeting');
    assert.ok(call.maxMs > 239 * 60000, 'the agent knows the max length');
    assert.equal(sess.cur.rec.via, 'agent');
    assert.equal(sess.cur.rec.state, 'live');
    assert.equal(voice.get(g).channel, s.room);
    assert.equal(s.room.sent.length, 1, 'the room card became the session card');
    assert.equal(sess.card, s.room.sent[0]);
    const live = lastOf(sess.card);
    assert.match(content(live), new RegExp(`^🔴 \\*\\*กำลังอัดจอของ <@${s.b.id}>\\*\\* ในห้อง \\*\\*Meeting\\*\\* · เริ่ม <t:\\d+:R>\\n-# บอทอัดเสียงทุกคนในห้องด้วย$`));
    assert.deepEqual(ids(live), [`screen:stop:${sess.began}`]);
    assertDiscordLimits(live, 'live session');
    assert.deepEqual(getSettings(g).cards, [[sess.card.channelId, sess.card.id]], 'remembered as a recording card');
    assert.deepEqual(getSettings(g).roomCards, [], 'not as a room card');
    await press(s, `screen:stop:${sess.began}`, { message: sess.card });
    const out = await resultOf(s, sess);
    assert.match(content(out), new RegExp(`^✅ \\*\\*อัดจอเสร็จแล้ว\\*\\* · ยาว \\d+:\\d\\d · จอของ <@${s.b.id}>`));
    assert.deepEqual(labels(out), ['▶️ ดูวิดีโอ', '📁 ไฟล์ทั้งหมด']);
    assert.equal(composed.calls.length, 1);
    const c = composed.calls[0];
    assert.equal(c.segments.length, 1);
    assert.equal(c.segments[0].start, sess.segments[0].rec.liveAt);
    assert.equal(c.audioStart, FakeVoiceRecorder.instances[0].startedAt);
    assert.ok(c.end >= c.segments[0].start);
    assert.equal(c.dir, sess.dir);
    assert.deepEqual(uploads.map((u) => u.replace(/^.*-/, '')), ['meeting.mp4']);
    assert.equal(sess.segments[0].rec.result.url, 'https://drive.google.com/file/d/1/view');
    assert.ok(agents.stops.some((x) => x.userId === s.b.id), 'the agent was told to stop');
    assert.ok(FakeVoiceRecorder.instances[0].stopped, 'bot left');
  });

  test('(old flow) 🔴 records at once: the card says recording and the bot joins while the agent starts; an old agent with askFirst is never waited for', async () => {
    const s = await cardScene();
    agents.setOnline(s.b.id, { askFirst: true }); // an old agent still reports askFirst: ignored
    agents.startMode = 'hold';
    share(s.b);
    const pressing = pressRec(bot, s, s.b.id); // held until the ack: not awaited
    const g = s.guild.id;
    const sess = await waitFor(() => screen.get(g), 'reserved');
    await waitFor(() => agents.pending.length === 1, 'commanded');
    await waitFor(() => sess.paired && voice.get(g) === sess.paired, 'joined before the ack');
    await sess.cardQ;
    const card = content(lastOf(sess.card));
    assert.match(card, /^🔴 \*\*กำลังอัดในห้อง Meeting\*\* · เริ่ม <t:\d+:R>\n-# บอทอัดเสียงทุกคนในห้องด้วย\n/);
    assert.ok(card.includes(`⏳ **กำลังสั่งเครื่องของ <@${s.b.id}> ให้เริ่มอัดจอ...**`));
    assert.doesNotMatch(card, /ถามก่อน/);
    assert.equal(parts(lastOf(sess.card))[0].style, 4, 'a red stop: the room records');
    agents.ack('ok');
    await pressing;
    await waitFor(() => sess.cur?.source === 'agent', 'live');
    assert.equal(FakeVoiceRecorder.instances.length, 1, 'one voice');
  });

  test('(old flow) the agent fails (old agent declines): the room audio goes on, the sharer gets the card link, a note', async () => {
    const s = await cardScene();
    agents.setOnline(s.b.id, { askFirst: true });
    agents.startMode = 'hold';
    share(s.b);
    const pressing = pressRec(bot, s, s.b.id);
    const g = s.guild.id;
    await waitFor(() => agents.pending.length === 1, 'commanded');
    agents.ack('declined');
    await pressing;
    const sess = screen.get(g);
    assert.equal(sess?.kind, 'session', 'not cancelled');
    await waitFor(() => sess.cur?.source === 'link' && sess.paired, 'link fallback with audio');
    assert.equal(sess.cur.owner, s.b.id);
    await sess.cardQ;
    const card = lastOf(sess.card);
    assert.match(content(card), new RegExp(`^🔴 \\*\\*กำลังอัดเสียงในห้อง Meeting\\*\\* · <@${s.b.id}> กด 🎥 เพื่ออัดจอด้วย`));
    assert.match(content(card), new RegExp(`-# ⚠️ <@${s.b.id}> ไม่อนุญาตให้อัดจอ`));
    assert.ok(parts(card).some((c) => c.url?.startsWith('http://localhost:1/capture/')), 'the link on the card');
    assert.ok(!bot.cardSkip.get(g)?.has(s.b.id), 'recorded through the link: not skipped');
    assert.equal(FakeVoiceRecorder.instances.length, 1);
  });

  test('the agent went offline before the ack: falls back to the card link', async () => {
    const s = await cardScene();
    agents.setOnline(s.b.id);
    agents.startMode = 'hold';
    share(s.b);
    const pressing = pressRec(bot, s, s.b.id);
    await waitFor(() => agents.pending.length === 1, 'asked');
    agents.ack('offline');
    await pressing;
    const sess = await waitFor(() => screen.get(s.guild.id)?.cur && screen.get(s.guild.id), 'fallback');
    assert.equal(sess.cur.source, 'link');
    await waitFor(() => sess.paired, 'joined');
    await sess.cardQ;
    assert.ok(parts(lastOf(sess.card)).some((c) => c.url?.startsWith('http://localhost:1/capture/')), 'the link on the card');
  });
});

describe('capture area (กรอบอัดหน้าจอ)', () => {
  test('the start command carries area; the agent\'s note (no Discord window) shows on the card', async () => {
    const s = await cardScene({ area: 'discord' });
    agents.setOnline(s.b.id);
    agents.note = 'หาหน้าต่าง Discord ไม่เจอ อัดทั้งจอแทน';
    const sess = await startSession(bot, s, { sharer: s.b });
    assert.equal(agents.calls[0].area, 'discord');
    await waitFor(() => content(lastOf(sess.card)).includes('-# ⚠️ หาหน้าต่าง Discord ไม่เจอ อัดทั้งจอแทน'), 'note on the card');
    await press(s, `screen:stop:${sess.began}`, { message: sess.card });
    const out = await resultOf(s, sess);
    assert.match(content(out), /หาหน้าต่าง Discord ไม่เจอ อัดทั้งจอแทน/, 'kept on the result');
  });

  test('area screen (default) is sent as screen; the card link asks the page for the Discord window only when set', async () => {
    const s = await cardScene();
    agents.setOnline(s.b.id);
    const sess = await startSession(bot, s, { sharer: s.b });
    assert.equal(agents.calls[0].area, 'screen');
    await press(s, `screen:stop:${sess.began}`, { message: sess.card });
    await resultOf(s, sess);
    // mode browser hides the area select: a saved 'discord' gives a plain link there
    for (const [area, re, mode = 'agent'] of [['screen', /\/capture\/[^?]+$/], ['discord', /\/capture\/[^?]+\?area=discord$/], ['discord', /\/capture\/[^?]+$/, 'browser']]) {
      const s2 = await cardScene({ area, mode });
      const sess2 = await startSession(bot, s2);
      assert.equal(sess2.cur.source, 'link');
      assert.match(parts(lastOf(sess2.card)).find((c) => c.url).url, re, `${area} ${mode}`);
      share(s2.member, false);
      await resultOf(s2, sess2);
    }
  });
});

describe('case 3: 🔴 without an agent (browser mode)', () => {
  test('the link goes on the card, the bot records the room; the sharer opens it → live; share ends → one meeting', async () => {
    const s = await cardScene();
    const sess = await startSession(bot, s);
    assert.equal(agents.calls.length, 0, 'no agent online: no command to anyone');
    const rec = sess.cur.rec;
    assert.equal(sess.cur.source, 'link');
    assert.equal(rec.via, 'page');
    const card = lastOf(sess.card);
    const lines = content(card).split('\n');
    assert.equal(lines[0], `🔴 **กำลังอัดเสียงในห้อง Meeting** · <@${s.member.id}> กด 🎥 เพื่ออัดจอด้วย`);
    assert.match(lines[1], /^-# 🎥 กด \*\*อัดจอของฉันด้วย\*\* → เลือกจอ → กด \*\*แชร์\*\*/);
    assert.ok(ids(card).includes('agent:install'), 'mode agent without their agent: 📥 for next time');
    const link = parts(card).find((c) => c.url);
    assert.match(link.url, /^http:\/\/localhost:1\/capture\//);
    assert.equal(parts(card).find((c) => c.custom_id?.startsWith('screen:stop'))?.style, 4, 'red: the room audio records');
    assertDiscordLimits(card, 'link card');
    goLive(rec);
    await waitFor(() => /^🔴 \*\*กำลังอัดจอของ/.test(content(lastOf(sess.card))), 'live');
    share(s.member, false);
    const out = await resultOf(s, sess);
    assert.match(content(out), /^✅ \*\*อัดจอเสร็จแล้ว/);
    assert.match(content(out), /-# <@\d+> เลิกแชร์จอแล้ว$/);
    assert.equal(composed.calls.length, 1);
    assert.equal(composed.calls[0].segments[0].start, rec.liveAt);
    assert.equal(rec.result.url, 'https://drive.google.com/file/d/1/view', 'the page opens the meeting');
    assert.equal(voice.size + screen.size, 0);
    assert.ok(!bot.roomCards.has(s.room.id));
  });

  test('phone: the link answers paired, the card drops it; share end → audio-only result', async () => {
    const s = await cardScene();
    const sess = await startSession(bot, s);
    const rec = sess.cur.rec;
    assert.deepEqual(await rec.voiceOnly(tokenOf(rec)), { ok: true, paired: true });
    await sess.cardQ;
    const card = lastOf(sess.card);
    assert.ok(!parts(card).some((c) => c.url), 'no dead link');
    assert.match(content(card), /เปิดลิงก์จากมือถือ เลยอัดได้แค่เสียง/);
    assert.equal(FakeVoiceRecorder.instances.length, 1, 'no second voice');
    share(s.member, false);
    const out = await resultOf(s, sess);
    assert.match(content(out), /^✅ \*\*อัดเสียงในห้องเสร็จแล้ว\*\* · ยาว .* · ไม่ได้อัดภาพจอ/);
    assert.deepEqual(labels(out), ['🎧 ฟังเสียง', '📁 ไฟล์ทั้งหมด']);
    assert.equal(composed.calls.length, 0, 'nothing to compose');
  });
});

describe('cases 7-12: several sharers, switching and the 2-minute wait', () => {
  const two = async () => { // A records (agent), B shares on top
    const s = await cardScene();
    agents.setOnline(s.member.id);
    agents.setOnline(s.b.id);
    const sess = await startSession(bot, s);
    share(s.b);
    await waitFor(() => ids(lastOf(sess.card)).includes(`screen:switch:${sess.began}.${s.b.id}`), '🔁 B');
    return [s, sess];
  };

  test('case 7: B shares on top: A goes on, the card offers 🔁 B, no room card', async () => {
    const [s, sess] = await two();
    assert.equal(sess.cur.owner, s.member.id);
    assert.equal(agents.calls.length, 1, 'B is not recorded by itself (rule 4)');
    const card = lastOf(sess.card);
    assert.deepEqual(labels(card), ['⏹️ หยุดอัด', '🔁 สลับไปอัด Bob']);
    assertDiscordLimits(card, '🔁 card');
    assert.ok(!bot.roomCards.has(s.room.id), 'the session room has its own card');
    assert.equal(s.room.sent.length, 1);
  });

  test('case 8: 🔁 B → B starts, then A stops; one session, one voice, two segments composed', async () => {
    const [s, sess] = await two();
    const a = sess.cur;
    await press(s, `screen:switch:${sess.began}.${s.b.id}`, { message: sess.card });
    await waitFor(() => sess.cur?.owner === s.b.id, 'B is current');
    assert.equal(agents.calls.at(-1).userId, s.b.id);
    assert.ok(a.done && a.rec.stopping, 'A stopped after B was accepted');
    assert.ok(agents.stops.some((x) => x.userId === s.member.id && x.capId === a.rec.capId));
    assert.equal(screen.get(s.guild.id), sess);
    assert.equal(FakeVoiceRecorder.instances.length, 1, 'voice unbroken');
    await sess.cardQ;
    assert.match(content(lastOf(sess.card)), new RegExp(`กำลังอัดจอของ <@${s.b.id}>`));
    assert.deepEqual(labels(lastOf(sess.card)), ['⏹️ หยุดอัด', '🔁 สลับไปอัด Alice']);
    await waitFor(() => s.guild.members.me.nickname === 'Bob - 🔴 กำลังอัดหน้าจอ', 'nickname follows the screen (D13)');
    await press(s, `screen:stop:${sess.began}`, { message: sess.card });
    const out = await resultOf(s, sess);
    assert.match(content(out), new RegExp(`จอของ <@${s.member.id}> → <@${s.b.id}>`));
    const c = composed.calls[0];
    assert.deepEqual(c.segments.map((x) => x.start), sess.segments.map((x) => x.rec.liveAt));
    assert.ok(c.segments[0].start <= c.segments[1].start);
    assert.equal(uploads.length, 1);
  });

  test('case 9: A stops sharing, B still shares → waiting card with 🔴 อัดจอ B ต่อ / ⏹️ จบ, voice goes on', async () => {
    const [s, sess] = await two();
    share(s.member, false);
    await waitFor(() => sess.state === 'waiting', 'waiting');
    await sess.cardQ;
    const card = lastOf(sess.card);
    assert.match(content(card), new RegExp(`^⏸️ <@${s.member.id}> หยุดแชร์แล้ว · เสียงยังอัดอยู่\\n-# กด 🔴 เพื่ออัดจอคนที่ยังแชร์อยู่ต่อ ไม่มีใครกดจะจบเอง <t:\\d+:R>`));
    assert.deepEqual(ids(card), [`screen:stop:${sess.began}`, `screen:cont:${sess.began}.${s.b.id}`]);
    assert.deepEqual(labels(card), ['⏹️ จบ', '🔴 อัดจอ Bob ต่อ']);
    assertDiscordLimits(card, 'waiting card');
    assert.ok(voice.has(s.guild.id) && !FakeVoiceRecorder.instances[0].stopped);
    assert.ok(sess.waitTimer);
    await waitFor(() => s.guild.members.me.nickname === 'Alice - 🔴 กำลังอัดเสียง', 'nickname: the presser, voice (D13)');
  });

  test('case 10: 🔴 ต่อ within the wait → B segment, timer cleared; compose gets both start offsets (gap = black)', async () => {
    const [s, sess] = await two();
    share(s.member, false);
    await waitFor(() => sess.state === 'waiting', 'waiting');
    const timer = sess.waitTimer;
    await sleep(30);
    await press(s, `screen:cont:${sess.began}.${s.b.id}`, { message: sess.card });
    await waitFor(() => sess.state === 'live' && sess.cur?.owner === s.b.id, 'B live');
    assert.equal(timer._destroyed, true, 'the wait timer was cleared');
    await press(s, `screen:stop:${sess.began}`, { message: sess.card });
    await resultOf(s, sess);
    const [a, b] = composed.calls[0].segments;
    assert.ok(b.start - a.start >= 30, 'B starts later: compose fills the gap with black');
    assert.equal(composed.calls[0].audioStart, FakeVoiceRecorder.instances[0].startedAt);
  });

  test('case 11: nobody presses → ends at the wait', async () => {
    bot.T.wait = 60;
    const [s, sess] = await two();
    share(s.member, false);
    const out = await resultOf(s, sess, 'ended by the wait');
    assert.match(content(out), /-# ⌛ ไม่มีใครกดอัดจอต่อภายใน 2 นาที$/);
    assert.ok(bot.cardSkip.get(s.guild.id).has(s.b.id), 'B is not offered a card right away');
    await settle();
    assert.ok(!bot.roomCards.has(s.room.id));
  });

  test('case 12: A stops and nobody else shares → ends now', async () => {
    const s = await cardScene();
    agents.setOnline(s.member.id);
    const sess = await startSession(bot, s);
    share(s.member, false);
    const out = await resultOf(s, sess);
    assert.match(content(out), new RegExp(`-# <@${s.member.id}> เลิกแชร์จอแล้ว$`));
    assert.equal(sess.waitTimer, undefined, 'no wait');
  });

  test('a new sharer during the wait is added to the 🔴 ต่อ buttons; all of them stop → ends now', async () => {
    const [s, sess] = await two();
    const c = fakeMember(s.guild, { name: 'Carol' });
    moveMember(c, { channel: s.room });
    share(s.member, false);
    await waitFor(() => sess.state === 'waiting', 'waiting');
    share(c);
    await waitFor(() => labels(lastOf(sess.card)).includes('🔴 อัดจอ Carol ต่อ'), 'C added');
    share(s.b, false);
    share(c, false);
    const out = await resultOf(s, sess);
    assert.match(content(out), /ไม่มีใครแชร์จอแล้ว$/);
  });

  test('a switch while B\'s ack is pending and A stops meanwhile: B still becomes current, no duplicate segment', async () => {
    const [s, sess] = await two();
    agents.startMode = 'hold';
    const pressing = press(s, `screen:switch:${sess.began}.${s.b.id}`, { message: sess.card });
    await waitFor(() => agents.pending.length === 1, 'B asked');
    await sess.cardQ;
    assert.match(content(lastOf(sess.card)), new RegExp(`-# ⏳ กำลังสลับไปอัดจอของ <@${s.b.id}>`));
    share(s.member, false); // A stops during the ack
    await waitFor(() => sess.state === 'waiting', 'A ended → waiting');
    agents.ack('ok');
    await pressing;
    assert.equal(sess.state, 'live');
    assert.equal(sess.cur.owner, s.b.id);
    assert.equal(sess.segments.length, 2);
    assert.deepEqual(sess.segments.map((x) => x.owner), [s.member.id, s.b.id]);
    await sleep(WAIT > 1000 ? 30 : 0);
    assert.equal(screen.get(s.guild.id), sess, 'the wait timer did not end it');
  });

  test('a failed 🔁 (B\'s agent declines): falls back to B\'s link like no agent, A stops, a note', async () => {
    const [s, sess] = await two();
    agents.plan.push('declined');
    await press(s, `screen:switch:${sess.began}.${s.b.id}`, { message: sess.card });
    await waitFor(() => sess.cur?.owner === s.b.id, 'B');
    assert.equal(sess.cur.source, 'link');
    assert.equal(sess.segments.length, 2);
    assert.ok(sess.segments[0].done, 'A stopped once B took over');
    await sess.cardQ;
    const card = lastOf(sess.card);
    assert.match(content(card), new RegExp(`-# ⚠️ <@${s.b.id}> ไม่อนุญาตให้อัดจอ`));
    assert.ok(parts(card).some((c) => c.url), 'B\'s link');
  });

  test('a 🔁 in browser mode never commands an agent: B\'s link', async () => {
    const [s, sess] = await two();
    await updateSettings(s.guild.id, { mode: 'browser' });
    const n = agents.calls.length;
    await press(s, `screen:switch:${sess.began}.${s.b.id}`, { message: sess.card });
    await waitFor(() => sess.cur?.owner === s.b.id, 'B');
    assert.equal(sess.cur.source, 'link');
    assert.equal(agents.calls.length, n, 'no agent command in browser mode');
  });

  test('stale tags: an old 🔁 / 🔴 ต่อ after the session ended says so and drops its buttons', async () => {
    const [s, sess] = await two();
    await press(s, `screen:stop:${sess.began}`, { message: sess.card });
    await resultOf(s, sess);
    const old = { id: 'old', edits: [], async edit(p) { this.edits.push(p); } };
    for (const id of [`screen:switch:${sess.began}.${s.b.id}`, `screen:cont:${sess.began}.${s.b.id}`]) {
      const i = await press(s, id, { message: old });
      assert.equal(content(i.replies[0]), 'การอัดนี้จบไปแล้ว');
      assert.ok(isEphemeral(i.replies[0]));
    }
    assert.deepEqual(old.edits.at(-1).components, []);
    assert.equal(agents.calls.length, 1, 'nothing started');
  });
});

describe('cases 13-17, 20: endings', () => {
  test('case 13: A\'s agent drops → ⚠️ note, voice goes on, the wait offers B (D6)', async () => {
    const s = await cardScene();
    agents.setOnline(s.member.id);
    const sess = await startSession(bot, s);
    share(s.b);
    await waitFor(() => labels(lastOf(sess.card)).includes('🔁 สลับไปอัด Bob'), '🔁');
    agents.drop(s.member.id);
    await waitFor(() => sess.state === 'waiting', 'waiting');
    await sess.cardQ;
    const card = lastOf(sess.card);
    assert.match(content(card), new RegExp(`^⚠️ ตัวอัดหลุด \\(ปิดเครื่องหรือเน็ตหลุด\\) \\(<@${s.member.id}>\\) · เสียงยังอัดอยู่`));
    // A still shares in Discord: A is a candidate too (their agent may come back, or the link)
    assert.deepEqual(labels(card), ['⏹️ จบ', '🔴 อัดจอ Alice ต่อ', '🔴 อัดจอ Bob ต่อ']);
    assert.ok(voice.has(s.guild.id));
    await press(s, `screen:stop:${sess.began}`, { message: sess.card });
    const out = await resultOf(s, sess);
    assert.match(content(out), /⚠️ ตัวอัดหลุด/);
  });

  test('case 20 / D7: the owner stops at the agent → skipped; nobody else → ends now; re-share → new card', async () => {
    const s = await cardScene();
    agents.setOnline(s.member.id);
    const sess = await startSession(bot, s);
    agents.localStop(s.member.id);
    const out = await resultOf(s, sess);
    assert.match(content(out), /-# ⏹️ เจ้าของเครื่องกดหยุดที่ตัวอัด$/);
    assert.ok(bot.cardSkip.get(s.guild.id).has(s.member.id));
    await settle();
    assert.ok(!bot.roomCards.has(s.room.id), 'still sharing, but no card');
    share(s.member, false);
    share(s.member);
    await waitCard(bot, s);
  });

  test('D7 with someone else sharing: wait without the one who stopped', async () => {
    const s = await cardScene();
    agents.setOnline(s.member.id);
    const sess = await startSession(bot, s);
    share(s.b);
    agents.localStop(s.member.id);
    await waitFor(() => sess.state === 'waiting', 'waiting');
    await sess.cardQ;
    assert.deepEqual(labels(lastOf(sess.card)), ['⏹️ จบ', '🔴 อัดจอ Bob ต่อ']);
  });

  test('case 14: ⏹️ by the sharer without rights (D9 own) ends now; a non-sharer guest is refused', async () => {
    const s = await cardScene();
    agents.setOnline(s.b.id);
    const sess = await startSession(bot, s, { sharer: s.b });
    const guest = fakeMember(s.guild, { name: 'Guest' });
    const no = await press(s, `screen:stop:${sess.began}`, { member: guest, message: sess.card });
    assert.match(content(no.replies[0]), /^🔒/);
    assert.equal(screen.get(s.guild.id), sess);
    const yes = await press(s, `screen:stop:${sess.began}`, { member: s.b, message: sess.card });
    assert.ok(yes.deferredUpdate);
    const out = await resultOf(s, sess);
    assert.match(content(out), new RegExp(`-# หยุดโดย <@${s.b.id}>$`));
  });

  test('D9: the sharer may press their own 🔴 without rights; someone else without rights may not', async () => {
    const s = await cardScene({}, { admin: false });
    share(s.b);
    const card = await waitCard(bot, s);
    const no = await press(s, `screen:rec:${s.b.id}`, { message: card }); // Alice, no rights, not the sharer
    assert.match(content(no.replies[0]), /^🔒/);
    assert.equal(screen.size, 0);
    await press(s, `screen:rec:${s.b.id}`, { member: s.b, message: card });
    await waitFor(() => screen.get(s.guild.id)?.kind === 'session', 'own press works');
  });

  test('case 15: max length ends it with one meeting', async () => {
    const s = await cardScene({ maxMinutes: 0.002 });
    agents.setOnline(s.member.id);
    const sess = await startSession(bot, s);
    const out = await resultOf(s, sess);
    assert.match(content(out), /ครบเวลาอัดสูงสุดที่ตั้งไว้/);
    assert.equal(composed.calls.length, 1);
  });

  test('case 16: bot kicked while live → the video goes on with a note; while waiting → ends now', async () => {
    const s = await cardScene();
    agents.setOnline(s.member.id);
    const sess = await startSession(bot, s);
    sess.paired.onGone();
    await settle();
    assert.equal(screen.get(s.guild.id), sess, 'video still recording');
    await press(s, `screen:stop:${sess.began}`, { message: sess.card });
    const out = await resultOf(s, sess);
    assert.match(content(out), /บอทหลุดจากห้องเสียงกลางทาง/);

    bot._reset(); resetFakes(); composed.calls.length = 0;
    const t = await cardScene();
    agents.setOnline(t.member.id);
    const s2 = await startSession(bot, t);
    share(t.b);
    share(t.member, false);
    await waitFor(() => s2.state === 'waiting', 'waiting 2');
    s2.paired.onGone();
    const out2 = await resultOf(t, s2, 'ended by the drop');
    assert.match(content(out2), /-# ⚠️ บอทหลุดจากห้องเสียง$/);
  });

  test('all humans leave the room → ends now; the bot leaves', async () => {
    const s = await cardScene();
    agents.setOnline(s.member.id);
    const sess = await startSession(bot, s);
    moveMember(s.b, { channel: null });
    fire('voiceStateUpdate', ...moveMember(s.member, { channel: null }));
    const out = await resultOf(s, sess);
    assert.match(content(out), /ทุกคนออกจากห้องแล้ว$/);
    assert.ok(FakeVoiceRecorder.instances.every((v) => v.stopped));
  });

  test('case 17 / D15: compose fails → up to 3 segment videos + voice, with the note', async () => {
    const s = await cardScene();
    agents.setOnline(s.member.id);
    agents.setOnline(s.b.id);
    const sess = await startSession(bot, s);
    share(s.b);
    await waitFor(() => labels(lastOf(sess.card)).includes('🔁 สลับไปอัด Bob'), '🔁');
    await press(s, `screen:switch:${sess.began}.${s.b.id}`, { message: sess.card });
    await waitFor(() => sess.cur.owner === s.b.id, 'switched');
    bot.deps.composeFails = new Error('ffmpeg exploded');
    await press(s, `screen:stop:${sess.began}`, { message: sess.card });
    const out = await resultOf(s, sess);
    assert.deepEqual(labels(out), ['▶️ วิดีโอ 1', '▶️ วิดีโอ 2', '🎧 ฟังเสียง', '📁 ไฟล์ทั้งหมด']);
    assert.match(content(out), /⚠️ รวมเป็นไฟล์เดียวไม่สำเร็จ ส่งแยกไฟล์/);
    assertDiscordLimits(out, 'fallback result');
  });

  test('the nickname shows the screen owner while live and is restored after', async () => {
    const s = await cardScene();
    s.guild.members.me.nickname = 'Keep';
    agents.setOnline(s.b.id);
    const sess = await startSession(bot, s, { sharer: s.b });
    await waitFor(() => s.guild.members.me.nickname === 'Bob - 🔴 กำลังอัดหน้าจอ', 'tagged');
    await press(s, `screen:stop:${sess.began}`, { message: sess.card });
    await resultOf(s, sess);
    await waitFor(() => s.guild.members.me.nickname === 'Keep', 'restored');
  });
});

describe('one session per server (D2) and races', () => {
  test('double-press 🔴 → one session, one agent start', async () => {
    const s = await cardScene();
    agents.setOnline(s.member.id);
    share(s.member);
    const card = await waitCard(bot, s);
    const [a, b] = await Promise.all([press(s, `screen:rec:${s.member.id}`, { message: card }), press(s, `screen:rec:${s.member.id}`, { message: card })]);
    const r = [a, b].find((i) => i.replies.length);
    assert.match(content(r.replies[0]), /^กำลังอัดอยู่แล้ว/);
    assert.equal(agents.calls.length, 1);
    await waitFor(() => voice.has(s.guild.id), 'joined');
    assert.equal(FakeVoiceRecorder.instances.length, 1);
  });

  test('🔴 in a second room while the first records → the busy text, the second card stays', async () => {
    const s = await cardScene();
    agents.setOnline(s.member.id);
    const sess = await startSession(bot, s);
    const { fakeVoiceChannel } = await import('./helpers/fakes.js');
    const room2 = fakeVoiceChannel(s.guild, { name: 'Lobby' });
    const c = fakeMember(s.guild, { name: 'Carol' }), d = fakeMember(s.guild, { name: 'Dan' });
    moveMember(d, { channel: room2 });
    moveMember(c, { channel: room2 });
    share(c);
    const card2 = await waitCard(bot, s, room2);
    const i = await press(s, `screen:rec:${c.id}`, { message: card2 });
    assert.equal(content(i.replies[0]), `บอทอัดได้ทีละห้องต่อ server ตอนนี้อัดห้อง **Meeting** อยู่ ${sess.card.url}`);
    assert.ok(isEphemeral(i.replies[0]));
    assert.equal(agents.calls.length, 1);
    assert.ok(bot.roomCards.has(room2.id) && !card2.deleted);
  });

  test('🎙️ during a session is refused with the session card', async () => {
    const s = await cardScene();
    agents.setOnline(s.member.id);
    const sess = await startSession(bot, s);
    const i = await press(s, 'record:start');
    assert.equal(content(i.replies[0]), `บอทกำลังอัดเสียงในห้อง **Meeting** อยู่แล้ว ${sess.card.url}`);
    assert.ok(!bot.panel(s.guild).components[0].toJSON().components.some((c) => c.custom_id === 'record:start'));
    assertDiscordLimits(bot.panel(s.guild), 'panel with a session');
  });

  test('🔴 for someone who stopped sharing: told, the card goes away', async () => {
    const s = await cardScene();
    share(s.b);
    const card = await waitCard(bot, s);
    moveMember(s.b, { streaming: false }); // the event hasn't arrived yet
    const i = await press(s, `screen:rec:${s.b.id}`, { message: card });
    assert.equal(content(i.replies[0]), `<@${s.b.id}> ไม่ได้แชร์จออยู่แล้ว`);
    await waitFor(() => card.deleted, 'stale card removed');
    assert.equal(screen.size, 0);
  });

  test('a failed voice join keeps the agent video with a note (R9); without any video it cancels', async () => {
    const s = await cardScene();
    agents.setOnline(s.member.id);
    FakeVoiceRecorder.startHook = () => { throw new Error('join timeout'); };
    share(s.member);
    const i = await pressRec(bot, s);
    const card = i.message;
    const sess = await waitFor(() => screen.get(s.guild.id)?.cur && screen.get(s.guild.id), 'video live');
    await waitFor(() => /บอทเข้าห้องเสียง \*\*Meeting\*\* ไม่ได้: join timeout — อัดแค่ภาพจอ/.test(content(lastOf(card))), 'note');
    assert.equal(sess.cur.source, 'agent');
    assert.ok(!sess.paired);
    await press(s, `screen:stop:${sess.began}`, { message: sess.card });
    await resultOf(s, sess);
    assert.equal(composed.calls.length, 1, 'the video is delivered');
    // no agent: the link alone records nothing, so a failed join cancels
    FakeVoiceRecorder.startHook = () => { throw new Error('join timeout'); };
    const s2 = await cardScene();
    share(s2.member);
    const i2 = await pressRec(bot, s2);
    await waitFor(() => !screen.has(s2.guild.id), 'cancelled');
    await waitFor(() => content(lastOf(i2.message)).startsWith('⚪ **ไม่ได้อัด** — ❌ บอทเข้าห้องเสียง **Meeting** ไม่ได้: join timeout'), 'card text');
  });

  test('restart: room cards are deleted, then reposted for who shares now', async () => {
    const s = await cardScene();
    share(s.member);
    const card = await waitCard(bot, s);
    await bot.roomCards.get(s.room.id).cardQ;
    bot._reset();
    await fire('clientReady', bot.client);
    await waitFor(() => card.deleted, 'old card deleted');
    await waitFor(() => roomCardOf(bot, s.room) && roomCardOf(bot, s.room) !== card, 'reposted');
    await waitFor(() => getSettings(s.guild.id).roomCards.length === 1, 'only the new one remembered');
    bot._reset();
  });
});
