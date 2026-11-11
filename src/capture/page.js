// Capture page: records the screen in the browser and uploads chunks to the bot. Plain script, no deps.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const startBtn = $('start'), stopBtn = $('stop'), msg = $('msg'), hint = $('hint'), live = $('live');
  const token = location.pathname.split('/')[2] || '';   // /capture/<token>
  const capId = token.split('.')[0];
  const api = `/api/capture/${encodeURIComponent(capId)}`;
  const say = (text, kind = '') => { msg.textContent = text; msg.className = `msg ${kind}`; };

  let session = '', mr = null, stream = null, mimeBase = 'video/webm';
  let recording = false, stopped = false, dead = false;   // dead: server said stop / link gone
  let n = 0, sentBytes = 0, t0 = 0, sent0 = false;        // sent0: chunk 0 (the container header) arrived
  let endMsg = null;                                      // why the server ended it, shown instead of ✅
  const queue = [];
  let uploading = null;
  let tick = 0, poll = 0;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const auth = () => ({ Authorization: `Bearer ${session}` });

  // U20: a phone can't capture, so the bot records the voice room instead (single use, server decides)
  const NOCAP = '📱 อุปกรณ์นี้อัดจอไม่ได้ ใช้คอมพิวเตอร์แทน';
  async function voiceFallback() {
    try {
      const res = await fetch(`${api}/voice`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
      });
      const r = await res.json().catch(() => ({}));
      if (res.ok && r.ok) {
        return [r.paired ? '📱 อุปกรณ์นี้อัดจอไม่ได้ — บอทอัดเสียงในห้องอยู่แล้ว ปิดหน้านี้ได้'
          : '📱 อุปกรณ์นี้อัดจอไม่ได้ — บอทอัดเสียงในห้องให้แทนแล้ว ดูผลใน Discord', 'ok'];
      }
      if (r.error === 'novoice') return ['📱 อุปกรณ์นี้อัดจอไม่ได้ และคุณไม่ได้อยู่ในห้องเสียง', 'err'];
    } catch { /* offline: same as failed */ }
    return [NOCAP, 'err'];
  }
  if (!navigator.mediaDevices?.getDisplayMedia || typeof MediaRecorder === 'undefined') {
    startBtn.hidden = true;
    hint.hidden = true;
    if (!token) return say(NOCAP, 'err');
    say('📱 อุปกรณ์นี้อัดจอไม่ได้ — กำลังให้บอทอัดเสียงแทน…'); // joining a room can take a while
    voiceFallback().then(([text, kind]) => say(text, kind));
    return;
  }

  // High profile level 4.0 first (1080p+ at 30 fps); Baseline as fallback for browsers without it
  const pickMime = (hasAudio) => [
    'video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01F,mp4a.40.2', 'video/webm;codecs=h264,opus', 'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4',
  ].map((m) => (hasAudio ? m : m.replace(/,(opus|mp4a\.40\.2)$/, '')))
    .find((m) => MediaRecorder.isTypeSupported(m)) || '';

  const stopTracks = () => stream?.getTracks().forEach((t) => t.stop());

  // the server ended this capture for good: stop at once (no drain, it would only be rejected)
  const ENDED = {
    404: ['บอทรีสตาร์ท การอัดนี้หายไป กด 🎥 ใหม่ใน Discord', 'err'],
    401: ['การอัดนี้ใช้ต่อไม่ได้แล้ว กด 🎥 ใหม่ใน Discord', 'err'],
    410: ['⏹️ บอทหยุดอัดแล้ว ส่วนท้ายที่ยังไม่ได้ส่งจะหายไป ผลจะขึ้นใน Discord', 'warn'],
    413: ['⚠️ วิดีโอใหญ่ถึงขีดจำกัด บอทหยุดอัดแล้ว ผลจะขึ้นใน Discord', 'warn'],
  };
  function ended(status) {
    if (!dead) { dead = true; endMsg = ENDED[status]; }
    stopAll('server'); // not awaited: called from inside the uploader that stopAll would wait for
  }

  // chunk 0 carries the container header: without it nothing plays, so it is retried for as long as
  // the page is alive; other chunks give up after ~23 s (the server notes the gap)
  async function upload(item) {
    for (let i = 0; ; i++) {
      if (dead) return;
      try {
        const res = await fetch(`${api}/chunk/${item.seq}`, {
          method: 'PUT', headers: { ...auth(), 'Content-Type': mimeBase }, body: item.blob,
        });
        if (ENDED[res.status]) return ended(res.status);
        if (res.ok) {
          sentBytes += item.blob.size;
          if (item.seq === 0) sent0 = true;
          if ((await res.json().catch(() => ({}))).stop) stopAll('server');
          return;
        }
        // 409 (same chunk still being written) and 429 are worth another try; other 4xx never succeed
        if (res.status >= 400 && res.status < 500 && ![409, 429].includes(res.status)) return;
      } catch { /* network error: retry */ }
      if (item.seq !== 0 && i >= 5) return;
      await sleep(Math.min(1000 * 2 ** i, 8000));
    }
  }

  function pump() {
    if (uploading) return uploading;
    uploading = (async () => {
      while (queue.length) { await upload(queue[0]); queue.shift(); }
    })().finally(() => { uploading = null; });
    return uploading;
  }

  const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  function paint() {
    $('elapsed').textContent = fmt(Math.floor((Date.now() - t0) / 1000));
    $('sent').textContent = `ส่งแล้ว ${(sentBytes / 1048576).toFixed(1)} MB`;
    if (queue.length > 3) say(`เน็ตช้า กำลังส่งที่ค้าง ${queue.length} ส่วน`, 'warn');
    else if (msg.classList.contains('warn')) say('');
  }

  async function stopAll(reason) {
    if (stopped) return;
    stopped = true;
    recording = false;
    clearInterval(tick); clearInterval(poll);
    stopBtn.disabled = true;
    say('กำลังส่งส่วนสุดท้ายให้บอท…');
    if (mr && mr.state !== 'inactive') {
      await new Promise((r) => { mr.onstop = r; try { mr.stop(); } catch { r(); } });
    }
    if (!dead) await Promise.race([pump(), sleep(30000)]);   // drain, at most 30 s
    const wasEnded = dead && endMsg;
    dead = true;
    stopTracks();
    if (wasEnded && endMsg[1] === 'err') { // 401/404: the server doesn't know this capture any more
      live.hidden = true; stopBtn.hidden = true; hint.hidden = true;
      return say(endMsg[0], 'err');
    }
    try {
      await fetch(`${api}/stop`, {
        method: 'POST', keepalive: true,
        headers: { ...auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason === 'server' ? 'page' : reason, last: n - 1 }),
      });
    } catch { /* server may already be done */ }
    live.hidden = true; stopBtn.hidden = true; hint.hidden = true;
    if (n > 0 && !sent0) say('❌ ส่งวิดีโอส่วนแรกให้บอทไม่สำเร็จ ไฟล์นี้ใช้ไม่ได้ กด 🎥 ใหม่ใน Discord', 'err');
    else openResult();
  }

  // wait for the bot to remux + upload, then turn this tab into the video on Google Drive
  // (a tab opened from Discord can't close itself; replacing it is the closest thing)
  async function openResult() {
    const head = endMsg ? `${endMsg[0]}\n` : '';
    say(`${head}⏳ กำลังรวมไฟล์และอัปขึ้น Google Drive… เสร็จแล้วหน้านี้จะเปิดวิดีโอให้เอง`, endMsg ? endMsg[1] : 'ok');
    for (const until = Date.now() + 15 * 60e3; Date.now() < until;) {
      await sleep(3000);
      try {
        const res = await fetch(`${api}/result`, { headers: auth() });
        if (res.status === 401 || res.status === 404) break; // bot restarted / gone
        if (!res.ok) continue;
        const r = await res.json();
        if (!r.ready) continue;
        if (typeof r.url === 'string' && /^https:\/\/(drive|docs)\.google\.com\//.test(r.url)) {
          say('✅ เสร็จแล้ว กำลังเปิด Google Drive…', 'ok');
          return location.replace(r.url);
        }
        break; // done, but no Drive link (Drive off or upload failed): the result is in Discord
      } catch { /* offline: keep waiting */ }
    }
    say('✅ ส่งวิดีโอให้บอทแล้ว ผลอยู่ใน Discord ปิดหน้านี้ได้', 'ok');
  }

  async function start(auto = false) {
    startBtn.disabled = true;
    say('');
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 30 } },
        audio: true,
        selfBrowserSurface: 'exclude', surfaceSwitching: 'include', systemAudio: 'include', monitorTypeSurfaces: 'include',
      });
    } catch (e) {
      startBtn.disabled = false;
      // the automatic try usually fails for lack of a click (Chrome needs one unless an admin policy allows it):
      // that's expected, just leave the ▶️ button
      if (e?.name === 'NotSupportedError') { // a phone browser that exposes getDisplayMedia but rejects it: same as having none
        startBtn.hidden = true;
        hint.hidden = true;
        if (!token) return say(NOCAP, 'err');
        say('📱 อุปกรณ์นี้อัดจอไม่ได้ — กำลังให้บอทอัดเสียงแทน…');
        return voiceFallback().then(([text, kind]) => say(text, kind));
      }
      if (auto) return say('');
      say(e?.name === 'NotAllowedError' ? 'ยกเลิกการเลือกจอ กดเริ่มใหม่ได้' : 'เปิดการอัดจอไม่ได้ ลองใหม่อีกครั้ง', 'err');
      return;
    }
    const mime = pickMime(stream.getAudioTracks().length > 0);
    mimeBase = (mime || 'video/webm').split(';')[0];
    let cfg;
    try {
      const res = await fetch(`${api}/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, mime: mime || 'video/webm' }),
      });
      if (!res.ok) {
        stopTracks();
        startBtn.disabled = false;
        say(res.status === 409 ? 'ลิงก์นี้ถูกเปิดไปแล้ว (แท็บอื่นหรือคนอื่น) กด 🎥 ใน Discord ใหม่'
          : res.status === 410 || res.status === 404 ? 'ลิงก์หมดอายุหรือถูกใช้แล้ว กด 🎥 ใน Discord ใหม่'
            : 'เริ่มอัดไม่ได้ ลองใหม่อีกครั้ง', 'err');
        if (res.status === 410 || res.status === 404) startBtn.hidden = true;
        return;
      }
      cfg = await res.json();
    } catch {
      stopTracks();
      startBtn.disabled = false;
      say('เชื่อมต่อบอทไม่ได้ ลองใหม่อีกครั้ง', 'err');
      return;
    }
    session = cfg.session;
    history.replaceState(null, '', '/capture/');   // keep the token out of history and the address bar
    try {
      mr = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: cfg.videoBps });
      mr.ondataavailable = (e) => { if (e.data?.size) { queue.push({ seq: n++, blob: e.data }); pump(); } };
      // encoder failure, or the browser stopping the recorder on its own: finish instead of hanging "live"
      mr.onerror = () => stopAll('page');
      mr.onstop = () => { if (!stopped) stopAll('page'); };
      stream.getVideoTracks()[0].addEventListener('ended', () => stopAll('ended'));
      mr.start(cfg.chunkMs);
    } catch {
      say('เริ่มอัดไม่ได้ เบราว์เซอร์ไม่รองรับรูปแบบวิดีโอ', 'err');
      stopAll('page');
      return;
    }
    recording = true; t0 = Date.now();
    startBtn.hidden = true; stopBtn.hidden = false; live.hidden = false;
    hint.textContent = 'อย่าปิดแท็บนี้จนกว่าจะหยุดอัด';
    say('');
    tick = setInterval(paint, 1000);
    poll = setInterval(async () => {
      try {
        const res = await fetch(`${api}/status`, { headers: auth() });
        if (ENDED[res.status]) return ended(res.status);
        if (res.ok && (await res.json()).stop) stopAll('server');
      } catch { /* offline: the server heartbeat decides */ }
    }, 5000);
  }

  startBtn.addEventListener('click', () => start());
  // open the screen picker right away where Chrome allows it without a click
  // (managed Chrome with the ScreenCaptureWithoutGestureAllowedForOrigins policy); else ▶️ stays
  if (token) start(true);
  stopBtn.addEventListener('click', () => stopAll('page'));
  window.addEventListener('beforeunload', (e) => { if (recording) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('pagehide', () => {
    if (!recording || stopped) return;
    fetch(`${api}/stop`, {
      method: 'POST', keepalive: true,
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'unload', last: n - 1 }),
    }).catch(() => {});
  });
})();
