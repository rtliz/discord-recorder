// Terminal UI: one status line + window title, single-key commands, macOS notifications. Node built-ins only.
import { execFile } from 'node:child_process';

export const hms = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return [s / 3600, (s / 60) % 60, s % 60].map((v) => String(Math.floor(v)).padStart(2, '0')).join(':'); };
const esc = (s) => String(s).replace(/[\\"]/g, '\\$&').replace(/[\r\n]+/g, ' ');

export function createUi({ stdin = process.stdin, stdout = process.stdout, platform = process.platform, notifyFn, now = Date.now } = {}) {
  const tty = Boolean(stdout.isTTY), keys = Boolean(stdin.isTTY);
  let text = '', note = '', rec = 0, timer = null, onKey = () => {}, closed = false;
  const line = () => (rec ? `🔴 กำลังอัดจอ ${hms(now() - rec)} · กด s เพื่อหยุด${note}` : `${text}${note}`);
  const draw = () => { const l = line(); stdout.write(`\r\x1b[2K${l}`); stdout.write(`\x1b]0;${l}\x07`); };
  const push = () => (tty ? draw() : stdout.write(`${line()}\n`)); // a pipe gets one line per change, no ticking
  const log = (t) => { if (tty) { stdout.write(`\r\x1b[2K${t}\n`); draw(); } else stdout.write(`${t}\n`); };

  const onData = (d) => { for (const k of String(d)) onKey(k === '\x03' ? 'ctrl-c' : k.toLowerCase()); };
  if (keys) { stdin.setRawMode?.(true); stdin.setEncoding?.('utf8'); stdin.on('data', onData); stdin.resume?.(); }

  return {
    log,
    setText(t) { text = t; push(); },
    setNote(n) { note = n ? ` · ${n}` : ''; push(); },
    // t0 = start time (ms) of a live recording, 0 for idle
    setRec(t0) {
      rec = t0; clearInterval(timer);
      if (rec && tty) timer = setInterval(draw, 1000);
      push();
    },
    set onKey(fn) { onKey = fn; },
    notify(title, body) {
      if (notifyFn) return notifyFn(title, body);
      if (platform === 'darwin') execFile('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`], () => {}).on('error', () => {});
    },
    close() {
      if (closed) return;
      closed = true; clearInterval(timer);
      if (keys) { stdin.off('data', onData); stdin.setRawMode?.(false); stdin.pause?.(); }
      if (tty) stdout.write('\n');
    },
  };
}
