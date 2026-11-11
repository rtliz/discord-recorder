import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// settings.js reads env + file at import time, so each scenario imports a fresh copy via a query string
let n = 0;
const load = async (file, env = {}) => {
  const saved = {};
  for (const k of ['SETTINGS_FILE', 'AUTO_SCREEN', 'AUTO_SCREEN_MIN_MEMBERS', 'SCREEN_MODE', 'AUTO_SCREEN_CHANNEL_IDS']) saved[k] = process.env[k];
  for (const k of Object.keys(saved)) delete process.env[k];
  Object.assign(process.env, { SETTINGS_FILE: file }, env);
  try {
    return await import(`../src/settings.js?t=${++n}`);
  } finally {
    for (const [k, v] of Object.entries(saved)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
  }
};
const dir = () => mkdtemp(join(tmpdir(), 'dr-settings-'));
const origErr = console.error;
const quiet = () => { console.error = () => {}; };
const loud = () => { console.error = origErr; };

test('defaults when there is no file', async () => {
  const { getSettings } = await load(join(await dir(), 'none.json'));
  const s = getSettings('g1');
  assert.deepEqual(s, {
    autoScreen: false, autoVoice: 'off', minMembers: 2, mode: 'screen', channels: [], roles: [], notifyChannel: null,
    days: [0, 1, 2, 3, 4, 5, 6], from: 0, to: 24, minShareSeconds: 10, maxMinutes: 240,
    anyoneRecords: false, managerRole: null, panels: [],
  });
});

test('env values are the defaults', async () => {
  const { getSettings } = await load(join(await dir(), 'none.json'), {
    AUTO_SCREEN: 'true', AUTO_SCREEN_MIN_MEMBERS: '4', SCREEN_MODE: 'browser', AUTO_SCREEN_CHANNEL_IDS: '1, 2 ,,3',
  });
  const s = getSettings('g1');
  assert.equal(s.autoScreen, true);
  assert.equal(s.minMembers, 4);
  assert.equal(s.mode, 'browser');
  assert.deepEqual(s.channels, ['1', '2', '3']);
  const bad = await load(join(await dir(), 'none.json'), { SCREEN_MODE: 'nonsense', AUTO_SCREEN_MIN_MEMBERS: 'x' });
  assert.equal(bad.getSettings('g').mode, 'screen');
  assert.equal(bad.getSettings('g').minMembers, 2);
});

test('saved values override defaults per guild only', async () => {
  const d = await dir();
  const file = join(d, 's.json');
  await writeFile(file, JSON.stringify({ g1: { minMembers: 5, autoScreen: true } }));
  const { getSettings } = await load(file);
  assert.equal(getSettings('g1').minMembers, 5);
  assert.equal(getSettings('g1').maxMinutes, 240); // untouched keys keep defaults
  assert.equal(getSettings('g2').minMembers, 2);
});

test('corrupt file is moved aside and defaults are used', async () => {
  const d = await dir();
  const file = join(d, 's.json');
  await writeFile(file, '{ not json');
  quiet();
  const { getSettings, updateSettings } = await load(file).finally(loud);
  assert.equal(getSettings('g1').minMembers, 2);
  const files = await readdir(d);
  assert.ok(files.some((f) => f.startsWith('s.json.corrupt-')), files.join());
  assert.ok(!files.includes('s.json'));
  assert.equal(await updateSettings('g1', { minMembers: 3 }), true); // still writable afterwards
  assert.equal(JSON.parse(await readFile(file, 'utf8')).g1.minMembers, 3);
});

test('non-object JSON is treated as corrupt', async () => {
  for (const body of ['[1,2]', 'null', '42', '"x"']) {
    const d = await dir();
    const file = join(d, 's.json');
    await writeFile(file, body);
    quiet();
    const { getSettings } = await load(file).finally(loud);
    assert.equal(getSettings('g').minMembers, 2, body);
    assert.ok((await readdir(d)).some((f) => f.includes('.corrupt-')), body);
  }
});

test('updateSettings applies in memory first, then on disk', async () => {
  const d = await dir();
  const file = join(d, 'sub', 's.json'); // dir is created on demand
  const { getSettings, updateSettings } = await load(file);
  const p = updateSettings('g1', { minMembers: 4 });
  assert.equal(getSettings('g1').minMembers, 4); // before the promise settles
  await assert.rejects(readFile(file, 'utf8'), { code: 'ENOENT' });
  assert.equal(await p, true);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).g1.minMembers, 4);
  await updateSettings('g1', { from: 9 }); // patches merge
  const g1 = JSON.parse(await readFile(file, 'utf8')).g1;
  assert.deepEqual([g1.minMembers, g1.from], [4, 9]);
  assert.ok(!(await readdir(join(d, 'sub'))).includes('s.json.tmp'));
});

test('20 parallel writes are serialized: last wins, file is valid JSON', async () => {
  const d = await dir();
  const file = join(d, 's.json');
  const { getSettings, updateSettings } = await load(file);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => updateSettings('g1', { maxMinutes: i + 1 })));
  assert.ok(results.every((r) => r === true));
  assert.equal(getSettings('g1').maxMinutes, 20);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).g1.maxMinutes, 20);
});

test('write failure resolves false and keeps the in-memory value', async () => {
  const d = await dir();
  const { getSettings, updateSettings } = await load(join(d, 'blocker', 's.json'));
  await writeFile(join(d, 'blocker'), 'i am a file'); // the parent dir becomes a file after load, so mkdir/open fail
  quiet();
  const ok = await updateSettings('g1', { minMembers: 3 }).finally(loud);
  assert.equal(ok, false);
  assert.equal(getSettings('g1').minMembers, 3);
  quiet();
  assert.equal(await updateSettings('g1', { minMembers: 4 }).finally(loud), false); // queue is not poisoned: next call still resolves
});

test("legacy autoVoice 'screen' is normalised to 'off'", async () => {
  const d = await dir();
  const file = join(d, 's.json');
  await writeFile(file, JSON.stringify({ g1: { autoVoice: 'screen' }, g2: { autoVoice: 'members' } }));
  const { getSettings } = await load(file);
  assert.equal(getSettings('g1').autoVoice, 'off');
  assert.equal(getSettings('g2').autoVoice, 'members');
});

test('anyoneRecords defaults to false', async () => {
  const { getSettings } = await load(join(await dir(), 'none.json'));
  assert.equal(getSettings('g').anyoneRecords, false);
});
