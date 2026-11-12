import { tmp } from './helpers/env.js';
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { truncate } from 'node:fs/promises';
import { loadBot, waitFor, sleep, scene, resetFakes } from './helpers/bot.js';
import { fakeInteraction, fakeMember, moveMember, parts, ids, deferred, FakeVoiceRecorder } from './helpers/fakes.js';
import { assertDiscordLimits } from './helpers/limits.js';
import { pressRec, startSession } from './helpers/session.js';

// index.js flows in browser-capture mode (k8s-like: no host screen, PUBLIC_URL set), Drive on, no Discord

const { bot, logs, uploads, fire } = await loadBot({ SCREEN_ENABLED: 'false', PUBLIC_URL: 'http://localhost:1' });
const { T } = await import('../src/browser-capture.js');
const { updateSettings, getSettings } = await import('../src/settings.js');
Object.assign(T, { drainMax: 50, silent: 50, poll: 5 }); // a page that never talks: finish fast

const { voice, screen } = bot;
const content = (p) => p?.content ?? '';
const isEphemeral = (p) => Boolean(p?.flags & MessageFlags.Ephemeral);
const press = (s, customId, extra = {}) => fire('interactionCreate', fakeInteraction({ guild: s.guild, member: s.member, channel: s.text, customId, ...extra }));
const interact = (s, customId, extra = {}) => {
  const i = fakeInteraction({ guild: s.guild, member: s.member, channel: s.text, customId, ...extra });
  return [i, fire('interactionCreate', i)];
};
const lastEdit = (m) => m.edits.at(-1) ?? m.payload;
const tokenOf = (rec) => rec.link().split('/capture/')[1];
// the page "records": claim, and a finalize that yields a file without ffmpeg
const goLive = (rec) => {
  rec.finalize = async () => `${rec.dir}/screen.webm`;
  return rec.claim(tokenOf(rec), 'video/webm');
};

beforeEach(() => { bot._reset(); bot.client.guilds.cache.clear(); resetFakes(); uploads.length = 0; logs.err.length = 0; }); // checkShares sweeps every cached guild
after(() => bot._reset());

describe('loading', () => {
  test('importing index.js neither logs in nor registers commands', () => {
    assert.equal(bot.client.ws.status !== undefined, true);
    assert.equal(bot.client.readyAt, null);
    assert.ok(!logs.out.some((l) => l.includes('logged in')));
  });
});

describe('manual voice', () => {
  test('not in a voice room: a hint, nothing starts', async () => {
    const s = scene(bot, { inVoice: false });
    const [i, done] = interact(s, 'record:start');
    await done;
    assert.ok(isEphemeral(i.replies[0]));
    assert.match(content(i.replies[0]), /เข้าห้องเสียงก่อน/);
    assert.equal(voice.size, 0);
  });

  test('start → one card with a tagged stop; stop on it → ⏳ ⏫ ✅ with Drive links', async () => {
    const s = scene(bot);
    const [i, done] = interact(s, 'record:start');
    await done;
    assert.ok(i.deferred);
    const rec = voice.get(s.guild.id);
    assert.ok(rec && FakeVoiceRecorder.instances.length === 1);
    assert.match(content(i.edits[0]), /🔴 \*\*กำลังอัดเสียง/);
    assert.deepEqual(ids(i.edits[0]), [`record:stop:${rec.began}`]);
    const card = rec.card;
    assert.equal(card, i.replyMessage, 'the deferred reply is the card');
    assert.equal(s.text.sent.length, 0, 'no second message');

    const [stop, stopped] = interact(s, `record:stop:${rec.began}`, { message: card });
    await stopped;
    assert.ok(stop.deferredUpdate);
    assert.equal(voice.size, 0);
    const texts = i.edits.slice(1).map(content).concat(card.edits.map(content));
    assert.ok(texts.some((t) => t.startsWith('⏳')), texts.join('|'));
    assert.ok(texts.some((t) => t.startsWith('⏫')), texts.join('|'));
    const result = [...i.edits, ...card.edits].at(-1);
    assert.match(content(result), /^✅/);
    const links = parts(result).filter((c) => c.url);
    assert.ok(links.some((c) => c.url.startsWith('https://drive.google.com/file/')));
    assert.ok(links.some((c) => c.url.includes('/folders/FOLDER')));
    assert.equal(s.text.sent.length, 0, 'still one message');
    assertDiscordLimits(result, 'voice result');
  });

  test('double click starts one recorder', async () => {
    const s = scene(bot);
    const gate = deferred();
    FakeVoiceRecorder.startHook = () => gate.promise;
    const [, a] = interact(s, 'record:start');
    const [b, bDone] = interact(s, 'record:start');
    await bDone;
    assert.match(content(b.replies[0]), /บอทกำลังอัดเสียงในห้อง \*\*Meeting\*\* อยู่แล้ว/); // U12 (the presser's room: not tracked yet)
    gate.resolve();
    await a;
    assert.equal(FakeVoiceRecorder.instances.length, 1);
  });

  test('a stale stop button: reply + its buttons dropped, the running recording untouched', async () => {
    const s = scene(bot);
    await press(s, 'record:start');
    const old = { id: 'old', edits: [], async edit(p) { this.edits.push(p); } };
    const [i, done] = interact(s, 'record:stop:12345', { message: old });
    await done;
    assert.match(content(i.replies[0]), /จบไปแล้ว/);
    assert.deepEqual(old.edits[0].components, []);
    assert.ok(voice.has(s.guild.id));
  });
});

describe('permissions', () => {
  test('non-admin can open the panel but not record or open settings', async () => {
    const s = scene(bot, { admin: false });
    const [p, pd] = interact(s, 'panel:refresh');
    await pd;
    assert.equal(p.updates.length, 1);
    const [r, rd] = interact(s, 'record:start');
    await rd;
    assert.match(content(r.replies[0]), /🔒/);
    assert.equal(voice.size, 0);
    const [c, cd] = interact(s, 'config:open');
    await cd;
    assert.match(content(c.replies[0]), /ตั้งค่าได้เฉพาะผู้ดูแล/);
  });

  test('the recorder role may record', async () => {
    const s = scene(bot, { admin: false });
    await updateSettings(s.guild.id, { managerRole: 'R1' });
    s.member.roles.cache.set('R1', { id: 'R1' });
    await press(s, 'record:start');
    assert.ok(voice.has(s.guild.id));
  });

  test('bot without Send Messages here: told, nothing starts', async () => {
    const s = scene(bot);
    const [i, done] = interact(s, 'record:start', { appPerms: false });
    await done;
    assert.match(content(i.replies[0]), /🔒/);
    assert.equal(voice.size, 0);
  });
});

describe('manual browser capture (🎥 อัดจอฉัน)', () => {
  test('not in a voice room: a hint, no offer', async () => {
    const s = scene(bot, { inVoice: false });
    const [i, done] = interact(s, 'screen:me');
    await done;
    assert.match(content(i.replies[0]), /เข้าห้องเสียงก่อน/);
    assert.equal(screen.size, 0);
  });

  test('one private link; public card only when the page starts; stop → video + room audio', async () => {
    const s = scene(bot);
    const [i, done] = interact(s, 'screen:me');
    await done;
    assert.ok(isEphemeral(i.replies[0]));
    const comps = parts(i.replies[0]);
    assert.deepEqual(comps.map((c) => c.custom_id ?? 'url'), ['url', 'agent:install']); // the link + 📥 install
    assert.match(comps[0].url, /^http:\/\/localhost:1\/capture\//);
    const rec = screen.get(s.guild.id);
    assert.equal(rec.state, 'offered');
    assert.equal(s.text.sent.length, 0, 'nothing public yet');

    goLive(rec);
    await waitFor(() => s.text.sent.length === 1 && voice.has(s.guild.id) && rec.paired, 'live card + paired voice');
    await rec.cardQ;
    assert.match(content(lastEdit(s.text.sent[0])), /🔴/);
    assert.equal(voice.get(s.guild.id).channel, s.room);

    const [stop, stopped] = interact(s, `screen:stop:${rec.began}`, { message: rec.card });
    await stopped;
    const result = lastEdit(rec.card);
    assert.match(content(result), /^✅/);
    const labels = parts(result).map((c) => c.label);
    assert.ok(labels.some((l) => l.includes('วิดีโอ')) && !labels.some((l) => l.includes('ฟังเสียง')), labels.join()); // one file: audio is in the video
    assert.match(rec.result.url, /^https:\/\/drive\.google\.com\//);
    assert.equal(voice.size, 0);
    assert.equal(s.text.sent.length, 1, 'one card');
    assert.ok(stop.deferredUpdate);
  });
});

describe('auto browser offer (press-to-start: a share posts a card, a 🔴 press records)', () => {
  const autoScene = async () => {
    const s = scene(bot);
    await updateSettings(s.guild.id, { shareCards: true, minMembers: 2, minShareSeconds: 0, mode: 'browser' });
    const other = fakeMember(s.guild, { name: 'Other' });
    moveMember(other, { channel: s.room });
    return s;
  };

  test('a share → card pinging the sharer; 🔴 → the bot joins but records nothing; share ends unopened → nothing recorded (press-to-start)', async () => {
    const s = await autoScene();
    const g = s.guild.id;
    fire('voiceStateUpdate', ...moveMember(s.member, { streaming: true }));
    await waitFor(() => bot.roomCards.get(s.room.id)?.card, 'room card');
    const card = s.room.sent[0];
    assert.deepEqual(card.payload.allowedMentions.users, [s.member.id]);
    assert.equal(screen.size + voice.size, 0, 'a share alone records nothing');
    await pressRec(bot, s);
    await waitFor(() => screen.get(g)?.paired && voice.get(g) === screen.get(g).paired, 'session + room audio');
    const sess = screen.get(g);
    assert.equal(sess.card, card, 'the card became the recording');
    assert.equal(sess.cur.rec.state, 'offered');
    assert.equal(sess.paired.recording, false, 'joined, nothing recorded');

    fire('voiceStateUpdate', ...moveMember(s.member, { streaming: false }));
    await waitFor(() => !screen.has(g) && !voice.has(g) && /^⚪/.test(content(lastEdit(card))), 'ended');
    assert.match(content(lastEdit(card)), /^⚪ \*\*ไม่ได้อัด\*\* — ไม่มีภาพจอ/);
    assert.deepEqual(lastEdit(card).components, []);
    assert.equal(uploads.length, 0, 'no voice.mp3');
    assert.equal(s.room.sent.length, 1, 'one card');
  });

  test('screen gone while the bot was still joining: the voice does not keep running (press-to-start)', async () => {
    const s = await autoScene();
    const gate = deferred();
    FakeVoiceRecorder.startHook = () => gate.promise;
    fire('voiceStateUpdate', ...moveMember(s.member, { streaming: true }));
    const pressing = pressRec(bot, s); // held by the join: not awaited
    const g = s.guild.id;
    await waitFor(() => screen.get(g) && FakeVoiceRecorder.instances.length === 1, 'joining');
    fire('voiceStateUpdate', ...moveMember(s.member, { streaming: false }));
    await waitFor(() => !screen.has(g), 'session ended');
    gate.resolve();
    await pressing;
    await waitFor(() => FakeVoiceRecorder.instances[0].stopped && !voice.has(g), 'voice stopped');
  });
});

describe('panel', () => {
  test('fits Discord limits in every state', async () => {
    const s = scene(bot);
    assertDiscordLimits(bot.panel(s.guild), 'idle');
    assert.match(content(bot.panel(s.guild)), /ยังไม่ได้อัด/);
    await press(s, 'record:start');
    assertDiscordLimits(bot.panel(s.guild), 'voice');
    assert.ok(ids(bot.panel(s.guild)).includes('record:stop'));
    bot._reset();
    await press(s, 'screen:me');
    assertDiscordLimits(bot.panel(s.guild), 'private offer');
    goLive(screen.get(s.guild.id));
    await waitFor(() => screen.get(s.guild.id)?.paired, 'paired');
    assertDiscordLimits(bot.panel(s.guild), 'live paired');
    assert.ok(ids(bot.panel(s.guild)).includes('screen:stop'));
    await bot.screen.get(s.guild.id).cardQ;
  });
});

describe('nickname', () => {
  test('"<name> - 🔴 กำลังอัดเสียง" while recording, restored after', async () => {
    const s = scene(bot, { name: 'Somchai' });
    s.guild.members.me.nickname = 'Old Nick';
    await press(s, 'record:start');
    await waitFor(() => s.guild.members.me.nickname === 'Somchai - 🔴 กำลังอัดเสียง', 'nick set');
    const rec = voice.get(s.guild.id);
    await press(s, `record:stop:${rec.began}`, { message: rec.card });
    await waitFor(() => s.guild.members.me.nickname === 'Old Nick', 'nick restored');
  });
});

describe('delivery failures', () => {
  test('a result that can go nowhere is logged with its files', async () => {
    const s = scene(bot);
    const [i, done] = interact(s, 'record:start');
    await done;
    const rec = voice.get(s.guild.id);
    i.failEdit = true;
    s.text.failEdit = true;
    s.text.failSend = true;
    rec.interaction.createdTimestamp = 0; // too old to edit through the interaction
    await press(s, 'record:stop', { kind: 'slash', command: 'record', sub: 'stop' });
    await waitFor(() => logs.err.some((l) => l.includes('!!! ส่งผลการอัดไม่ได้')), '!!! log');
  });
});

describe('entry points', () => {
  test('@mention → a panel; remembered only for people who can record', async () => {
    const s = scene(bot);
    const mention = (member) => ({
      inGuild: () => true, author: member.user, guildId: s.guild.id, guild: s.guild, member, content: '<@bot> panel',
      reply: (p) => s.text.send(p),
    });
    await fire('messageCreate', mention(s.member));
    assert.equal(s.text.sent.length, 1);
    assert.match(content(s.text.sent[0].payload), /Recorder/);
    assert.equal(getSettings(s.guild.id).panels.length, 1);
    const guest = fakeMember(s.guild, { name: 'Guest' });
    await fire('messageCreate', mention(guest));
    assert.equal(s.text.sent.length, 2);
    assert.equal(getSettings(s.guild.id).panels.length, 1);
  });

  test('invited to a server: the quick setup is posted in the system channel', async () => {
    const s = scene(bot);
    s.guild.systemChannel = s.text;
    await fire('guildCreate', s.guild);
    assert.equal(s.text.sent.length, 1);
    assert.match(content(s.text.sent[0].payload), /สวัสดี/);
    assertDiscordLimits(s.text.sent[0].payload, 'intro');
  });
});

test('tmp cwd is used for recordings', () => assert.equal(process.cwd(), tmp));

// --- step 4: correctness fixes (each written failing first) -------------------------------------------

describe('fixes', () => {
  const autoScene = async (patch = {}) => {
    const s = scene(bot);
    await updateSettings(s.guild.id, { shareCards: true, minMembers: 2, minShareSeconds: 0, mode: 'browser', ...patch });
    moveMember(fakeMember(s.guild, { name: 'Other' }), { channel: s.room });
    return s;
  };
  const share = (s, on = true) => fire('voiceStateUpdate', ...moveMember(s.member, { streaming: on }));
  const withOffer = async (ms, fn) => { const old = T.offer; T.offer = ms; try { return await fn(); } finally { T.offer = old; } };

  test('R1: an auto offer nobody opens keeps recording the room (no 5-minute cut-off) (press-to-start)', () => withOffer(30, async () => {
    const s = await autoScene();
    const sess = await startSession(bot, s);
    const g = s.guild.id;
    await sleep(120);
    assert.ok(screen.get(g) === sess && voice.has(g) && sess.cur.rec.state === 'offered', 'still recording, link still open');
    assert.ok(!bot.cardSkip.get(g)?.has(s.member.id));
    share(s, false);
    await waitFor(() => !screen.has(g), 'ended by the share');
  }));

  test('R1: a manual (private) offer still expires', () => withOffer(30, async () => {
    const s = scene(bot);
    await press(s, 'screen:me');
    await waitFor(() => !screen.has(s.guild.id), 'expired');
  }));

  test('R2: the link card says prepare at once; "the bot is joining" until it is in the room', async () => {
    const s = await autoScene();
    const gate = deferred();
    FakeVoiceRecorder.startHook = () => gate.promise;
    share(s);
    const pressing = pressRec(bot, s);
    const g = s.guild.id;
    await waitFor(() => screen.get(g)?.cur && FakeVoiceRecorder.instances.length === 1, 'link accepted, joining');
    await screen.get(g).cardQ;
    const before = content(lastEdit(s.room.sent[0]));
    assert.match(before, /^⏳ \*\*เตรียมอัดในห้อง Meeting\*\*/);
    assert.match(before, /\n-# ⏳ บอทกำลังเข้าห้อง\.\.\./);
    gate.resolve();
    await pressing;
    await waitFor(() => screen.get(g)?.paired, 'paired');
    await screen.get(g).cardQ;
    const after = content(lastEdit(s.room.sent[0]));
    assert.match(after, /^⏳ \*\*เตรียมอัดในห้อง/);
    assert.doesNotMatch(after, /บอทกำลังเข้าห้อง/);
    share(s, false);
    await waitFor(() => !screen.has(g) && !voice.has(g), 'done');
  });

  test('R2: a failed join with only an unopened link: cancelled, the card says why (press-to-start)', async () => {
    const s = await autoScene();
    FakeVoiceRecorder.startHook = () => { throw new Error('join timeout'); };
    share(s);
    await pressRec(bot, s);
    const g = s.guild.id;
    // no room audio and no video yet: nothing records, the session is cancelled and the card says why
    await waitFor(() => !screen.has(g), 'cancelled');
    await waitFor(() => content(lastEdit(s.room.sent[0])) === '⚪ **ไม่ได้อัด** — ❌ บอทเข้าห้องเสียง **Meeting** ไม่ได้: join timeout', 'honest card');
    assert.deepEqual(lastEdit(s.room.sent[0]).components, []);
    assert.equal(voice.size, 0);
  });

  test('R3: a live-card render held up by a slow edit never lands after the result (press-to-start)', async () => {
    const s = await autoScene();
    const sess = await startSession(bot, s);
    const g = s.guild.id;
    const card = s.room.sent[0];
    const gate = deferred();
    card.editGate = () => { card.editGate = null; return gate.promise; }; // hold the next edit only
    goLive(sess.cur.rec);
    share(s, false); // finish while the live render is stuck
    await sleep(20);
    gate.resolve();
    await waitFor(() => !screen.has(g) && /^✅/.test(content(lastEdit(card))), 'result');
    const seq = card.edits.map((p) => [...content(p)][0]);
    assert.ok(seq.lastIndexOf('🔴') < seq.indexOf('⏳'), seq.join(' '));
  });

  test('R4: the link on an auto card is minted once and lives as long as the recording may (press-to-start)', async () => {
    const s = await autoScene({ maxMinutes: 120 });
    const sess = await startSession(bot, s);
    const g = s.guild.id;
    const card = s.room.sent[0];
    const urls = [card.payload, ...card.edits].map((p) => parts(p).find((c) => c.url)?.url).filter(Boolean);
    assert.ok(urls.length >= 2);
    assert.equal(new Set(urls).size, 1, 'same link on every render');
    const exp = parseInt(urls[0].split('/capture/')[1].split('.')[1], 36);
    assert.ok(exp - Date.now() > 119 * 60000);
    assert.equal(sess.cur.rec.cardLink, urls[0]);
    share(s, false);
    await waitFor(() => !screen.has(g), 'done');
  });

  test('R6: stopping the room audio of a screen recording stops both, on its one card', async () => {
    const s = scene(bot);
    await press(s, 'screen:me');
    const g = s.guild.id;
    const rec = screen.get(g);
    goLive(rec);
    await waitFor(() => rec.paired && rec.paired.notice, 'paired + notice in the room');
    const v = rec.paired;
    const [i, done] = interact(s, `record:stop:${v.began}`, { message: v.notice });
    await done;
    assert.match(content(i.replies[0]), /หยุดทั้งคู่/);
    await waitFor(() => /^✅/.test(content(lastEdit(rec.card))), 'result on the screen card');
    assert.equal(s.text.sent.length, 1);
    assert.equal(s.room.sent.length, 1, 'only the notice');
    assert.equal(voice.size + screen.size, 0);
  });

  test('R6: a voice that joined after its screen ended leaves no card behind (press-to-start)', async () => {
    const s = await autoScene();
    const gate = deferred();
    FakeVoiceRecorder.startHook = () => gate.promise;
    share(s);
    const pressing = pressRec(bot, s);
    const g = s.guild.id;
    await waitFor(() => FakeVoiceRecorder.instances.length === 1, 'joining');
    share(s, false);
    await waitFor(() => !screen.has(g), 'session ended');
    gate.resolve();
    await pressing;
    await waitFor(() => FakeVoiceRecorder.instances[0].stopped && !voice.has(g), 'voice stopped');
    await sleep(20);
    assert.equal(s.room.sent.length, 1, 'just the session card: no notice, no voice card');
    assert.equal(s.text.sent.length, 0);
  });

  test('R7: a page that goes live after its capture was dropped still gets a result', async () => {
    const s = scene(bot);
    await press(s, 'screen:me');
    const rec = screen.get(s.guild.id);
    screen.delete(s.guild.id);
    goLive(rec);
    await waitFor(() => rec.result, 'result');
    assert.deepEqual(rec.result, { url: null });
  });

  test('R8: nickFor fits 32 UTF-16 units and never cuts a Thai mark or an emoji', () => {
    assert.equal(bot.nickFor('สมชาย', 'กำลังอัดหน้าจอ'), 'สมชาย - 🔴 กำลังอัดหน้าจอ');
    const seg = (x) => [...new Intl.Segmenter('th', { granularity: 'grapheme' }).segment(x)].map((p) => p.segment);
    for (const name of ['😀'.repeat(20), 'ประยุทธ์จันทร์โอชาสุดยอดนักอัด', 'Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦']) {
      for (const st of ['กำลังอัดหน้าจอ', 'กำลังอัดเสียง']) {
        const n = bot.nickFor(name, st);
        assert.ok(n.length <= 32, `${n} is ${n.length}`);
        const head = n.slice(0, n.indexOf(' - 🔴'));
        const g = seg(head);
        assert.deepEqual(g, seg(name).slice(0, g.length), `${name} → ${head}`);
      }
    }
  });

  test('R8: a long emoji display name still gets a valid nickname', async () => {
    const s = scene(bot, { name: 'Somchai 😀😀😀😀😀😀😀' });
    await press(s, 'record:start');
    await waitFor(() => s.guild.members.me.nickname?.endsWith('กำลังอัดเสียง'), 'nick');
    assert.ok(s.guild.members.me.nickname.length <= 32);
  });

  test('R8: no Change Nickname permission is logged once per server, not on every change', async () => {
    const s = scene(bot);
    s.guild.members.me.failNick = true;
    for (let n = 0; n < 2; n++) {
      await press(s, 'record:start');
      const rec = voice.get(s.guild.id);
      await press(s, `record:stop:${rec.began}`, { message: rec.card });
    }
    await sleep(20);
    assert.equal(logs.err.filter((l) => l.includes('Change Nickname')).length, 1);
  });

  test('R8: the nickname from before a restart is put back', async () => {
    const s = scene(bot);
    s.guild.members.me.nickname = 'Old Nick';
    await press(s, 'record:start');
    await waitFor(() => s.guild.members.me.nickname?.includes('🔴'), 'tagged');
    bot._reset(); // the process "restarts": memory gone, settings kept
    await fire('clientReady', bot.client);
    await waitFor(() => s.guild.members.me.nickname === 'Old Nick', 'restored from settings');
    bot._reset();
  });

  test('R9: the bot dropped from the room ends a voice recording with a reason', async () => {
    const s = scene(bot);
    await press(s, 'record:start');
    const rec = voice.get(s.guild.id);
    rec.onGone();
    await waitFor(() => !voice.has(s.guild.id) && /^✅/.test(content(lastEdit(rec.card))), 'ended');
    assert.match(content(lastEdit(rec.card)), /บอทหลุดจากห้องเสียง/);
  });

  test('R9: dropped from the room during a screen recording: video goes on, a note on the result', async () => {
    const s = scene(bot);
    await press(s, 'screen:me');
    const rec = screen.get(s.guild.id);
    goLive(rec);
    await waitFor(() => rec.paired, 'paired');
    rec.paired.onGone();
    await sleep(20);
    assert.ok(screen.has(s.guild.id));
    await press(s, `screen:stop:${rec.began}`, { message: rec.card });
    await waitFor(() => /^✅/.test(content(lastEdit(rec.card))), 'result');
    assert.match(content(lastEdit(rec.card)), /หลุดจากห้องเสียงกลางทาง/);
    assert.match(uploads.at(-1), /^\d{4}-\d\d-\d\d \d\d\.\d\d .+\.\w+$/, 'audio until then is in the video');
  });

  test('R10: live cards are remembered, and a restart marks them stopped', async () => {
    const s = scene(bot);
    await press(s, 'record:start');
    const rec = voice.get(s.guild.id);
    await rec.cardQ;
    assert.deepEqual(getSettings(s.guild.id).cards, [[rec.card.channelId, rec.card.id]]);
    bot._reset();
    await fire('clientReady', bot.client);
    await waitFor(() => /บอทรีสตาร์ทระหว่างอัด/.test(content(lastEdit(rec.card))), 'restart note');
    assert.deepEqual(lastEdit(rec.card).components, []);
    await waitFor(() => getSettings(s.guild.id).cards.length === 0, 'list cleared');
    bot._reset();
  });

  test('R10: a finished recording is forgotten', async () => {
    const s = scene(bot);
    await press(s, 'record:start');
    const rec = voice.get(s.guild.id);
    await press(s, `record:stop:${rec.began}`, { message: rec.card });
    assert.deepEqual(getSettings(s.guild.id).cards, []);
  });

  test('R14: a failed join for a manual screen does not block auto voice in that room (press-to-start)', async () => {
    // no auto voice any more (D3): what must not be blocked is the next 🔴 in that room
    const s = await autoScene();
    FakeVoiceRecorder.startHook = () => { throw new Error('join timeout'); };
    await press(s, 'screen:me');
    const rec = screen.get(s.guild.id);
    goLive(rec);
    await waitFor(() => FakeVoiceRecorder.instances.length === 1, 'tried');
    await sleep(20);
    await press(s, `screen:stop:${rec.began}`, { message: rec.card });
    FakeVoiceRecorder.startHook = null;
    const sess = await startSession(bot, s);
    assert.equal(voice.get(s.guild.id), sess.paired, 'the room is recorded for the press');
  });
});

test('R1: the auto offer card no longer promises a 5-minute deadline (press-to-start)', async () => {
  const s = scene(bot);
  await updateSettings(s.guild.id, { shareCards: true, minMembers: 1, minShareSeconds: 0, mode: 'browser' });
  const sess = await startSession(bot, s);
  const text = content(lastEdit(s.room.sent[0]));
  assert.doesNotMatch(text, /<t:\d+:R>/);
  assert.match(text, /ยังไม่ได้อัดอะไร/);
  assert.doesNotMatch(text, /เสียงอย่างเดียว/);
  fire('voiceStateUpdate', ...moveMember(s.member, { streaming: false }));
  await waitFor(() => !screen.has(s.guild.id), 'done');
  void sess;
});

// --- step 5: copy and flow (U1-U18, U24) ---------------------------------------------------------------

describe('step 5', () => {
  const autoScene = async (patch = {}) => {
    const s = scene(bot);
    await updateSettings(s.guild.id, { shareCards: true, minMembers: 2, minShareSeconds: 0, mode: 'browser', ...patch });
    moveMember(fakeMember(s.guild, { name: 'Other' }), { channel: s.room });
    return s;
  };
  const share = (s, on = true) => fire('voiceStateUpdate', ...moveMember(s.member, { streaming: on }));
  const withOffer = async (ms, fn) => { const old = T.offer; T.offer = ms; try { return await fn(); } finally { T.offer = old; } };
  const button = (p, id) => parts(p).find((c) => (c.custom_id ?? '').startsWith(id));
  const SECONDARY = 2, DANGER = 4;

  test('U1/U2: the link card prepares from the start: the same grey cancel while joining and after (nothing records)', async () => {
    const s = await autoScene();
    const gate = deferred();
    FakeVoiceRecorder.startHook = () => gate.promise;
    share(s);
    const pressing = pressRec(bot, s);
    const g = s.guild.id;
    await waitFor(() => screen.get(g)?.cur && FakeVoiceRecorder.instances.length === 1, 'link accepted, joining');
    await screen.get(g).cardQ;
    const before = lastEdit(s.room.sent[0]);
    const lines = content(before).split('\n');
    assert.equal(lines[0], `⏳ **เตรียมอัดในห้อง Meeting** · <@${s.member.id}> กด 🎥 เพื่อเริ่มอัด`);
    assert.match(content(before), new RegExp(`ปุ่มนี้สำหรับ <@${s.member.id}> · ยังไม่ได้อัดอะไร`));
    const red0 = button(before, 'screen:stop');
    assert.equal(red0.style, SECONDARY, 'grey: nothing records yet');
    gate.resolve();
    await pressing;
    await waitFor(() => screen.get(g)?.paired, 'paired');
    await screen.get(g).cardQ;
    const after = lastEdit(s.room.sent[0]);
    assert.equal(content(after).split('\n')[0], lines[0]);
    const red = button(after, 'screen:stop');
    assert.equal(red.label, '✖️ ไม่อัด');
    assert.equal(red.style, SECONDARY);
    assert.equal(red.custom_id, red0.custom_id, 'same tagged customId');
    goLive(screen.get(g).cur.rec);
    await waitFor(() => button(lastEdit(s.room.sent[0]), 'screen:stop')?.style === DANGER, 'red once live');
    assert.equal(button(lastEdit(s.room.sent[0]), 'screen:stop').custom_id, red0.custom_id, 'still the same tag');
    assertDiscordLimits(before, 'offer joining');
    assertDiscordLimits(after, 'offer paired');
    share(s, false);
    await waitFor(() => !screen.has(g), 'done');
  });

  test('U3/U24: cards say "หยุดอัด"; live card copy per kind', async () => {
    const s = scene(bot);
    const [i, done] = interact(s, 'record:start');
    await done;
    const v = voice.get(s.guild.id);
    assert.equal(button(i.edits[0], 'record:stop').label, '⏹️ หยุดอัด');
    assert.equal(content(i.edits[0]).split('\n')[0], `🔴 **กำลังอัดเสียงในห้อง Meeting** · เริ่ม <t:${Math.floor(v.began / 1000)}:R>`);
    assert.match(content(i.edits[0]), /\n-# ทุกคนในห้องถูกอัดเสียงอยู่$/);
    bot._reset();
    await press(s, 'screen:me');
    const rec = screen.get(s.guild.id);
    goLive(rec);
    await waitFor(() => rec.paired && s.text.sent.length === 1, 'live + paired');
    await rec.cardQ;
    const live = lastEdit(s.text.sent[0]);
    assert.match(content(live), new RegExp(`^🔴 \\*\\*กำลังอัดจอของ <@${s.member.id}>\\*\\* ในห้อง \\*\\*Meeting\\*\\* · เริ่ม <t:\\d+:R>\\n-# บอทอัดเสียงทุกคนในห้องด้วย$`));
    assert.equal(button(live, 'screen:stop').label, '⏹️ หยุดอัด');
    await press(s, `screen:stop:${rec.began}`, { message: rec.card });
  });

  test('U4: screen result is one video (audio inside); voice result is 🎧 only', async () => {
    const s = scene(bot);
    await press(s, 'screen:me');
    const rec = screen.get(s.guild.id);
    goLive(rec);
    await waitFor(() => rec.paired, 'paired');
    await press(s, `screen:stop:${rec.began}`, { message: rec.card });
    assert.deepEqual(parts(lastEdit(rec.card)).map((c) => c.label), ['▶️ ดูวิดีโอ', '📁 ไฟล์ทั้งหมด']);
    await press(s, 'record:start');
    const v = voice.get(s.guild.id);
    await press(s, `record:stop:${v.began}`, { message: v.card });
    assert.deepEqual(parts(lastEdit(v.card)).map((c) => c.label), ['🎧 ฟังเสียง', '📁 ไฟล์ทั้งหมด']);
  });

  test('merged video is delivered first and is the Drive redirect; failure falls back with a note', async () => {
    const calls = [];
    const orig = bot.deps.mergeAudio;
    bot.deps.mergeAudio = async (...a) => { calls.push(a); return orig(...a); };
    try {
      for (const fail of [false, true]) {
        bot.deps.mergeFails = fail;
        uploads.length = 0;
        const s = scene(bot);
        await press(s, 'screen:me');
        const rec = screen.get(s.guild.id);
        goLive(rec);
        await waitFor(() => rec.paired, 'paired');
        await press(s, `screen:stop:${rec.began}`, { message: rec.card });
        const [v, a, off] = calls.at(-1);
        assert.match(v, /screen\.webm$/);
        assert.match(a, /voice\.mp3$/);
        assert.equal(off, rec.liveAt - rec.paired.startedAt);
        assert.equal(uploads.length, fail ? 2 : 1, `${uploads}`); // merged: one file; failed: silent video + audio
        assert.match(uploads[0], /^\d{4}-\d\d-\d\d \d\d\.\d\d .+\.webm$/, uploads[0]);
        if (fail) assert.ok(uploads[1].endsWith(' (เสียง).mp3'), uploads[1]);
        assert.equal(content(lastEdit(rec.card)).includes('รวมเสียงเข้าวิดีโอไม่สำเร็จ ส่งแยกไฟล์'), fail);
        assert.equal(rec.result.url, 'https://drive.google.com/file/d/1/view');
      }
    } finally { bot.deps.mergeAudio = orig; bot.deps.mergeFails = false; }
  });

  test('U5: 🌐 the private link reply is two short lines naming the room', async () => {
    const s = scene(bot);
    const [i, done] = interact(s, 'screen:link');
    await done;
    const lines = content(i.replies[0]).split('\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[0], '🎥 กดปุ่มด้านล่าง → เลือกจอ → กด **แชร์** แค่นั้น');
    assert.match(lines[1], /^-# บอทจะเข้าห้อง \*\*Meeting\*\* มาอัดเสียงด้วย · ใช้คอมพิวเตอร์ \(มือถืออัดจอไม่ได้\) · ลิงก์นี้ของคุณคนเดียว หมดอายุ <t:\d+:R>$/);
    assert.equal(parts(i.replies[0])[0].label, '🎥 เปิดหน้าอัดจอ');
  });

  test('U6: an unopened private offer: its ephemeral is edited to ⌛ on expiry, never the public card', () => withOffer(30, async () => {
    const s = scene(bot);
    const [i, done] = interact(s, 'screen:link');
    await done;
    const rec = screen.get(s.guild.id);
    assert.equal(rec.offerInteraction, i);
    assert.equal(rec.interaction, undefined, 'putCard must never edit the link reply into a card');
    await waitFor(() => !screen.has(s.guild.id) && i.edits.length, 'expired');
    assert.equal(content(i.edits.at(-1)), '⌛ ลิงก์หมดเวลาแล้ว กด 🌐 อัดผ่านเบราว์เซอร์ ใหม่ได้เลย');
    assert.deepEqual(i.edits.at(-1).components, []);
    assert.equal(s.text.sent.length, 0, 'no public trace');
  }));

  test('U6: cancelling a private offer edits the ephemeral too', async () => {
    const s = scene(bot);
    const [i, done] = interact(s, 'screen:me');
    await done;
    const rec = screen.get(s.guild.id);
    await press(s, `screen:stop:${rec.began}`);
    assert.equal(content(i.edits.at(-1)), '✖️ ยกเลิกการอัดจอแล้ว'); // cancelled, not "expired"
    assert.equal(s.text.sent.length, 0);
  });

  test('U7/U8: a private offer is not on the public panel; 🎙️ stays available', async () => {
    const s = scene(bot);
    await press(s, 'screen:me');
    const p = bot.panel(s.guild);
    assert.doesNotMatch(content(p), /🟡|รอ/);
    assert.match(content(p), /ยังไม่ได้อัด/);
    assert.ok(!ids(p).includes('screen:stop'), 'nobody else can cancel it');
    assert.deepEqual(ids(p).slice(0, 2), ['record:start', 'screen:me']);
    assertDiscordLimits(p, 'private offer');
  });

  test('U8: 🎙️ is offered next to a running screen recording whose room audio failed to join', async () => {
    const s = scene(bot);
    FakeVoiceRecorder.startHook = () => { throw new Error('join timeout'); };
    await press(s, 'screen:me');
    const rec = screen.get(s.guild.id);
    goLive(rec);
    await waitFor(() => FakeVoiceRecorder.instances.length === 1, 'join tried');
    await sleep(20);
    const p = bot.panel(s.guild);
    assert.deepEqual(ids(p).slice(0, 2), ['record:start', 'screen:stop']);
    assertDiscordLimits(p, 'screen without audio');
    await press(s, `screen:stop:${rec.began}`, { message: rec.card });
  });

  test('U3: the panel keeps the specific stop labels only when it shows two stops', async () => {
    const s = scene(bot);
    FakeVoiceRecorder.startHook = null;
    await press(s, 'record:start');
    assert.equal(button(bot.panel(s.guild), 'record:stop').label, '⏹️ หยุดอัด');
    // a voice recording next to an unpaired live screen recording: two stops
    const rec = Object.assign(new (await import('../src/browser-capture.js')).BrowserCapture('recordings/x', { guildId: s.guild.id, owner: s.member.id }),
      { textChannel: s.text, channelName: 'Meeting', guildId: s.guild.id, began: 1 });
    rec.state = 'live';
    screen.set(s.guild.id, rec);
    const p = bot.panel(s.guild);
    assert.equal(button(p, 'record:stop').label, '⏹️ หยุดอัดเสียง');
    assert.equal(button(p, 'screen:stop').label, '⏹️ หยุดอัดจอ');
    assertDiscordLimits(p, 'two stops');
    screen.delete(s.guild.id);
  });

  test('U9: a non-admin is told where to switch it on; ⚙️ and the toggle stay admin-only', async () => {
    const s = scene(bot, { admin: false });
    const [r, rd] = interact(s, 'record:start');
    await rd;
    assert.equal(content(r.replies[0]), '🔒 คุณยังกดอัดไม่ได้ — ให้ผู้ดูแล server เปิด ⚙️ ตั้งค่า → 👥 ทุกคนกดอัดได้');
    await updateSettings(s.guild.id, { managerRole: 'R7' });
    const [r2, rd2] = interact(s, 'record:start');
    await rd2;
    assert.match(content(r2.replies[0]), /หรือขอ role <@&R7>$/);
  });

  test('U16: anyoneRecords (config:who) lets a non-admin press 🎙️/🖥️/⏹️, never ⚙️ or the select', async () => {
    const s = scene(bot, { admin: false });
    const admin = fakeMember(s.guild, { name: 'Boss', admin: true });
    const [t, td] = interact({ ...s, member: admin }, 'config:who', { kind: 'select', values: ['all'] });
    await td;
    assert.equal(getSettings(s.guild.id).anyoneRecords, true);
    const view = t.updates[0];
    const who = view.components.map((x) => x.toJSON().components[0]).find((c) => c.custom_id === 'config:who');
    assert.equal(who.options.find((o) => o.default).value, 'all', 'the quick page is re-rendered with the choice');
    assertDiscordLimits(view, 'quick page, anyone on');
    // the guest can record
    await press(s, 'record:start');
    assert.ok(voice.has(s.guild.id), 'voice started');
    const rec = voice.get(s.guild.id);
    const [stop, sd] = interact(s, `record:stop:${rec.began}`, { message: rec.card });
    await sd;
    assert.equal(voice.size, 0);
    const [me, md] = interact(s, 'screen:me');
    await md;
    assert.ok(screen.has(s.guild.id), 'the 🎥 offer');
    // but not settings
    for (const id of ['config:open', 'config:anyone', 'config:auto', 'config:who']) {
      const [x, xd] = interact(s, id);
      await xd;
      assert.match(content(x.replies[0]), /ตั้งค่าได้เฉพาะผู้ดูแล/, id);
    }
    assert.equal(getSettings(s.guild.id).anyoneRecords, true);
    // the admin turns it off again
    const [, offd] = interact({ ...s, member: admin }, 'config:anyone'); // an old message's toggle still works
    await offd;
    assert.equal(getSettings(s.guild.id).anyoneRecords, false);
  });

  test('U16: @mention panels of anyone-records guests are remembered as recorders', async () => {
    const s = scene(bot);
    await updateSettings(s.guild.id, { anyoneRecords: true });
    const guest = fakeMember(s.guild, { name: 'Guest' });
    await fire('messageCreate', { inGuild: () => true, author: guest.user, guildId: s.guild.id, guild: s.guild, member: guest,
      content: '<@bot>', reply: (p) => s.text.send(p) });
    assert.equal(getSettings(s.guild.id).panels.length, 1);
  });

  test('U10: the bot cannot post here: plain Thai, no API names beyond the permissions to grant', async () => {
    const s = scene(bot);
    const [i, done] = interact(s, 'record:start', { appPerms: false });
    await done;
    assert.equal(content(i.replies[0]), '🔒 บอทส่งข้อความในห้องแชทนี้ไม่ได้ — กดจากห้องแชทอื่น หรือให้ผู้ดูแลให้สิทธิ์ Send Messages กับบอท');
  });

  test('U11: a room the bot cannot join is refused before anything starts', async () => {
    const s = scene(bot);
    s.room.joinable = false;
    for (const id of ['record:start', 'screen:me']) {
      const [i, done] = interact(s, id);
      await done;
      assert.equal(content(i.replies[0]), '🔒 บอทเข้าห้อง **Meeting** ไม่ได้ — ต้องให้บอทมีสิทธิ์ Connect ในห้องนั้น (หรือห้องเต็ม)', id);
      assert.ok(isEphemeral(i.replies[0]));
      assert.equal(i.deferred, false, 'no deferReply');
    }
    assert.equal(FakeVoiceRecorder.instances.length + voice.size + screen.size, 0);
  });

  test('U11: an AbortError from the join is mapped to the same text', async () => {
    const s = scene(bot);
    FakeVoiceRecorder.startHook = () => { throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }); };
    const [i, done] = interact(s, 'record:start');
    await done;
    assert.match(content(i.edits.at(-1)), /^🔒 บอทเข้าห้อง \*\*Meeting\*\* ไม่ได้ — ต้องให้บอทมีสิทธิ์ Connect/);
    assert.doesNotMatch(content(i.edits.at(-1)), /aborted/);
  });

  test('U12: already recording: names the room and links the screen card when the voice is paired', async () => {
    const s = scene(bot);
    await press(s, 'screen:me');
    const rec = screen.get(s.guild.id);
    goLive(rec);
    await waitFor(() => rec.paired && s.text.sent.length === 1, 'live + paired');
    await rec.cardQ;
    const [i, done] = interact(s, 'record:start');
    await done;
    assert.equal(content(i.replies[0]), `บอทกำลังอัดเสียงในห้อง **Meeting** อยู่แล้ว ${rec.card.url}`);
    await press(s, `screen:stop:${rec.began}`, { message: rec.card });
  });

  test('U13: the room notice says (อัตโนมัติ) only for automatic recordings; join errors name the room (press-to-start)', async () => {
    // nothing is automatic any more: every notice is the plain one; a session's join error lands on its card
    const s = scene(bot);
    await press(s, 'screen:me');
    const rec = screen.get(s.guild.id);
    goLive(rec);
    await waitFor(() => rec.paired?.notice, 'notice');
    assert.equal(content(rec.paired.notice.payload), '🔴 **ห้องนี้กำลังถูกอัดเสียง**');
    assert.equal(button(rec.paired.notice.payload, 'record:stop').label, '⏹️ หยุดอัด');
    await press(s, `screen:stop:${rec.began}`, { message: rec.card });
    bot._reset();
    resetFakes();

    const a = await autoScene();
    await updateSettings(a.guild.id, { notifyChannel: a.text.id }); // the card is elsewhere, so the room gets a notice
    const sess = await startSession(bot, a);
    await waitFor(() => sess.paired.notice, 'session notice');
    const notice = sess.paired.notice;
    assert.equal(content(notice.payload), '⏳ **บอทเข้าห้องนี้เพื่อเตรียมอัด** · ยังไม่ได้อัด เริ่มอัดเมื่อภาพจอขึ้น', 'prepare: nothing recorded yet');
    assert.deepEqual([button(notice.payload, 'record:stop').label, button(notice.payload, 'record:stop').style], ['✖️ ไม่อัด', SECONDARY]);
    assert.equal(sess.card.channelId, a.text.id, 'the card in the notify channel');
    goLive(sess.cur.rec);
    await waitFor(() => content(lastEdit(notice)) === '🔴 **ห้องนี้กำลังถูกอัดเสียง**', 'the notice says recording once the screen is live');
    assert.equal(button(lastEdit(notice), 'record:stop').style, DANGER);
    share(a, false);
    await waitFor(() => !screen.has(a.guild.id), 'done');
    bot._reset();
    resetFakes();

    const b = await autoScene();
    FakeVoiceRecorder.startHook = () => { throw new Error('join timeout'); };
    share(b);
    await pressRec(bot, b);
    await waitFor(() => content(lastEdit(b.room.sent[0])).includes('❌ บอทเข้าห้องเสียง **Meeting** ไม่ได้: join timeout'), 'error on the card');
    assert.equal(b.room.sent.length, 1, 'no separate error message');
  });

  test('U14: an auto offer that recorded nothing is deleted, not left as "cancelled" (press-to-start)', async () => {
    const s = await autoScene();
    share(s);
    const g = s.guild.id;
    await waitFor(() => bot.roomCards.get(s.room.id)?.card, 'room card');
    await bot.roomCards.get(s.room.id).cardQ;
    const card = s.room.sent[0];
    assert.deepEqual(getSettings(g).roomCards, [[card.channelId, card.id]]);
    assert.deepEqual(getSettings(g).cards ?? [], [], 'not a recording card');
    share(s, false);
    await waitFor(() => card.deleted, 'card deleted');
    assert.ok(!card.edits.some((p) => /ยกเลิก/.test(content(p))));
    await waitFor(() => getSettings(g).roomCards.length === 0, 'forgotten');
  });

  test('U14: falls back to the ⚪ edit when the card cannot be deleted (press-to-start)', async () => {
    const s = await autoScene();
    share(s);
    const g = s.guild.id;
    await waitFor(() => bot.roomCards.get(s.room.id)?.card, 'room card');
    await bot.roomCards.get(s.room.id).cardQ;
    const card = s.room.sent[0];
    card.delete = async () => { throw new Error('Missing Permissions'); };
    share(s, false);
    await waitFor(() => /⚪/.test(content(lastEdit(card))), 'no live 🔴 left');
    assert.deepEqual(lastEdit(card).components, []);
    assert.equal(screen.size, 0);
    void g;
  });

  test('U14: a pressed session that never had a screen keeps its card as ⚪ ไม่ได้อัด, no audio result (press-to-start)', async () => {
    const s = await autoScene();
    await startSession(bot, s);
    const g = s.guild.id;
    const card = s.room.sent[0];
    share(s, false);
    await waitFor(() => !screen.has(g) && /^⚪ \*\*ไม่ได้อัด\*\* — ไม่มีภาพจอ/.test(content(lastEdit(card))), 'nothing recorded');
    assert.equal(card.deleted, false);
    assert.equal(uploads.length, 0);
  });

  test('U15 (new quick page): one select per setting; an old config:cards toggle still flips the cards', async () => {
    const s = scene(bot);
    await updateSettings(s.guild.id, { mode: 'browser' });
    const [i, done] = interact(s, 'config:open');
    await done;
    assertDiscordLimits(i.replies[0], 'quick page');
    const sel = i.replies[0].components.map((x) => x.toJSON().components[0].custom_id);
    assert.deepEqual(sel.slice(0, 3), ['config:share', 'config:mode', 'config:who'], 'browser mode hides กรอบอัด');
    await updateSettings(s.guild.id, { mode: 'agent' });
    const [ia, da] = interact(s, 'config:open');
    await da;
    assert.deepEqual(ia.replies[0].components.slice(0, 4).map((x) => x.toJSON().components[0].custom_id), ['config:share', 'config:mode', 'config:area', 'config:who']);
    const before = getSettings(s.guild.id).shareCards;
    const [p, pd] = interact(s, 'config:cards');
    await pd;
    assert.equal(getSettings(s.guild.id).shareCards, !before);
    assertDiscordLimits(p.updates[0], 'quick page after the toggle');
  });

  test('U16 (new quick page): 🔧 and ✔️ on the last row; ✔️ shows the summary', async () => {
    const s = scene(bot);
    const [i, done] = interact(s, 'config:open');
    await done;
    const last = i.replies[0].components.at(-1).toJSON().components.map((c) => c.custom_id);
    assert.deepEqual(last, ['config:page-limits', 'config:done']);
    await updateSettings(s.guild.id, { anyoneRecords: true });
    const [d, dd] = interact(s, 'config:done');
    await dd;
    assert.match(content(d.updates[0]), /🔑 กดอัดได้: \*\*ทุกคน\*\*/);
  });

  test('U17: the greeting uses the bot\'s real mention', async () => {
    const s = scene(bot);
    s.guild.systemChannel = s.text;
    await fire('guildCreate', s.guild);
    const sent = s.text.sent[0].payload;
    assert.ok(content(sent).startsWith('👋 **สวัสดีครับ <@bot> พร้อมใช้แล้ว**\nเปิดแผงควบคุม: พิมพ์ <@bot> ในแชท หรือ /panel\n\n'));
    assert.deepEqual(sent.allowedMentions, { parse: [] });
  });

  describe('U18: Drive failures still deliver', () => {
    const record = async (s, big = false) => {
      await press(s, 'record:start');
      const rec = voice.get(s.guild.id);
      await rec.cardQ;
      if (big) {
        const real = rec.stop.bind(rec);
        rec.stop = async () => { const f = await real(); await truncate(f, 11 * 1024 * 1024); return f; };
      }
      await press(s, `record:stop:${rec.began}`, { message: rec.card });
      return lastEdit(rec.card);
    };
    test('invalid_grant: a small file is attached, with the readable note', async () => {
      bot.deps.uploadFails = Object.assign(new Error('invalid_grant'), { response: { data: { error: 'invalid_grant' } } });
      try {
        const out = await record(scene(bot));
        assert.match(content(out), /^✅/);
        assert.match(content(out), /⚠️ อัปขึ้น Google Drive ไม่ได้ \(การเชื่อม Drive หมดอายุ — ผู้ดูแลบอทต้องรัน npm run drive-auth ใหม่\)/);
        assert.doesNotMatch(content(out), /invalid_grant/);
        assert.equal(out.files.length, 1, 'the file is attached');
        assertDiscordLimits(out, 'drive failed');
      } finally { bot.deps.uploadFails = null; }
    });
    test('any other upload failure: attached, with the reason', async () => {
      bot.deps.uploadFails = new Error('quota exceeded');
      try {
        const out = await record(scene(bot));
        assert.equal(out.files.length, 1);
        assert.match(content(out), /อัปขึ้น Google Drive ไม่ได้ \(quota exceeded\)/);
      } finally { bot.deps.uploadFails = null; }
    });
    test('a file over 10 MB is not attached: its path is reported', async () => {
      bot.deps.uploadFails = Object.assign(new Error('invalid_grant'));
      try {
        const out = await record(scene(bot), true);
        assert.equal(out.files.length, 0);
        assert.match(content(out), /ไฟล์ใหญ่เกิน 10MB เก็บไว้ที่/);
        assert.match(content(out), /drive-auth/);
      } finally { bot.deps.uploadFails = null; }
    });
  });
});

describe('U20: a phone opens the link: nothing is recorded (audio only is 🎙️\'s alone)', () => {
  const autoScene = async () => {
    const s = scene(bot);
    await updateSettings(s.guild.id, { shareCards: true, minMembers: 2, minShareSeconds: 0, mode: 'browser' });
    moveMember(fakeMember(s.guild, { name: 'Other' }), { channel: s.room });
    return s;
  };
  // the HTTP side (POST /voice is gone: 404) is in capture.test.js; the page side in page.browser.js

  test('manual private link: no voice fallback, the bot never joins, the offer stays open for a computer', async () => {
    const s = scene(bot);
    const [i, done] = interact(s, 'screen:me');
    await done;
    const rec = screen.get(s.guild.id);
    assert.equal(rec.voiceOnly, undefined);
    assert.equal(rec.onVoiceOnly, undefined);
    assert.equal(rec.state, 'offered');
    assert.equal(voice.size + FakeVoiceRecorder.instances.length, 0, 'nothing joins or records');
    assert.equal(s.text.sent.length, 0, 'no public card');
    assert.equal(i.edits.length, 0);
    goLive(rec); // the same link from a computer
    await waitFor(() => s.text.sent.length === 1 && rec.paired, 'live from a computer, with the room audio');
    await press(s, `screen:stop:${rec.began}`, { message: rec.card });
    assert.match(content(lastEdit(rec.card)), /^✅/);
  });

  test('session card link: no voice fallback; the share ends unopened → nothing recorded, no voice.mp3 (press-to-start)', async () => {
    const s = await autoScene();
    const g = s.guild.id;
    const sess = await startSession(bot, s);
    const rec = sess.cur.rec, card = s.room.sent[0];
    assert.equal(rec.voiceOnly, undefined);
    assert.equal(rec.onVoiceOnly, undefined);
    assert.equal(sess.paired.recording, false);
    fire('voiceStateUpdate', ...moveMember(s.member, { streaming: false }));
    await waitFor(() => !screen.has(g) && !voice.has(g) && /^⚪/.test(content(lastEdit(card))), 'ended');
    assert.equal(uploads.length, 0);
    assert.ok(FakeVoiceRecorder.instances.every((v) => v.stopped && !v.recording));
  });
});

describe('review fixes', () => {
  const autoScene = async (patch = {}) => {
    const s = scene(bot);
    await updateSettings(s.guild.id, { shareCards: true, minMembers: 2, minShareSeconds: 0, mode: 'browser', ...patch });
    s.other = fakeMember(s.guild, { name: 'Other' });
    moveMember(s.other, { channel: s.room });
    return s;
  };
  const share = (s, on = true) => fire('voiceStateUpdate', ...moveMember(s.member, { streaming: on }));

  test('kicked from an auto "members" room: not restarted until the room empties (press-to-start)', async () => {
    // D3: no auto voice. A saved legacy autoVoice 'members' starts nothing when people gather; a kicked 🎙️
    // recording is not restarted either
    const s = scene(bot);
    const g = s.guild.id;
    await updateSettings(g, { autoVoice: 'members', minMembers: 2 });
    s.other = fakeMember(s.guild, { name: 'Other' });
    moveMember(s.other, { channel: s.room });
    fire('voiceStateUpdate', ...moveMember(s.member, { channel: s.room }));
    await sleep(40);
    assert.ok(!voice.has(g), 'people gathering record nothing');
    assert.equal(getSettings(g).autoVoice, 'off');
    await press(s, 'record:start');
    voice.get(g).onGone(); // kicked
    await waitFor(() => !voice.has(g), 'ended');
    fire('voiceStateUpdate', ...moveMember(fakeMember(s.guild, { name: 'C' }), { channel: s.room })); // the next sweep
    await sleep(60);
    assert.ok(!voice.has(g), 'not restarted');
    assert.equal(FakeVoiceRecorder.instances.length, 1);
  });

  test('a result whose Drive-failure notes are huge is clamped to 2000 and still lands', async () => {
    const s = scene(bot);
    const [, done] = interact(s, 'screen:me');
    await done;
    const rec = screen.get(s.guild.id);
    goLive(rec);
    await waitFor(() => rec.paired, 'paired');
    await rec.cardQ;
    bot.deps.uploadFails = new Error('x'.repeat(5000));
    try {
      await press(s, `screen:stop:${rec.began}`, { message: rec.card });
      const out = lastEdit(rec.card);
      assert.match(content(out), /^✅/);
      assert.ok(content(out).length <= 2000, `length ${content(out).length}`);
      assertDiscordLimits(out, 'huge notes');
    } finally { bot.deps.uploadFails = null; }
  });

  test('cancelling a private offer via /screen stop edits its link message to the cancelled note', async () => {
    const s = scene(bot);
    const [offer, done] = interact(s, 'screen:me');
    await done;
    await press(s, 'screen:stop', { kind: 'slash', command: 'screen', sub: 'stop' });
    await waitFor(() => offer.edits.length, 'link message edited');
    assert.equal(content(offer.edits.at(-1)), '✖️ ยกเลิกการอัดจอแล้ว');
    assert.equal(screen.size, 0);
  });

  test('markOrphanCards keeps a card remembered while its edits were running', async () => {
    const s = scene(bot);
    const g = s.guild.id;
    const old = await s.text.send({ content: '🔴' });
    await updateSettings(g, { cards: [[s.text.id, old.id]] });
    const gate = deferred(), edit = s.text.messages.edit;
    s.text.messages.edit = async (id, p) => { await gate.promise; return edit(id, p); };
    const ready = fire('clientReady', bot.client);
    await sleep(20);
    await updateSettings(g, { cards: [[s.text.id, 'fresh'], ...getSettings(g).cards] });
    gate.resolve();
    await ready;
    await waitFor(() => getSettings(g).cards.length === 1, 'old removed');
    assert.deepEqual(getSettings(g).cards, [[s.text.id, 'fresh']]);
    assert.match(content(lastEdit(old)), /บอทรีสตาร์ท/);
  });
});
