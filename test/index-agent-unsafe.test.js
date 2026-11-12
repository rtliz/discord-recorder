import './helpers/env.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadBot, scene } from './helpers/bot.js';
import { fakeInteraction } from './helpers/fakes.js';

// an https PUBLIC_URL the server would refuse to put in the install scripts (a shell metacharacter): /agent shows no commands either

const { bot, agents } = await loadBot({ SCREEN_ENABLED: 'false', PUBLIC_URL: 'https://bot.example.com/a$(x)' });
after(() => bot._reset());

test('/agent with a PUBLIC_URL that fails SAFE_SERVER: a note, never the commands or the token', async () => {
  const s = scene(bot, { admin: false });
  const i = fakeInteraction({ guild: s.guild, member: s.member, channel: s.text, kind: 'slash', command: 'agent' });
  await bot.client.listeners('interactionCreate')[0](i);
  const p = i.replies[0];
  assert.match(p.content, /PUBLIC_URL/);
  assert.ok(!p.content.includes('curl') && !p.content.includes('DRA_TOKEN') && !p.content.includes(agents.pairings.at(-1).token));
});
