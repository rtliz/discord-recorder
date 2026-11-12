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
  static RECONNECT_MS = 5000; // a disconnect that doesn't start reconnecting within this is for good

  constructor(channel, dir) {
    this.kind = 'voice';
    this.channel = channel;
    this.dir = dir;
    this.tracks = new Map(); // userId -> { file, out, written, active }
    this.startedAt = 0;
    this.recording = false;
  }

  // joins the room; record false: sit in it silently until begin() (a session's room audio starts with its first video)
  async start({ record = true } = {}) {
    await mkdir(this.dir, { recursive: true });
    this.connection = joinVoiceChannel({
      channelId: this.channel.id,
      guildId: this.channel.guild.id,
      adapterCreator: this.channel.guild.voiceAdapterCreator,
      selfDeaf: false,
    });
    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (e) {
      this.connection.destroy(); // don't leave a half-open connection for the next join to reuse
      throw e;
    }
    this.watch(this.connection);
    if (record) this.begin();
  }

  // starts recording on the joined connection; at = the recording clock's zero (every track is padded from it).
  // Nothing is subscribed before this, so nobody is recorded while the bot only waits in the room
  begin(at = Date.now()) {
    if (this.recording || this.stopping || !this.connection) return;
    this.recording = true;
    this.startedAt = at;
    const { speaking } = this.connection.receiver;
    speaking.on('start', (id) => this.#listen(id));
    for (const id of speaking.users?.keys() ?? []) this.#listen(id); // already talking: no wait for their next burst
  }

  // kicked, moved away for good, or the network gone: tell the owner (onGone) instead of recording silence.
  // A move to another channel or a short blip goes back to Signalling/Connecting by itself.
  watch(connection) {
    connection.on('stateChange', (_, next) => {
      if (next.status !== VoiceConnectionStatus.Disconnected || this.stopping || this.gone) return;
      Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, VoiceRecorder.RECONNECT_MS),
        entersState(connection, VoiceConnectionStatus.Connecting, VoiceRecorder.RECONNECT_MS),
      ]).catch(() => {
        if (this.stopping || this.gone) return;
        this.gone = true;
        if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
        this.onGone?.();
      });
    });
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
    this.stopping = true;
    // already destroyed when the bot was dropped from the room (destroy() would throw)
    if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) this.connection.destroy();
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
