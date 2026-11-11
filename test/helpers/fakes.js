import { Collection, ChannelType } from 'discord.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// just enough of discord.js's Guild / Member / Channel / Interaction for src/index.js, all calls recorded

let seq = 0;
const sid = () => String(900000000000000000n + BigInt(++seq));
export const json = (x) => x?.toJSON?.() ?? x;
/** flat list of the components (buttons, selects) of a payload, as JSON */
export const parts = (payload) => (payload?.components ?? []).map(json).flatMap((r) => r.components.map(json));
export const ids = (payload) => parts(payload).map((c) => c.custom_id ?? `link:${c.label}`);
export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const discordError = (code, message) => Object.assign(new Error(message), { code });

function fakeMessage(channel, payload) {
  const m = {
    id: sid(), channelId: channel.id, guildId: channel.guild.id, payload, edits: [], deleted: false,
    get url() { return `https://discord.com/channels/${channel.guild.id}/${channel.id}/${m.id}`; },
    async edit(p) {
      if (channel.failEdit) throw discordError(50013, 'Missing Permissions');
      if (m.deleted) throw discordError(10008, 'Unknown Message');
      if (m.editGate) await m.editGate(p); // tests can hold an edit to reorder them
      m.payload = p;
      m.edits.push(p);
      return m;
    },
    async delete() { m.deleted = true; },
  };
  channel.messages.store.set(m.id, m);
  return m;
}

function textLike(guild, props) {
  const ch = {
    id: sid(), guild, guildId: guild.id, sent: [], failSend: false, failEdit: false, ...props,
    async send(p) {
      if (ch.failSend) throw discordError(50013, 'Missing Permissions');
      const m = fakeMessage(ch, p);
      ch.sent.push(m);
      return m;
    },
    messages: {
      store: new Map(),
      async edit(id, p) {
        const m = ch.messages.store.get(id);
        if (!m) throw discordError(10008, 'Unknown Message');
        return m.edit(p);
      },
    },
    permissionsFor: () => ({ has: () => !ch.noPerms }),
  };
  guild.channels.cache.set(ch.id, ch);
  return ch;
}

export function fakeGuild({ name = 'Test Server', nickname = null } = {}) {
  const guild = {
    id: sid(), name, left: false,
    channels: { cache: new Collection() },
    roles: { cache: new Collection() },
    voiceStates: { cache: new Collection() },
    members: { cache: new Collection(), me: null },
    async leave() { guild.left = true; },
  };
  guild.members.me = {
    id: 'bot', nickname, nicks: [], failNick: false,
    async setNickname(n) {
      if (guild.members.me.failNick) throw discordError(50013, 'Missing Permissions');
      guild.members.me.nickname = n;
      guild.members.me.nicks.push(n);
    },
  };
  return guild;
}

export const fakeTextChannel = (guild, { name = 'general' } = {}) =>
  textLike(guild, { name, type: ChannelType.GuildText, isVoiceBased: () => false, rawPosition: 0 });

export const fakeVoiceChannel = (guild, { name = 'Meeting' } = {}) =>
  textLike(guild, { name, type: ChannelType.GuildVoice, isVoiceBased: () => true, members: new Collection(), joinable: true });

export function fakeMember(guild, { name = 'Somchai', admin = false, roles = [], bot = false } = {}) {
  const id = sid();
  const m = {
    id, guild, displayName: name, admin,
    user: { id, bot, tag: name, username: name },
    permissions: { has: () => m.admin },
    roles: { cache: new Collection(roles.map((r) => [r, { id: r }])) },
  };
  m.voice = { id, guild, member: m, channel: null, channelId: null, streaming: false };
  guild.members.cache.set(id, m);
  return m;
}

/** moves a member (into a voice channel, null = out) and/or changes streaming; returns [old, new] voice states */
export function moveMember(m, { channel = m.voice.channel, streaming = m.voice.streaming } = {}) {
  const old = { ...m.voice };
  m.voice.channel?.members.delete(m.id);
  Object.assign(m.voice, { channel, channelId: channel?.id ?? null, streaming: Boolean(channel) && streaming });
  if (channel) {
    channel.members.set(m.id, m);
    m.guild.voiceStates.cache.set(m.id, m.voice);
  } else m.guild.voiceStates.cache.delete(m.id);
  return [old, m.voice];
}

/**
 * an interaction. kind: 'button' | 'slash' | 'select' | 'context'. For buttons/selects pass customId;
 * for slash pass command (+ sub, options). `message` = the message a button sits on.
 */
export function fakeInteraction({ guild, member, channel, kind = 'button', customId, command, sub = null,
  options = {}, values, message, appPerms = true } = {}) {
  const i = {
    guild, guildId: guild.id, member, user: member.user, channel, customId, values,
    commandName: command, createdTimestamp: Date.now(),
    replies: [], edits: [], updates: [], followUps: [], deferred: false, replied: false, deferredUpdate: false,
    message: message ?? { id: 'not-a-card', edits: [], async edit(p) { this.edits.push(p); } },
    reply: null, replyMessage: null,
    isChatInputCommand: () => kind === 'slash',
    isUserContextMenuCommand: () => kind === 'context',
    isButton: () => kind === 'button',
    isAnySelectMenu: () => kind === 'select',
    options: { getSubcommand: () => sub, getString: (n) => options[n] ?? null },
    memberPermissions: { has: () => member.admin },
    appPermissions: { has: () => appPerms },
  };
  const own = (p) => {
    i.replyMessage ??= fakeMessage(channel, p);
    i.replyMessage.payload = p;
    return i.replyMessage;
  };
  Object.assign(i, {
    async reply(p) { i.replied = true; i.replies.push(p); i.reply_ = p; own(p); },
    async deferReply() { i.deferred = true; },
    async editReply(p) {
      if (i.failEdit) throw discordError(10015, 'Unknown Webhook');
      i.edits.push(p);
      return own(p);
    },
    async update(p) { i.replied = true; i.updates.push(p); },
    async deferUpdate() { i.deferredUpdate = true; },
    async followUp(p) { i.followUps.push(p); },
    async fetchReply() { return i.replyMessage; },
  });
  return i;
}

// recorders: start/stop are instant unless a test sets a gate; stop writes a small real file

export class FakeVoiceRecorder {
  static instances = [];
  static startHook = null; // async (rec) => {} : await a gate or throw
  constructor(channel, dir) {
    Object.assign(this, { kind: 'voice', channel, dir, onGone: null, stopped: false, nobodySpoke: false, startedAt: Date.now() });
    FakeVoiceRecorder.instances.push(this);
  }
  async start() { await FakeVoiceRecorder.startHook?.(this); this.started = true; }
  async stop() {
    this.stopped = true;
    if (this.nobodySpoke) return null;
    await mkdir(this.dir, { recursive: true });
    const f = join(this.dir, 'voice.mp3');
    await writeFile(f, 'mp3');
    return f;
  }
}

export class FakeScreenRecorder {
  static instances = [];
  static startHook = null;
  constructor(dir, device, region = null) {
    Object.assign(this, { dir, device, region, stopped: false });
    this.exited = new Promise((r) => { this.die = r; }); // die(): ffmpeg quit on its own
    FakeScreenRecorder.instances.push(this);
  }
  async start() { await FakeScreenRecorder.startHook?.(this); this.started = true; }
  async stop() {
    this.stopping = true;
    this.stopped = true;
    await mkdir(this.dir, { recursive: true });
    const f = join(this.dir, 'screen.mp4');
    await writeFile(f, 'mp4');
    this.die();
    return f;
  }
}
