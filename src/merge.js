import { spawn, spawnSync } from 'node:child_process';
import { extname } from 'node:path';

// Mux the room's voice track into a screen video without touching the video stream.
// offsetMs = video start - voice start: > 0 the voice began earlier (trim its head), < 0 later (delay it).
// Resolves to the new file's path, or null on any failure (caller delivers the files separately).
const hasAudio = (file) => {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim().length > 0 : null; // null: unreadable
};

export function mergeArgs(videoPath, audioPath, offsetMs, withOwnAudio, output) {
  const webm = extname(videoPath).toLowerCase() === '.webm';
  const sec = (Math.abs(offsetMs) / 1000).toFixed(3);
  const shift = offsetMs > 0 ? ['-ss', sec] : offsetMs < 0 ? ['-itsoffset', sec] : [];
  // apad + -shortest: the voice is padded/cut to exactly the video's length (never longer, never ends it early)
  const chain = withOwnAudio ? '[0:a][1:a]amix=inputs=2:duration=first:normalize=0,apad[a]' : '[1:a]apad[a]';
  return ['-y', '-v', 'error', '-i', videoPath, ...shift, '-i', audioPath,
    '-filter_complex', chain, '-map', '0:v:0', '-map', '[a]',
    '-c:v', 'copy', ...(webm ? ['-c:a', 'libopus', '-b:a', '128k'] : ['-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart']),
    '-shortest', output];
}

export async function mergeAudio(videoPath, audioPath, offsetMs = 0, { timeoutMs = 15 * 60000 } = {}) {
  try {
    const own = hasAudio(videoPath);
    if (own === null || hasAudio(audioPath) !== true) return null;
    const ext = extname(videoPath);
    const output = videoPath.slice(0, -ext.length) + '-with-audio' + ext;
    const proc = spawn('ffmpeg', mergeArgs(videoPath, audioPath, Number(offsetMs) || 0, own, output), { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    const code = await new Promise((r) => { proc.on('error', () => r(-1)); proc.on('close', (c) => r(c)); });
    clearTimeout(timer);
    if (code !== 0) { console.error(`mergeAudio failed (${code}): ${err}`); return null; }
    return output;
  } catch (e) {
    console.error(e);
    return null;
  }
}
