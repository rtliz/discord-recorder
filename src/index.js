import 'dotenv/config';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes,
  PermissionFlagsBits, AttachmentBuilder, MessageFlags,
} from 'discord.js';
import { VoiceRecorder } from './voice-recorder.js';
import { ScreenRecorder } from './screen-recorder.js';

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID, ALLOWED_USER_IDS = '', SCREEN_DEVICE = '2' } = process.env;
const allowed = ALLOWED_USER_IDS.split(',').map((s) => s.trim()).filter(Boolean);
const UPLOAD_LIMIT = 10 * 1024 * 1024; // default upload cap; bigger files stay on disk

const commands = [
  new SlashCommandBuilder().setName('record').setDescription('อัดเสียงใน voice channel')
    .addSubcommand((s) => s.setName('start').setDescription('เข้าห้องเสียงของคุณแล้วเริ่มอัด'))
    .addSubcommand((s) => s.setName('stop').setDescription('หยุดอัดและส่งไฟล์เสียง')),
  new SlashCommandBuilder().setName('screen').setDescription('อัดหน้าจอเครื่องที่รันบอท')
    .addSubcommand((s) => s.setName('start').setDescription('เริ่มอัดหน้าจอ'))
    .addSubcommand((s) => s.setName('stop').setDescription('หยุดอัดและส่งไฟล์วิดีโอ')),
].map((c) => c.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).toJSON());

await new REST().setToken(DISCORD_TOKEN)
  .put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const voice = new Map();  // guildId -> VoiceRecorder
const screen = new Map(); // guildId -> ScreenRecorder

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const dirFor = (guildId) => join('recordings', `${guildId}-${stamp()}`);

async function reply(i, file, text) {
  const size = (await stat(file)).size;
  if (size > UPLOAD_LIMIT) return i.editReply(`${text}\nไฟล์ใหญ่เกิน ${UPLOAD_LIMIT / 1048576}MB เก็บไว้ที่ \`${file}\``);
  return i.editReply({ content: text, files: [new AttachmentBuilder(file)] });
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
      voice.set(g, rec);
      return i.editReply(`🔴 เริ่มอัดเสียงใน **${channel.name}** — ทุกคนในห้องถูกอัดเสียงอยู่`);
    }
    if (i.commandName === 'record' && sub === 'stop') {
      const rec = voice.get(g);
      if (!rec) return i.reply({ content: 'ยังไม่ได้อัด', flags: MessageFlags.Ephemeral });
      await i.deferReply();
      voice.delete(g);
      const file = await rec.stop();
      return file ? reply(i, file, '⏹️ อัดเสร็จแล้ว') : i.editReply('⏹️ หยุดอัด แต่ไม่มีใครพูด');
    }
    if (i.commandName === 'screen' && sub === 'start') {
      if (screen.has(g)) return i.reply({ content: 'กำลังอัดจออยู่แล้ว', flags: MessageFlags.Ephemeral });
      await i.deferReply();
      const rec = new ScreenRecorder(dirFor(g), SCREEN_DEVICE);
      await rec.start();
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

client.once('clientReady', (c) => console.log(`logged in as ${c.user.tag}`));
await client.login(DISCORD_TOKEN);
