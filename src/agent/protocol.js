// wire contract shared by the bot (src/agent-hub.js, src/capture-server.js) and the agent (src/agent/*)
// constants only: no imports, no I/O, so both sides (and a later bundle) can load it anywhere
export const PROTOCOL = 1;
export const POLL_MS = 25000, GONE_MS = 40000, ACK_MS = 15000, CHUNK_MS = 3000;
export const AGENT_MIME = 'video/mp4;codecs=avc1'; // what the agent sends as `mime` on /api/capture/<capId>/start
export const CMD = { start: 'start', stop: 'stop', replaced: 'replaced', revoked: 'revoked' }; // poll `cmds[].type`
// `start.area`: what the agent captures (an old agent ignores it and records the whole screen). An agent that can't find
// the Discord window records the whole screen and acks ok with a Thai `detail` note the bot shows on the card
export const AREA = { screen: 'screen', discord: 'discord' };
export const STOP_REASON = { local: 'agent', quit: 'unload' }; // POST /api/capture/<capId>/stop {reason}
// ack `error` values (`declined` only from old agents that still asked first); `offline` is never sent by an agent, the hub uses it when the session went away before the ack
export const ACK_ERROR = { declined: 'declined', timeout: 'timeout', busy: 'busy', ffmpeg: 'ffmpeg', display: 'display', offline: 'offline' };
