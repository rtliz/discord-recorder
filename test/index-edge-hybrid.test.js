import './helpers/env.js';
import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadBot, waitFor, sleep, scene, resetFakes } from './helpers/bot.js';
import { fakeInteraction, fakeMember, moveMember, FakeScreenRecorder } from './helpers/fakes.js';

// both host-Mac screen and browser capture available: mode changes mid-recording, and which kinds share the one screen

const { bot, uploads, fire } = await loadBot({ SCREEN_ENABLED: 'true', PUBLIC_URL: 'http://localhost:1' });
const { updateSettings, getSettings } = await import('../src/settings.js');
const { voice, screen } = bot;
const press = (s, customId, extra = {}) => {
  const i = fakeInteraction({ guild: s.guild, member: s.member, channel: s.text, customId, ...extra });
  return fire('interactionCreate', i).then(() => i);
};
const share = (s, on = true) => fire('voiceStateUpdate', ...moveMember(s.member, { streaming: on }));
const autoScene = async (mode) => {
  const s = scene(bot);
  await updateSettings(s.guild.id, { autoScreen: true, minMembers: 2, minShareSeconds: 0, mode });
  moveMember(fakeMember(s.guild, { name: 'Other' }), { channel: s.room });
  return s;
};

beforeEach(() => { bot._reset(); bot.client.guilds.cache.clear(); resetFakes(); uploads.length = 0; });
afterEach(() => sleep(80));
after(() => bot._reset());

test('mode switched browser → screen while an offer runs: the offer stays, no Mac recorder starts', async () => {
  const s = await autoScene('browser');
  share(s);
  const g = s.guild.id;
  await waitFor(() => screen.get(g)?.paired, 'offer + paired');
  const rec = screen.get(g);
  await press(s, 'config:mode', { kind: 'select', values: ['screen'] });
  assert.equal(getSettings(g).mode, 'screen');
  await sleep(40);
  assert.ok(screen.get(g) === rec);
  assert.equal(FakeScreenRecorder.instances.length, 0);
  share(s, false);
  await waitFor(() => !screen.has(g) && !voice.has(g), 'ended');
});

test('mode switched screen → browser while the Mac records: the video goes on, the next share gets an offer', async () => {
  const s = await autoScene('screen');
  share(s);
  const g = s.guild.id;
  await waitFor(() => screen.get(g)?.paired, 'mac + paired');
  const rec = screen.get(g);
  assert.equal(rec.kind, 'mac');
  await press(s, 'config:mode', { kind: 'select', values: ['browser'] });
  await sleep(40);
  assert.ok(screen.get(g) === rec);
  share(s, false);
  await waitFor(() => !screen.has(g), 'ended');
  await sleep(60);
  share(s, true);
  await waitFor(() => screen.get(g)?.kind === 'browser', 'browser offer for the next share');
});

test('the Mac busy in one server does not block a browser offer in another, and browser offers do not make the Mac busy', async () => {
  const a = await autoScene('screen');
  const b = await autoScene('browser');
  const c = await autoScene('screen');
  share(a);
  await waitFor(() => screen.get(a.guild.id)?.kind === 'mac', 'A on the Mac');
  share(b);
  await waitFor(() => screen.get(b.guild.id)?.kind === 'browser', 'B offered despite the busy Mac');
  share(c);
  await sleep(60);
  assert.equal(screen.has(c.guild.id), false, 'C waits for the Mac');
  share(a, false);
  await waitFor(() => screen.get(c.guild.id)?.kind === 'mac', 'C gets the Mac when A is done');
});

test('a browser offer in A never blocks the Mac in B', async () => {
  const a = await autoScene('browser');
  const b = await autoScene('screen');
  share(a);
  await waitFor(() => screen.has(a.guild.id), 'A offered');
  share(b);
  await waitFor(() => screen.get(b.guild.id)?.kind === 'mac', 'B on the Mac');
});
