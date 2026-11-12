import 'dotenv/config';
import { stat, rm, mkdir } from 'node:fs/promises';
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
import { BrowserCapture, captureEnabled, publicUrl } from './browser-capture.js';
import { startCaptureServer, SAFE_SERVER } from './capture-server.js';
import { mergeAudio } from './merge.js';
import { composeMeeting, pending as composePending } from './compose.js';
import { hub } from './agent-hub.js';
import { ACK_ERROR } from './agent/protocol.js';
import { driveEnabled, uploadToDrive } from './drive.js';
import { getSettings, updateSettings } from './settings.js';
import { configView, configPageOf, applyConfig, summary, inSchedule, cardsLabel, shareModeOf } from './config-ui.js';

const { DISCORD_TOKEN, CLIENT_ID, ALLOWED_USER_IDS = '', SCREEN_DEVICE = '2', AUTO_SCREEN_USER_IDS = '',
  SCREEN_ENABLED = 'true', DRIVE_FOLDER_ID, SCREEN_WINDOW_APP = 'Discord', ALLOWED_GUILD_IDS = '', LEAVE_UNLISTED = 'false',
  HTTP_PORT, DELETE_AFTER_UPLOAD = 'false' } = process.env;
const macScreen = SCREEN_ENABLED !== 'false'; // false in k8s: no display on the bot's machine to capture
const browserScreen = captureEnabled;         // PUBLIC_URL set: the sharer records their own screen in a browser
const screenEnabled = macScreen || browserScreen;
// with PUBLIC_URL: 'agent' (the person's recorder agent, else the 🎥 link) or 'browser' (always the link, never an
// agent). The host-Mac modes are only offered without PUBLIC_URL (their code stays; settings.js maps old values)
const modes = browserScreen ? ['agent', 'browser'] : macScreen ? ['screen', 'window'] : [];
const modeOf = (s) => (modes.includes(s.mode) ? s.mode : modes[0]); // same rule as config-ui's effective mode
const isMac = (mode) => mode === 'screen' || mode === 'window';
const useAgent = (g) => modeOf(getSettings(g)) === 'agent'; // may this server's starts command an agent
// a browser capture waiting for its sharer, or one whose phone couldn't capture ('voice', U20), isn't recording video;
// a session is live while its current segment is
const live = (r) => (r.kind === 'session' ? Boolean(r.cur && live(r.cur.rec)) : r.state !== 'offered' && r.state !== 'voice');
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
const SESSION = { starting: 'starting', live: 'live', waiting: 'waiting', agent: 'agent', link: 'link', mac: 'mac' }; // session states, segment sources
// what touches the outside world (voice, ffmpeg, osascript, Drive, recorder agents), swappable in tests;
// always read through deps.x at call time so a swapped fake is the one used
export const deps = { VoiceRecorder, ScreenRecorder, windowRegion, uploadToDrive, mergeAudio, composeMeeting };
// assigning deps.agents (tests swap in a fake) also hooks its online/offline transitions
let agentHub = hub;
Object.defineProperty(deps, 'agents', { enumerable: true, get: () => agentHub, set: (a) => { agentHub = a; a.onChange = onAgentChange; } });
hub.onChange = onAgentChange;
// session timings in ms; exported so tests can shrink them
export const T = { wait: 120000 };

const MODE_NAMES = { screen: 'ทั้งจอ', window: `หน้าต่าง ${SCREEN_WINDOW_APP}`, agent: 'อัดหน้าจอในเครื่อง (ต้องติดตั้งตัวอัดหน้าจอ)', browser: 'อัดผ่านเบราว์เซอร์' };

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
  new SlashCommandBuilder().setName('agent').setDescription('ติดตั้งตัวอัดจอบนเครื่องของคุณ (ไม่ต้องใช้เบราว์เซอร์)'),
  new SlashCommandBuilder().setName('settings').setDescription('ตั้งค่าการ์ดแชร์จอ ห้อง เวลา และคนที่กดอัดได้')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  // right-click the bot (or anyone) → Apps → this opens the panel
  new ContextMenuCommandBuilder().setName('แผงควบคุม Recorder').setType(ApplicationCommandType.User),
].filter((c) => screenEnabled || c.name !== 'screen').filter((c) => browserScreen || c.name !== 'agent') // agents need PUBLIC_URL
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
  'screen:me': ['🖥️ อัดจอ', ButtonStyle.Primary],          // with PUBLIC_URL: the presser's own agent (else a link)
  'screen:link': ['🌐 อัดผ่านเบราว์เซอร์', ButtonStyle.Primary], // always the private 🎥 link, never an agent
  'screen:full': ['🖥️ อัดทั้งจอแทน', ButtonStyle.Secondary],
  'screen:stop': ['⏹️ หยุดอัดจอ', ButtonStyle.Danger],
  'panel:refresh': ['🔄', ButtonStyle.Secondary],
  'perm:screen': ['🔐 เปิดตั้งค่าสิทธิ์อัดจอ (macOS)', ButtonStyle.Secondary],
  'config:open': ['⚙️ ตั้งค่า', ButtonStyle.Secondary],
  'agent:install': ['📥 ติดตั้งตัวอัด', ButtonStyle.Secondary], // same as /agent: the install one-liners, only the presser sees them
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
const voice = new Map();  // guildId -> VoiceRecorder (.pairedTo = the screen recording / session it belongs to)
const screen = new Map(); // guildId -> ScreenRecorder | BrowserCapture (manual) | session (kind 'session', a pressed share)

// --- live status: one message per recording, panels and the bot's own status follow along --------

// the recording's single message ("card"): live while recording, then saving, then the result
const liveCard = (rec) => {
  if (rec.kind === 'session') return sessionCard(rec);
  const room = rec.channelName ?? rec.channel?.name;
  const head = rec.kind === 'voice' ? `🔴 **กำลังอัดเสียงในห้อง ${room}** · เริ่ม ${ago(rec.began)}`
    : rec.kind === 'mac' ? `🔴 **กำลังอัด${rec.what}เครื่องบอท** · เริ่ม ${ago(rec.began)}`
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

const nameOf = (guild, id) => guild?.members.cache.get(id)?.displayName ?? 'คนแชร์';
const short = (t, n = 40) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
// one button per person (max 3: the row also holds the stop or link); id(u) = its customId
const peopleButtons = (guild, users, id, label, style = ButtonStyle.Success) => users.slice(0, 3)
  .map((u) => new ButtonBuilder().setCustomId(id(u)).setLabel(short(label(nameOf(guild, u)))).setStyle(style));

// a room card: someone shares, nothing records until a 🔴 is pressed (one 🔴 per sharer, D5)
const roomCardOf = (rc) => ({
  content: [`🖥️ ${rc.sharers.map((u) => `<@${u}>`).join(', ')} กำลังแชร์จอใน **${rc.room.name}** · กด 🔴 เพื่ออัด`, '-# ยังไม่ได้อัดอะไร'].join('\n'),
  components: [new ActionRowBuilder().addComponents(...peopleButtons(rc.room.guild, rc.sharers, (u) => `screen:rec:${u}`,
    (n) => (rc.sharers.length === 1 ? '🔴 เริ่มอัด' : `🔴 อัด ${n}`)), button('agent:install'))],
  allowedMentions: { parse: [], users: rc.sharers }, // pings on the first post only: edits never ping
});

// a session's card: starting / live (with 🔁 for other sharers) / waiting for the next screen (🔴 ต่อ)
function sessionCard(sess) {
  const g = sess.guildId, guild = client.guilds.cache.get(g), room = sess.room.name;
  const seg = sess.cur, rec = seg?.rec, p = sess.pending;
  const audio = Boolean(sess.paired) && voice.get(g) === sess.paired; // the room is being recorded
  const joining = sess.joinState === 'joining'; // the bot joins the room as the session starts (not after the screen)
  const voiceLine = audio ? '-# บอทอัดเสียงทุกคนในห้องด้วย' : joining ? '-# ⏳ บอทกำลังเข้าห้องเพื่ออัดเสียง...' : null;
  const lines = [];
  let top = [], more = [];
  // a red stop once something records (or the room audio is on its way); before that a grey cancel
  const stop = audio || joining || (rec && live(rec)) ? stopBtn('screen:stop', sess.began)
    : button('screen:stop', sess.began, { label: '✖️ ไม่อัด', style: ButtonStyle.Secondary });
  const others = sharing(sess).filter((u) => u !== seg?.owner && u !== p?.owner);
  const starting = p && `⏳ **กำลัง${p.source === SESSION.agent ? `สั่งเครื่องของ <@${p.owner}> ให้เริ่มอัดจอ` : `เริ่มอัดจอของ <@${p.owner}>`}...**`;
  if (sess.state === SESSION.waiting) {
    lines.push(`${sess.pause} · เสียงยังอัดอยู่`);
    if (p) lines.push(starting);
    else {
      lines.push(`-# กด 🔴 เพื่ออัดจอคนที่ยังแชร์อยู่ต่อ ไม่มีใครกดจะจบเอง ${ago(sess.waitUntil)}`);
      more = peopleButtons(guild, others, (u) => `screen:cont:${sess.began}.${u}`, (n) => `🔴 อัดจอ ${n} ต่อ`);
    }
    top = [button('screen:stop', sess.began, { label: '⏹️ จบ', style: ButtonStyle.Danger })];
  } else if (!seg) { // just started: the room audio and the first screen start together (or the screen failed: audio only)
    lines.push(`🔴 **กำลังอัด${p ? '' : 'เสียง'}ในห้อง ${room}** · เริ่ม ${ago(sess.began)}`);
    if (voiceLine) lines.push(voiceLine);
    if (p) lines.push(starting);
    top = [stop];
  } else {
    if (rec.kind === 'browser' && rec.via !== 'agent' && !live(rec)) { // the card link, not opened yet (or a phone)
      lines.push(`🔴 **กำลังอัดเสียงในห้อง ${room}**${rec.state === 'voice' ? '' : ` · <@${seg.owner}> กด 🎥 เพื่ออัดจอด้วย`}`);
      if (joining) lines.push(voiceLine);
      if (rec.state === 'voice') lines.push(`-# <@${seg.owner}> เปิดลิงก์จากมือถือ เลยอัดได้แค่เสียง`);
      else if (seg.private) lines.push(`-# 🎥 ส่งลิงก์อัดจอให้ <@${seg.owner}> แล้ว (เห็นคนเดียว) · ไม่เปิดก็ได้เสียงอย่างเดียว`);
      else {
        lines.push(`-# 🎥 กด **อัดจอของฉันด้วย** → เลือกจอ → กด **แชร์** · ปุ่มนี้สำหรับ <@${seg.owner}> · ไม่กดก็ได้เสียงอย่างเดียว`);
        top.push(linkButton('🎥 อัดจอของฉันด้วย', cardLink(rec)));
        if (useAgent(g)) top.push(button('agent:install')); // mode agent without their agent: the next time it can be
      }
      if (seg.auto) lines.push('-# ⚡ อัดอัตโนมัติ (ตั้งค่าไว้ให้อัดเมื่อมีคนแชร์จอ) · ไม่อยากให้อัดกด ⏹️');
    } else {
      lines.push(`🔴 **กำลังอัด${rec.kind === 'mac' ? `${rec.what}เครื่องบอท** — <@${seg.owner}> แชร์จอ` : `จอของ <@${seg.owner}>**`}`
        + ` ในห้อง **${room}** · เริ่ม ${ago(sess.began)}`);
      if (voiceLine) lines.push(voiceLine);
      if (seg.auto) lines.push('-# ⚡ อัดอัตโนมัติ (ตั้งค่าไว้ให้อัดเมื่อมีคนแชร์จอ) · ไม่อยากให้อัดกด ⏹️');
    }
    if (p) lines.push(`-# ⏳ กำลังสลับไปอัดจอของ <@${p.owner}>...`);
    else if (sess.mode === 'share') more = peopleButtons(guild, others, (u) => `screen:switch:${sess.began}.${u}`, (n) => `🔁 สลับไปอัด ${n}`, ButtonStyle.Secondary);
    top.push(stop);
  }
  return {
    content: [...lines, ...(sess.notes ? [sess.notes.trim()] : [])].join('\n'),
    components: [new ActionRowBuilder().addComponents(...top), ...(more.length ? [new ActionRowBuilder().addComponents(...more)] : [])],
    ...quiet,
  };
}

// the link on a session card: minted once (every render shows the same link) and valid for as long as the
// recording may run (single use all the same)
const cardLink = (rec) => (rec.cardLink ??= pageUrl(rec, (getSettings(rec.guildId).maxMinutes || 24 * 60) * 60000));
// a capture page link; with the area set to the Discord window the page asks for that window (a hint, see page.js).
// Mode browser hides the area select, so a saved 'discord' left from agent mode must not reach the page there
// (agents keep the saved area: start.area)
const linkArea = (s) => (s.area === 'discord' && modeOf(s) !== 'browser' ? 'discord' : 'screen');
const pageUrl = (rec, ms) => `${rec.link(ms)}${linkArea(getSettings(rec.guildId)) === 'discord' ? '?area=discord' : ''}`;

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
      if (!rec.card && m) { rec.card = m; (rec.remember ?? rememberCard)(rec); }
      return true;
    } catch (e) { console.error('edit reply:', e.message); }
  }
  try {
    rec.card = await rec.textChannel.send(msg);
    (rec.remember ?? rememberCard)(rec); // room cards keep their own list (deleted on restart, not marked)
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

// a start nobody should see yet: a private link offer (a session is public from its start: it records the room at once)
const hiddenStart = (r) => !live(r) && Boolean(r.private);
// people in this server's voice rooms whose recorder agent is online (the panel shows who can be recorded)
const agentsOnline = (guild) => [...guild.voiceStates.cache.values()].filter((vs) => vs.channelId && !vs.member?.user.bot && deps.agents.online(vs.id))
  .map((vs) => vs.id);

// recorder control panel: only the buttons that make sense right now, refreshed on every change
const panel = (guild) => {
  const g = guild.id, v = voice.get(g);
  // a private offer (link only the presser sees) stays off public panels until it records
  const sc = [screen.get(g)].find((r) => r && !hiddenStart(r));
  const s = getSettings(g);
  const paired = Boolean(sc && v && sc.paired === v); // the room's audio belongs to the screen recording
  const agents = browserScreen ? agentsOnline(guild) : [];
  const offered = Boolean(sc && !live(sc));           // link sent, the sharer hasn't started the page yet
  const phone = sc?.state === 'voice';                // the sharer's phone can't capture: only the room audio (U20)
  const sess = sc?.kind === 'session' ? sc : null;
  const status = sess ? [ // a pressed share: whose screen, or waiting for the next one (B3 polishes this)
    sess.state === SESSION.waiting ? `⏸️ รอเลือกจอถัดไปในห้อง **${sess.room.name}**${paired ? ' · เสียงยังอัดอยู่' : ''}`
      : live(sess) ? `🔴 อัดจอของ <@${sess.owner}> · ห้อง **${sess.room.name}** · เริ่ม ${ago(sess.began)}${paired ? ' · อัดเสียงในห้องด้วย' : ''}`
        : [paired && `🔴 อัดเสียงในห้อง **${sess.room.name}**`, // a phone took the link (U20): only the room audio
          sess.cur?.rec.state !== 'voice' && `🟡 รอเริ่มอัดจอ${sess.owner ? `ของ <@${sess.owner}>` : ''}`].filter(Boolean).join(' · '),
  ] : [
    v && (!paired || phone) ? `🔴 อัดเสียงในห้อง **${v.channel.name}** · เริ่ม ${ago(v.began)}` : null,
    offered && !phone ? `${paired ? `🔴 อัดเสียงในห้อง **${v.channel.name}** · ` : ''}🟡 รอ <@${sc.owner}> เปิดหน้าอัดจอแล้วกด ▶️` : null,
    sc && !offered ? `🔴 อัดจอ${sc.owner ? `ของ <@${sc.owner}>` : ''} · เริ่ม ${ago(sc.liveAt ?? sc.began)}`
      + `${paired ? ` · อัดเสียงในห้อง **${v.channel.name}** ด้วย` : ''}` : null,
  ].filter(Boolean);
  const bottom = new ActionRowBuilder().addComponents(button('config:open'),
    ...(driveEnabled ? [linkButton('📁 Google Drive', folderUrl)] : []), ...(browserScreen ? [button('agent:install')] : []), button('panel:refresh'));
  // only what makes sense now: a room audio that belongs to a screen recording is stopped with it, and an
  // unopened offer gets a quiet cancel, not a red stop. The specific stop labels only when two stops show
  const voiceStop = Boolean(v) && !paired;
  const two = voiceStop && Boolean(sc);
  const actions = [
    ...(!v && !startingVoice.has(g) && !sess ? [button('record:start')] : []), // a session brings its own room audio
    ...(voiceStop ? [two ? button('record:stop') : stopBtn('record:stop')] : []),
    ...(sc ? [offered && !paired ? button('screen:stop', null, { label: '✖️ ยกเลิกอัดจอ', style: ButtonStyle.Secondary })
      : two ? button('screen:stop') : stopBtn('screen:stop')]
      // D12: with PUBLIC_URL 🖥️ (their agent) and 🌐 (a link); without it the host Mac's 🖥️
      : browserScreen ? [button('screen:me'), button('screen:link')] : macScreen ? [button('screen:start')] : []),
  ];
  return {
    content: [
      '🎛️ **Recorder**',
      ...(status.length ? status : ['⚪ ยังไม่ได้อัด — เข้าห้องเสียงแล้วกด 🎙️']),
      ...(screenEnabled ? [cardsLabel(s, screenEnabled)] : []),
      ...(agents.length ? [`🟢 ตัวอัดออนไลน์: ${agents.slice(0, 5).map((u) => `<@${u}>`).join(' ')}${agents.length > 5 ? ` +${agents.length - 5}` : ''}`] : []),
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
const NICK_TAG = / - 🔴 (?:กำลังอัด|อัดจออัตโนมัติ).*$/u;
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
    const rec = sc && live(sc) ? sc : sc && hiddenStart(sc) ? null : v; // a private start tags nothing until it records
    // an auto-started screen says so (same length as กำลังอัดหน้าจอ: the 32-unit cap keeps the same room for the name)
    const status = !rec ? null : rec === sc ? (sc.cur?.auto ? 'อัดจออัตโนมัติ' : 'กำลังอัดหน้าจอ') : 'กำลังอัดเสียง';
    let want;
    if (status) {
      // our own tagged name left over from a restart is not worth restoring
      if (!nickBefore.has(g)) {
        const saved = getSettings(g).nickBefore; // undefined = nothing saved
        nickBefore.set(g, !NICK_TAG.test(me.nickname ?? '') ? me.nickname ?? null : saved !== undefined ? saved : null);
        updateSettings(g, { nickBefore: nickBefore.get(g) });
      }
      // whose screen is recorded / who pressed (a session waiting for the next screen: its presser, D13)
      const id = rec.owner ?? rec.by ?? (sc?.paired === rec ? sc.owner ?? sc.by : null);
      const name = (id && /^\d+$/.test(id) && guild.members.cache.get(id)?.displayName)
        || nickBefore.get(g) || client.user.username;
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

const startingScreen = new Set(); // guildIds with a screen start in flight (manual or a session segment)
const startingVoice = new Set();  // guildIds with a voice start in flight (manual or paired)
let finalizingScreen = 0;         // ffmpeg processes still writing their mp4 after a stop
const screenBusy = () => [...screen.values()].some((r) => r.kind === 'mac' || (r.kind === 'session' && r.cur?.rec.kind === 'mac'))
  || startingScreen.size > 0 || finalizingScreen > 0;

// per server: sharers not offered a card (nor a 🔴 ต่อ) again until they stop sharing in Discord
// (stopped by hand, declined, failed to start, or stopped at their agent)
const cardSkip = new Map(); // guildId -> Set<userId>
const skipSet = (map, g) => map.get(g) ?? map.set(g, new Set()).get(g);
// only while they share: the skip is cleared when they stop, so one added after that would outlive the share
const skipSharer = (guild, u) => { if (guild?.voiceStates.cache.get(u)?.streaming) skipSet(cardSkip, guild.id).add(u); };

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
  if (!minutes) return;
  rec.maxAt = Date.now() + minutes * 60000;
  rec.maxTimer = setTimeout(() => finish(rec, '⏱️ ครบเวลาอัดสูงสุดที่ตั้งไว้').catch(console.error), minutes * 60000);
}

function trackVoice(g, rec) {
  Object.assign(rec, { guildId: g, began: Date.now(), onGone: () => voiceGone(rec) });
  voice.set(g, rec);
  armMax(rec, finishVoice);
  stateChanged(g);
  rlog(g, `🎙️ เริ่มอัดเสียง ห้อง ${rec.channel.name}${rec.by ? ` โดย ${who(rec.by)}` : ''}${rec.pairedTo ? ' (คู่กับอัดจอ)' : ''}`);
}

// the bot was kicked from the room or lost its connection: a voice recording ends; the room audio of a
// screen recording stops where it is (delivered with the video), the video goes on
function voiceGone(rec) {
  const g = rec.guildId;
  if (voice.get(g) !== rec) return;
  rlog(g, `⚠️ บอทหลุดจากห้องเสียง ${rec.channel.name}`);
  const owner = rec.pairedTo;
  if (owner && screen.get(g) === owner) {
    if (owner.kind === 'session') { // case 16: live video goes on with a note; no video right now (waiting, link unopened): end
      if (owner.state === SESSION.waiting || !live(owner)) return finishSession(owner, '⚠️ บอทหลุดจากห้องเสียง').catch(console.error);
      owner.notes += '\n⚠️ บอทหลุดจากห้องเสียงกลางทาง เสียงมีถึงตอนนั้น';
      return;
    }
    // an offer nobody opened (or a phone, U20) has no video: the room audio was all of it, so end it now
    if (owner.kind === 'browser' && !owner.liveAt) return finishScreen(owner, '⚠️ บอทหลุดจากห้องเสียง').catch(console.error);
    owner.notes = `${owner.notes ?? ''}\n⚠️ บอทหลุดจากห้องเสียงกลางทาง เสียงมีถึงตอนนั้น`; // live video goes on
    return;
  }
  finishVoice(rec, '⚠️ บอทหลุดจากห้องเสียง').catch(console.error);
}

// ffmpeg dying on its own (display/permission change, disk full) is reported, not left as a ghost "recording"
// a browser capture ends on its own too (offer expired, page closed or stopped): exitReason says why
function trackScreen(g, rec) {
  Object.assign(rec, { guildId: g, began: Date.now() });
  screen.set(g, rec);
  if (rec.kind !== 'browser') armMax(rec, finishScreen); // browser: from going live (onLive)
  stateChanged(g);
  rlog(g, rec.kind === 'browser'
    ? `🎥 ส่งปุ่มอัดจอให้ ${who(rec.owner)}${rec.channelName ? ` ห้อง ${rec.channelName}` : ''} capture ${rec.capId}`
    : `🖥️ เริ่มอัด${rec.what} โดย ${who(rec.by)}`);
  rec.exited.then(() => {
    if (rec.stopping) return;
    if (screen.get(g) === rec) {
      finishScreen(rec, rec.exitReason ?? '⚠️ ffmpeg หยุดเองระหว่างอัด ไฟล์อาจไม่สมบูรณ์');
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
  const inUse = new Set([...voice.values(), ...screen.values()] // a session's segments have their own dirs
    .flatMap((r) => [r.dir, ...(r.segments ?? []).map((s) => s.rec.dir), r.pending?.rec?.dir]));
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
async function finishScreen(rec, reason) {
  const g = rec.guildId;
  const browser = rec.kind === 'browser';
  if (screen.get(g) !== rec) { // already stopped (double click, timer vs. button...)
    if (browser) rec.stop().catch(() => {}); // idempotent: makes sure it's finalizing, the first finish reports
    return;
  }
  screen.delete(g);
  rec.finished = true; // queued live-card renders are dropped from here on
  clearTimeout(rec.maxTimer);
  rlog(g, `⏹️ หยุด${browser && !rec.liveAt ? 'ข้อเสนออัดจอ (ยังไม่ได้เริ่ม)' : `อัด${rec.what}`}${rec.owner ? ` ของ ${who(rec.owner)}` : ''}: ${reason ?? '-'}`);
  if (browser) {
    // the server's slot is free: rooms with sharers get their cards back
    setImmediate(() => { const guild = client.guilds.cache.get(g); if (guild) checkShares(guild); });
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
        await oi.editReply({ content: rec.offerNote ?? '⌛ ลิงก์หมดเวลาแล้ว กด 🌐 อัดผ่านเบราว์เซอร์ ใหม่ได้เลย', components: [], ...quiet }).catch(() => {});
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
    browser ? rec.stop() : rec.stop().finally(() => { finalizingScreen--; }),
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
  const head = ok && !gotVideo // nothing recorded on screen: only the room's audio
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

async function finishVoice(rec, reason) {
  const g = rec.guildId;
  if (voice.get(g) !== rec) return;
  const owner = rec.pairedTo; // the screen recording this room audio belongs to
  if (owner && screen.get(g) === owner) return finishAny(owner, reason); // one card for both
  voice.delete(g);
  rec.finished = true;
  clearTimeout(rec.maxTimer);
  if (owner) { // joined after its screen recording had already ended: nothing to deliver it on
    stateChanged(g);
    rec.notice?.delete().catch(() => {}); // nothing was announced as recorded: no "stopped" line either
    await rec.stop().catch(console.error);
    return;
  }
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
const linkRow = (rec) => new ActionRowBuilder().addComponents(linkButton('🎥 เปิดหน้าอัดจอ', pageUrl(rec)));
const linkReply = (rec) => ephemeral([
  '🎥 กดปุ่มด้านล่าง → เลือกจอ → กด **แชร์** แค่นั้น',
  `-# บอทจะเข้าห้อง **${rec.channelName}** มาอัดเสียงด้วย · ใช้คอมพิวเตอร์ (มือถืออัดได้แค่เสียง) · ลิงก์นี้ของคุณคนเดียว หมดอายุ ${ago(rec.began + 5 * 60000)}`,
].join('\n'), { components: [linkRow(rec).addComponents(button('agent:install'))] });

client.on('interactionCreate', async (i) => {
  let cmd, sub, tag;
  if (i.isChatInputCommand()) [cmd, sub] = [i.commandName, i.options.getSubcommand(false)];
  else if (i.isUserContextMenuCommand()) cmd = 'panel';
  else if ((i.isButton() || i.isAnySelectMenu()) && /^(record|screen|panel|perm|config|agent):/.test(i.customId)) {
    [cmd, sub, tag] = i.customId.split(':');
  } else return;
  if (!guildAllowed(i.guildId)) return i.reply(ephemeral('บอทนี้ไม่ได้เปิดให้ใช้ใน server นี้'));
  const g = i.guildId;

  // anyone may open the panel; recording needs the recorder role; settings need Manage Server.
  // The sharer of a browser capture (or a session's current screen) may always use its own 🎥 / ⏹️ buttons,
  // and a sharer may press the 🔴 / 🔁 / 🔴 ต่อ that names them (D9): only their own screen
  const own = cmd === 'screen' && Boolean(tag) && (['me', 'stop'].includes(sub) ? screen.get(g)?.owner === i.user.id
    : ['rec', 'cont', 'switch'].includes(sub) && tag.split('.').pop() === i.user.id);
  const adminOnly = cmd === 'settings' || cmd === 'config';
  if (cmd !== 'panel' && cmd !== 'agent' && !own && !(adminOnly ? isAdmin(i) : canRecord(i))) {
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
    if (cmd === 'agent') return await handleAgent(i, sub, tag); // anyone: their own devices; agent:kick re-checks isAdmin inside
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
      const sess = screen.get(g)?.kind === 'session' ? screen.get(g) : null; // brings (or is about to bring) its own room audio
      if (voice.has(g) || startingVoice.has(g) || sess) {
        const v = voice.get(g), room = v?.channel.name ?? sess?.room.name ?? channel?.name; // a paired room audio's card is the screen's
        return await i.reply(ephemeral(`บอทกำลังอัดเสียง${room ? `ในห้อง **${room}** ` : ' '}อยู่แล้ว ${v?.pairedTo?.card?.url ?? v?.card?.url ?? sess?.card?.url ?? ''}`));
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
    if (cmd === 'screen' && sub === 'rec') return await pressRec(i, tag);
    if (cmd === 'screen' && (sub === 'cont' || sub === 'switch')) return await pressNext(i, sub, tag);
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
      const s = getSettings(g), opt = i.isChatInputCommand() && i.options.getString('mode');
      // with PUBLIC_URL the presser records their own screen whatever the mode setting (it is for share starts):
      // 🖥️ screen:me (and an old screen:start, /screen start) = their agent, 🌐 screen:link (/screen start mode:browser)
      // = the link. Without PUBLIC_URL: the host Mac, as before
      let mode = browserScreen ? (sub === 'link' || opt === 'browser' ? 'browser' : 'agent')
        : sub === 'full' ? 'screen' : opt || s.mode;
      if (!modes.includes(mode)) mode = modeOf(s);
      if (!isMac(mode)) { // the presser records their own screen: their agent, else through a link
        const here = screen.get(g);
        // pressed again before opening the page: just a fresh link for the same offer
        if (here?.state === 'offered' && !here.stopping && here.owner === i.user.id) {
          here.offerInteraction = i; // the newest link message is the one to tidy up
          return await i.reply(linkReply(here));
        }
        if (here || startingScreen.has(g)) {
          return await i.reply(ephemeral(here && here.kind !== 'session' && !live(here) ? `<@${here.owner}> กำลังจะอัดจออยู่ รอสักครู่แล้วลองใหม่`
            : `กำลังอัดจออยู่แล้ว ${here?.card?.url ?? ''}`));
        }
        const room = i.member.voice?.channel;
        if (!room) return await i.reply(ephemeral('🎙️ เข้าห้องเสียงก่อน (บอทจะเข้าไปอัดเสียงในห้องนั้นด้วย) แล้วกดอีกครั้ง'));
        if (!room.joinable) return await i.reply(ephemeral(joinFail(room.name)));
        if (mode === 'agent' && deps.agents.online(i.user.id)) return await agentManual(i, room); // their own machine, no link
        // nothing public yet: the card appears when the page really starts recording (onLive).
        // The link message is kept as offerInteraction (NOT interaction: putCard would turn it into the public card)
        const rec = Object.assign(offerBrowser(i.guild, i.user.id, i.channel, room), { private: true, offerInteraction: i }); // before any await
        const reply = linkReply(rec);
        // 🖥️ without their agent: say so; the link records now, 📥 installs the agent for next time
        if (mode === 'agent') reply.content = `⚠️ เครื่องของคุณยังไม่ได้เปิดตัวอัด — กด 📥 ติดตั้งตัวอัด หรือใช้ลิงก์ด้านล่างอัดผ่านเบราว์เซอร์แทนได้เลย\n${reply.content}`;
        return await i.reply(reply);
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
        return await finishAny(rec.pairedTo, `หยุดโดย <@${i.user.id}>`);
      }
      const offer = cmd === 'screen' && rec.kind !== 'session' && !live(rec) && !rec.paired; // a private link nobody opened
      if (offer) rec.offerNote ??= '✖️ ยกเลิกการอัดจอแล้ว'; // the link message says so, not "expired"
      if (i.isButton() && i.message.id === rec.card?.id) await i.deferUpdate();
      else if (offer) await i.reply(ephemeral('✖️ ยกเลิกการอัดจอแล้ว ลิงก์ที่ส่งไปใช้ไม่ได้แล้ว'));
      else await i.reply(ephemeral(`⏹️ กำลังหยุด ผลจะขึ้นที่ ${rec.card?.url ?? 'ข้อความของการอัดนี้'}`));
      return await (cmd === 'screen' ? finishAny : finishVoice)(rec, `หยุดโดย <@${i.user.id}>`);
    }
  } catch (e) {
    console.error(e);
    const msg = { content: isAbort(e) ? errText(e, i.member?.voice?.channel?.name) : `❌ ${errText(e)}`, components: errorButtons(e), ...quiet };
    return (i.deferred || i.replied ? i.editReply(msg) : i.reply({ ...msg, flags: MessageFlags.Ephemeral })).catch(console.error);
  }
});

// the quick page's selects and the 🔧 tabs (old messages' buttons still map); every change is saved right away and
// applied to the room cards
async function handleConfig(i, sub) {
  const g = i.guildId;
  if (sub === 'done') {
    return i.update({ content: `✅ **บันทึกแล้ว**${screenEnabled ? ` · ${cardsLabel(getSettings(g), screenEnabled)}` : ''}\n${summary(i.guild, viewOpts)}`, components: [row('config:open')], ...quiet });
  }
  if (sub.startsWith('page-')) return i.update(configView(i.guild, sub.slice(5), viewOpts));
  // one patch table for every select and old button id (config-ui.js applyConfig)
  const patch = applyConfig(sub, i.values ?? [], getSettings(g), { screenEnabled, browser: browserScreen, locked: allowed.length > 0, modes });
  if (!patch) return i.deferUpdate();
  const saved = updateSettings(g, patch); // in memory now, disk in the background
  await i.update(configView(i.guild, configPageOf(sub), viewOpts));
  checkShares(i.guild); // cards appear / go away (auto: a share may start now); a running session is never touched by settings
  stateChanged(g); // panels show the cards line
  if (!(await saved)) await i.followUp(ephemeral('⚠️ บันทึกการตั้งค่าลงดิสก์ไม่ได้ ใช้ได้จนกว่าบอทจะรีสตาร์ท (ดู log ของบอท)'));
}

// --- recorder agents (/agent) -----------------------------------------------------------------------

const secureUrl = /^https:\/\//i.test(publicUrl) || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(publicUrl); // the install scripts need https (or a local dev server)
const installable = secureUrl && SAFE_SERVER.test(publicUrl); // the same check the server uses before it serves the scripts
const TOKEN_RE = /^[A-Za-z0-9_-]+$/; // what the install scripts accept; anything else is never shown
// is uid in the guild now: the cache, else one REST fetch (an error, no answer within 1.5 s = not a member: the
// interaction must be answered within 3 s)
async function memberOf(guild, uid) {
  if (guild.members.cache.has(uid)) return true;
  let timer;
  const late = new Promise((r) => { timer = setTimeout(r, 1500, null); });
  try { return Boolean(await Promise.race([guild.members.fetch?.(uid), late])); } catch { return false; } finally { clearTimeout(timer); }
}
// an admin's reach: devices paired from this server; a record from before guildId was stored falls back to
// "the owner is a member here now". Re-checked on every 🗑️ press (buttons can be forged or replayed)
const inScope = (guild, d) => (d.guildId ? d.guildId === guild.id : memberOf(guild, d.userId));
const LEGACY_FETCH = 25; // at most this many uncached owners of old records are fetched per listing
async function serverDevices(guild, uid) {
  const others = deps.agents.allDevices().filter((d) => d.userId !== uid);
  const ask = [...new Set(others.filter((d) => !d.guildId && !guild.members.cache.has(d.userId)).map((d) => d.userId))].slice(0, LEGACY_FETCH);
  const members = new Set((await Promise.all(ask.map(async (u) => ((await memberOf(guild, u)) ? u : null)))).filter(Boolean));
  return others.filter((d) => (d.guildId ? d.guildId === guild.id : guild.members.cache.has(d.userId) || members.has(d.userId)));
}
const ownerName = (guild, u) => guild.members.cache.get(u)?.displayName ?? client.users.cache.get(u)?.username ?? 'สมาชิก';

// the /agent reply: install one-liners (when a fresh pairing is given), start/reconnect/uninstall commands, the
// presser's devices, and for a server admin every other member's device in scope (🗑️ agent:kick:<deviceId>)
// one OS's commands for /agent: install (with a fresh token), start later, uninstall — each in its own box
const osSection = (title, lang, install, start, uninstall) => [`### ${title}`,
  ...(install ? ['ติดตั้ง / อัปเดต', `\`\`\`${lang}\n${install}\n\`\`\``] : []),
  'เปิดตัวอัดทีหลัง', `\`\`\`${lang}\n${start}\n\`\`\``, 'ลบตัวอัด', `\`\`\`${lang}\n${uninstall}\n\`\`\``];
async function agentView(i, pairing, note = '') {
  const uid = i.user.id;
  const devs = deps.agents.devices(uid), shown = devs.slice(0, 4); // one row: 4 revokes + "all"
  const all = isAdmin(i) && i.guild ? await serverDevices(i.guild, uid) : null;
  const t = pairing?.token;
  const head = [
    ...(note ? [note] : []),
    ...(t && !installable ? ['⚠️ ติดตั้งตัวอัดไม่ได้: PUBLIC_URL ของบอทต้องเป็น https (ผู้ดูแลบอทต้องตั้งค่านี้ก่อน)']
      : !installable ? [] : [
      ...(t && TOKEN_RE.test(t) ? ['🎥 **ติดตั้งตัวอัดจอบนเครื่องของคุณ** — อัดเฉพาะจอเครื่องนี้'] : ['-# พิมพ์ /agent ใหม่เพื่อรับคำสั่งติดตั้ง']),
      // one section per OS, one box per command (copying a box never runs start and uninstall together)
      ...osSection('🍎 macOS / Linux — วางใน Terminal', 'sh', t && TOKEN_RE.test(t) && `curl -fsSL ${publicUrl}/agent/install.sh | DRA_TOKEN=${t} sh`,
        '~/.discord-recorder-agent/start.command', '~/.discord-recorder-agent/uninstall.command'),
      ...osSection('🪟 Windows — วางใน PowerShell', 'powershell', t && TOKEN_RE.test(t) && `$env:DRA_TOKEN='${t}'; irm ${publicUrl}/agent/install.ps1 | iex`,
        '& "$HOME\\.discord-recorder-agent\\start.cmd"', '& "$HOME\\.discord-recorder-agent\\uninstall.cmd"'),
      // a clock time: a relative <t:R> reads "1 second ago" once it has passed, which looks like it expired at once
      ...(t && TOKEN_RE.test(t) ? [`-# คำสั่งติดตั้งใช้ได้ครั้งเดียวถึง <t:${Math.floor(pairing.expires / 1000)}:t> (10 นาที)`] : []),
      // reconnect: start.command on a revoked/unpaired install asks for this code (none when AGENT_CODE_PAIRING=false)
      ...(pairing?.code && t ? ['**🔗 เชื่อมใหม่** (ถ้าตัวอัดขึ้นว่าถูกยกเลิกการเชื่อมต่อ) เปิดตัวอัดแล้วใส่รหัส 6 หลักนี้', `\`\`\`\n${pairing.code}\n\`\`\``,
        '-# หรือวางคำสั่งติดตั้งอีกครั้ง · รหัสใช้ได้ครั้งเดียว หมดเวลาพร้อมคำสั่งติดตั้ง']
        : ['-# 🔗 เชื่อมใหม่ (ถ้าตัวอัดขึ้นว่าถูกยกเลิกการเชื่อมต่อ): พิมพ์ /agent แล้ววางคำสั่งติดตั้งอีกครั้ง']),
    ]),
    '**เครื่องของคุณ**',
    ...(shown.length ? shown.map((d) => `${d.active ? '🟢 ออนไลน์' : '⚪ ออฟไลน์'} · ${short(d.name, 40)} (${d.os}) · เห็นล่าสุด ${ago(d.lastSeen)}`)
      : ['-# ยังไม่มีเครื่องที่ติดตั้ง']),
    ...(devs.length > shown.length ? [`-# แสดง ${shown.length} จาก ${devs.length} เครื่อง (ล่าสุดก่อน)`] : []),
  ];
  const rows = [];
  const btns = [...shown.map((d) => new ButtonBuilder().setCustomId(`agent:revoke:${d.deviceId}`).setLabel(short(`🗑️ ${d.name}`, 30)).setStyle(ButtonStyle.Secondary)),
    ...(devs.length > 1 ? [new ButtonBuilder().setCustomId('agent:revoke:all').setLabel('🗑️ ลบทั้งหมด').setStyle(ButtonStyle.Danger)] : [])];
  if (btns.length) rows.push(new ActionRowBuilder().addComponents(btns));
  if (!all) return ephemeral(head.join('\n'), { components: rows });
  // admin section: the newest that fit the free rows (5 buttons each) and 2000 characters
  const g = i.guild;
  const text = (n) => [...head, '**ตัวอัดใน server นี้**',
    ...(all.length ? all.slice(0, n).map((d) => `${d.active ? '🟢' : '⚪'} · <@${d.userId}> · ${short(d.name, 40)} (${short(d.os || '?', 16)}) · เห็นล่าสุด ${ago(d.lastSeen)}`)
      : ['-# ไม่มีตัวอัดของคนอื่นใน server นี้']),
    ...(all.length > n ? [`-# แสดง ${n} จาก ${all.length} เครื่อง (ล่าสุดก่อน)`] : [])].join('\n');
  let n = Math.min(all.length, (5 - rows.length) * 5);
  while (n > 0 && text(n).length > 2000) n--;
  const kicks = all.slice(0, n).map((d) => new ButtonBuilder().setCustomId(`agent:kick:${d.deviceId}`)
    .setLabel(short(`🗑️ ${ownerName(g, d.userId)} · ${d.name}`, 40)).setStyle(ButtonStyle.Secondary));
  for (let k = 0; k < kicks.length; k += 5) rows.push(new ActionRowBuilder().addComponents(kicks.slice(k, k + 5)));
  return ephemeral(text(n), { components: rows });
}

// /agent (a fresh pairing each time, replacing the last one), the owner's 🗑️ (agent:revoke, only their own devices)
// and an admin's 🗑️ on someone else's (agent:kick, re-checked here: admin + device in this server's scope)
async function handleAgent(i, sub, tag) {
  const uid = i.user.id;
  if (!browserScreen) return i.reply(ephemeral('ปิดตัวอัดจอไว้ (บอทนี้ไม่ได้ตั้ง PUBLIC_URL)'));
  if (!i.isButton() || sub === 'install') return i.reply(await agentView(i, deps.agents.newPairing(uid, i.guildId, i.user.tag)));
  if (sub === 'kick') {
    if (!i.guild || !isAdmin(i)) return i.reply(ephemeral('🔒 ลบตัวอัดของคนอื่นได้เฉพาะผู้ดูแล server'));
    const d = deps.agents.allDevices().find((x) => x.deviceId === tag);
    // revokeDevice re-reads the store: a device dropped during the membership fetch gives null
    const gone = d && (await inScope(i.guild, d)) ? deps.agents.revokeDevice(d.deviceId) : null;
    if (!gone) return i.reply(ephemeral('ไม่พบเครื่องนี้ใน server นี้ (อาจถูกลบไปแล้ว)'));
    rlog(i.guildId, `🗑️ ${who(uid)} ลบตัวอัดของ ${who(gone.userId)} (${gone.name})`);
    return i.update(await agentView(i, null, `✅ ลบตัวอัด **${short(gone.name, 40)}** ของ <@${gone.userId}> แล้ว (เครื่องนั้นต้องติดตั้งใหม่ถ้าจะใช้อีก)`));
  }
  if (sub !== 'revoke') return i.deferUpdate();
  if (tag !== 'all' && !deps.agents.devices(uid).some((d) => d.deviceId === tag)) {
    return i.reply(ephemeral('ไม่พบเครื่องนี้ในบัญชีของคุณ (อาจถูกลบไปแล้ว)')); // never someone else's
  }
  const n = deps.agents.revoke(uid, tag);
  rlog(i.guildId, `🗑️ ${who(uid)} ลบตัวอัด ${n} เครื่อง`);
  return i.update(await agentView(i, null, `✅ ลบแล้ว ${n} เครื่อง (เครื่องนั้นต้องติดตั้งใหม่ถ้าจะใช้อีก)`));
}

// transitions only (the hub guarantees it): a log line, and the panels of the servers they are in
function onAgentChange(uid, online) {
  const guilds = [...client.guilds.cache.values()].filter((gd) => gd.members.cache.has(uid));
  rlog(guilds[0]?.id ?? '-', `${online ? '🟢' : '⚪'} ตัวอัดของ ${who(uid)} ${online ? 'ออนไลน์' : 'ออฟไลน์'}`);
  for (const gd of guilds) refreshPanels(gd);
  // auto mode: their share may start recording now (or continue a session waiting for the next screen). Not from
  // inside the hub's own call
  if (online) setImmediate(() => guilds.forEach(checkShares));
}

// manual 🎥 with the presser's agent online (D11): a manual session on their machine, continuous (spec rule 7), not
// tied to sharing. It records at once (the room audio, public card); a failed agent start keeps the audio and sends
// them the private link instead, in this same ephemeral reply
async function agentManual(i, room) {
  const g = i.guildId, guild = i.guild, uid = i.user.id;
  const busy = busyText(g, room); // a manual 🎙️ already holds the server's voice connection
  if (busy) return i.reply(ephemeral(busy));
  const sess = newSession(guild, room, i.channel, uid, 'manual'); // reserved before any await
  rlog(g, `🖥️ ${who(uid)} กดอัดจอ (ตัวอัด) ห้อง ${room.name}`);
  const started = launch(sess, guild, uid, uid);
  await i.reply(ephemeral('🔴 เริ่มอัดแล้ว บอทเข้าห้องอัดเสียง · ⏳ กำลังสั่งเครื่องของคุณให้อัดจอ...'));
  const r = await started;
  await sess.cardQ;
  const url = sess.card?.url ?? '', on = screen.get(g) === sess && !sess.finished;
  if (!r || !on) return i.editReply({ content: `⚪ การอัดนี้จบแล้ว ดูที่การ์ด ${url}`.trimEnd(), components: [], ...quiet });
  const stopHint = '-# หยุดได้ที่ปุ่ม ⏹️ บนการ์ด หรือเมื่อคุณออกจากห้องเสียง';
  if (r.seg?.source === SESSION.agent) return i.editReply({ content: `🔴 เริ่มอัดจอเครื่องของคุณแล้ว ${url}\n${stopHint}`, components: [], ...quiet });
  const f = r.fail ?? {};
  const why = { [ACK_ERROR.busy]: 'เครื่องของคุณกำลังอัดอยู่', [ACK_ERROR.declined]: 'เครื่องของคุณไม่ยอมให้อัดจอ', [ACK_ERROR.timeout]: 'เครื่องของคุณไม่ตอบ',
    [ACK_ERROR.display]: 'หาจอที่จะอัดไม่เจอ', [ACK_ERROR.offline]: 'ตัวอัดออฟไลน์' }[f.error]
    ?? `ตัวอัดเริ่มอัดไม่ได้${f.detail ? `: ${String(f.detail).slice(0, 300)}` : ''}`;
  if (r.seg?.source === SESSION.link) { // the audio goes on; their screen through the link, only they see it
    return i.editReply({
      content: [`⚠️ ${why} — บอทยังอัดเสียงในห้องอยู่ ${url}`.trimEnd(), '🎥 กดปุ่มด้านล่าง → เลือกจอ → กด **แชร์** เพื่ออัดจอด้วย',
        `-# ใช้คอมพิวเตอร์ (มือถืออัดได้แค่เสียง) · ลิงก์นี้ของคุณคนเดียว\n${stopHint}`].join('\n'),
      components: [new ActionRowBuilder().addComponents(linkButton('🎥 เปิดหน้าอัดจอ', cardLink(r.seg.rec)), button('agent:install'))], ...quiet,
    });
  }
  return i.editReply({ content: `⚠️ ${why} — อัดแค่เสียงในห้อง ${url}\n${stopHint}`, components: [], ...quiet });
}

// --- share cards and sessions (press-to-start) ------------------------------------------------------
// Nothing records until someone presses (rule 1). A share posts a room card with one 🔴 per sharer; a press
// turns that card into a session: one continuous room audio plus video segments, one machine at a time (the
// sharer's agent, else the card link in browser mode, else the host Mac: D10). One session per server (one
// voice connection per guild: D2), kept in the screen Map as kind 'session'. Its end composes one file.

const shareStart = new Map();     // `${guildId}:${userId}` -> when that person started sharing
const recheckTimers = new Map();  // guildId -> timer waiting out minShareSeconds
const roomCards = new Map();      // voice channelId -> {guildId, room, textChannel, sharers, card, cardQ}

const humansIn = (ch) => ch?.members.filter((m) => !m.user.bot).size ?? 0;
const isWatched = (ch, s) => ch.isVoiceBased() && (!s.channels.length || s.channels.includes(ch.id));
const watched = (guild, s) => [...guild.channels.cache.values()].filter((ch) => isWatched(ch, s));
const canShare = (m, s) => (!autoScreenUsers.length || autoScreenUsers.includes(m.id))
  && (!s.roles.length || m.roles.cache.hasAny(...s.roles));
// where cards and results go: the chosen channel, else the given fallback (the voice channel's chat)
const notifyIn = (guild, fallback) => guild.channels.cache.get(getSettings(guild.id).notifyChannel) ?? fallback;
// humans sharing in the room who may be recorded: allowed by the card filters and not skipped
const sharersIn = (ch, s = getSettings(ch.guild.id)) => [...ch.members.values()]
  .filter((m) => !m.user.bot && m.voice.streaming && canShare(m, s) && !cardSkip.get(ch.guild.id)?.has(m.id)).map((m) => m.id);
const sharing = (sess) => sharersIn(sess.room);

// auto mode is on and in schedule; autoRoom: the room passes the card filters too
const autoOn = (s) => screenEnabled && shareModeOf(s) === 'auto' && inSchedule(s);
const autoRoom = (ch, s) => autoOn(s) && isWatched(ch, s) && humansIn(ch) >= s.minMembers;
// u has shared for minShareSeconds; else a re-check when they will have
const sharedLong = (guild, u, s) => {
  const wait = s.minShareSeconds * 1000 - (Date.now() - (shareStart.get(`${guild.id}:${u}`) ?? 0));
  if (wait > 0) recheckIn(guild, wait);
  return wait <= 0;
};

function recheckIn(guild, ms) {
  if (recheckTimers.has(guild.id)) return; // a pending check re-schedules itself if still needed
  recheckTimers.set(guild.id, setTimeout(() => { recheckTimers.delete(guild.id); checkShares(guild); }, ms + 250));
}

// every voice event, settings change and the minute sweep: each room's card shows exactly the people sharing
// there (a shared-long-enough, filtered, unskipped human), and the server's session moves along
function checkShares(guild) {
  if (!guildAllowed(guild.id)) return;
  const g = guild.id, s = getSettings(g);
  if (screen.get(g)?.kind === 'session') sessionEvent(screen.get(g), guild);
  const sess = screen.get(g)?.kind === 'session' ? screen.get(g) : null; // may have just ended
  const on = screenEnabled && s.shareCards && inSchedule(s);
  const rooms = new Map(on ? watched(guild, s).map((ch) => [ch.id, ch]) : []);
  for (const rc of roomCards.values()) if (rc.guildId === g) rooms.set(rc.room.id, rc.room); // so it can go away
  for (const ch of rooms.values()) {
    let want = [];
    // the session's own room has its card (🔁 / 🔴 ต่อ) instead
    if (on && isWatched(ch, s) && humansIn(ch) >= s.minMembers && sess?.room.id !== ch.id) {
      want = sharersIn(ch, s).filter((u) => sharedLong(guild, u, s));
      // auto: the first of them (one with an agent online first) records by itself, when nothing else records in the
      // server (one session per server: a second room gets its card). No agent: the link / the host Mac (if free)
      const u = autoOn(s) && ch.joinable && !busyText(g, ch)
        && ((useAgent(g) && want.find((x) => deps.agents.online(x))) || (!isMac(modeOf(s)) || !screenBusy() ? want[0] : undefined));
      if (u) { autoStart(guild, ch, u).catch(console.error); continue; } // its card (if any) becomes the session's
    }
    setRoomCard(guild, ch, want);
  }
}

function setRoomCard(guild, ch, sharers) {
  const rc = roomCards.get(ch.id);
  if (!sharers.length) return rc && dropRoomCard(rc);
  if (rc && rc.sharers.join() === sharers.join()) return;
  const card = rc ?? { guildId: guild.id, room: ch, textChannel: notifyIn(guild, ch), remember: rememberRoomCard };
  card.sharers = sharers;
  if (!rc) {
    roomCards.set(ch.id, card);
    rlog(guild.id, `📣 ส่งการ์ดแชร์จอ ห้อง ${ch.name}: ${sharers.map(who).join(', ')}`);
  }
  renderCard(card, () => (card.gone ? null : roomCardOf(card)));
}
// nobody shares there any more: the card goes (it recorded nothing). keep: a press made it a session's card
function dropRoomCard(rc, keep = false) {
  roomCards.delete(rc.room.id);
  if (!keep) rlog(rc.guildId, `🗑️ ลบการ์ดแชร์จอ ห้อง ${rc.room.name}`);
  rc.gone = true; // queued renders are skipped from here on
  if (keep) return forgetRoomCard(rc);
  rc.cardQ = (rc.cardQ ?? Promise.resolve()).then(async () => {
    // can't delete (permissions): at least no live 🔴 is left on it. Inside the card's queue, so in order
    if (rc.card && !(await rc.card.delete().then(() => true, () => false))) {
      await rc.card.edit({ content: '⚪ **ไม่ได้อัด** — เลิกแชร์จอแล้ว', components: [], ...quiet }).catch(() => {});
    }
    forgetRoomCard(rc);
  });
}
// room cards are kept in the settings file too: a restart deletes them (clientReady), then checkShares reposts
function rememberRoomCard(rc) {
  const { channelId, id } = rc.card ?? {};
  if (!channelId || !id) return;
  const list = (getSettings(rc.guildId).roomCards ?? []).filter(([, m]) => m !== id);
  updateSettings(rc.guildId, { roomCards: [[channelId, id], ...list].slice(0, 20) });
}
function forgetRoomCard(rc) {
  const id = rc.card?.id, list = getSettings(rc.guildId).roomCards ?? [];
  if (id && list.some(([, m]) => m === id)) updateSettings(rc.guildId, { roomCards: list.filter(([, m]) => m !== id) });
}
async function dropOrphanRoomCards(guild) {
  const list = getSettings(guild.id).roomCards ?? [];
  if (!list.length) return;
  for (const [channelId, messageId] of list) await guild.channels.cache.get(channelId)?.messages.delete(messageId).catch(() => {});
  const done = new Set(list.map(([, m]) => m)); // a card posted meanwhile is a live one
  await updateSettings(guild.id, { roomCards: (getSettings(guild.id).roomCards ?? []).filter(([, m]) => !done.has(m)) });
}

const finishAny = (rec, reason) => (rec.kind === 'session' ? finishSession : finishScreen)(rec, reason);

// one recording per server (D2): why a 🔴 can't start a session for room ch now, or null
function busyText(g, ch) {
  const cur = screen.get(g), v = voice.get(g);
  if (!cur && !v && !startingScreen.has(g) && !startingVoice.has(g)) return null;
  const room = cur?.room ?? v?.channel, name = room?.name ?? cur?.channelName;
  const url = cur?.card?.url ?? v?.pairedTo?.card?.url ?? v?.card?.url ?? '';
  if (!name) return 'บอทกำลังเริ่มอัดอยู่ ลองใหม่อีกสักครู่';
  return (room?.id === ch.id ? `กำลังอัดอยู่แล้ว ${url}` : `บอทอัดได้ทีละห้องต่อ server ตอนนี้อัดห้อง **${name}** อยู่ ${url}`).trimEnd();
}

// 🔴 on a room card: record uid's screen in the room they share in. The only way a share session starts
async function pressRec(i, uid) {
  const g = i.guildId, guild = i.guild;
  const vs = guild.voiceStates.cache.get(uid), ch = vs?.streaming ? vs.channel : null;
  if (!ch) {
    checkShares(guild); // a stale card catches up
    return i.reply(ephemeral(`<@${uid}> ไม่ได้แชร์จออยู่แล้ว`));
  }
  const busy = busyText(g, ch);
  if (busy) return i.reply(ephemeral(busy));
  if (!ch.joinable) return i.reply(ephemeral(joinFail(ch.name)));
  if (isMac(modeOf(getSettings(g))) && screenBusy()) {
    return i.reply(ephemeral('🖥️ จอเครื่องบอทกำลังถูกอัดอยู่ (อาจเป็นของ server อื่น) ลองใหม่อีกสักครู่'));
  }
  const rc = roomCards.get(ch.id);
  const sess = newSession(guild, ch, rc?.textChannel ?? i.channel, i.user.id); // reserved before any await
  // the room card becomes the session's card: same message, its queued writes first
  if (rc) { dropRoomCard(rc, true); sess.cardQ = rc.cardQ; }
  sess.card = rc?.card ?? (i.message?.edit ? i.message : undefined);
  sess.interaction = i; // its deferred update can still edit the card if the bot can't
  rememberCard(sess);
  rlog(g, `🔴 ${who(i.user.id)} กดอัดจอของ ${who(uid)} ห้อง ${ch.name}`);
  // launched before the defer: an expired press (10062) must not strand the reserved session; the card shows the rest
  const started = launch(sess, guild, uid, i.user.id);
  started.catch(() => {}); // handled by the await below, not an unhandled rejection meanwhile
  await i.deferUpdate().catch((e) => console.error('defer 🔴:', e.message));
  await started;
}

// auto mode: uid shares in ch (card filters passed, nothing records in the server). The session starts as if 🔴 was
// pressed for them, by them (the old auto flow): the bot joins and records the room at once, their screen comes from
// their agent, else the card link (browser mode) or the host Mac. A failed agent start skips them for auto (no loop)
// and falls back like no agent
async function autoStart(guild, ch, uid) {
  const g = guild.id, rc = roomCards.get(ch.id);
  const sess = Object.assign(newSession(guild, ch, rc?.textChannel ?? notifyIn(guild, ch), uid), { auto: true }); // reserved before any await
  if (rc) { // the room card becomes the session's card, even one whose post is still on its way
    dropRoomCard(rc, true);
    sess.card = rc.card;
    sess.cardQ = (rc.cardQ ?? Promise.resolve()).then(() => {
      if (!sess.card && rc.card) { sess.card = rc.card; forgetRoomCard(rc); }
      rememberCard(sess);
    });
  }
  rlog(g, `⚡ เริ่มอัดจอของ ${who(uid)} ห้อง ${ch.name} (อัตโนมัติ)`);
  await launch(sess, guild, uid, uid, { auto: true });
}

// a new session records at once (the old flow): the bot joins the room while uid's screen starts, neither waits for
// the other. A failed agent start keeps the room audio and falls back like no agent (startScreen); the session is
// cancelled only when nothing records at all. -> startScreen's result, null when the session ended meanwhile
async function launch(sess, guild, uid, by, { auto = false } = {}) {
  const g = guild.id;
  sess.want = uid; // whose screen this session is for until one records (sessionEvent)
  const joined = joinSession(sess, guild).catch(console.error);
  const started = startScreen(sess, uid, by, { auto });
  renderCard(sess, liveCardOf(sess)); // 🔴 at once, with "telling their machine..."
  const r = await started;
  if (!r || screen.get(g) !== sess || sess.finished) return null;
  // the join failed while this start was on its way: decided now (a join still on its way decides in joinSession)
  if (await joinFailed(sess, errorButtons(r.e))) return null;
  if (!r.seg) renderCard(sess, liveCardOf(sess)); // the room audio goes on; the note says why there's no screen
  sessionEvent(sess, guild); // they may have stopped sharing while it started
  await joined;
  return screen.get(g) === sess ? r : null;
}

// uid's screen as the session's next segment: their agent when online; a failed agent start (or none) falls back to
// the card link (browser mode, a manual session's private link) or the host Mac, as if they had no agent, with the
// reason as a note. A share session falls back only while uid still shares in its room.
// -> {seg} (seg missing: no screen; fail: the agent's failure) | null when the session ended meanwhile
async function startScreen(sess, uid, by, { auto = false } = {}) {
  const g = sess.guildId, guild = client.guilds.cache.get(g);
  let fail = null;
  // browser mode never commands an agent on a share start; a manual 🖥️ session is the presser's own agent whatever the mode
  if ((sess.mode === 'manual' || useAgent(g)) && deps.agents.online(uid)) {
    const r = await startSegment(sess, uid, by, { auto });
    if (!r) return null;
    if (!r.text) return { seg: r };
    fail = r;
    sess.notes += `\n-# ⚠️ ${r.text}`;
    rlog(g, `⚠️ ตัวอัดของ ${who(uid)} เริ่มไม่ได้: ${r.error ?? '-'}`);
    if (auto) skipSharer(guild, uid); // auto never asks their machine again until they re-share
  }
  const vs = guild?.voiceStates.cache.get(uid);
  if (sess.mode === 'share' && (vs?.channelId !== sess.room.id || !vs.streaming)) return { fail, ...fail };
  // the host Mac already records its own screen (a 🔁 to someone without a working agent): only whose share it is changes
  if (sess.cur?.rec.kind === 'mac' && sess.mode === 'share' && isMac(modeOf(getSettings(g)))) {
    sess.cur.owner = uid;
    stateChanged(g);
    renderCard(sess, liveCardOf(sess));
    return { seg: sess.cur, fail };
  }
  const r = await startSegment(sess, uid, by, { agent: false, auto });
  if (!r) return null;
  if (!r.text) return { seg: Object.assign(r, { upgrade: Boolean(fail) }), fail }; // their agent just failed: no auto retry onto it
  sess.notes += `\n-# ⚠️ ${r.text}`;
  return { fail: fail ?? r, text: r.text, e: r.e };
}

function newSession(guild, room, textChannel, by, mode = 'share') {
  const g = guild.id;
  const sess = {
    kind: 'session', guildId: g, room, textChannel, by, mode, began: Date.now(), state: SESSION.starting, dir: dirFor(g),
    paired: null, cur: null, pending: null, segments: [], notes: '', finished: false,
    get owner() { return this.cur?.owner ?? this.pending?.owner; }, // whose screen: their own ⏹️, the nickname
  };
  screen.set(g, sess); // synchronously: one session per server
  armMax(sess, finishSession);
  stateChanged(g);
  return sess;
}

const agentFail = (uid, r = {}) => ({
  [ACK_ERROR.declined]: `<@${uid}> ไม่อนุญาตให้อัดจอ`,
  [ACK_ERROR.timeout]: `เครื่องของ <@${uid}> ไม่ตอบ`,
  [ACK_ERROR.busy]: `เครื่องของ <@${uid}> กำลังอัดอย่างอื่นอยู่`,
  [ACK_ERROR.display]: `เครื่องของ <@${uid}> หาจอที่จะอัดไม่เจอ`,
  [ACK_ERROR.offline]: `ตัวอัดของ <@${uid}> ออฟไลน์`,
}[r.error] ?? `ตัวอัดของ <@${uid}> เริ่มอัดไม่ได้${r.detail ? `: ${String(r.detail).slice(0, 300)}` : ''}`);

// one source for uid's screen as the session's next segment (D10): agent true = their online agent only; false = the
// card link (browser mode; a manual session's link is private, sent in the presser's reply) else the host Mac.
// Resolves the accepted segment (now sess.cur), {text, e, error, detail} when it couldn't start, or null when the
// session ended meanwhile. sess.pending is set before the first await: one start at a time.
// auto: started by auto mode, not a press (the card, the nickname and the logs say so)
async function startSegment(sess, uid, by, { agent = true, auto = false } = {}) {
  const g = sess.guildId, mode = modeOf(getSettings(g));
  const on = agent ? deps.agents.online(uid) : null;
  if (agent && !on) return { text: agentFail(uid, { error: ACK_ERROR.offline }), error: ACK_ERROR.offline };
  const source = on ? SESSION.agent : sess.mode === 'manual' || !isMac(mode) ? SESSION.link : SESSION.mac;
  const seg = { owner: uid, began: Date.now(), source, auto, private: source === SESSION.link && sess.mode === 'manual' };
  const gone = () => screen.get(g) !== sess || sess.finished;
  if (gone()) return null; // e.g. cancelled between a failed agent start and its fallback
  sess.pending = seg;
  try {
    if (seg.source === SESSION.mac) {
      if (screenBusy()) return { text: '🖥️ จอเครื่องบอทกำลังถูกอัดอยู่ (อาจเป็นของ server อื่น)' };
      startingScreen.add(g);
      try {
        seg.rec = await screenRecorder(g, mode, { fallback: true });
        await seg.rec.start();
      } catch (e) {
        console.error(e);
        if (gone()) return null;
        return { text: `❌ อัดจอเครื่องบอทไม่ได้: ${errText(e)}`, e };
      } finally {
        startingScreen.delete(g);
      }
      wireSegment(sess, seg);
      if (gone()) { discardSeg(seg, stopSeg(seg)); return null; }
      return accept(sess, seg);
    }
    seg.rec = new BrowserCapture(dirFor(g), { guildId: g, owner: uid, offerMs: 0, via: seg.source === SESSION.agent ? 'agent' : 'page' });
    wireSegment(sess, seg);
    if (seg.source === SESSION.link) return accept(sess, seg); // the link goes on the card; the room is recorded meanwhile
    renderCard(sess, liveCardOf(sess)); // ⏳ telling their machine
    const r = await deps.agents.start(uid, seg.rec, { // maxMs 0 = no limit; room/by are for display
      maxMs: sess.maxAt ? Math.max(0, sess.maxAt - Date.now()) : 0, room: sess.room.name, by: nameOf(client.guilds.cache.get(g), by), area: getSettings(g).area });
    const ok = r?.ok && !seg.rec.exitReason && seg.rec.liveAt; // an ack without a claim is no recording
    if (ok && r.note) sess.notes += `\n-# ⚠️ ${String(r.note).slice(0, 200)}`; // e.g. no Discord window: the whole screen instead
    if (ok && !gone()) return accept(sess, seg);
    // a device that never started gets no stop (it may be busy with something else); one that did is told to stop.
    // Never accepted either way (e.g. it claimed, then ⏹️ before the ack): nothing of it is delivered
    discardSeg(seg, ok ? stopSeg(seg) : seg.rec.stop().catch(() => null));
    if (gone()) return null;
    const bad = r?.ok ? { error: ACK_ERROR.ffmpeg, detail: seg.rec.exitReason } : r; // ok but never live
    return { text: agentFail(uid, bad), error: bad?.error, detail: bad?.detail }; // error/detail: a manual 🎥 words it for itself
  } finally {
    if (sess.pending === seg) sess.pending = null;
  }
}

// the new segment records (a link: is offered): it becomes the current one. On a switch the previous one is
// stopped only now, so the video never has a hole nobody asked for (rule 4)
function accept(sess, seg) {
  const old = sess.cur;
  Object.assign(sess, { cur: seg, state: SESSION.live, pending: null });
  sess.segments.push(seg);
  clearTimeout(sess.waitTimer);
  if (old) stopSeg(old);
  rlog(sess.guildId, `🎥 อัดจอของ ${who(seg.owner)} (${{ agent: 'ตัวอัด', link: 'ลิงก์เบราว์เซอร์', mac: 'เครื่องบอท' }[seg.source]})${old ? ` แทน ${who(old.owner)}` : ''}${seg.auto ? ' (อัตโนมัติ)' : ''}`);
  stateChanged(sess.guildId);
  renderCard(sess, liveCardOf(sess));
  return seg;
}

// a segment that never joined sess.segments (dropped while starting): never composed or delivered, so once it has
// finalized its own dir goes too (it would be left behind), and a capture page / agent hears there's no link
function discardSeg(seg, done) {
  done.finally(() => {
    if (seg.rec.kind === 'browser') seg.rec.result ??= { url: null };
    return rm(seg.rec.dir, { recursive: true, force: true });
  }).catch(console.error);
}

// idempotent; resolves the segment's file (null: nothing recorded). The agent hears the stop before its next chunk
function stopSeg(seg) {
  if (seg.done) return seg.done;
  const rec = seg.rec, mac = rec.kind === 'mac';
  if (mac) finalizingScreen++; // the host screen isn't free until ffmpeg has written the file
  seg.done = rec.stop().catch((e) => { console.error(e); seg.error = e; return null; })
    .finally(() => { if (mac) finalizingScreen--; });
  if (seg.source === SESSION.agent) deps.agents.stop(seg.owner, rec.capId);
  return seg.done;
}

// a segment's recorder belongs to its session (not trackScreen): going live re-renders the card, a self-exit
// ends the segment (D6 gone / D7 local / size cap)
function wireSegment(sess, seg) {
  const g = sess.guildId, rec = seg.rec;
  const mine = () => screen.get(g) === sess && !sess.finished && (sess.cur === seg || sess.pending === seg);
  if (rec.kind === 'browser') {
    rec.onLive = () => { // the agent / page started (an agent: inside its start, before the ack)
      if (!mine()) { // dropped meanwhile (e.g. an agent claiming after ⏹️): finalize unseen, tell the page there's no link
        if (sess.segments.includes(seg)) stopSeg(seg).finally(() => { rec.result ??= { url: null }; });
        else discardSeg(seg, stopSeg(seg));
        return;
      }
      // an agent start is logged once, by accept() (with the source); a card link is logged when its page starts
      if (seg.source === SESSION.link) rlog(g, `🔴 ${who(seg.owner)} เปิดลิงก์บนการ์ดและเริ่มอัดจอ capture ${rec.capId}`);
      stateChanged(g);
      renderCard(sess, liveCardOf(sess));
    };
    // the card link opened on a phone (U20): the room is already recorded, the card drops the link
    if (seg.source === SESSION.link) {
      rec.onVoiceOnly = async () => {
        await sess.joining; // the bot may still be joining
        if (!mine() || !sess.paired || voice.get(g) !== sess.paired) return { error: 'voice' };
        stateChanged(g);
        renderCard(sess, liveCardOf(sess));
        return { paired: true };
      };
    }
  }
  rec.exited.then(() => {
    if (rec.stopping) return;
    if (sess.cur === seg) segmentEnded(sess, seg, rec.exitReason ?? '⚠️ ffmpeg หยุดเองระหว่างอัด ไฟล์อาจไม่สมบูรณ์', rec.exitKind ?? 'gone');
  }).catch(console.error);
}

// the current screen stopped: its sharer stopped sharing ('share'), stopped it on their machine ('local', D7),
// their machine vanished ('gone', D6) or hit a size cap ('cap'). Rule 5: wait 2 min for a 🔴 ต่อ if anyone
// else still shares, else end now. A manual session ends (D11)
function segmentEnded(sess, seg, reason, kind) {
  const g = sess.guildId;
  if (screen.get(g) !== sess || sess.finished || sess.cur !== seg) return;
  stopSeg(seg);
  sess.cur = null;
  const by = `<@${seg.owner}>`;
  rlog(g, `⏸️ จอของ ${who(seg.owner)} หยุด: ${reason}`);
  if (kind === 'local') skipSharer(client.guilds.cache.get(g), seg.owner); // not offered again until they stop sharing in Discord
  if (kind !== 'share' && kind !== 'local') {
    sess.notes += `\n${reason} (${by})`; // a warning on the result too
    (sess.noAuto ??= new Set()).add(seg.owner); // their machine vanished / hit a cap: a 🔴 ต่อ only, never auto again here
  }
  nextScreen(sess, kind === 'share' ? `${by} เลิกแชร์จอแล้ว` : reason, kind === 'share' ? `⏸️ ${by} หยุดแชร์แล้ว` : `${reason} (${by})`);
}
// no screen records now: a manual session or a room nobody else shares in ends (reason), else wait for a 🔴 ต่อ (pause)
function nextScreen(sess, reason, pause) {
  const g = sess.guildId;
  if (sess.mode === 'manual' || !sharing(sess).length) return void finishSession(sess, reason).catch(console.error);
  Object.assign(sess, { state: SESSION.waiting, pause, waitUntil: Date.now() + T.wait });
  armWait(sess, T.wait);
  rlog(g, `⏸️ รอ 🔴 อัดจอต่อ ห้อง ${sess.room.name}`);
  stateChanged(g);
  renderCard(sess, liveCardOf(sess));
  autoNext(sess).catch(console.error); // auto mode: someone else sharing with an agent continues at once
}
const armWait = (sess, ms) => {
  clearTimeout(sess.waitTimer);
  sess.waitTimer = setTimeout(() => finishSession(sess, '⌛ ไม่มีใครกดอัดจอต่อภายใน 2 นาที').catch(console.error), Math.max(0, ms));
};

// a voice event for the server's session: the sharer stopped or left (rule 5), the room emptied, or the people
// sharing changed (the 🔁 / 🔴 ต่อ buttons follow)
function sessionEvent(sess, guild) {
  if (sess.finished) return;
  if (humansIn(sess.room) === 0) return void finishSession(sess, 'ทุกคนออกจากห้องแล้ว').catch(console.error);
  // a manual recording is the presser's: it ends when they leave the room (D11)
  if (sess.mode === 'manual' && guild.voiceStates.cache.get(sess.by)?.channelId !== sess.room.id) {
    return void finishSession(sess, `<@${sess.by}> ออกจากห้องเสียงแล้ว`).catch(console.error);
  }
  const seg = sess.cur;
  if (seg && sess.mode === 'share') {
    const vs = guild.voiceStates.cache.get(seg.owner);
    if (vs?.channelId !== sess.room.id || !vs.streaming) return segmentEnded(sess, seg, `<@${seg.owner}> เลิกแชร์จอแล้ว`, 'share');
  }
  // started on the room audio but no screen got going (its start failed): when that sharer stops, as if it had ended
  if (!seg && !sess.pending && sess.state === SESSION.starting && sess.mode === 'share' && sess.want) {
    const vs = guild.voiceStates.cache.get(sess.want);
    if (vs?.channelId !== sess.room.id || !vs.streaming) return nextScreen(sess, `<@${sess.want}> เลิกแชร์จอแล้ว`, `⏸️ <@${sess.want}> หยุดแชร์แล้ว`);
  }
  const now = sharing(sess);
  if (sess.state === SESSION.waiting && !sess.pending && !now.length) return void finishSession(sess, 'ไม่มีใครแชร์จอแล้ว').catch(console.error);
  if (now.join() !== sess.sharersShown) {
    sess.sharersShown = now.join();
    renderCard(sess, liveCardOf(sess));
  }
  // waiting: a new sharer, an agent that came online or a share now long enough may continue it (auto mode)
  if (sess.state === SESSION.waiting) autoNext(sess).catch(console.error);
  // auto, the sharer's link not opened yet and their agent came online: their machine records instead (tried once)
  if (sess.auto && seg?.source === SESSION.link && !live(seg.rec) && !sess.pending && !seg.upgrade && useAgent(sess.guildId) && deps.agents.online(seg.owner)) {
    seg.upgrade = true;
    startSegment(sess, seg.owner, seg.owner, { auto: seg.auto }).then((r) => {
      if (r?.text) { sess.notes += `\n-# ⚠️ ${r.text}`; renderCard(sess, liveCardOf(sess)); }
    }).catch(console.error);
  }
}

// auto mode, a share session waiting for its next screen (rule 5): another sharer (one with an agent online first,
// else their link / the host Mac) continues the same session and file at once, no 2-min wait. Never while a screen is
// live (no auto switch, 🔁 stays a press). A start that gets no screen skips them and tries the next; nobody left:
// the wait for a 🔴 ต่อ goes on
async function autoNext(sess) {
  const g = sess.guildId, guild = client.guilds.cache.get(g), s = getSettings(g);
  if (!guild || sess.finished || screen.get(g) !== sess || sess.mode !== 'share' || sess.state !== SESSION.waiting || sess.pending) return;
  if (!autoRoom(sess.room, s)) return;
  const can = sharing(sess).filter((u) => !sess.noAuto?.has(u) && sharedLong(guild, u, s));
  const uid = (useAgent(g) && can.find((u) => deps.agents.online(u))) || can[0];
  if (!uid) return;
  clearTimeout(sess.waitTimer); // a slow start isn't cut by the wait; re-armed if it fails
  rlog(g, `⚡ อัดจอของ ${who(uid)} ต่อ ห้อง ${sess.room.name} (อัตโนมัติ)`);
  const r = await startScreen(sess, uid, uid, { auto: true });
  if (!r) return;
  if (!r.seg) { // the note is on the card already
    skipSharer(guild, uid);
    if (!sharing(sess).length) return finishSession(sess, 'ไม่มีใครแชร์จอแล้ว');
    armWait(sess, sess.waitUntil - Date.now());
    renderCard(sess, liveCardOf(sess));
    return autoNext(sess);
  }
  noteJoin(sess); // the join may have failed while this screen started (launch has returned already)
  sessionEvent(sess, guild); // they may have stopped sharing while it started
}

// 🔁 สลับไปอัด <name> (live) and 🔴 อัดจอ <name> ต่อ (waiting): the next segment, only on a press (rule 4)
async function pressNext(i, sub, tag) {
  const g = i.guildId, sess = screen.get(g);
  const [began, uid] = String(tag).split('.');
  if (sess?.kind !== 'session' || began !== String(sess.began)) {
    if (i.isButton()) await i.message.edit({ components: [] }).catch(() => {}); // a stale card: drop its buttons
    return i.reply(ephemeral('การอัดนี้จบไปแล้ว'));
  }
  if (sess.pending || sess.state === SESSION.starting) return i.reply(ephemeral('กำลังเริ่มอัดจออยู่ รอสักครู่'));
  if (sub === 'cont' ? sess.state !== SESSION.waiting : sess.state !== SESSION.live || sess.cur?.owner === uid) {
    return i.reply(ephemeral('ปุ่มนี้เก่าแล้ว ดูปุ่มล่าสุดบนการ์ด'));
  }
  const vs = i.guild.voiceStates.cache.get(uid);
  if (vs?.channelId !== sess.room.id || !vs.streaming) return i.reply(ephemeral(`<@${uid}> ไม่ได้แชร์จอในห้อง **${sess.room.name}** แล้ว`));
  await i.deferUpdate();
  rlog(g, sub === 'switch' ? `🔁 ${who(i.user.id)} กดสลับไปอัดจอของ ${who(uid)}` : `🔴 ${who(i.user.id)} กดอัดจอของ ${who(uid)} ต่อ`);
  clearTimeout(sess.waitTimer); // a slow start isn't cut by the wait; re-armed if it fails
  // their agent, else (or when it fails) the link / the host Mac (a Mac 🔁 only changes whose share it is)
  const r = await startScreen(sess, uid, i.user.id);
  if (!r) return;
  if (!r.seg) { // D8: the current screen keeps recording; the note is on the card, not offered again until they re-share
    skipSharer(i.guild, uid);
    if (sess.state === SESSION.waiting) {
      if (!sharing(sess).length) return finishSession(sess, 'ไม่มีใครแชร์จอแล้ว');
      armWait(sess, sess.waitUntil - Date.now());
    }
    return renderCard(sess, liveCardOf(sess));
  }
  noteJoin(sess); // the join may have failed while this screen started (launch has returned already)
  sessionEvent(sess, i.guild); // they may have stopped sharing while it started
}

// the room's audio for the whole session, joined as the session starts, in parallel with its first screen (rule 6)
async function joinSession(sess, guild) {
  const g = guild.id;
  let err;
  sess.joinState = 'joining'; // synchronously: the first card already says the bot is joining
  sess.joining = joinRoom(guild, sess.room, sess.textChannel, sess, { by: sess.by, dir: sess.dir, onError: (e) => { err = e; } });
  const v = await sess.joining;
  if (!v) {
    sess.joinState = 'fail';
    sess.joinText = isAbort(err) ? joinFail(sess.room.name) : `❌ บอทเข้าห้องเสียง **${sess.room.name}** ไม่ได้: ${errText(err)}`;
    if (screen.get(g) !== sess || sess.finished) return;
    if (sess.pending) return renderCard(sess, liveCardOf(sess)); // the screen's start decides (launch -> joinFailed)
    return joinFailed(sess);
  }
  sess.joinState = 'ok';
  if (screen.get(g) !== sess || sess.finished) return finishVoice(v, 'อัดจอหยุดไปแล้ว'); // ended while joining: silently
  stateChanged(g);
  renderCard(sess, liveCardOf(sess)); // now says "with audio"
  sessionEvent(sess, guild); // the sharer may have stopped while it started
}

// the bot couldn't join the room; called once both the join and the first screen's start are known, in either order.
// No live video (an unopened link is no recording) = nothing records: cancelled (-> true). Else the screen goes on
// alone (R9) with a note
async function joinFailed(sess, components = []) {
  if (sess.joinState !== 'fail' || sess.joinNoted || screen.get(sess.guildId) !== sess || sess.finished) return false;
  if (!live(sess)) { await cancelSession(sess, `⚪ **ไม่ได้อัด** — ${sess.joinText}${sess.notes}`, components); return true; }
  return noteJoin(sess);
}
// the "no room audio" note, once. After the first screen (🔁 / 🔴 ต่อ / auto continue) a failed join never cancels:
// earlier segments are already recorded
function noteJoin(sess) {
  if (sess.joinState !== 'fail' || sess.joinNoted || screen.get(sess.guildId) !== sess || sess.finished) return false;
  sess.joinNoted = true;
  sess.notes += `\n-# ⚠️ ${sess.joinText} — อัดแค่ภาพจอ ไม่มีเสียงในห้อง`;
  renderCard(sess, liveCardOf(sess));
  return false;
}

// a session whose first screen or room audio never started: everything stops, nothing delivered, the card says why
async function cancelSession(sess, text, components = []) {
  const g = sess.guildId;
  if (screen.get(g) !== sess || sess.finished) return;
  screen.delete(g);
  sess.finished = true;
  clearTimeout(sess.maxTimer);
  clearTimeout(sess.waitTimer);
  // a start that couldn't get going (e.g. the bot can't join) isn't retried (auto) and its card isn't reposted at once:
  // a new share is a new chance
  for (const u of new Set([sess.want, ...(sess.auto ? sess.segments.map((x) => x.owner) : [])])) skipSharer(client.guilds.cache.get(g), u);
  for (const seg of [...sess.segments, sess.pending].filter((x) => x?.rec)) {
    stopSeg(seg).then(() => { if (seg.rec.kind === 'browser') seg.rec.result ??= { url: null }; });
  }
  const v = sess.paired && voice.get(g) === sess.paired ? sess.paired : null;
  if (v) {
    voice.delete(g);
    v.finished = true;
    clearTimeout(v.maxTimer);
    v.notice?.delete().catch(() => {});
    v.stop().catch(console.error);
  }
  stateChanged(g);
  rlog(g, `⚪ ไม่ได้อัด ห้อง ${sess.room.name}: ${text}`);
  await showCard(sess, { content: text, components });
  forgetCard(sess);
  setImmediate(() => { const guild = client.guilds.cache.get(g); if (guild) checkShares(guild); });
}

// end of a session: stop the screen and the room audio, compose one meeting file (rule 6), deliver it on the card
async function finishSession(sess, reason) {
  const g = sess.guildId;
  if (screen.get(g) !== sess || sess.finished) return;
  screen.delete(g);
  sess.finished = true; // queued live-card renders are dropped from here on
  clearTimeout(sess.maxTimer);
  clearTimeout(sess.waitTimer);
  const end = Date.now();
  // what was just stopped isn't offered again right away: the room's sharers wait until they re-share
  // after a manual 🎥 only the screens it recorded: other sharers were never offered a card meanwhile
  // only while they still share: a 🖥️ presser who never shared must get a card on their next real share
  const guild = client.guilds.cache.get(g);
  for (const u of sess.mode === 'manual' ? sess.segments.map((x) => x.owner) : sharing(sess)) skipSharer(guild, u);
  if (sess.pending?.rec) stopSeg(sess.pending); // its start resolves into nothing
  const segs = sess.segments;
  segs.forEach(stopSeg);
  const v = sess.paired && voice.get(g) === sess.paired ? sess.paired : null;
  if (v) {
    voice.delete(g);
    v.finished = true;
    clearTimeout(v.maxTimer);
    v.notice?.edit({ content: '⏹️ หยุดอัดเสียงในห้องนี้แล้ว', components: [] }).catch(() => {});
  }
  stateChanged(g);
  setImmediate(() => { const guild = client.guilds.cache.get(g); if (guild) checkShares(guild); });
  rlog(g, `⏹️ หยุดอัดห้อง ${sess.room.name}: ${reason ?? '-'}`);
  const audioP = v ? v.stop() : Promise.resolve(null);
  if (!segs.length && !v) { // nothing ever recorded (stopped while starting)
    audioP.catch(() => {});
    await showCard(sess, { content: `⚪ **ยกเลิกการอัดจอ**${reason ? `\n-# ${reason}` : ''}`, components: [] });
    return forgetCard(sess);
  }
  await showCard(sess, { content: '⏳ **กำลังบันทึกไฟล์...**', components: [] });
  const [audio, ...videos] = await Promise.allSettled([audioP, ...segs.map((s) => s.done)]);
  const audioFile = audio.status === 'fulfilled' ? audio.value : null;
  const got = segs.map((seg, k) => ({ seg, file: videos[k].value })).filter((x) => x.file); // done never rejects
  let meeting = null, note = '';
  if (got.length) { // one file: every screen on one timeline, black where nobody was recorded, room audio throughout (none if nobody spoke)
    const n = composePending() + 1;
    await showCard(sess, { content: `🎞️ **กำลังรวมวิดีโอเป็นไฟล์เดียว...**${n > 1 ? ` (คิวที่ ${n})` : ''}`, components: [] });
    const t0 = Date.now();
    try {
      await mkdir(sess.dir, { recursive: true });
      const r = await deps.composeMeeting({
        segments: got.map(({ seg, file }) => ({ file, start: seg.rec.liveAt ?? seg.rec.firstFrameAt ?? seg.began })),
        audio: audioFile,
        // no audio file (nobody spoke): the origin is the earliest video, or compose would trim the start of the first segment
        audioStart: audioFile ? v?.startedAt || sess.began : Math.min(sess.began, ...got.map(({ seg }) => seg.rec.liveAt ?? seg.rec.firstFrameAt ?? seg.began)),
        end, dir: sess.dir,
      });
      meeting = r.file;
      rlog(g, `🎞️ รวมไฟล์ ${got.length} ช่วง ${r.reencoded ? 'เข้ารหัสใหม่' : 'ไม่เข้ารหัสใหม่'} ใช้เวลา ${duration(Date.now() - t0)}`);
    } catch (e) {
      console.error(e);
      rlog(g, `❌ รวมไฟล์ ${got.length} ช่วงไม่สำเร็จ (ส่งแยกไฟล์) ใช้เวลา ${duration(Date.now() - t0)}: ${String(e?.message).slice(0, 200)}`);
      note = '\n⚠️ รวมเป็นไฟล์เดียวไม่สำเร็จ ส่งแยกไฟล์'; // D15
    }
  }
  const vids = got.slice(0, 3); // ≤5 link buttons: 3 videos + voice + folder
  if (!meeting && got.length > 3) note += `\n⚠️ มีวิดีโอ ${got.length} ช่วง ส่งได้ 3 ช่วงแรก ที่เหลืออยู่ในเครื่องบอท`;
  const files = meeting ? [[meeting, '▶️ ดูวิดีโอ']] : [
    ...vids.map(({ file }, k) => [file, vids.length > 1 ? `▶️ วิดีโอ ${k + 1}` : '▶️ ดูวิดีโอ']),
    ...(audioFile ? [[audioFile, '🎧 ฟังเสียง']] : []),
  ];
  const problems = [...(audio.status === 'rejected' ? [audio.reason] : []), ...segs.filter((s) => s.error).map((s) => s.error)]
    .map((e) => (console.error(e), `\n❌ ${errText(e)}`));
  if (files.length && driveEnabled) await showCard(sess, { content: '⏫ **กำลังอัปโหลดขึ้น Google Drive...**', components: [] });
  const out = await deliver(files);
  // every capture page of the session opens the meeting video on Drive (null = no link: the result is only in Discord)
  const url = got.length ? out.urls[0] ?? null : null;
  for (const { rec } of segs) if (rec.kind === 'browser') rec.result = { url };
  const length = duration(end - sess.began);
  const owners = [...new Set(got.map(({ seg }) => `<@${seg.owner}>`))];
  rlog(g, `${files.length || !problems.length ? '✅' : '❌'} ส่งผลอัดห้อง ${sess.room.name} ยาว ${length}: ${logFiles(files, out)}${problems.join('').replace(/\n/g, ' ')}`);
  const head = got.length ? `✅ **อัดจอเสร็จแล้ว** · ยาว ${length} · จอของ ${owners.join(' → ')}`
    : audioFile ? `✅ **อัดเสียงในห้องเสร็จแล้ว** · ยาว ${length} · ไม่ได้อัดภาพจอ`
      : `${problems.length ? '❌' : '✅'} **อัดเสร็จแล้ว** · ยาว ${length} · ไม่มีภาพจอและไม่มีใครพูด`;
  await showResult(sess, {
    content: head + `${problems.join('')}${segs.map((s) => s.rec.notes ?? '').join('')}${sess.notes}${note}${out.note}${reason ? `\n-# ${reason}` : ''}`,
    components: out.components.slice(0, 5), files: out.files,
  }, files);
  // the meeting file holds the segments and the voice: their dirs may go too
  await dropUploaded([sess, v, ...segs.map((s) => s.rec)], meeting ? [...files, ...got.map(({ file }) => [file]), ...(audioFile ? [[audioFile]] : [])] : files, out);
}

// a manual screen recording brings the room's audio, delivered on its card: the bot joins the room
async function pairVoice(rec, guild, ch, textChannel) {
  const g = guild.id;
  await rec.cardQ; // the card's channel decides whether the room needs its own notice
  if (!ch || voice.has(g) || startingVoice.has(g) || screen.get(g) !== rec) return;
  const v = await joinRoom(guild, ch, textChannel, rec);
  // the screen may have stopped while the bot was joining: don't leave the voice running alone
  if (v && screen.get(g) !== rec) await finishVoice(v, 'อัดจอหยุดไปแล้ว');
  else if (v) await renderCard(rec, liveCardOf(rec)); // now says "with audio"
}

// manual 🎥 without an agent: a private link to `owner`, tracked right away (synchronously, no await before
// screen.set). Recording starts when their page claims it (onLive); the bot then joins the owner's room
function offerBrowser(guild, owner, textChannel, voiceChannel) {
  const g = guild.id;
  const rec = Object.assign(new BrowserCapture(dirFor(g), { guildId: g, owner }), { textChannel, channelName: voiceChannel?.name });
  rec.onLive = () => { // the sharer's page started recording
    if (screen.get(g) !== rec) { // stopped meanwhile: let it finalize unseen, and tell the page there's no link
      rec.stop().catch(() => {}).finally(() => { rec.result ??= { url: null }; });
      return;
    }
    if (!rec.maxTimer) armMax(rec, finishScreen);
    stateChanged(g);
    rlog(g, `🔴 ${who(owner)} เริ่มอัดจอผ่านเบราว์เซอร์ capture ${rec.capId}`);
    renderCard(rec, liveCardOf(rec)); // private offer: posts the first card here
    // join the owner's room and record it too (wherever the owner is when the page starts)
    const room = guild.members.cache.get(owner)?.voice?.channel ?? null;
    if (room && !rec.channelName) rec.channelName = room.name;
    pairVoice(rec, guild, room, textChannel).catch(console.error);
  };
  rec.onVoiceOnly = () => voiceOnly(rec, guild); // the page can't capture (phone, U20)
  trackScreen(g, rec);
  return rec;
}

// U20: the owner opened their private link on a device that can't capture, so the bot records the room's audio
// instead. Contract (BrowserCapture.voiceOnly): { paired:true } the room is already recorded · { paired:false } a
// voice recording was started here · { error:'novoice' } owner not in a voice room · { error:'voice' } couldn't
// join. On an error the offer stays open (the page tells them to use a computer), so it's never finished here then
async function voiceOnly(rec, guild) {
  const g = guild.id, owner = rec.owner;
  if (screen.get(g) !== rec) return { error: 'voice' }; // stopped meanwhile
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

// the bot joins room ch to record it alongside a screen recording (pairWith: a manual screen recording or a
// session); its file is delivered on that card. Resolves the recorder, or null when it couldn't join
// (onError(e); by default the error is posted in textChannel)
async function joinRoom(guild, ch, textChannel, pairWith, { by, dir, onError } = {}) {
  const g = guild.id;
  startingVoice.add(g);
  try {
    const rec = Object.assign(new deps.VoiceRecorder(ch, dir ?? dirFor(g)), { textChannel, ...(by ? { by } : {}) });
    await rec.start();
    pairWith.paired = rec; // link both ways before tracking, or a check in between sees an orphan
    rec.pairedTo = pairWith;
    trackVoice(g, rec);
    await pairWith.cardQ; // the card (posted meanwhile) decides whether the room needs its own notice
    // people being recorded must be told in the room itself when the card lives elsewhere
    if (pairWith.card?.channelId !== ch.id) {
      rec.notice = await ch.send({
        content: '🔴 **ห้องนี้กำลังถูกอัดเสียง**',
        components: [new ActionRowBuilder().addComponents(stopBtn('record:stop', rec.began))],
      }).catch(console.error);
    }
    return rec;
  } catch (e) {
    console.error(e);
    if (onError) onError(e);
    else await textChannel.send({ content: isAbort(e) ? joinFail(ch.name) : `❌ บอทเข้าห้องเสียง **${ch.name}** ไม่ได้: ${errText(e)}`, ...quiet }).catch(console.error);
    return null;
  } finally {
    startingVoice.delete(g);
  }
}

client.on('voiceStateUpdate', (oldS, newS) => {
  if (newS.member?.user.bot) return;
  const g = newS.guild.id, key = `${g}:${newS.id}`;
  if (newS.streaming && !(oldS.streaming && oldS.channelId === newS.channelId)) shareStart.set(key, Date.now());
  else if (!newS.streaming) {
    shareStart.delete(key);
    cardSkip.get(g)?.delete(newS.id); // a new share later is a new chance
  }
  checkShares(newS.guild);
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

// invited to a new server: the quick settings page, right where people will see it
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
      dropOrphanRoomCards(guild).then(() => checkShares(guild)).catch(console.error); // fresh cards for who shares now
    }
  }
  updatePresence();
  // schedule windows open without any voice event, so sweep every minute
  sweep = setInterval(() => c.guilds.cache.forEach(checkShares), 60000);
});
let sweep;
if (isMain) {
  await deps.agents.load(); // paired devices, before anyone can press
  await client.login(DISCORD_TOKEN);
}

// for tests: the module's state, and a reset that drops it (timers included, so the process can exit)
export { client, voice, screen, panel, liveCard, cardSkip, roomCards, commands };
export function _reset() {
  for (const r of [...voice.values(), ...screen.values()]) { clearTimeout(r.maxTimer); clearTimeout(r.waitTimer); }
  for (const r of roomCards.values()) r.gone = true;
  for (const m of [voice, screen, cardSkip, roomCards, shareStart, nickBefore, nickQueue, nickWarned]) m.clear();
  for (const s of [startingScreen, startingVoice]) s.clear();
  for (const t of [...recheckTimers.values(), ...panelTimers.values()]) clearTimeout(t);
  recheckTimers.clear();
  panelTimers.clear();
  clearInterval(sweep);
  finalizingScreen = 0;
}
