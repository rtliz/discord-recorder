import { tmp } from './helpers/env.js';
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { truncate } from 'node:fs/promises';
import { loadBot, waitFor, sleep, scene, resetFakes } from './helpers/bot.js';
import { fakeInteraction, fakeMember, moveMember, parts, ids, deferred, FakeVoiceRecorder } from './helpers/fakes.js';
import { assertDiscordLimits } from './helpers/limits.js';

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

beforeEach(() => { bot._reset(); bot.client.guilds.cache.clear(); resetFakes(); uploads.length = 0; logs.err.length = 0; }); // checkAuto sweeps every cached guild
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
    assert.equal(comps.length, 1);
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

describe('auto browser offer', () => {
  const autoScene = async () => {
    const s = scene(bot);
    await updateSettings(s.guild.id, { autoScreen: true, minMembers: 2, minShareSeconds: 0, mode: 'browser' });
    const other = fakeMember(s.guild, { name: 'Other' });
    moveMember(other, { channel: s.room });
    return s;
  };

  test('a share → card pinging the sharer + the bot records the room; share ends → audio-only result', async () => {
    const s = await autoScene();
    fire('voiceStateUpdate', ...moveMember(s.member, { streaming: true }));
    const g = s.guild.id;
    await waitFor(() => screen.get(g) && voice.get(g) && screen.get(g).paired === voice.get(g), 'offer + paired voice');
    const rec = screen.get(g);
    await rec.cardQ;
    const card = s.room.sent[0];
    assert.deepEqual(card.payload.allowedMentions.users, [s.member.id]);
    assert.equal(rec.state, 'offered');

    fire('voiceStateUpdate', ...moveMember(s.member, { streaming: false }));
    await waitFor(() => !screen.has(g) && !voice.has(g) && /^✅/.test(content(lastEdit(card))), 'audio result');
    assert.match(content(lastEdit(card)), /อัดเสียงในห้องเสร็จแล้ว/);
    assert.equal(s.room.sent.length, 1, 'one card');
  });

  test('screen gone while the bot was still joining: the voice does not keep running', async () => {
    const s = await autoScene();
    const gate = deferred();
    FakeVoiceRecorder.startHook = () => gate.promise;
    fire('voiceStateUpdate', ...moveMember(s.member, { streaming: true }));
    const g = s.guild.id;
    await waitFor(() => screen.get(g) && FakeVoiceRecorder.instances.length === 1, 'joining');
    fire('voiceStateUpdate', ...moveMember(s.member, { streaming: false }));
    await waitFor(() => !screen.has(g), 'offer ended');
    gate.resolve();
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
    await updateSettings(s.guild.id, { autoScreen: true, minMembers: 2, minShareSeconds: 0, mode: 'browser', ...patch });
    moveMember(fakeMember(s.guild, { name: 'Other' }), { channel: s.room });
    return s;
  };
  const share = (s, on = true) => fire('voiceStateUpdate', ...moveMember(s.member, { streaming: on }));
  const withOffer = async (ms, fn) => { const old = T.offer; T.offer = ms; try { return await fn(); } finally { T.offer = old; } };

  test('R1: an auto offer nobody opens keeps recording the room (no 5-minute cut-off)', () => withOffer(30, async () => {
    const s = await autoScene();
    share(s);
    const g = s.guild.id;
    await waitFor(() => screen.get(g)?.paired, 'paired');
    await sleep(120);
    assert.ok(screen.has(g) && voice.has(g), 'still recording');
    assert.ok(!bot.autoSkip.get(g)?.has(s.member.id));
    share(s, false);
    await waitFor(() => !screen.has(g), 'ended by the share');
  }));

  test('R1: a manual (private) offer still expires', () => withOffer(30, async () => {
    const s = scene(bot);
    await press(s, 'screen:me');
    await waitFor(() => !screen.has(s.guild.id), 'expired');
  }));

  test('R2: the offer card claims room audio only once the bot is in the room', async () => {
    const s = await autoScene();
    const gate = deferred();
    FakeVoiceRecorder.startHook = () => gate.promise;
    share(s);
    const g = s.guild.id;
    await waitFor(() => s.room.sent.length === 1, 'offer card');
    await screen.get(g).cardQ;
    assert.doesNotMatch(content(lastEdit(s.room.sent[0])), /กำลังอัดเสียง/);
    assert.match(content(lastEdit(s.room.sent[0])), /^🎥/);
    gate.resolve();
    await waitFor(() => screen.get(g)?.paired, 'paired');
    await screen.get(g).cardQ;
    assert.match(content(lastEdit(s.room.sent[0])), /^🔴 \*\*กำลังอัดเสียงในห้อง/);
    share(s, false);
    await waitFor(() => !screen.has(g) && !voice.has(g), 'done');
  });

  test('R2: a failed join leaves the card honest', async () => {
    const s = await autoScene();
    FakeVoiceRecorder.startHook = () => { throw new Error('join timeout'); };
    share(s);
    const g = s.guild.id;
    await waitFor(() => FakeVoiceRecorder.instances.length === 1, 'join tried');
    await sleep(30);
    await screen.get(g).cardQ;
    assert.match(content(lastEdit(s.room.sent[0])), /^🎥/);
    share(s, false);
    await waitFor(() => !screen.has(g), 'done');
  });

  test('R3: a live-card render held up by a slow edit never lands after the result', async () => {
    const s = await autoScene();
    share(s);
    const g = s.guild.id;
    await waitFor(() => screen.get(g)?.paired, 'paired');
    const rec = screen.get(g);
    await rec.cardQ;
    const card = s.room.sent[0];
    const gate = deferred();
    card.editGate = () => { card.editGate = null; return gate.promise; }; // hold the next edit only
    goLive(rec);
    share(s, false); // finish while the live render is stuck
    await sleep(20);
    gate.resolve();
    await waitFor(() => !screen.has(g) && /^✅/.test(content(lastEdit(card))), 'result');
    const seq = card.edits.map((p) => [...content(p)][0]);
    assert.ok(seq.lastIndexOf('🔴') < seq.indexOf('⏳'), seq.join(' '));
  });

  test('R4: the link on an auto card is minted once and lives as long as the recording may', async () => {
    const s = await autoScene({ maxMinutes: 120 });
    share(s);
    const g = s.guild.id;
    await waitFor(() => screen.get(g)?.paired, 'paired');
    await screen.get(g).cardQ;
    const card = s.room.sent[0];
    const urls = [card.payload, ...card.edits].map((p) => parts(p).find((c) => c.url)?.url).filter(Boolean);
    assert.ok(urls.length >= 2);
    assert.equal(new Set(urls).size, 1, 'same link on every render');
    const exp = parseInt(urls[0].split('/capture/')[1].split('.')[1], 36);
    assert.ok(exp - Date.now() > 119 * 60000);
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

  test('R6: a voice that joined after its screen ended leaves no card behind', async () => {
    const s = await autoScene();
    const gate = deferred();
    FakeVoiceRecorder.startHook = () => gate.promise;
    share(s);
    const g = s.guild.id;
    await waitFor(() => FakeVoiceRecorder.instances.length === 1, 'joining');
    share(s, false);
    await waitFor(() => !screen.has(g), 'offer ended');
    gate.resolve();
    await waitFor(() => FakeVoiceRecorder.instances[0].stopped && !voice.has(g), 'voice stopped');
    await sleep(20);
    assert.equal(s.room.sent.length, 1);
    assert.equal(s.room.sent[0].deleted, true, 'the notice is deleted, not edited to "stopped"');
    assert.equal(s.room.sent[0].edits.length, 0);
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
    assert.match(uploads.at(-1), /-with-audio\.\w+$/, 'audio until then is in the video');
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

  test('R14: a failed join for a manual screen does not block auto voice in that room', async () => {
    const s = scene(bot);
    FakeVoiceRecorder.startHook = () => { throw new Error('join timeout'); };
    await press(s, 'screen:me');
    const rec = screen.get(s.guild.id);
    goLive(rec);
    await waitFor(() => FakeVoiceRecorder.instances.length === 1, 'tried');
    await sleep(20);
    assert.ok(!bot.voiceSkip.get(s.guild.id)?.has(s.room.id));
    await press(s, `screen:stop:${rec.began}`, { message: rec.card });
  });
});

test('R1: the auto offer card no longer promises a 5-minute deadline', async () => {
  const s = scene(bot);
  await updateSettings(s.guild.id, { autoScreen: true, minMembers: 1, minShareSeconds: 0, mode: 'browser' });
  fire('voiceStateUpdate', ...moveMember(s.member, { streaming: true }));
  await waitFor(() => screen.get(s.guild.id)?.paired, 'paired');
  await screen.get(s.guild.id).cardQ;
  const text = content(lastEdit(s.room.sent[0]));
  assert.doesNotMatch(text, /<t:\d+:R>/);
  assert.match(text, /ไม่กดก็ได้เสียงอย่างเดียว/);
  fire('voiceStateUpdate', ...moveMember(s.member, { streaming: false }));
  await waitFor(() => !screen.has(s.guild.id), 'done');
});

// --- step 5: copy and flow (U1-U18, U24) ---------------------------------------------------------------

describe('step 5', () => {
  const autoScene = async (patch = {}) => {
    const s = scene(bot);
    await updateSettings(s.guild.id, { autoScreen: true, minMembers: 2, minShareSeconds: 0, mode: 'browser', ...patch });
    moveMember(fakeMember(s.guild, { name: 'Other' }), { channel: s.room });
    return s;
  };
  const share = (s, on = true) => fire('voiceStateUpdate', ...moveMember(s.member, { streaming: on }));
  const withOffer = async (ms, fn) => { const old = T.offer; T.offer = ms; try { return await fn(); } finally { T.offer = old; } };
  const button = (p, id) => parts(p).find((c) => (c.custom_id ?? '').startsWith(id));
  const SECONDARY = 2, DANGER = 4;

  test('U1/U2: offer card text and stop button follow whether the bot is in the room', async () => {
    const s = await autoScene();
    const gate = deferred();
    FakeVoiceRecorder.startHook = () => gate.promise;
    share(s);
    const g = s.guild.id;
    await waitFor(() => s.room.sent.length === 1, 'offer card');
    await screen.get(g).cardQ;
    const before = lastEdit(s.room.sent[0]);
    const lines = content(before).split('\n');
    assert.equal(lines[0], `🎥 <@${s.member.id}> แชร์จอใน **Meeting**`);
    assert.equal(lines[1], `🎥 <@${s.member.id}> กด **อัดจอของฉันด้วย** → เลือกจอ → กด **แชร์** เพื่ออัดภาพด้วย`);
    assert.equal(lines[2], '-# ปุ่มนี้สำหรับคนแชร์ · ไม่กดก็ได้เสียงอย่างเดียว');
    const grey = button(before, 'screen:stop');
    assert.equal(grey.label, '✖️ ไม่อัด');
    assert.equal(grey.style, SECONDARY);
    gate.resolve();
    await waitFor(() => screen.get(g)?.paired, 'paired');
    await screen.get(g).cardQ;
    const after = lastEdit(s.room.sent[0]);
    assert.equal(content(after).split('\n')[0], `🔴 **กำลังอัดเสียงในห้อง Meeting** — <@${s.member.id}> แชร์จออยู่`);
    const red = button(after, 'screen:stop');
    assert.equal(red.label, '⏹️ หยุดอัด');
    assert.equal(red.style, DANGER);
    assert.equal(red.custom_id, grey.custom_id, 'same tagged customId');
    assertDiscordLimits(before, 'offer unpaired');
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
        assert.ok(uploads[0].endsWith(fail ? '-screen.webm' : '-screen-with-audio.webm'), uploads[0]);
        if (fail) assert.ok(uploads[1].endsWith('-voice.mp3'), uploads[1]);
        assert.equal(content(lastEdit(rec.card)).includes('รวมเสียงเข้าวิดีโอไม่สำเร็จ ส่งแยกไฟล์'), fail);
        assert.equal(rec.result.url, 'https://drive.google.com/file/d/1/view');
      }
    } finally { bot.deps.mergeAudio = orig; bot.deps.mergeFails = false; }
  });

  test('U5: the private link reply is two short lines naming the room', async () => {
    const s = scene(bot);
    const [i, done] = interact(s, 'screen:me');
    await done;
    const lines = content(i.replies[0]).split('\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[0], '🎥 กดปุ่มด้านล่าง → เลือกจอ → กด **แชร์** แค่นั้น');
    assert.match(lines[1], /^-# บอทจะเข้าห้อง \*\*Meeting\*\* มาอัดเสียงด้วย · ใช้คอมพิวเตอร์ \(มือถืออัดได้แค่เสียง\) · ลิงก์นี้ของคุณคนเดียว หมดอายุ <t:\d+:R>$/);
    assert.equal(parts(i.replies[0])[0].label, '🎥 เปิดหน้าอัดจอ');
  });

  test('U6: an unopened private offer: its ephemeral is edited to ⌛ on expiry, never the public card', () => withOffer(30, async () => {
    const s = scene(bot);
    const [i, done] = interact(s, 'screen:me');
    await done;
    const rec = screen.get(s.guild.id);
    assert.equal(rec.offerInteraction, i);
    assert.equal(rec.interaction, undefined, 'putCard must never edit the link reply into a card');
    await waitFor(() => !screen.has(s.guild.id) && i.edits.length, 'expired');
    assert.equal(content(i.edits.at(-1)), '⌛ ลิงก์หมดเวลาแล้ว กด 🎥 อัดจอฉัน ใหม่ได้เลย');
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

  test('U16: anyoneRecords lets a non-admin press 🎙️/🎥/⏹️, never ⚙️ or the toggle', async () => {
    const s = scene(bot, { admin: false });
    const admin = fakeMember(s.guild, { name: 'Boss', admin: true });
    const [t, td] = interact({ ...s, member: admin }, 'config:anyone');
    await td;
    assert.equal(getSettings(s.guild.id).anyoneRecords, true);
    const view = t.updates[0];
    assert.equal(button(view, 'config:anyone').label, '👥 ทุกคนกดอัดได้');
    assert.match(content(view), /^⚡/, 'the quick page is re-rendered');
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
    for (const id of ['config:open', 'config:anyone', 'config:auto']) {
      const [x, xd] = interact(s, id);
      await xd;
      assert.match(content(x.replies[0]), /ตั้งค่าได้เฉพาะผู้ดูแล/, id);
    }
    assert.equal(getSettings(s.guild.id).anyoneRecords, true);
    // the admin turns it off again
    const [off, offd] = interact({ ...s, member: admin }, 'config:anyone');
    await offd;
    assert.equal(getSettings(s.guild.id).anyoneRecords, false);
    assert.equal(button(off.updates[0], 'config:anyone').label, '🔑 เฉพาะผู้ดูแลกดอัด');
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

  test('U13: the room notice says (อัตโนมัติ) only for automatic recordings; join errors name the room', async () => {
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
    share(a);
    await waitFor(() => screen.get(a.guild.id)?.paired?.notice, 'auto notice');
    assert.equal(content(screen.get(a.guild.id).paired.notice.payload), '🔴 **ห้องนี้กำลังถูกอัดเสียง** (อัตโนมัติ)');
    share(a, false);
    await waitFor(() => !screen.has(a.guild.id), 'done');
    bot._reset();
    resetFakes();

    const b = await autoScene();
    FakeVoiceRecorder.startHook = () => { throw new Error('join timeout'); };
    share(b);
    await waitFor(() => b.room.sent.some((m) => /ไม่ได้/.test(content(m.payload))), 'error posted');
    assert.ok(b.room.sent.some((m) => content(m.payload) === '❌ บอทเข้าห้องเสียง **Meeting** ไม่ได้: join timeout'));
    share(b, false);
    await waitFor(() => !screen.has(b.guild.id), 'done');
  });

  test('U14: an auto offer that recorded nothing is deleted, not left as "cancelled"', async () => {
    const s = await autoScene();
    FakeVoiceRecorder.startHook = () => { throw new Error('join timeout'); };
    share(s);
    const g = s.guild.id;
    await waitFor(() => FakeVoiceRecorder.instances.length === 1 && s.room.sent.length >= 1, 'offer + failed join');
    await screen.get(g).cardQ;
    const card = s.room.sent[0];
    assert.deepEqual(getSettings(g).cards, [[card.channelId, card.id]]);
    share(s, false);
    await waitFor(() => !screen.has(g), 'offer ended');
    await waitFor(() => card.deleted, 'card deleted');
    assert.ok(!card.edits.some((p) => /ยกเลิก/.test(content(p))));
    assert.deepEqual(getSettings(g).cards, [], 'forgotten');
  });

  test('U14: falls back to the ⚪ edit when the card cannot be deleted', async () => {
    const s = await autoScene();
    FakeVoiceRecorder.startHook = () => { throw new Error('join timeout'); };
    share(s);
    const g = s.guild.id;
    await waitFor(() => s.room.sent.length >= 1, 'offer');
    await screen.get(g).cardQ;
    const card = s.room.sent[0];
    card.delete = async () => { throw new Error('Missing Permissions'); };
    share(s, false);
    await waitFor(() => !screen.has(g) && /⚪/.test(content(lastEdit(card))), 'cancelled card');
  });

  test('U14: an offer with the room audio recorded keeps its (audio) result card', async () => {
    const s = await autoScene();
    share(s);
    const g = s.guild.id;
    await waitFor(() => screen.get(g)?.paired, 'paired');
    const card = s.room.sent[0];
    share(s, false);
    await waitFor(() => !screen.has(g) && /^✅/.test(content(lastEdit(card))), 'audio result');
    assert.equal(card.deleted, false);
  });

  test('U15: the "share" preset help in browser mode does not promise the bot records the screen', async () => {
    const s = scene(bot);
    await updateSettings(s.guild.id, { mode: 'browser' });
    const [i, done] = interact(s, 'config:open');
    await done;
    assert.match(content(i.replies[0]), /มีคนแชร์จอ บอทเข้าห้องอัดเสียง แล้วส่งปุ่มให้คนแชร์กดอัดจอ/);
    assert.doesNotMatch(content(i.replies[0]), /บอทอัดจอ \+ เสียงในห้องให้เอง/);
    assertDiscordLimits(i.replies[0], 'quick page');
    const [p, pd] = interact(s, 'config:preset-share');
    await pd;
    assert.equal(getSettings(s.guild.id).autoScreen, true);
    assert.match(content(p.updates[0]), /มีคนแชร์จอ บอทเข้าห้องอัดเสียง/);
    assertDiscordLimits(p.updates[0], 'quick page after preset');
  });

  test('U16: the quick page has the toggle (row 2) and the summary line', async () => {
    const s = scene(bot);
    const [i, done] = interact(s, 'config:open');
    await done;
    const row2 = i.replies[0].components[1].toJSON().components.map((c) => c.custom_id);
    assert.deepEqual(row2, ['config:page-main', 'config:anyone', 'config:done']);
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

describe('U20: phone opens the link (voice-only fallback)', () => {
  const autoScene = async () => {
    const s = scene(bot);
    await updateSettings(s.guild.id, { autoScreen: true, minMembers: 2, minShareSeconds: 0, mode: 'browser' });
    moveMember(fakeMember(s.guild, { name: 'Other' }), { channel: s.room });
    return s;
  };
  const offer = async (s) => {
    const [i, done] = interact(s, 'screen:me');
    await done;
    return [i, screen.get(s.guild.id)];
  };
  const rejects = (rec, status, error) => assert.rejects(rec.voiceOnly(tokenOf(rec)), (e) => {
    assert.equal(e.status, status);
    assert.deepEqual(e.body, { error });
    return true;
  });

  test('manual: one public voice card with the phone line, offer ended silently, ephemeral says 📱', async () => {
    const s = scene(bot);
    const g = s.guild.id;
    const [i, rec] = await offer(s);
    assert.deepEqual(await rec.voiceOnly(tokenOf(rec)), { ok: true, paired: false });
    const v = voice.get(g);
    assert.ok(v && v.by === s.member.id && v.channel === s.room);
    assert.equal(FakeVoiceRecorder.instances.length, 1);
    assert.equal(screen.size, 0);
    assert.equal(rec.state, 'done');
    assert.equal(s.text.sent.length, 1, 'one public card');
    const card = lastEdit(s.text.sent[0]);
    const lines = content(card).split('\n');
    assert.match(lines[0], /^🔴 \*\*กำลังอัดเสียงในห้อง Meeting\*\* · เริ่ม <t:\d+:R>$/);
    assert.equal(lines.at(-1), `-# <@${s.member.id}> เปิดลิงก์อัดจอจากมือถือ เลยอัดได้แค่เสียง`);
    assert.deepEqual(ids(card), [`record:stop:${v.began}`]);
    assert.deepEqual(card.allowedMentions, { parse: [] });
    assertDiscordLimits(card, 'phone voice card');
    assert.match(content(i.edits.at(-1)), /^📱 อุปกรณ์นี้อัดจอไม่ได้ — บอทอัดเสียงในห้องให้แทนแล้ว/);
    assert.ok(!i.edits.some((e) => /⌛/.test(content(e))), 'not the expiry text');
    assert.deepEqual(i.edits.at(-1).components, []);
    assert.match(content(bot.panel(s.guild)), /🔴 อัดเสียงในห้อง \*\*Meeting\*\*/);
    await press(s, `record:stop:${v.began}`, { message: v.card });
    assert.match(content(lastEdit(v.card)), /^✅ \*\*อัดเสียงในห้อง Meeting เสร็จแล้ว/);
    assert.equal(s.text.sent.length, 1);
  });

  test('manual while a voice recording already runs: paired, no second voice, offer ended', async () => {
    const s = scene(bot);
    const g = s.guild.id;
    await press(s, 'record:start');
    const [i, rec] = await offer(s);
    assert.deepEqual(await rec.voiceOnly(tokenOf(rec)), { ok: true, paired: true });
    assert.equal(FakeVoiceRecorder.instances.length, 1);
    assert.equal(screen.size, 0);
    assert.ok(voice.has(g));
    assert.match(content(i.edits.at(-1)), /^📱 อุปกรณ์นี้อัดจอไม่ได้ — บอทอัดเสียงในห้องอยู่แล้ว/);
  });

  test('owner not in voice -> 409 novoice; the offer stays open (a computer can still take it)', async () => {
    const s = scene(bot);
    const [i, rec] = await offer(s);
    moveMember(s.member, { channel: null });
    await rejects(rec, 409, 'novoice');
    assert.equal(screen.get(s.guild.id), rec);
    assert.equal(rec.state, 'offered');
    assert.equal(voice.size, 0);
    assert.equal(i.edits.length, 0);
    assert.equal(s.text.sent.length, 0);
    goLive(rec); // the computer (owner out of voice: video only)
    await waitFor(() => s.text.sent.length === 1, 'live from a computer');
    assert.equal(rec.state, 'live');
    await rec.cardQ;
  });

  test('room not joinable / join fails -> 409 voice; offer not finished, nothing left starting', async () => {
    const s = scene(bot);
    const g = s.guild.id;
    const [, rec] = await offer(s);
    s.room.joinable = false;
    await rejects(rec, 409, 'voice');
    assert.equal(FakeVoiceRecorder.instances.length, 0);
    assert.equal(screen.get(g), rec);
    assert.equal(rec.state, 'offered');

    s.room.joinable = true;
    bot._reset(); resetFakes();
    const [, rec2] = await offer(s);
    FakeVoiceRecorder.startHook = () => { throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }); };
    await rejects(rec2, 409, 'voice');
    assert.equal(voice.size, 0);
    assert.equal(screen.get(g), rec2);
    assert.equal(rec2.state, 'offered');
    assert.equal(s.text.sent.length, 0);
    FakeVoiceRecorder.startHook = null;
    await press(s, 'record:start'); // startingVoice was released
    assert.ok(voice.has(g));
  });

  test('auto offer already pairing the room: paired, no second voice, card untouched; share end → audio result', async () => {
    const s = await autoScene();
    const g = s.guild.id;
    fire('voiceStateUpdate', ...moveMember(s.member, { streaming: true }));
    await waitFor(() => screen.get(g)?.paired, 'paired');
    const rec = screen.get(g);
    await rec.cardQ;
    const card = s.room.sent[0];
    const edits = card.edits.length;
    assert.deepEqual(await rec.voiceOnly(tokenOf(rec)), { ok: true, paired: true });
    assert.equal(rec.state, 'voice');
    assert.equal(FakeVoiceRecorder.instances.length, 1);
    assert.equal(screen.get(g), rec);
    assert.equal(card.edits.length, edits);
    const p = bot.panel(s.guild);
    assert.match(content(p), /🔴 อัดเสียงในห้อง \*\*Meeting\*\*/);
    assert.doesNotMatch(content(p), /🟡|อัดจอของ/);
    assertDiscordLimits(p, 'auto phone');
    fire('voiceStateUpdate', ...moveMember(s.member, { streaming: false }));
    await waitFor(() => !screen.has(g) && !voice.has(g) && /^✅/.test(content(lastEdit(card))), 'audio result');
    assert.match(content(lastEdit(card)), /อัดเสียงในห้องเสร็จแล้ว/);
    assert.equal(s.room.sent.length, 1, 'one card');
  });

  test('auto offer whose bot is still joining: waits for the pair', async () => {
    const s = await autoScene();
    const g = s.guild.id;
    const gate = deferred();
    FakeVoiceRecorder.startHook = () => gate.promise;
    fire('voiceStateUpdate', ...moveMember(s.member, { streaming: true }));
    await waitFor(() => screen.get(g) && FakeVoiceRecorder.instances.length === 1, 'joining');
    const rec = screen.get(g);
    const res = rec.voiceOnly(tokenOf(rec));
    gate.resolve();
    assert.deepEqual(await res, { ok: true, paired: true });
    assert.equal(FakeVoiceRecorder.instances.length, 1);
    fire('voiceStateUpdate', ...moveMember(s.member, { streaming: false }));
    await waitFor(() => !screen.has(g) && !voice.has(g), 'done');
  });

  test('auto offer whose pair failed: 409 voice, offer stays', async () => {
    const s = await autoScene();
    const g = s.guild.id;
    FakeVoiceRecorder.startHook = () => { throw new Error('join timeout'); };
    fire('voiceStateUpdate', ...moveMember(s.member, { streaming: true }));
    await waitFor(() => screen.get(g) && FakeVoiceRecorder.instances.length === 1, 'join tried');
    const rec = screen.get(g);
    await rec.pairing;
    await rejects(rec, 409, 'voice');
    assert.equal(rec.state, 'offered');
    assert.equal(FakeVoiceRecorder.instances.length, 1, 'no retry');
    fire('voiceStateUpdate', ...moveMember(s.member, { streaming: false }));
    await waitFor(() => !screen.has(g), 'done');
  });
});

describe('review fixes', () => {
  const autoScene = async (patch = {}) => {
    const s = scene(bot);
    await updateSettings(s.guild.id, { autoScreen: true, minMembers: 2, minShareSeconds: 0, mode: 'browser', ...patch });
    s.other = fakeMember(s.guild, { name: 'Other' });
    moveMember(s.other, { channel: s.room });
    return s;
  };
  const share = (s, on = true) => fire('voiceStateUpdate', ...moveMember(s.member, { streaming: on }));

  test('kicked from an auto "members" room: not restarted until the room empties', async () => {
    const s = scene(bot);
    const g = s.guild.id;
    await updateSettings(g, { autoVoice: 'members', minMembers: 2 });
    s.other = fakeMember(s.guild, { name: 'Other' });
    moveMember(s.other, { channel: s.room });
    fire('voiceStateUpdate', ...moveMember(s.member, { channel: s.room }));
    await waitFor(() => voice.has(g), 'auto voice');
    voice.get(g).onGone(); // kicked
    await waitFor(() => !voice.has(g) && s.text.sent.length + s.room.sent.length > 0, 'ended');
    fire('voiceStateUpdate', ...moveMember(fakeMember(s.guild, { name: 'C' }), { channel: s.room })); // the next sweep
    await sleep(60);
    assert.ok(!voice.has(g), 'not restarted');
    assert.equal(FakeVoiceRecorder.instances.length, 1);
    for (const m of [s.member, s.other, ...s.room.members.values()]) moveMember(m, { channel: null }); // room empties: re-armed
    fire('voiceStateUpdate', ...moveMember(fakeMember(s.guild, { name: 'D' }), { channel: null }));
    await sleep(30);
    assert.ok(!bot.voiceSkip.get(g)?.has(s.room.id), 'room re-armed');
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

  test('auto offer used by the phone fallback: no dead 🎥 link or hint on the card', async () => {
    const s = await autoScene();
    share(s);
    const g = s.guild.id;
    await waitFor(() => screen.get(g)?.paired, 'paired');
    const rec = screen.get(g);
    assert.ok(parts(bot.liveCard(rec)).some((c) => c.url), 'link before');
    assert.deepEqual(await rec.voiceOnly(tokenOf(rec)), { ok: true, paired: true });
    const card = bot.liveCard(rec);
    assert.ok(!parts(card).some((c) => c.url), 'no link');
    assert.doesNotMatch(content(card), /กด \*\*อัดจอของฉันด้วย/);
    assert.match(content(card), /กำลังอัดเสียงในห้อง/);
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
