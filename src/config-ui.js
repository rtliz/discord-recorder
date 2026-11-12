import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, ChannelType,
} from 'discord.js';
import { getSettings, SHARE_MODES } from './settings.js';

const { SCREEN_WINDOW_APP = 'Discord', TIMEZONE = 'Asia/Bangkok' } = process.env;

const DAYS = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
const hh = (h) => `${String(h).padStart(2, '0')}:00`;

export const label = {
  min: (n) => (n <= 1 ? 'ส่งการ์ดทันทีที่มีคนแชร์จอ' : `ส่งการ์ดเมื่อในห้องมี ${n} คนขึ้นไป`),
  // agent / browser: the choices with PUBLIC_URL; screen / window (host Mac) only for a bot without it
  mode: (m) => ({ agent: 'อัดหน้าจอในเครื่อง (ต้องติดตั้งตัวอัดหน้าจอ)', browser: 'อัดผ่านเบราว์เซอร์',
    window: `อัดหน้าต่าง ${SCREEN_WINDOW_APP} บนเครื่องที่รันบอท` }[m] ?? 'อัดทั้งจอของเครื่องที่รันบอท'),
  days: (d) => (d.length === 7 ? 'ทุกวัน' : d.join() === '1,2,3,4,5' ? 'จ–ศ' : d.map((x) => DAYS[x]).join(' ')),
  hours: (s) => (s.from === s.to || (s.from === 0 && s.to === 24) ? 'ทั้งวัน' : `${hh(s.from)}–${hh(s.to)}`),
  area: (a) => (a === 'discord' ? 'แค่หน้าต่าง Discord' : 'ทั้งหน้าจอ'),
  delay: (n) => (n ? `แชร์ต่อเนื่อง ${n} วินาทีก่อนส่งการ์ด` : 'ส่งการ์ดทันทีที่แชร์'),
  max: (n) => (!n ? 'ไม่จำกัดความยาว' : n % 60 ? `ยาวสุด ${n} นาที` : `ยาวสุด ${n / 60} ชั่วโมง`),
};

/** is `now` inside the server's recording schedule (days + hours, in TIMEZONE) */
export function inSchedule(s, now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE, weekday: 'short', hour: 'numeric', hourCycle: 'h23',
  }).formatToParts(now).map((x) => [x.type, x.value]));
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  const h = Number(p.hour);
  if (!s.days.includes(day)) return false;
  if (s.from === s.to || (s.from === 0 && s.to === 24)) return true;
  return s.from < s.to ? h >= s.from && h < s.to : h >= s.from || h < s.to; // from > to: overnight
}

// what a share does (settings.shareMode): nothing, a 🔴 card (nothing records until pressed), or record at once (the
// bot joins and records the room; the screen from the sharer's agent, else the 🎥 link or the host Mac)
const SHARE = { off: ['⚪ ปิด', 'ปิด', 'ไม่ส่งการ์ด ไม่อัด'], card: ['📣 ส่งการ์ด', 'ส่งการ์ด', 'รอคนกด 🔴 ก่อนอัด'],
  auto: ['⚡ อัดอัตโนมัติ', 'อัดอัตโนมัติ', 'มีคนแชร์จอก็อัดเลย บอทเข้าห้องอัดเสียงด้วย'] };
/** the share mode in effect: 'auto' without screen recording works like 'card' */
export const shareModeOf = (s, auto = true) => {
  const m = s.shareMode ?? (s.shareCards ? 'card' : 'off');
  return m === 'auto' && !auto ? 'card' : m;
};
/** one line for the panel, summary and quick page */
export const cardsLabel = (s, auto = true) => `📣 เมื่อมีคนแชร์จอ: **${SHARE[shareModeOf(s, auto)][1]}**`;

const DEFAULT_MODES = ['screen', 'window'];
// a saved mode that is no longer offered (e.g. host-Mac modes switched off) falls back to the first one
const effectiveMode = (s, modes) => (modes.includes(s.mode) ? s.mode : modes[0]);
const hasArea = (modes) => modes.includes('agent') || modes.includes('browser');

export function summary(guild, { screenEnabled, modes = DEFAULT_MODES }) {
  const s = getSettings(guild.id);
  const ids = (xs, fmt, all) => (xs.length ? xs.map(fmt).join(' ') : all);
  return [
    ...(screenEnabled ? [`> ${cardsLabel(s, screenEnabled)}${s.shareCards ? ` — **${label.min(s.minMembers)}** · ${label.mode(effectiveMode(s, modes))}${hasArea(modes) ? ` · กรอบ: ${label.area(s.area)}` : ''}` : ''}`] : []),
    `> 📍 ห้อง: ${ids(s.channels, (x) => `<#${x}>`, '**ทุกห้องเสียง**')} · 👤 คนแชร์: ${ids(s.roles, (x) => `<@&${x}>`, '**ทุกคน**')}`,
    `> 📣 แจ้งผลที่: ${s.notifyChannel ? `<#${s.notifyChannel}>` : '**แชทของห้องเสียง**'} · 🔑 กดอัดได้: ${s.anyoneRecords ? '**ทุกคน**' : s.managerRole ? `ผู้ดูแล + <@&${s.managerRole}>` : '**ผู้ดูแล server**'}`,
    `> 🕘 เวลา: **${label.days(s.days)} ${label.hours(s)}** (${TIMEZONE})`,
    `> ⏳ **${label.delay(s.minShareSeconds)}** · ⏱️ **${label.max(s.maxMinutes)}**`,
  ].join('\n');
}

// 🔧 ตั้งค่าเพิ่มเติม: three tabs behind the quick page (◀️ กลับ returns to it). Nothing here repeats the quick page
const PAGES = [['limits', '⏳ เงื่อนไข'], ['where', '📍 ห้อง & คน'], ['time', '🕘 เวลา']];
const PAGE_OF = {
  share: 'quick', mode: 'quick', area: 'quick', who: 'quick', done: 'quick', back: 'quick', open: 'quick',
  // old ids an old message may still carry: the quick page's former buttons and toggles
  'share-off': 'quick', 'share-card': 'quick', 'share-auto': 'quick', cards: 'quick', 'cards-main': 'quick', anyone: 'quick',
  more: 'limits', min: 'limits', delay: 'limits', max: 'limits', macmode: 'limits',
  channels: 'where', roles: 'where', notify: 'where', manager: 'where',
  days: 'time', from: 'time', to: 'time',
};
/** which page to show after `config:<sub>`; unknown / old ids (and preset-*) show the quick page */
export const configPageOf = (sub) => PAGE_OF[sub] ?? (sub?.startsWith('page-') ? sub.slice(5) : 'quick');

const wrap = (menu) => new ActionRowBuilder().addComponents(menu);
// one setting per select: Discord shows no label next to a select, so every option starts with the setting's name
// (`name: value`) and the chosen one stays readable. options: [value, label, description?]
const select = (id, name, current, options, { multi = false } = {}) => wrap(new StringSelectMenuBuilder()
  .setCustomId(`config:${id}`).setPlaceholder(name)
  .setMinValues(1).setMaxValues(multi ? options.length : 1)
  .addOptions(options.map(([value, text, description]) => ({
    value: String(value), label: multi ? text : `${name}: ${text}`, ...(description ? { description } : {}),
    default: multi ? current.map(String).includes(String(value)) : String(value) === String(current),
  }))));
const btn = (id, text, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(`config:${id}`).setLabel(text).setStyle(style);

// the quick page's choices: [value, label, description]
const SHARE_OPTS = [['auto', '⚡ อัดอัตโนมัติ', 'บอทเข้าห้องและอัดทันทีที่มีคนแชร์จอ'],
  ['card', '📣 ส่งการ์ดให้กดอัด', 'ส่งการ์ด 🔴 ให้คนกดก่อนถึงจะอัด'],
  ['off', '⚪ ไม่ทำอะไร', 'ไม่ส่งการ์ด ไม่อัดเอง (ยังกดอัดจากแผงควบคุมได้)']];
const MODE_OPTS = [['agent', '🖥️ ตัวอัดในเครื่อง', 'ต้องติดตั้งตัวอัด เครื่องที่ยังไม่ติดตั้งจะได้ลิงก์เบราว์เซอร์แทน'],
  ['browser', '🌐 เบราว์เซอร์', 'ส่งลิงก์ให้เปิดใน Chrome ทุกครั้ง']];
const AREA_OPTS = [['screen', '🖼️ ทั้งหน้าจอ', 'อัดทั้งจอที่เลือกไว้'],
  ['discord', '💬 แค่หน้าต่าง Discord', 'ตัวอัดตัดเฉพาะหน้าต่าง Discord ตามตำแหน่งตอนเริ่มอัด']];
const WHO_OPTS = [['admins', '🔑 เฉพาะผู้ดูแล (และ role ที่ตั้งไว้)', 'ผู้ดูแล server และ role ที่ตั้งใน 🔧 ตั้งค่าเพิ่มเติม'],
  ['all', '👥 ทุกคน', 'ทุกคนกด 🎙️ 🖥️ ⏹️ ได้ (การตั้งค่ายังเป็นของผู้ดูแล)']];

/**
 * customId (`config:x` or `x`) + selected values + current settings -> the settings patch, or null (nothing to save:
 * unknown / old / navigation ids, or a choice that isn't available). The caller re-renders `configPageOf(sub)`.
 * opts: { screenEnabled, browser (PUBLIC_URL set), locked (ALLOWED_USER_IDS set), modes (the bot's offered modes;
 * default agent/browser with PUBLIC_URL, else the host-Mac ones) }. index.js handleConfig uses this table only
 */
export function applyConfig(customId, values = [], s = {}, { screenEnabled = true, browser = true, locked = false, modes = browser ? ['agent', 'browser'] : DEFAULT_MODES } = {}) {
  const sub = customId.replace(/^config:/, ''), v = values;
  const share = (m) => (SHARE_MODES.includes(m) && (m !== 'auto' || screenEnabled) ? { shareMode: m } : null);
  const num = (x) => (x == null || String(x).trim() === '' || !Number.isFinite(Number(x)) ? null : Number(x)); // NaN / empty: nothing saved
  const n = (key, x) => (num(x) === null ? null : { [key]: num(x) });
  return ({
    share: () => share(v[0]),
    'share-off': () => share('off'), 'share-card': () => share('card'), 'share-auto': () => share('auto'),
    cards: () => ({ shareMode: shareModeOf(s) === 'off' ? 'card' : 'off' }), // the old on/off toggles
    'cards-main': () => ({ shareMode: shareModeOf(s) === 'off' ? 'card' : 'off' }),
    mode: () => (modes.includes(v[0]) ? { mode: v[0] } : null), // host-Mac modes too, without PUBLIC_URL
    macmode: () => (modes.includes(v[0]) ? { mode: v[0] } : null),
    area: () => (browser && ['screen', 'discord'].includes(v[0]) ? { area: v[0] } : null),
    who: () => (locked || !['all', 'admins'].includes(v[0]) ? null : { anyoneRecords: v[0] === 'all' }),
    anyone: () => (locked ? null : { anyoneRecords: !s.anyoneRecords }), // the old toggle
    min: () => n('minMembers', v[0]),
    delay: () => n('minShareSeconds', v[0]),
    max: () => n('maxMinutes', v[0]),
    channels: () => ({ channels: v }),
    roles: () => ({ roles: v }),
    notify: () => ({ notifyChannel: v[0] ?? null }),
    manager: () => ({ managerRole: v[0] ?? null }),
    days: () => ({ days: [...new Set(v.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b) }),
    from: () => n('from', v[0]),
    to: () => n('to', v[0]),
  }[sub]?.()) ?? null;
}

/** the first page people see: one select per setting (the current value shown in it), then 🔧 / ✔️. At most 5 rows.
 *  opts: { screenEnabled, browser (PUBLIC_URL set), locked (ALLOWED_USER_IDS set), intro } */
export function quickPage(s, { screenEnabled, browser = false, locked = false, intro = '' } = {}) {
  return {
    content: `${intro}⚙️ **ตั้งค่าการอัด (server นี้)**\n-# เลือกจากเมนูด้านล่างได้เลย บันทึกทันที`,
    components: [
      ...(screenEnabled ? [select('share', 'เมื่อมีคนแชร์จอ', shareModeOf(s, Boolean(screenEnabled)), SHARE_OPTS)] : []),
      // agent / browser exist only with PUBLIC_URL; the capture area only for the agent (in the browser the sharer picks it)
      ...(screenEnabled && browser ? [select('mode', 'อัดจอด้วย', s.mode === 'browser' ? 'browser' : 'agent', MODE_OPTS),
        ...(s.mode === 'browser' ? [] : [select('area', 'กรอบอัด', s.area, AREA_OPTS)])] : []),
      // hidden when ALLOWED_USER_IDS is set: that list replaces every permission check
      ...(locked ? [] : [select('who', 'ใครกดอัดได้', s.anyoneRecords ? 'all' : 'admins', WHO_OPTS)]),
      new ActionRowBuilder().addComponents(btn('page-limits', '🔧 ตั้งค่าเพิ่มเติม'), btn('done', '✔️ เสร็จ', ButtonStyle.Primary)),
    ],
    allowedMentions: { parse: [] },
  };
}

/** 🔧 detail page: tab 'limits' | 'where' | 'time' (default limits). opts: { screenEnabled, browser, modes, guild (to drop
 *  deleted channels / roles from the defaults) } */
export function detailPage(s, { screenEnabled, browser = false, modes = DEFAULT_MODES, guild } = {}, tab = 'limits') {
  const page = PAGES.some(([p]) => p === tab) ? tab : 'limits';
  const nav = new ActionRowBuilder().addComponents(btn('page-quick', '◀️ กลับ', ButtonStyle.Primary),
    ...PAGES.map(([p, text]) => btn(`page-${p}`, text, p === page ? ButtonStyle.Success : ButtonStyle.Secondary)));
  // default values must still exist, or Discord rejects the menu
  const keep = (xs, cache) => (guild ? xs.filter((x) => cache.has(x)) : xs).slice(0, 25);

  const pages = {
    limits: [
      select('min', 'คนในห้อง', s.minMembers, [1, 2, 3, 4, 5].map((n) => [n, `${n} คนขึ้นไป`, n <= 1 ? 'เริ่มทันทีที่มีคนแชร์จอ' : `แชร์จอแล้วมีคนในห้องอย่างน้อย ${n} คน`])),
      select('delay', 'แชร์นานก่อน', s.minShareSeconds, [0, 5, 10, 15, 30, 60].map((n) => [n, n ? `${n} วินาที` : 'ทันที', 'แชร์ต่อเนื่องนานเท่านี้ก่อนส่งการ์ด/เริ่มอัด'])),
      select('max', 'ยาวสุด', s.maxMinutes, [30, 60, 120, 180, 240, 480, 0].map((n) => [n, !n ? 'ไม่จำกัด' : n % 60 ? `${n} นาที` : `${n / 60} ชั่วโมง`, 'ครบแล้วหยุดอัดและส่งไฟล์เอง'])),
      // a bot without PUBLIC_URL: the host Mac's whole screen or one window (agent / browser are on the quick page)
      ...(screenEnabled && !browser && modes.length > 1
        ? [select('macmode', 'อัดจอ', effectiveMode(s, modes), modes.map((m) => [m, label.mode(m), m === 'window' ? 'อัดเฉพาะหน้าต่างของเครื่องที่รันบอท' : 'อัดทั้งจอของเครื่องที่รันบอท']))] : []),
    ],
    where: [
      wrap(new ChannelSelectMenuBuilder().setCustomId('config:channels')
        .setPlaceholder('📍 ห้องเสียงที่เฝ้า (ไม่เลือก = ทุกห้อง)')
        .setChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
        .setMinValues(0).setMaxValues(25).setDefaultChannels(keep(s.channels, guild?.channels.cache))),
      wrap(new RoleSelectMenuBuilder().setCustomId('config:roles')
        .setPlaceholder('👤 role ที่แชร์จอแล้วให้อัด (ไม่เลือก = ทุกคน)')
        .setMinValues(0).setMaxValues(25).setDefaultRoles(keep(s.roles, guild?.roles.cache))),
      wrap(new ChannelSelectMenuBuilder().setCustomId('config:notify')
        .setPlaceholder('📣 ห้องที่ส่งการ์ด/แจ้งผลการอัด (ไม่เลือก = แชทของห้องเสียง)')
        .setChannelTypes(ChannelType.GuildText)
        .setMinValues(0).setMaxValues(1).setDefaultChannels(keep(s.notifyChannel ? [s.notifyChannel] : [], guild?.channels.cache))),
      wrap(new RoleSelectMenuBuilder().setCustomId('config:manager')
        .setPlaceholder('🔑 role ที่กดอัด/หยุดได้ (ไม่เลือก = เฉพาะผู้ดูแล server)')
        .setMinValues(0).setMaxValues(1).setDefaultRoles(keep(s.managerRole ? [s.managerRole] : [], guild?.roles.cache))),
    ],
    time: [
      select('days', '🗓️ วันที่ใช้ (การ์ดและอัดอัตโนมัติ)', s.days, DAYS.map((d, n) => [n, `วัน${d}`]), { multi: true }),
      select('from', 'ตั้งแต่', s.from, Array.from({ length: 24 }, (_, h) => [h, hh(h)])),
      select('to', 'ถึง', s.to, Array.from({ length: 24 }, (_, h) => [h + 1, hh(h + 1)])),
    ],
  };
  return {
    content: `🔧 **ตั้งค่าเพิ่มเติม** — เลือกแล้วบันทึกทันที · กด ◀️ กลับ ไปหน้าหลัก${page === 'time' ? ` (เวลา ${TIMEZONE})` : ''}`,
    components: [nav, ...pages[page]],
    allowedMentions: { parse: [] },
  };
}

/** settings message for one page ('quick', or a 🔧 tab) of a guild; kept for index.js. Any other page id = quick */
export function configView(guild, page = 'quick', { screenEnabled, modes = DEFAULT_MODES, intro = '', lockedUsers = false }) {
  const s = getSettings(guild.id), browser = hasArea(modes);
  return PAGES.some(([p]) => p === page)
    ? detailPage(s, { screenEnabled, browser, modes, guild }, page)
    : quickPage(s, { screenEnabled, browser, locked: lockedUsers, intro });
}
