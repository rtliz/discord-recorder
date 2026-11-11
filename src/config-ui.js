import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, ChannelType,
} from 'discord.js';
import { getSettings } from './settings.js';

const { SCREEN_WINDOW_APP = 'Discord', TIMEZONE = 'Asia/Bangkok' } = process.env;

const DAYS = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
const hh = (h) => `${String(h).padStart(2, '0')}:00`;

export const label = {
  min: (n) => (n <= 1 ? 'มีใครสักคนแชร์จอ' : `มีคนแชร์จอ และในห้องมี ${n} คนขึ้นไป`),
  mode: (m) => (m === 'window' ? `หน้าต่าง ${SCREEN_WINDOW_APP} บนเครื่องที่รันบอท` : m === 'browser' ? 'จอของคนกด/คนแชร์ ผ่านเบราว์เซอร์' : 'ทั้งจอของเครื่องที่รันบอท'),
  voice: (v, n) => ({
    off: 'อัดเสียงเฉพาะตอนอัดจอ (บอทเข้าห้องพร้อมจอ)',
    screen: 'อัดเสียงเฉพาะตอนอัดจอ (บอทเข้าห้องพร้อมจอ)', // old saved value: the room's audio now always comes with a screen
    members: `อัดเสียงเมื่อในห้องมี ${n} คนขึ้นไป (ไม่ต้องแชร์จอ)`,
  }[v]),
  days: (d) => (d.length === 7 ? 'ทุกวัน' : d.join() === '1,2,3,4,5' ? 'จ–ศ' : d.map((x) => DAYS[x]).join(' ')),
  hours: (s) => (s.from === s.to || (s.from === 0 && s.to === 24) ? 'ทั้งวัน' : `${hh(s.from)}–${hh(s.to)}`),
  delay: (n) => (n ? `แชร์ต่อเนื่อง ${n} วินาทีก่อนเริ่มอัด` : 'เริ่มอัดทันทีที่แชร์'),
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

// one-click setups; detailed tabs stay available for everything else
// `mode` only changes the 'share' help: in browser mode the bot joins for audio and the sharer records the screen
export const presets = (screenEnabled, mode) => (screenEnabled ? {
  off: { text: '⛔ ไม่อัดอัตโนมัติ', help: 'กดอัดเองจากแผงควบคุม', patch: { autoScreen: false, autoVoice: 'off' } },
  share: { text: '🖥️ อัดจอเมื่อมีคนแชร์', help: mode === 'browser' ? 'มีคนแชร์จอ บอทเข้าห้องอัดเสียง แล้วส่งปุ่มให้คนแชร์กดอัดจอ' : 'มีคนแชร์จอ บอทอัดจอ + เสียงในห้องให้เอง หยุดเมื่อเลิกแชร์', patch: { autoScreen: true, autoVoice: 'off' } },
  meeting: { text: '📋 อัดประชุม (เสียง + จอ)', help: 'คนเข้าห้องครบ บอทอัดเสียงทั้งห้อง และอัดจอเมื่อมีคนแชร์', patch: { autoScreen: true, autoVoice: 'members' } },
} : {
  off: { text: '⛔ ไม่อัดอัตโนมัติ', help: 'กดอัดเองจากแผงควบคุม', patch: { autoVoice: 'off' } },
  meeting: { text: '📋 อัดเสียงประชุม', help: 'คนเข้าห้องครบ บอทอัดเสียงทั้งห้องให้เอง', patch: { autoVoice: 'members' } },
});
export function presetOf(s, screenEnabled) {
  return Object.entries(presets(screenEnabled))
    .find(([, p]) => Object.entries(p.patch).every(([k, v]) => s[k] === v))?.[0] ?? null;
}
export const presetLabel = (s, screenEnabled) => presets(screenEnabled)[presetOf(s, screenEnabled)]?.text ?? '🔧 กำหนดเอง';

const DEFAULT_MODES = ['screen', 'window'];
// a saved mode that is no longer offered (e.g. host-Mac modes switched off) falls back to the first one
const effectiveMode = (s, modes) => (modes.includes(s.mode) ? s.mode : modes[0]);

export function summary(guild, { screenEnabled, modes = DEFAULT_MODES }) {
  const s = getSettings(guild.id);
  const ids = (xs, fmt, all) => (xs.length ? xs.map(fmt).join(' ') : all);
  return [
    ...(screenEnabled ? [`> 🖥️ อัดจอ: **${s.autoScreen ? `เมื่อ${label.min(s.minMembers)} — ${label.mode(effectiveMode(s, modes))}` : 'ปิด'}**`] : []),
    `> 🎙️ เสียง: **${s.autoVoice === 'members' || screenEnabled ? label.voice(s.autoVoice, s.minMembers) : 'ไม่อัดเสียงอัตโนมัติ'}**`,
    `> 📍 ห้อง: ${ids(s.channels, (x) => `<#${x}>`, '**ทุกห้องเสียง**')} · 👤 คนแชร์: ${ids(s.roles, (x) => `<@&${x}>`, '**ทุกคน**')}`,
    `> 📣 แจ้งผลที่: ${s.notifyChannel ? `<#${s.notifyChannel}>` : '**แชทของห้องเสียง**'} · 🔑 กดอัดได้: ${s.anyoneRecords ? '**ทุกคน**' : s.managerRole ? `ผู้ดูแล + <@&${s.managerRole}>` : '**ผู้ดูแล server**'}`,
    `> 🕘 เวลา: **${label.days(s.days)} ${label.hours(s)}** (${TIMEZONE})`,
    `> ⏳ **${label.delay(s.minShareSeconds)}** · ⏱️ **${label.max(s.maxMinutes)}**`,
  ].join('\n');
}

const PAGES = [['quick', '⚡ แบบง่าย'], ['main', '🖥️ การอัด'], ['where', '📍 ห้อง & คน'], ['time', '🕘 เวลา'], ['limits', '⏳ ความยาว']];
const PAGE_OF = {
  auto: 'main', min: 'main', mode: 'main', voice: 'main',
  channels: 'where', roles: 'where', notify: 'where', manager: 'where',
  days: 'time', from: 'time', to: 'time',
  delay: 'limits', max: 'limits',
};
export const configPageOf = (sub) => PAGE_OF[sub] ?? (sub === 'anyone' || sub.startsWith('preset-') ? 'quick' : 'main');

const wrap = (menu) => new ActionRowBuilder().addComponents(menu);
const select = (id, placeholder, current, options, { multi = false } = {}) => wrap(new StringSelectMenuBuilder()
  .setCustomId(`config:${id}`).setPlaceholder(placeholder)
  .setMinValues(1).setMaxValues(multi ? options.length : 1)
  .addOptions(options.map(([value, text]) => ({
    value: String(value), label: text,
    default: multi ? current.map(String).includes(String(value)) : String(value) === String(current),
  }))));

/** settings message for one tab; every change is saved right away */
export function configView(guild, page = 'quick', { screenEnabled, modes = DEFAULT_MODES, intro = '', lockedUsers = false }) {
  const s = getSettings(guild.id);
  if (page === 'quick') return quickView(guild, s, { screenEnabled, intro, lockedUsers, mode: effectiveMode(s, modes) });
  const nav = new ActionRowBuilder().addComponents(
    ...PAGES.map(([p, text]) => new ButtonBuilder().setCustomId(`config:page-${p}`).setLabel(text)
      .setStyle(p === page ? ButtonStyle.Primary : ButtonStyle.Secondary)));
  // default values must still exist, or Discord rejects the menu
  const keep = (xs, cache) => xs.filter((x) => cache.has(x)).slice(0, 25);

  const pages = {
    main: [
      ...(screenEnabled ? [
        new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('config:auto')
          .setLabel(s.autoScreen ? '✅ อัดจออัตโนมัติ: เปิด (กดเพื่อปิด)' : '⛔ อัดจออัตโนมัติ: ปิด (กดเพื่อเปิด)')
          .setStyle(s.autoScreen ? ButtonStyle.Success : ButtonStyle.Secondary)),
        select('min', 'เริ่มอัดจอเมื่อ', s.minMembers, [1, 2, 3, 4, 5].map((n) => [n, `เริ่มอัดเมื่อ${label.min(n)}`])),
        // always shown, even with one choice: people need to see whose screen gets recorded
        select('mode', 'ประเภทการอัดจอ', effectiveMode(s, modes), modes.map((m) => [m, `🎥 อัด${label.mode(m)}`])),
      ] : [
        select('min', 'จำนวนคนในห้อง', s.minMembers, [1, 2, 3, 4, 5].map((n) => [n, `ในห้องมี ${n} คนขึ้นไป`])),
      ]),
      // 'screen' is gone as a choice: every screen recording brings the room's audio now
      select('voice', 'อัดเสียงอัตโนมัติ', s.autoVoice === 'screen' ? 'off' : s.autoVoice,
        ['off', 'members'].map((v) => [v, screenEnabled || v !== 'off' ? label.voice(v, s.minMembers) : 'ไม่อัดเสียงอัตโนมัติ'])),
    ],
    where: [
      wrap(new ChannelSelectMenuBuilder().setCustomId('config:channels')
        .setPlaceholder('📍 ห้องเสียงที่เฝ้า (ไม่เลือก = ทุกห้อง)')
        .setChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
        .setMinValues(0).setMaxValues(25).setDefaultChannels(keep(s.channels, guild.channels.cache))),
      wrap(new RoleSelectMenuBuilder().setCustomId('config:roles')
        .setPlaceholder('👤 role ที่แชร์จอแล้วให้อัด (ไม่เลือก = ทุกคน)')
        .setMinValues(0).setMaxValues(25).setDefaultRoles(keep(s.roles, guild.roles.cache))),
      wrap(new ChannelSelectMenuBuilder().setCustomId('config:notify')
        .setPlaceholder('📣 ห้องที่แจ้งผลการอัดอัตโนมัติ (ไม่เลือก = แชทของห้องเสียง)')
        .setChannelTypes(ChannelType.GuildText)
        .setMinValues(0).setMaxValues(1).setDefaultChannels(keep(s.notifyChannel ? [s.notifyChannel] : [], guild.channels.cache))),
      wrap(new RoleSelectMenuBuilder().setCustomId('config:manager')
        .setPlaceholder('🔑 role ที่กดอัด/หยุดได้ (ไม่เลือก = เฉพาะผู้ดูแล server)')
        .setMinValues(0).setMaxValues(1).setDefaultRoles(keep(s.managerRole ? [s.managerRole] : [], guild.roles.cache))),
    ],
    time: [
      select('days', 'วันที่อัดอัตโนมัติ', s.days, DAYS.map((d, n) => [n, `วัน${d}`]), { multi: true }),
      select('from', 'ตั้งแต่', s.from, Array.from({ length: 24 }, (_, h) => [h, `ตั้งแต่ ${hh(h)}`])),
      select('to', 'ถึง', s.to, Array.from({ length: 24 }, (_, h) => [h + 1, `ถึง ${hh(h + 1)}`])),
    ],
    limits: [
      select('delay', 'แชร์นานเท่าไรถึงเริ่มอัด', s.minShareSeconds, [0, 5, 10, 15, 30, 60].map((n) => [n, label.delay(n)])),
      select('max', 'ความยาวสูงสุด', s.maxMinutes, [30, 60, 120, 180, 240, 480, 0].map((n) => [n, label.max(n)])),
    ],
  };

  return {
    content: `${intro}🔧 **ตั้งค่าละเอียด** — เปลี่ยนแล้วบันทึกทันที\n${summary(guild, { screenEnabled, modes })}`,
    components: [nav, ...(pages[page] ?? pages.main)],
    allowedMentions: { parse: [] },
  };
}

// first screen people see: pick one of three setups, done
function quickView(guild, s, { screenEnabled, intro, lockedUsers, mode }) {
  const all = presets(screenEnabled, mode);
  const current = presetOf(s, screenEnabled);
  const lines = Object.entries(all).map(([k, p]) => `${k === current ? '▶' : '　'} **${p.text}** — ${p.help}`);
  return {
    content: `${intro}⚡ **อยากให้บอทอัดอัตโนมัติแบบไหน?** กดเลือกได้เลย บันทึกทันที\n${lines.join('\n')}`
      + `${current ? '' : '\n▶ ตอนนี้: **🔧 กำหนดเอง**'}\n-# ปรับละเอียด (ห้อง, เวลา, คนที่กดได้ ฯลฯ) ได้ที่ 🔧`,
    components: [
      new ActionRowBuilder().addComponents(Object.entries(all).map(([k, p]) => new ButtonBuilder()
        .setCustomId(`config:preset-${k}`).setLabel(p.text)
        .setStyle(k === current ? ButtonStyle.Success : ButtonStyle.Secondary))),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('config:page-main').setLabel('🔧 ปรับละเอียด').setStyle(ButtonStyle.Secondary),
        // hidden when ALLOWED_USER_IDS is set: that list replaces every permission check
        ...(lockedUsers ? [] : [new ButtonBuilder().setCustomId('config:anyone')
          .setLabel(s.anyoneRecords ? '👥 ทุกคนกดอัดได้' : '🔑 เฉพาะผู้ดูแลกดอัด')
          .setStyle(s.anyoneRecords ? ButtonStyle.Success : ButtonStyle.Secondary)]),
        new ButtonBuilder().setCustomId('config:done').setLabel('✔️ เสร็จ').setStyle(ButtonStyle.Primary)),
    ],
    allowedMentions: { parse: [] },
  };
}
