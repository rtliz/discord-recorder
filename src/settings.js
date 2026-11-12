import { readFile, mkdir, rename, open } from 'node:fs/promises';
import { dirname } from 'node:path';

// per-server settings, chosen in Discord (setup message on join, /settings, ⚙️ in the panel)
// env values are only the defaults for servers that haven't saved anything yet
const FILE = process.env.SETTINGS_FILE || 'data/settings.json';
const list = (v = '') => v.split(',').map((x) => x.trim()).filter(Boolean);
// what a share does: 'off' nothing · 'card' a 🔴 card, nothing records until pressed · 'auto' the sharer's online agent
// records by itself (no agent: the card). Env: SHARE_CARDS = true|card / auto / false|off; when unset, the legacy
// AUTO_SCREEN=true means 'auto' (what it did before press-to-start), false 'off'
export const SHARE_MODES = ['off', 'card', 'auto'];
const envShare = { true: 'card', card: 'card', auto: 'auto', false: 'off', off: 'off' };
const DEFAULT_SHARE = envShare[process.env.SHARE_CARDS] ?? (process.env.AUTO_SCREEN === 'true' ? 'auto' : 'off');
// screen mode: with PUBLIC_URL, 'agent' (the person's recorder agent, else the 🎥 link) or 'browser' (always the link);
// the host-Mac modes 'screen' / 'window' are only left for a bot without PUBLIC_URL. With PUBLIC_URL a saved or env
// 'screen' / 'window' reads as 'agent' (the file is untouched)
const DEFAULT_AREA = process.env.CAPTURE_AREA === 'discord' ? 'discord' : 'screen'; // env default for the capture area
const agentModes = Boolean(process.env.PUBLIC_URL);
const modeIn = (m) => (agentModes ? (m === 'browser' ? 'browser' : 'agent') : m === 'window' ? 'window' : 'screen');
const DEFAULTS = {
  shareMode: DEFAULT_SHARE,
  shareCards: DEFAULT_SHARE !== 'off',                           // derived from shareMode on every read (kept for readers): any card at all
  autoVoice: 'off',                                              // always 'off': press-to-start has no auto voice (kept so old readers don't break)
  minMembers: Number(process.env.AUTO_SCREEN_MIN_MEMBERS) || 2,  // humans in the room before a card is posted
  mode: modeIn(process.env.SCREEN_MODE),
  area: DEFAULT_AREA,                                            // capture area: 'screen' the whole screen, 'discord' only the Discord window
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
  const saved = all[guildId] ?? {};
  const s = { ...DEFAULTS, ...saved };
  // legacy keys stay in the file untouched; they are only translated here: a saved shareMode wins, then the A5
  // boolean shareCards, then the pre-press-to-start keys (autoScreen on = auto, auto voice for members = card)
  s.shareMode = SHARE_MODES.includes(saved.shareMode) ? saved.shareMode
    : typeof saved.shareCards === 'boolean' ? (saved.shareCards ? 'card' : 'off')
      : saved.autoScreen === true ? 'auto'
        : saved.autoVoice === 'members' ? 'card'
          : saved.autoScreen === false ? 'off' // an explicit old "off" beats the env default
            : DEFAULTS.shareMode;
  s.shareCards = s.shareMode !== 'off';
  s.mode = saved.mode === undefined ? DEFAULTS.mode : modeIn(saved.mode);
  s.area = saved.area === 'discord' || saved.area === 'screen' ? saved.area : DEFAULTS.area; // anything else: the default
  delete s.autoScreen;
  s.autoVoice = 'off'; // 'members' was removed (press-to-start); 'screen' was already folded into off
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
