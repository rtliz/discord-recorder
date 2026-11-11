import { writeFile } from 'node:fs/promises';
import { FakeVoiceRecorder, FakeScreenRecorder, fakeGuild, fakeTextChannel, fakeVoiceChannel, fakeMember, moveMember } from './fakes.js';

// loads src/index.js with fakes in place of voice/ffmpeg/Drive. Import ./env.js first (tmp cwd + settings).
// Never logs in: index.js only registers commands / logs in when run as `node src/index.js`.

export async function loadBot(env = {}) {
  Object.assign(process.env, {
    DISCORD_TOKEN: 'test-token', CLIENT_ID: '1', DOTENV_CONFIG_PATH: '/dev/null', // never the repo's .env
    GOOGLE_REFRESH_TOKEN: 'test', DRIVE_FOLDER_ID: 'FOLDER', ...env,
  });
  const logs = { out: [], err: [] };
  if (!process.env.DEBUG_LOGS) {
    console.log = (...a) => logs.out.push(a.map(String).join(' '));
    console.error = (...a) => logs.err.push(a.map((x) => x?.stack ?? String(x)).join(' '));
    console.warn = console.error;
  }
  const bot = await import('../../src/index.js');
  const uploads = [];
  Object.assign(bot.deps, {
    VoiceRecorder: FakeVoiceRecorder,
    ScreenRecorder: FakeScreenRecorder,
    windowRegion: async () => ({ x: 0, y: 0, w: 1, h: 1 }),
    mergeAudio: async (v, a) => { // no ffmpeg in flow tests: a fake merged file next to the video
      if (bot.deps.mergeFails) return null;
      const f = v.replace(/(\.\w+)$/, '-with-audio$1');
      await writeFile(f, 'merged');
      return f;
    },
    uploadToDrive: async (file, name) => {
      if (bot.deps.uploadFails) throw bot.deps.uploadFails;
      uploads.push(name);
      return `https://drive.google.com/file/d/${uploads.length}/view`;
    },
  });
  bot.client.user = { id: 'bot', username: 'Recorder', tag: 'Recorder#0000', setPresence() {} };
  const fire = (ev, ...args) => bot.client.listeners(ev)[0](...args);
  return { bot, logs, uploads, fire };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function waitFor(cond, what = 'condition', ms = 3000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** a server with a text channel, a voice channel and an admin standing in it */
export function scene(bot, { admin = true, name = 'Somchai', inVoice = true } = {}) {
  const guild = fakeGuild();
  const text = fakeTextChannel(guild);
  const room = fakeVoiceChannel(guild);
  const member = fakeMember(guild, { name, admin });
  if (inVoice) moveMember(member, { channel: room });
  bot.client.guilds.cache.set(guild.id, guild);
  return { guild, text, room, member };
}

export function resetFakes() {
  FakeVoiceRecorder.instances.length = 0;
  FakeScreenRecorder.instances.length = 0;
  FakeVoiceRecorder.startHook = null;
  FakeScreenRecorder.startHook = null;
}
