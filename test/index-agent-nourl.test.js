import './helpers/env.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadBot } from './helpers/bot.js';

// without PUBLIC_URL there are no agents: /agent is not registered

const { bot } = await loadBot({ SCREEN_ENABLED: 'true', PUBLIC_URL: '' });
after(() => bot._reset());

test('no /agent command without PUBLIC_URL (the other commands stay)', () => {
  const names = bot.commands.map((c) => c.name);
  assert.ok(!names.includes('agent'));
  assert.ok(names.includes('screen') && names.includes('record'));
});
