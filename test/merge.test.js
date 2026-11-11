import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasFfmpeg } from './helpers/fixtures.js';
import { mergeAudio, mergeArgs } from '../src/merge.js';

const ff = (...a) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...a], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
const probe = (file) => {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', file], { encoding: 'utf8' });
  const j = JSON.parse(r.stdout);
  const types = j.streams.map((s) => s.codec_type);
  return { v: types.filter((t) => t === 'video').length, a: types.filter((t) => t === 'audio').length, dur: Number(j.format.duration) };
};

describe('mergeAudio', { skip: !hasFfmpeg() }, () => {
  let dir; const f = (n) => join(dir, n);
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'merge-'));
    const vid = ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15'];
    ff(...vid, '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', f('silent.mp4'));
    ff(...vid, '-t', '4', '-c:v', 'libvpx', '-b:v', '300k', f('silent.webm'));
    ff(...vid, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f('own.mp4'));
    ff('-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-t', '9', f('voice.mp3'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  for (const off of [2500, 0, -1500]) {
    test(`mp4 with offset ${off}: 1 video + 1 audio, video length kept`, async () => {
      const out = await mergeAudio(f('silent.mp4'), f('voice.mp3'), off);
      assert.equal(out, f('silent-with-audio.mp4'));
      const p = probe(out);
      assert.deepEqual([p.v, p.a], [1, 1]);
      assert.ok(Math.abs(p.dur - 4) < 0.3, `duration ${p.dur}`);
    });
  }

  test('webm gets opus audio, video untouched', async () => {
    const out = await mergeAudio(f('silent.webm'), f('voice.mp3'), 1000);
    assert.match(out, /-with-audio\.webm$/);
    const p = probe(out);
    assert.deepEqual([p.v, p.a], [1, 1]);
    assert.ok(Math.abs(p.dur - 4) < 0.3, `duration ${p.dur}`);
  });

  test('a video with its own audio is mixed: still one audio stream', async () => {
    const out = await mergeAudio(f('own.mp4'), f('voice.mp3'), 0);
    const p = probe(out);
    assert.deepEqual([p.v, p.a], [1, 1]);
    assert.ok(Math.abs(p.dur - 4) < 0.3, `duration ${p.dur}`);
  });

  test('command: copy video, trim vs delay by sign of the offset', () => {
    const a = mergeArgs('/x/s.mp4', '/x/v.mp3', 2500, false, '/x/o.mp4');
    assert.ok(a.join(' ').includes('-c:v copy') && a.join(' ').includes('-ss 2.500 -i /x/v.mp3') && a.includes('+faststart'));
    assert.ok(mergeArgs('/x/s.mp4', '/x/v.mp3', -1500, false, '/x/o.mp4').join(' ').includes('-itsoffset 1.500 -i /x/v.mp3'));
    assert.ok(mergeArgs('/x/s.mp4', '/x/v.mp3', 5, true, '/x/o.mp4').join(' ').includes('amix=inputs=2:duration=first:normalize=0'));
  });

  test('corrupt or missing input resolves to null', async () => {
    writeFileSync(f('bad.mp4'), 'not a video');
    writeFileSync(f('bad.mp3'), 'not audio');
    assert.equal(await mergeAudio(f('bad.mp4'), f('voice.mp3'), 0), null);
    assert.equal(await mergeAudio(f('silent.mp4'), f('bad.mp3'), 0), null);
    assert.equal(await mergeAudio(f('nope.mp4'), f('voice.mp3'), 0), null);
  });

  test('timeout kills ffmpeg and resolves null', async () => {
    assert.equal(await mergeAudio(f('silent.mp4'), f('voice.mp3'), 0, { timeoutMs: 1 }), null);
  });
});
