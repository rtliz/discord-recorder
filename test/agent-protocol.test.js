import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as P from '../src/agent/protocol.js';
import { AgentHub, hub, T, capToken } from '../src/agent-hub.js';
import { BrowserCapture, checkToken } from '../src/browser-capture.js';

const src = (f) => readFile(new URL(`../src/${f}`, import.meta.url), 'utf8');

test('protocol constants (plan §5.1)', () => {
  assert.equal(P.PROTOCOL, 1);
  assert.deepEqual([P.POLL_MS, P.GONE_MS, P.ACK_MS, P.CHUNK_MS], [25000, 40000, 15000, 3000]);
  assert.equal(P.ASK_MS, undefined, 'ask-first is gone');
  assert.deepEqual(P.AREA, { screen: 'screen', discord: 'discord' });
  assert.ok(P.GONE_MS > P.POLL_MS, 'a healthy poll loop must never look offline');
  assert.equal(P.AGENT_MIME, 'video/mp4;codecs=avc1');
  assert.deepEqual(P.CMD, { start: 'start', stop: 'stop', replaced: 'replaced', revoked: 'revoked' });
  assert.deepEqual(P.STOP_REASON, { local: 'agent', quit: 'unload' });
  assert.deepEqual(Object.values(P.ACK_ERROR).sort(), ['busy', 'declined', 'display', 'ffmpeg', 'offline', 'timeout']);
});

test('protocol.js has no imports (loadable by the agent and the bot alike)', async () => {
  assert.doesNotMatch(await src('agent/protocol.js'), /\bimport\b|\brequire\(/);
});

test('agent-hub.js imports only node: built-ins and ./agent/*', async () => {
  const specs = [...(await src('agent-hub.js')).matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  for (const s of specs) assert.match(s, /^(node:|\.\/agent\/)/, s);
});

test('hub timings default to the protocol values (no ask budget)', () => {
  assert.deepEqual({ poll: T.poll, gone: T.gone, ack: T.ack, ask: T.ask }, { poll: 25000, gone: 40000, ack: 15000, ask: undefined });
});

test('AgentHub skeleton exposes the §5.3 API', () => {
  assert.ok(hub instanceof AgentHub);
  assert.equal(hub.onChange, null);
  assert.equal(new AgentHub({ file: '/x/agents.json' }).file, '/x/agents.json');
  assert.equal(new AgentHub().file, process.env.AGENTS_FILE || 'data/agents.json');
  for (const m of ['load', 'newPairing', 'devices', 'allDevices', 'revoke', 'revokeDevice', 'online', 'start', 'stop', 'handle', '_reset'])
    assert.equal(typeof AgentHub.prototype[m], 'function', m);
});

test('capToken gives the token checkToken accepts', () => {
  const cap = new BrowserCapture('recordings/x', { guildId: 'g1', owner: 'u1', offerMs: 0 });
  try {
    const tok = capToken(cap, 60000);
    assert.ok(tok.startsWith(`${cap.capId}.`));
    assert.doesNotMatch(tok, /\//);
    assert.equal(checkToken(tok), cap);
  } finally {
    cap.exit('test', false);
  }
});
