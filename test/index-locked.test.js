import './helpers/env.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadBot, scene, resetFakes } from './helpers/bot.js';
import { fakeInteraction, fakeMember, moveMember, parts } from './helpers/fakes.js';
import { assertDiscordLimits } from './helpers/limits.js';

// ALLOWED_USER_IDS replaces every permission check: the "anyone records" toggle must be hidden and inert

const { bot, fire } = await loadBot({ SCREEN_ENABLED: 'false', PUBLIC_URL: 'http://localhost:1', ALLOWED_USER_IDS: 'VIP, OTHER' });
const { getSettings, updateSettings } = await import('../src/settings.js');
const content = (p) => p?.content ?? '';
const press = (s, member, customId) => {
  const i = fakeInteraction({ guild: s.guild, member, channel: s.text, customId });
  return fire('interactionCreate', i).then(() => i);
};

beforeEach(() => { bot._reset(); bot.client.guilds.cache.clear(); resetFakes(); }); // checkAuto sweeps every cached guild
after(() => bot._reset());

test('the quick page has no ใครกดอัดได้ select when ALLOWED_USER_IDS is set (new quick page)', async () => {
  const s = scene(bot);
  s.member.user.id = 'VIP';
  const i = await press(s, s.member, 'config:open');
  const view = i.replies[0];
  const idsOf = parts(view).map((c) => c.custom_id);
  assert.ok(!idsOf.includes('config:anyone') && !idsOf.includes('config:who'));
  for (const id of ['config:share', 'config:mode', 'config:area', 'config:done']) assert.ok(idsOf.includes(id), id);
  assertDiscordLimits(view, 'quick page, locked');
});

test('config:anyone is ignored even from a listed user', async () => {
  const s = scene(bot);
  s.member.user.id = 'VIP';
  const i = await press(s, s.member, 'config:anyone');
  assert.equal(getSettings(s.guild.id).anyoneRecords, false);
  assert.ok(i.deferredUpdate, 'acknowledged, nothing changed');
});

test('anyoneRecords saved earlier does not open recording to unlisted users', async () => {
  const s = scene(bot, { admin: true }); // a Manage Server admin who is not on the list
  await updateSettings(s.guild.id, { anyoneRecords: true });
  const i = await press(s, s.member, 'record:start');
  assert.match(content(i.replies[0]), /^🔒 คุณยังกดอัดไม่ได้ — บอทนี้จำกัดให้เฉพาะรายชื่อ/);
  assert.doesNotMatch(content(i.replies[0]), /ทุกคนกดอัดได้/, 'no pointer to a toggle that is not there');
  assert.equal(bot.voice.size, 0);
  const guest = fakeMember(s.guild, { name: 'Guest' });
  guest.user.id = 'OTHER';
  moveMember(guest, { channel: s.room });
  const ok = await press(s, guest, 'record:start');
  assert.ok(ok.deferred, 'a listed user records');
});
