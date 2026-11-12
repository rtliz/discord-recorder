import { Collection, ChannelType } from 'discord.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { ACK_ERROR, AGENT_MIME, STOP_REASON } from '../../src/agent/protocol.js';
import { capToken } from '../../src/agent-hub.js';

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
      async delete(id) {
        const m = ch.messages.store.get(id);
        if (!m) throw discordError(10008, 'Unknown Message');
        return m.delete();
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

// the agent side of the bot: a stand-in for AgentHub (src/agent-hub.js) with the same public API
// (load, newPairing, devices, allDevices, revoke, revokeDevice, online, start, stop, onChange, _reset). No HTTP, no long-poll: tests
// drive the "agent" by hand. A started capture goes live through the REAL BrowserCapture (claim with the
// signed token, via 'agent'), so onLive / liveAt / stop() / exitReason / exitKind behave as in production.
// Needs PUBLIC_URL set before browser-capture.js is imported (capture.link() is used for the token).

const PAIR_MS = 10 * 60000;
const GONE_TEXT = '⚠️ ตัวอัดหลุด (ปิดเครื่องหรือเน็ตหลุด)'; // same as BrowserCapture's heartbeat text for via 'agent'

export class FakeAgentHub {
  static instances = [];
  constructor() {
    this.onChange = null; // (userId, online) => {}, fires on transitions only; kept across _reset like the real one
    this.startMode = 'ok'; // what start() does: 'ok' | 'hold' (wait for ack()) | an ACK_ERROR value (acks that error)
    this.plan = []; // modes for the next start() calls, consumed first (hub.plan.push('declined'))
    this.realFinalize = false; // true: leave capture.finalize alone (real ffmpeg remux of uploaded chunks)
    FakeAgentHub.instances.push(this);
    this._init();
  }

  _init() {
    Object.assign(this, {
      active: new Map(),   // userId -> {deviceId, name, askFirst}  (online)
      known: new Map(),    // userId -> [{deviceId, name, os, lastSeen}]
      pairings: [],        // every newPairing() result, {userId, guildId, tag, token, code, expires}
      revoked: [],         // [userId, which, count]
      kicked: [],          // every revokeDevice() that removed one: [deviceId, userId]
      calls: [],           // every start(): {userId, capture, capId, maxMs, room, by, area, mode, result, settled}
      pending: [],         // start() calls held by 'hold' mode, oldest first
      stops: [],           // every stop(): {userId, capId}
      recording: new Map(), // userId -> the capture the device is recording (busy while it runs)
      byCap: new Map(),    // capId -> capture that went live through this hub
    });
  }

  async load() {} // the real one reads data/agents.json

  // --- the AgentHub API ----------------------------------------------------------

  newPairing(userId, guildId, tag = null) {
    const p = { userId, guildId, tag, token: randomBytes(16).toString('base64url'),
      code: String(Math.floor(Math.random() * 1e6)).padStart(6, '0'), expires: Date.now() + PAIR_MS };
    this.pairings = this.pairings.filter((x) => x.userId !== userId).concat(p); // replaces the user's previous one
    return { token: p.token, code: p.code, expires: p.expires };
  }

  devices(userId) {
    const on = this.active.get(userId);
    return (this.known.get(userId) ?? []).map((d) => ({ ...d, active: on?.deviceId === d.deviceId }))
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  revoke(userId, which) {
    const list = this.known.get(userId) ?? [];
    const gone = list.filter((d) => which === 'all' || d.deviceId === which);
    this.known.set(userId, list.filter((d) => !gone.includes(d)));
    if (gone.some((d) => d.deviceId === this.active.get(userId)?.deviceId)) this.setOnline(userId, false);
    this.revoked.push([userId, which, gone.length]);
    return gone.length;
  }

  allDevices() {
    return [...this.known].flatMap(([userId, list]) => list.map((d) => ({ guildId: null, ...d, userId, active: this.active.get(userId)?.deviceId === d.deviceId })))
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  revokeDevice(deviceId) {
    for (const [userId, list] of this.known) {
      const d = list.find((x) => x.deviceId === deviceId);
      if (!d) continue;
      this.known.set(userId, list.filter((x) => x !== d));
      if (this.active.get(userId)?.deviceId === deviceId) this.setOnline(userId, false);
      this.kicked.push([deviceId, userId]);
      return { userId, name: d.name };
    }
    return null;
  }

  online(userId) {
    const o = this.active.get(userId);
    return o ? { ...o } : null;
  }

  // -> Promise<{ok:true} | {ok:false, error}>, like AgentHub.start: offline / busy answer without a command
  async start(userId, capture, { maxMs, room, by, area } = {}) {
    const call = { userId, capture, capId: capture.capId, maxMs, room, by, area, mode: null, result: null, settled: false };
    this.calls.push(call);
    const early = (error) => { call.settled = true; return (call.result = { ok: false, error }); };
    if (!this.active.has(userId)) return early(ACK_ERROR.offline);
    const cur = this.recording.get(userId);
    if (cur && cur !== capture && !cur.stopRequested && cur.state !== 'done') return early(ACK_ERROR.busy);
    this.recording.set(userId, capture); // reserved synchronously, like the real hub
    capture.exited.then(() => this.recording.get(userId) === capture && this.recording.delete(userId), () => {});
    call.mode = this.plan.length ? this.plan.shift() : this.startMode;
    return new Promise((resolve) => {
      call.resolve = resolve;
      if (call.mode === 'hold') this.pending.push(call);
      else Promise.resolve().then(() => this._settle(call, call.mode)); // the ack arrives after the caller's await
    });
  }

  // best effort, like the real one; the "agent" obeys: it stops ffmpeg and posts stop (reason 'agent').
  // -> whether the user's device is online
  stop(userId, capId) {
    this.stops.push({ userId, capId });
    const cap = this.byCap.get(capId);
    const obey = () => { try { cap.pageStop(STOP_REASON.local, cap.maxSeq); } catch { /* already finished */ } };
    if (cap) {
      if (cap.stopping) obey(); // bot stopped it first: the page-stop lets finish() skip its drain wait
      else setTimeout(obey, 0);
    }
    return this.active.has(userId);
  }

  _reset() {
    for (const c of this.pending.splice(0)) this._settle(c, ACK_ERROR.offline);
    this._init();
    this.plan = [];
    this.startMode = 'ok';
    this.realFinalize = false;
    this.note = null;
  }

  // --- test controls -------------------------------------------------------------

  // device online/offline. opts: {askFirst, name, deviceId} or false/null = offline. Fires onChange on transitions.
  setOnline(userId, opts = {}) {
    const was = this.active.has(userId);
    if (!opts) this.active.delete(userId);
    else {
      const { askFirst = false, name = 'เครื่องทดสอบ', deviceId } = opts;
      const dev = (this.known.get(userId) ?? []).find((d) => (deviceId ? d.deviceId === deviceId : true)) ?? this.addDevice(userId, { name, deviceId });
      this.active.set(userId, { deviceId: dev.deviceId, name: dev.name, askFirst });
    }
    const now = this.active.has(userId);
    if (now !== was) this.onChange?.(userId, now);
  }

  // guildId: the server it was paired from (undefined = an old record without one); lastSeen orders the lists
  addDevice(userId, { name = 'เครื่องทดสอบ', os = 'test', deviceId = randomBytes(8).toString('base64url'), guildId, lastSeen = Date.now() } = {}) {
    const d = { deviceId, name, os, lastSeen, ...(guildId ? { guildId } : {}) };
    this.known.set(userId, [...(this.known.get(userId) ?? []), d]);
    return d;
  }

  // resolves a held start() (mode 'hold'): result 'ok' (claims + acks ok) or an ACK_ERROR value. Returns the call.
  ack(result = 'ok', which = 0) {
    const call = this.pending[which];
    if (!call) throw new Error('FakeAgentHub.ack: no start() is waiting');
    this._settle(call, result);
    return call;
  }

  // the agent claims the capture with its signed token (like page.js / agent/capture.js) and acks
  _settle(call, mode) {
    if (call.settled) return;
    call.settled = true;
    this.pending = this.pending.filter((c) => c !== call);
    const cap = call.capture;
    let result = { ok: true };
    if (mode === 'ok') {
      try {
        cap.claim(capToken(cap, PAIR_MS), AGENT_MIME); // fires cap.onLive synchronously, as in production
        this.byCap.set(cap.capId, cap);
        if (!this.realFinalize) { // no ffmpeg: a file instead of the remux
          cap.finalize = async () => {
            await mkdir(cap.dir, { recursive: true });
            const f = join(cap.dir, 'screen.mp4');
            await writeFile(f, 'mp4');
            return f;
          };
        }
        if (this.note) result.note = this.note; // e.g. the Discord window not found: the whole screen instead
      } catch { result = { ok: false, error: ACK_ERROR.ffmpeg }; } // stopped / spent token: the agent can't start
    } else if (mode === 'unclaimed') result = { ok: true }; // acks ok although the capture was never claimed
    else result = { ok: false, error: mode };
    if (!result.ok && this.recording.get(call.userId) === cap) this.recording.delete(call.userId);
    call.result = result;
    call.resolve(result);
  }

  // the capture this user's device is recording now (or null)
  capture(userId) {
    const c = this.recording.get(userId);
    return c && c.state !== 'done' ? c : null;
  }

  // the agent uploads n numbered chunks (real putChunk, so bytes/maxSeq/have move like a real upload)
  async upload(userId, n = 1, bytes = 64) {
    const cap = this.capture(userId);
    if (!cap) throw new Error('FakeAgentHub.upload: nothing is recording');
    for (let k = 0; k < n; k++) {
      const buf = Buffer.alloc(bytes, 1);
      await cap.putChunk(cap.maxSeq + 1, Readable.from([buf]), buf.length);
    }
    return cap;
  }

  // the owner pressed "s" on the agent: POST stop {reason:'agent'} (exitKind 'local')
  localStop(userId, last) {
    const cap = this.capture(userId);
    cap.pageStop(STOP_REASON.local, last ?? cap.maxSeq);
    return cap;
  }

  // Ctrl+C on the agent: POST stop {reason:'unload'} (exitKind 'gone')
  quit(userId) {
    const cap = this.capture(userId);
    cap.pageStop(STOP_REASON.quit, cap.maxSeq);
    return cap;
  }

  // the agent vanishes (machine off, network lost): the heartbeat's exit, exitKind 'gone', and by default offline
  drop(userId, { offline = true } = {}) {
    const cap = this.capture(userId);
    cap?.exit(GONE_TEXT, true, 'gone');
    if (offline) this.setOnline(userId, false);
    return cap;
  }
}

// deps.composeMeeting fake: writes dir/meeting.mp4 and returns {file, reencoded}, no ffmpeg.
// fn.calls = the args of every call; fn.reencoded = true/false/undefined (undefined: reencoded when not exactly 1 segment);
// fn.fails = an Error to throw; fn.hook = async (args) => {} to hold or throw
export function fakeComposeMeeting() {
  const fn = async (args, opts) => {
    fn.calls.push({ ...args, opts });
    await fn.hook?.(args);
    if (fn.fails) throw fn.fails;
    await mkdir(args.dir, { recursive: true });
    const file = join(args.dir, 'meeting.mp4');
    await writeFile(file, 'meeting');
    return { file, reencoded: fn.reencoded ?? args.segments.length !== 1 };
  };
  Object.assign(fn, { calls: [], reencoded: undefined, fails: null, hook: null });
  return fn;
}
