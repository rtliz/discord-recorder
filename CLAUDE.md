# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```
npm install
npm start              # node src/index.js — registers global slash commands, then logs in
npm run drive-auth     # one-time OAuth flow on localhost:53682, prints GOOGLE_REFRESH_TOKEN for .env
ffmpeg -f avfoundation -list_devices true -i ""   # find SCREEN_DEVICE index (macOS)
```

There is no build step or linter. `npm test` (node:test, offline, no Discord login) and `npm run test:browser` (headless Chrome via puppeteer-core, skips without Chrome). `test/index-*.test.js` load `src/index.js` without logging in: the main-guard skips login and REST, and `deps` swaps recorders and uploads for fakes in `test/helpers`. Plain Node ESM (`"type": "module"`, top-level `await`). `ffmpeg` must be on PATH.
Verify changes by running the bot against a real Discord server. Copy `.env.example` to `.env` first.

## Architecture

A single-process Discord gateway bot. `src/index.js` holds all routing and state. Other modules are leaf helpers.
Flow diagrams (Mermaid) for every path are in `diagram/`. Update them when a flow changes.

- **State is in-memory, one recording of each kind per guild**: `voice: Map<guildId, VoiceRecorder>` and `screen: Map<guildId, ScreenRecorder | BrowserCapture>`.
  A recorder object also carries the context it needs later: `textChannel` (where to post the result), and for auto recordings `auto` (sharer user id) and `autoChannelId`.
  A restart loses in-progress recordings. Nothing handles SIGTERM.
- **One handler for slash commands, buttons and selects**: a button `customId` is `"<cmd>:<sub>"` (for example `record:stop`). The `interactionCreate` handler parses slash commands, buttons and select menus into the same `[cmd, sub]` pair, so a new action needs an entry in `BUTTONS` (or `SELECTS`) and a branch in the handler. Bot replies carry the buttons for the next step (`row(...)`). `panel()` builds the control panel from the current state.
- **Permissions**: slash commands are gated by Discord (`ManageGuild` default permission). Buttons are visible to everyone, so the handler re-checks `ManageGuild`. If `ALLOWED_USER_IDS` is set, it replaces both checks.
- **Voice** (`voice-recorder.js`): joins with `selfDeaf:false` and writes one raw PCM file per speaker (`<userId>.pcm`, 48kHz s16le stereo). Before each speaking burst it pads silence computed from `startedAt`, so all tracks stay time-aligned. On stop, ffmpeg `amix` merges the tracks into `voice.mp3`.
- **Screen** (`screen-recorder.js`, macOS only): ffmpeg `avfoundation` plus `h264_videotoolbox`. Missing Screen Recording permission makes ffmpeg hang silently, so `start()` waits up to 8 s for the first `frame=` on stderr and throws `code: 'SCREEN_PERMISSION'` on timeout. Stop sends `q` to stdin so the mp4 is finalized, escalating to SIGINT and then SIGKILL. Window mode gets a crop region (fractions of the main display) from `window-bounds.js` (osascript JXA) and throws `code: 'WINDOW_NOT_FOUND'`. The `errorButtons(e)` function maps error `code`s to recovery buttons.
- **Screen modes** (`screen`, `window`, `browser`): `macScreen = SCREEN_ENABLED !== 'false'` (host-Mac capture only), `browserScreen = Boolean(PUBLIC_URL)`. `screenEnabled` is either, `modes` lists what is available, `modeOf(settings)` falls back to `modes[0]`. `screenBusy()` ignores browser captures: Mac screen is one at a time globally, browser capture is one per guild.
- **Browser capture** (`browser-capture.js`, `capture-server.js`, `capture/page.*`): Discord bots cannot receive video, so the sharer records their own screen. A `BrowserCapture` (same shape as `ScreenRecorder`: `stop()` returns the path, `exited`, `stopping`) lives in the `screen` Map. States: `offered` -> `live` -> `stopping` -> `finalizing` -> `done`, plus `voice` (phone fallback, see below). Auto offers have no timer (`offerMs: 0`: they end on stop, share end, leave or max); only manual private offers expire, after 5 min. The bot posts an offer card with the link button on it (auto); a manual sharer presses `screen:me` for an ephemeral link instead. Links are HMAC-signed with a per-process random key and claimed once: the manual link lasts 10 min, the card's link is minted once (`rec.cardLink`, lasts `maxMinutes` or 24 h). The page runs `getDisplayMedia` + `MediaRecorder` and PUTs numbered 3 s chunks with a bearer session. `stop()` waits for the page to flush, then pipes the chunks into ffmpeg (remux only, never re-encode; H.264 -> mp4, VP8/VP9 -> webm, falls back to the raw concatenation). Every self-exit (manual offer 5 min timeout, heartbeat 45 s, size cap `CAPTURE_MAX_MB` or the process-wide `CAPTURE_TOTAL_MB`, page stop/ended/unload) sets `exitReason` and `exitSkip`, so `finishScreen` reports it and `autoSkip` blocks re-offering until the sharer stops sharing. The owner may press `screen:me`/`screen:stop` without the recorder role. The modules must not import discord.js or index.js, and only use node built-ins.
- **HTTP server** (`startCaptureServer`, plain `node:http`): starts when `PUBLIC_URL` is set (full capture routes) or only `HTTP_PORT` is set (health only: `/healthz` 200, else 404). Page assets are read once into memory, never served from disk by URL. Capture routes: `/capture/<token>`, `/static/capture.{js,css}`, `/api/capture/<capId>/{start,chunk/<seq>,status,stop}`.
- **Auto screen recording** (`checkAutoScreen`): runs on every non-bot `voiceStateUpdate` and after any settings change. It starts recording when a voice channel has at least `minMembers` humans and one of them is streaming. It stops when that sharer stops streaming or leaves. Guards:
  - `startingScreen` / `startingVoice`: one start in flight per guild.
  - `autoSkip`: a share that was stopped by hand, or failed to start, is not retried until that user stops sharing.
  - After starting, it re-checks in case the sharer stopped during startup.
  - In `browser` mode it does not start a recording: it posts an offer (`offerBrowser`) and the sharer must press the link on the card. Auto offers pair voice immediately (`pairVoice` from `checkAutoScreen`, before any click). Manual captures pair on `onLive`, in the owner's current room. Both ignore `autoVoice`.
  - Manual recordings are never touched.
- **Nickname** (`updateNick`, called from `stateChanged`): while recording, the bot's per-server nickname is `<display name of who pressed/shares> - 🔴 กำลังอัดหน้าจอ|กำลังอัดเสียง` (`rec.owner ?? rec.by ?? rec.auto`); the nickname from before is kept in `nickBefore` and restored after; changes are serialized per guild, and startup clears a stale tag.
- **Settings** (`settings.js`): per-guild `{autoScreen, minMembers, mode}` (`mode` is `screen`, `window` or `browser`) in `data/settings.json` (`SETTINGS_FILE`). Env values are only defaults for guilds that have not saved settings. Writes are serialized and atomic (tmp file, then rename).
- **Delivery** (`deliver()`): uploads to Google Drive when `GOOGLE_REFRESH_TOKEN` and `DRIVE_FOLDER_ID` are set and replies with link buttons. Otherwise it attaches the file (10MB cap) or reports the local path. Files land in `recordings/<guildId>-<timestamp>/`. When a screen recording ends with a video and a paired voice file, `finishScreen` first calls `mergeAudio` (`src/merge.js`, ffmpeg `-c:v copy`, offset = video start − `VoiceRecorder.startedAt`; browser start = `liveAt`, Mac = `firstFrameAt`) and delivers the merged `*-with-audio` file as "▶️ ดูวิดีโอ" (also the capture page's Drive redirect) as the only file (voice.mp3 is not delivered separately); on failure it delivers the silent video plus voice.mp3 with a note. A voice-only recording delivers just voice.mp3. `deliver()` returns `uploaded`; with `DELETE_AFTER_UPLOAD=true` a recording dir is removed only if every file in it uploaded to Drive and no active recorder uses it.
- **`SCREEN_ENABLED=false`** (set in Dockerfile and k8s): disables host-Mac capture (`screen`/`window`) only. With `PUBLIC_URL` unset nothing else is left, so `/screen` and `/settings` are not registered and all screen and auto paths are off (voice only). With `PUBLIC_URL` set, `browser` mode keeps them.
- **`anyoneRecords`** (⚙️ quick page, 👥 toggle, default off, hidden when `ALLOWED_USER_IDS` is set): opens 🎙️/🎥/⏹️ to everyone, in both `canRecord` and `memberCanRecord`. Config (`settings`, `config:*`) stays `isAdmin` only. The sharer's own `screen:me`/`screen:stop` (with tag) bypass the checks.
- **Card queue** (`renderCard(rec, payloadOrFn)`): every write to a recording's card goes through `rec.cardQ`, in call order. A function payload (`liveCardOf(rec)`) is built when its turn comes and is skipped (null) once `rec.finished`. `putCard` edits the card, else the deferred interaction reply, else posts. Don't call `card.edit` directly.
- **Private offers**: a manual `screen:me` offer is `private: true`. Its link message is `rec.offerInteraction`, never `rec.interaction` (that would turn it into the public card). `panel()` hides it until it's live. Expiry or cancel edits that message to ⌛ with `components: []`.
- **Voice-only fallback** (`POST /api/capture/:id/voice`, state `voice`, `onVoiceOnly` -> `voiceOnly()` in index.js): a device without `getDisplayMedia` (phone) makes the bot record the owner's room instead. Single use (`voiceTried`). Auto: `{ paired: true }`, nothing started. Manual: the private offer ends silently and a public voice card is posted. Any failure returns the offer to `offered`.
- **Restart cleanup**: `settings.cards` (`[[channelId, messageId]]`, kept by `rememberCard`/`forgetCard`) lists the live cards. On `clientReady`, `markOrphanCards` edits them to "⚠️ บอทรีสตาร์ทระหว่างอัด" and clears the list. `settings.nickBefore` keeps the nickname to restore after a restart.
- **`VoiceRecorder.onGone`**: the connection is lost for good (kicked, or no reconnect within 5 s). `voiceGone` ends an unpaired recording (`⚠️ บอทหลุดจากห้องเสียง`), or adds a note to the paired screen recording, which keeps its video.

## Deployment

- `k8s/deployment.yaml` must stay `replicas: 1` with `strategy: Recreate`. Two gateway connections would answer every command twice.
- `k8s/deployment.yaml` also has a Service (ClusterIP 80 -> `http` 8080) and `/healthz` readiness/liveness probes. `k8s/ingress.yaml` exposes only `/capture`, `/static`, `/api/capture` (not `/healthz`) with nginx body-size, no request buffering and per-IP `limit-rps`; the host `recorder.example.com` and the TLS secret are placeholders that must match `PUBLIC_URL`.
- Recordings use an `emptyDir` (20Gi; video is about 0.9GB/h per person, doubled while remuxing); k8s sets `DELETE_AFTER_UPLOAD=true`. The real secrets file `k8s/secret.yaml` (copied from `secret.example.yaml`) must not be committed.
- The Docker image copies only `package*.json` and `src/` (the capture page is `src/capture/`). It exposes 8080.

## Conventions

- User-facing strings (replies, button labels, command descriptions) are in Thai. Code comments are in English.
- The code style is compact: short helpers and inline comments explaining *why*. Match it.
