import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// JXA: on-screen windows of an app (global points, origin top-left of the main display) + main display size
const JXA = `
ObjC.import('CoreGraphics'); ObjC.import('AppKit');
function run(argv) {
  const opts = $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements;
  const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(opts, $.kCGNullWindowID))) || [];
  const f = $.NSScreen.screens.objectAtIndex(0).frame;
  const wins = list.filter((w) => w.kCGWindowOwnerName === argv[0] && w.kCGWindowLayer === 0).map((w) => w.kCGWindowBounds);
  return JSON.stringify({ sw: f.size.width, sh: f.size.height, wins });
}`;

/**
 * Region of the main display covered by the biggest on-screen window of `app`,
 * as fractions of the display (so it works at any Retina scale).
 * Assumes SCREEN_DEVICE captures the main display.
 */
export async function windowRegion(app) {
  const { stdout } = await promisify(execFile)('osascript', ['-l', 'JavaScript', '-e', JXA, app], { timeout: 10000 });
  const { sw, sh, wins } = JSON.parse(stdout);
  const notFound = (msg) => Object.assign(new Error(msg), { code: 'WINDOW_NOT_FOUND' });
  if (!wins.length) throw notFound(`🪟 ไม่พบหน้าต่าง ${app} บนจอ (ยังไม่เปิด ถูกย่อ หรืออยู่ Space อื่น)`);

  const w = wins.reduce((a, b) => (b.Width * b.Height > a.Width * a.Height ? b : a));
  // clip to the main display
  const x0 = Math.max(0, w.X), y0 = Math.max(0, w.Y);
  const x1 = Math.min(sw, w.X + w.Width), y1 = Math.min(sh, w.Y + w.Height);
  if (x1 - x0 < 50 || y1 - y0 < 50) throw notFound(`🪟 หน้าต่าง ${app} ไม่ได้อยู่บนจอหลัก ย้ายมาที่จอหลักก่อน`);
  return { x: x0 / sw, y: y0 / sh, w: (x1 - x0) / sw, h: (y1 - y0) / sh };
}
