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
  for (const k of ['SETTINGS_FILE', 'AUTO_SCREEN', 'SHARE_CARDS', 'AUTO_SCREEN_MIN_MEMBERS', 'SCREEN_MODE', 'AUTO_SCREEN_CHANNEL_IDS', 'PUBLIC_URL']) saved[k] = process.env[k];
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

test('defaults when there is no file (3-way)', async () => {
  const { getSettings } = await load(join(await dir(), 'none.json'));
  const s = getSettings('g1');
  assert.deepEqual(s, {
    shareMode: 'off', shareCards: false, autoVoice: 'off', minMembers: 2, mode: 'screen', area: 'screen', channels: [], roles: [], notifyChannel: null,
    days: [0, 1, 2, 3, 4, 5, 6], from: 0, to: 24, minShareSeconds: 10, maxMinutes: 240,
    anyoneRecords: false, managerRole: null, panels: [],
  });
});

test('env values are the defaults', async () => {
  const { getSettings } = await load(join(await dir(), 'none.json'), {
    AUTO_SCREEN: 'true', AUTO_SCREEN_MIN_MEMBERS: '4', SCREEN_MODE: 'browser', AUTO_SCREEN_CHANNEL_IDS: '1, 2 ,,3',
  });
  const s = getSettings('g1');
  assert.equal(s.shareCards, true); // AUTO_SCREEN is the legacy alias
  assert.equal(s.minMembers, 4);
  assert.equal(s.mode, 'screen', 'browser needs PUBLIC_URL: a bot without it has only the host Mac');
  assert.deepEqual(s.channels, ['1', '2', '3']);
  const bad = await load(join(await dir(), 'none.json'), { SCREEN_MODE: 'nonsense', AUTO_SCREEN_MIN_MEMBERS: 'x' });
  assert.equal(bad.getSettings('g').mode, 'screen');
  const win = await load(join(await dir(), 'none.json'), { SCREEN_MODE: 'window' });
  assert.equal(win.getSettings('g').mode, 'window');
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

test("legacy autoVoice 'screen' and 'members' are normalised to 'off'", async () => {
  const d = await dir();
  const file = join(d, 's.json');
  await writeFile(file, JSON.stringify({ g1: { autoVoice: 'screen' }, g2: { autoVoice: 'members' } }));
  const { getSettings } = await load(file);
  assert.equal(getSettings('g1').autoVoice, 'off');
  assert.equal(getSettings('g2').autoVoice, 'off');
});

test('shareCards migration matrix (press-to-start)', async () => {
  const d = await dir();
  const file = join(d, 's.json');
  const legacy = {
    autoOn: { autoScreen: true },
    autoOnVoiceScreen: { autoScreen: true, autoVoice: 'screen' },
    members: { autoVoice: 'members' },
    membersAutoOff: { autoScreen: false, autoVoice: 'members' },
    autoOff: { autoScreen: false },
    nothing: { minMembers: 3 },
    explicitOff: { shareCards: false, autoScreen: true, autoVoice: 'members' }, // an explicit new value wins
    explicitOn: { shareCards: true, autoScreen: false },
  };
  const body = JSON.stringify(legacy, null, 2);
  await writeFile(file, body);
  for (const [env, want] of [[{}, { nothing: false, autoOff: false }], [{ SHARE_CARDS: 'true' }, { nothing: true, autoOff: false }], [{ AUTO_SCREEN: 'true' }, { nothing: true, autoOff: false }]]) {
    const { getSettings } = await load(file, env);
    const on = (k) => getSettings(k).shareCards;
    assert.equal(on('autoOn'), true);
    assert.equal(on('autoOnVoiceScreen'), true);
    assert.equal(on('members'), true);
    assert.equal(on('membersAutoOff'), true);
    assert.equal(on('autoOff'), want.autoOff);
    assert.equal(on('nothing'), want.nothing); // nothing saved = env default
    assert.equal(on('explicitOff'), false);
    assert.equal(on('explicitOn'), true);
    assert.equal(on('unknownGuild'), want.nothing);
    for (const k of Object.keys(legacy)) {
      assert.equal(getSettings(k).autoVoice, 'off', k);
      assert.ok(!('autoScreen' in getSettings(k)), k);
    }
  }
  assert.equal(await readFile(file, 'utf8'), body, 'load must not rewrite the file');
});

test('SHARE_CARDS beats AUTO_SCREEN as the env default', async () => {
  const { getSettings } = await load(join(await dir(), 'none.json'), { SHARE_CARDS: 'false', AUTO_SCREEN: 'true' });
  assert.equal(getSettings('g').shareCards, false);
});

test('saving a new value keeps the legacy keys in the file and shareCards wins afterwards', async () => {
  const d = await dir();
  const file = join(d, 's.json');
  await writeFile(file, JSON.stringify({ g1: { autoScreen: true, autoVoice: 'members' } }));
  const { getSettings, updateSettings } = await load(file);
  assert.equal(getSettings('g1').shareCards, true);
  await updateSettings('g1', { shareCards: false });
  assert.equal(getSettings('g1').shareCards, false);
  const g1 = JSON.parse(await readFile(file, 'utf8')).g1;
  assert.deepEqual(g1, { autoScreen: true, autoVoice: 'members', shareCards: false });
  const again = await load(file);
  assert.equal(again.getSettings('g1').shareCards, false);
});

test('shareMode migration matrix and env defaults (3-way)', async () => {
  const d = await dir();
  const file = join(d, 's.json');
  const legacy = {
    autoOn: { autoScreen: true },                                      // full auto before press-to-start -> auto
    autoOnVoiceScreen: { autoScreen: true, autoVoice: 'screen' },
    members: { autoVoice: 'members' },                                 // auto voice for members -> card
    membersAutoOff: { autoScreen: false, autoVoice: 'members' },
    autoOff: { autoScreen: false },                                    // explicit old off beats the env
    nothing: { minMembers: 3 },                                        // env default
    boolOff: { shareCards: false, autoScreen: true },                  // the A5 boolean beats the legacy keys
    boolOn: { shareCards: true, autoScreen: true },
    modeAuto: { shareMode: 'auto', shareCards: false },                // shareMode beats everything
    modeOff: { shareMode: 'off', shareCards: true, autoScreen: true },
    modeBogus: { shareMode: 'loud', autoScreen: true },                // unknown value: ignored
  };
  const body = JSON.stringify(legacy, null, 2);
  await writeFile(file, body);
  const fixed = { autoOn: 'auto', autoOnVoiceScreen: 'auto', members: 'card', membersAutoOff: 'card', autoOff: 'off',
    boolOff: 'off', boolOn: 'card', modeAuto: 'auto', modeOff: 'off', modeBogus: 'auto' };
  const envs = [[{}, 'off'], [{ SHARE_CARDS: 'true' }, 'card'], [{ SHARE_CARDS: 'card' }, 'card'], [{ SHARE_CARDS: 'auto' }, 'auto'],
    [{ SHARE_CARDS: 'off' }, 'off'], [{ AUTO_SCREEN: 'true' }, 'auto'], [{ AUTO_SCREEN: 'false' }, 'off'],
    [{ SHARE_CARDS: 'false', AUTO_SCREEN: 'true' }, 'off'], [{ SHARE_CARDS: 'nonsense' }, 'off']];
  for (const [env, def] of envs) {
    const { getSettings } = await load(file, env);
    const what = JSON.stringify(env);
    for (const [k, want] of Object.entries(fixed)) {
      assert.equal(getSettings(k).shareMode, want, `${k} ${what}`);
      assert.equal(getSettings(k).shareCards, want !== 'off', `${k} shareCards ${what}`);
    }
    assert.equal(getSettings('nothing').shareMode, def, `nothing ${what}`);
    assert.equal(getSettings('unknownGuild').shareMode, def, `unknown ${what}`);
  }
  assert.equal(await readFile(file, 'utf8'), body, 'load must not rewrite the file');
});

test('saving shareMode keeps the legacy keys and wins afterwards (3-way)', async () => {
  const d = await dir();
  const file = join(d, 's.json');
  await writeFile(file, JSON.stringify({ g1: { autoScreen: true, shareCards: true } }));
  const { getSettings, updateSettings } = await load(file);
  assert.equal(getSettings('g1').shareMode, 'card');
  await updateSettings('g1', { shareMode: 'auto' });
  assert.equal(getSettings('g1').shareMode, 'auto');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).g1, { autoScreen: true, shareCards: true, shareMode: 'auto' });
  assert.equal((await load(file)).getSettings('g1').shareMode, 'auto');
});

test('anyoneRecords defaults to false', async () => {
  const { getSettings } = await load(join(await dir(), 'none.json'));
  assert.equal(getSettings('g').anyoneRecords, false);
});

test('with PUBLIC_URL: mode is agent (default) or browser; legacy screen/window and env SCREEN_MODE read as agent, file untouched', async () => {
  const pub = { PUBLIC_URL: 'https://rec.example.com' };
  const fresh = await load(join(await dir(), 'none.json'), pub);
  assert.equal(fresh.getSettings('new').mode, 'agent');
  for (const [env, want] of [['screen', 'agent'], ['window', 'agent'], ['browser', 'browser'], ['agent', 'agent'], ['junk', 'agent']]) {
    const m = await load(join(await dir(), 'none.json'), { ...pub, SCREEN_MODE: env });
    assert.equal(m.getSettings('g').mode, want, `SCREEN_MODE=${env}`);
  }
  const d = await dir(), file = join(d, 's.json');
  const raw = JSON.stringify({ a: { mode: 'screen' }, b: { mode: 'window' }, c: { mode: 'browser' }, d: { mode: 'agent' } });
  await writeFile(file, raw);
  const { getSettings } = await load(file, pub);
  assert.deepEqual(['a', 'b', 'c', 'd'].map((g) => getSettings(g).mode), ['agent', 'agent', 'browser', 'agent']);
  assert.equal(await readFile(file, 'utf8'), raw, 'read-time only');
});

test('capture area: default screen; only discord or screen are ever read', async () => {
  const d = await dir(), file = join(d, 's.json');
  await writeFile(file, JSON.stringify({ a: { area: 'discord' }, b: { area: 'window' }, c: {} }));
  const { getSettings } = await load(file);
  assert.deepEqual(['a', 'b', 'c', 'new'].map((g) => getSettings(g).area), ['discord', 'screen', 'screen', 'screen']);
});

test('env CAPTURE_AREA is the default area; a saved area still wins', async () => {
  const d = await dir(), file = join(d, 's.json');
  await writeFile(file, JSON.stringify({ a: { area: 'screen' } }));
  const m = await load(file, { CAPTURE_AREA: 'discord' });
  assert.deepEqual(['a', 'new'].map((g) => m.getSettings(g).area), ['screen', 'discord']);
  assert.equal((await load(join(d, 'n.json'), { CAPTURE_AREA: 'bogus' })).getSettings('x').area, 'screen');
});
