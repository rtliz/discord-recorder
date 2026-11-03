import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  EndBehaviorType,
} from '@discordjs/voice';
import prism from 'prism-media';

const BYTES_PER_MS = 48000 * 2 * 2 / 1000; // 48kHz s16le stereo

export class VoiceRecorder {
  constructor(channel, dir) {
    this.channel = channel;
    this.dir = dir;
    this.tracks = new Map(); // userId -> { file, out, written, active }
    this.startedAt = 0;
  }

  async start() {
    await mkdir(this.dir, { recursive: true });
    this.connection = joinVoiceChannel({
      channelId: this.channel.id,
      guildId: this.channel.guild.id,
      adapterCreator: this.channel.guild.voiceAdapterCreator,
      selfDeaf: false,
    });
    await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    this.startedAt = Date.now();
    this.connection.receiver.speaking.on('start', (id) => this.#listen(id));
  }

  #track(userId) {
    let t = this.tracks.get(userId);
    if (!t) {
      const file = join(this.dir, `${userId}.pcm`);
      t = { file, out: createWriteStream(file), written: 0, active: false };
      this.tracks.set(userId, t);
    }
    return t;
  }

  #listen(userId) {
    const t = this.#track(userId);
    if (t.active) return;
    t.active = true;

    // pad silence so every user's file stays aligned to the recording clock
    const gap = Math.floor((Date.now() - this.startedAt) * BYTES_PER_MS) - t.written;
    const aligned = gap - (gap % 4);
    if (aligned > 0) {
      t.out.write(Buffer.alloc(aligned));
      t.written += aligned;
    }

    const opus = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 500 },
    });
    const pcm = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    pcm.on('data', (chunk) => {
      t.out.write(chunk);
      t.written += chunk.length;
    });
    const done = () => { t.active = false; };
    pcm.on('end', done);
    pcm.on('error', done);
    opus.on('error', done);
    opus.pipe(pcm);
  }

  /** stop, mix all tracks into one mp3, return its path (or null if nobody spoke) */
  async stop() {
    this.connection.destroy();
    const tracks = [...this.tracks.values()];
    await Promise.all(tracks.map((t) => new Promise((r) => t.out.end(r))));
    if (!tracks.length) return null;

    const output = join(this.dir, 'voice.mp3');
    const args = ['-y'];
    for (const t of tracks) args.push('-f', 's16le', '-ar', '48000', '-ac', '2', '-i', t.file);
    if (tracks.length > 1) {
      args.push('-filter_complex', `amix=inputs=${tracks.length}:normalize=0:duration=longest`);
    }
    args.push('-b:a', '128k', output);
    const ff = spawn('ffmpeg', args, { stdio: 'ignore' });
    const [code] = await once(ff, 'exit');
    if (code !== 0) throw new Error(`ffmpeg mix exited ${code}`);
    return output;
  }
}
