import { tmp } from './helpers/env.js';
import { describe, test, beforeEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { loadBot, waitFor, sleep, scene, resetFakes } from './helpers/bot.js';
import { fakeInteraction, fakeMember, fakeGuild, fakeTextChannel, moveMember, parts, deferred, FakeVoiceRecorder } from './helpers/fakes.js';

// QA edge cases for index.js in browser-capture mode: several servers, stop paths (one result card each),
// settings / schedule / max changes mid-recording, restart cleanup. No Discord, no real voice.

const { bot, logs, uploads, fire } = await loadBot({ SCREEN_ENABLED: 'false', PUBLIC_URL: 'http://localhost:1' });
const { T } = await import('../src/browser-capture.js');
const { updateSettings, getSettings } = await import('../src/settings.js');
Object.assign(T, { drainMax: 50, silent: 50, poll: 5, beat: 20 }); // beat: before the first capture exists

const { voice, screen } = bot;
const content = (p) => p?.content ?? '';
const lastOf = (m) => m.edits.at(-1) ?? m.payload;
const labels = (p) => parts(p).filter((c) => c.url).map((c) => c.label);
const pressAs = (s, member, customId, extra = {}) => {
  const i = fakeInteraction({ guild: s.guild, member, channel: s.text, customId, ...extra });
  return fire('interactionCreate', i).then(() => i);
};
const press = (s, customId, extra = {}) => pressAs(s, s.member, customId, extra);
const tokenOf = (rec) => rec.link().split('/capture/')[1];
const goLive = (rec) => {
  rec.finalize = async () => `${rec.dir}/screen.webm`; // no ffmpeg
  return rec.claim(tokenOf(rec), 'video/webm');
};
// every message the bot posted in this server whose latest text is a result (✅/❌)
const resultsOf = (s) => [s.text, s.room].flatMap((c) => [...c.messages.store.values()])
  .filter((m) => !m.deleted && /^[✅❌]/.test(content(lastOf(m))));
const settle = (ms = 40) => sleep(ms);
const share = (s, on = true, who = s.member) => fire('voiceStateUpdate', ...moveMember(who, { streaming: on }));
const autoScene = async (patch = {}, opts = {}) => {
  const s = scene(bot, opts);
  await updateSettings(s.guild.id, { autoScreen: true, minMembers: 2, minShareSeconds: 0, mode: 'browser', ...patch });
  s.other = fakeMember(s.guild, { name: 'Other' });
  moveMember(s.other, { channel: s.room });
  return s;
};
const autoOffer = async (s) => {
  share(s);
  const g = s.guild.id;
  await waitFor(() => screen.get(g)?.paired && voice.get(g) === screen.get(g).paired, 'offer + paired voice');
  const rec = screen.get(g);
  await rec.cardQ;
  return rec;
};
// manual 🎥 → page goes live → the bot joins the room (notice posted there)
const manualLive = async (s) => {
  await press(s, 'screen:me');
  const rec = screen.get(s.guild.id);
  goLive(rec);
  await waitFor(() => rec.paired?.notice, 'paired voice + notice');
  await rec.cardQ;
  return rec;
};
const oneResult = async (s, { video, name = 'result' }) => {
  const g = s.guild.id;
  await waitFor(() => resultsOf(s).length >= 1 && !screen.has(g) && !voice.has(g), `${name}: a result card`);
  await settle();
  const r = resultsOf(s);
  assert.equal(r.length, 1, `${name}: exactly one result card, got ${r.map((m) => content(lastOf(m)).split('\n')[0])}`);
  const l = labels(lastOf(r[0]));
  // one file: the video carries the room audio, so a separate 🎧 only when there is no video
  assert.equal(l.some((x) => x.includes('ฟังเสียง')), !video, `${name}: audio file ${video ? 'merged into the video' : 'on the card'} (${l})`);
  assert.equal(l.some((x) => x.includes('ดูวิดีโอ')), video, `${name}: video file ${video ? 'present' : 'absent'} (${l})`);
  assert.ok(FakeVoiceRecorder.instances.every((v) => v.stopped), `${name}: voice recorder stopped`);
  assert.equal(voice.size + screen.size, 0);
  assert.equal(uploads.length, 1, `${name}: uploads ${uploads}`);
  if (video) assert.match(uploads[0], /-with-audio\.\w+$/, `${name}: the merged file`);
  assert.deepEqual(logs.err.filter((e) => /!!!|TypeError|ReferenceError/.test(e)), [], `${name}: no errors`);
  return r[0];
};

beforeEach(() => { bot._reset(); bot.client.guilds.cache.clear(); resetFakes(); // old scenes must not keep reacting (checkAuto sweeps every cached guild)
  uploads.length = 0; logs.err.length = 0; mock.timers.reset(); });
after(() => { bot._reset(); mock.timers.reset(); });

describe('two servers at once', () => {
  test('auto offers in both are independent; ending one leaves the other, results go to their own channels', async () => {
    const a = await autoScene({}, { name: 'Alice' });
    const b = await autoScene({}, { name: 'Bob' });
    const ra = await autoOffer(a);
    const rb = await autoOffer(b);
    assert.notEqual(ra.dir, rb.dir);
    assert.notEqual(ra.capId, rb.capId);
    assert.equal(FakeVoiceRecorder.instances.length, 2);
    await waitFor(() => a.guild.members.me.nickname === 'Alice - 🔴 กำลังอัดเสียง' || a.guild.members.me.nickname?.includes('🔴'), 'nick A').catch(() => {});
    share(a, false);
    await waitFor(() => !screen.has(a.guild.id), 'A ended');
    await settle();
    assert.ok(screen.get(b.guild.id) === rb && voice.get(b.guild.id) === rb.paired, 'B untouched');
    assert.equal(FakeVoiceRecorder.instances.find((v) => v.channel === b.room).stopped, false);
    assert.equal(resultsOf(b).length, 0, 'nothing posted for B');
    assert.equal(resultsOf(a).length, 1);
    assert.equal(b.room.sent.length, 1, 'B has just its offer card');
    share(b, false);
    await waitFor(() => !screen.has(b.guild.id), 'B ended');
    await settle();
    assert.equal(resultsOf(b).length, 1);
    assert.equal(resultsOf(a).length, 1, 'A not touched again');
  });

  test('manual recordings in two servers: their own dirs, cards, settings and nicknames', async () => {
    const a = scene(bot, { name: 'Alice' });
    const b = scene(bot, { name: 'Bob' });
    a.guild.members.me.nickname = 'NickA';
    await press(a, 'record:start');
    await press(b, 'record:start');
    assert.equal(voice.size, 2);
    const [va, vb] = [voice.get(a.guild.id), voice.get(b.guild.id)];
    assert.notEqual(va.dir, vb.dir);
    await waitFor(() => a.guild.members.me.nickname === 'Alice - 🔴 กำลังอัดเสียง' && b.guild.members.me.nickname === 'Bob - 🔴 กำลังอัดเสียง', 'both nicks');
    await press(a, `record:stop:${va.began}`, { message: va.card });
    await waitFor(() => a.guild.members.me.nickname === 'NickA', 'A restored');
    assert.equal(b.guild.members.me.nickname, 'Bob - 🔴 กำลังอัดเสียง', 'B keeps its tag');
    assert.ok(voice.has(b.guild.id) && !FakeVoiceRecorder.instances.find((v) => v.channel === b.room).stopped);
    assert.deepEqual(getSettings(b.guild.id).cards.length, 1);
    await press(b, `record:stop:${vb.began}`, { message: vb.card });
    await waitFor(() => b.guild.members.me.nickname === null, 'B restored to no nickname');
  });

  test('settings and anyoneRecords do not leak between servers', async () => {
    const a = scene(bot);
    const b = scene(bot);
    await press(a, 'config:anyone');
    assert.equal(getSettings(a.guild.id).anyoneRecords, true);
    assert.equal(Boolean(getSettings(b.guild.id).anyoneRecords), false);
    const guestB = fakeMember(b.guild, { name: 'Guest' });
    moveMember(guestB, { channel: b.room });
    const i = await pressAs(b, guestB, 'record:start');
    assert.match(content(i.replies[0]), /^🔒/);
    assert.equal(voice.size, 0);
  });

  test('a "stop" button of one server cannot stop the other (same tag value is not enough)', async () => {
    const a = scene(bot);
    const b = scene(bot);
    await press(a, 'record:start');
    await press(b, 'record:start');
    const va = voice.get(a.guild.id), vb = voice.get(b.guild.id);
    await press(a, `record:stop:${vb.began}`, { message: va.card }); // B's tag in A's guild
    // began timestamps may collide within one ms; then this IS A's valid stop, and B must still run
    assert.ok(voice.has(b.guild.id), 'B keeps recording');
    void va;
  });

  test('screen-less browser offers: a share in A and a manual 🎥 in B do not block each other', async () => {
    const a = await autoScene();
    const b = scene(bot);
    await autoOffer(a);
    await press(b, 'screen:me');
    assert.ok(screen.has(b.guild.id) && screen.has(a.guild.id));
  });
});

describe('stop paths: exactly one result card with the right files', () => {
  const manualPaths = {
    'card ⏹️': (s, rec) => press(s, `screen:stop:${rec.began}`, { message: rec.card }),
    'panel ⏹️': (s) => press(s, 'screen:stop'),
    'room notice': (s, rec) => press(s, `record:stop:${rec.paired.began}`, { message: rec.paired.notice }),
    '/record stop': (s) => press(s, undefined, { kind: 'slash', command: 'record', sub: 'stop' }),
    '/screen stop': (s) => press(s, undefined, { kind: 'slash', command: 'screen', sub: 'stop' }),
    'page stop': (s, rec) => rec.pageStop('page', 0),
    'page share ended': (s, rec) => rec.pageStop('ended', 0),
    'heartbeat (page gone)': (s, rec) => { rec.lastSeen -= 1e7; },
    'record:stop from panel (untagged)': (s) => press(s, 'record:stop'),
  };
  for (const [name, stop] of Object.entries(manualPaths)) {
    test(`manual screen + audio: ${name}`, async () => {
      const s = scene(bot);
      const rec = await manualLive(s);
      await stop(s, rec);
      await oneResult(s, { video: true, name });
    });
  }

  test('manual screen + audio: max length', async () => {
    const s = scene(bot);
    await updateSettings(s.guild.id, { maxMinutes: 0.001 });
    await press(s, 'screen:me');
    const rec = screen.get(s.guild.id);
    assert.equal(rec.maxTimer, undefined, 'a private offer is not on the clock');
    goLive(rec);
    await waitFor(() => rec.maxTimer, 'armed when the page started');
    const r = await oneResult(s, { video: true, name: 'max' });
    assert.match(content(lastOf(r)), /ครบเวลาอัดสูงสุด/);
  });

  const autoPaths = {
    'card ⏹️ (the sharer)': (s, rec) => press(s, `screen:stop:${rec.began}`, { message: rec.card }),
    'panel ⏹️': (s) => press(s, 'screen:stop'),
    '/record stop': (s) => press(s, undefined, { kind: 'slash', command: 'record', sub: 'stop' }),
    '/screen stop': (s) => press(s, undefined, { kind: 'slash', command: 'screen', sub: 'stop' }),
    'share ends': (s) => share(s, false),
    'sharer leaves the room': (s) => fire('voiceStateUpdate', ...moveMember(s.member, { channel: null })),
    'autoScreen switched off': (s) => press(s, 'config:auto'),
  };
  for (const [name, stop] of Object.entries(autoPaths)) {
    test(`auto offer (audio only): ${name}`, async () => {
      const s = await autoScene();
      const rec = await autoOffer(s);
      await stop(s, rec);
      const r = await oneResult(s, { video: false, name });
      assert.equal(s.room.sent.length, 1, 'the offer card became the result: nothing else posted in the room');
      assert.equal(r, s.room.sent[0]);
      assert.match(content(lastOf(r)), /อัดเสียงในห้องเสร็จแล้ว/);
    });
  }

  test('auto offer: bot dropped from the room ends the offer at once: one audio card, nickname back, sharer skipped', async () => {
    const s = await autoScene();
    const g = s.guild.id;
    s.guild.members.me.nickname = 'Keep Me';
    const rec = await autoOffer(s);
    await waitFor(() => s.guild.members.me.nickname?.includes('🔴'), 'tagged');
    rec.paired.onGone();
    const r = await oneResult(s, { video: false, name: 'dropped' }); // before any share end
    assert.equal(r, s.room.sent[0], 'the offer card became the result');
    assert.match(content(lastOf(r)), /^✅ \*\*อัดเสียงในห้องเสร็จแล้ว/);
    assert.match(content(lastOf(r)), /-# ⚠️ บอทหลุดจากห้องเสียง$/);
    assert.equal(rec.state, 'done');
    assert.ok(bot.autoSkip.get(g)?.has(s.member.id), 'not re-offered until they stop sharing');
    assert.doesNotMatch(content(bot.panel(s.guild)), /🔴|🟡/);
    await waitFor(() => s.guild.members.me.nickname === 'Keep Me', 'nickname back');
    share(s, false); // the share ending later changes nothing
    await settle();
    assert.equal(s.room.sent.length, 1);
    assert.equal(screen.size + voice.size, 0);
  });

  test('auto offer on a phone (voice only): bot dropped ends it the same way', async () => {
    const s = await autoScene();
    const rec = await autoOffer(s);
    assert.deepEqual(await rec.voiceOnly(rec.link().split('/capture/')[1]), { ok: true, paired: true });
    rec.paired.onGone();
    const r = await oneResult(s, { video: false, name: 'phone dropped' });
    assert.match(content(lastOf(r)), /บอทหลุดจากห้องเสียง/);
    assert.equal(rec.state, 'done');
  });

  test('R9 kept: live video + bot dropped → video goes on, note on the final card', async () => {
    const s = await autoScene();
    const rec = await autoOffer(s);
    goLive(rec);
    await waitFor(() => rec.liveAt, 'live');
    rec.paired.onGone();
    await settle();
    assert.equal(screen.get(s.guild.id), rec, 'video still recording');
    share(s, false);
    const r = await oneResult(s, { video: true, name: 'live dropped then share end' });
    assert.match(content(lastOf(r)), /บอทหลุดจากห้องเสียงกลางทาง/);
  });

  test('auto offer, claimed: share ends → one card with video + audio', async () => {
    const s = await autoScene();
    const rec = await autoOffer(s);
    goLive(rec);
    await waitFor(() => rec.liveAt, 'live');
    share(s, false);
    await oneResult(s, { video: true, name: 'claimed share end' });
  });

  test('auto offer, max length counted from the offer: not re-armed when the page goes live', async () => {
    const s = await autoScene();
    const rec = await autoOffer(s);
    const timer = rec.maxTimer;
    assert.ok(timer, 'armed at offer time');
    goLive(rec);
    await waitFor(() => rec.liveAt, 'live');
    assert.equal(rec.maxTimer, timer, 'same timer');
    const { exp } = { exp: parseInt(rec.cardLink.split('.')[1] ?? '0', 36) };
    assert.ok(exp > Date.now() + 239 * 60000 && exp < Date.now() + 241 * 60000, 'card link lives as long as maxMinutes');
  });

  test('auto offer unopened: max length stops it (audio result), sharer is skipped until they re-share', async () => {
    const s = await autoScene({ maxMinutes: 0.001 });
    const rec = await autoOffer(s);
    const r = await oneResult(s, { video: false, name: 'auto max' });
    assert.match(content(lastOf(r)), /ครบเวลาอัดสูงสุด/);
    assert.ok(bot.autoSkip.get(s.guild.id)?.has(s.member.id), 'skipped');
    fire('voiceStateUpdate', ...moveMember(s.other, { streaming: false })); // any event while still sharing
    await settle();
    assert.equal(screen.size, 0, 'not offered again');
    share(s, false);
    share(s, true); // a new share is a new chance
    await waitFor(() => screen.has(s.guild.id), 'offered again');
    assert.notEqual(screen.get(s.guild.id), rec);
  });

  test('auto offer unopened: max cut-off ignores the old 5 minute offer length (T.offer shorter than max)', async () => {
    const old = T.offer;
    T.offer = 20;
    try {
      const s = await autoScene({ maxMinutes: 240 });
      await autoOffer(s);
      await sleep(100);
      assert.ok(screen.has(s.guild.id) && voice.has(s.guild.id), 'still recording past T.offer');
      share(s, false);
      await oneResult(s, { video: false, name: 'after T.offer' });
    } finally { T.offer = old; }
  });

  test('voice only: card ⏹️, panel, /record stop, max and bot dropped each give one audio card', async () => {
    const paths = {
      card: (s, v) => press(s, `record:stop:${v.began}`, { message: v.card }),
      panel: (s) => press(s, 'record:stop'),
      slash: (s) => press(s, undefined, { kind: 'slash', command: 'record', sub: 'stop' }),
      dropped: (s, v) => v.onGone(),
      max: () => {},
    };
    for (const [name, stop] of Object.entries(paths)) {
      bot._reset(); resetFakes(); uploads.length = 0;
      const s = scene(bot);
      if (name === 'max') await updateSettings(s.guild.id, { maxMinutes: 0.001 });
      await press(s, 'record:start');
      const v = voice.get(s.guild.id);
      await v.cardQ;
      await stop(s, v);
      const r = await oneResult(s, { video: false, name: `voice ${name}` });
      assert.equal(s.text.sent.length + s.text.messages.store.size - s.text.sent.length >= 1, true);
      assert.equal(r, v.card, `${name}: the result is the recording's own card`);
    }
  });

  test('voice only: nobody spoke → one card saying so, no files', async () => {
    const s = scene(bot);
    await press(s, 'record:start');
    const v = voice.get(s.guild.id);
    v.nobodySpoke = true;
    await press(s, `record:stop:${v.began}`, { message: v.card });
    await waitFor(() => /ไม่มีใครพูด/.test(content(lastOf(v.card))), 'no-speech result');
    assert.deepEqual(labels(lastOf(v.card)).filter((l) => l.includes('ฟังเสียง')), []);
  });

  test('manual mobile voice-only: stop on its card gives one audio card; the private offer is not a second one', async () => {
    const s = scene(bot);
    const [i] = [await press(s, 'screen:me')];
    const rec = screen.get(s.guild.id);
    assert.deepEqual(await rec.voiceOnly(tokenOf(rec)), { ok: true, paired: false });
    const v = voice.get(s.guild.id);
    await press(s, `record:stop:${v.began}`, { message: v.card });
    await oneResult(s, { video: false, name: 'mobile' });
    assert.ok(!/^[✅❌]/.test(content(lastOf(i.replyMessage))), 'the link message is not a result');
  });

  test('auto mobile voice-only: the page says paired; share end gives one audio card', async () => {
    const s = await autoScene();
    const rec = await autoOffer(s);
    assert.deepEqual(await rec.voiceOnly(tokenOf(rec)), { ok: true, paired: true });
    assert.equal(FakeVoiceRecorder.instances.length, 1);
    share(s, false);
    await oneResult(s, { video: false, name: 'auto mobile' });
  });
});

describe('settings changed while recording', () => {
  test('autoScreen off mid-offer: the offer ends as an audio result, the sharer is not skipped; on again → new offer', async () => {
    const s = await autoScene();
    const first = await autoOffer(s);
    await press(s, 'config:auto');
    await oneResult(s, { video: false, name: 'autoScreen off' });
    assert.ok(!bot.autoSkip.get(s.guild.id)?.has(s.member.id));
    await press(s, 'config:auto'); // still sharing: evaluated again
    await waitFor(() => screen.has(s.guild.id), 'new offer');
    assert.notEqual(screen.get(s.guild.id), first);
  });

  test('autoScreen off mid-recording (page live): both stop, one card with video + audio', async () => {
    const s = await autoScene();
    const rec = await autoOffer(s);
    goLive(rec);
    await waitFor(() => rec.liveAt, 'live');
    await press(s, 'config:auto');
    await oneResult(s, { video: true, name: 'off while live' });
  });

  test('preset "off" (R17) stops a running auto offer', async () => {
    const s = await autoScene();
    await autoOffer(s);
    await press(s, 'config:preset-off');
    await oneResult(s, { video: false, name: 'preset off' });
  });

  test('watched channels changed to another room mid-offer: the offer ends', async () => {
    const s = await autoScene();
    await autoOffer(s);
    const other = fakeMember(s.guild, { name: 'x' }); void other;
    await updateSettings(s.guild.id, { channels: ['123'] });
    await press(s, 'config:open'); // any later check
    fire('voiceStateUpdate', ...moveMember(s.other, { streaming: false }));
    await oneResult(s, { video: false, name: 'channels' });
  });

  test('minMembers raised above the head-count mid-offer: the recording goes on (only starts are gated)', async () => {
    const s = await autoScene();
    const rec = await autoOffer(s);
    await updateSettings(s.guild.id, { minMembers: 5 });
    fire('voiceStateUpdate', ...moveMember(s.other, { streaming: false }));
    await settle();
    assert.ok(screen.get(s.guild.id) === rec);
  });

  test('maxMinutes changed mid-recording does not move the running timer (pinned behaviour)', async () => {
    const s = await autoScene();
    const rec = await autoOffer(s);
    const t = rec.maxTimer;
    await updateSettings(s.guild.id, { maxMinutes: 0.001 });
    await settle(100);
    assert.ok(screen.get(s.guild.id) === rec && rec.maxTimer === t);
  });

  test('mode selected while an offer runs: browser is the only mode here, a bogus value is ignored and nothing breaks', async () => {
    const s = await autoScene();
    const rec = await autoOffer(s);
    const i = await press(s, 'config:mode', { kind: 'select', values: ['screen'] });
    assert.ok(i.deferredUpdate, 'ignored');
    assert.ok(screen.get(s.guild.id) === rec);
  });

  describe('anyoneRecords toggled while recording', () => {
    const guestScene = () => {
      const s = scene(bot);
      s.guest = fakeMember(s.guild, { name: 'Guest' });
      return s;
    };
    test('guest can stop only while it is on; off again → refused, the recording continues', async () => {
      const s = guestScene();
      await press(s, 'record:start');
      const v = voice.get(s.guild.id);
      const stop = () => pressAs(s, s.guest, `record:stop:${v.began}`, { message: v.card });
      assert.match(content((await stop()).replies[0]), /^🔒/);
      await press(s, 'config:anyone');
      await press(s, 'config:anyone');
      assert.match(content((await stop()).replies[0]), /^🔒/, 'toggled twice = off');
      assert.ok(voice.has(s.guild.id));
      await press(s, 'config:anyone');
      await stop();
      await waitFor(() => /^✅/.test(content(lastOf(v.card))), 'stopped by the guest');
    });

    test('a guest cannot toggle it or open settings, even while it is on', async () => {
      const s = guestScene();
      await press(s, 'config:anyone');
      const i = await pressAs(s, s.guest, 'config:anyone');
      assert.match(content(i.replies[0]), /^🔒/);
      assert.equal(getSettings(s.guild.id).anyoneRecords, true);
      const j = await pressAs(s, s.guest, 'config:open');
      assert.match(content(j.replies[0]), /^🔒/);
    });

    test('the sharer may always stop their own offer, with the toggle off and without admin rights', async () => {
      const s = await autoScene({}, { admin: false });
      const rec = await autoOffer(s);
      assert.equal(getSettings(s.guild.id).anyoneRecords, false);
      await press(s, `screen:stop:${rec.began}`, { message: rec.card });
      await oneResult(s, { video: false, name: 'own stop' });
    });

    test('a non-sharer guest cannot stop someone else\'s offer with the toggle off', async () => {
      const s = await autoScene();
      const rec = await autoOffer(s);
      const i = await pressAs(s, s.other, `screen:stop:${rec.began}`, { message: rec.card });
      assert.match(content(i.replies[0]), /^🔒/);
      assert.ok(screen.get(s.guild.id) === rec);
    });
  });
});

describe('schedule window closing mid-recording', () => {
  const at = (iso) => mock.timers.enable({ apis: ['Date'], now: new Date(iso) });
  const NOON = '2026-11-09T05:00:00Z'; // Monday 12:00 in Asia/Bangkok
  const EVENING = '2026-11-09T11:00:00Z'; // 18:00

  test('auto offer: the window closes, the next voice event ends it (audio result, sharer not skipped)', async () => {
    at(NOON);
    const s = await autoScene({ from: 9, to: 17 });
    await autoOffer(s);
    mock.timers.setTime(new Date(EVENING).getTime());
    fire('voiceStateUpdate', ...moveMember(s.other, { streaming: false }));
    await oneResult(s, { video: false, name: 'window closed' });
    assert.ok(!bot.autoSkip.get(s.guild.id)?.has(s.member.id));
    fire('voiceStateUpdate', ...moveMember(s.other, { streaming: false }));
    await settle();
    assert.equal(screen.size, 0, 'no new offer outside the window');
    mock.timers.setTime(new Date(NOON).getTime()); // window open again
    fire('voiceStateUpdate', ...moveMember(s.other, { streaming: false }));
    await waitFor(() => screen.has(s.guild.id), 'offered inside the window');
  });

  test('a share that starts outside the window is not offered', async () => {
    at(EVENING);
    const s = await autoScene({ from: 9, to: 17 });
    share(s);
    await settle();
    assert.equal(screen.size + voice.size, 0);
  });

  test('overnight window 22-6 closes at 06:00', async () => {
    at('2026-11-09T16:00:00Z'); // 23:00
    const s = await autoScene({ from: 22, to: 6 });
    await autoOffer(s);
    mock.timers.setTime(new Date('2026-11-09T23:00:00Z').getTime()); // 06:00
    fire('voiceStateUpdate', ...moveMember(s.other, { streaming: false }));
    await oneResult(s, { video: false, name: 'overnight' });
  });

  test('a manual recording is never stopped by the window', async () => {
    at(NOON);
    const s = scene(bot);
    await updateSettings(s.guild.id, { autoScreen: true, from: 9, to: 17, mode: 'browser' });
    const rec = await manualLive(s);
    mock.timers.setTime(new Date(EVENING).getTime());
    rec.seen(); // the clock jumped 6 h: keep the heartbeat from treating the live page as gone
    fire('voiceStateUpdate', ...moveMember(fakeMember(s.guild, { name: 'late' }), { channel: s.room }));
    await settle();
    assert.ok(screen.get(s.guild.id) === rec && voice.has(s.guild.id));
  });

  test('auto voice for members: window closing ends the room recording once, with one card', async () => {
    at(NOON);
    const s = scene(bot);
    await updateSettings(s.guild.id, { autoVoice: 'members', minMembers: 2, from: 9, to: 17 });
    moveMember(fakeMember(s.guild, { name: 'B' }), { channel: s.room });
    fire('voiceStateUpdate', ...moveMember(s.member, { channel: s.room }));
    await waitFor(() => voice.has(s.guild.id), 'auto voice');
    mock.timers.setTime(new Date(EVENING).getTime());
    fire('voiceStateUpdate', ...moveMember(fakeMember(s.guild, { name: 'C' }), { channel: s.room }));
    await waitFor(() => !voice.has(s.guild.id), 'ended');
    await settle();
    assert.equal(resultsOf(s).length, 1);
    assert.match(content(lastOf(resultsOf(s)[0])), /นอกเวลาที่ตั้งไว้/);
  });
});

describe('restart cleanup', () => {
  const restart = async () => { bot._reset(); await fire('clientReady', bot.client); };

  test('cards of two servers, an offer card and a paired screen card are all marked, lists cleared', async () => {
    const a = await autoScene();
    const ra = await autoOffer(a);
    const b = scene(bot);
    const rb = await manualLive(b);
    await rb.cardQ;
    assert.equal(getSettings(a.guild.id).cards.length, 1);
    await restart();
    await waitFor(() => /บอทรีสตาร์ทระหว่างอัด/.test(content(lastOf(ra.card))) && /บอทรีสตาร์ทระหว่างอัด/.test(content(lastOf(rb.card))), 'both marked');
    assert.deepEqual(lastOf(ra.card).components, []);
    await waitFor(() => getSettings(a.guild.id).cards.length === 0 && getSettings(b.guild.id).cards.length === 0, 'lists cleared');
    bot._reset();
  });

  test('a card whose message or channel is gone does not break the sweep; the list is still cleared', async () => {
    const s = scene(bot);
    await updateSettings(s.guild.id, { cards: [['no-such-channel', '1'], [s.text.id, 'no-such-message']] });
    await restart();
    await waitFor(() => getSettings(s.guild.id).cards.length === 0, 'cleared');
    assert.deepEqual(logs.err.filter((e) => /Unhandled|TypeError/.test(e)), []);
    bot._reset();
  });

  test('editing is refused (permissions): still cleared, nothing thrown', async () => {
    const s = scene(bot);
    await press(s, 'record:start');
    const rec = voice.get(s.guild.id);
    await rec.cardQ;
    s.text.failEdit = true;
    await restart();
    await waitFor(() => getSettings(s.guild.id).cards.length === 0, 'cleared');
    bot._reset();
  });

  test('after a restart a new recording works and its card is remembered afresh', async () => {
    const s = scene(bot);
    await press(s, 'record:start');
    await restart();
    await waitFor(() => getSettings(s.guild.id).cards.length === 0, 'cleared');
    await press(s, 'record:start');
    const v = voice.get(s.guild.id);
    await v.cardQ;
    assert.equal(getSettings(s.guild.id).cards.length, 1);
    await press(s, `record:stop:${v.began}`, { message: v.card });
    await waitFor(() => getSettings(s.guild.id).cards.length === 0, 'forgotten after result');
    bot._reset();
  });

  test('nickname: originally none → restored to none after a restart, and from the file only once', async () => {
    const s = scene(bot);
    await press(s, 'record:start');
    await waitFor(() => s.guild.members.me.nickname?.includes('🔴'), 'tagged');
    await restart();
    await waitFor(() => s.guild.members.me.nickname === null, 'restored to no nickname');
    assert.equal(getSettings(s.guild.id).nickBefore, undefined, 'dropped from the file');
    bot._reset();
  });

  test('nickname: restored on every stop path, including max length and a dropped bot', async () => {
    for (const how of ['max', 'dropped', 'panel']) {
      bot._reset(); resetFakes();
      const s = scene(bot);
      s.guild.members.me.nickname = 'Keep Me';
      if (how === 'max') await updateSettings(s.guild.id, { maxMinutes: 0.001 });
      await press(s, 'record:start');
      const v = voice.get(s.guild.id);
      await waitFor(() => s.guild.members.me.nickname?.includes('🔴') || how === 'max', 'tagged');
      if (how === 'dropped') v.onGone();
      if (how === 'panel') await press(s, 'record:stop');
      await waitFor(() => !voice.has(s.guild.id), `${how} ended`);
      await waitFor(() => s.guild.members.me.nickname === 'Keep Me', `${how}: nickname back`);
    }
  });

  test('nickname: another recording starting right after a stop does not lose the original name', async () => {
    const s = scene(bot);
    s.guild.members.me.nickname = 'Original';
    for (let n = 0; n < 3; n++) {
      await press(s, 'record:start');
      const v = voice.get(s.guild.id);
      await press(s, `record:stop:${v.began}`, { message: v.card });
    }
    await waitFor(() => s.guild.members.me.nickname === 'Original', 'original after 3 rapid cycles');
  });
});

after(() => { void tmp; void deferred; void fakeGuild; void fakeTextChannel; });
