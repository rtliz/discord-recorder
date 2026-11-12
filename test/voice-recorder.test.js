import './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { VoiceConnectionStatus } from '@discordjs/voice';
import { VoiceRecorder } from '../src/voice-recorder.js';

// the parts of VoiceRecorder that don't need a real voice connection

const fakeConnection = (status = VoiceConnectionStatus.Ready) => Object.assign(new EventEmitter(), {
  state: { status }, destroyed: 0,
  destroy() {
    if (this.state.status === VoiceConnectionStatus.Destroyed) throw new Error('already destroyed');
    this.destroyed++;
    this.setState(VoiceConnectionStatus.Destroyed);
  },
  // like VoiceConnection: 'stateChange' plus an event named after the new status (entersState waits on that)
  setState(status) { const old = this.state; this.state = { status }; this.emit('stateChange', old, this.state); this.emit(status, old, this.state); },
});

test('kind is voice', () => assert.equal(new VoiceRecorder({}, 'x').kind, 'voice'));

test('stop() after the connection is already gone does not throw', async () => {
  const rec = new VoiceRecorder({}, 'x');
  rec.connection = fakeConnection(VoiceConnectionStatus.Destroyed);
  assert.equal(await rec.stop(), null); // nobody spoke
});

test('disconnected and not reconnecting → onGone once', async () => {
  VoiceRecorder.RECONNECT_MS = 30;
  const rec = new VoiceRecorder({}, 'x');
  const conn = fakeConnection();
  let gone = 0;
  rec.onGone = () => gone++;
  rec.watch(conn);
  rec.connection = conn;
  conn.setState(VoiceConnectionStatus.Disconnected);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(gone, 1);
  assert.ok(rec.gone);
  assert.equal(await rec.stop(), null, 'stop still works');
});

test('a disconnect that reconnects is not gone', async () => {
  VoiceRecorder.RECONNECT_MS = 50;
  const rec = new VoiceRecorder({}, 'x');
  const conn = fakeConnection();
  let gone = 0;
  rec.onGone = () => gone++;
  rec.watch(conn);
  conn.setState(VoiceConnectionStatus.Disconnected);
  conn.setState(VoiceConnectionStatus.Signalling);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(gone, 0);
});

test('a requested stop is not reported as gone', async () => {
  VoiceRecorder.RECONNECT_MS = 20;
  const rec = new VoiceRecorder({}, 'x');
  const conn = fakeConnection();
  let gone = 0;
  rec.onGone = () => gone++;
  rec.watch(conn);
  rec.connection = conn;
  await rec.stop();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(gone, 0);
});

// a session's room audio: joined (start({record:false})) but silent until begin(at), whose clock is the video's
test('begin(at): nothing subscribed before it; sets startedAt and listens once; never after a stop', async () => {
  const speaking = Object.assign(new EventEmitter(), { users: new Map() });
  const rec = new VoiceRecorder({}, 'x');
  rec.connection = Object.assign(fakeConnection(), { receiver: { speaking } });
  assert.equal(rec.recording, false);
  assert.equal(speaking.listenerCount('start'), 0, 'joined but not listening');
  rec.begin(1234);
  assert.equal(rec.recording, true);
  assert.equal(rec.startedAt, 1234);
  assert.equal(speaking.listenerCount('start'), 1);
  rec.begin(9999); // idempotent: the clock stays the first video's
  assert.equal(rec.startedAt, 1234);
  assert.equal(speaking.listenerCount('start'), 1);
  assert.equal(await rec.stop(), null, 'nobody spoke: no voice.mp3');

  const late = new VoiceRecorder({}, 'x');
  late.connection = Object.assign(fakeConnection(), { receiver: { speaking: Object.assign(new EventEmitter(), { users: new Map() }) } });
  await late.stop();
  late.begin();
  assert.equal(late.recording, false, 'a stopped recorder never begins');
});
