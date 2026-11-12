import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasFfmpeg } from './helpers/fixtures.js';
import { composeMeeting, planCompose, canvasOf, pending, probe } from '../src/compose.js';

const ff = (...a) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...a], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
const info = (file) => {
  const j = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type,width,height:format=duration', '-of', 'json', file], { encoding: 'utf8' }).stdout);
  const v = j.streams.find((s) => s.codec_type === 'video');
  return { dur: Number(j.format.duration), w: v.width, h: v.height, vcodec: v.codec_name, a: j.streams.filter((s) => s.codec_type === 'audio').length };
};
// mean luma of the frame at t seconds (black ~16, testsrc2 is far brighter)
const yavg = (file, t) => {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-'], { encoding: 'utf8' });
  return Number(/YAVG=([\d.]+)/.exec(r.stdout)[1]);
};
const vmd5 = (file) => spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'md5', '-'], { encoding: 'utf8' }).stdout.trim();

const T0 = 1_700_000_000_000; // audioStart
describe('composeMeeting', { skip: !hasFfmpeg() }, () => {
  let root, n = 0; const f = (x) => join(root, x);
  const out = () => { const d = f(`o${n++}`); mkdirSync(d); return d; }; // each test gets its own output dir
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'compose-'));
    const test = (size, dur) => ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=15`, '-t', String(dur)];
    const enc = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];
    ff(...test('320x180', 2), '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', ...enc, '-c:a', 'aac', f('a.mp4')); // with own audio
    ff(...test('640x360', 2), ...enc, f('b.mp4'));
    ff(...test('480x270', 2), '-c:v', 'libvpx', '-b:v', '300k', f('c.webm'));
    ff('-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-t', '9', f('voice.mp3'));
  });
  after(() => rmSync(root, { recursive: true, force: true }));
  const base = () => ({ audio: f('voice.mp3'), audioStart: T0 });

  test('one segment, small gaps: fast path, video stream copied byte for byte', async () => {
    const dir = out();
    const r = await composeMeeting({ ...base(), segments: [{ file: f('b.mp4'), start: T0 + 1000 }], end: T0 + 4000, dir });
    assert.deepEqual([r.file, r.reencoded], [join(dir, 'meeting.mp4'), false]);
    assert.equal(vmd5(r.file), vmd5(f('b.mp4')));
    const p = info(r.file);
    assert.deepEqual([p.a, p.w, p.h], [1, 640, 360]);
  });

  test('one webm segment keeps its extension on the fast path', async () => {
    const r = await composeMeeting({ ...base(), segments: [{ file: f('c.webm'), start: T0 }], end: T0 + 2000, dir: out() });
    assert.match(r.file, /meeting\.webm$/);
    assert.equal(r.reencoded, false);
  });

  test('one segment but 20 s of voice after it: re-encoded onto black, full length', async () => {
    const r = await composeMeeting({ ...base(), segments: [{ file: f('b.mp4'), start: T0 }], end: T0 + 2000 + 16000, dir: out() },
      { timeoutMs: 60000 });
    assert.equal(r.reencoded, true);
    assert.match(r.file, /meeting\.mp4$/);
    assert.ok(Math.abs(info(r.file).dur - 18) < 0.4);
  });

  test('2 segments (320x180 + 640x360) with gaps: one canvas, black gaps, length = D, continuous audio', async () => {
    const r = await composeMeeting({
      ...base(), segments: [{ file: f('a.mp4'), start: T0 + 1000 }, { file: f('b.mp4'), start: T0 + 4000 }], end: T0 + 7000, dir: out(),
    }, { timeoutMs: 60000 });
    assert.equal(r.reencoded, true);
    const p = info(r.file);
    assert.deepEqual([p.w, p.h, p.vcodec, p.a], [640, 360, 'h264', 1]);
    assert.ok(Math.abs(p.dur - 7) < 0.3, `duration ${p.dur}`);
    for (const t of [0.4, 3.5, 6.5]) assert.ok(yavg(r.file, t) < 20, `black at ${t}s`);
    for (const t of [1.6, 4.6]) assert.ok(yavg(r.file, t) > 40, `picture at ${t}s`);
  });

  test('webm + mp4 mix, and overlapping segments are clipped (no extra length)', async () => {
    const r = await composeMeeting({
      ...base(), segments: [{ file: f('b.mp4'), start: T0 }, { file: f('c.webm'), start: T0 + 1000 }], end: T0 + 3000, dir: out(),
    }, { timeoutMs: 60000 });
    const p = info(r.file);
    assert.ok(Math.abs(p.dur - 3) < 0.3, `duration ${p.dur}`);
    assert.deepEqual([p.w, p.h], [640, 360]);
    assert.ok(yavg(r.file, 2.5) > 40); // the webm part is real picture, not black
  });

  test('timeout kills ffmpeg, throws, and leaves no partial meeting.mp4', async () => {
    const dir = out();
    await assert.rejects(composeMeeting({ ...base(), segments: [{ file: f('a.mp4'), start: T0 }, { file: f('b.mp4'), start: T0 + 3000 }], end: T0 + 5000, dir },
      { timeoutMs: 1 }), /timed out/);
    assert.ok(!existsSync(join(dir, 'meeting.mp4')));
    assert.equal(pending(), 0);
  });

  test('failures throw: unreadable segment, unreadable voice on the compose path', async () => {
    await assert.rejects(composeMeeting({ ...base(), segments: [{ file: f('nope.mp4'), start: T0 }], end: T0 + 2000, dir: out() }), /no readable video/);
    await assert.rejects(composeMeeting({ audio: f('nope.mp3'), audioStart: T0, segments: [{ file: f('a.mp4'), start: T0 }, { file: f('b.mp4'), start: T0 + 2000 }], end: T0 + 4000, dir: out() },
      { timeoutMs: 60000 }), /failed/);
    assert.equal(pending(), 0);
  });

  test('no voice (audio null), fast path: the segment itself, as it is', async () => {
    const dir = out();
    const r = await composeMeeting({ audio: null, audioStart: T0, segments: [{ file: f('b.mp4'), start: T0 + 500 }], end: T0 + 2500, dir });
    assert.deepEqual([r.file, r.reencoded], [join(dir, 'meeting.mp4'), false]);
    assert.equal(vmd5(r.file), vmd5(f('b.mp4')));
    assert.ok(existsSync(f('b.mp4')), 'the segment stays for the caller');
  });

  test('no voice (audio null), compose path: one file, full length, one silent audio track', async () => {
    const r = await composeMeeting({ audio: null, audioStart: T0, segments: [{ file: f('b.mp4'), start: T0 + 1000 }, { file: f('a.mp4'), start: T0 + 4000 }],
      end: T0 + 7000, dir: out() }, { timeoutMs: 60000 });
    assert.equal(r.reencoded, true);
    const p = info(r.file);
    assert.deepEqual([p.w, p.h, p.a], [640, 360, 1]);
    assert.ok(Math.abs(p.dur - 7) < 0.3, `duration ${p.dur}`);
    const vol = spawnSync('ffmpeg', ['-v', 'info', '-ss', '0.5', '-t', '2', '-i', r.file, '-map', '0:a', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    assert.match(vol, /max_volume: -(inf|9\d(\.\d)?) dB/, 'silent before the segment with its own audio');
  });

  test('probe is async: a Promise of the meta, null for unreadable or past its timeout', async () => {
    const pr = probe(f('b.mp4'));
    assert.ok(pr instanceof Promise);
    assert.deepEqual(await pr, { w: 640, h: 360, dur: 2000, hasAudio: false });
    assert.equal(await probe(f('nope.mp4')), null);
    assert.equal(await probe(f('b.mp4'), { timeoutMs: 1 }), null);
  });

  test('queue: two composes run one after the other, pending() counts them', async () => {
    const job = () => composeMeeting({ ...base(), segments: [{ file: f('a.mp4'), start: T0 }, { file: f('b.mp4'), start: T0 + 2000 }], end: T0 + 4000, dir: out() }, { timeoutMs: 60000 });
    const p1 = job(), p2 = job();
    assert.equal(pending(), 2);
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.ok(r1.reencoded && r2.reencoded);
    assert.equal(pending(), 0);
  });
});

describe('planCompose (pure)', () => {
  const seg = (o) => ({ file: '/x/a.mp4', start: 1000, end: 3000, w: 320, h: 180, hasAudio: false, ...o });
  const plan = (segments, o = {}) => planCompose({ segments, audio: '/x/v.mp3', audioStart: 0, end: 7000, output: '/x/meeting.mp4', ...o });

  test('canvas: largest segment, capped at 1920x1080, even dims', () => {
    assert.deepEqual(canvasOf([seg({}), seg({ w: 640, h: 360 })]), { W: 640, H: 360 });
    assert.deepEqual(canvasOf([seg({ w: 3840, h: 2160 })]), { W: 1920, H: 1080 });
    assert.deepEqual(canvasOf([seg({ w: 1281, h: 721 })]), { W: 1280, H: 720 });
  });

  test('snapshot: black head/gap/tail around two clipped segments, voice padded and cut to D', () => {
    const { args, W, H, D } = plan([seg({}), seg({ file: '/x/b.mp4', start: 4000, end: 6000, w: 640, h: 360 })]);
    assert.deepEqual([W, H, D], [640, 360, 7000]);
    const fc = args[args.indexOf('-filter_complex') + 1];
    assert.equal(fc.split(';').length, 8);
    assert.ok(fc.startsWith('color=c=black:s=640x360:r=15:d=1.000'));
    assert.ok(fc.includes('[0:v]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,fps=15,tpad=stop_mode=clone:stop_duration=2.000,trim=start=0.000:duration=2.000,setpts=PTS-STARTPTS[v0]'));
    assert.ok(fc.includes('[g1]') && fc.includes('[tail]'));
    assert.ok(fc.includes('concat=n=5:v=1:a=0[vout]'));
    assert.ok(fc.includes('[2:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=0:7.000[voice]'));
    assert.ok(fc.includes('[voice]amix=inputs=1:duration=first:normalize=0[aout]'));
    assert.equal(args.slice(-21).join(' '), '-c:v libx264 -preset superfast -crf 30 -r 15 -g 150 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart -t 7.000 /x/meeting.mp4');
  });

  test('overlap: the first segment is cut where the next starts; own audio is delayed and mixed', () => {
    const { args } = plan([seg({ start: 0, end: 5000, hasAudio: true }), seg({ file: '/x/b.mp4', start: 2000, end: 4000 })], { end: 4000 });
    const fc = args[args.indexOf('-filter_complex') + 1];
    assert.ok(fc.includes('trim=start=0.000:duration=2.000')); // a: [0, 2s]
    assert.ok(fc.includes('adelay=0:all=1'));
    assert.ok(fc.includes('amix=inputs=2:duration=first:normalize=0'));
    assert.ok(!fc.includes('[tail]'));
  });

  test('audio null: no voice input, a silent track stands in', () => {
    const { args } = plan([seg({})], { audio: null });
    const fc = args[args.indexOf('-filter_complex') + 1];
    assert.equal(args.filter((a) => a === '-i').length, 1, 'only the segment is an input');
    assert.ok(fc.includes('anullsrc=r=48000:cl=stereo,atrim=0:7.000[voice]'));
    assert.ok(fc.includes('[voice]amix=inputs=1:duration=first:normalize=0[aout]'));
    assert.ok(!args.includes(null));
  });

  test('a segment that began before the timeline start is trimmed at its head; empty timeline throws', () => {
    const { args } = plan([seg({ start: -1500, end: 2000 })], { end: 2000 });
    assert.ok(args.join(' ').includes('trim=start=1.500:duration=2.000'));
    assert.throws(() => plan([seg({})], { end: 0 }), /empty timeline/);
  });
});
