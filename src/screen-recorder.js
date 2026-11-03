import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

// records the screen of the machine running the bot (macOS avfoundation)
export class ScreenRecorder {
  constructor(dir, device = '2') {
    this.dir = dir;
    this.device = device;
    this.output = join(dir, 'screen.mp4');
  }

  async start() {
    await mkdir(this.dir, { recursive: true });
    this.proc = spawn('ffmpeg', [
      '-y', '-f', 'avfoundation', '-framerate', '30', '-capture_cursor', '1',
      '-i', `${this.device}:none`,
      '-c:v', 'h264_videotoolbox', '-b:v', '4M', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', this.output,
    ], { stdio: ['pipe', 'ignore', 'pipe'] });

    let err = '';
    this.proc.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    this.exited = once(this.proc, 'exit');

    // fail fast if avfoundation is denied (screen recording permission) or device is wrong
    const early = await Promise.race([
      this.exited.then(([code]) => code),
      new Promise((r) => setTimeout(() => r(null), 2500)),
    ]);
    if (early !== null) throw new Error(`ffmpeg screen capture failed:\n${err}`);
  }

  async stop() {
    this.proc.stdin.write('q'); // ffmpeg finalizes the mp4 on 'q'
    await this.exited;
    return this.output;
  }
}
