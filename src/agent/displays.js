// Display discovery and ffmpeg input args per OS. Node built-ins only (this runs on a bundled plain Node).
import { execFile } from 'node:child_process';

export const DESKTOP = { id: 'desktop', name: 'ทั้งเดสก์ท็อป' };

const run = (cmd, args, ms = 8000) => new Promise((res) =>
  execFile(cmd, args, { timeout: ms, windowsHide: true, maxBuffer: 1 << 20 }, (e, out, err) => res(`${out ?? ''}\n${err ?? ''}`)));

// avfoundation prints "[3] Capture screen 0" on stderr; the bracket number is the device index to pass to -i
// (screen: avfoundation's screen number, taken as NSScreen's order for the Discord window crop)
export const parseMac = (t) => [...t.matchAll(/\[(\d+)\] Capture screen (\d+)/g)].map((m) => ({ id: m[1], name: `จอ ${+m[2] + 1}`, screen: +m[2] }));

// one "x,y,w,h,primary" line per monitor; the id carries the geometry so no state is needed later
export const parseWin = (t) => t.split(/\r?\n/).map((l) => /^\s*(-?\d+),(-?\d+),(\d+),(\d+),(True|False)\s*$/i.exec(l)).filter(Boolean)
  .map((m, i) => ({ id: `${m[1]},${m[2]},${m[3]},${m[4]}`, name: `จอ ${i + 1} (${m[3]}x${m[4]})${/true/i.test(m[5]) ? ' หลัก' : ''}` }));

const PS = "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { '{0},{1},{2},{3},{4}' -f $_.Bounds.X,$_.Bounds.Y,$_.Bounds.Width,$_.Bounds.Height,$_.Primary }";

// listing only (-list_devices never captures); on macOS an empty list means ffmpeg could not enumerate screens
export async function listDisplays({ platform = process.platform, bin = 'ffmpeg', runFn = run } = {}) {
  try {
    if (platform === 'darwin') return parseMac(await runFn(bin, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']));
    if (platform === 'win32') return [DESKTOP, ...parseWin(await runFn('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS]))];
  } catch { /* fall through */ }
  return platform === 'darwin' ? [] : [DESKTOP];
}

// no id: the first display. An id that is no longer in the list gives undefined (never record another screen silently)
export const pickDisplay = (list, id) => (id ? list.find((d) => d.id === id) : list[0]);

// ffmpeg input args for one display, or null when the display is unusable
export function inputArgs(platform, display, fps = 15) {
  if (!display) return null;
  const r = String(fps);
  if (platform === 'darwin') return /^\d+$/.test(display.id) ? ['-f', 'avfoundation', '-capture_cursor', '1', '-framerate', r, '-i', `${display.id}:none`] : null;
  if (platform === 'win32') {
    const g = /^(-?\d+),(-?\d+),(\d+),(\d+)$/.exec(display.id);
    return ['-f', 'gdigrab', '-framerate', r, ...(g ? ['-offset_x', g[1], '-offset_y', g[2], '-video_size', `${g[3]}x${g[4]}`] : []), '-i', 'desktop'];
  }
  return ['-f', 'x11grab', '-framerate', r, '-i', process.env.DISPLAY || ':0.0']; // best effort
}

// --- capture area 'discord': only the Discord window, resolved at start (its title follows the channel) ---
export const AREA_MISS = 'หาหน้าต่าง Discord ไม่เจอ อัดทั้งจอแทน';
const AREA_NONE = 'เครื่องนี้อัดเฉพาะหน้าต่าง Discord ไม่ได้ อัดทั้งจอแทน';
// Windows: the title of Discord's main window (stable, PTB or Canary)
const WIN_TITLE = "(Get-Process Discord,DiscordPTB,DiscordCanary -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -First 1).MainWindowTitle";
// macOS: on-screen Discord windows and every display, in global points with a top-left origin. Window bounds and owner
// names need no extra permission (no System Events, no Accessibility); same idea as src/window-bounds.js
const MAC_JXA = `
ObjC.import('CoreGraphics'); ObjC.import('AppKit');
function run() {
  const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID))) || [];
  const all = $.NSScreen.screens, main = all.objectAtIndex(0).frame, screens = [];
  for (let i = 0; i < all.count; i++) {
    const f = all.objectAtIndex(i).frame;
    screens.push({ x: f.origin.x, y: main.size.height - f.origin.y - f.size.height, w: f.size.width, h: f.size.height });
  }
  const wins = list.filter((w) => /^Discord/.test(w.kCGWindowOwnerName || '') && w.kCGWindowLayer === 0).map((w) => w.kCGWindowBounds);
  return JSON.stringify({ screens, wins });
}`;

// ffmpeg crop (input pixels, even sizes) for the biggest Discord window on screen n, or null. Fractions of the display,
// so any Retina scale works; the part outside that display is cut off
export function discordCrop({ screens = [], wins = [] } = {}, n = 0) {
  const s = screens[n] ?? screens[0];
  if (!s) return null;
  const clip = (w) => {
    const x0 = Math.max(s.x, w.X), y0 = Math.max(s.y, w.Y), x1 = Math.min(s.x + s.w, w.X + w.Width), y1 = Math.min(s.y + s.h, w.Y + w.Height);
    return { x0, y0, a: Math.max(0, x1 - x0) * Math.max(0, y1 - y0), w: x1 - x0, h: y1 - y0 };
  };
  const best = wins.map(clip).filter((c) => c.w >= 50 && c.h >= 50).sort((a, b) => b.a - a.a)[0];
  if (!best) return null;
  const f = (v) => +v.toFixed(5);
  const [x, y, w, h] = [f((best.x0 - s.x) / s.w), f((best.y0 - s.y) / s.h), f(best.w / s.w), f(best.h / s.h)];
  return `crop=trunc(iw*${w}/2)*2:trunc(ih*${h}/2)*2:trunc(iw*${x}):trunc(ih*${y})`;
}

// the input for one start: -> { input (null: display unusable), crop?, note? }. note: why it records the whole screen
// instead (shown on the bot's card). A crop stays where the window was at start: moving or resizing it later doesn't follow
export async function areaInput({ platform = process.platform, display, fps = 15, area, runFn = run } = {}) {
  const input = inputArgs(platform, display, fps);
  if (!input || area !== 'discord') return { input };
  try {
    if (platform === 'win32') {
      const title = (await runFn('powershell', ['-NoProfile', '-NonInteractive', '-Command', WIN_TITLE])).split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      if (title) return { input: ['-f', 'gdigrab', '-framerate', String(fps), '-i', `title=${title}`] };
    } else if (platform === 'darwin') {
      const line = (await runFn('osascript', ['-l', 'JavaScript', '-e', MAC_JXA])).split(/\r?\n/).find((l) => l.trim().startsWith('{'));
      const crop = line ? discordCrop(JSON.parse(line), display.screen ?? 0) : null;
      if (crop) return { input, crop };
    } else return { input, note: AREA_NONE };
  } catch { /* the whole screen, with the note */ }
  return { input, note: AREA_MISS };
}
