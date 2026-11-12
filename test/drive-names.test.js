import './helpers/env.js';
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadBot, waitFor, scene, resetFakes } from './helpers/bot.js';
import { fakeInteraction } from './helpers/fakes.js';

// Drive layout: <root>/<server>/<time> <channel>[ (เสียง)].ext, and the folder resolver against a fake drive client

const { bot, uploads } = await loadBot({ SCREEN_ENABLED: 'false', PUBLIC_URL: 'http://localhost:1' });
const { voice } = bot;
const { folderResolver, safeName } = await import('../src/drive.js'); // after loadBot: it reads the Drive env on import
const STAMP = /^\d{4}-\d\d-\d\d \d\d\.\d\d /;
const press = (s, customId, extra) => bot.client.listeners('interactionCreate')[0](fakeInteraction({ guild: s.guild, member: s.member, channel: s.text, customId, ...extra }));

beforeEach(() => { bot._reset(); bot.client.guilds.cache.clear(); resetFakes(); uploads.length = 0; uploads.calls.length = 0; });
after(() => bot._reset());

describe('upload names', () => {
  test('a voice-only 🎙️ goes to [server] as "<time> <channel> (เสียง).mp3"', async () => {
    const s = scene(bot);
    await press(s, 'record:start');
    const v = voice.get(s.guild.id);
    await v.cardQ;
    await press(s, `record:stop:${v.began}`, { message: v.card });
    await waitFor(() => uploads.calls.length === 1, 'uploaded');
    const { name, folders } = uploads.calls[0];
    assert.deepEqual(folders, ['Test Server']);
    assert.match(name, STAMP);
    assert.ok(name.endsWith(' Meeting (เสียง).mp3'), name);
  });

  test('a "/" and a quote in the server and channel names are sanitized, not nested', async () => {
    const s = scene(bot);
    s.guild.name = "A/B's server";
    s.room.name = "R/D 'x'";
    await press(s, 'record:start');
    const v = voice.get(s.guild.id);
    await v.cardQ;
    await press(s, `record:stop:${v.began}`, { message: v.card });
    await waitFor(() => uploads.calls.length === 1, 'uploaded');
    const { name, folders } = uploads.calls[0];
    assert.deepEqual(folders, ["A B's server"]);
    assert.ok(name.endsWith(" R D 'x' (เสียง).mp3"), name);
    assert.ok(!name.includes('/'));
  });
});

describe('safeName', () => {
  test('trims, replaces "/" and control chars, caps, falls back', () => {
    assert.equal(safeName('  a/b\u0000c  '), 'a b c');
    assert.equal(safeName('x'.repeat(300)).length, 100);
    assert.equal(safeName('  ', 'id1'), 'id1');
    assert.equal(safeName(undefined, 7), '7');
  });
});

// a fake drive client: folders live in a Map, files.list parses the query it is given
function fakeDrive({ existing = [], failList = false } = {}) {
  const folders = existing.map(([name, parent], k) => ({ id: `e${k}`, name, parent }));
  const calls = { list: [], create: [] };
  return {
    folders, calls,
    files: {
      async list({ q, ...rest }) {
        calls.list.push({ q, ...rest });
        if (failList) throw new Error('boom');
        await Promise.resolve();
        const m = q.match(/^name='((?:[^'\\]|\\.)*)' and '([^']+)' in parents/);
        const name = m[1].replace(/\\(.)/g, '$1');
        return { data: { files: folders.filter((f) => f.name === name && f.parent === m[2]).map(({ id }) => ({ id })) } };
      },
      async create({ requestBody }) {
        calls.create.push(requestBody);
        await Promise.resolve();
        const f = { id: `n${calls.create.length}`, name: requestBody.name, parent: requestBody.parents[0] };
        folders.push(f);
        return { data: { id: f.id } };
      },
    },
  };
}

describe('folderResolver', () => {
  test('finds an existing folder, creates a missing one, passes the shared-drive flags and the escaped query', async () => {
    const d = fakeDrive({ existing: [['Srv', 'ROOT']] });
    const resolve = folderResolver(d, 'ROOT');
    assert.equal(await resolve(['Srv']), 'e0');
    assert.equal(d.calls.create.length, 0);
    assert.equal(await resolve(["it's a\\b"]), 'n1');
    assert.deepEqual(d.calls.create[0], { name: "it's a\\b", mimeType: 'application/vnd.google-apps.folder', parents: ['ROOT'] });
    assert.equal(d.calls.list[1].q, "name='it\\'s a\\\\b' and 'ROOT' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false");
    assert.equal(d.calls.list[0].supportsAllDrives, true);
    assert.equal(d.calls.list[0].includeItemsFromAllDrives, true);
  });

  test('caches by path and dedupes concurrent creates', async () => {
    const d = fakeDrive();
    const resolve = folderResolver(d, 'ROOT');
    const ids = await Promise.all([resolve(['Srv']), resolve(['Srv']), resolve(['Srv'])]);
    assert.deepEqual(ids, ['n1', 'n1', 'n1']);
    assert.equal(d.calls.create.length, 1);
    await resolve(['Srv']);
    assert.equal(d.calls.list.length, 1, 'cached: no more lookups');
    assert.deepEqual(await resolve([]), 'ROOT');
    assert.equal(await resolve(['Srv', 'Sub']), 'n2', 'nested path reuses the cached parent');
    assert.equal(d.calls.list.length, 2);
  });

  test('a failure answers the root, logs it and is retried next time', async () => {
    const d = fakeDrive({ failList: true });
    const errs = [], orig = console.error;
    console.error = (...a) => errs.push(a);
    try {
      const resolve = folderResolver(d, 'ROOT');
      assert.equal(await resolve(['Srv']), 'ROOT');
      assert.equal(errs.length, 1);
      assert.equal(await resolve(['Srv']), 'ROOT');
      assert.equal(d.calls.list.length, 2, 'the failure was not cached');
    } finally { console.error = orig; }
  });
});
