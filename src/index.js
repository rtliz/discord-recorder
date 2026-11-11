import 'dotenv/config';
import { stat, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join, basename, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import {
  Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, ActivityType,
  PermissionFlagsBits, AttachmentBuilder, MessageFlags, InteractionContextType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ContextMenuCommandBuilder, ApplicationCommandType, ChannelType,
} from 'discord.js';
import { VoiceRecorder } from './voice-recorder.js';
import { ScreenRecorder } from './screen-recorder.js';
import { windowRegion } from './window-bounds.js';
import { BrowserCapture, captureEnabled } from './browser-capture.js';
import { startCaptureServer } from './capture-server.js';
import { mergeAudio } from './merge.js';
import { driveEnabled, uploadToDrive } from './drive.js';
import { getSettings, updateSettings } from './settings.js';
import { configView, configPageOf, summary, inSchedule, presets, presetLabel } from './config-ui.js';

const { DISCORD_TOKEN, CLIENT_ID, ALLOWED_USER_IDS = '', SCREEN_DEVICE = '2', AUTO_SCREEN_USER_IDS = '',
  SCREEN_ENABLED = 'true', DRIVE_FOLDER_ID, SCREEN_WINDOW_APP = 'Discord', ALLOWED_GUILD_IDS = '', LEAVE_UNLISTED = 'false',
  HTTP_PORT, DELETE_AFTER_UPLOAD = 'false' } = process.env;
const macScreen = SCREEN_ENABLED !== 'false'; // false in k8s: no display on the bot's machine to capture
const browserScreen = captureEnabled;         // PUBLIC_URL set: the sharer records their own screen in a browser
const screenEnabled = macScreen || browserScreen;
const modes = [...(macScreen ? ['screen', 'window'] : []), ...(browserScreen ? ['browser'] : [])];
const modeOf = (s) => (modes.includes(s.mode) ? s.mode : modes[0]); // same rule as config-ui's effective mode
// a browser capture waiting for its sharer, or one whose phone couldn't capture ('voice', U20), isn't recording video
const live = (r) => r.state !== 'offered' && r.state !== 'voice';
const list = (v) => v.split(',').map((x) => x.trim()).filter(Boolean);
const allowed = list(ALLOWED_USER_IDS);
const autoScreenUsers = list(AUTO_SCREEN_USER_IDS);
// servers allowed to use the bot; others are left on join. Empty = any server (turn "Public Bot" off then)
const allowedGuilds = list(ALLOWED_GUILD_IDS);
const guildAllowed = (id) => !allowedGuilds.length || allowedGuilds.includes(id);
const UPLOAD_LIMIT = 10 * 1024 * 1024; // default upload cap; bigger files stay on disk
// lockedUsers: ALLOWED_USER_IDS replaces every permission check, so the 'anyone records' toggle is hidden
const viewOpts = { screenEnabled, modes, lockedUsers: allowed.length > 0 };
// `node src/index.js` runs the bot; importing this file (tests) only sets up the handlers: no command
// registration, no HTTP server, no Discord login
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
// what touches the outside world (voice, ffmpeg, osascript, Drive), swappable in tests
export const deps = { VoiceRecorder, ScreenRecorder, windowRegion, uploadToDrive, mergeAudio };

const MODE_NAMES = { screen: 'ทั้งจอ', window: `หน้าต่าง ${SCREEN_WINDOW_APP}`, browser: 'จอของคนที่แชร์ (ผ่านลิงก์ในเบราว์เซอร์)' };

// probes need /healthz even when browser capture is off (k8s sets HTTP_PORT); the capture routes only with PUBLIC_URL
if (isMain && (captureEnabled || HTTP_PORT)) startCaptureServer(Number(HTTP_PORT) || 8080);

// recording commands are open to everyone in the list and checked in code (Manage Server or the
// server's recorder role); /settings stays admin-only in Discord's own UI too
const commands = [
  new SlashCommandBuilder().setName('record').setDescription('อัดเสียงใน voice channel')
    .addSubcommand((s) => s.setName('start').setDescription('เข้าห้องเสียงของคุณแล้วเริ่มอัด'))
    .addSubcommand((s) => s.setName('stop').setDescription('หยุดอัดและส่งไฟล์เสียง')),
  new SlashCommandBuilder().setName('screen').setDescription(browserScreen ? 'อัดหน้าจอ' : 'อัดหน้าจอเครื่องที่รันบอท')
    .addSubcommand((s) => {
      s.setName('start').setDescription('เริ่มอัดหน้าจอ');
      return modes.length < 2 ? s : s.addStringOption((o) => o.setName('mode') // one mode: nothing to choose
        .setDescription(browserScreen ? 'อัดแบบไหน (ไม่เลือก = ตามที่ตั้งค่าไว้)' : 'อัดทั้งจอ หรือแค่หน้าต่างแอป (ไม่เลือก = ตามที่ตั้งค่าไว้)')
        .addChoices(...modes.map((m) => ({ name: MODE_NAMES[m], value: m }))));
    })
    .addSubcommand((s) => s.setName('stop').setDescription('หยุดอัดและส่งไฟล์วิดีโอ')),
  new SlashCommandBuilder().setName('panel').setDescription('ส่งแผงควบคุมการอัด (อัปเดตสถานะเอง ปักหมุดไว้ได้)'),
  new SlashCommandBuilder().setName('settings').setDescription('ตั้งค่าการอัดอัตโนมัติ')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  // right-click the bot (or anyone) → Apps → this opens the panel
  new ContextMenuCommandBuilder().setName('แผงควบคุม Recorder').setType(ApplicationCommandType.User),
].filter((c) => screenEnabled || c.name !== 'screen')
  .map((c) => c.setContexts(InteractionContextType.Guild).toJSON()); // global commands: hide from DMs

if (isMain) {
  await new REST().setToken(DISCORD_TOKEN)
    .put(Routes.applicationCommands(CLIENT_ID), { body: commands }); // global: every server the bot joins
}

// --- message building blocks --------------------------------------------------

// buttons: customId is "<command>:<subcommand>", handled the same way as the slash command
const BUTTONS = {
  'record:start': ['🎙️ อัดเสียง', ButtonStyle.Success],
  'record:stop': ['⏹️ หยุดอัดเสียง', ButtonStyle.Danger],
  'screen:start': ['🖥️ อัดจอ', ButtonStyle.Primary],
  'screen:me': ['🎥 อัดจอฉัน', ButtonStyle.Primary],
  'screen:full': ['🖥️ อัดทั้งจอแทน', ButtonStyle.Secondary],
  'screen:stop': ['⏹️ หยุดอัดจอ', ButtonStyle.Danger],
  'panel:refresh': ['🔄', ButtonStyle.Secondary],
  'perm:screen': ['🔐 เปิดตั้งค่าสิทธิ์อัดจอ (macOS)', ButtonStyle.Secondary],
  'config:open': ['⚙️ ตั้งค่า', ButtonStyle.Secondary],
};
// tag: pins a stop button to one recording, so an old message can't stop a newer recording
const button = (id, tag, over = {}) => new ButtonBuilder().setCustomId(tag ? `${id}:${tag}` : id)
  .setLabel(over.label ?? BUTTONS[id][0]).setStyle(over.style ?? BUTTONS[id][1]);
// a card has one action, so its stop is just "stop" (the panel keeps the specific labels when it shows two)
const stopBtn = (id, tag) => button(id, tag, { label: '⏹️ หยุดอัด' });
const row = (...ids) => new ActionRowBuilder().addComponents(ids.map((id) => button(id)));
// link buttons open a URL directly, no interaction reaches the bot
const linkButton = (text, url) => new ButtonBuilder().setLabel(text).setURL(url).setStyle(ButtonStyle.Link);
const folderUrl = `https://drive.google.com/drive/folders/${DRIVE_FOLDER_ID}`;
const errorButtons = (e) => ({
  SCREEN_PERMISSION: [row('perm:screen', 'screen:start')],
  WINDOW_NOT_FOUND: [row('screen:start', 'screen:full')], // retry, or record the whole screen instead
}[e?.code] ?? []);
// a failed voice join (no Connect permission, full room) surfaces as an AbortError from the 20 s ready wait
const isAbort = (e) => e?.name === 'AbortError' || /operation was aborted/i.test(e?.message ?? '');
const joinFail = (name) => `🔒 บอทเข้าห้อง **${name}** ไม่ได้ — ต้องให้บอทมีสิทธิ์ Connect ในห้องนั้น (หรือห้องเต็ม)`;
const errText = (e, room = 'เสียง') => (isAbort(e) ? joinFail(room) : String(e.message).slice(0, 1500));
// one console line per recording event, so `kubectl logs` / the terminal shows who recorded what and when
const who = (id) => (id ? `${client.users.cache.get(id)?.tag ?? id}` : '');
const rlog = (g, text) => console.log(`[${new Date().toLocaleString('sv-SE', { timeZone: process.env.TIMEZONE || 'Asia/Bangkok' })}]`
  + ` [${client.guilds.cache.get(g)?.name ?? g}] ${text}`);
const ago = (ms) => `<t:${Math.floor(ms / 1000)}:R>`; // Discord renders and ticks this itself
const pad = (n) => String(n).padStart(2, '0');
const duration = (ms) => {
  const t = Math.round(ms / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(t % 60)}` : `${m}:${pad(t % 60)}`;
};
const quiet = { allowedMentions: { parse: [] } };

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages] });
const voice = new Map();  // guildId -> VoiceRecorder (.auto = 'screen' | 'members' when started automatically)
const screen = new Map(); // guildId -> ScreenRecorder (.auto = sharer's userId when started automatically)

// --- live status: one message per recording, panels and the bot's own status follow along --------

// the recording's single message ("card"): live while recording, then saving, then the result
const liveCard = (rec) => {
  if (!live(rec)) return offerCard(rec); // only auto offers have a card (a manual one is private)
  const room = rec.channelName ?? rec.channel?.name;
  const head = rec.kind === 'voice' ? `🔴 **กำลังอัดเสียงในห้อง ${room}** · เริ่ม ${ago(rec.began)}`
    : rec.kind === 'mac' ? `🔴 **กำลังอัด${rec.what}เครื่องบอท**${rec.auto ? ` — <@${rec.auto}> แชร์จอใน **${room}**` : ''} · เริ่ม ${ago(rec.began)}`
      : `🔴 **กำลังอัดจอของ <@${rec.owner}>**${room ? ` ในห้อง **${room}**` : ''} · เริ่ม ${ago(rec.liveAt ?? rec.began)}`; // browser: when the page started, not the offer
  return {
    content: [
      head,
      ...(rec.kind === 'voice' ? ['-# ทุกคนในห้องถูกอัดเสียงอยู่'] : rec.paired ? ['-# บอทอัดเสียงทุกคนในห้องด้วย'] : []),
      ...(rec.note ? [rec.note] : []), // e.g. why a screen recording became voice only (U20)
    ].join('\n'),
    components: [new ActionRowBuilder().addComponents(stopBtn(rec.kind === 'voice' ? 'record:stop' : 'screen:stop', rec.began))],
    ...quiet,
  };
};

// a browser capture before its sharer opened the page: only the sharer's 🎥 gets them a link (ephemeral)
const offerCard = (rec) => ({
  content: [
    rec.paired ? `🔴 **กำลังอัดเสียงในห้อง ${rec.channelName}** — <@${rec.owner}> แชร์จออยู่` // only once the bot is in
      : `🎥 <@${rec.owner}> แชร์จอใน **${rec.channelName}**`,
    ...(rec.state === 'voice' ? [] : [ // the phone fallback used the link up: no point offering it again
      `🎥 <@${rec.owner}> กด **อัดจอของฉันด้วย** → เลือกจอ → กด **แชร์** เพื่ออัดภาพด้วย`,
      '-# ปุ่มนี้สำหรับคนแชร์ · ไม่กดก็ได้เสียงอย่างเดียว', // an auto offer doesn't expire
    ]),
  ].join('\n'),
  // the link sits on the card itself (one click to the browser; single use, see cardLink). The stop is
  // "no thanks" until the room's audio is being recorded, then a real stop
  components: [new ActionRowBuilder().addComponents(
    ...(rec.state === 'voice' ? [] : [linkButton('🎥 อัดจอของฉันด้วย', cardLink(rec))]),
    rec.paired ? stopBtn('screen:stop', rec.began) : button('screen:stop', rec.began, { label: '✖️ ไม่อัด', style: ButtonStyle.Secondary }))],
  // ping the sharer once; edits never ping again
  allowedMentions: { parse: [], users: [rec.owner] },
});

// the link on an auto card: minted once (every render shows the same link) and valid for as long as the
// recording may run, since the offer itself no longer expires (single use all the same)
const cardLink = (rec) => (rec.cardLink ??= rec.link((getSettings(rec.guildId).maxMinutes || 24 * 60) * 60000));

// put a payload on the recording's card: edit it, else edit through the interaction (works even where
// the bot can't read the channel, for 15 min), else post a new one. Resolves true when it landed somewhere.
async function putCard(rec, payload) {
  const msg = { ...quiet, ...payload };
  if (msg.content?.length > 2000) msg.content = `${msg.content.slice(0, 1999)}…`; // Discord rejects longer; the head (result line) matters most
  if (rec.card) {
    try { await rec.card.edit(msg); return true; } catch (e) { console.error('edit card:', e.message); }
  }
  if (rec.interaction && Date.now() - rec.interaction.createdTimestamp < 14 * 60000) {
    try {
      const m = await rec.interaction.editReply(msg); // the deferred reply is the card
      if (!rec.card && m) { rec.card = m; rememberCard(rec); }
      return true;
    } catch (e) { console.error('edit reply:', e.message); }
  }
  try {
    rec.card = await rec.textChannel.send(msg);
    rememberCard(rec);
    return true;
  } catch (e) {
    console.error('send card:', e.message);
    return false;
  }
}
// cards of recordings in progress are kept in the settings file: after a restart they would say
// "🔴 กำลังอัด" forever, so clientReady marks them stopped (see markOrphanCards)
function rememberCard(rec) {
  const { channelId, id } = rec.card ?? {};
  if (!channelId || !id) return;
  const cards = (getSettings(rec.guildId).cards ?? []).filter(([, m]) => m !== id);
  updateSettings(rec.guildId, { cards: [[channelId, id], ...cards].slice(0, 20) });
}
function forgetCard(rec) {
  const id = rec.card?.id;
  const cards = getSettings(rec.guildId).cards ?? [];
  if (id && cards.some(([, m]) => m === id)) updateSettings(rec.guildId, { cards: cards.filter(([, m]) => m !== id) });
}
async function markOrphanCards(guild) {
  const cards = getSettings(guild.id).cards ?? [];
  if (!cards.length) return;
  for (const [channelId, messageId] of cards) {
    await guild.channels.cache.get(channelId)?.messages
      .edit(messageId, { content: '⚠️ **บอทรีสตาร์ทระหว่างอัด** การอัดนี้หยุดแล้ว', components: [], ...quiet }).catch(() => {});
  }
  // only the ones handled: a card remembered while the edits were running is a live recording's
  const done = new Set(cards.map(([, m]) => m));
  await updateSettings(guild.id, { cards: (getSettings(guild.id).cards ?? []).filter(([, m]) => !done.has(m)) });
}

// every write to one recording's card goes through one queue, in call order, and a function payload is
// built only when its turn comes: a slow edit can't land after a newer one with stale content, and an
// early stop can't post a second message. A function returning null skips (the recording moved on).
// Resolves true when the payload landed somewhere.
function renderCard(rec, payload) {
  const run = async () => {
    const msg = typeof payload === 'function' ? payload() : payload;
    return msg ? putCard(rec, msg) : false;
  };
  const next = (rec.cardQ ?? Promise.resolve()).then(run);
  rec.cardQ = next.catch((e) => { console.error('card:', e); return false; });
  return rec.cardQ;
}
const showCard = renderCard;
// the live card as of when it gets written; nothing once the recording is finishing (its own messages follow)
const liveCardOf = (rec) => () => (rec.finished ? null : liveCard(rec));

// recorder control panel: only the buttons that make sense right now, refreshed on every change
const panel = (guild) => {
  const g = guild.id, v = voice.get(g);
  // a private offer (link only the presser sees) stays off public panels until the page starts recording
  const sc = [screen.get(g)].find((r) => r && (!r.private || live(r)));
  const s = getSettings(g);
  const paired = Boolean(sc && v && sc.paired === v); // the room's audio belongs to the screen recording
  const offered = Boolean(sc && !live(sc));           // link sent, the sharer hasn't started the page yet
  const phone = sc?.state === 'voice';                // the sharer's phone can't capture: only the room audio (U20)
  const status = [
    v && (!paired || phone) ? `🔴 อัดเสียงในห้อง **${v.channel.name}** · เริ่ม ${ago(v.began)}` : null,
    offered && !phone ? `${paired ? `🔴 อัดเสียงในห้อง **${v.channel.name}** · ` : ''}🟡 รอ <@${sc.owner}> เปิดหน้าอัดจอแล้วกด ▶️` : null,
    sc && !offered ? `🔴 อัดจอ${sc.owner ? `ของ <@${sc.owner}>` : ''} · เริ่ม ${ago(sc.liveAt ?? sc.began)}`
      + `${paired ? ` · อัดเสียงในห้อง **${v.channel.name}** ด้วย` : ''}` : null,
  ].filter(Boolean);
  const bottom = new ActionRowBuilder().addComponents(button('config:open'),
    ...(driveEnabled ? [linkButton('📁 Google Drive', folderUrl)] : []), button('panel:refresh'));
  // only what makes sense now: a room audio that belongs to a screen recording is stopped with it, and an
  // unopened offer gets a quiet cancel, not a red stop. The specific stop labels only when two stops show
  const voiceStop = Boolean(v) && !paired;
  const two = voiceStop && Boolean(sc);
  const actions = [
    ...(!v && !startingVoice.has(g) ? [button('record:start')] : []),
    ...(voiceStop ? [two ? button('record:stop') : stopBtn('record:stop')] : []),
    ...(sc ? [offered && !paired ? button('screen:stop', null, { label: '✖️ ยกเลิกอัดจอ', style: ButtonStyle.Secondary })
      : two ? button('screen:stop') : stopBtn('screen:stop')]
      : screenEnabled ? [button(modeOf(s) === 'browser' ? 'screen:me' : 'screen:start')] : []),
  ];
  return {
    content: [
      '🎛️ **Recorder**',
      ...(status.length ? status : ['⚪ ยังไม่ได้อัด — เข้าห้องเสียงแล้วกด 🎙️']),
      `⚡ อัดอัตโนมัติ: **${presetLabel(s, screenEnabled)}**`,
    ].join('\n'),
    components: [new ActionRowBuilder().addComponents(...actions), bottom],
    ...quiet,
  };
};

// public panels (/panel, @Recorder) are remembered per server and edited whenever something changes
async function rememberPanel(msg) {
  const panels = [[msg.channelId, msg.id], ...getSettings(msg.guildId).panels.filter(([, id]) => id !== msg.id)].slice(0, 3);
  await updateSettings(msg.guildId, { panels });
}
const panelTimers = new Map();
function refreshPanels(guild) {
  clearTimeout(panelTimers.get(guild.id));
  panelTimers.set(guild.id, setTimeout(async () => {
    panelTimers.delete(guild.id);
    const gone = new Set();
    for (const [channelId, messageId] of getSettings(guild.id).panels) {
      const ch = guild.channels.cache.get(channelId);
      const ok = await ch?.messages.edit(messageId, panel(guild)).then(() => true, (e) => ![10003, 10008].includes(e.code));
      if (!ok) gone.add(messageId); // deleted message/channel; transient errors keep it
    }
    // filter the current list, not the snapshot: a panel remembered meanwhile must survive
    if (gone.size) await updateSettings(guild.id, { panels: getSettings(guild.id).panels.filter(([, id]) => !gone.has(id)) });
  }, 1000));
}

// the bot's own status (visible when you click its name)
function updatePresence() {
  const screens = [...screen.values()].filter(live).length; // an unanswered offer isn't recording
  const busy = voice.size + screens > 0;
  const what = [screens && 'จอ', voice.size && 'เสียง'].filter(Boolean).join(' + ');
  client.user?.setPresence({
    status: busy ? 'dnd' : 'online',
    activities: [{ type: ActivityType.Custom, name: 'status', state: busy ? `🔴 กำลังอัด${what}` : '⚪ พร้อมอัด · พิมพ์ @Recorder เพื่อเปิดแผงควบคุม' }],
  });
}

// the bot's nickname in each server says who is recording: "<ชื่อคนที่กดอัด> - 🔴 กำลังอัดหน้าจอ"
// (needs Change Nickname). The nickname from before is remembered and put back when recording stops.
const NICK_TAG = / - 🔴 กำลังอัด.*$/u;
const nickBefore = new Map(); // guildId -> nickname before we changed it (null = none); also in settings (restarts)
const nickQueue = new Map();  // guildId -> promise: one nickname change at a time per server
const nickWarned = new Set(); // guildIds already told about a missing Change Nickname (once is enough)
// Discord caps nicknames at 32 UTF-16 units: shorten the name only, whole graphemes (a Thai vowel mark or a
// joined emoji is never cut in half)
const graphemes = (s) => [...new Intl.Segmenter('th', { granularity: 'grapheme' }).segment(s)].map((x) => x.segment);
export function nickFor(name, status) {
  const tail = ` - 🔴 ${status}`;
  const g = graphemes(name);
  while (g.length && g.join('').length + tail.length > 32) g.pop();
  return g.join('').trimEnd() + tail;
}
function updateNick(guild) {
  const g = guild.id;
  const run = async () => {
    const me = guild.members.me;
    if (!me) return;
    const sc = screen.get(g), v = voice.get(g);
    const rec = sc && live(sc) ? sc : v;
    const status = !rec ? null : rec === sc ? 'กำลังอัดหน้าจอ' : 'กำลังอัดเสียง';
    let want;
    if (status) {
      // our own tagged name left over from a restart is not worth restoring
      if (!nickBefore.has(g)) {
        const saved = getSettings(g).nickBefore; // undefined = nothing saved
        nickBefore.set(g, !NICK_TAG.test(me.nickname ?? '') ? me.nickname ?? null : saved !== undefined ? saved : null);
        updateSettings(g, { nickBefore: nickBefore.get(g) });
      }
      const id = rec.owner ?? rec.by ?? (sc?.paired === rec ? sc.owner ?? sc.auto : null) ?? rec.auto; // who pressed / shares
      const name = (id && /^\d+$/.test(id) && guild.members.cache.get(id)?.displayName)
        || nickBefore.get(g) || client.user.username;                  // automatic voice: the bot's own name
      want = nickFor(name, status);
    } else {
      // after a restart only the settings file knows the nickname from before
      const saved = getSettings(g).nickBefore;
      want = nickBefore.has(g) ? nickBefore.get(g)
        : NICK_TAG.test(me.nickname ?? '') ? (saved !== undefined ? saved : null) : me.nickname;
      nickBefore.delete(g);
      if (saved !== undefined) updateSettings(g, { nickBefore: undefined }); // dropped from the file
    }
    if ((me.nickname ?? null) === want) return;
    await me.setNickname(want, 'สถานะการอัด').catch((e) => {
      if (nickWarned.has(g)) return;
      nickWarned.add(g);
      console.error(`ตั้งชื่อบอทใน ${guild.name} ไม่ได้ (ต้องมีสิทธิ์ Change Nickname): ${e.message}`);
    });
  };
  const next = (nickQueue.get(g) ?? Promise.resolve()).then(run);
  nickQueue.set(g, next);
  next.finally(() => { if (nickQueue.get(g) === next) nickQueue.delete(g); });
}

function stateChanged(g) {
  updatePresence();
  const guild = client.guilds.cache.get(g);
  if (guild) { refreshPanels(guild); updateNick(guild); }
}

// --- recording lifecycle ----------------------------------------------------
// one physical screen: at most one host-Mac screen recording across all servers (browser captures: one per server).
// finish functions take the recorder itself so a stale timer/button can't stop a newer recording

const startingScreen = new Set(); // guildIds with a screen start in flight (manual or auto)
const startingVoice = new Set();  // guildIds with a voice start in flight (manual or auto)
let finalizingScreen = 0;         // ffmpeg processes still writing their mp4 after a stop
const screenBusy = () => [...screen.values()].some((r) => r.kind !== 'browser') || startingScreen.size > 0 || finalizingScreen > 0;

// per server: sharers / voice channels not to auto-record again until they stop sharing / the room empties
const autoSkip = new Map();  // guildId -> Set<userId>
const voiceSkip = new Map(); // guildId -> Set<channelId>
const skipSet = (map, g) => map.get(g) ?? map.set(g, new Set()).get(g);

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
// unique even within one millisecond (DELETE_AFTER_UPLOAD removes whole dirs): a repeated timestamp gets
// -2, -3...; only the last timestamp is remembered, so nothing grows
let lastStamp = '', sameStamp = 0;
const dirFor = (guildId) => {
  const t = stamp();
  sameStamp = t === lastStamp ? sameStamp + 1 : 1;
  lastStamp = t;
  return join('recordings', `${guildId}-${t}${sameStamp > 1 ? `-${sameStamp}` : ''}`);
};

// stop any recording after the server's max length
function armMax(rec, finish) {
  const minutes = getSettings(rec.guildId).maxMinutes;
  if (minutes) rec.maxTimer = setTimeout(() => finish(rec, '⏱️ ครบเวลาอัดสูงสุดที่ตั้งไว้', { skip: true }).catch(console.error), minutes * 60000);
}

function trackVoice(g, rec) {
  Object.assign(rec, { guildId: g, began: Date.now(), onGone: () => voiceGone(rec) });
  voice.set(g, rec);
  armMax(rec, finishVoice);
  stateChanged(g);
  rlog(g, `🎙️ เริ่มอัดเสียง ห้อง ${rec.channel.name}${rec.by ? ` โดย ${who(rec.by)}` : ` (อัตโนมัติ: ${rec.auto})`}`);
}

// the bot was kicked from the room or lost its connection: a voice recording ends; the room audio of a
// screen recording stops where it is (delivered with the video), the video goes on
function voiceGone(rec) {
  const g = rec.guildId;
  if (voice.get(g) !== rec) return;
  rlog(g, `⚠️ บอทหลุดจากห้องเสียง ${rec.channel.name}`);
  const owner = rec.pairedTo;
  if (owner && screen.get(g) === owner) {
    // an offer nobody opened (or a phone, U20) has no video: the room audio was all of it, so end it now;
    // skip the sharer like any self-exit, or the next voice event would offer again right away
    if (owner.kind === 'browser' && !owner.liveAt) return finishScreen(owner, '⚠️ บอทหลุดจากห้องเสียง', { skip: true }).catch(console.error);
    owner.notes = `${owner.notes ?? ''}\n⚠️ บอทหลุดจากห้องเสียงกลางทาง เสียงมีถึงตอนนั้น`; // live video goes on
    return;
  }
  finishVoice(rec, '⚠️ บอทหลุดจากห้องเสียง', { skip: true }).catch(console.error); // a kicked auto 'members' room re-arms once it empties
}

// ffmpeg dying on its own (display/permission change, disk full) is reported, not left as a ghost "recording"
// a browser capture ends on its own too (offer expired, page closed or stopped): exitReason says why
function trackScreen(g, rec) {
  Object.assign(rec, { guildId: g, began: Date.now() });
  screen.set(g, rec);
  // browser: from going live (onLive); an auto offer records the room right away, so from now
  if (rec.kind !== 'browser' || rec.auto) armMax(rec, finishScreen);
  stateChanged(g);
  rlog(g, rec.kind === 'browser'
    ? `🎥 ส่งปุ่มอัดจอให้ ${who(rec.owner)}${rec.channelName ? ` ห้อง ${rec.channelName}` : ''}${rec.auto ? ' (อัตโนมัติ)' : ''} capture ${rec.capId}`
    : `🖥️ เริ่มอัด${rec.what}${rec.by ? ` โดย ${who(rec.by)}` : ` (อัตโนมัติ: แชร์โดย ${who(rec.auto)})`}`);
  rec.exited.then(() => {
    if (rec.stopping) return;
    if (screen.get(g) === rec) {
      finishScreen(rec, rec.exitReason ?? '⚠️ ffmpeg หยุดเองระหว่างอัด ไฟล์อาจไม่สมบูรณ์', { skip: Boolean(rec.exitSkip) });
    } else if (rec.kind === 'browser') rec.stop().catch(console.error); // never leave a capture unfinalized
  }).catch(console.error);
}

// upload (Drive) or attach the files of one recording: [[path, buttonLabel], ...]
// each file on its own: one failed upload doesn't cost the others
// for the log: each file → its Drive link, "แนบ/ในเครื่อง", or the failure
const logFiles = (files, out) => files.map(([f], i) => `${basename(f)} → ${out.urls[i] ?? (driveEnabled ? 'อัปไม่สำเร็จ' : 'แนบ/เก็บในเครื่อง')}`).join(', ') || '-';

const driveExpired = (e) => /invalid_grant/.test(e?.message ?? '') || e?.response?.data?.error === 'invalid_grant';

async function deliver(files) {
  const links = [], attach = [], notes = [], urls = []; // urls[i]: Drive link of files[i], or null
  let failed = 0, expired = false;
  for (const [file, text] of files) {
    urls.push(null);
    try {
      if (driveEnabled) {
        try {
          urls[urls.length - 1] = await deps.uploadToDrive(file, `${basename(dirname(file))}-${basename(file)}`);
          links.push(linkButton(text, urls[urls.length - 1]));
        } catch (e) { // Drive is down or its token expired: a small file still reaches people as an attachment
          console.error(e);
          failed++;
          if (driveExpired(e)) expired = true;
          else notes.push(`\n⚠️ ${text}: อัปขึ้น Google Drive ไม่ได้ (${errText(e).slice(0, 300)})`);
          if ((await stat(file)).size > UPLOAD_LIMIT) notes.push(`\n${text}: ไฟล์ใหญ่เกิน ${UPLOAD_LIMIT / 1048576}MB เก็บไว้ที่ \`${file}\``);
          else attach.push(new AttachmentBuilder(file));
        }
      }
      else if ((await stat(file)).size > UPLOAD_LIMIT) notes.push(`\n${text}: ไฟล์ใหญ่เกิน ${UPLOAD_LIMIT / 1048576}MB เก็บไว้ที่ \`${file}\``);
      else attach.push(new AttachmentBuilder(file));
    } catch (e) {
      console.error(e);
      failed++;
      notes.push(`\n⚠️ ${text}: ส่งไม่ได้ (${errText(e).slice(0, 300)}) ไฟล์อยู่ที่ \`${file}\``);
    }
  }
  if (expired) notes.unshift('\n⚠️ อัปขึ้น Google Drive ไม่ได้ (การเชื่อม Drive หมดอายุ — ผู้ดูแลบอทต้องรัน npm run drive-auth ใหม่)');
  const components = driveEnabled && files.length
    ? [new ActionRowBuilder().addComponents(...links, linkButton('📁 ไฟล์ทั้งหมด', folderUrl))] : [];
  return { components, files: attach, note: notes.join(''), urls, uploaded: driveEnabled && files.length > 0 && !failed };
}

// DELETE_AFTER_UPLOAD: once every delivered file is on Drive, drop the recorders' dirs (raw tracks, chunks
// included). Only dirs of the given recorders that produced a delivered file, and never one still in use
async function dropUploaded(recs, files, out) {
  if (DELETE_AFTER_UPLOAD !== 'true' || !out.uploaded) return;
  const delivered = new Set(files.map(([f]) => dirname(f)));
  const inUse = new Set([...voice.values(), ...screen.values()].map((r) => r.dir));
  for (const dir of new Set(recs.filter(Boolean).map((r) => r.dir))) {
    if (dir && delivered.has(dir) && !inUse.has(dir)) await rm(dir, { recursive: true, force: true }).catch(console.error);
  }
}
// the result must never vanish silently
async function showResult(rec, payload, files) {
  if (!(await showCard(rec, payload))) {
    console.error(`!!! ส่งผลการอัดไม่ได้ (guild ${rec.guildId}) ไฟล์: ${files.map(([f]) => f).join(', ') || '-'}`);
  }
  forgetCard(rec); // finished: nothing for a restart to mark
}

// stop + turn the card into the result. reason: why it stopped (shown small under the result)
async function finishScreen(rec, reason, { skip = false } = {}) {
  const g = rec.guildId;
  const browser = rec.kind === 'browser';
  if (screen.get(g) !== rec) { // already stopped (double click, timer vs. button...)
    if (browser) rec.stop().catch(() => {}); // idempotent: makes sure it's finalizing, the first finish reports
    return;
  }
  screen.delete(g);
  rec.finished = true; // queued live-card renders are dropped from here on
  clearTimeout(rec.maxTimer);
  if (skip && rec.auto) skipSet(autoSkip, g).add(rec.auto);
  rlog(g, `⏹️ หยุด${browser && !rec.liveAt ? 'ข้อเสนออัดจอ (ยังไม่ได้เริ่ม)' : `อัด${rec.what}`}${rec.owner ? ` ของ ${who(rec.owner)}` : ''}: ${reason ?? '-'}`);
  if (browser) {
    // nothing on the host is busy: the server's slot is free for the next sharer right away
    setImmediate(() => { const guild = client.guilds.cache.get(g); if (guild) checkAuto(guild); });
    if (!rec.liveAt && !(rec.paired && voice.get(g) === rec.paired)) { // offer never taken, nothing recorded
      stateChanged(g);
      await rec.stop();
      await rec.cardQ;
      // nothing was recorded: don't leave a "cancelled" card behind for every unanswered share
      const gone = rec.card && !rec.private ? await rec.card.delete().then(() => true, () => false) : false;
      if (!gone && (!rec.private || rec.card)) await showCard(rec, { content: `⚪ **ยกเลิกการอัดจอ**${reason ? `\n-# ${reason}` : ''}`, components: [] });
      forgetCard(rec);
      // the private link message must not keep a dead button (its token lasts 15 min, the offer 5)
      const oi = rec.offerInteraction;
      if (oi && Date.now() - oi.createdTimestamp < 14 * 60000) {
        await oi.editReply({ content: rec.offerNote ?? '⌛ ลิงก์หมดเวลาแล้ว กด 🎥 อัดจอฉัน ใหม่ได้เลย', components: [], ...quiet }).catch(() => {});
      }
      return;
    }
  }
  // the paired voice stops with the video, in parallel, whatever happens to ffmpeg
  const paired = rec.paired && voice.get(g) === rec.paired ? rec.paired : null;
  if (paired) {
    voice.delete(g);
    paired.finished = true;
    clearTimeout(paired.maxTimer);
    paired.notice?.edit({ content: `⏹️ หยุดอัดเสียงในห้องนี้แล้ว`, components: [] }).catch(() => {});
  }
  if (!browser) finalizingScreen++; // before any await: the screen isn't free until ffmpeg has written the file
  stateChanged(g);
  const length = duration(Date.now() - (rec.liveAt ?? rec.began));
  const stopping = Promise.allSettled([
    browser ? rec.stop() : rec.stop().finally(() => {
      finalizingScreen--;
      setImmediate(() => client.guilds.cache.forEach(checkAuto)); // screen free: a waiting sharer can start now
    }),
    paired ? paired.stop() : null,
  ]);
  await showCard(rec, { content: `⏳ **กำลังบันทึกไฟล์...**`, components: [] });
  const [video, audio] = await stopping;
  // deliver whatever survived: a failed video must not take the paired audio down with it
  const gotVideo = video.status === 'fulfilled' && Boolean(video.value); // null: the offer was never opened
  const gotAudio = audio.status === 'fulfilled' && Boolean(audio.value);
  let mergeNote = '';
  let videoFile = gotVideo ? video.value : null;
  if (gotVideo && gotAudio) { // one file with the room's voice in it, aligned by the two recorders' start times
    const vStart = browser ? rec.liveAt : rec.firstFrameAt ?? rec.began; // browser: MediaRecorder starts right after the claim
    const merged = await Promise.resolve(deps.mergeAudio(video.value, audio.value, paired.startedAt ? vStart - paired.startedAt : 0)).catch(() => null);
    if (merged) videoFile = merged;
    else mergeNote = '\n⚠️ รวมเสียงเข้าวิดีโอไม่สำเร็จ ส่งแยกไฟล์';
  }
  const merged = videoFile !== (gotVideo ? video.value : null); // the merged file already holds the room audio
  const files = [
    ...(gotVideo ? [[videoFile, '▶️ ดูวิดีโอ']] : []),
    ...(gotAudio && !merged ? [[audio.value, '🎧 ฟังเสียง']] : []), // separate audio only when it isn't in the video
  ];
  const problems = [video, audio].filter((r) => r.status === 'rejected').map((r) => (console.error(r.reason), `\n❌ ${errText(r.reason)}`));
  if (files.length && driveEnabled) await showCard(rec, { content: `⏫ **กำลังอัปโหลดขึ้น Google Drive...**`, components: [] });
  const out = await deliver(files);
  const ok = video.status === 'fulfilled';
  // the capture page polls this and opens the video on Drive (null = no link: the result is only in Discord)
  if (browser) rec.result = { url: gotVideo ? out.urls[0] ?? null : null };
  rlog(g, `${ok ? '✅' : '❌'} ส่งผลอัด${rec.what} ยาว ${length}: ${logFiles(files, out)}${problems.join('').replace(/\n/g, ' ')}`);
  const head = ok && !gotVideo // auto offer nobody opened: only the room's audio
    ? `✅ **อัดเสียงในห้องเสร็จแล้ว** · ยาว ${length} · ไม่ได้อัดภาพจอ`
    : `${ok ? '✅' : '❌'} **อัด${rec.what}${ok ? 'เสร็จแล้ว' : 'ไม่สำเร็จ'}** · ยาว ${length}`;
  await showResult(rec, {
    content: head
      + `${problems.join('')}${rec.notes ?? ''}${mergeNote}${out.note}${reason ? `\n-# ${reason}` : ''}`,
    components: [...out.components, ...(ok ? [] : errorButtons(video.reason))].slice(0, 5), files: out.files,
  }, files);
  // voice.mp3 is inside the uploaded merged video: its dir may go too
  await dropUploaded([rec, paired], merged ? [...files, [audio.value]] : files, out);
}

async function finishVoice(rec, reason, { skip = false } = {}) {
  const g = rec.guildId;
  if (voice.get(g) !== rec) return;
  const owner = rec.pairedTo; // the screen recording this room audio belongs to
  if (owner && screen.get(g) === owner) return finishScreen(owner, reason, { skip }); // one card for both
  voice.delete(g);
  rec.finished = true;
  clearTimeout(rec.maxTimer);
  if (owner) { // joined after its screen recording had already ended: nothing to deliver it on
    stateChanged(g);
    rec.notice?.delete().catch(() => {}); // nothing was announced as recorded: no "stopped" line either
    await rec.stop().catch(console.error);
    return;
  }
  if (skip && rec.auto) skipSet(voiceSkip, g).add(rec.channel.id);
  stateChanged(g);
  rlog(g, `⏹️ หยุดอัดเสียง ห้อง ${rec.channel.name}: ${reason ?? '-'}`);
  const length = duration(Date.now() - rec.began);
  await showCard(rec, { content: `⏳ **กำลังบันทึกไฟล์เสียง...**`, components: [] });
  // the "this room is being recorded" notice must not keep a live stop button
  rec.notice?.edit({ content: `⏹️ หยุดอัดเสียงในห้องนี้แล้ว`, components: [] }).catch(() => {});
  try {
    const file = await rec.stop(); // null when nobody spoke
    const files = file ? [[file, '🎧 ฟังเสียง']] : [];
    if (file && driveEnabled) await showCard(rec, { content: `⏫ **กำลังอัปโหลดขึ้น Google Drive...**`, components: [] });
    const out = await deliver(files);
    rlog(g, `✅ ส่งผลอัดเสียง ห้อง ${rec.channel.name} ยาว ${length}: ${file ? logFiles(files, out) : 'ไม่มีใครพูด'}`);
    await showResult(rec, {
      content: `✅ **อัดเสียงในห้อง ${rec.channel.name} เสร็จแล้ว** · ยาว ${length}${file ? '' : ' · ไม่มีใครพูด'}${out.note}${reason ? `\n-# ${reason}` : ''}`,
      components: out.components, files: out.files,
    }, files);
    await dropUploaded([rec], files, out);
  } catch (e) {
    console.error(e);
    await showResult(rec, { content: `❌ **อัดเสียงไม่สำเร็จ**\n${errText(e)}`, components: [] }, []);
  }
}

// mode 'window' crops to SCREEN_WINDOW_APP's window; with fallback, a missing window records the full screen
async function screenRecorder(g, mode, { fallback = false } = {}) {
  if (mode === 'window') {
    try {
      const region = await deps.windowRegion(SCREEN_WINDOW_APP);
      return Object.assign(new deps.ScreenRecorder(dirFor(g), SCREEN_DEVICE, region), { what: `หน้าต่าง ${SCREEN_WINDOW_APP}`, kind: 'mac' });
    } catch (e) {
      if (!fallback || e.code !== 'WINDOW_NOT_FOUND') throw e;
    }
  }
  return Object.assign(new deps.ScreenRecorder(dirFor(g), SCREEN_DEVICE), { what: 'จอ', kind: 'mac' });
}

// --- interactions -----------------------------------------------------------

// the deferred reply becomes the card; set synchronously after tracking so an early stop waits for it
function openCardFromInteraction(rec, i) {
  rec.interaction = i;
  return renderCard(rec, liveCardOf(rec));
}

const isAdmin = (i) => (allowed.length ? allowed.includes(i.user.id) : i.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
// "anyone records" (⚙️ toggle) opens 🎙️/🎥/⏹️ only: settings stay admin-only, and ALLOWED_USER_IDS overrides it
const anyoneRecords = (g) => !allowed.length && Boolean(getSettings(g).anyoneRecords);
function canRecord(i) {
  if (isAdmin(i) || anyoneRecords(i.guildId)) return true;
  const role = getSettings(i.guildId).managerRole;
  const roles = i.member?.roles;
  return Boolean(role && (roles?.cache ? roles.cache.has(role) : roles?.includes?.(role)));
}
// same rule for a member outside an interaction (@mention panels)
const memberCanRecord = (m) => (allowed.length ? allowed.includes(m.id) : m.permissions.has(PermissionFlagsBits.ManageGuild))
  || anyoneRecords(m.guild.id) || Boolean(getSettings(m.guild.id).managerRole && m.roles.cache.has(getSettings(m.guild.id).managerRole));
const ephemeral = (content, extra = {}) => ({ content, flags: MessageFlags.Ephemeral, ...quiet, ...extra });
// the capture link: only ever in an ephemeral reply, never on a public card
const linkRow = (rec) => new ActionRowBuilder().addComponents(linkButton('🎥 เปิดหน้าอัดจอ', rec.link()));
const linkReply = (rec) => ephemeral([
  '🎥 กดปุ่มด้านล่าง → เลือกจอ → กด **แชร์** แค่นั้น',
  `-# บอทจะเข้าห้อง **${rec.channelName}** มาอัดเสียงด้วย · ใช้คอมพิวเตอร์ (มือถืออัดได้แค่เสียง) · ลิงก์นี้ของคุณคนเดียว หมดอายุ ${ago(rec.began + 5 * 60000)}`,
].join('\n'), { components: [linkRow(rec)] });

client.on('interactionCreate', async (i) => {
  let cmd, sub, tag;
  if (i.isChatInputCommand()) [cmd, sub] = [i.commandName, i.options.getSubcommand(false)];
  else if (i.isUserContextMenuCommand()) cmd = 'panel';
  else if ((i.isButton() || i.isAnySelectMenu()) && /^(record|screen|panel|perm|config):/.test(i.customId)) {
    [cmd, sub, tag] = i.customId.split(':');
  } else return;
  if (!guildAllowed(i.guildId)) return i.reply(ephemeral('บอทนี้ไม่ได้เปิดให้ใช้ใน server นี้'));
  const g = i.guildId;

  // anyone may open the panel; recording needs the recorder role; settings need Manage Server.
  // The sharer of a browser capture may always use its own 🎥 / ⏹️ buttons (only their own screen)
  const own = cmd === 'screen' && ['me', 'stop'].includes(sub) && Boolean(tag) && screen.get(g)?.owner === i.user.id;
  const adminOnly = cmd === 'settings' || cmd === 'config';
  if (cmd !== 'panel' && !own && !(adminOnly ? isAdmin(i) : canRecord(i))) {
    const role = getSettings(g).managerRole;
    return i.reply(ephemeral(adminOnly ? '🔒 ตั้งค่าได้เฉพาะผู้ดูแล server'
      : allowed.length ? '🔒 คุณยังกดอัดไม่ได้ — บอทนี้จำกัดให้เฉพาะรายชื่อที่ผู้ดูแลบอทกำหนดไว้' // no toggle to point at
        : `🔒 คุณยังกดอัดไม่ได้ — ให้ผู้ดูแล server เปิด ⚙️ ตั้งค่า → 👥 ทุกคนกดอัดได้${role ? ` หรือขอ role <@&${role}>` : ''}`));
  }
  if (cmd === 'screen' && !screenEnabled) return i.reply(ephemeral('ปิดการอัดหน้าจอไว้'));
  // the recording's message lives in this channel: the bot must be able to post (and attach) there
  const needs = ['ViewChannel', 'SendMessages', ...(driveEnabled ? [] : ['AttachFiles'])];
  if (!own && (cmd === 'record' || cmd === 'screen') && sub !== 'stop' && !i.appPermissions?.has(needs)) {
    return i.reply(ephemeral(`🔒 บอทส่งข้อความในห้องแชทนี้ไม่ได้ — กดจากห้องแชทอื่น หรือให้ผู้ดูแลให้สิทธิ์ Send Messages${driveEnabled ? '' : ' + Attach Files'} กับบอท`));
  }

  try {
    if (cmd === 'settings' || (cmd === 'config' && sub === 'open')) {
      return await i.reply({ ...configView(i.guild, 'quick', viewOpts), flags: MessageFlags.Ephemeral });
    }
    if (cmd === 'config') return await handleConfig(i, sub);
    if (cmd === 'perm') {
      // Discord buttons can't open x-apple.* URLs, so the bot opens System Settings on its own Mac
      if (process.platform !== 'darwin') return await i.reply(ephemeral('เครื่องที่รันบอทไม่ใช่ macOS'));
      spawn('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'], { stdio: 'ignore' })
        .on('error', console.error);
      return await i.reply(ephemeral('⚙️ เปิดหน้า Screen & System Audio Recording บนเครื่องที่รันบอทแล้ว\nเปิดสิทธิ์ให้แอปที่รันบอท แล้วปิดเปิดแอปนั้นใหม่ (⌘Q)'));
    }
    if (cmd === 'panel') {
      if (i.isButton()) return await i.update(panel(i.guild)); // 🔄 on any panel
      if (i.isUserContextMenuCommand()) return await i.reply({ ...panel(i.guild), flags: MessageFlags.Ephemeral });
      await i.reply(panel(i.guild)); // /panel: public, kept up to date — pin it
      if (canRecord(i)) await rememberPanel(await i.fetchReply()); // anyone else's panel still works, just isn't live
      return;
    }

    if (cmd === 'record' && sub === 'start') {
      const channel = i.member.voice?.channel;
      if (voice.has(g) || startingVoice.has(g)) {
        const v = voice.get(g), room = v?.channel.name ?? channel?.name; // a paired room audio's card is the screen's
        return await i.reply(ephemeral(`บอทกำลังอัดเสียง${room ? `ในห้อง **${room}** ` : ' '}อยู่แล้ว ${v?.pairedTo?.card?.url ?? v?.card?.url ?? ''}`));
      }
      if (!channel) return await i.reply(ephemeral('🎙️ เข้าห้องเสียงก่อน แล้วกดอีกครั้ง'));
      if (!channel.joinable) return await i.reply(ephemeral(joinFail(channel.name)));
      startingVoice.add(g); // reserve before the first await: a double click must not start two recorders
      try {
        await i.deferReply();
        const rec = Object.assign(new deps.VoiceRecorder(channel, dirFor(g)), { textChannel: i.channel, by: i.user.id });
        await rec.start();
        trackVoice(g, rec);
        await openCardFromInteraction(rec, i);
      } finally {
        startingVoice.delete(g);
      }
      return;
    }
    if (cmd === 'screen' && sub === 'me' && tag) { // 🎥 on a browser capture's card: a fresh link for its sharer
      const rec = screen.get(g);
      if (!rec || tag !== String(rec.began)) {
        if (i.isButton()) await i.message.edit({ components: [] }).catch(() => {}); // a stale card: drop its buttons
        return await i.reply(ephemeral(rec ? 'การอัดนี้จบไปแล้ว' : 'ไม่ได้อัดจออยู่'));
      }
      if (rec.owner !== i.user.id) return await i.reply(ephemeral(`ปุ่มนี้สำหรับ <@${rec.owner}> เท่านั้น อัดได้เฉพาะจอของตัวเอง`));
      if (rec.state !== 'offered' || rec.stopping) return await i.reply(ephemeral('กำลังอัดอยู่แล้ว')); // live, or voice only (phone)
      return await i.reply(linkReply(rec));
    }
    if (cmd === 'screen' && sub !== 'stop') {
      const s = getSettings(g);
      let mode = sub === 'full' ? 'screen' : sub === 'me' ? 'browser' : (i.isChatInputCommand() && i.options.getString('mode')) || s.mode;
      if (!modes.includes(mode)) mode = modeOf(s);
      if (mode === 'browser') { // the presser records their own screen through a link
        const here = screen.get(g);
        // pressed again before opening the page: just a fresh link for the same offer
        if (here?.state === 'offered' && !here.stopping && here.owner === i.user.id) {
          here.offerInteraction = i; // the newest link message is the one to tidy up
          return await i.reply(linkReply(here));
        }
        if (here || startingScreen.has(g)) {
          return await i.reply(ephemeral(here && !live(here) ? `<@${here.owner}> กำลังจะอัดจออยู่ รอสักครู่แล้วลองใหม่`
            : `กำลังอัดจออยู่แล้ว ${here?.card?.url ?? ''}`));
        }
        const room = i.member.voice?.channel;
        if (!room) return await i.reply(ephemeral('🎙️ เข้าห้องเสียงก่อน (บอทจะเข้าไปอัดเสียงในห้องนั้นด้วย) แล้วกดอีกครั้ง'));
        if (!room.joinable) return await i.reply(ephemeral(joinFail(room.name)));
        // nothing public yet: the card appears when the page really starts recording (onLive).
        // The link message is kept as offerInteraction (NOT interaction: putCard would turn it into the public card)
        const rec = Object.assign(offerBrowser(i.guild, i.user.id, i.channel, null, room), { private: true, offerInteraction: i }); // before any await
        return await i.reply(linkReply(rec));
      }
      if (screen.has(g) || screenBusy()) {
        const here = screen.get(g);
        return await i.reply(ephemeral(here ? `กำลังอัดจออยู่แล้ว ${here.card?.url ?? ''}` : 'จอเครื่องนี้กำลังถูกอัดอยู่ (อาจเป็นของ server อื่น) ลองใหม่อีกสักครู่'));
      }
      startingScreen.add(g);
      try {
        await i.deferReply();
        const rec = await screenRecorder(g, mode);
        await rec.start();
        Object.assign(rec, { textChannel: i.channel, by: i.user.id });
        trackScreen(g, rec);
        await openCardFromInteraction(rec, i);
      } finally {
        startingScreen.delete(g);
      }
      // like a browser capture: the bot joins the presser's room and records it alongside
      const room = i.member.voice?.channel, rec = screen.get(g);
      if (room && rec && rec.by === i.user.id) pairVoice(rec, i.guild, room, i.channel).catch(console.error);
      return;
    }
    if (sub === 'stop') {
      const rec = (cmd === 'screen' ? screen : voice).get(g);
      if (!rec || (tag && tag !== String(rec.began))) {
        if (tag && i.isButton()) await i.message.edit({ components: [] }).catch(() => {}); // a stale card: drop its button
        return await i.reply(ephemeral(rec ? 'การอัดนี้จบไปแล้ว (ตอนนี้มีการอัดอื่นอยู่ หยุดได้จากข้อความของมัน)' : (cmd === 'screen' ? 'ไม่ได้อัดจออยู่' : 'ไม่ได้อัดเสียงอยู่')));
      }
      // the stop button on the recording's own message just updates it; anywhere else gets a pointer to it
      if (cmd === 'record' && rec.pairedTo && screen.get(g) === rec.pairedTo) { // room audio of a screen recording
        await i.reply(ephemeral(`⏹️ กำลังหยุด (เสียงนี้อัดคู่กับจอ จึงหยุดทั้งคู่) ผลจะขึ้นที่ ${rec.pairedTo.card?.url ?? 'ข้อความของการอัดจอ'}`));
        return await finishScreen(rec.pairedTo, `หยุดโดย <@${i.user.id}>`, { skip: true });
      }
      if (cmd === 'screen' && !live(rec) && !rec.paired) rec.offerNote ??= '✖️ ยกเลิกการอัดจอแล้ว'; // the link message says so, not "expired"
      if (i.isButton() && i.message.id === rec.card?.id) await i.deferUpdate();
      else if (cmd === 'screen' && !live(rec) && !rec.paired) await i.reply(ephemeral('✖️ ยกเลิกการอัดจอแล้ว ลิงก์ที่ส่งไปใช้ไม่ได้แล้ว'));
      else await i.reply(ephemeral(`⏹️ กำลังหยุด ผลจะขึ้นที่ ${rec.card?.url ?? 'ข้อความของการอัดนี้'}`));
      const finish = cmd === 'screen' ? finishScreen : finishVoice;
      return await finish(rec, `หยุดโดย <@${i.user.id}>`, { skip: true }); // by hand: don't auto-restart it
    }
  } catch (e) {
    console.error(e);
    const msg = { content: isAbort(e) ? errText(e, i.member?.voice?.channel?.name) : `❌ ${errText(e)}`, components: errorButtons(e), ...quiet };
    return (i.deferred || i.replied ? i.editReply(msg) : i.reply({ ...msg, flags: MessageFlags.Ephemeral })).catch(console.error);
  }
});

// settings tabs, presets and selects; every change is saved right away and applied to rooms that already match
async function handleConfig(i, sub) {
  const g = i.guildId;
  if (sub === 'done') {
    return i.update({ content: `✅ **บันทึกแล้ว** · ${presetLabel(getSettings(g), screenEnabled)}\n${summary(i.guild, viewOpts)}`, components: [row('config:open')], ...quiet });
  }
  if (sub.startsWith('page-')) return i.update(configView(i.guild, sub.slice(5), viewOpts));
  const v = i.values ?? [];
  const patch = sub.startsWith('preset-') ? presets(screenEnabled, modeOf(getSettings(g)))[sub.slice(7)]?.patch : {
    anyone: () => (allowed.length ? null : { anyoneRecords: !getSettings(g).anyoneRecords }), // hidden (and inert) when ALLOWED_USER_IDS is set
    auto: () => ({ autoScreen: !getSettings(g).autoScreen }),
    min: () => ({ minMembers: Number(v[0]) }),
    mode: () => (modes.includes(v[0]) ? { mode: v[0] } : null),
    voice: () => ({ autoVoice: v[0] }),
    channels: () => ({ channels: v }),
    roles: () => ({ roles: v }),
    notify: () => ({ notifyChannel: v[0] ?? null }),
    manager: () => ({ managerRole: v[0] ?? null }),
    days: () => ({ days: v.map(Number).sort((a, b) => a - b) }),
    from: () => ({ from: Number(v[0]) }),
    to: () => ({ to: Number(v[0]) }),
    delay: () => ({ minShareSeconds: Number(v[0]) }),
    max: () => ({ maxMinutes: Number(v[0]) }),
  }[sub]?.();
  if (!patch) return i.deferUpdate();
  const saved = updateSettings(g, patch); // in memory now, disk in the background
  await i.update(configView(i.guild, configPageOf(sub), viewOpts));
  checkAuto(i.guild);
  stateChanged(g); // panels show the auto-record mode
  if (!(await saved)) await i.followUp(ephemeral('⚠️ บันทึกการตั้งค่าลงดิสก์ไม่ได้ ใช้ได้จนกว่าบอทจะรีสตาร์ท (ดู log ของบอท)'));
}

// --- automatic recording ----------------------------------------------------

const shareStart = new Map();     // `${guildId}:${userId}` -> when that person started sharing
const recheckTimers = new Map();  // guildId -> timer waiting out minShareSeconds

const humansIn = (ch) => ch?.members.filter((m) => !m.user.bot).size ?? 0;
const isWatched = (ch, s) => ch.isVoiceBased() && (!s.channels.length || s.channels.includes(ch.id));
const watched = (guild, s) => [...guild.channels.cache.values()].filter((ch) => isWatched(ch, s));
const canShare = (m, s) => (!autoScreenUsers.length || autoScreenUsers.includes(m.id))
  && (!s.roles.length || m.roles.cache.hasAny(...s.roles));
// where auto recordings report: the chosen channel, else the given fallback
const notifyIn = (guild, fallback) => guild.channels.cache.get(getSettings(guild.id).notifyChannel) ?? fallback;

function recheckIn(guild, ms) {
  if (recheckTimers.has(guild.id)) return; // a pending check re-schedules itself if still needed
  recheckTimers.set(guild.id, setTimeout(() => { recheckTimers.delete(guild.id); checkAuto(guild); }, ms + 250));
}

function checkAuto(guild) {
  if (!guildAllowed(guild.id)) return;
  checkAutoScreen(guild).then(() => checkAutoVoice(guild)).catch(console.error);
}

async function checkAutoScreen(guild) {
  const g = guild.id;
  const s = getSettings(g);
  const cur = screen.get(g);
  if (cur) {
    if (!cur.auto) return; // manual recording: leave it alone
    const sharer = guild.voiceStates.cache.get(cur.auto);
    const ch = guild.channels.cache.get(cur.autoChannelId);
    if (sharer?.channelId !== cur.autoChannelId || !sharer.streaming) return finishScreen(cur, 'คนแชร์เลิกแชร์จอแล้ว');
    // settings changed or the schedule ended: "off" means stop now
    if (!s.autoScreen || !ch || !isWatched(ch, s) || !inSchedule(s)) return finishScreen(cur, 'ปิดการอัดอัตโนมัติ หรือนอกเวลาที่ตั้งไว้');
    return;
  }
  if (!screenEnabled || screen.has(g) || startingScreen.has(g) || !s.autoScreen || !inSchedule(s)) return;
  const browser = modeOf(s) === 'browser';
  if (!browser && screenBusy()) return; // the host's one screen is busy (maybe another server)

  for (const ch of watched(guild, s)) {
    if (humansIn(ch) < s.minMembers) continue;
    const skip = autoSkip.get(g);
    const sharer = ch.members.find((m) => !m.user.bot && m.voice.streaming && !skip?.has(m.id) && canShare(m, s));
    if (!sharer) continue;
    const wait = s.minShareSeconds * 1000 - (Date.now() - (shareStart.get(`${g}:${sharer.id}`) ?? 0));
    if (wait > 0) { recheckIn(guild, wait); continue; }

    const textChannel = notifyIn(guild, voice.get(g)?.textChannel ?? ch);
    if (browser) { // offer the sharer a link; recording starts when their page claims it (onLive)
      const rec = offerBrowser(guild, sharer.id, textChannel, ch);
      renderCard(rec, liveCardOf(rec)).then((ok) => {
        // the sharer can't see an offer that never got posted (the room audio still records; it ends with the share)
        if (!ok) console.error(`auto screen offer card not posted (guild ${g}, capture ${rec.capId})`);
      });
      // don't wait for the page: the bot joins the room and records the audio from the moment of sharing
      rec.pairing = pairVoice(rec, guild, ch, textChannel).catch(console.error); // voiceOnly waits for it
      return;
    }
    startingScreen.add(g);
    let rec;
    try {
      rec = await screenRecorder(g, modeOf(s), { fallback: true });
      await rec.start();
      Object.assign(rec, { textChannel, auto: sharer.id, autoChannelId: ch.id, channelName: ch.name });
      trackScreen(g, rec);
    } catch (e) {
      console.error(e);
      skipSet(autoSkip, g).add(sharer.id); // don't retry (and re-post the error) on every voice event
      await textChannel.send({ content: `❌ อัดจออัตโนมัติไม่ได้: ${errText(e)}`, components: errorButtons(e), ...quiet }).catch(console.error);
      return;
    } finally {
      startingScreen.delete(g);
    }
    await renderCard(rec, liveCardOf(rec)); // a missing Send Messages permission must not undo the recording
    await pairVoice(rec, guild, ch, textChannel); // the bot always joins the sharer's room
    return;
  }
}

// every screen recording brings the room's audio, delivered on its card: the bot joins the room
async function pairVoice(rec, guild, ch, textChannel) {
  const g = guild.id;
  await rec.cardQ; // the card's channel decides whether the room needs its own notice
  if (ch && !voice.has(g) && !startingVoice.has(g) && screen.get(g) === rec) {
    const v = await startAutoVoice(guild, ch, 'screen', textChannel, rec);
    // the screen may have stopped while the bot was joining: don't leave the voice running alone
    if (v && screen.get(g) !== rec) await finishVoice(v, 'อัดจอหยุดไปแล้ว');
    else if (v) await renderCard(rec, liveCardOf(rec)); // now says "with audio"
  }
  if (screen.get(g) === rec) await checkAutoScreen(guild); // sharer may have stopped during the start-up wait
}

// browser capture: tracked right away (synchronously, no await before screen.set) as an offer to `owner`.
// ch = the sharer's voice channel for an auto offer, else null (manual)
function offerBrowser(guild, owner, textChannel, ch = null, voiceChannel = ch) {
  const g = guild.id;
  // an auto offer doesn't expire: the room is recorded meanwhile, and the share ending ends it
  const rec = Object.assign(new BrowserCapture(dirFor(g), { guildId: g, owner, ...(ch ? { offerMs: 0 } : {}) }),
    { textChannel, channelName: voiceChannel?.name, ...(ch ? { auto: owner, autoChannelId: ch.id } : {}) });
  rec.onLive = () => { // the sharer's page started recording
    if (screen.get(g) !== rec) { // stopped meanwhile: let it finalize unseen, and tell the page there's no link
      rec.stop().catch(() => {}).finally(() => { rec.result ??= { url: null }; });
      return;
    }
    if (!rec.maxTimer) armMax(rec, finishScreen);
    stateChanged(g);
    rlog(g, `🔴 ${who(owner)} เริ่มอัดจอผ่านเบราว์เซอร์ capture ${rec.capId}`);
    renderCard(rec, liveCardOf(rec)); // private offer: posts the first card here
    // join the sharer's room and record it too (manual: wherever the owner is when the page starts)
    const room = ch ?? guild.members.cache.get(owner)?.voice?.channel ?? null;
    if (room && !rec.channelName) rec.channelName = room.name;
    pairVoice(rec, guild, room, textChannel).catch(console.error);
  };
  rec.onVoiceOnly = () => voiceOnly(rec, guild, ch); // the page can't capture (phone, U20)
  trackScreen(g, rec);
  return rec;
}

// U20: the sharer opened the link on a device that can't capture, so the bot records the room's audio instead.
// Contract (BrowserCapture.voiceOnly): { paired:true } the room is already recorded · { paired:false } a voice
// recording was started here · { error:'novoice' } owner not in a voice room · { error:'voice' } couldn't join.
// On an error the offer stays open (the page tells them to use a computer), so it's never finished here then
async function voiceOnly(rec, guild, ch) {
  const g = guild.id, owner = rec.owner;
  if (screen.get(g) !== rec) return { error: 'voice' }; // stopped meanwhile
  if (ch) { // auto offer: the room is recorded from the moment of sharing, nothing to start
    await rec.pairing; // the bot may still be joining
    // a failed pair was already reported on the card's channel; the share may also have ended meanwhile
    return voice.has(g) && screen.get(g) === rec ? { paired: true } : { error: 'voice' };
  }
  const done = async (note) => { // the private offer ends silently; its link message says why
    rec.offerNote = note;
    if (screen.get(g) === rec) await finishScreen(rec, '📱 เปิดลิงก์จากอุปกรณ์ที่อัดจอไม่ได้ อัดแค่เสียง');
  };
  if (voice.has(g) || startingVoice.has(g)) {
    await done('📱 อุปกรณ์นี้อัดจอไม่ได้ — บอทอัดเสียงในห้องอยู่แล้ว');
    return { paired: true };
  }
  const room = guild.members.cache.get(owner)?.voice?.channel;
  if (!room) return { error: 'novoice' };
  if (!room.joinable) { rlog(g, joinFail(room.name)); return { error: 'voice' }; }
  startingVoice.add(g); // before the first await, like record:start
  let v;
  try {
    v = Object.assign(new deps.VoiceRecorder(room, dirFor(g)), {
      textChannel: rec.textChannel, by: owner, note: `-# <@${owner}> เปิดลิงก์อัดจอจากมือถือ เลยอัดได้แค่เสียง`,
    });
    await v.start();
  } catch (e) {
    console.error(e);
    rlog(g, isAbort(e) ? joinFail(room.name) : `❌ บอทเข้าห้องเสียง ${room.name} ไม่ได้: ${errText(e)}`);
    return { error: 'voice' };
  } finally {
    startingVoice.delete(g);
  }
  trackVoice(g, v);
  await renderCard(v, liveCardOf(v)); // public card in the channel where 🎥 was pressed
  await done(`📱 อุปกรณ์นี้อัดจอไม่ได้ — บอทอัดเสียงในห้องให้แทนแล้ว ${v.card?.url ?? ''}`.trimEnd());
  return { paired: false };
}

async function checkAutoVoice(guild) {
  const g = guild.id;
  const s = getSettings(g);
  const skip = voiceSkip.get(g); // re-arm rooms once they empty
  for (const id of skip ?? []) if (humansIn(guild.channels.cache.get(id)) === 0) skip.delete(id);
  const cur = voice.get(g);
  if (cur) {
    if (cur.auto === 'members') {
      if (humansIn(cur.channel) === 0) return finishVoice(cur, 'ทุกคนออกจากห้องแล้ว');
      if (s.autoVoice !== 'members' || !isWatched(cur.channel, s) || !inSchedule(s)) {
        return finishVoice(cur, 'ปิดการอัดอัตโนมัติ หรือนอกเวลาที่ตั้งไว้');
      }
    }
    // a 'screen' voice whose screen recording is gone (shouldn't happen, but never leave it running)
    if (cur.auto === 'screen' && ![...screen.values()].some((r) => r.paired === cur) && !startingScreen.has(g)) {
      return finishVoice(cur, 'อัดจอหยุดไปแล้ว');
    }
    return;
  }
  if (s.autoVoice !== 'members' || startingVoice.has(g) || !inSchedule(s)) return;

  for (const ch of watched(guild, s)) {
    if (skip?.has(ch.id) || humansIn(ch) < s.minMembers) continue;
    await startAutoVoice(guild, ch, 'members', notifyIn(guild, ch));
    return;
  }
}

// resolves to the recorder, or null when it couldn't start; pairWith = the screen recording it belongs to
// (a paired voice has no card of its own: its file is delivered on the screen recording's card)
async function startAutoVoice(guild, ch, kind, textChannel, pairWith = null) {
  const g = guild.id;
  startingVoice.add(g);
  try {
    const rec = Object.assign(new deps.VoiceRecorder(ch, dirFor(g)), { textChannel, auto: kind });
    await rec.start();
    trackVoice(g, rec);
    if (pairWith) { // link both ways before any await, or a check in between sees an orphan
      pairWith.paired = rec;
      rec.pairedTo = pairWith;
    } else {
      await renderCard(rec, liveCardOf(rec));
    }
    // people being recorded must be told in the room itself when the card lives elsewhere
    if ((pairWith?.card?.channelId ?? rec.card?.channelId) !== ch.id) {
      rec.notice = await ch.send({
        content: `🔴 **ห้องนี้กำลังถูกอัดเสียง**${pairWith && !pairWith.auto ? '' : ' (อัตโนมัติ)'}`, // a manual screen's pair isn't automatic
        components: [new ActionRowBuilder().addComponents(stopBtn('record:stop', rec.began))],
      }).catch(console.error);
    }
    return rec;
  } catch (e) {
    console.error(e);
    if (kind === 'members') skipSet(voiceSkip, g).add(ch.id); // a manual pair is tried once, nothing to suppress
    await textChannel.send({ content: isAbort(e) ? joinFail(ch.name) : `❌ บอทเข้าห้องเสียง **${ch.name}** ไม่ได้: ${errText(e)}`, ...quiet }).catch(console.error);
    return null;
  } finally {
    startingVoice.delete(g);
  }
}

client.on('voiceStateUpdate', (oldS, newS) => {
  if (newS.member?.user.bot) return;
  const key = `${newS.guild.id}:${newS.id}`;
  if (newS.streaming && !(oldS.streaming && oldS.channelId === newS.channelId)) shareStart.set(key, Date.now());
  else if (!newS.streaming) {
    shareStart.delete(key);
    autoSkip.get(newS.guild.id)?.delete(newS.id); // a new share later is a new chance
  }
  checkAuto(newS.guild);
});

// --- entry points -----------------------------------------------------------

// @Recorder in a server channel -> a live panel
client.on('messageCreate', async (m) => {
  // a real @Recorder, not just a reply to one of the bot's messages (that pings it too)
  const id = client.user.id;
  if (!m.inGuild() || m.author.bot || !guildAllowed(m.guildId) || !(m.content.includes(`<@${id}>`) || m.content.includes(`<@!${id}>`))) return;
  const sent = await m.reply({ ...panel(m.guild), allowedMentions: { parse: [], repliedUser: false } }).catch(console.error);
  if (sent && m.member && memberCanRecord(m.member)) await rememberPanel(sent);
});

// invited to a new server: ask the one question that matters, right where people will see it
client.on('guildCreate', async (guild) => {
  if (!guildAllowed(guild.id)) {
    console.warn(`left ${guild.name} (${guild.id}): not in ALLOWED_GUILD_IDS`);
    return guild.leave().catch(console.error);
  }
  const me = guild.members.me;
  const canSend = (c) => c?.type === ChannelType.GuildText && c.permissionsFor(me)?.has(['ViewChannel', 'SendMessages']);
  const channel = canSend(guild.systemChannel) ? guild.systemChannel
    : guild.channels.cache.filter(canSend).sort((a, b) => a.rawPosition - b.rawPosition).first();
  if (!channel) return console.warn(`no channel to post setup in ${guild.name}`);
  const intro = `👋 **สวัสดีครับ <@${client.user.id}> พร้อมใช้แล้ว**\nเปิดแผงควบคุม: พิมพ์ <@${client.user.id}> ในแชท หรือ /panel\n\n`; // configView keeps allowedMentions empty
  await channel.send(configView(guild, 'quick', { ...viewOpts, intro })).catch(console.error);
});

client.once('clientReady', (c) => {
  console.log(`logged in as ${c.user.tag}`);
  for (const guild of c.guilds.cache.values()) {
    if (!guildAllowed(guild.id)) {
      // leaving on startup is opt-in: a typo in ALLOWED_GUILD_IDS must not throw the bot out of every server
      if (LEAVE_UNLISTED === 'true') {
        console.warn(`left ${guild.name} (${guild.id}): not in ALLOWED_GUILD_IDS`);
        guild.leave().catch(console.error);
      } else console.warn(`ignoring ${guild.name} (${guild.id}): not in ALLOWED_GUILD_IDS (LEAVE_UNLISTED=true to leave)`);
    } else {
      refreshPanels(guild); // panels posted before a restart show the current state again
      updateNick(guild);    // a restart mid-recording must not leave "กำลังอัด" in the name
      markOrphanCards(guild).catch(console.error);
    }
  }
  updatePresence();
  // schedule windows open without any voice event, so sweep every minute
  sweep = setInterval(() => c.guilds.cache.forEach(checkAuto), 60000);
});
let sweep;
if (isMain) await client.login(DISCORD_TOKEN);

// for tests: the module's state, and a reset that drops it (timers included, so the process can exit)
export { client, voice, screen, panel, liveCard, autoSkip, voiceSkip };
export function _reset() {
  for (const r of [...voice.values(), ...screen.values()]) clearTimeout(r.maxTimer);
  for (const m of [voice, screen, autoSkip, voiceSkip, shareStart, nickBefore, nickQueue, nickWarned]) m.clear();
  for (const s of [startingScreen, startingVoice]) s.clear();
  for (const t of [...recheckTimers.values(), ...panelTimers.values()]) clearTimeout(t);
  recheckTimers.clear();
  panelTimers.clear();
  clearInterval(sweep);
  finalizingScreen = 0;
}
