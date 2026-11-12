// Recorder agent CLI: `npm run agent -- --server https://host --code 123456` (first time), then `npm run agent`.
// Records this machine's screen ONLY when the bot sends `start` (nothing here ever starts ffmpeg by itself).
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { Capture, buildArgs, ffmpegPath, pruneRecordings } from './capture.js';
import { areaInput, listDisplays, pickDisplay } from './displays.js';
import { AGENT_VERSION, Link, pair } from './link.js';
import { ACK_ERROR, CMD, STOP_REASON } from './protocol.js';
import { createUi } from './ui.js';

const USAGE = `ใช้งาน: npm run agent -- --server <https://...> --code <รหัส 6 หลัก จาก /agent>
ตัวเลือก: --token <โทเคนติดตั้ง> (หรือ DRA_TOKEN คู่กับ --pair-only) --display <id> --fps <เลข> --pair-only --consent (ยอมให้บอทอัดจอ ไม่ถาม)`;

export function parseArgs(argv) {
  const a = {}, bad = [];
  for (let i = 0; i < argv.length; i++) {
    const [k, inline] = argv[i].split(/=(.*)/s);
    const val = () => inline ?? argv[++i];
    if (['--server', '--code', '--token', '--display', '--fps'].includes(k)) a[k.slice(2)] = val();
    else if (k === '--pair-only') a.pairOnly = true;
    else if (k === '--consent') a.consent = true;
    else if (k === '--help' || k === '-h') a.help = true;
    else bad.push(argv[i]);
  }
  if (a.fps !== undefined && !(Number(a.fps) >= 1 && Number(a.fps) <= 60)) bad.push(`--fps ${a.fps}`);
  return { ...a, bad };
}

// the bearer secret travels on every request: plain http only for loopback (local tests, developers)
export function normalizeServer(s) {
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) return null;
    return u.origin;
  } catch { return null; }
}

export const configPath = (home) => join(home, 'config.json');
export function loadConfig(home) {
  try { const c = JSON.parse(readFileSync(configPath(home), 'utf8')); return c && typeof c === 'object' ? c : null; } catch { return null; }
}
export function saveConfig(home, cfg) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const tmp = `${configPath(home)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* windows */ }
  renameSync(tmp, configPath(home));
}

// -> { done: Promise<exit code>, shutdown(), link?, ui? }. Everything OS/network related is injectable for tests.
export async function runAgent(o = {}) {
  const { argv = [], env = process.env, platform = process.platform, stdin = process.stdin, stdout = process.stdout, fetchFn = fetch, spawnFn, T = {} } = o;
  const home = o.home ?? env.DRA_HOME ?? join(homedir(), '.discord-recorder-agent');
  const say = (t) => stdout.write(`${t}\n`);
  const quit = (msg, code = 1) => { if (msg) say(msg); return { done: Promise.resolve(code), shutdown: async () => {} }; };

  const args = parseArgs(argv);
  if (args.help || args.bad.length) return quit(`${args.bad.length ? `ไม่รู้จักตัวเลือก: ${args.bad.join(' ')}\n` : ''}${USAGE}`, args.help ? 0 : 2);
  let cfg = loadConfig(home);
  const server = normalizeServer(args.server ?? cfg?.server ?? '');
  if (!server) return quit(`ต้องระบุ --server ที่เป็น https://... (http ใช้ได้เฉพาะ localhost)\n${USAGE}`, 2);

  // pair when asked to (code/token), or when this folder has no credentials for this server. The installers pass the
  // token as DRA_TOKEN with --pair-only (argv is visible to other users in ps); --token stays for developers.
  let code = args.code, token = args.token ?? (args.pairOnly && env.DRA_TOKEN ? env.DRA_TOKEN : undefined);
  const paired = cfg?.deviceId && cfg?.secret && cfg.server === server;
  if (!code && !token && !paired) {
    if (!stdin.isTTY) return quit(`ยังไม่ได้เชื่อมกับบอท ใส่ --code (ขอได้ด้วย /agent ใน Discord)\n${USAGE}`, 2);
    const rl = createInterface({ input: stdin, output: stdout });
    code = (await rl.question('รหัส 6 หลักจาก /agent ใน Discord: ')).trim();
    rl.close();
  }
  // consent once, before the first pairing (the installers ask and pass --consent); a config from before counts as agreed
  if ((code || token) && !args.consent && !cfg) {
    if (!stdin.isTTY) return quit('ยกเลิกการติดตั้ง ไม่ได้ติดตั้งอะไร (ต้องรันในเทอร์มินัลเพื่อตอบคำถาม หรือใส่ --consent)', 0);
    say('ℹ️  ตัวอัดจะให้บอทอัดทั้งจอที่เลือกของเครื่องนี้ได้ทุกครั้งที่มีคนกดอัดหรือเปิดอัดอัตโนมัติ โดยไม่ถามอีก กด s ที่ตัวอัดเพื่อหยุดได้ทุกเมื่อ');
    const rl = createInterface({ input: stdin, output: stdout });
    const a = (await rl.question('ให้บอทอัดจอเครื่องนี้ไหม? (y/N) ')).trim();
    rl.close();
    if (!/^(y|yes)$/i.test(a)) return quit('ยกเลิกการติดตั้ง ไม่ได้ติดตั้งอะไร', 0);
  }
  if (code || token) {
    const r = await pair(server, { ...(token ? { token } : { code }), name: hostname(), os: platform, version: AGENT_VERSION }, fetchFn);
    if (!r.ok) {
      return quit(r.status === 410 ? '❌ รหัสไม่ถูกต้องหรือหมดอายุ ขอใหม่ด้วย /agent ใน Discord'
        : r.status === 429 ? '❌ ลองผิดหลายครั้งเกินไป รอสักครู่แล้วลองใหม่'
          : '❌ เชื่อมต่อบอทไม่ได้ ตรวจ --server แล้วลองใหม่');
    }
    cfg = { ...(cfg?.server === server ? cfg : {}), server, deviceId: r.deviceId, secret: r.secret, user: r.user, consent: true };
    say(`✅ เชื่อมกับ Discord ในชื่อ ${r.user?.tag ?? '?'} แล้ว`);
  }
  if (!code && !token && !paired) return quit('❌ ไม่ได้ใส่รหัส ยกเลิก — เชื่อมใหม่: พิมพ์ /agent ใน Discord แล้ววางคำสั่งติดตั้งใน Terminal อีกครั้ง', 2); // also a revoked config
  if (args.display !== undefined) cfg.display = args.display;
  delete cfg.askFirst; // ask-first is gone: an old saved true never prompts, and the next save drops it
  if (args.fps !== undefined) cfg.fps = Number(args.fps);
  saveConfig(home, cfg);
  if (args.pairOnly) return quit('', 0);

  const bin = ffmpegPath({ env, dir: home, platform });
  const pruned = pruneRecordings(home);
  const ui = createUi({ stdin, stdout, platform, notifyFn: o.notifyFn });
  const host = new URL(server).host;
  let displays = bin ? await (o.listDisplaysFn ?? listDisplays)({ platform, bin }) : [];
  let cur = null, starting = false, shut = null;
  let finish; const done = new Promise((r) => { finish = r; });

  const ready = (user) => ui.setText(`⚪ พร้อม — เชื่อมกับ ${host} ในชื่อ ${user?.tag ?? cfg.user?.tag ?? '?'}`);
  const link = new Link({
    server, cred: cfg, T: T.link, fetchFn,
    info: { name: hostname(), os: platform, version: AGENT_VERSION },
    getState: () => ({ displays, display: cfg.display ?? displays[0]?.id ?? null }),
    onStatus(kind, d) {
      if (kind === 'online') { ui.setNote(''); if (!cur) ready(d.user); } // keep the 🔴 line while recording
      else if (kind === 'offline') { ui.setNote(`🟠 ต่อบอทไม่ได้ ลองใหม่ใน ${Math.ceil(d.wait / 1000)} วิ`); if (!cur) ui.setText('⚪ รอเชื่อมต่อบอท'); }
      else if (kind === 'replaced') { ui.setNote(''); ui.setText('⚠️ เครื่องอื่นของคุณเชื่อมต่อแทนแล้ว กด r เพื่อใช้เครื่องนี้'); }
      else if (kind === 'revoked') {
        delete cfg.deviceId; delete cfg.secret; saveConfig(home, cfg);
        ui.log('🗑️ ตัวอัดนี้ถูกยกเลิกการเชื่อมต่อจาก Discord ลบข้อมูลเชื่อมต่อแล้ว — เชื่อมใหม่: พิมพ์ /agent ใน Discord แล้ววางคำสั่งติดตั้งใน Terminal อีกครั้ง');
        shutdown();
      }
    },
    onCmd: (c) => (c?.type === CMD.start ? onStart(c) : c?.type === CMD.stop ? onStop(c) : null),
  });

  function onStop(c) {
    return cur?.capId === c.capId ? cur.stop(STOP_REASON.local) : null;
  }

  async function onStart(c) {
    if (cur || starting) return link.ack(c.id, false, ACK_ERROR.busy);
    starting = true; // reserved before the first await
    let cap;
    try {
      // never asks: a start records at once (an old bot's `ask` flag is ignored)
      if (shut) return link.ack(c.id, false, ACK_ERROR.offline);
      if (!bin) return link.ack(c.id, false, ACK_ERROR.ffmpeg, 'ไม่พบ ffmpeg ของตัวอัด รันคำสั่งติดตั้งจาก /agent ใหม่');
      // area 'discord': only the Discord window, found now; not found = the whole screen with a note for the bot's card
      const { input, crop, note } = await areaInput({ platform, display: pickDisplay(displays, cfg.display), fps: cfg.fps ?? 15, area: c.area, runFn: o.runFn });
      if (!input) return link.ack(c.id, false, ACK_ERROR.display, 'ไม่พบจอที่เลือกไว้ กด d เพื่อเลือกจอใหม่');
      if (note) ui.log(`ℹ️ ${note}`);
      cap = new Capture({ server, cmd: c, bin, args: buildArgs(platform, input, crop), dir: home, platform, T: T.capture, spawnFn, fetchFn, log: ui.log });
      cur = cap;
      const r = await cap.start();
      if (!r.ok) { cur = null; ui.log(`❌ เริ่มอัดไม่ได้: ${r.detail}`); return link.ack(c.id, false, r.error, r.detail); }
      ui.setRec(Date.now());
      ui.notify('ตัวอัดหน้าจอ', '🔴 เริ่มอัดจอแล้ว');
      cap.finished.then((f) => {
        if (cur === cap) cur = null;
        ui.setRec(0); ready();
        ui.notify('ตัวอัดหน้าจอ', '⏹️ หยุดอัดจอแล้ว');
        if (f.crashed) ui.log(`❌ ffmpeg หยุดทำงานเอง: ${f.tail}`);
        else ui.log('⏹️ หยุดอัดแล้ว กำลังรอบอทรวมไฟล์...');
      });
      cap.final.then((f) => { if (f.kept) ui.log(`💾 เก็บไฟล์ในเครื่องไว้ที่ ${f.file} (${f.why})`); else ui.log('✅ บอทได้รับวิดีโอแล้ว ลบไฟล์ในเครื่องแล้ว'); });
      return link.ack(c.id, true, undefined, note);
    } catch (e) {
      cur = null; cap?.cancel();
      return link.ack(c.id, false, ACK_ERROR.ffmpeg, e.message);
    } finally { starting = false; }
  }

  // local stop (case 20): the bot hears reason 'agent' and treats it as the owner stopping
  const stopCur = (reason) => (cur ? cur.stop(reason) : null);

  function shutdown() {
    shut ??= (async () => {
      if (cur) await Promise.race([stopCur(STOP_REASON.quit), new Promise((r) => setTimeout(r, 10000).unref())]);
      await link.stop(); ui.close(); finish(0);
    })();
    return shut;
  }

  ui.onKey = (k) => {
    if (k === 's') { if (cur) { ui.log('⏹️ กำลังหยุดอัด...'); stopCur(STOP_REASON.local); } }
    else if (k === 'q' || k === 'ctrl-c') shutdown();
    else if (k === 'r') { if (link.resume()) ui.setText('⚪ กำลังเชื่อมต่อบอท...'); }
    else if (k === 'd' && displays.length > 1) {
      const i = displays.findIndex((d) => d.id === (cfg.display ?? displays[0].id));
      const d = displays[(i + 1) % displays.length];
      cfg.display = d.id; saveConfig(home, cfg); link.sendState();
      ui.log(`🖥️ เลือกจอ: ${d.name}${cur ? ' (มีผลกับการอัดครั้งถัดไป)' : ''}`);
    }
  };

  if (!bin) ui.log(`❌ ไม่พบ ffmpeg ของตัวอัดที่ ${home} อัดจอไม่ได้จนกว่าจะรันคำสั่งติดตั้งจาก /agent ใหม่`);
  if (pruned) ui.log(`🧹 ลบไฟล์อัดในเครื่องที่เก่ากว่า 7 วันแล้ว ${pruned} ไฟล์`);
  link.start();
  return { done, shutdown, link, ui, get recording() { return cur; }, cfg };
}

export async function cli() {
  const a = await runAgent({ argv: process.argv.slice(2) });
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => a.shutdown());
  process.exit(await a.done);
}

// run as a script only (importing this file for tests does nothing)
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) cli();
