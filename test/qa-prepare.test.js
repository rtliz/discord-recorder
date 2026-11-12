import './helpers/env.js';
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadBot, waitFor, sleep, scene, resetFakes } from './helpers/bot.js';
import { fakeMember, moveMember, FakeVoiceRecorder } from './helpers/fakes.js';
import { pressRec } from './helpers/session.js';

// QA: prepare-mode (room audio only from the first live video) edge cases

const { bot, uploads, agents, composed, share } = await loadBot({ SCREEN_ENABLED: 'false', PUBLIC_URL: 'http://localhost:1' });
const { T } = await import('../src/browser-capture.js');
const { updateSettings } = await import('../src/settings.js');
Object.assign(T, { drainMax: 50, silent: 50, poll: 5 });
const { voice, screen } = bot;

const cardScene = async () => {
  const s = scene(bot, { name: 'Alice' });
  await updateSettings(s.guild.id, { shareCards: true, minMembers: 2, minShareSeconds: 0, mode: 'agent' });
  s.b = fakeMember(s.guild, { name: 'Bob' });
  moveMember(s.b, { channel: s.room });
  return s;
};
beforeEach(() => { bot._reset(); bot.client.guilds.cache.clear(); resetFakes(); uploads.length = 0; composed.calls.length = 0; });
after(() => bot._reset());

describe('QA prepare', () => {
  test('agent claims (live) then its ack fails: that discarded video must not start the room audio', async () => {
    const s = await cardScene();
    const g = s.guild.id;
    agents.setOnline(s.b.id);
    agents.startMode = 'hold';
    share(s.b);
    const pressing = pressRec(bot, s, s.b.id);
    await waitFor(() => agents.pending.length === 1, 'commanded');
    const call = agents.pending[0], orig = call.resolve;
    call.resolve = () => orig({ ok: false, error: 'ffmpeg' }); // claimed, then the ack reports a failure
    agents.ack('ok');
    await pressing;
    const sess = screen.get(g);
    await sleep(60);
    const v = sess?.paired ?? FakeVoiceRecorder.instances[0];
    assert.ok(v, 'joined');
    assert.equal(v.recording, false, 'audio must not record: the only video was discarded (no video ever went live)');
  });

  test('nobody spoke: compose origin must be the first video live, not the session start (prepare time = black head)', async () => {
    const s = await cardScene();
    const g = s.guild.id;
    agents.setOnline(s.b.id);
    agents.startMode = 'hold';
    share(s.b);
    const pressing = pressRec(bot, s, s.b.id);
    await waitFor(() => agents.pending.length === 1, 'commanded');
    await sleep(150); // prepare lasts a while
    FakeVoiceRecorder.instances[0].nobodySpoke = true;
    agents.ack('ok');
    await pressing;
    const sess = await waitFor(() => screen.get(g)?.cur && screen.get(g), 'live');
    await waitFor(() => sess.paired?.recording, 'audio');
    const liveAt = sess.cur.rec.liveAt;
    share(s.b, false);
    await waitFor(() => composed.calls.length === 1, 'composed', 3000);
    const c = composed.calls[0];
    assert.equal(c.audio, null);
    assert.equal(c.audioStart, liveAt, `origin ${liveAt - c.audioStart}ms before the video`);
  });
});
