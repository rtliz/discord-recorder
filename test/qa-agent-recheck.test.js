import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { loadConfig, runAgent, saveConfig } from '../src/agent/main.js';

// D3 edge: a config that exists but holds no credentials (revoked: deviceId/secret deleted) + empty code at the prompt
test('revoked config (no credentials), empty code at the prompt: exits 2, does not run unpaired', async () => {
  const home = mkdtempSync(join(tmpdir(), 'qa-agent-'));
  saveConfig(home, { server: 'http://localhost:1', consent: true });
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  const stdout = { isTTY: false, write(t) { stdout.out += t; return true; }, out: '' };
  setTimeout(() => stdin.write('\n'), 20);
  const a = await runAgent({ home, stdout, stdin, env: {}, notifyFn() {}, argv: [], listDisplaysFn: async () => [] });
  const r = await Promise.race([a.done, new Promise((r) => setTimeout(() => r('STILL RUNNING'), 1500))]);
  await a.shutdown?.();
  assert.equal(r, 2, stdout.out);
});
