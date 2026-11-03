import 'dotenv/config';
import { stat } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import {
  Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes,
  PermissionFlagsBits, AttachmentBuilder, MessageFlags,
} from 'discord.js';
import { VoiceRecorder } from './voice-recorder.js';
import { ScreenRecorder } from './screen-recorder.js';
import { driveEnabled, uploadToDrive } from './drive.js';

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID, ALLOWED_USER_IDS = '', SCREEN_DEVICE = '2', AUTO_SCREEN_USER_IDS = '', SCREEN_ENABLED = 'true' } = process.env;
const screenEnabled = SCREEN_ENABLED !== 'false'; // false in k8s: no display to capture
const allowed = ALLOWED_USER_IDS.split(',').map((s) => s.trim()).filter(Boolean);
const autoScreenUsers = AUTO_SCREEN_USER_IDS.split(',').map((x) => x.trim()).filter(Boolean);
const UPLOAD_LIMIT = 10 * 1024 * 1024; // default upload cap; bigger files stay on disk

const commands = [
  new SlashCommandBuilder().setName('record').setDescription('อัดเสียงใน voice channel')
    .addSubcommand((s) => s.setName('start').setDescription('เข้าห้องเสียงของคุณแล้วเริ่มอัด'))
    .addSubcommand((s) => s.setName('stop').setDescription('หยุดอัดและส่งไฟล์เสียง')),
  new SlashCommandBuilder().setName('screen').setDescription('อัดหน้าจอเครื่องที่รันบอท')
    .addSubcommand((s) => s.setName('start').setDescription('เริ่มอัดหน้าจอ'))
    .addSubcommand((s) => s.setName('stop').setDescription('หยุดอัดและส่งไฟล์วิดีโอ')),
].filter((c) => screenEnabled || c.name !== 'screen').map((c) => c.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).toJSON());

await new REST().setToken(DISCORD_TOKEN)
  .put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const voice = new Map();  // guildId -> VoiceRecorder
const screen = new Map(); // guildId -> ScreenRecorder

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const dirFor = (guildId) => join('recordings', `${guildId}-${stamp()}`);

// Drive link if configured, otherwise attach (or report path when too big)
async function deliver(file, text) {
  if (driveEnabled) {
    const link = await uploadToDrive(file, `${basename(dirname(file))}-${basename(file)}`);
    return { content: `${text}\n📁 ${link}` };
  }
  const size = (await stat(file)).size;
  if (size > UPLOAD_LIMIT) return { content: `${text}\nไฟล์ใหญ่เกิน ${UPLOAD_LIMIT / 1048576}MB เก็บไว้ที่ \`${file}\`` };
  return { content: text, files: [new AttachmentBuilder(file)] };
}

async function reply(i, file, text) {
  if (driveEnabled) await i.editReply(`${text}\nกำลังอัปโหลดขึ้น Google Drive...`);
  return i.editReply(await deliver(file, text));
}

// stop the screen recording of a guild and post the result to its text channel
async function finishScreen(g, text) {
  const rec = screen.get(g);
  if (!rec) return;
  screen.delete(g);
  const textChannel = rec.textChannel;
  try {
    const file = await rec.stop();
    await textChannel?.send(await deliver(file, text));
  } catch (e) {
    console.error(e);
    await textChannel?.send(`ผิดพลาด: ${String(e.message).slice(0, 1500)}`);
  }
}

client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;
  if (allowed.length && !allowed.includes(i.user.id)) {
    return i.reply({ content: 'คุณไม่มีสิทธิ์ใช้คำสั่งนี้', flags: MessageFlags.Ephemeral });
  }
  const sub = i.options.getSubcommand();
  const g = i.guildId;

  try {
    if (i.commandName === 'record' && sub === 'start') {
      if (voice.has(g)) return i.reply({ content: 'กำลังอัดอยู่แล้ว', flags: MessageFlags.Ephemeral });
      const channel = i.member.voice?.channel;
      if (!channel) return i.reply({ content: 'เข้า voice channel ก่อน', flags: MessageFlags.Ephemeral });
      await i.deferReply();
      const rec = new VoiceRecorder(channel, dirFor(g));
      await rec.start();
      rec.textChannel = i.channel;
      voice.set(g, rec);
      return i.editReply(`🔴 เริ่มอัดเสียงใน **${channel.name}** — ทุกคนในห้องถูกอัดเสียงอยู่`);
    }
    if (i.commandName === 'record' && sub === 'stop') {
      const rec = voice.get(g);
      if (!rec) return i.reply({ content: 'ยังไม่ได้อัด', flags: MessageFlags.Ephemeral });
      await i.deferReply();
      voice.delete(g);
      const auto = screen.get(g)?.auto;
      if (auto) await finishScreen(g, '⏹️ อัดหน้าจอที่แชร์เสร็จแล้ว');
      const file = await rec.stop();
      return file ? reply(i, file, '⏹️ อัดเสร็จแล้ว') : i.editReply('⏹️ หยุดอัด แต่ไม่มีใครพูด');
    }
    if (i.commandName === 'screen' && sub === 'start') {
      if (screen.has(g)) return i.reply({ content: 'กำลังอัดจออยู่แล้ว', flags: MessageFlags.Ephemeral });
      await i.deferReply();
      const rec = new ScreenRecorder(dirFor(g), SCREEN_DEVICE);
      await rec.start();
      rec.textChannel = i.channel;
      screen.set(g, rec);
      return i.editReply('🔴 เริ่มอัดหน้าจอเครื่องที่รันบอท');
    }
    if (i.commandName === 'screen' && sub === 'stop') {
      const rec = screen.get(g);
      if (!rec) return i.reply({ content: 'ยังไม่ได้อัดจอ', flags: MessageFlags.Ephemeral });
      await i.deferReply();
      screen.delete(g);
      return reply(i, await rec.stop(), '⏹️ อัดจอเสร็จแล้ว');
    }
  } catch (e) {
    console.error(e);
    voice.delete(g);
    screen.delete(g);
    const msg = `ผิดพลาด: ${String(e.message).slice(0, 1500)}`;
    return i.deferred || i.replied ? i.editReply(msg) : i.reply({ content: msg, flags: MessageFlags.Ephemeral });
  }
});

// while a voice recording is running, someone starting a screen share starts a screen recording
client.on('voiceStateUpdate', async (oldS, newS) => {
  const g = newS.guild.id;
  const rec = voice.get(g);
  if (!screenEnabled || !rec || newS.member?.user.bot) return;

  const inRoom = newS.channelId === rec.channel.id;
  const wasStreaming = oldS.channelId === rec.channel.id && oldS.streaming;
  const nowStreaming = inRoom && newS.streaming;

  if (!wasStreaming && nowStreaming && !screen.has(g)) {
    if (autoScreenUsers.length && !autoScreenUsers.includes(newS.id)) return;
    try {
      const sr = new ScreenRecorder(dirFor(g), SCREEN_DEVICE);
      await sr.start();
      sr.textChannel = rec.textChannel;
      sr.auto = newS.id;
      screen.set(g, sr);
      await rec.textChannel?.send(`🔴 <@${newS.id}> เริ่มแชร์หน้าจอ — เริ่มอัดวิดีโอ`);
    } catch (e) {
      console.error(e);
      await rec.textChannel?.send(`อัดวิดีโอไม่ได้: ${String(e.message).slice(0, 1500)}`);
    }
  } else if (wasStreaming && !nowStreaming && screen.get(g)?.auto === newS.id) {
    await finishScreen(g, '⏹️ หยุดแชร์ — อัดวิดีโอเสร็จแล้ว');
  }
});

client.once('clientReady', (c) => console.log(`logged in as ${c.user.tag}`));
await client.login(DISCORD_TOKEN);
