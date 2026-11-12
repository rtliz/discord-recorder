import { tmp } from './helpers/env.js';
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadBot, waitFor, sleep, scene, resetFakes } from './helpers/bot.js';
import { fakeMember, moveMember, FakeVoiceRecorder } from './helpers/fakes.js';
import { startSession } from './helpers/session.js';
import { updateSettings } from '../src/settings.js';

// DELETE_AFTER_UPLOAD is read at module load, hence its own file. recordings/ is under the tmp cwd (helpers/env.js)

const { bot, logs, uploads, agents, composed } = await loadBot({ SCREEN_ENABLED: 'false', PUBLIC_URL: 'http://localhost:1', DELETE_AFTER_UPLOAD: 'true' });
const { T } = await import('../src/browser-capture.js');
Object.assign(T, { drainMax: 50, silent: 50, poll: 5 });
const { voice, screen } = bot;
const content = (p) => p?.content ?? '';
const lastOf = (m) => m.edits.at(-1) ?? m.payload;

beforeEach(() => { bot._reset(); bot.client.guilds.cache.clear(); resetFakes(); uploads.length = 0; logs.err.length = 0; composed.calls.length = 0; });
after(() => bot._reset());

describe('DELETE_AFTER_UPLOAD with a session where nobody spoke', () => {
  test('finishes without error and removes the session and segment dirs after the upload', async () => {
    const s = scene(bot, { name: 'Alice' });
    await updateSettings(s.guild.id, { shareCards: true, minMembers: 2, minShareSeconds: 0, mode: 'agent' });
    moveMember(fakeMember(s.guild, { name: 'Bob' }), { channel: s.room });
    agents.setOnline(s.member.id);
    const sess = await startSession(bot, s);
    FakeVoiceRecorder.instances[0].nobodySpoke = true; // stop() gives audioFile = null
    const dirs = [sess.dir, ...sess.segments.map((x) => x.rec.dir)];
    const { pressOn } = await import('./helpers/session.js');
    await pressOn(bot, s, `screen:stop:${sess.began}`, { message: sess.card });
    await waitFor(() => !screen.has(s.guild.id) && !voice.has(s.guild.id) && /^[✅❌⚪]/.test(content(lastOf(sess.card))), 'result');
    await sleep(60);
    assert.match(content(lastOf(sess.card)), /^✅/);
    assert.equal(uploads.length, 1, 'the meeting file was uploaded');
    assert.deepEqual(logs.err, [], 'no error logged (dirname(null) used to throw)');
    for (const d of dirs) assert.ok(!existsSync(d), `${d} removed`);
    assert.ok(dirs.every((d) => resolve(d).startsWith(tmp)), 'only temp dirs');
  });
});
