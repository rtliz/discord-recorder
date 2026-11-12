import './helpers/env.js';
import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadBot, waitFor, sleep, scene, resetFakes } from './helpers/bot.js';
import { fakeInteraction, fakeMember, moveMember, FakeScreenRecorder } from './helpers/fakes.js';
import { startSession, pressRec } from './helpers/session.js';

// both host-Mac screen and browser capture available: with PUBLIC_URL only agent / browser are used (the Mac is hidden)

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
  await updateSettings(s.guild.id, { shareCards: true, minMembers: 2, minShareSeconds: 0, mode });
  moveMember(fakeMember(s.guild, { name: 'Other' }), { channel: s.room });
  return s;
};

beforeEach(() => { bot._reset(); bot.client.guilds.cache.clear(); resetFakes(); uploads.length = 0; });
afterEach(() => sleep(80));
after(() => bot._reset());

// host-Mac capture is no longer selectable once PUBLIC_URL is set: the modes are agent / browser
test('host Mac + PUBLIC_URL: a saved screen/window reads as agent; 🔴 without an agent gives the link, never the host Mac', async () => {
  for (const mode of ['screen', 'window']) {
    const s = await autoScene(mode);
    assert.equal(getSettings(s.guild.id).mode, 'agent', mode);
    const sess = await startSession(bot, s);
    assert.equal(sess.cur.source, 'link', mode);
    assert.equal(FakeScreenRecorder.instances.length, 0, 'the host Mac never records');
    share(s, false);
    await waitFor(() => !screen.has(s.guild.id) && !voice.has(s.guild.id), 'ended');
  }
});

test('host Mac + PUBLIC_URL: config:mode only takes agent / browser', async () => {
  const s = await autoScene('browser');
  await press(s, 'config:mode', { kind: 'select', values: ['screen'] });
  assert.equal(getSettings(s.guild.id).mode, 'browser', 'screen refused');
  await press(s, 'config:mode', { kind: 'select', values: ['agent'] });
  assert.equal(getSettings(s.guild.id).mode, 'agent');
});

test('an old screen:start button (host Mac) maps to 🖥️ อัดจอ: the presser\'s agent path, here the link with a note', async () => {
  const s = await autoScene('agent');
  const i = await press(s, 'screen:start');
  assert.match(i.replies[0].content, /^⚠️ เครื่องของคุณยังไม่ได้เปิดตัวอัด/);
  assert.equal(screen.get(s.guild.id).kind, 'browser');
  assert.equal(FakeScreenRecorder.instances.length, 0);
  await screen.get(s.guild.id).stop();
});

test('panel (D12): with PUBLIC_URL 🖥️ (agent) + 🌐 (link) whatever the mode; never the host-Mac button', async () => {
  const s = scene(bot);
  const btn = () => bot.panel(s.guild).components[0].toJSON().components.map((c) => c.custom_id);
  for (const mode of ['browser', 'agent', 'screen', 'window']) {
    await updateSettings(s.guild.id, { mode });
    assert.deepEqual(btn(), ['record:start', 'screen:me', 'screen:link'], mode);
  }
});
