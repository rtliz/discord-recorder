import { fakeInteraction, moveMember } from './fakes.js';
import { waitFor } from './bot.js';

// press-to-start helpers: a share posts a room card (nothing records), a 🔴 press turns it into a session

/** the room card of a voice room (once posted), or undefined */
export const roomCardOf = (bot, room) => bot.roomCards.get(room.id)?.card;

/** waits for the room card of s.room to be posted and returns its message */
export const waitCard = (bot, s, room = s.room) => waitFor(() => roomCardOf(bot, room), 'room card');

/** presses a session/room-card button as `member` (default s.member) on `message`; resolves the interaction */
export function pressOn(bot, s, customId, { member = s.member, message, ...extra } = {}) {
  const i = fakeInteraction({ guild: s.guild, member, channel: s.text, customId, message, ...extra });
  return bot.client.listeners('interactionCreate')[0](i).then(() => i);
}

/** 🔴 for `uid` on the room's card (as `member`, default s.member) */
export async function pressRec(bot, s, uid = s.member.id, { member = s.member, room = s.room } = {}) {
  const card = await waitCard(bot, s, room);
  return pressOn(bot, s, `screen:rec:${uid}`, { member, message: card });
}

/**
 * s.member shares, the room card appears, 🔴 is pressed: resolves the session once its first segment is
 * accepted and the room audio joined (sess.paired). sharer: who shares (default s.member)
 */
export async function startSession(bot, s, { sharer = s.member, presser = s.member, paired = true } = {}) {
  const g = s.guild.id;
  bot.client.listeners('voiceStateUpdate')[0](...moveMember(sharer, { streaming: true }));
  const i = await pressRec(bot, s, sharer.id, { member: presser });
  const sess = await waitFor(() => {
    const x = bot.screen.get(g);
    return x?.kind === 'session' && x.cur && (!paired || (x.paired && bot.voice.get(g) === x.paired)) && x;
  }, 'session started');
  await sess.cardQ;
  return Object.assign(sess, { press: i });
}
