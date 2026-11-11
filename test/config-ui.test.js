import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDiscordLimits } from './helpers/limits.js';

const { getSettings, updateSettings } = await import('../src/settings.js');
const ui = await import('../src/config-ui.js');
const { configView, presets, presetOf, presetLabel, configPageOf, inSchedule, summary, label } = ui;

const ids = (n, base = 1000) => Array.from({ length: n }, (_, i) => String(base + i));
const cache = (keys) => ({ has: (k) => keys.includes(k) });
const guildOf = (id, channels = [], roles = []) => ({ id, channels: { cache: cache(channels) }, roles: { cache: cache(roles) } });

const PAGES = ['quick', 'main', 'where', 'time', 'limits', 'bogus'];
const MODES = [['screen', 'window'], ['browser'], ['screen', 'window', 'browser']];
const VARIANTS = {
  fresh: { patch: {}, channels: [], roles: [] },
  legacy: { patch: { autoVoice: 'screen', mode: 'window' }, channels: [], roles: [] },
  deleted: { patch: { channels: ['gone1', 'gone2'], roles: ['gone3'], notifyChannel: 'gone4', managerRole: 'gone5' }, channels: [], roles: [] },
  many: { patch: { channels: ids(30), roles: ids(30, 5000), notifyChannel: '1', managerRole: '5000' }, channels: ids(30), roles: ids(30, 5000) },
  anyoneOn: { patch: { anyoneRecords: true, autoScreen: true, autoVoice: 'members' }, channels: [], roles: [] },
  anyoneOff: { patch: { anyoneRecords: false, mode: 'browser', minShareSeconds: 0, maxMinutes: 0, from: 22, to: 6 }, channels: [], roles: [] },
};

test('every page x screenEnabled x modes x settings variant fits Discord limits', async () => {
  let n = 0;
  for (const [vname, v] of Object.entries(VARIANTS)) {
    const guild = guildOf(`g-${vname}`, v.channels, v.roles);
    await updateSettings(guild.id, v.patch);
    for (const screenEnabled of [true, false]) {
      for (const modes of MODES) {
        for (const page of PAGES) {
          for (const lockedUsers of [false, true]) {
            const what = `${vname}/${page}/screen=${screenEnabled}/${modes}/locked=${lockedUsers}`;
            const view = configView(guild, page, { screenEnabled, modes, intro: '', lockedUsers });
            assertDiscordLimits(view, what);
            assert.ok(view.content.length > 0, what);
            n++;
          }
        }
      }
    }
  }
  assert.ok(n > 400);
});

test('settings page 1 (main) stays within 5 rows even with screen enabled', async () => {
  const guild = guildOf('g-rows');
  const rows = assertDiscordLimits(configView(guild, 'main', { screenEnabled: true, modes: ['screen', 'window', 'browser'] }), 'main');
  assert.ok(rows.length <= 5);
});

test('intro is prepended and mentions stay disabled', () => {
  const v = configView(guildOf('g-i'), 'quick', { screenEnabled: true, intro: 'HELLO\n' });
  assert.ok(v.content.startsWith('HELLO\n'));
  assert.deepEqual(v.allowedMentions, { parse: [] });
});

for (const screenEnabled of [true, false]) {
  test(`presetOf round-trips each preset patch (screenEnabled=${screenEnabled})`, async () => {
    for (const [k, p] of Object.entries(presets(screenEnabled))) {
      const g = `g-preset-${screenEnabled}-${k}`;
      await updateSettings(g, p.patch);
      assert.equal(presetOf(getSettings(g), screenEnabled), k);
      assert.equal(presetLabel(getSettings(g), screenEnabled), p.text);
      const quick = configView(guildOf(g), 'quick', { screenEnabled });
      const btn = quick.components[0].toJSON().components.find((c) => c.custom_id === `config:preset-${k}`);
      assert.equal(btn.style, 3, 'current preset is highlighted (Success)');
      assert.ok(quick.content.includes(`▶ **${p.text}**`));
    }
  });
}

test("legacy autoVoice 'screen' is recognised as a preset, not custom", async () => {
  await updateSettings('g-legacy-p', { autoScreen: true, autoVoice: 'screen' });
  assert.equal(presetOf(getSettings('g-legacy-p'), true), 'share');
  await updateSettings('g-custom', { autoScreen: false, autoVoice: 'members' });
  assert.equal(presetOf(getSettings('g-custom'), true), null);
  assert.equal(presetLabel(getSettings('g-custom'), true), '🔧 กำหนดเอง');
  assert.ok(configView(guildOf('g-custom'), 'quick', { screenEnabled: true }).content.includes('กำหนดเอง'));
});

test('presets differ with screenEnabled', () => {
  assert.deepEqual(Object.keys(presets(true)), ['off', 'share', 'meeting']);
  assert.deepEqual(Object.keys(presets(false)), ['off', 'meeting']);
});

test('configPageOf maps every sub-action to its tab', () => {
  const m = { auto: 'main', min: 'main', mode: 'main', voice: 'main', channels: 'where', roles: 'where', notify: 'where', manager: 'where',
    days: 'time', from: 'time', to: 'time', delay: 'limits', max: 'limits', 'preset-share': 'quick', 'preset-off': 'quick', anyone: 'quick', unknown: 'main' };
  for (const [sub, page] of Object.entries(m)) assert.equal(configPageOf(sub), page, sub);
});

test('labels', () => {
  assert.equal(label.min(1), 'มีใครสักคนแชร์จอ');
  assert.ok(label.min(3).includes('3 คน'));
  assert.equal(label.days([0, 1, 2, 3, 4, 5, 6]), 'ทุกวัน');
  assert.equal(label.days([1, 2, 3, 4, 5]), 'จ–ศ');
  assert.equal(label.days([0, 6]), 'อา ส');
  assert.equal(label.hours({ from: 0, to: 24 }), 'ทั้งวัน');
  assert.equal(label.hours({ from: 5, to: 5 }), 'ทั้งวัน');
  assert.equal(label.hours({ from: 9, to: 17 }), '09:00–17:00');
  assert.equal(label.max(0), 'ไม่จำกัดความยาว');
  assert.equal(label.max(90), 'ยาวสุด 90 นาที');
  assert.equal(label.max(120), 'ยาวสุด 2 ชั่วโมง');
  assert.equal(label.delay(0), 'เริ่มอัดทันทีที่แชร์');
  assert.ok(label.delay(15).includes('15'));
  assert.ok(label.voice('screen', 2) && label.voice('screen', 2) === label.voice('off', 2));
});

test('summary reflects settings and hides screen line when screen is disabled', async () => {
  await updateSettings('g-sum', { autoScreen: true, minMembers: 3, mode: 'browser' });
  const on = summary(guildOf('g-sum'), { screenEnabled: true, modes: ['screen', 'browser'] });
  assert.ok(on.includes('🖥️ อัดจอ') && on.includes('3 คน'));
  const off = summary(guildOf('g-sum'), { screenEnabled: false });
  assert.ok(!off.includes('🖥️ อัดจอ'));
  // a saved mode that is no longer offered falls back to the first one
  await updateSettings('g-sum2', { autoScreen: true, mode: 'window' });
  assert.ok(summary(guildOf('g-sum2'), { screenEnabled: true, modes: ['browser'] }).includes(label.mode('browser')));
});

// --- inSchedule (TIMEZONE = Asia/Bangkok, UTC+7, no DST) ---
// 2026-03-02 is a Monday
const bkk = (iso) => new Date(`${iso}+07:00`);
const sched = (o) => ({ days: [0, 1, 2, 3, 4, 5, 6], from: 0, to: 24, ...o });

test('inSchedule: all day', () => {
  assert.equal(inSchedule(sched({}), bkk('2026-03-02T03:30:00')), true);
  assert.equal(inSchedule(sched({ from: 5, to: 5 }), bkk('2026-03-02T12:00:00')), true); // from===to = all day
  assert.equal(inSchedule(sched({ from: 0, to: 24 }), bkk('2026-03-02T23:59:59')), true);
});

test('inSchedule: 9-17 boundaries', () => {
  const s = sched({ from: 9, to: 17 });
  assert.equal(inSchedule(s, bkk('2026-03-02T08:59:00')), false);
  assert.equal(inSchedule(s, bkk('2026-03-02T09:00:00')), true);
  assert.equal(inSchedule(s, bkk('2026-03-02T16:59:59')), true);
  assert.equal(inSchedule(s, bkk('2026-03-02T17:00:00')), false);
});

test('inSchedule: overnight 22-6', () => {
  const s = sched({ from: 22, to: 6 });
  assert.equal(inSchedule(s, bkk('2026-03-02T23:00:00')), true);
  assert.equal(inSchedule(s, bkk('2026-03-03T05:59:00')), true);
  assert.equal(inSchedule(s, bkk('2026-03-03T06:00:00')), false);
  assert.equal(inSchedule(s, bkk('2026-03-03T12:00:00')), false);
  assert.equal(inSchedule(s, bkk('2026-03-02T22:00:00')), true);
  assert.equal(inSchedule(s, bkk('2026-03-02T21:59:00')), false);
});

test('inSchedule: day filter uses local midnight, not UTC', () => {
  const monOnly = sched({ days: [1] });
  // Mon 00:30 Bangkok = Sun 17:30 UTC -> still Monday locally
  assert.equal(inSchedule(monOnly, bkk('2026-03-02T00:30:00')), true);
  // Mon 23:30 Bangkok = Mon 16:30 UTC; Tue 00:30 Bangkok = Mon 17:30 UTC -> Tuesday locally
  assert.equal(inSchedule(monOnly, bkk('2026-03-02T23:30:00')), true);
  assert.equal(inSchedule(monOnly, bkk('2026-03-03T00:30:00')), false);
  const sunOnly = sched({ days: [0] });
  assert.equal(inSchedule(sunOnly, bkk('2026-03-01T00:10:00')), true); // Sun 00:10 local = Sat 17:10 UTC
  assert.equal(inSchedule(sunOnly, bkk('2026-02-28T23:50:00')), false);
  assert.equal(inSchedule(sched({ days: [] }), bkk('2026-03-02T12:00:00')), false);
});

test('presets: browser mode changes only the share help; Mac text unchanged; mode optional', () => {
  const mac = presets(true).share.help;
  assert.equal(presets(true, 'screen').share.help, mac);
  assert.equal(presets(true, 'window').share.help, mac);
  assert.equal(presets(true, 'browser').share.help, 'มีคนแชร์จอ บอทเข้าห้องอัดเสียง แล้วส่งปุ่มให้คนแชร์กดอัดจอ');
  assert.notEqual(presets(true, 'browser').share.help, mac);
  assert.deepEqual(presets(true, 'browser').off, presets(true).off);
  assert.deepEqual(Object.keys(presets(false, 'browser')), ['off', 'meeting']);
});

test('quick view uses the browser share help when the effective mode is browser', async () => {
  await updateSettings('g-qb', { mode: 'browser' });
  const v = configView(guildOf('g-qb'), 'quick', { screenEnabled: true, modes: ['browser'] });
  assert.ok(v.content.includes(presets(true, 'browser').share.help));
  const m = configView(guildOf('g-qm'), 'quick', { screenEnabled: true, modes: ['screen', 'window'] });
  assert.ok(m.content.includes(presets(true).share.help));
});

test('quick view: anyone toggle in row 2 between detail and done; hidden when lockedUsers', async () => {
  const row2 = (g, o) => configView(guildOf(g), 'quick', { screenEnabled: true, ...o }).components[1].toJSON().components;
  await updateSettings('g-any', { anyoneRecords: false });
  let r = row2('g-any', {});
  assert.deepEqual(r.map((c) => c.custom_id), ['config:page-main', 'config:anyone', 'config:done']);
  assert.equal(r[1].label, '🔑 เฉพาะผู้ดูแลกดอัด');
  assert.equal(r[1].style, 2);
  await updateSettings('g-any', { anyoneRecords: true });
  r = row2('g-any', {});
  assert.equal(r[1].label, '👥 ทุกคนกดอัดได้');
  assert.equal(r[1].style, 3);
  r = row2('g-any', { lockedUsers: true });
  assert.deepEqual(r.map((c) => c.custom_id), ['config:page-main', 'config:done']);
});

test('summary: 🔑 line says everyone when anyoneRecords', async () => {
  await updateSettings('g-sa', { anyoneRecords: true, managerRole: '5' });
  assert.ok(summary(guildOf('g-sa'), { screenEnabled: true }).includes('🔑 กดอัดได้: **ทุกคน**'));
  await updateSettings('g-sa', { anyoneRecords: false });
  assert.ok(summary(guildOf('g-sa'), { screenEnabled: true }).includes('ผู้ดูแล + <@&5>'));
});
