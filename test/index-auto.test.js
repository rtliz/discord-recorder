import './helpers/env.js';
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadBot, waitFor, sleep, scene, resetFakes } from './helpers/bot.js';
import { fakeMember, fakeVoiceChannel, fakeInteraction, moveMember, parts, ids, FakeVoiceRecorder } from './helpers/fakes.js';
import { roomCardOf, waitCard, pressOn, pressRec } from './helpers/session.js';
import { assertDiscordLimits } from './helpers/limits.js';

// auto mode (shareMode 'auto', change 2026-11-11, old flow): a share that passes the card filters starts recording by
// itself (as if 🔴 was pressed for them, by them): the bot joins at once, the screen from their agent, else the 🎥
// link on the card. Never an auto switch while a screen is live; when it stops, another sharer with an agent continues the
// same session at once. One session per server. Browser-capture mode with FakeAgentHub

const { bot, logs, fire, agents, composed, share } = await loadBot({ SCREEN_ENABLED: 'false', PUBLIC_URL: 'http://localhost:1' });
const { T } = await import('../src/browser-capture.js');
const { updateSettings, getSettings } = await import('../src/settings.js');
Object.assign(T, { drainMax: 50, silent: 50, poll: 5 });
const WAIT = bot.T.wait;

const { voice, screen } = bot;
const content = (p) => p?.content ?? '';
const lastOf = (m) => m.edits.at(-1) ?? m.payload;
const labels = (p) => parts(p).map((c) => c.label);
const press = (s, customId, extra) => pressOn(bot, s, customId, extra);
const settle = (ms = 40) => sleep(ms);
// a server in auto mode: the admin Alice (s.member) and Bob (s.b) in the room, nobody sharing yet
const autoScene = async (patch = {}) => {
  const s = scene(bot, { name: 'Alice' });
  await updateSettings(s.guild.id, { shareMode: 'auto', minMembers: 2, minShareSeconds: 0, mode: 'agent', ...patch });
  s.b = fakeMember(s.guild, { name: 'Bob' });
  moveMember(s.b, { channel: s.room });
  for (const m of [s.member, s.b]) bot.client.users.cache.set(m.id, { id: m.id, tag: m.displayName }); // log names
  return s;
};
// the server's session once its screen records and the room audio joined
const liveSession = (s, owner) => waitFor(() => {
  const x = screen.get(s.guild.id);
  return x?.kind === 'session' && x.cur?.owner === owner.id && x.cur.rec.state === 'live' && x.paired && voice.get(s.guild.id) === x.paired && x;
}, `${owner.displayName} recorded`);
const resultOf = async (s, sess) => {
  await waitFor(() => !screen.has(s.guild.id) && !voice.has(s.guild.id) && /^[✅❌⚪]/.test(content(lastOf(sess.card))), 'result');
  await settle();
  return lastOf(sess.card);
};
const autoLogs = () => logs.out.filter((l) => l.includes('(อัตโนมัติ)'));

beforeEach(() => {
  bot._reset(); bot.client.guilds.cache.clear(); resetFakes();
  logs.out.length = 0; logs.err.length = 0; composed.calls.length = 0; bot.T.wait = WAIT;
});
after(() => bot._reset());

describe('auto start with the sharer\'s agent online', () => {
  test('a share starts the session by itself: the sharer\'s agent, the bot joins, by = the sharer, card/nick/log say auto', async () => {
    const s = await autoScene();
    s.guild.members.me.nickname = 'Keep';
    agents.setOnline(s.b.id);
    share(s.b);
    const sess = await liveSession(s, s.b);
    const g = s.guild.id;
    assert.equal(agents.calls.length, 1);
    const call = agents.calls[0];
    assert.equal(call.userId, s.b.id, 'only the sharer\'s machine');
    assert.equal(call.by, 'Bob', 'as if they pressed it themselves');
    assert.equal(call.room, 'Meeting');
    assert.equal(sess.by, s.b.id);
    assert.equal(sess.mode, 'share');
    assert.ok(sess.auto && sess.cur.auto);
    assert.equal(voice.get(g).channel, s.room);
    assert.equal(voice.get(g).by, s.b.id);
    assert.ok(!bot.roomCards.has(s.room.id), 'no 🔴 card first');
    await sess.cardQ;
    assert.equal(s.room.sent.length, 1, 'one message: the session card');
    const card = lastOf(sess.card);
    assert.match(content(card), new RegExp(`^🔴 \\*\\*กำลังอัดจอของ <@${s.b.id}>\\*\\* ในห้อง \\*\\*Meeting\\*\\*.*\\n-# บอทอัดเสียงทุกคนในห้องด้วย\\n-# ⚡ อัดอัตโนมัติ`));
    assert.deepEqual(ids(card), [`screen:stop:${sess.began}`]);
    assertDiscordLimits(card, 'auto live card');
    assert.deepEqual(getSettings(g).cards, [[sess.card.channelId, sess.card.id]], 'remembered for a restart');
    await waitFor(() => s.guild.members.me.nickname === 'Bob - 🔴 อัดจออัตโนมัติ', 'nickname says auto');
    assert.ok(s.guild.members.me.nickname.length <= 32);
    assert.ok(autoLogs().some((l) => /⚡ เริ่มอัดจอของ Bob ห้อง Meeting \(อัตโนมัติ\)/.test(l)), logs.out.join('\n'));
    assert.ok(autoLogs().some((l) => /🎥 อัดจอของ Bob \(ตัวอัด\) \(อัตโนมัติ\)/.test(l)));
    const p = bot.panel(s.guild);
    assert.match(content(p), /📣 เมื่อมีคนแชร์จอ: \*\*อัดอัตโนมัติ\*\*/);
    assertDiscordLimits(p, 'panel with an auto session');
    await press(s, `screen:stop:${sess.began}`, { message: sess.card });
    const out = await resultOf(s, sess);
    assert.match(content(out), new RegExp(`^✅ \\*\\*อัดจอเสร็จแล้ว\\*\\* · ยาว \\d+:\\d\\d · จอของ <@${s.b.id}>`));
    assert.equal(composed.calls.length, 1);
    await waitFor(() => s.guild.members.me.nickname === 'Keep', 'nickname restored');
  });

  test('(old flow) the bot joins at once while the agent starts; the card says recording (an old agent\'s askFirst is ignored)', async () => {
    const s = await autoScene();
    agents.setOnline(s.b.id, { askFirst: true });
    agents.startMode = 'hold';
    share(s.b);
    await waitFor(() => agents.pending.length === 1, 'commanded');
    const sess = screen.get(s.guild.id);
    await waitFor(() => sess.paired && voice.get(s.guild.id) === sess.paired, 'joined before the ack');
    await sess.cardQ;
    const card = lastOf(sess.card);
    assert.match(content(card), new RegExp(`^🔴 \\*\\*กำลังอัดในห้อง Meeting\\*\\*[^\\n]*\\n-# บอทอัดเสียงทุกคนในห้องด้วย\\n⏳ \\*\\*กำลังสั่งเครื่องของ <@${s.b.id}> ให้เริ่มอัดจอ...\\*\\*`));
    assert.doesNotMatch(content(card), /ถามก่อน/);
    assert.equal(parts(card)[0].style, 4, 'a red stop: the room records');
    assertDiscordLimits(card, 'auto starting card');
    agents.ack('ok');
    await liveSession(s, s.b);
    assert.equal(FakeVoiceRecorder.instances.length, 1);
  });

  for (const how of ['declined', 'busy']) {
    test(`(old flow) the agent fails (${how}): the audio goes on, the 🎥 link on the card, a note; skipped for auto, never re-commanded until they re-share`, async () => {
      const s = await autoScene();
      agents.setOnline(s.b.id);
      agents.plan.push(how);
      share(s.b);
      const sess = await waitFor(() => screen.get(s.guild.id)?.cur?.source === 'link' && screen.get(s.guild.id).paired && screen.get(s.guild.id), 'link + audio');
      assert.ok(sess.auto);
      assert.ok(bot.cardSkip.get(s.guild.id).has(s.b.id), 'skipped for auto');
      await sess.cardQ;
      const card = lastOf(sess.card);
      assert.match(content(card), /^🔴 \*\*กำลังอัดเสียงในห้อง Meeting\*\* · <@\d+> กด 🎥 เพื่ออัดจอด้วย/);
      assert.match(content(card), /-# ⚠️ /);
      assert.ok(parts(card).some((c) => c.url?.startsWith('http://localhost:1/capture/')));
      // any later event (someone joins, the agent reconnecting) commands nothing
      const c = fakeMember(s.guild, { name: 'Carol' });
      fire('voiceStateUpdate', ...moveMember(c, { channel: s.room }));
      agents.setOnline(s.b.id, false);
      agents.setOnline(s.b.id);
      await settle(60);
      assert.equal(agents.calls.length, 1, 'not commanded again');
      assert.equal(screen.get(s.guild.id), sess);
      share(s.b, false);
      await resultOf(s, sess);
      share(s.b);
      await waitFor(() => agents.calls.length === 2, 'a new share is a new chance');
    });
  }

  test('the bot cannot join the room: the agent video goes on with a note (R9)', async () => {
    const s = await autoScene();
    agents.setOnline(s.b.id);
    FakeVoiceRecorder.startHook = () => { throw new Error('join timeout'); };
    share(s.b);
    const sess = await waitFor(() => screen.get(s.guild.id)?.cur?.rec.state === 'live' && screen.get(s.guild.id), 'video');
    await waitFor(() => /ไม่ได้: join timeout — อัดแค่ภาพจอ/.test(sess.notes), 'note');
    assert.ok(!sess.paired);
    await press(s, `screen:stop:${sess.began}`, { message: sess.card });
    await resultOf(s, sess);
    assert.equal(composed.calls.length, 1);
    assert.equal(agents.calls.length, 1, 'not retried');
  });

  test('no agent and the bot cannot join: cancelled with the reason, skipped (no retry loop)', async () => {
    const s = await autoScene();
    FakeVoiceRecorder.startHook = () => { throw new Error('join timeout'); };
    share(s.b);
    await waitFor(() => FakeVoiceRecorder.instances.length >= 0 && bot.cardSkip.get(s.guild.id)?.has(s.b.id) && !screen.has(s.guild.id), 'cancelled + skipped');
    const n = logs.out.filter((l) => l.includes('ไม่ได้อัด')).length;
    await settle(80);
    assert.equal(logs.out.filter((l) => l.includes('ไม่ได้อัด')).length, n, 'not retried');
    assert.ok(!screen.has(s.guild.id));
  });

  test('the share ends while their machine is being told: the room audio and the short video are delivered, not skipped', async () => {
    const s = await autoScene();
    agents.setOnline(s.b.id);
    agents.startMode = 'hold';
    share(s.b);
    await waitFor(() => agents.pending.length === 1, 'commanded');
    const sess = screen.get(s.guild.id);
    await waitFor(() => sess.paired, 'joined');
    share(s.b, false);
    agents.ack('ok');
    const out = await resultOf(s, sess);
    assert.match(content(out), /^✅/);
    assert.match(content(out), /เลิกแชร์จอแล้ว/);
    assert.equal(FakeVoiceRecorder.instances.length, 1);
    assert.ok(!bot.cardSkip.get(s.guild.id)?.has(s.b.id), 'not sharing: no skip that would outlive the share');
    agents.startMode = 'ok';
    share(s.b);
    await liveSession(s, s.b);
  });
});

describe('filters: the same as cards', () => {
  const blocked = {
    'too few people': [{ minMembers: 3 }],
    'an unwatched room': [{ channels: ['elsewhere'] }],
    'a role filter they lack': [{ roles: ['r1'] }],
    'out of schedule': [{ days: [] }],
    'mode off': [{ shareMode: 'off' }],
  };
  for (const [what, [patch]] of Object.entries(blocked)) {
    test(`${what}: no start and no card`, async () => {
      const s = await autoScene(patch);
      agents.setOnline(s.b.id);
      share(s.b);
      await settle(60);
      assert.equal(agents.calls.length + screen.size + voice.size + FakeVoiceRecorder.instances.length, 0);
      assert.ok(!bot.roomCards.has(s.room.id));
    });
  }

  test('card mode with the agent online: only the card, nothing records until a press (unchanged)', async () => {
    const s = await autoScene({ shareMode: 'card' });
    agents.setOnline(s.b.id);
    share(s.b);
    await waitCard(bot, s);
    await settle(60);
    assert.equal(agents.calls.length + screen.size + FakeVoiceRecorder.instances.length, 0);
    await pressRec(bot, s, s.b.id);
    const sess = await liveSession(s, s.b);
    assert.ok(!sess.auto && !sess.cur.auto, 'a pressed session');
    assert.equal(agents.calls[0].by, 'Alice');
  });

  test('a short share waits for minShareSeconds, then starts', async () => {
    const s = await autoScene({ minShareSeconds: 1 });
    agents.setOnline(s.b.id);
    share(s.b);
    await settle(300);
    assert.equal(agents.calls.length, 0, 'too short yet');
    await liveSession(s, s.b);
  });

  test('skip list: a sharer in cardSkip is not started', async () => {
    const s = await autoScene();
    agents.setOnline(s.b.id);
    moveMember(s.b, { streaming: true });
    bot.cardSkip.set(s.guild.id, new Set([s.b.id]));
    fire('voiceStateUpdate', ...moveMember(s.member, { channel: s.room })); // any event
    await settle(60);
    assert.equal(agents.calls.length, 0);
  });
});

describe('no agent online (old flow)', () => {
  test('(old flow) the session starts at once: the bot joins, the card says recording with the 🎥 link for the sharer; opening it → live', async () => {
    const s = await autoScene();
    share(s.b);
    const sess = await waitFor(() => screen.get(s.guild.id)?.cur && screen.get(s.guild.id).paired && screen.get(s.guild.id), 'started');
    assert.ok(sess.auto);
    assert.equal(sess.cur.source, 'link');
    assert.equal(sess.cur.owner, s.b.id);
    assert.equal(agents.calls.length, 0);
    assert.equal(voice.get(s.guild.id).channel, s.room);
    await sess.cardQ;
    const card = lastOf(sess.card);
    assert.equal(content(card).split('\n')[0], `🔴 **กำลังอัดเสียงในห้อง Meeting** · <@${s.b.id}> กด 🎥 เพื่ออัดจอด้วย`);
    assert.match(content(card), /⚡ อัดอัตโนมัติ/);
    const link = parts(card).find((c) => c.url);
    assert.match(link.url, /^http:\/\/localhost:1\/capture\//);
    assert.ok(ids(card).includes('agent:install'), '📥 for next time');
    assertDiscordLimits(card, 'auto link card');
    const rec = sess.cur.rec;
    assert.equal(rec.offerMs ?? 0, 0, 'no 5-minute expiry');
    rec.finalize = async () => `${rec.dir}/screen.webm`;
    await rec.claim(link.url.split('/capture/')[1], 'video/webm');
    await waitFor(() => /กำลังอัดจอของ/.test(content(lastOf(sess.card))), 'live');
    share(s.b, false);
    const out = await resultOf(s, sess);
    assert.match(content(out), /^✅ \*\*อัดจอเสร็จแล้ว/);
    assert.equal(composed.calls.length, 1, 'one file');
  });

  test('(old flow) browser mode never commands an agent, even one online: the link', async () => {
    const s = await autoScene({ mode: 'browser' });
    agents.setOnline(s.b.id);
    share(s.b);
    const sess = await waitFor(() => screen.get(s.guild.id)?.cur && screen.get(s.guild.id), 'started');
    assert.equal(sess.cur.source, 'link');
    await settle(60);
    assert.equal(agents.calls.length, 0);
  });

  test('(old flow) their agent comes online while the link is unopened: the video switches to their agent, same session and card', async () => {
    const s = await autoScene();
    share(s.b);
    const sess = await waitFor(() => screen.get(s.guild.id)?.cur && screen.get(s.guild.id).paired && screen.get(s.guild.id), 'started');
    const card = sess.card;
    const link = sess.cur;
    agents.setOnline(s.b.id);
    await liveSession(s, s.b);
    assert.equal(sess.cur.source, 'agent');
    assert.ok(link.done, 'the unopened link was dropped');
    assert.equal(sess.card, card);
    assert.equal(FakeVoiceRecorder.instances.length, 1, 'voice unbroken');
  });

  test('an agent coming online while something else records starts nothing', async () => {
    const s = await autoScene();
    await press(s, 'record:start'); // a manual 🎙️ holds the server's voice
    share(s.b);
    await waitCard(bot, s);
    agents.setOnline(s.b.id);
    await settle(60);
    assert.equal(agents.calls.length, 0);
    assert.ok(bot.roomCards.has(s.room.id), 'the card stays');
  });
});

describe('A recorded, B shares on top', () => {
  const two = async ({ bAgent = true } = {}) => { // A (Alice) auto-recorded, B shares on top
    const s = await autoScene();
    agents.setOnline(s.member.id);
    if (bAgent) agents.setOnline(s.b.id);
    share(s.member);
    const sess = await liveSession(s, s.member);
    share(s.b);
    await waitFor(() => ids(lastOf(sess.card)).includes(`screen:switch:${sess.began}.${s.b.id}`), '🔁 B');
    return [s, sess];
  };

  test('no auto switch while A is live: 🔁 is offered', async () => {
    const [s, sess] = await two();
    await settle(60);
    assert.equal(agents.calls.length, 1);
    assert.equal(sess.cur.owner, s.member.id);
    assertDiscordLimits(lastOf(sess.card), 'auto card with 🔁');
  });

  for (const [how, end] of [
    ['A stops sharing', (s) => share(s.member, false)],
    ['A stops at their agent', (s) => agents.localStop(s.member.id)],
    ['A\'s agent drops', (s) => agents.drop(s.member.id)],
  ]) {
    test(`${how} → continues on B at once, same session, voice and file`, async () => {
      const [s, sess] = await two();
      const a = sess.cur;
      end(s);
      await waitFor(() => sess.cur?.owner === s.b.id && sess.state === 'live', 'B current');
      assert.equal(screen.get(s.guild.id), sess);
      assert.equal(agents.calls.length, 2);
      assert.equal(agents.calls[1].userId, s.b.id);
      assert.equal(agents.calls[1].by, 'Bob');
      assert.ok(sess.cur.auto);
      assert.ok(a.done, 'A stopped');
      assert.equal(FakeVoiceRecorder.instances.length, 1, 'voice unbroken');
      assert.ok(autoLogs().some((l) => /⚡ อัดจอของ Bob ต่อ ห้อง Meeting \(อัตโนมัติ\)/.test(l)));
      await sess.cardQ;
      assert.match(content(lastOf(sess.card)), new RegExp(`กำลังอัดจอของ <@${s.b.id}>`));
      await press(s, `screen:stop:${sess.began}`, { message: sess.card });
      await resultOf(s, sess);
      assert.equal(composed.calls.length, 1);
      assert.equal(composed.calls[0].segments.length, 2, 'one file, both screens');
    });
  }

  test('A\'s agent drops and only A still shares: no auto restart of A, the wait for a press', async () => {
    const s = await autoScene();
    agents.setOnline(s.member.id);
    share(s.member);
    const sess = await liveSession(s, s.member);
    const c = fakeMember(s.guild, { name: 'Carol' });
    fire('voiceStateUpdate', ...moveMember(c, { channel: s.room })); // so the wait does not end for lack of people
    agents.drop(s.member.id, { offline: false }); // the device still looks online
    await waitFor(() => sess.state === 'waiting', 'waiting');
    await settle(60);
    assert.equal(agents.calls.length, 1, 'never auto again after a drop');
    assert.deepEqual(labels(lastOf(sess.card)), ['⏹️ จบ', '🔴 อัดจอ Alice ต่อ']);
  });

  test('(old flow) B has no agent: continues at once on B\'s link, same session and voice', async () => {
    const [s, sess] = await two({ bAgent: false });
    share(s.member, false);
    await waitFor(() => sess.cur?.owner === s.b.id && sess.state === 'live', 'continued on B');
    assert.equal(sess.cur.source, 'link');
    assert.equal(agents.calls.length, 1, 'nothing commanded');
    assert.equal(FakeVoiceRecorder.instances.length, 1);
    await sess.cardQ;
    assert.ok(parts(lastOf(sess.card)).some((c) => c.url), 'B\'s link on the card');
  });

  test('(old flow) B\'s link never opened and B stops sharing: ends with one meeting (A\'s video + the room audio)', async () => {
    const [s, sess] = await two({ bAgent: false });
    share(s.member, false);
    await waitFor(() => sess.cur?.owner === s.b.id, 'B');
    share(s.b, false);
    const out = await resultOf(s, sess);
    assert.match(content(out), /^✅ \*\*อัดจอเสร็จแล้ว/);
    assert.equal(composed.calls[0].segments.length, 1, 'only A recorded video');
  });

  test('B\'s agent declines the continuation: B\'s link instead, a note, B skipped for auto', async () => {
    const [s, sess] = await two();
    agents.plan.push('declined');
    share(s.member, false);
    await waitFor(() => agents.calls.length === 2 && agents.calls[1].settled, 'B commanded');
    await waitFor(() => sess.cur?.owner === s.b.id && sess.cur.source === 'link', 'B link');
    assert.match(sess.notes, /ไม่อนุญาตให้อัดจอ/);
    assert.ok(bot.cardSkip.get(s.guild.id).has(s.b.id));
  });
});

describe('hand stop', () => {
  test('⏹️ → every sharer skipped until they re-share; no auto restart', async () => {
    const s = await autoScene();
    agents.setOnline(s.b.id);
    share(s.b);
    const sess = await liveSession(s, s.b);
    await press(s, `screen:stop:${sess.began}`, { message: sess.card });
    await resultOf(s, sess);
    assert.ok(bot.cardSkip.get(s.guild.id).has(s.b.id));
    fire('voiceStateUpdate', ...moveMember(s.member, { channel: s.room }));
    await settle(60);
    assert.equal(agents.calls.length, 1, 'not restarted');
    assert.ok(!screen.has(s.guild.id) && !bot.roomCards.has(s.room.id));
    share(s.b, false);
    share(s.b);
    await waitFor(() => agents.calls.length === 2, 'a re-share starts again');
    await liveSession(s, s.b);
  });

  test('`s` at the agent → skipped, the session ends; re-share starts again', async () => {
    const s = await autoScene();
    agents.setOnline(s.b.id);
    share(s.b);
    const sess = await liveSession(s, s.b);
    agents.localStop(s.b.id);
    const out = await resultOf(s, sess);
    assert.match(content(out), /-# ⏹️ เจ้าของเครื่องกดหยุดที่ตัวอัด$/);
    assert.ok(bot.cardSkip.get(s.guild.id).has(s.b.id));
    await settle(60);
    assert.equal(agents.calls.length, 1);
    share(s.b, false);
    share(s.b);
    await liveSession(s, s.b);
    assert.equal(agents.calls.length, 2);
  });
});

describe('one session per server', () => {
  test('a second room sharing while one records gets a card, never an auto start; it starts once the first ends', async () => {
    const s = await autoScene();
    agents.setOnline(s.b.id);
    share(s.b);
    const sess = await liveSession(s, s.b);
    const room2 = fakeVoiceChannel(s.guild, { name: 'Lobby' });
    const c = fakeMember(s.guild, { name: 'Carol' }), d = fakeMember(s.guild, { name: 'Dan' });
    moveMember(d, { channel: room2 });
    moveMember(c, { channel: room2 });
    agents.setOnline(c.id);
    share(c);
    const card2 = await waitCard(bot, s, room2);
    await settle(60);
    assert.equal(agents.calls.length, 1, 'room 2 only gets a card');
    assert.equal(screen.get(s.guild.id), sess);
    await bot.roomCards.get(room2.id).cardQ;
    assert.deepEqual(labels(card2.payload), ['🔴 เริ่มอัด', '📥 ติดตั้งตัวอัด']);
    await press(s, `screen:stop:${sess.began}`, { message: sess.card });
    await waitFor(() => /^✅/.test(content(lastOf(sess.card))), 'room 1 result'); // room 2 may start meanwhile
    const sess2 = await liveSession(s, c);
    assert.equal(sess2.room, room2);
    assert.equal(sess2.card, card2, 'room 2\'s card became its session card');
    assert.equal(agents.calls[1].userId, c.id);
  });

  test('two sharers with agents in one room at once: one session, the other gets 🔁', async () => {
    const s = await autoScene();
    agents.setOnline(s.member.id);
    agents.setOnline(s.b.id);
    moveMember(s.member, { streaming: true });
    share(s.b);
    const sess = await waitFor(() => screen.get(s.guild.id)?.cur && screen.get(s.guild.id), 'one started');
    await settle(60);
    assert.equal(agents.calls.length, 1);
    assert.equal(FakeVoiceRecorder.instances.length, 1);
    await sess.cardQ;
    assert.equal(parts(lastOf(sess.card)).filter((x) => x.custom_id?.startsWith('screen:switch:')).length, 1);
  });
});

describe('settings: the 3-way control', () => {
  test('the quick page select saves shareMode; switching to auto starts a share already going; old share-* buttons still work', async () => {
    const s = await autoScene({ shareMode: 'off' });
    agents.setOnline(s.b.id);
    share(s.b);
    await settle(40);
    assert.equal(agents.calls.length, 0);
    const open = await press(s, 'config:open');
    const quick = open.replies[0];
    assertDiscordLimits(quick, 'quick page');
    const selOf = (p, id) => p.components.map((r) => r.toJSON().components).find((r) => r[0].custom_id === id)?.[0];
    const sel = selOf(quick, 'config:share');
    assert.deepEqual([...sel.options.map((o) => o.value)].sort(), ['auto', 'card', 'off']);
    assert.equal(sel.options.find((o) => o.default).value, 'off');
    for (const id of ['config:mode', 'config:area', 'config:who']) assert.ok(selOf(quick, id), id);
    let i = await press(s, 'config:share', { kind: 'select', values: ['card'] });
    assert.equal(getSettings(s.guild.id).shareMode, 'card');
    assert.equal(selOf(i.updates[0], 'config:share').options.find((o) => o.default).value, 'card');
    assertDiscordLimits(i.updates[0], 'quick page after a change');
    await waitCard(bot, s);
    assert.equal(agents.calls.length, 0, 'card mode: a card only');
    i = await press(s, 'config:share-auto'); // an old message's button
    assert.equal(getSettings(s.guild.id).shareMode, 'auto');
    const sess = await liveSession(s, s.b);
    assert.ok(sess.auto);
    await press(s, 'config:share', { kind: 'select', values: ['off'] });
    assert.equal(getSettings(s.guild.id).shareMode, 'off');
    assert.equal(screen.get(s.guild.id), sess, 'a running session is never touched by settings');
    await press(s, 'config:share', { kind: 'select', values: ['loud'] });
    assert.equal(getSettings(s.guild.id).shareMode, 'off', 'unknown value ignored');
    const done = await press(s, 'config:done');
    assert.match(content(done.updates[0]), /บันทึกแล้ว/);
  });

  test('the quick page selects save mode, area and who; bad values are ignored', async () => {
    const s = await autoScene({ shareMode: 'card' });
    await press(s, 'config:mode', { kind: 'select', values: ['browser'] });
    assert.equal(getSettings(s.guild.id).mode, 'browser');
    await press(s, 'config:mode', { kind: 'select', values: ['screen'] });
    assert.equal(getSettings(s.guild.id).mode, 'browser', 'host-Mac modes are not selectable with PUBLIC_URL');
    await press(s, 'config:area', { kind: 'select', values: ['discord'] });
    assert.equal(getSettings(s.guild.id).area, 'discord');
    await press(s, 'config:area', { kind: 'select', values: ['window'] });
    assert.equal(getSettings(s.guild.id).area, 'discord');
    await press(s, 'config:who', { kind: 'select', values: ['all'] });
    assert.equal(getSettings(s.guild.id).anyoneRecords, true);
    await press(s, 'config:who', { kind: 'select', values: ['admins'] });
    assert.equal(getSettings(s.guild.id).anyoneRecords, false);
    for (const [id, vals] of [['config:mode', ['agent']], ['config:area', ['screen']], ['config:who', ['all']]]) {
      const i = await press(s, id, { kind: 'select', values: vals, member: s.b });
      assert.match(content(i.replies[0]), /^🔒/, `${id}: non-admins refused`);
    }
    assert.equal(getSettings(s.guild.id).anyoneRecords, false);
  });

  test('the old on/off toggle (an old setup message) switches off ↔ card, auto → off', async () => {
    const s = await autoScene({ shareMode: 'auto' });
    await press(s, 'config:cards');
    assert.equal(getSettings(s.guild.id).shareMode, 'off');
    await press(s, 'config:cards-main');
    assert.equal(getSettings(s.guild.id).shareMode, 'card');
  });

  test('legacy autoScreen: true reads as auto and starts by itself', async () => {
    const s = scene(bot, { name: 'Alice' });
    await updateSettings(s.guild.id, { autoScreen: true, minMembers: 2, minShareSeconds: 0, mode: 'agent' });
    s.b = fakeMember(s.guild, { name: 'Bob' });
    moveMember(s.b, { channel: s.room });
    assert.equal(getSettings(s.guild.id).shareMode, 'auto');
    agents.setOnline(s.b.id);
    share(s.b);
    await liveSession(s, s.b);
  });

  test('non-admins cannot change it', async () => {
    const s = await autoScene({ shareMode: 'card' });
    const i = await press(s, 'config:share-auto', { member: s.b });
    assert.match(content(i.replies[0]), /^🔒 ตั้งค่าได้เฉพาะผู้ดูแล server/);
    assert.equal(getSettings(s.guild.id).shareMode, 'card');
  });
});

describe('restart', () => {
  test('a share already going when the bot starts is auto-recorded after the old cards are cleaned', async () => {
    const s = await autoScene();
    agents.setOnline(s.b.id);
    moveMember(s.b, { streaming: true }); // sharing before the bot came up: no event
    assert.equal(roomCardOf(bot, s.room), undefined);
    bot.client.listeners('clientReady')[0](bot.client);
    await liveSession(s, s.b);
  });
});
