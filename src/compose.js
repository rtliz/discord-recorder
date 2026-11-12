import { spawn } from 'node:child_process';
import { copyFileSync, linkSync, renameSync, rmSync } from 'node:fs';
import { extname, join } from 'node:path';
import { mergeAudio } from './merge.js';

// One meeting file from a session: video segments (different machines/sizes, maybe gaps) + the room's continuous voice.
// Times are epoch ms (like VoiceRecorder.startedAt and BrowserCapture.liveAt). Only node built-ins and merge.js.
const FAST_GAP_MS = 15000, FPS = 15, MAX_W = 1920, MAX_H = 1080, MIN_TIMEOUT_MS = 15 * 60000, PROBE_MS = 30000;
const sec = (ms) => (ms / 1000).toFixed(3);
const even = (n) => Math.max(2, Math.floor(n / 2) * 2);

// -> size/length/audio of one file; null when unreadable or ffprobe hangs past timeoutMs (async: a stuck ffprobe must
// not freeze the bot). dur is null for streams with no duration (kept honest, caller decides)
export function probe(file, { timeoutMs = PROBE_MS } = {}) {
  const parse = (out) => {
    try {
      const j = JSON.parse(out);
      const v = j.streams?.find((s) => s.codec_type === 'video');
      if (!v) return null;
      const d = Number(v.duration ?? j.format?.duration);
      return { w: v.width, h: v.height, dur: Number.isFinite(d) && d > 0 ? d * 1000 : null, hasAudio: j.streams.some((s) => s.codec_type === 'audio') };
    } catch { return null; }
  };
  return new Promise((resolve) => {
    let out = '', timer = null;
    const end = (v) => { clearTimeout(timer); resolve(v); };
    let p;
    try {
      p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,duration:format=duration', '-of', 'json', file], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { return end(null); }
    timer = setTimeout(() => { p.kill('SIGKILL'); end(null); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => end(null));
    p.on('close', (code) => end(code === 0 ? parse(out) : null)); // a second resolve is a no-op
  });
}

// Canvas = the largest segment, shrunk to fit 1920x1080 (aspect kept), even dims
export function canvasOf(segs) {
  const big = segs.reduce((a, s) => (s.w * s.h > a.w * a.h ? s : a));
  const k = Math.min(1, MAX_W / big.w, MAX_H / big.h);
  return { W: even(big.w * k), H: even(big.h * k) };
}

// Pure: segments [{file, start, end, w, h, hasAudio}] (end = when its video really ended) -> ffmpeg args.
// Timeline T0 = audioStart, D = end - T0. Each segment is clipped to [start, min(end, next start)] so overlaps never double.
// audio null (no room recording): a silent track stands in, so the file still has the same one audio stream.
export function planCompose({ segments, audio, audioStart, end, output }) {
  const D = end - audioStart;
  if (!(D > 0)) throw new Error('compose: empty timeline');
  const { W, H } = canvasOf(segments);
  const order = segments.map((s, i) => ({ ...s, i })).sort((a, b) => a.start - b.start);
  const inputs = order.map((s) => ['-i', s.file]).flat();
  const black = (ms) => `color=c=black:s=${W}x${H}:r=${FPS}:d=${sec(ms)},format=yuv420p,setsar=1`;
  const parts = [], labels = [], mixIn = [];
  let cur = audioStart; // video is laid out up to here
  order.forEach((s, k) => {
    const from = Math.max(s.start, cur), to = Math.min(s.end, order[k + 1]?.start ?? Infinity, end);
    if (to - from < 100) return; // sub-frame sliver: drop it
    if (from > cur) { parts.push(`${black(from - cur)}[g${k}]`); labels.push(`[g${k}]`); }
    parts.push(`[${k}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,fps=${FPS},`
      + `tpad=stop_mode=clone:stop_duration=${sec(to - from)},trim=start=${sec(from - s.start)}:duration=${sec(to - from)},setpts=PTS-STARTPTS[v${k}]`);
    labels.push(`[v${k}]`);
    if (s.hasAudio) {
      parts.push(`[${k}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=start=${sec(from - s.start)}:duration=${sec(to - from)},asetpts=PTS-STARTPTS,adelay=${Math.round(from - audioStart)}:all=1,apad[s${k}]`);
      mixIn.push(`[s${k}]`);
    }
    cur = to;
  });
  if (!labels.length) throw new Error('compose: no usable video');
  if (end > cur) { parts.push(`${black(end - cur)}[tail]`); labels.push('[tail]'); }
  parts.push(`${labels.join('')}concat=n=${labels.length}:v=1:a=0[vout]`);
  const A = order.length; // voice is the last input
  parts.push(audio ? `[${A}:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=0:${sec(D)}[voice]`
    : `anullsrc=r=48000:cl=stereo,atrim=0:${sec(D)}[voice]`);
  parts.push(`[voice]${mixIn.join('')}amix=inputs=${1 + mixIn.length}:duration=first:normalize=0[aout]`);
  const args = ['-y', '-v', 'error', ...inputs, ...(audio ? ['-i', audio] : []), '-filter_complex', parts.join(';'), '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'superfast', '-crf', '30', '-r', String(FPS), '-g', '150', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-t', sec(D), output];
  return { args, W, H, D };
}

// One compose at a time process-wide (1 CPU pod). pending() = running + waiting (counted from the call: probing is async),
// so a new caller's place in line is pending() + 1.
let tail = Promise.resolve(), waiting = 0;
export const pending = () => waiting;
export const compose = { pending };

function run(args, timeoutMs) {
  const [cmd, a] = process.platform === 'win32' ? ['ffmpeg', args] : ['nice', ['-n', '10', 'ffmpeg', ...args]];
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, a, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '', timedOut = false;
    proc.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, timeoutMs);
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`compose timed out after ${Math.round(timeoutMs / 1000)}s`));
      else if (code !== 0) reject(new Error(`compose ffmpeg failed (${code}): ${err}`));
      else resolve();
    });
  });
}

// -> { file, reencoded }; throws on failure (caller delivers the segments separately, plan D15)
// audio may be null (no voice file): the fast path keeps the segment as it is, the compose path adds a silent track
export async function composeMeeting(job, opts) {
  waiting++;
  try { return await composeOne(job, opts); } finally { waiting--; }
}

async function composeOne({ segments, audio, audioStart, end, dir }, { timeoutMs } = {}) {
  const meta = [];
  for (const s of segments) {
    const p = await probe(s.file);
    if (p) meta.push({ ...s, ...p, end: s.end ?? (p.dur ? s.start + p.dur : end) });
  }
  if (!meta.length) throw new Error('compose: no readable video segment');
  // Fast path: one segment and the voice is not missing video for more than 15 s at either side -> copy video, mux voice
  if (meta.length === 1) {
    const [s] = meta;
    if (s.start - audioStart <= FAST_GAP_MS && end - s.end <= FAST_GAP_MS) {
      if (!audio) { // nothing to mux: the segment is the meeting (a hard link, no 1 GB copy; the segment stays for the caller)
        const file = join(dir, 'meeting' + extname(s.file));
        if (file !== s.file) {
          rmSync(file, { force: true });
          try { linkSync(s.file, file); } catch { copyFileSync(s.file, file); }
        }
        return { file, reencoded: false };
      }
      const merged = await mergeAudio(s.file, audio, s.start - audioStart);
      if (merged) {
        const file = join(dir, 'meeting' + extname(s.file));
        renameSync(merged, file);
        return { file, reencoded: false };
      }
      // merge failed (e.g. unreadable voice): fall through, the compose path reports a real error
    }
  }
  const output = join(dir, 'meeting.mp4');
  const { args, D } = planCompose({ segments: meta, audio, audioStart, end, output });
  const prev = tail;
  let release;
  tail = new Promise((r) => { release = r; });
  try {
    await prev;
    await run(args, timeoutMs ?? Math.max(MIN_TIMEOUT_MS, D));
    return { file: output, reencoded: true };
  } catch (e) {
    rmSync(output, { force: true });
    throw e;
  } finally {
    release();
  }
}
