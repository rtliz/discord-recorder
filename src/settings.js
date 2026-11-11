import { readFile, mkdir, rename, open } from 'node:fs/promises';
import { dirname } from 'node:path';

// per-server settings, chosen in Discord (setup message on join, /settings, ⚙️ in the panel)
// env values are only the defaults for servers that haven't saved anything yet
const FILE = process.env.SETTINGS_FILE || 'data/settings.json';
const list = (v = '') => v.split(',').map((x) => x.trim()).filter(Boolean);
const DEFAULTS = {
  autoScreen: process.env.AUTO_SCREEN === 'true',               // off until a server opts in (screen = the host Mac's)
  autoVoice: 'off',                                              // 'off' | 'screen' (with the screen recording) | 'members'
  minMembers: Number(process.env.AUTO_SCREEN_MIN_MEMBERS) || 2,  // humans in the room before auto recording kicks in
  mode: ['window', 'browser'].includes(process.env.SCREEN_MODE) ? process.env.SCREEN_MODE : 'screen',
  channels: list(process.env.AUTO_SCREEN_CHANNEL_IDS),           // voice channels to watch, [] = all
  roles: [],                                                     // sharers must have one of these, [] = anyone
  notifyChannel: null,                                           // text channel for auto recordings, null = the voice channel's chat
  days: [0, 1, 2, 3, 4, 5, 6],                                   // 0 = Sunday
  from: 0,                                                       // hours [from, to) in TIMEZONE; 0-24 = all day
  to: 24,
  minShareSeconds: 10,                                           // ignore shares shorter than this
  maxMinutes: 240,                                               // stop any recording after this, 0 = no limit
  anyoneRecords: false,                                          // true = every member may start/stop recordings (not change settings)
  managerRole: null,                                             // role that may start/stop recordings (besides Manage Server)
  panels: [],                                                    // [channelId, messageId] of public panels kept up to date
};

let all = {};
let text = null;
try {
  text = await readFile(FILE, 'utf8');
} catch (e) {
  // missing = first run; any other read error (EIO, EMFILE...) must not cost the saved settings
  if (e.code !== 'ENOENT') throw new Error(`อ่าน ${FILE} ไม่ได้: ${e.message}`);
}
if (text !== null) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
    all = parsed;
  } catch (e) {
    // broken content: keep it aside instead of overwriting every server's settings on the next save
    const aside = `${FILE}.corrupt-${Date.now()}`;
    await rename(FILE, aside).catch(() => {});
    console.error(`${FILE} เสีย (${e.message}) ย้ายไปไว้ที่ ${aside} แล้วใช้ค่าเริ่มต้น`);
  }
}

export const getSettings = (guildId) => {
  const s = { ...DEFAULTS, ...all[guildId] };
  if (s.autoVoice === 'screen') s.autoVoice = 'off'; // legacy value: the room's audio now always comes with a screen recording
  return s;
};

let writing = Promise.resolve(true);
/** applies in memory right away; the promise says whether it reached the disk */
export function updateSettings(guildId, patch) {
  all[guildId] = { ...all[guildId], ...patch };
  // serialize writes; fsync a temp file then rename so a crash never leaves a half or empty JSON
  writing = writing.then(async () => {
    await mkdir(dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    const fh = await open(tmp, 'w');
    try {
      await fh.writeFile(JSON.stringify(all, null, 2));
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, FILE);
    return true;
  }).catch((e) => {
    console.error('บันทึกการตั้งค่าไม่ได้:', e);
    return false;
  });
  return writing;
}
