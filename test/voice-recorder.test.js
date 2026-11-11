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
