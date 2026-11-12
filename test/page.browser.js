import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// real capture-server + real BrowserCapture + the real page in headless Chrome; only getDisplayMedia is stubbed

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const skip = !existsSync(CHROME) && `no Chrome at ${CHROME} (set CHROME_PATH)`;

const PORT = await new Promise((res) => {
  const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => res(port)); }); // never 8080
});
process.env.PUBLIC_URL = `http://localhost:${PORT}`;
const { BrowserCapture, T } = await import('../src/browser-capture.js');
const { startCaptureServer } = await import('../src/capture-server.js');
const puppeteer = skip ? null : (await import('puppeteer-core')).default;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000, what = 'condition') => {
  for (const end = Date.now() + ms; Date.now() < end;) { const v = await fn(); if (v) return v; await sleep(100); }
  throw new Error(`timeout waiting for ${what}`);
};
const DRIVE = 'https://drive.google.com/file/d/x/view';

// runs in the page before any script: 320x180 canvas video + WebAudio tone, like a shared screen with sound
function stub(mode) {
  window.__mode = mode; // 'ok' | 'reject' | 'unsupported' | 'none'
  if (mode === 'none') { delete navigator.mediaDevices.getDisplayMedia; try { Object.defineProperty(navigator, 'mediaDevices', { value: undefined }); } catch {} return; }
  navigator.mediaDevices.getDisplayMedia = async (asked) => {
    window.__gdm = asked; // the constraints the page asked for
    if (window.__mode === 'reject') throw new DOMException('no gesture', 'NotAllowedError');
    if (window.__mode === 'unsupported') throw new DOMException('not here', 'NotSupportedError');
    const c = document.createElement('canvas');
    c.width = 320; c.height = 180;
    const g = c.getContext('2d');
    let i = 0;
    setInterval(() => { g.fillStyle = `hsl(${(i += 7) % 360} 80% 50%)`; g.fillRect(0, 0, 320, 180); }, 66);
    const st = c.captureStream(15);
    const ac = new AudioContext(), osc = ac.createOscillator(), dest = ac.createMediaStreamDestination();
    osc.connect(dest); osc.start();
    dest.stream.getAudioTracks().forEach((t) => st.addTrack(t));
    return st;
  };
}

describe('capture page in headless Chrome', { skip }, () => {
  let server, browser, out;
  const driveHits = [];
  const oldT = { ...T };

  before(async () => {
    out = mkdtempSync(join(tmpdir(), 'page-test-'));
    server = startCaptureServer(PORT);
    await new Promise((r) => server.once('listening', r));
    Object.assign(T, { poll: 25, drainMax: 8000 });
    browser = await puppeteer.launch({
      executablePath: CHROME, headless: 'new',
      args: ['--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check'],
    });
  });
  after(async () => {
    Object.assign(T, oldT);
    await browser?.close();
    server?.closeAllConnections();
    server?.close();
    rmSync(out, { recursive: true, force: true });
  });

  let n = 0;
  const fresh = () => {
    const rec = new BrowserCapture(join(out, `rec${++n}`), { guildId: 'g', owner: 'u', offerMs: 0 });
    rec.lived = 0;
    rec.onLive = () => { rec.lived++; };
    return rec;
  };
  const open = async (url, mode = 'ok') => {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (/(^|\.)google\.com$/.test(new URL(req.url()).hostname)) { driveHits.push(req.url()); return req.abort(); }
      req.continue();
    });
    await page.evaluateOnNewDocument(stub, mode);
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {}); // a google.com redirect may abort the load
    return page;
  };
  const text = (page, sel) => page.$eval(sel, (e) => e.textContent);
  const visible = (page, sel) => page.$eval(sel, (e) => !e.hidden);

  test('auto-starts without a click and streams chunks', async () => {
    const rec = fresh();
    const page = await open(rec.link());
    await until(() => rec.state === 'live' && rec.have.size >= 1, 20000, 'live + first chunk');
    assert.equal(rec.lived, 1);
    assert.ok(await visible(page, '#stop'));
    assert.ok(rec.bytes > 0);
    rec.exit('test'); await rec.stop();
    await page.close();
  });

  test('stop on the page then the result redirects to Drive', async () => {
    const rec = fresh();
    const page = await open(rec.link());
    await until(() => rec.state === 'live' && rec.have.size >= 1, 20000, 'live');
    await page.click('#stop');
    await rec.exited; // pageStop -> exit
    assert.match(rec.exitReason, /หยุดจากหน้าอัดจอ/);
    const p = rec.stop();
    const before = driveHits.length;
    await p.catch(() => {});
    rec.result = { url: DRIVE };
    await until(() => driveHits.length > before, 15000, 'drive navigation');
    assert.ok(driveHits.at(-1).startsWith('https://drive.google.com/'));
    await page.close();
  });

  test('server-side stop drains the page and shows the result text', async () => {
    const rec = fresh();
    const page = await open(rec.link());
    await until(() => rec.state === 'live' && rec.have.size >= 1, 20000, 'live');
    const p = rec.stop();
    await p.catch(() => {});
    rec.result = { url: null }; // Drive off: the page falls back to the generic text
    await until(async () => /ผลอยู่ใน Discord/.test(await text(page, '#msg')), 15000, 'result text');
    assert.equal(rec.state, 'done');
    await page.close();
  });

  test('rejected auto-start leaves the button and no error text', async () => {
    const rec = fresh();
    const page = await open(rec.link(), 'reject');
    await sleep(800);
    assert.ok(await visible(page, '#start'));
    assert.equal(await page.$eval('#start', (e) => e.disabled), false);
    assert.equal((await text(page, '#msg')).trim(), '');
    assert.equal(rec.state, 'offered');
    rec.exit('test'); await rec.stop();
    await page.close();
  });

  test('capture area: ?area=discord asks for the Discord window (hint text + displaySurface window); default monitor', async () => {
    for (const [q, surface, hintRe] of [['?area=discord', 'window', /เลือกหน้าต่าง Discord แล้วกด แชร์/], ['', 'monitor', /เลือกจอที่จะอัด แล้วกด แชร์/]]) {
      const rec = fresh();
      const page = await open(`${rec.link()}${q}`, 'reject'); // rejected: the hint stays on screen
      await until(() => page.evaluate(() => Boolean(window.__gdm)), 10000, 'getDisplayMedia called');
      assert.equal(await page.evaluate(() => window.__gdm.video.displaySurface), surface, q || 'default');
      assert.match(await text(page, '#hint'), hintRe);
      rec.exit('test'); await rec.stop();
      await page.close();
    }
  });

  // U20: no getDisplayMedia -> the page asks the bot (POST /voice) to record the room instead
  const U20 = [
    ['no onVoiceOnly (fallback failed)', undefined, '📱 อุปกรณ์นี้อัดจอไม่ได้ ใช้คอมพิวเตอร์แทน', 'offered'],
    ['manual: bot started a voice recording', async () => ({ paired: false }), '📱 อุปกรณ์นี้อัดจอไม่ได้ — บอทอัดเสียงในห้องให้แทนแล้ว ดูผลใน Discord', 'voice'],
    ['auto: room already recorded', () => ({ paired: true }), '📱 อุปกรณ์นี้อัดจอไม่ได้ — บอทอัดเสียงในห้องอยู่แล้ว ปิดหน้านี้ได้', 'voice'],
    ['owner not in voice', () => ({ error: 'novoice' }), '📱 อุปกรณ์นี้อัดจอไม่ได้ และคุณไม่ได้อยู่ในห้องเสียง', 'offered'],
  ];
  for (const [name, cb, want, state] of U20) {
    test(`no getDisplayMedia -> /voice -> U20 text: ${name}`, async () => {
      const rec = fresh();
      let calls = 0;
      if (cb) rec.onVoiceOnly = (r) => { calls++; assert.equal(r, rec); return cb(r); };
      const page = await open(rec.link(), 'none');
      await until(async () => (await text(page, '#msg')) === want, 5000, `U20 text "${want}"`);
      assert.equal(await visible(page, '#start'), false);
      assert.equal(calls, cb ? 1 : 0);
      assert.equal(rec.voiceTried, true);
      assert.equal(rec.state, state);
      rec.exit('test'); await rec.stop();
      await page.close();
    });
  }

  test('getDisplayMedia rejecting NotSupportedError (mobile) -> same voice fallback as having none', async () => {
    const rec = fresh();
    let calls = 0;
    rec.onVoiceOnly = () => { calls++; return { paired: false }; };
    const page = await open(rec.link(), 'unsupported');
    await until(async () => (await text(page, '#msg')) === '📱 อุปกรณ์นี้อัดจอไม่ได้ — บอทอัดเสียงในห้องให้แทนแล้ว ดูผลใน Discord', 5000, 'U20 text');
    assert.equal(await visible(page, '#start'), false);
    assert.equal(calls, 1);
    rec.exit('test'); await rec.stop();
    await page.close();
  });

  test('second tab on the same link gets the "already opened" text', async () => {
    const rec = fresh();
    const url = rec.link();
    const b = await open(url, 'reject'); // loads while still offered, keeps its button
    const a = await open(url);
    await until(() => rec.state === 'live', 20000, `tab A live (state ${rec.state})`);
    await b.bringToFront();
    await b.evaluate(() => { window.__mode = 'ok'; document.getElementById('start').click(); }); // DOM click: no layout/focus needed
    await until(async () => (await text(b, '#msg')).includes('ลิงก์นี้ถูกเปิดไปแล้ว (แท็บอื่นหรือคนอื่น) กด 🎥 ใน Discord ใหม่'), 10000, 'U22 text');
    assert.equal(rec.lived, 1);
    rec.exit('test'); await rec.stop();
    await a.close(); await b.close();
  });

  test('bad link shows the styled GONE page', async () => {
    const rec = fresh();
    const url = rec.link();
    const used = await open(url); // claim it, then the same token is gone
    await until(() => rec.state === 'live', 20000, 'live');
    const page = await open(url);
    assert.match(await text(page, '#gone'), /ลิงก์นี้ใช้ไม่ได้แล้ว \(หมดเวลา ถูกเปิดไปแล้ว หรือบอทรีสตาร์ท\) — กลับไป Discord แล้วกด 🎥 อีกครั้ง/);
    assert.ok(await page.$('meta[name=viewport]'));
    assert.ok(await page.$('link[href="/static/capture.css"]'));
    rec.exit('test'); await rec.stop();
    await used.close(); await page.close();
  });
});
