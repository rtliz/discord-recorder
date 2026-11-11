import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

// crop in input pixels; even sizes for yuv420p / h264
const cropFilter = ({ x, y, w, h }) =>
  `crop=trunc(iw*${w}/2)*2:trunc(ih*${h}/2)*2:trunc(iw*${x}):trunc(ih*${y})`;

// records the screen of the machine running the bot (macOS avfoundation);
// `region` ({x, y, w, h} as fractions of the display) crops to one window's area
export class ScreenRecorder {
  constructor(dir, device = '2', region = null) {
    this.dir = dir;
    this.device = device;
    this.region = region;
    this.output = join(dir, 'screen.mp4');
  }

  async start() {
    await mkdir(this.dir, { recursive: true });
    this.proc = spawn('ffmpeg', [
      '-y', '-f', 'avfoundation', '-framerate', '30', '-capture_cursor', '1',
      '-i', `${this.device}:none`,
      ...(this.region ? ['-vf', cropFilter(this.region)] : []),
      '-c:v', 'h264_videotoolbox', '-b:v', '4M', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', this.output,
    ], { stdio: ['pipe', 'ignore', 'pipe'] });

    let err = '';
    this.proc.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    this.exited = once(this.proc, 'exit');

    // wait for the first encoded frame: without Screen Recording permission avfoundation
    // neither errors nor delivers frames, ffmpeg just hangs
    const firstFrame = new Promise((r) => {
      const onData = (d) => { if (/frame=\s*\d+/.test(d)) { this.proc.stderr.off('data', onData); this.firstFrameAt = Date.now(); r('ok'); } };
      this.proc.stderr.on('data', onData);
    });
    const result = await Promise.race([
      firstFrame,
      this.exited.then(() => 'exit'),
      new Promise((r) => setTimeout(() => r('timeout'), 8000)),
    ]);
    if (result === 'exit') throw new Error(`ffmpeg screen capture failed:\n${err}`);
    if (result === 'timeout') {
      this.proc.kill('SIGKILL');
      const e = new Error('🚫 ไม่ได้รับสิทธิ์อัดหน้าจอ (macOS Screen Recording)\n'
        + 'เปิดสิทธิ์ให้แอปที่รันบอทที่ System Settings → Privacy & Security → Screen & System Audio Recording '
        + 'แล้วปิดเปิดแอปนั้นใหม่');
      e.code = 'SCREEN_PERMISSION';
      throw e;
    }
  }

  async stop() {
    this.stopping = true; // lets the owner tell a requested stop from ffmpeg dying on its own
    this.proc.stdin.write('q'); // ffmpeg finalizes the mp4 on 'q'
    const timeout = (ms) => new Promise((r) => setTimeout(() => r('timeout'), ms));
    if (await Promise.race([this.exited, timeout(15000)]) === 'timeout') {
      this.proc.kill('SIGINT'); // second chance to finalize
      if (await Promise.race([this.exited, timeout(5000)]) === 'timeout') {
        this.proc.kill('SIGKILL');
        throw new Error('ffmpeg ไม่ยอมหยุด ไฟล์วิดีโออาจเสีย');
      }
    }
    return this.output;
  }
}
