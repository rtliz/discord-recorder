import './helpers/env.js';
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { loadBot, waitFor, sleep, scene, resetFakes } from './helpers/bot.js';
import { fakeInteraction, fakeMember, moveMember, parts, ids, FakeVoiceRecorder } from './helpers/fakes.js';
import { assertDiscordLimits } from './helpers/limits.js';

// /agent and the manual 🎥 อัดจอฉัน on the presser's own agent (plan B2, §9 cases 4, 5, 18), FakeAgentHub, no Discord

const { bot, logs, uploads, fire, agents, composed } = await loadBot({ SCREEN_ENABLED: 'false', PUBLIC_URL: 'http://localhost:1' });
const { T } = await import('../src/browser-capture.js');
const { updateSettings } = await import('../src/settings.js');
Object.assign(T, { drainMax: 50, silent: 50, poll: 5 });

const { voice, screen } = bot;
const content = (p) => p?.content ?? '';
const lastOf = (m) => m.edits.at(-1) ?? m.payload;
const isEphemeral = (p) => Boolean(p?.flags & MessageFlags.Ephemeral);
const tokenOf = (rec) => rec.link().split('/capture/')[1];
const labels = (p) => parts(p).map((c) => c.label);
const interact = (s, customId, extra = {}) => {
  const i = fakeInteraction({ guild: s.guild, member: s.member, channel: s.text, customId, ...extra });
  return [i, fire('interactionCreate', i)];
};
const press = async (s, customId, extra) => { const [i, done] = interact(s, customId, extra); await done; return i; };
// a server with the presser (admin, Alice) and Bob in the room: leaving doesn't empty it
const manualScene = async () => {
  const s = scene(bot, { name: 'Alice' });
  await updateSettings(s.guild.id, { mode: 'agent' });
  s.b = fakeMember(s.guild, { name: 'Bob' });
  moveMember(s.b, { channel: s.room });
  return s;
};
const live = async (s) => { // the manual session has gone live: card posted, room joined
  const g = s.guild.id;
  const sess = await waitFor(() => screen.get(g)?.kind === 'session' && screen.get(g).cur && voice.get(g) && screen.get(g), 'manual session live');
  await sess.cardQ;
  return sess;
};
const resultOf = async (s, sess) => {
  await waitFor(() => !screen.has(s.guild.id) && !voice.has(s.guild.id) && /^[✅❌⚪]/.test(content(lastOf(sess.card))), 'result');
  await sleep(30);
  return lastOf(sess.card);
};

beforeEach(() => {
  bot._reset(); bot.client.guilds.cache.clear(); resetFakes();
  uploads.length = 0; logs.err.length = 0; logs.out.length = 0; composed.calls.length = 0;
});
after(() => bot._reset());

describe('/agent (case 18)', () => {
  test('is registered when PUBLIC_URL is set, with no default permission', () => {
    const c = bot.commands.find((x) => x.name === 'agent');
    assert.ok(c);
    assert.equal(c.default_member_permissions ?? null, null);
  });

  test('ephemeral: both one-liners with one token, the code, expiry, guidance; fits Discord limits', async () => {
    const s = scene(bot, { admin: false }); // anyone, no recorder role needed
    const i = await press(s, undefined, { kind: 'slash', command: 'agent' });
    const p = i.replies[0];
    assert.ok(isEphemeral(p));
    const pairing = agents.pairings.at(-1);
    assert.equal(pairing.userId, s.member.id);
    assert.equal(pairing.guildId, s.guild.id);
    assert.match(pairing.token, /^[A-Za-z0-9_-]+$/);
    assert.ok(content(p).includes(`curl -fsSL http://localhost:1/agent/install.sh | DRA_TOKEN=${pairing.token} sh`));
    assert.ok(content(p).includes(`$env:DRA_TOKEN='${pairing.token}'; irm http://localhost:1/agent/install.ps1 | iex`));
    const c = content(p);
    // macOS / Linux first, all its commands, then Windows; one box per command
    const mac = c.indexOf('### 🍎 macOS / Linux — วางใน Terminal'), win = c.indexOf('### 🪟 Windows — วางใน PowerShell');
    assert.ok(mac >= 0 && win > mac, 'mac section before windows');
    const box = (lang, x) => `\`\`\`${lang}\n${x}\n\`\`\``;
    const at = (x) => c.indexOf(x);
    const macIdx = [box('sh', `curl -fsSL http://localhost:1/agent/install.sh | DRA_TOKEN=${pairing.token} sh`), box('sh', '~/.discord-recorder-agent/start.command'), box('sh', '~/.discord-recorder-agent/uninstall.command')].map(at);
    const winIdx = [box('powershell', `$env:DRA_TOKEN='${pairing.token}'; irm http://localhost:1/agent/install.ps1 | iex`), box('powershell', '& "$HOME\\.discord-recorder-agent\\start.cmd"'), box('powershell', '& "$HOME\\.discord-recorder-agent\\uninstall.cmd"')].map(at);
    assert.ok(macIdx.every((x, k) => x > mac && x < win && (k === 0 || x > macIdx[k - 1])), 'mac: install, start, uninstall in order');
    assert.ok(winIdx.every((x, k) => x > win && (k === 0 || x > winIdx[k - 1])), 'windows: install, start, uninstall in order');
    assert.match(c, /-# คำสั่งติดตั้งใช้ได้ครั้งเดียวถึง <t:\d+:t> \(10 นาที\)/); // a clock time: a relative one reads "1 second ago" once passed
    assert.ok(c.includes(`**🔗 เชื่อมใหม่** (ถ้าตัวอัดขึ้นว่าถูกยกเลิกการเชื่อมต่อ) เปิดตัวอัดแล้วใส่รหัส 6 หลักนี้\n${box('', pairing.code)}`), 'the 6-digit code, boxed');
    assert.doesNotMatch(c, /Screen Recording|มือถือ|ปิดของส่วนตัว/);
    assert.equal((c.match(/```/g) ?? []).length, 14, '6 command boxes + the code');
    assert.match(content(p), /ยังไม่มีเครื่องที่ติดตั้ง/);
    assert.deepEqual(p.components ?? [], []);
    assertDiscordLimits(p, '/agent');
    assert.ok(!logs.out.join('\n').includes(pairing.token) && !logs.err.join('\n').includes(pairing.token), 'the token is never logged');
  });

  test('no code shown when code pairing is off', async () => {
    const s = scene(bot);
    const orig = agents.newPairing.bind(agents);
    agents.newPairing = (...a) => ({ ...orig(...a), code: null });
    const i = await press(s, undefined, { kind: 'slash', command: 'agent' });
    delete agents.newPairing;
    assert.ok(!/รหัส 6 หลัก/.test(content(i.replies[0])));
    assert.match(content(i.replies[0]), /-# 🔗 เชื่อมใหม่ \(ถ้าตัวอัดขึ้นว่าถูกยกเลิกการเชื่อมต่อ\): พิมพ์ \/agent แล้ววางคำสั่งติดตั้งอีกครั้ง/);
  });

  test('📥 ติดตั้งตัวอัด button: anyone gets the /agent install reply, only they see it', async () => {
    const s = scene(bot);
    const guest = fakeMember(s.guild, { name: 'Guest', admin: false });
    const i = await press(s, 'agent:install', { member: guest });
    assert.ok(isEphemeral(i.replies[0]));
    assert.match(content(i.replies[0]), /install\.sh \| DRA_TOKEN=[A-Za-z0-9_-]+ sh/);
    assert.equal(agents.pairings.at(-1).userId, guest.id);
    assertDiscordLimits(i.replies[0]);
  });

  test('📥 sits on the panel', async () => {
    const s = scene(bot);
    const panel = await press(s, undefined, { kind: 'slash', command: 'panel' });
    assert.ok(ids(panel.replies[0] ?? panel.deferred).includes('agent:install'), 'panel');
  });

  test('a new /agent replaces the previous pairing', async () => {
    const s = scene(bot);
    await press(s, undefined, { kind: 'slash', command: 'agent' });
    await press(s, undefined, { kind: 'slash', command: 'agent' });
    assert.equal(agents.pairings.length, 1);
  });

  test('device list with revoke buttons (max 4 + all), fits limits', async () => {
    const s = scene(bot);
    for (const n of ['MacBook', 'Desktop', 'Work', 'Old', 'Fifth']) agents.addDevice(s.member.id, { name: n });
    agents.setOnline(s.member.id, { deviceId: agents.devices(s.member.id).find((d) => d.name === 'Desktop').deviceId });
    const i = await press(s, undefined, { kind: 'slash', command: 'agent' });
    const p = i.replies[0];
    assert.match(content(p), /🟢 ออนไลน์ · Desktop/);
    assert.match(content(p), /⚪ ออฟไลน์/);
    assert.match(content(p), /แสดง 4 จาก 5 เครื่อง/);
    const cs = parts(p);
    assert.equal(cs.length, 5);
    assert.equal(cs.at(-1).custom_id, 'agent:revoke:all');
    assert.ok(cs.slice(0, 4).every((c) => c.custom_id.startsWith('agent:revoke:') && c.label.startsWith('🗑️')));
    assertDiscordLimits(p, '/agent devices');
  });

  test('🗑️ revokes your own device and refreshes the list without a new token', async () => {
    const s = scene(bot);
    const d = agents.addDevice(s.member.id, { name: 'Mine' });
    const i = await press(s, `agent:revoke:${d.deviceId}`);
    assert.deepEqual(agents.revoked, [[s.member.id, d.deviceId, 1]]);
    assert.equal(i.updates.length, 1);
    assert.match(content(i.updates[0]), /ลบแล้ว 1 เครื่อง/);
    assert.ok(!/curl/.test(content(i.updates[0])), 'no install command on the refreshed list');
    assert.equal(agents.pairings.length, 0, 'viewing does not mint a pairing');
    assertDiscordLimits(i.updates[0], 'revoked');
  });

  test('revoking someone else\'s device is refused', async () => {
    const s = scene(bot);
    const other = fakeMember(s.guild, { name: 'Other' });
    const d = agents.addDevice(other.id, { name: 'Theirs' });
    const i = await press(s, `agent:revoke:${d.deviceId}`);
    assert.match(content(i.replies[0]), /ไม่พบเครื่องนี้/);
    assert.ok(isEphemeral(i.replies[0]));
    assert.deepEqual(agents.revoked, []);
    assert.equal(agents.devices(other.id).length, 1);
  });

  test('🗑️ ทั้งหมด revokes only the caller\'s devices', async () => {
    const s = scene(bot);
    const other = fakeMember(s.guild, { name: 'Other' });
    agents.addDevice(other.id); agents.addDevice(s.member.id); agents.addDevice(s.member.id);
    await press(s, 'agent:revoke:all');
    assert.deepEqual(agents.revoked, [[s.member.id, 'all', 2]]);
    assert.equal(agents.devices(other.id).length, 1);
  });
});

describe('/agent for a server admin: every member\'s recorder agent in scope', () => {
  const view = (s, member = s.member) => press(s, undefined, { kind: 'slash', command: 'agent', member });
  const section = (p) => content(p).split('**ตัวอัดใน server นี้**')[1];

  test('an admin sees another member\'s device (paired here) and revokes it; the owner is told revoked, the log names both', async () => {
    const s = scene(bot, { name: 'Admin' });
    const bob = fakeMember(s.guild, { name: 'Bob' });
    bot.client.users.cache.set(s.member.id, { id: s.member.id, tag: 'Admin#1' });
    bot.client.users.cache.set(bob.id, { id: bob.id, tag: 'Bob#2' });
    agents.addDevice(s.member.id, { name: 'AdminMac', guildId: s.guild.id });
    const d = agents.addDevice(bob.id, { name: 'BobPC', os: 'win32', guildId: s.guild.id });
    agents.setOnline(bob.id, { deviceId: d.deviceId });
    const i = await view(s);
    const p = i.replies[0];
    assert.ok(isEphemeral(p));
    assert.ok(content(p).indexOf('**เครื่องของคุณ**') < content(p).indexOf('**ตัวอัดใน server นี้**'), 'after เครื่องของคุณ');
    assert.match(section(p), new RegExp(`🟢 · <@${bob.id}> · BobPC \\(win32\\) · เห็นล่าสุด <t:\\d+:R>`));
    assert.doesNotMatch(section(p), /AdminMac/, 'their own devices stay in เครื่องของคุณ');
    assert.ok(ids(p).includes(`agent:kick:${d.deviceId}`) && ids(p).includes(`agent:revoke:${agents.devices(s.member.id)[0].deviceId}`));
    assert.deepEqual(p.allowedMentions, { parse: [] }, 'mentions never ping');
    assertDiscordLimits(p, '/agent admin');
    const minted = agents.pairings.length;
    const k = await press(s, `agent:kick:${d.deviceId}`);
    assert.deepEqual(agents.kicked, [[d.deviceId, bob.id]]);
    assert.equal(agents.online(bob.id), null, 'its live session ends (revoked)');
    assert.deepEqual(agents.devices(bob.id), []);
    assert.match(content(k.updates[0]), new RegExp(`ลบตัวอัด \\*\\*BobPC\\*\\* ของ <@${bob.id}> แล้ว`));
    assert.match(content(k.updates[0]), /ไม่มีตัวอัดของคนอื่นใน server นี้/);
    assertDiscordLimits(k.updates[0], 'kicked');
    assert.ok(logs.out.some((l) => l.includes('🗑️ Admin#1 ลบตัวอัดของ Bob#2 (BobPC)')), logs.out.join('\n'));
    assert.equal(agents.pairings.length, minted, 'no new token on the refreshed view');
  });

  test('a non-admin sees no server section, and a forged agent:kick is refused with nothing changed', async () => {
    const s = scene(bot, { name: 'Admin' });
    const guest = fakeMember(s.guild, { name: 'Guest', admin: false });
    const d = agents.addDevice(s.member.id, { name: 'AdminMac', guildId: s.guild.id });
    const v = await view(s, guest);
    assert.doesNotMatch(content(v.replies[0]), /ตัวอัดใน server นี้/);
    assert.ok(!ids(v.replies[0]).some((x) => x.startsWith('agent:kick:')));
    const i = await press(s, `agent:kick:${d.deviceId}`, { member: guest });
    assert.ok(isEphemeral(i.replies[0]));
    assert.match(content(i.replies[0]), /เฉพาะผู้ดูแล server/);
    assert.deepEqual(agents.kicked, []);
    assert.equal(agents.devices(s.member.id).length, 1);
  });

  test('out of scope: paired from another server, or an old record of a non-member, is neither listed nor revocable', async () => {
    const s = scene(bot, { name: 'Admin' });
    const bob = fakeMember(s.guild, { name: 'Bob' });
    const elsewhere = agents.addDevice(bob.id, { name: 'PairedElsewhere', guildId: 'other-guild' }); // Bob is a member, still out
    const stranger = agents.addDevice('stranger-id', { name: 'OldStranger' }); // no guildId, not a member
    const legacy = agents.addDevice(bob.id, { name: 'OldBob' }); // no guildId, Bob is a member: in scope
    const p = (await view(s)).replies[0];
    assert.doesNotMatch(section(p), /PairedElsewhere|OldStranger/);
    assert.match(section(p), /OldBob/);
    for (const d of [elsewhere, stranger]) {
      const i = await press(s, `agent:kick:${d.deviceId}`);
      assert.match(content(i.replies[0]), /ไม่พบเครื่องนี้ใน server นี้/);
      assert.ok(isEphemeral(i.replies[0]));
    }
    await press(s, 'agent:kick:no-such-device');
    assert.deepEqual(agents.kicked, []);
    await press(s, `agent:kick:${legacy.deviceId}`);
    assert.deepEqual(agents.kicked, [[legacy.deviceId, bob.id]]);
  });

  test('an old record whose owner is not cached: one members.fetch decides', async () => {
    const s = scene(bot, { name: 'Admin' });
    const d = agents.addDevice('fetched-id', { name: 'Fetched' });
    const asked = [];
    s.guild.members.fetch = async (u) => { asked.push(u); return u === 'fetched-id' ? { id: u } : Promise.reject(new Error('Unknown Member')); };
    agents.addDevice('gone-id', { name: 'LeftServer' });
    const p = (await view(s)).replies[0];
    assert.match(section(p), /Fetched/);
    assert.doesNotMatch(section(p), /LeftServer/);
    assert.deepEqual(asked.sort(), ['fetched-id', 'gone-id']);
    await press(s, `agent:kick:${d.deviceId}`);
    assert.deepEqual(agents.kicked, [[d.deviceId, 'fetched-id']]);
  });

  test('the owner\'s own 🗑️ is unchanged for an admin too', async () => {
    const s = scene(bot, { name: 'Admin' });
    const mine = agents.addDevice(s.member.id, { name: 'Mine', guildId: s.guild.id });
    const i = await press(s, `agent:revoke:${mine.deviceId}`);
    assert.deepEqual(agents.revoked, [[s.member.id, mine.deviceId, 1]]);
    assert.deepEqual(agents.kicked, []);
    assert.match(content(i.updates[0]), /ลบแล้ว 1 เครื่อง/);
  });

  test('many devices: newest first, within 5 rows / 5 buttons / 2000 characters, with แสดง N จาก M', async () => {
    const s = scene(bot, { name: 'Admin' });
    for (let k = 0; k < 6; k++) agents.addDevice(s.member.id, { name: `Mine-${k}`, guildId: s.guild.id });
    const t0 = Date.now();
    const order = [];
    for (let k = 0; k < 30; k++) {
      const m = fakeMember(s.guild, { name: `Member ${k} with a rather long display name` });
      order.push(agents.addDevice(m.id, { name: `${'Workstation'.repeat(5)}-${k}`.slice(-64), os: 'linux', guildId: s.guild.id, lastSeen: t0 - k * 1000 }).deviceId);
    }
    for (const p of [(await view(s)).replies[0], (await press(s, `agent:revoke:${agents.devices(s.member.id)[0].deviceId}`)).updates[0]]) {
      const rows = assertDiscordLimits(p, '/agent many');
      assert.ok(rows.length <= 5);
      const kicks = parts(p).filter((c) => c.custom_id?.startsWith('agent:kick:'));
      assert.ok(kicks.length >= 1 && kicks.length <= 20);
      const m = section(p).match(/แสดง (\d+) จาก 30 เครื่อง/);
      assert.ok(m, 'แสดง N จาก M');
      assert.equal(Number(m[1]), kicks.length);
      assert.deepEqual(kicks.map((c) => c.custom_id), order.slice(0, kicks.length).map((x) => `agent:kick:${x}`), 'newest first');
      assert.ok(content(p).length <= 2000);
    }
  });
});

describe('agent online/offline', () => {
  test('transitions are logged (tag only) and refresh nothing else', async () => {
    const s = scene(bot);
    bot.client.users.cache.set(s.member.id, { id: s.member.id, tag: 'Alice' });
    agents.setOnline(s.member.id);
    agents.setOnline(s.member.id);
    agents.setOnline(s.member.id, false);
    const l = logs.out.filter((x) => /ตัวอัดของ/.test(x));
    assert.equal(l.length, 2);
    assert.match(l[0], /🟢 ตัวอัดของ Alice ออนไลน์/);
    assert.match(l[1], /⚪ ตัวอัดของ Alice ออฟไลน์/);
  });
});

describe('manual 🎥 อัดจอฉัน with an agent (case 4)', () => {
  test('prepares at once: ephemeral ⏳, the public prepare card and the room join before the ack (nothing recorded); live → audio starts; ⏹️ → one meeting file', async () => {
    const s = await manualScene();
    agents.setOnline(s.member.id);
    agents.startMode = 'hold';
    const [i, done] = interact(s, 'screen:me');
    const g = s.guild.id;
    const sess = await waitFor(() => screen.get(g), 'reserved');
    assert.equal(sess.kind, 'session');
    assert.equal(sess.mode, 'manual');
    await waitFor(() => agents.pending.length === 1, 'machine told');
    assert.equal(content(i.replies[0]), '⏳ กำลังสั่งเครื่องของคุณให้อัดจอ... · บอทเข้าห้องเตรียมอัด (เริ่มอัดพร้อมภาพจอ)');
    assert.ok(isEphemeral(i.replies[0]));
    await waitFor(() => sess.paired && voice.get(g) === sess.paired, 'joined before the ack');
    await sess.cardQ;
    assert.equal(s.text.sent.length, 1, 'the public card at once: the bot is in the room');
    assert.match(content(lastOf(sess.card)), /^⏳ \*\*เตรียมอัดในห้อง Meeting\*\*/);
    assert.equal(sess.paired.recording, false, 'nothing recorded before the screen');
    agents.ack('ok');
    await done;
    await live(s);
    assert.equal(sess.paired.recording, true);
    assert.equal(sess.paired.startedAt, sess.cur.rec.liveAt, 'the audio starts at the agent\'s live time');
    assert.equal(agents.calls.length, 1);
    assert.equal(agents.calls[0].userId, s.member.id, 'only the presser\'s machine');
    assert.equal(agents.calls[0].capture.via, 'agent');
    assert.equal(s.text.sent.length, 1, 'still one card');
    const card = sess.card;
    assert.match(content(lastOf(card)), /กำลังอัดจอของ <@\d+>/);
    assert.deepEqual(ids(lastOf(card)), [`screen:stop:${sess.began}`]);
    assert.equal(voice.get(g).channel, s.room);
    assert.equal(FakeVoiceRecorder.instances.length, 1);
    assert.match(content(lastOf(i)), /^🔴 เริ่มอัดจอเครื่องของคุณแล้ว/);
    assert.deepEqual(lastOf(i).components, []);
    await press(s, `screen:stop:${sess.began}`, { message: card });
    const out = await resultOf(s, sess);
    assert.match(content(out), /^✅ \*\*อัดจอเสร็จแล้ว\*\*/);
    assert.deepEqual(labels(out), ['▶️ ดูวิดีโอ', '📁 ไฟล์ทั้งหมด']);
    assert.equal(composed.calls.length, 1);
    assert.deepEqual(uploads.map((u) => u.replace(/^\d{4}-\d\d-\d\d \d\d\.\d\d /, '')), ['Meeting.mp4']);
    assert.ok(agents.stops.some((x) => x.userId === s.member.id));
    assert.ok(FakeVoiceRecorder.instances[0].stopped, 'bot left');
  });

  test('continuous: not tied to sharing (no share, others sharing, share toggles: it keeps recording)', async () => {
    const s = await manualScene();
    agents.setOnline(s.member.id);
    await press(s, 'screen:me');
    const sess = await live(s);
    const g = s.guild.id;
    fire('voiceStateUpdate', ...moveMember(s.b, { streaming: true }));
    fire('voiceStateUpdate', ...moveMember(s.member, { streaming: true }));
    fire('voiceStateUpdate', ...moveMember(s.member, { streaming: false }));
    await sleep(40);
    assert.equal(screen.get(g), sess);
    assert.equal(sess.cur?.rec.state, 'live');
    assert.ok(!ids(lastOf(sess.card)).some((x) => x.startsWith('screen:switch')), 'no 🔁 on a manual recording');
    await press(s, `screen:stop:${sess.began}`, { message: sess.card });
    await resultOf(s, sess);
  });

  test('/screen start (no mode) uses their agent; mode:browser always the link, never the agent', async () => {
    const s = await manualScene();
    agents.setOnline(s.member.id);
    await press(s, undefined, { kind: 'slash', command: 'screen', sub: 'start' });
    const sess = await live(s);
    assert.equal(sess.mode, 'manual');
    assert.equal(agents.calls.length, 1);
    await press(s, `screen:stop:${sess.began}`, { message: sess.card });
    await resultOf(s, sess);
    const i = await press(s, undefined, { kind: 'slash', command: 'screen', sub: 'start', options: { mode: 'browser' } });
    assert.equal(agents.calls.length, 1, 'mode:browser never commands the agent');
    assert.equal(screen.get(s.guild.id).kind, 'browser');
    assert.match(parts(i.replies[0])[0].url, /^http:\/\/localhost:1\/capture\//);
    await screen.get(s.guild.id).stop();
  });

  test('the owner may stop it without the recorder role', async () => {
    const s = await manualScene();
    s.member.admin = false;
    await updateSettings(s.guild.id, { anyoneRecords: true });
    agents.setOnline(s.member.id);
    await press(s, 'screen:me');
    const sess = await live(s);
    await updateSettings(s.guild.id, { anyoneRecords: false });
    const i = await press(s, `screen:stop:${sess.began}`, { message: sess.card });
    assert.equal(i.replies.length, 0, 'not refused');
    await resultOf(s, sess);
  });

  test('the presser leaves voice → ends, meeting delivered, bot leaves', async () => {
    const s = await manualScene();
    agents.setOnline(s.member.id);
    await press(s, 'screen:me');
    const sess = await live(s);
    fire('voiceStateUpdate', ...moveMember(s.member, { channel: null }));
    const out = await resultOf(s, sess);
    assert.match(content(out), /ออกจากห้องเสียงแล้ว/);
    assert.equal(composed.calls.length, 1);
    assert.ok(FakeVoiceRecorder.instances[0].stopped);
  });

  test('the presser moving to another room also ends it; someone else leaving does not', async () => {
    const s = await manualScene();
    agents.setOnline(s.member.id);
    await press(s, 'screen:me');
    const sess = await live(s);
    fire('voiceStateUpdate', ...moveMember(s.b, { channel: null }));
    await sleep(30);
    assert.equal(screen.get(s.guild.id), sess, 'Bob leaving changes nothing');
    const other = fakeMember(s.guild, { name: 'Elsewhere' });
    const room2 = (await import('./helpers/fakes.js')).fakeVoiceChannel(s.guild, { name: 'Room 2' });
    moveMember(other, { channel: room2 });
    fire('voiceStateUpdate', ...moveMember(s.member, { channel: room2 }));
    await resultOf(s, sess);
  });

  test('the agent goes offline → partial file + ⚠️ note, the session ends', async () => {
    const s = await manualScene();
    agents.setOnline(s.member.id);
    await press(s, 'screen:me');
    const sess = await live(s);
    agents.drop(s.member.id);
    const out = await resultOf(s, sess);
    assert.match(content(out), /^✅ \*\*อัดจอเสร็จแล้ว\*\*/);
    assert.match(content(out), /⚠️ ตัวอัดหลุด/);
    assert.equal(composed.calls.length, 1, 'the partial video still goes through');
  });

  test('stopped at the machine (local stop) ends the manual session', async () => {
    const s = await manualScene();
    agents.setOnline(s.member.id);
    await press(s, 'screen:me');
    const sess = await live(s);
    agents.localStop(s.member.id);
    const out = await resultOf(s, sess);
    assert.match(content(out), /เจ้าของเครื่องกดหยุดที่ตัวอัด/);
  });

  test('max length ends it', async () => {
    const s = await manualScene();
    await updateSettings(s.guild.id, { maxMinutes: 0.0005 });
    agents.setOnline(s.member.id);
    await press(s, 'screen:me');
    const sess = await live(s);
    const out = await resultOf(s, sess);
    assert.match(content(out), /ครบเวลา/);
  });

  test('double press while starting: one session, a pointer', async () => {
    const s = await manualScene();
    agents.setOnline(s.member.id);
    agents.startMode = 'hold';
    const [, done] = interact(s, 'screen:me');
    await waitFor(() => agents.pending.length === 1, 'asked');
    const i2 = await press(s, 'screen:me');
    assert.match(content(i2.replies[0]), /อัดจออยู่แล้ว|กำลังจะอัด/);
    assert.equal(agents.calls.length, 1);
    agents.ack('ok');
    await done;
    const sess = await live(s);
    await press(s, `screen:stop:${sess.began}`, { message: sess.card });
    await resultOf(s, sess);
  });

  test('an old agent still reporting askFirst: no ask text anywhere, it records at once', async () => {
    const s = await manualScene();
    agents.setOnline(s.member.id, { askFirst: true });
    agents.startMode = 'hold';
    const [i, done] = interact(s, 'screen:me');
    await waitFor(() => agents.pending.length === 1, 'commanded');
    assert.doesNotMatch(content(i.replies[0]), /ถามก่อน/);
    agents.ack('ok');
    await done;
    const sess = await live(s);
    assert.doesNotMatch(content(lastOf(sess.card)), /ถามก่อน/);
    await press(s, `screen:stop:${sess.began}`, { message: sess.card });
    await resultOf(s, sess);
  });

  test('S3: the presser leaves while the machine is told: ends with nothing recorded, their reply says it ended', async () => {
    const s = await manualScene();
    agents.setOnline(s.member.id);
    agents.startMode = 'hold';
    const [i, done] = interact(s, 'screen:me');
    await waitFor(() => agents.pending.length === 1, 'commanded');
    const sess = screen.get(s.guild.id);
    await waitFor(() => sess.paired, 'joined');
    fire('voiceStateUpdate', ...moveMember(s.member, { channel: null }));
    await waitFor(() => !screen.has(s.guild.id), 'ended');
    agents.ack('ok');
    await done;
    const out = await resultOf(s, sess);
    assert.match(content(out), /^⚪ \*\*ไม่ได้อัด\*\* — ไม่มีภาพจอ/);
    assert.equal(uploads.length + composed.calls.length, 0, 'no voice.mp3, nothing composed');
    assert.ok(FakeVoiceRecorder.instances.every((v) => v.stopped), 'the bot left');
    assert.match(content(lastOf(i)), /จบแล้ว/);
  });

  test('N1: an ack ok for a capture nobody claimed is a failed start: the audio goes on, the private link instead', async () => {
    const s = await manualScene();
    agents.setOnline(s.member.id);
    agents.plan.push('unclaimed');
    const i = await press(s, 'screen:me');
    const sess = screen.get(s.guild.id);
    assert.equal(sess?.kind, 'session');
    assert.equal(sess.cur?.source, 'link', 'no live agent segment');
    assert.match(content(lastOf(i)), /^⚠️/);
    await press(s, `screen:stop:${sess.began}`, { message: sess.card });
    await resultOf(s, sess);
  });

  test('a manual 🎙️ running blocks it with the usual text, no command to the machine', async () => {
    const s = await manualScene();
    agents.setOnline(s.member.id);
    await press(s, 'record:start');
    const i = await press(s, 'screen:me');
    assert.match(content(i.replies[0]), /กำลังอัดอยู่แล้ว/);
    assert.equal(agents.calls.length, 0);
  });
});

describe('manual 🖥️ failures fall back to the private link (nothing recorded until it is opened)', () => {
  for (const [mode, text] of [['busy', 'เครื่องของคุณกำลังอัดอยู่'], ['declined', 'เครื่องของคุณไม่ยอมให้อัดจอ'], ['timeout', 'เครื่องของคุณไม่ตอบ'], ['ffmpeg', 'ตัวอัดเริ่มอัดไม่ได้']]) {
    test(`agent ${mode}: still preparing, the ephemeral reply has the private link + 📥, a note on the public card`, async () => {
      const s = await manualScene();
      agents.setOnline(s.member.id);
      agents.startMode = mode;
      const i = await press(s, 'screen:me');
      const e = lastOf(i);
      assert.ok(content(e).includes(text), content(e));
      assert.match(content(e), /อัดผ่านลิงก์แทนได้/);
      assert.match(content(e), /ยังไม่ได้อัดจนกว่าจะแชร์จอ/);
      const link = parts(e);
      assert.deepEqual(link.map((c) => c.custom_id ?? 'url'), ['url', 'agent:install']);
      assert.match(link[0].url, /^http:\/\/localhost:1\/capture\//);
      const sess = screen.get(s.guild.id);
      assert.equal(sess.kind, 'session', 'not cancelled');
      assert.equal(sess.cur.source, 'link');
      assert.equal(sess.cur.private, true);
      await waitFor(() => sess.paired, 'room audio');
      await sess.cardQ;
      const card = lastOf(sess.card);
      assert.ok(!parts(card).some((c) => c.url), 'the private link is not on the public card');
      assert.match(content(card), /ส่งลิงก์อัดจอให้ <@\d+> แล้ว \(เห็นคนเดียว\)/);
      assert.match(content(card), /-# ⚠️/);
      assert.equal(agents.stops.length, 0, 'a device that never started is not told to stop');
      const rec = sess.cur.rec;
      rec.finalize = async () => `${rec.dir}/screen.webm`;
      await rec.claim(tokenOf(rec), 'video/webm'); // the link still works, into the same session
      await waitFor(() => /กำลังอัดจอของ/.test(content(lastOf(sess.card))), 'live through the link');
      await press(s, `screen:stop:${sess.began}`, { message: sess.card });
      await resultOf(s, sess);
      assert.equal(composed.calls.length, 1, 'one meeting file');
    });
  }

  test('the agent detail is shown (trimmed)', async () => {
    const s = await manualScene();
    agents.setOnline(s.member.id);
    const orig = agents.start.bind(agents);
    agents.start = async (u, c, o) => { const r = await orig(u, c, o); return r.ok ? r : { ...r, detail: 'x'.repeat(500) }; };
    agents.startMode = 'ffmpeg';
    const i = await press(s, 'screen:me');
    assert.match(content(lastOf(i)), /ตัวอัดเริ่มอัดไม่ได้: x{300} — /);
    await screen.get(s.guild.id).cur.rec.stop();
  });

  test('the agent went offline before the ack: the private link, the session goes on with audio', async () => {
    const s = await manualScene();
    agents.setOnline(s.member.id);
    agents.startMode = 'hold';
    const [i, done] = interact(s, 'screen:me');
    await waitFor(() => agents.pending.length === 1, 'commanded');
    agents.ack('offline');
    await done;
    assert.match(content(lastOf(i)), /ตัวอัดออฟไลน์/);
    assert.deepEqual(ids(lastOf(i)).map((x) => (x.startsWith('link:') ? 'link' : x)), ['link', 'agent:install']);
    assert.equal(screen.get(s.guild.id).cur.source, 'link');
  });

  test('stopped while the machine is being told: ends (room audio delivered), the reply says it ended', async () => {
    const s = await manualScene();
    agents.setOnline(s.member.id);
    agents.startMode = 'hold';
    const [i, done] = interact(s, 'screen:me');
    await waitFor(() => agents.pending.length === 1, 'commanded');
    const sess = screen.get(s.guild.id);
    await press(s, 'screen:stop');
    agents.ack('ok');
    await done;
    assert.ok(!screen.has(s.guild.id));
    assert.equal(sess.finished, true);
    assert.match(content(lastOf(i)), /จบแล้ว/);
  });
});

describe('manual 🖥️ / 🌐 without an agent (case 5)', () => {
  test('🖥️ without an agent: a short note, the private link and 📥, nothing started on any agent', async () => {
    const s = await manualScene();
    const i = await press(s, 'screen:me');
    assert.ok(isEphemeral(i.replies[0]));
    assert.match(content(i.replies[0]), /^⚠️ เครื่องของคุณยังไม่ได้เปิดตัวอัด/);
    const comps = parts(i.replies[0]);
    assert.deepEqual(comps.map((c) => c.custom_id ?? 'url'), ['url', 'agent:install']);
    assert.match(comps[0].url, /^http:\/\/localhost:1\/capture\//);
    const rec = screen.get(s.guild.id);
    assert.equal(rec.kind, 'browser');
    assert.equal(rec.state, 'offered');
    assert.equal(agents.calls.length, 0);
    assert.equal(s.text.sent.length, 0);
    await rec.stop();
  });

  test('area discord: the private link asks for the Discord window only outside mode browser; manual 🖥️ agent keeps start.area', async () => {
    for (const [mode, re] of [['agent', /\/capture\/[^?]+\?area=discord$/], ['browser', /\/capture\/[^?]+$/]]) {
      bot._reset(); resetFakes();
      const s = await manualScene();
      await updateSettings(s.guild.id, { mode, area: 'discord' });
      const i = await press(s, 'screen:me');
      assert.match(parts(i.replies[0]).find((c) => c.url).url, re, mode);
      await screen.get(s.guild.id).stop();
    }
    const s = await manualScene();
    await updateSettings(s.guild.id, { mode: 'browser', area: 'discord' });
    agents.setOnline(s.member.id);
    await press(s, 'screen:me');
    await live(s);
    assert.equal(agents.calls[0].area, 'discord', 'the agent still gets the saved area in mode browser');
  });

  test('an agent of someone else does not count', async () => {
    const s = await manualScene();
    agents.setOnline(s.b.id);
    const i = await press(s, 'screen:me');
    assert.deepEqual(ids(i.replies[0]).map((x) => x.startsWith("link:") ? "link" : x), ["link", "agent:install"]);
    assert.equal(agents.calls.length, 0);
    await screen.get(s.guild.id).stop();
  });
});
