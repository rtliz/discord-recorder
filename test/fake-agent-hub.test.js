import './helpers/env.js';
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ACK_ERROR } from '../src/agent/protocol.js';
import { FakeAgentHub, fakeComposeMeeting } from './helpers/fakes.js';

// self-test of the test helper: it must behave like AgentHub from index.js's point of view
process.env.PUBLIC_URL = 'http://localhost:1';
const { BrowserCapture, T } = await import('../src/browser-capture.js');
const { AgentHub } = await import('../src/agent-hub.js');
Object.assign(T, { drainMax: 50, silent: 50, poll: 5, beat: 20 });

const hub = new FakeAgentHub();
const cap = (owner = 'u1') => new BrowserCapture(join(process.cwd(), 'recordings', `c-${Math.random()}`), { guildId: 'g', owner, offerMs: 0, via: 'agent' });
beforeEach(() => hub._reset());

describe('FakeAgentHub', () => {
  test('mirrors the public AgentHub API', () => {
    const real = new AgentHub({ file: join(process.cwd(), 'x.json') });
    for (const m of ['load', 'newPairing', 'devices', 'allDevices', 'revoke', 'revokeDevice', 'online', 'start', 'stop', '_reset']) {
      assert.equal(typeof hub[m], 'function', m);
      assert.equal(typeof real[m], 'function', m);
    }
    assert.equal(hub.onChange, null);
  });

  test('load is a no-op; online / onChange only on transitions; offline by default', async () => {
    await hub.load();
    const seen = [];
    hub.onChange = (u, on) => seen.push([u, on]);
    assert.equal(hub.online('u1'), null);
    hub.setOnline('u1', { askFirst: true, name: 'Mac' });
    hub.setOnline('u1', { askFirst: false }); // still online: no event
    assert.deepEqual(hub.online('u1'), { deviceId: hub.devices('u1')[0].deviceId, name: 'Mac', askFirst: false });
    hub.setOnline('u1', false);
    hub.setOnline('u1', false);
    assert.deepEqual(seen, [['u1', true], ['u1', false]]);
    hub.onChange = null;
  });

  test('pairing replaces the previous one; devices / revoke', () => {
    const a = hub.newPairing('u1', 'g', 'Tag');
    const b = hub.newPairing('u1', 'g');
    assert.notEqual(a.token, b.token);
    assert.match(b.code, /^\d{6}$/);
    assert.equal(hub.pairings.length, 1);
    hub.setOnline('u1');
    const [d] = hub.devices('u1');
    assert.equal(d.active, true);
    assert.equal(hub.revoke('u2', d.deviceId), 0); // not theirs
    assert.equal(hub.revoke('u1', d.deviceId), 1);
    assert.equal(hub.online('u1'), null); // revoking the active device takes it offline
    assert.deepEqual(hub.devices('u1'), []);
  });

  test('start: offline answers offline, no command', async () => {
    assert.deepEqual(await hub.start('u1', cap(), { maxMs: 1, room: 'r', by: 'b' }), { ok: false, error: ACK_ERROR.offline });
  });

  test('start ok: real claim, onLive fires before the ack, liveAt set', async () => {
    hub.setOnline('u1');
    const c = cap();
    let live = false;
    c.onLive = () => { live = true; };
    const r = await hub.start('u1', c, { maxMs: 5, room: 'Meeting', by: 'u1' });
    assert.deepEqual(r, { ok: true });
    assert.ok(live && c.liveAt && c.state === 'live' && c.via === 'agent');
    assert.equal(hub.calls[0].room, 'Meeting');
    assert.equal(hub.capture('u1'), c);
  });

  for (const error of ['declined', 'timeout', 'busy', 'ffmpeg', 'display']) {
    test(`start acks ${error}: not live, capture still offered`, async () => {
      hub.setOnline('u1');
      hub.plan.push(ACK_ERROR[error]);
      const c = cap();
      assert.deepEqual(await hub.start('u1', c), { ok: false, error });
      assert.equal(c.state, 'offered');
      assert.equal(hub.capture('u1'), null);
      await c.stop();
    });
  }

  test('hold mode: the test decides when the ack comes', async () => {
    hub.setOnline('u1');
    hub.startMode = 'hold';
    const c = cap();
    const p = hub.start('u1', c);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(c.state, 'offered');
    assert.equal(hub.pending.length, 1);
    hub.ack('ok');
    assert.deepEqual(await p, { ok: true });
    assert.equal(c.state, 'live');
    assert.throws(() => hub.ack(), /no start/);
  });

  test('a second start while the device records is busy; free again after the first ends', async () => {
    hub.setOnline('u1');
    const a = cap();
    await hub.start('u1', a);
    assert.deepEqual(await hub.start('u1', cap()), { ok: false, error: ACK_ERROR.busy });
    a.exit('x');
    await a.exited;
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(await hub.start('u1', cap()), { ok: true });
  });

  test('upload moves the real chunk counters', async () => {
    hub.setOnline('u1');
    const c = cap();
    await hub.start('u1', c);
    await hub.upload('u1', 3, 10);
    assert.deepEqual([c.maxSeq, c.bytes, c.have.size], [2, 30, 3]);
  });

  test('bot stop: hub.stop is recorded, the agent obeys, capture.stop() returns a file fast', async () => {
    hub.setOnline('u1');
    const c = cap();
    await hub.start('u1', c);
    const t0 = Date.now();
    const p = c.stop();
    assert.equal(hub.stop('u1', c.capId), true);
    const f = await p;
    assert.ok(existsSync(f) && f.endsWith('screen.mp4'));
    assert.ok(Date.now() - t0 < 500);
    assert.deepEqual(hub.stops, [{ userId: 'u1', capId: c.capId }]);
  });

  test('hub.stop before capture.stop(): the agent still ends it (reason agent, local)', async () => {
    hub.setOnline('u1');
    const c = cap();
    await hub.start('u1', c);
    hub.stop('u1', c.capId);
    await c.exited;
    assert.equal(c.exitKind, 'local');
    assert.match(c.exitReason, /ตัวอัด/);
  });

  test('localStop, quit and drop give exitKind local / gone / gone', async () => {
    const run = async (act) => {
      hub.setOnline('u1');
      const c = cap();
      await hub.start('u1', c);
      act();
      await c.exited;
      const r = [c.exitKind, c.exitReason];
      await c.stop();
      hub.setOnline('u1', false);
      return r;
    };
    assert.deepEqual(await run(() => hub.localStop('u1')), ['local', '⏹️ เจ้าของเครื่องกดหยุดที่ตัวอัด']);
    assert.deepEqual(await run(() => hub.quit('u1')), ['gone', '⚠️ ตัวอัดถูกปิด']);
    assert.deepEqual(await run(() => hub.drop('u1')), ['gone', '⚠️ ตัวอัดหลุด (ปิดเครื่องหรือเน็ตหลุด)']);
  });

  test('drop goes offline (onChange) unless told not to', async () => {
    const seen = [];
    hub.onChange = (u, on) => seen.push(on);
    hub.setOnline('u1');
    await hub.start('u1', cap());
    hub.drop('u1', { offline: false });
    assert.ok(hub.online('u1'));
    hub.drop('u1');
    assert.equal(hub.online('u1'), null);
    assert.deepEqual(seen, [true, false]);
    hub.onChange = null;
  });

  test('_reset settles held starts as offline and clears state', async () => {
    hub.setOnline('u1');
    hub.startMode = 'hold';
    const p = hub.start('u1', cap());
    hub._reset();
    assert.deepEqual(await p, { ok: false, error: ACK_ERROR.offline });
    assert.equal(hub.online('u1'), null);
    assert.equal(hub.startMode, 'ok');
  });
});

describe('fakeComposeMeeting', () => {
  test('writes dir/meeting.mp4, returns {file, reencoded}; knobs', async () => {
    const f = fakeComposeMeeting();
    const dir = join(process.cwd(), 'recordings', 'cm');
    const r1 = await f({ segments: [{ file: 'a', start: 1 }], dir });
    assert.deepEqual(r1, { file: join(dir, 'meeting.mp4'), reencoded: false });
    assert.ok(existsSync(r1.file));
    assert.equal((await f({ segments: [{}, {}], dir })).reencoded, true);
    f.reencoded = false;
    assert.equal((await f({ segments: [{}, {}], dir })).reencoded, false);
    f.fails = new Error('boom');
    await assert.rejects(f({ segments: [], dir }), /boom/);
    assert.equal(f.calls.length, 4);
  });
});
