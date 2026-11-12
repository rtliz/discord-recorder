import './helpers/env.js';
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadBot, waitFor, sleep, scene, resetFakes } from './helpers/bot.js';
import { fakeInteraction, fakeMember, moveMember, FakeVoiceRecorder } from './helpers/fakes.js';
import { pressRec } from './helpers/session.js';

// QA of the "join at once + agent without asking" batch: gaps the other suites miss
const { bot, logs, fire, agents, composed } = await loadBot({ SCREEN_ENABLED: 'false', PUBLIC_URL: 'http://localhost:1' });
const { T } = await import('../src/browser-capture.js');
const { updateSettings } = await import('../src/settings.js');
Object.assign(T, { drainMax: 50, silent: 50, poll: 5 });
const { screen } = bot;
const press = async (s, customId, extra) => { const i = fakeInteraction({ guild: s.guild, member: s.member, channel: s.text, customId, ...extra }); await fire('interactionCreate', i); return i; };

beforeEach(() => { bot._reset(); bot.client.guilds.cache.clear(); resetFakes(); logs.err.length = 0; logs.out.length = 0; composed.calls.length = 0; });
after(() => bot._reset());

describe('manual 🖥️ (screen:me) whatever the mode setting', () => {
  test('mode=browser in settings: 🖥️ still commands the presser\'s own agent (CLAUDE.md: "whatever the mode setting")', async () => {
    const s = scene(bot, { name: 'Alice' });
    await updateSettings(s.guild.id, { mode: 'browser' });
    s.b = fakeMember(s.guild, { name: 'Bob' }); moveMember(s.b, { channel: s.room });
    agents.setOnline(s.member.id);
    await press(s, 'screen:me');
    await waitFor(() => screen.get(s.guild.id), 'session');
    await sleep(100);
    assert.equal(agents.calls.length, 1, '🖥️ must use the presser\'s agent');
  });
});

describe('failed join racing a failing agent', () => {
  test('join fails while the agent ack is pending, then the agent declines: link is unopened and there is no audio -> expected cancel', async () => {
    const s = scene(bot, { name: 'Alice' });
    await updateSettings(s.guild.id, { shareMode: 'card', minMembers: 1, minShareSeconds: 0, mode: 'agent' });
    agents.setOnline(s.member.id);
    agents.startMode = 'hold';
    FakeVoiceRecorder.startHook = () => { throw new Error('join timeout'); };
    const share = bot.client.listeners('voiceStateUpdate')[0];
    share(...moveMember(s.member, { streaming: true }));
    pressRec(bot, s).catch(() => {});
    await waitFor(() => agents.pending.length, 'agent start held');
    await sleep(50); // join has failed meanwhile
    agents.ack('declined');
    await sleep(200);
    const sess = screen.get(s.guild.id);
    FakeVoiceRecorder.startHook = null;
    assert.ok(!sess || sess.finished, 'nothing records (no audio, link unopened): the session should be cancelled, got ' + (sess && `${sess.state}/${sess.cur?.source}`));
  });
});

describe('stop before the agent ack', () => {
  test('⏹️ while the ack is held, then an ok ack: nothing leaks, the agent is told to stop, a new session can start', async () => {
    const s = scene(bot, { name: 'Alice' });
    await updateSettings(s.guild.id, { shareMode: 'card', minMembers: 1, minShareSeconds: 0, mode: 'agent' });
    agents.setOnline(s.member.id);
    agents.startMode = 'hold';
    bot.client.listeners('voiceStateUpdate')[0](...moveMember(s.member, { streaming: true }));
    pressRec(bot, s).catch(() => {});
    await waitFor(() => agents.pending.length, 'held');
    const sess = screen.get(s.guild.id);
    await sleep(30);
    await press(s, `screen:stop:${sess.began}`, { message: sess.card });
    await waitFor(() => sess.finished, 'finished');
    const call = agents.ack('ok');
    await sleep(300);
    assert.ok(agents.stops.some((x) => x.capId === call.capId), 'agent told to stop');
    assert.equal(screen.has(s.guild.id), false);
    assert.equal(bot.voice.has(s.guild.id), false, 'no stray voice recording');
    const errs = logs.err.map(String).filter((x) => !/join/.test(x));
    assert.deepEqual(errs, []);
  });
});
