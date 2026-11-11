import './helpers/env.js';
import { describe, test, beforeEach, afterEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { loadBot, waitFor, sleep, scene, resetFakes } from './helpers/bot.js';
import { fakeInteraction, fakeMember, moveMember, parts, deferred, FakeVoiceRecorder, FakeScreenRecorder } from './helpers/fakes.js';

// QA edge cases for the host-Mac screen (one physical screen for every server) and its stop paths

const { bot, logs, uploads, fire } = await loadBot({ SCREEN_ENABLED: 'true', PUBLIC_URL: '' });
const { updateSettings } = await import('../src/settings.js');
const { voice, screen } = bot;
const content = (p) => p?.content ?? '';
const lastOf = (m) => m.edits.at(-1) ?? m.payload;
const labels = (p) => parts(p).filter((c) => c.url).map((c) => c.label);
const settle = (ms = 40) => sleep(ms);
const press = (s, customId, extra = {}) => {
  const i = fakeInteraction({ guild: s.guild, member: s.member, channel: s.text, customId, ...extra });
  return fire('interactionCreate', i).then(() => i);
};
const resultsOf = (s) => [s.text, s.room].flatMap((c) => [...c.messages.store.values()])
  .filter((m) => !m.deleted && /^[✅❌]/.test(content(lastOf(m))));
const share = (s, on = true) => fire('voiceStateUpdate', ...moveMember(s.member, { streaming: on }));
const autoScene = async (patch = {}) => {
  const s = scene(bot);
  await updateSettings(s.guild.id, { autoScreen: true, minMembers: 2, minShareSeconds: 0, mode: 'screen', ...patch });
  s.other = fakeMember(s.guild, { name: 'Other' });
  moveMember(s.other, { channel: s.room });
  return s;
};
const autoRec = async (s) => {
  share(s);
  const g = s.guild.id;
  await waitFor(() => screen.get(g)?.paired && voice.get(g), 'auto screen + voice');
  await screen.get(g).cardQ;
  return screen.get(g);
};
const manualRec = async (s) => {
  const i = await press(s, 'screen:start');
  const rec = screen.get(s.guild.id);
  await waitFor(() => rec.paired?.notice, 'paired + notice');
  await rec.cardQ;
  return [i, rec];
};
const oneResult = async (s, name) => {
  const g = s.guild.id;
  await waitFor(() => resultsOf(s).length >= 1 && !screen.has(g) && !voice.has(g), `${name}: result`);
  await settle();
  const r = resultsOf(s);
  assert.equal(r.length, 1, `${name}: one result card`);
  const l = labels(lastOf(r[0]));
  assert.ok(l.some((x) => x.includes('ดูวิดีโอ')) && !l.some((x) => x.includes('ฟังเสียง')), `${name}: one video with the audio in it (${l})`);
  assert.deepEqual([FakeScreenRecorder.instances, FakeVoiceRecorder.instances].map((a) => a.map((x) => x.stopped)), [[true], [true]], `${name}: stopped`);
  assert.equal(uploads.length, 1);
  assert.match(uploads[0], /-with-audio\.\w+$/);
  return r[0];
};

beforeEach(() => { bot._reset(); bot.client.guilds.cache.clear(); resetFakes(); // old scenes must not keep reacting (checkAuto sweeps every cached guild)
  uploads.length = 0; logs.err.length = 0; mock.timers.reset(); });
afterEach(() => sleep(80)); // let in-flight starts (voice join, card edits) land before the next test resets the maps
after(() => { bot._reset(); mock.timers.reset(); });

describe('one host screen across servers', () => {
  test('auto: a share in B waits while A records, then starts once A\'s file is written', async () => {
    const a = await autoScene();
    const b = await autoScene();
    const gate = deferred();
    await autoRec(a);
    const ra = screen.get(a.guild.id);
    ra.stop = async function stop() { this.stopped = true; await gate.promise; this.die(); return `${this.dir}/screen.mp4`; }; // slow ffmpeg finalize
    share(b);
    await settle();
    assert.equal(FakeScreenRecorder.instances.length, 1, 'B did not start a second ffmpeg');
    assert.equal(screen.has(b.guild.id), false);
    assert.equal(b.room.sent.length + b.text.sent.length, 0, 'and said nothing');
    share(a, false);
    await waitFor(() => !screen.has(a.guild.id), 'A stopping');
    fire('voiceStateUpdate', ...moveMember(b.other, { streaming: false })); // any event in B while A still finalizes
    await settle();
    assert.equal(screen.has(b.guild.id), false, 'screen still busy while ffmpeg writes the mp4');
    gate.resolve();
    await waitFor(() => screen.has(b.guild.id), 'B starts when the screen is free');
    assert.equal(screen.get(b.guild.id).auto, b.member.id);
  });

  test('manual 🖥️ in B while A records: refused with the "maybe another server" text, nothing started; 🎙️ still works', async () => {
    const a = scene(bot);
    const b = scene(bot);
    await manualRec(a);
    const i = await press(b, 'screen:start');
    assert.match(content(i.replies[0]), /จอเครื่องนี้กำลังถูกอัดอยู่ \(อาจเป็นของ server อื่น\)/);
    assert.equal(FakeScreenRecorder.instances.length, 1);
    await press(b, 'record:start');
    assert.ok(voice.has(b.guild.id), 'voice recording is per server');
  });

  test('B presses while A is still starting (ffmpeg not up yet): refused', async () => {
    const a = scene(bot);
    const b = scene(bot);
    const gate = deferred();
    FakeScreenRecorder.startHook = () => gate.promise;
    const first = press(a, 'screen:start');
    await waitFor(() => FakeScreenRecorder.instances.length === 1, 'A starting');
    const i = await press(b, 'screen:start');
    assert.match(content(i.replies[0]), /กำลังถูกอัดอยู่/);
    assert.equal(FakeScreenRecorder.instances.length, 1);
    gate.resolve();
    await first;
    assert.ok(screen.has(a.guild.id));
  });

  test('A fails to start (no permission): B can start straight away; A\'s sharer is skipped, one error in A', async () => {
    const a = await autoScene();
    const b = await autoScene();
    FakeScreenRecorder.startHook = () => { throw Object.assign(new Error('no permission'), { code: 'SCREEN_PERMISSION' }); };
    share(a);
    await waitFor(() => bot.autoSkip.get(a.guild.id)?.has(a.member.id), 'A skipped');
    await waitFor(() => a.room.sent.length === 1, 'error posted once in A');
    assert.match(content(a.room.sent[0].payload), /อัดจออัตโนมัติไม่ได้/);
    FakeScreenRecorder.startHook = null;
    share(b);
    await waitFor(() => screen.has(b.guild.id), 'B starts');
    share(a, false); share(a, true); // A retries only after a new share
    await waitFor(() => bot.autoSkip.get(a.guild.id) && !bot.autoSkip.get(a.guild.id).has(a.member.id) || screen.has(a.guild.id), 'skip cleared');
  });

  test('the same sharer pressing 🖥️ twice quickly starts one ffmpeg', async () => {
    const s = scene(bot);
    await Promise.all([press(s, 'screen:start'), press(s, 'screen:start')]);
    await settle();
    assert.equal(FakeScreenRecorder.instances.length, 1);
  });
});

describe('Mac stop paths: one result card with video + audio', () => {
  const paths = {
    'card ⏹️': (s, rec, i) => press(s, `screen:stop:${rec.began}`, { message: i.replyMessage }),
    'panel ⏹️': (s) => press(s, 'screen:stop'),
    'room notice': (s, rec) => press(s, `record:stop:${rec.paired.began}`, { message: rec.paired.notice }),
    '/record stop': (s) => press(s, undefined, { kind: 'slash', command: 'record', sub: 'stop' }),
    '/screen stop': (s) => press(s, undefined, { kind: 'slash', command: 'screen', sub: 'stop' }),
    'ffmpeg dies': () => FakeScreenRecorder.instances[0].die(),
  };
  for (const [name, stop] of Object.entries(paths)) {
    test(name, async () => {
      const s = scene(bot);
      const [i, rec] = await manualRec(s);
      await stop(s, rec, i);
      await oneResult(s, name);
    });
  }

  test('max length', async () => {
    const s = scene(bot);
    await updateSettings(s.guild.id, { maxMinutes: 0.001 });
    await manualRec(s);
    const r = await oneResult(s, 'max');
    assert.match(content(lastOf(r)), /ครบเวลาอัดสูงสุด/);
  });

  test('bot dropped from the room: the video goes on, the result carries the note', async () => {
    const s = scene(bot);
    const [i, rec] = await manualRec(s);
    rec.paired.onGone();
    await settle();
    assert.ok(screen.get(s.guild.id) === rec);
    await press(s, `screen:stop:${rec.began}`, { message: i.replyMessage });
    const r = await oneResult(s, 'dropped');
    assert.match(content(lastOf(r)), /บอทหลุดจากห้องเสียงกลางทาง/);
  });

  const autoPaths = {
    'share ends': (s) => share(s, false),
    'sharer leaves': (s) => fire('voiceStateUpdate', ...moveMember(s.member, { channel: null })),
    'autoScreen off': (s) => press(s, 'config:auto'),
    'preset off': (s) => press(s, 'config:preset-off'),
    'card ⏹️': (s, rec) => press(s, `screen:stop:${rec.began}`, { message: rec.card }),
    'room card is the screen card: /record stop': (s) => press(s, undefined, { kind: 'slash', command: 'record', sub: 'stop' }),
  };
  for (const [name, stop] of Object.entries(autoPaths)) {
    test(`auto: ${name}`, async () => {
      const s = await autoScene();
      const rec = await autoRec(s);
      await stop(s, rec);
      await oneResult(s, name);
      assert.equal(s.room.sent.length, 1, 'card in the room, no second message');
    });
  }

  test('auto: a stop by hand skips the sharer; max length skips too', async () => {
    const s = await autoScene({ maxMinutes: 0.001 });
    await autoRec(s);
    await oneResult(s, 'max');
    assert.ok(bot.autoSkip.get(s.guild.id)?.has(s.member.id));
    fire('voiceStateUpdate', ...moveMember(s.other, { streaming: false }));
    await settle();
    assert.equal(screen.size, 0);
  });

  test('auto: mode switched to window/browser mid-recording leaves the running recording alone', async () => {
    const s = await autoScene();
    const rec = await autoRec(s);
    await press(s, 'config:mode', { kind: 'select', values: ['window'] });
    await settle();
    assert.ok(screen.get(s.guild.id) === rec);
    await press(s, 'config:mode', { kind: 'select', values: ['browser'] }); // not available here: ignored
    assert.ok(screen.get(s.guild.id) === rec);
  });

  test('auto: schedule window closing ends it; reopening starts again (sharer not skipped)', async () => {
    mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-09T05:00:00Z') }); // Mon 12:00 Bangkok
    const s = await autoScene({ from: 9, to: 17 });
    await autoRec(s);
    mock.timers.setTime(new Date('2026-11-09T11:00:00Z').getTime());
    fire('voiceStateUpdate', ...moveMember(s.other, { streaming: false }));
    await oneResult(s, 'window closed');
    assert.ok(!bot.autoSkip.get(s.guild.id)?.has(s.member.id));
    mock.timers.setTime(new Date('2026-11-10T05:00:00Z').getTime());
    fire('voiceStateUpdate', ...moveMember(s.other, { streaming: false }));
    await waitFor(() => screen.has(s.guild.id), 'restarted in the window');
  });

  test('a manual recording survives autoScreen off and a closed window', async () => {
    const s = scene(bot);
    const [, rec] = await manualRec(s);
    await updateSettings(s.guild.id, { autoScreen: false, days: [] });
    fire('voiceStateUpdate', ...moveMember(fakeMember(s.guild, { name: 'x' }), { channel: s.room }));
    await settle();
    assert.ok(screen.get(s.guild.id) === rec && voice.has(s.guild.id));
  });
});
