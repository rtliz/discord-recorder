import './helpers/env.js';
process.env.PUBLIC_URL = 'https://rec.example.com'; // settings read it at import: modes are agent / browser
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDiscordLimits } from './helpers/limits.js';

const { getSettings, updateSettings } = await import('../src/settings.js');
const ui = await import('../src/config-ui.js');
const { configView, quickPage, detailPage, applyConfig, cardsLabel, shareModeOf, configPageOf, inSchedule, summary, label } = ui;

const ids = (n, base = 1000) => Array.from({ length: n }, (_, i) => String(base + i));
const cache = (keys) => ({ has: (k) => keys.includes(k) });
const guildOf = (id, channels = [], roles = []) => ({ id, channels: { cache: cache(channels) }, roles: { cache: cache(roles) } });

const PAGES = ['quick', 'limits', 'where', 'time', 'main', 'bogus'];
const MODES = [['screen', 'window'], ['agent', 'browser'], ['screen']];
const PUB = ['agent', 'browser']; // the modes with PUBLIC_URL
const VARIANTS = {
  fresh: { patch: {}, channels: [], roles: [] },
  legacy: { patch: { autoVoice: 'screen', autoScreen: true, mode: 'window' }, channels: [], roles: [] },
  deleted: { patch: { channels: ['gone1', 'gone2'], roles: ['gone3'], notifyChannel: 'gone4', managerRole: 'gone5' }, channels: [], roles: [] },
  many: { patch: { channels: ids(30), roles: ids(30, 5000), notifyChannel: '1', managerRole: '5000' }, channels: ids(30), roles: ids(30, 5000) },
  anyoneOn: { patch: { anyoneRecords: true, shareCards: true, autoVoice: 'members' }, channels: [], roles: [] },
  auto: { patch: { shareMode: 'auto', minMembers: 5 }, channels: [], roles: [] },
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

test('quick page (new): one select per setting, current value readable in it, then 🔧 / ✔️; 1–2 lines of text', async () => {
  await updateSettings('g-q', { shareMode: 'auto', mode: 'agent', area: 'screen', anyoneRecords: false });
  const v = configView(guildOf('g-q'), 'quick', { screenEnabled: true, modes: PUB });
  const rows = assertDiscordLimits(v, 'quick').map((r) => r.components);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((r) => r[0].custom_id), ['config:share', 'config:mode', 'config:area', 'config:who', 'config:page-limits']);
  assert.deepEqual(rows[4].map((c) => [c.custom_id, c.label]), [['config:page-limits', '🔧 ตั้งค่าเพิ่มเติม'], ['config:done', '✔️ เสร็จ']]);
  const chosen = rows.slice(0, 4).map((r) => r[0].options.find((o) => o.default).label);
  assert.deepEqual(chosen, ['เมื่อมีคนแชร์จอ: ⚡ อัดอัตโนมัติ', 'อัดจอด้วย: 🖥️ ตัวอัดในเครื่อง',
    'กรอบอัด: 🖼️ ทั้งหน้าจอ', 'ใครกดอัดได้: 🔑 เฉพาะผู้ดูแล (และ role ที่ตั้งไว้)']);
  assert.deepEqual(rows[0][0].options.map((o) => o.value), ['auto', 'card', 'off']);
  assert.deepEqual(rows[1][0].options.map((o) => o.value), ['agent', 'browser'], 'exactly two screen modes');
  assert.deepEqual(rows[1][0].options.map((o) => o.label), ['อัดจอด้วย: 🖥️ ตัวอัดในเครื่อง', 'อัดจอด้วย: 🌐 เบราว์เซอร์']);
  assert.deepEqual(rows[2][0].options.map((o) => o.value), ['screen', 'discord']);
  assert.deepEqual(rows[3][0].options.map((o) => o.value), ['admins', 'all']);
  for (const row of rows.slice(0, 4)) for (const o of row[0].options) assert.ok(o.description && o.description.length <= 100, o.label);
  assert.ok(v.content.split('\n').length <= 2, v.content);
  assert.match(v.content, /⚙️ \*\*ตั้งค่าการอัด \(server นี้\)\*\*/);
  await updateSettings('g-q', { shareMode: 'card', mode: 'browser', area: 'discord', anyoneRecords: true });
  const again = configView(guildOf('g-q'), 'quick', { screenEnabled: true, modes: PUB }).components.slice(0, 3)
    .map((r) => r.toJSON().components[0].options.find((o) => o.default).value);
  assert.deepEqual(again, ['card', 'browser', 'all'], 'browser mode: no กรอบอัด select (the sharer picks it in the browser)');
});

test('quick page hiding rules: no PUBLIC_URL hides อัดจอด้วย and กรอบอัด; ALLOWED_USER_IDS hides ใครกดอัดได้; no screen hides the share select', () => {
  const idsOf = (o) => configView(guildOf('g-h'), 'quick', o).components.map((r) => r.toJSON().components[0].custom_id);
  assert.deepEqual(idsOf({ screenEnabled: true, modes: ['screen', 'window'] }), ['config:share', 'config:who', 'config:page-limits']);
  assert.deepEqual(idsOf({ screenEnabled: true, modes: PUB, lockedUsers: true }), ['config:share', 'config:mode', 'config:area', 'config:page-limits']);
  assert.deepEqual(idsOf({ screenEnabled: false, modes: [] }), ['config:who', 'config:page-limits']);
});

test('intro is prepended and mentions stay disabled', () => {
  const v = configView(guildOf('g-i'), 'quick', { screenEnabled: true, intro: 'HELLO\n' });
  assert.ok(v.content.startsWith('HELLO\n'));
  assert.deepEqual(v.allowedMentions, { parse: [] });
});

test('no presets, preset buttons or voice select anywhere', async () => {
  assert.equal(ui.presets, undefined);
  assert.equal(ui.presetOf, undefined);
  assert.equal(ui.presetLabel, undefined);
  const g = guildOf('g-np');
  for (const page of PAGES) {
    const json = JSON.stringify(configView(g, page, { screenEnabled: true, modes: PUB }).components.map((r) => r.toJSON()));
    assert.ok(!json.includes('config:preset-') && !json.includes('config:voice') && !json.includes('config:auto"'), page);
  }
});

test('cardsLabel (3-way)', () => {
  assert.equal(cardsLabel({ shareCards: true }), '📣 เมื่อมีคนแชร์จอ: **ส่งการ์ด**'); // no shareMode: the old boolean
  assert.equal(cardsLabel({ shareCards: false }), '📣 เมื่อมีคนแชร์จอ: **ปิด**');
  assert.equal(cardsLabel({ shareMode: 'auto', shareCards: true }), '📣 เมื่อมีคนแชร์จอ: **อัดอัตโนมัติ**');
  assert.equal(cardsLabel({ shareMode: 'auto', shareCards: true }, false), '📣 เมื่อมีคนแชร์จอ: **ส่งการ์ด**');
  assert.equal(shareModeOf({ shareMode: 'off', shareCards: true }), 'off', 'shareMode wins');
  assert.equal(shareModeOf({ shareMode: 'auto' }, false), 'card');
});

test('🔧 tabs (new): ◀️ กลับ first, then the tabs; options prefixed with the setting name and described; nothing from the quick page', async () => {
  await updateSettings('g-m', { minMembers: 3, minShareSeconds: 10, maxMinutes: 240 });
  for (const page of ['limits', 'where', 'time']) {
    const rows = configView(guildOf('g-m'), page, { screenEnabled: true, modes: PUB }).components.map((r) => r.toJSON().components);
    assert.deepEqual(rows[0].map((c) => c.custom_id), ['config:page-quick', 'config:page-limits', 'config:page-where', 'config:page-time'], page);
    assert.equal(rows[0][0].label, '◀️ กลับ');
    const ids = rows.slice(1).map((r) => r[0].custom_id);
    for (const dup of ['config:share', 'config:mode', 'config:area', 'config:who']) assert.ok(!ids.includes(dup), `${page} repeats ${dup}`);
  }
  const lim = configView(guildOf('g-m'), 'limits', { screenEnabled: true, modes: PUB }).components.map((r) => r.toJSON().components[0]);
  assert.deepEqual(lim.slice(1).map((c) => c.custom_id), ['config:min', 'config:delay', 'config:max']);
  assert.equal(lim[1].options.find((o) => o.default).label, 'คนในห้อง: 3 คนขึ้นไป');
  assert.equal(lim[2].options.find((o) => o.default).label, 'แชร์นานก่อน: 10 วินาที');
  assert.equal(lim[3].options.find((o) => o.default).label, 'ยาวสุด: 4 ชั่วโมง');
  for (const c of lim.slice(1)) for (const o of c.options) assert.ok(o.description, o.label);
  // a bot without PUBLIC_URL keeps the host Mac's screen/window choice here
  const mac = configView(guildOf('g-m'), 'limits', { screenEnabled: true, modes: ['screen', 'window'] }).components.map((r) => r.toJSON().components[0]);
  assert.equal(mac.at(-1).custom_id, 'config:macmode');
  assert.deepEqual(mac.at(-1).options.map((o) => o.value), ['screen', 'window']);
  const time = configView(guildOf('g-m'), 'time', { screenEnabled: true, modes: PUB }).components.map((r) => r.toJSON().components[0]);
  assert.equal(time[2].options.find((o) => o.default).label, 'ตั้งแต่: 00:00');
});

test('configPageOf: new and old ids land on a page (old buttons re-render sensibly)', () => {
  const m = { share: 'quick', mode: 'quick', area: 'quick', who: 'quick', 'share-off': 'quick', 'share-card': 'quick', 'share-auto': 'quick',
    cards: 'quick', 'cards-main': 'quick', anyone: 'quick', min: 'limits', delay: 'limits', max: 'limits', macmode: 'limits',
    channels: 'where', roles: 'where', notify: 'where', manager: 'where', days: 'time', from: 'time', to: 'time', unknown: 'quick' };
  for (const [sub, page] of Object.entries(m)) assert.equal(configPageOf(sub), page, sub);
  // an old page id (main, from an old message) shows the quick page
  const v = configView(guildOf('g-old'), 'main', { screenEnabled: true, modes: PUB });
  assert.equal(v.components[0].toJSON().components[0].custom_id, 'config:share');
});

test('labels', () => {
  assert.equal(label.min(1), 'ส่งการ์ดทันทีที่มีคนแชร์จอ');
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
  assert.equal(label.delay(0), 'ส่งการ์ดทันทีที่แชร์');
  assert.ok(label.delay(15).includes('15'));
  assert.equal(label.voice, undefined);
});

test('summary reflects settings and hides the cards line when screen is disabled (3-way)', async () => {
  await updateSettings('g-sum', { shareCards: true, minMembers: 3, mode: 'browser' });
  const on = summary(guildOf('g-sum'), { screenEnabled: true, modes: PUB });
  assert.ok(on.includes(label.mode('browser')) && on.includes('กรอบ: ทั้งหน้าจอ'), on);
  assert.ok(on.includes('📣 เมื่อมีคนแชร์จอ: **ส่งการ์ด**') && on.includes('3 คน'));
  assert.ok(!on.includes('เสียง:'), 'no auto voice line any more');
  await updateSettings('g-sum', { shareMode: 'auto' });
  assert.ok(summary(guildOf('g-sum'), { screenEnabled: true, modes: ['browser'] }).includes('📣 เมื่อมีคนแชร์จอ: **อัดอัตโนมัติ**'));
  await updateSettings('g-sum', { shareMode: 'off' });
  assert.ok(summary(guildOf('g-sum'), { screenEnabled: true }).includes('📣 เมื่อมีคนแชร์จอ: **ปิด**'));
  const off = summary(guildOf('g-sum'), { screenEnabled: false });
  assert.ok(!off.includes('เมื่อมีคนแชร์จอ'));
  // a saved mode that is no longer offered falls back to the first one
  await updateSettings('g-sum2', { shareCards: true, mode: 'window' });
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

test('summary: 🔑 line says everyone when anyoneRecords', async () => {
  await updateSettings('g-sa', { anyoneRecords: true, managerRole: '5' });
  assert.ok(summary(guildOf('g-sa'), { screenEnabled: true }).includes('🔑 กดอัดได้: **ทุกคน**'));
  await updateSettings('g-sa', { anyoneRecords: false });
  assert.ok(summary(guildOf('g-sa'), { screenEnabled: true }).includes('ผู้ดูแล + <@&5>'));
});

test('quickPage / detailPage / applyConfig (pure API)', () => {
  const s = { shareMode: 'card', mode: 'browser', area: 'discord', anyoneRecords: true, minMembers: 2, minShareSeconds: 10, maxMinutes: 240, days: [1], from: 0, to: 24, channels: [], roles: [] };
  const q = quickPage(s, { screenEnabled: true, browser: true });
  assertDiscordLimits(q, 'quickPage');
  assert.deepEqual(q.components.slice(0, 3).map((r) => r.toJSON().components[0].options.find((o) => o.default).value), ['card', 'browser', 'all']);
  const qa = quickPage({ ...s, mode: 'agent' }, { screenEnabled: true, browser: true }); // the agent: กรอบอัด shown
  assert.deepEqual(qa.components.slice(0, 4).map((r) => r.toJSON().components[0].options.find((o) => o.default).value), ['card', 'agent', 'discord', 'all']);
  assertDiscordLimits(detailPage(s, { screenEnabled: true, browser: true }, 'where'), 'detail');
  const O = { screenEnabled: true, browser: true, locked: false };
  const cases = [
    ['config:share', ['auto'], { shareMode: 'auto' }], ['config:share', ['loud'], null],
    ['config:mode', ['browser'], { mode: 'browser' }], ['config:mode', ['screen'], null],
    ['config:area', ['discord'], { area: 'discord' }], ['config:area', ['window'], null],
    ['config:who', ['all'], { anyoneRecords: true }], ['config:who', ['admins'], { anyoneRecords: false }], ['config:who', ['x'], null],
    ['config:anyone', [], { anyoneRecords: false }], ['config:cards', [], { shareMode: 'off' }],
    ['config:min', ['3'], { minMembers: 3 }], ['config:min', [], null], ['config:delay', ['0'], { minShareSeconds: 0 }],
    ['config:max', ['0'], { maxMinutes: 0 }], ['config:days', ['3', '1'], { days: [1, 3] }],
    ['config:from', ['5'], { from: 5 }], ['config:to', ['6'], { to: 6 }],
    ['config:channels', ['1', '2'], { channels: ['1', '2'] }], ['config:notify', [], { notifyChannel: null }], ['config:manager', ['9'], { managerRole: '9' }],
    ['config:preset-x', [], null], ['config:done', [], null], ['config:page-limits', [], null],
  ];
  for (const [id, v, want] of cases) assert.deepEqual(applyConfig(id, v, s, O), want, id);
  assert.equal(applyConfig('config:who', ['all'], s, { ...O, locked: true }), null, 'locked: ALLOWED_USER_IDS replaces it');
  assert.equal(applyConfig('config:mode', ['browser'], s, { ...O, browser: false }), null);
  assert.equal(applyConfig('config:share', ['auto'], s, { ...O, screenEnabled: false }), null);
  assert.deepEqual(applyConfig('config:macmode', ['window'], s, { ...O, browser: false }), { mode: 'window' });
  for (const id of ['preset-x', 'open', 'bogus', 'page-quick']) assert.equal(configPageOf(id), id === 'page-quick' ? 'quick' : 'quick', id);
});
