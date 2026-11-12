import './helpers/env.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadBot, scene } from './helpers/bot.js';
import { fakeInteraction } from './helpers/fakes.js';
import { assertDiscordLimits } from './helpers/limits.js';

// PUBLIC_URL over plain http (not localhost): the install scripts need https, so /agent shows a note, never the commands

const { bot, agents } = await loadBot({ SCREEN_ENABLED: 'false', PUBLIC_URL: 'http://bot.example.com' });
after(() => bot._reset());

test('/agent with an http PUBLIC_URL: a Thai note about https instead of install commands', async () => {
  const s = scene(bot, { admin: false });
  const i = fakeInteraction({ guild: s.guild, member: s.member, channel: s.text, kind: 'slash', command: 'agent' });
  await bot.client.listeners('interactionCreate')[0](i);
  const p = i.replies[0];
  assert.match(p.content, /PUBLIC_URL.*https/);
  assert.ok(!p.content.includes('curl') && !p.content.includes('DRA_TOKEN') && !p.content.includes(agents.pairings.at(-1).token));
  assertDiscordLimits(p, '/agent http');
});
