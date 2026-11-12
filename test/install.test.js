// A4: pins.json, the build:agent tool (stubbed fetch), the manifest builder and install.sh against a local fake bot.
// Nothing here touches the real home dir or the network: every install runs in a tmp DRA_HOME/HOME with fake node/ffmpeg archives.
process.env.PUBLIC_URL ??= 'https://rec.example.com';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgentAssets } from '../src/capture-server.js';
import { PROTOCOL } from '../src/agent/protocol.js';
import { build, diff, gyanUrl, nodeUrl, parseSums, SEED, TARGETS, TRUSTED } from '../scripts/build-agent.js';

const AGENT_SRC = fileURLToPath(new URL('../src/agent/', import.meta.url));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;

describe('pins.json', () => {
  const pins = JSON.parse(readFileSync(join(AGENT_SRC, 'pins.json'), 'utf8'));
  test('has node and ffmpeg for every target with a trusted https url and a sha256', () => {
    for (const sec of ['node', 'ffmpeg']) {
      assert.match(pins[sec].version, /^\d+\.\d+(\.\d+)?$/);
      for (const t of TARGETS) {
        const { url, sha256 } = pins[sec][t];
        assert.match(sha256, /^[0-9a-f]{64}$/, `${sec} ${t}`);
        const u = new URL(url);
        assert.equal(u.protocol, 'https:');
        assert.ok(TRUSTED.includes(u.hostname), `${sec} ${t} host ${u.hostname}`);
      }
    }
  });
  test('node urls are the official dist urls of the pinned version', () => {
    for (const t of TARGETS) assert.equal(pins.node[t].url, nodeUrl(pins.node.version, t));
  });
  test('only known keys (the install scripts and the manifest rely on this shape)', () => {
    assert.deepEqual(Object.keys(pins).sort(), ['ffmpeg', 'node']);
    for (const sec of ['node', 'ffmpeg']) assert.deepEqual(Object.keys(pins[sec]).sort(), ['version', ...TARGETS].sort());
    for (const sec of ['node', 'ffmpeg']) for (const t of TARGETS) assert.deepEqual(Object.keys(pins[sec][t]).sort(), ['sha256', 'url']);
  });
});

describe('manifest builder (loadAgentAssets)', () => {
  test('real src/agent: files hashed, pins included, install scripts carry the server and no placeholder', () => {
    const a = loadAgentAssets(AGENT_SRC, 'https://rec.example.com');
    const m = JSON.parse(a.manifest.toString());
    assert.equal(m.protocol, PROTOCOL);
    assert.ok(m.files.some((f) => f.name === 'main.js'));
    for (const f of m.files) assert.equal(f.sha256, sha(readFileSync(join(AGENT_SRC, f.name))));
    assert.deepEqual(m.node, JSON.parse(readFileSync(join(AGENT_SRC, 'pins.json'), 'utf8')).node);
    for (const n of ['install.sh', 'install.ps1']) {
      const t = a.scripts.get(n).toString();
      assert.ok(!t.includes('__SERVER__'), n);
      assert.ok(t.includes("'https://rec.example.com'"), n);
    }
  });
  test('the source scripts hold the placeholder exactly once, single quoted', () => {
    for (const n of ['install.sh', 'install.ps1']) {
      const t = readFileSync(join(AGENT_SRC, n), 'utf8');
      assert.equal(t.split("'__SERVER__'").length - 1, 1, n);
      assert.equal(t.replaceAll("'__SERVER__'", '').includes('__SERVER__'), false, `${n}: placeholder outside the assignment`);
    }
  });
});

describe('build:agent', () => {
  const body = (s) => new Response(s);
  const arch = { 'darwin-arm64': 'AAA', 'darwin-x64': 'BBB', 'linux-x64': 'CCC', 'win-x64': 'DDD' };
  // a fake internet: url -> content, plus the publishers' hash files computed from it
  const world = (v = '24.1.0', extra = {}) => {
    const w = new Map(), nodeSums = [];
    for (const t of TARGETS) { const u = nodeUrl(v, t); w.set(u, `node-${t}-${v}`); nodeSums.push(`${sha(w.get(u))}  ${u.split('/').pop()}`); }
    w.set(`https://nodejs.org/dist/v${v}/SHASUMS256.txt`, `${nodeSums.join('\n')}\n`);
    const seed = JSON.parse(JSON.stringify(SEED));
    seed.node.version = v;
    for (const t of TARGETS) {
      const u = seed.ffmpeg[t].url;
      w.set(u, `ffmpeg-${t}`);
      w.set(`${u}.sha256`, t === 'win-x64' ? sha(w.get(u)) : `${sha(w.get(u))}  ffmpeg.zip\n`); // gyan.dev: the bare hash
    }
    for (const [k, val] of Object.entries(extra)) w.set(k, val);
    return { w, seed };
  };
  const fetchOf = (w, calls = []) => async (url, opts) => {
    calls.push(url);
    if (!w.has(url)) return new Response('nope', { status: 404 });
    const x = w.get(url);
    return x instanceof Response ? x : body(x);
  };

  test('computes node + ffmpeg pins from publisher hashes and cross-checks the downloads', async () => {
    const { w, seed } = world();
    const calls = [];
    const r = await build({ pins: seed, fetchFn: fetchOf(w, calls) });
    for (const t of TARGETS) {
      assert.equal(r.pins.node[t].sha256, sha(`node-${t}-24.1.0`));
      assert.equal(r.pins.ffmpeg[t].sha256, sha(`ffmpeg-${t}`));
    }
    assert.ok(r.changes.some((c) => c.startsWith('ffmpeg.win-x64.sha256: (none) -> ')));
    assert.ok(calls.includes(nodeUrl('24.1.0', 'win-x64')), 'archives were downloaded to hash');
  });

  test('a download that differs from the published hash aborts', async () => {
    const { w, seed } = world();
    const url = nodeUrl('24.1.0', 'linux-x64');
    const calls = [];
    // the SHASUMS says X, the archive hashes to Y
    const evil = new Map(w); evil.set(url, 'tampered');
    await assert.rejects(build({ pins: seed, fetchFn: fetchOf(evil, calls) }), /downloaded .* != SHASUMS256/);
    const evil2 = new Map(w); evil2.set(seed.ffmpeg['darwin-arm64'].url, 'tampered');
    await assert.rejects(build({ pins: seed, fetchFn: fetchOf(evil2) }), /ffmpeg darwin-arm64: downloaded/);
  });

  test('--no-download trusts the hash files and fetches no archive', async () => {
    const { w, seed } = world();
    const calls = [];
    await build({ pins: seed, fetchFn: fetchOf(w, calls), download: false });
    assert.ok(!calls.includes(nodeUrl('24.1.0', 'linux-x64')));
    assert.ok(!calls.includes(seed.ffmpeg['linux-x64'].url));
  });

  test('refuses an untrusted url and a missing published hash', async () => {
    const { w, seed } = world();
    seed.ffmpeg['linux-x64'].url = 'https://evil.example.com/ffmpeg.zip';
    await assert.rejects(build({ pins: seed, fetchFn: fetchOf(w) }), /untrusted url/);
    const w2 = world(); w2.w.delete(`${w2.seed.ffmpeg['darwin-x64'].url}.sha256`);
    await assert.rejects(build({ pins: w2.seed, fetchFn: fetchOf(w2.w) }), /HTTP 404/);
  });

  test('--bump node=<v> repoints the urls and hashes; a bad version is refused', async () => {
    const a = world('24.1.0'), b = world('24.2.0');
    const first = (await build({ pins: a.seed, fetchFn: fetchOf(new Map([...a.w, ...b.w])), download: false })).pins;
    const r = await build({ pins: first, bump: { node: '24.2.0' }, fetchFn: fetchOf(new Map([...a.w, ...b.w])), download: false });
    assert.equal(r.pins.node.version, '24.2.0');
    assert.equal(r.pins.node['win-x64'].url, nodeUrl('24.2.0', 'win-x64'));
    assert.ok(r.changes.includes('node.version: 24.1.0 -> 24.2.0'));
    await assert.rejects(build({ pins: first, bump: { node: '24;rm' }, fetchFn: fetchOf(a.w) }), /bad node version/);
  });

  test('the Windows pin is a versioned gyan.dev release build (BtbN prunes its dated autobuilds)', () => {
    assert.equal(SEED.ffmpeg['win-x64'].url, gyanUrl('9.0.2'));
    assert.match(gyanUrl('9.0.2'), /^https:\/\/www\.gyan\.dev\/ffmpeg\/builds\/packages\/ffmpeg-9\.0\.2-essentials_build\.zip$/);
    assert.ok(!TRUSTED.includes('github.com') && !TRUSTED.includes('api.github.com'), 'nothing is fetched from GitHub any more');
  });

  test('--bump ffmpeg=latest follows the martin-riedl redirect and the gyan.dev release version', async () => {
    const { w, seed } = world();
    const mart = 'https://ffmpeg.martin-riedl.de';
    const dl = { 'darwin-arm64': 'macos/arm64', 'darwin-x64': 'macos/amd64', 'linux-x64': 'linux/amd64' };
    for (const [t, p] of Object.entries(dl)) {
      const loc = `/download/${p}/1800000000_9.1.0/ffmpeg.zip`;
      w.set(`${mart}/redirect/latest/${p}/release/ffmpeg.zip`, new Response(null, { status: 307, headers: { location: loc } }));
      w.set(`${mart}${loc}`, `new-${t}`); w.set(`${mart}${loc}.sha256`, `${sha(`new-${t}`)}\n`);
    }
    w.set('https://www.gyan.dev/ffmpeg/builds/release-version', '9.1.0\n');
    w.set(gyanUrl('9.1.0'), 'new-win'); w.set(`${gyanUrl('9.1.0')}.sha256`, sha('new-win'));
    const r = await build({ pins: seed, bump: { ffmpeg: 'latest' }, fetchFn: fetchOf(w) });
    assert.equal(r.pins.ffmpeg.version, '9.1.0');
    assert.equal(r.pins.ffmpeg['darwin-arm64'].url, `${mart}/download/macos/arm64/1800000000_9.1.0/ffmpeg.zip`);
    assert.equal(r.pins.ffmpeg['win-x64'].url, gyanUrl('9.1.0'));
    assert.equal(r.pins.ffmpeg['win-x64'].sha256, sha('new-win'));
    await assert.rejects(build({ pins: seed, bump: { ffmpeg: '8.0.0' }, fetchFn: fetchOf(w) }), /is the latest release/);
    w.set('https://www.gyan.dev/ffmpeg/builds/release-version', '<html>oops</html>');
    await assert.rejects(build({ pins: seed, bump: { ffmpeg: 'latest' }, fetchFn: fetchOf(w) }), /not a version/);
  });

  test('parseSums and diff', () => {
    const h = 'a'.repeat(64);
    assert.deepEqual([...parseSums(`${h}  node-x.tar.gz\r\nnot a hash line\n${h.toUpperCase()} *b.zip\n`)], [['node-x.tar.gz', h], ['b.zip', h]]);
    assert.deepEqual(diff({ a: { b: 1, c: 2 } }, { a: { b: 1, c: 3, d: { e: 4 } } }), ['a.c: 2 -> 3', 'a.d.e: (none) -> 4']);
    assert.deepEqual(diff({ a: 1 }, { a: 1 }), []);
  });
});

describe('syntax and static checks of the scripts', () => {
  test('sh -n install.sh', () => {
    const r = spawnSync('sh', ['-n', join(AGENT_SRC, 'install.sh')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });
  test('shellcheck install.sh', { skip: !has('shellcheck') && 'shellcheck not installed' }, () => {
    const r = spawnSync('shellcheck', ['-s', 'sh', '-S', 'warning', join(AGENT_SRC, 'install.sh')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout);
  });
  test('PowerShell parser accepts install.ps1', { skip: !has('pwsh') && 'pwsh not installed' }, () => {
    const cmd = `$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${join(AGENT_SRC, 'install.ps1')}',[ref]$null,[ref]$e);if($e){$e|%{$_.Message};exit 1}`;
    const r = spawnSync('pwsh', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
  test('install.ps1 asks for consent once before any download, skipped by an existing config, and never on a start', () => {
    const t = readFileSync(join(AGENT_SRC, 'install.ps1'), 'utf8');
    const i = t.indexOf('Read-Host'), d = t.indexOf('Invoke-RestMethod');
    assert.ok(i > 0 && i < d, 'asked before the manifest download');
    assert.match(t, /Test-Path -LiteralPath \(Join-Path \$Dir 'config\.json'\)/);
    assert.match(t, /\$env:DRA_CONSENT/);
    assert.match(t, /ให้บอทอัดจอเครื่องนี้ไหม\? \(y\/N\)/);
    assert.match(t, /ยกเลิกการติดตั้ง ไม่ได้ติดตั้งอะไร/);
  });
  test('install.ps1 validates the token before use, never prints it and never calls exit', () => {
    const t = readFileSync(join(AGENT_SRC, 'install.ps1'), 'utf8');
    const re = "'\\A[A-Za-z0-9_-]+\\z'"; // \A..\z: '$' would accept a trailing newline
    assert.ok(t.indexOf(re) > 0 && t.indexOf(re) < t.indexOf('$env:DRA_TOKEN = $Token'));
    assert.ok(!t.includes('--token'), 'the token never goes on a command line');
    assert.match(t, /\$env:DRA_TOKEN = \$Token\s+try \{ & \$nodeExe \$main --server \$Server --pair-only --consent \} finally \{ Remove-Item Env:DRA_TOKEN/);
    assert.ok(!/Write-Host[^\n]*\$Token/.test(t));
    assert.ok(!/^\s*exit\b/m.test(t));
    assert.match(t, /Get-FileHash -Algorithm SHA256/);
    assert.match(t, /Expand-Archive/);
  });
  test('PowerShell: the token check refuses a trailing newline', { skip: !has('pwsh') && 'pwsh not installed' }, () => {
    const cmd = "foreach ($t in @('AbC_-1', \"AbC_-1`n\", \"AbC_-1`r`n\", 'a b', 'a;b')) { Write-Output (\"$($t -notmatch '\\A[A-Za-z0-9_-]+\\z')\") }";
    const r = spawnSync('pwsh', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' });
    assert.deepEqual(r.stdout.trim().split(/\r?\n/), ['False', 'True', 'True', 'True', 'True']);
  });
  test('install.sh hands the token over in the environment, never as an argument', () => {
    const t = readFileSync(join(AGENT_SRC, 'install.sh'), 'utf8');
    assert.ok(!t.includes('--token'));
    assert.match(t, /TOKEN="\$\{DRA_TOKEN:-\$\{1:-\}\}"\s+unset DRA_TOKEN/);
    assert.match(t, /DRA_TOKEN="\$TOKEN" "\$NODE" "\$MAIN" --server "\$SERVER" --pair-only/);
  });
  test('neither script mentions the Discord bot token or the system node/ffmpeg', () => {
    for (const n of ['install.sh', 'install.ps1']) {
      const t = readFileSync(join(AGENT_SRC, n), 'utf8');
      assert.ok(!/DISCORD_TOKEN/.test(t), n);
      assert.ok(!/command -v (node|ffmpeg)\b/.test(t), n);
    }
  });
});

// --- install.sh against a fake bot -------------------------------------------------
const host = { darwin: 'darwin', linux: 'linux' }[process.platform];
const arch = { arm64: 'arm64', x64: 'x64' }[process.arch];
const TARGET = host && arch ? `${host}-${arch}` : null;
const skipE2E = (!TARGET || !has('zip') || !has('curl') || TARGET === 'linux-arm64') && 'needs a posix host with curl and zip';

// fake node: records its calls, "pairs" when told to
const FAKE_NODE = (tag) => `#!/bin/sh
echo "${tag} $*\${DRA_TOKEN:+ DRA_TOKEN=\$DRA_TOKEN}" >> "$DRA_HOME/calls.log"
case " $* " in *" --pair-only "*)
  [ "\${FAKE_PAIR:-ok}" = ok ] || exit 1
  echo '{"deviceId":"d","secret":"s"}' > "$DRA_HOME/config.json" ;;
esac
`;

describe('install.sh end to end (fake bot, fake archives)', { skip: skipE2E }, () => {
  let root, server, base, hits, blobs, agentDir, pins, scriptOf;
  const sh = (name, tag) => `#!/bin/sh\n# ${tag}\n`;

  const makeBlobs = (tag) => {
    const w = mkdtempSync(join(root, 'mk-'));
    mkdirSync(join(w, 'node-v1', 'bin'), { recursive: true });
    writeFileSync(join(w, 'node-v1', 'bin', 'node'), FAKE_NODE(tag)); chmodSync(join(w, 'node-v1', 'bin', 'node'), 0o755);
    spawnSync('tar', ['-czf', join(w, 'node.tgz'), '-C', w, 'node-v1']);
    writeFileSync(join(w, 'ffmpeg'), sh('ffmpeg', tag)); chmodSync(join(w, 'ffmpeg'), 0o755);
    spawnSync('zip', ['-q', '-j', join(w, 'ffmpeg.zip'), join(w, 'ffmpeg')]);
    return { node: readFileSync(join(w, 'node.tgz')), ffmpeg: readFileSync(join(w, 'ffmpeg.zip')) };
  };
  const setPins = () => writeFileSync(join(agentDir, 'pins.json'), JSON.stringify({
    node: { version: '1.0.0', [TARGET]: { url: `${base}/blob/node.tgz`, sha256: sha(blobs.node) } },
    ffmpeg: { version: '1.0.0', [TARGET]: { url: `${base}/blob/ffmpeg.zip`, sha256: sha(blobs.ffmpeg) } },
  }));
  const reload = () => { setPins(); scriptOf = loadAgentAssets(agentDir, base); };

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'dra-install-'));
    agentDir = join(root, 'agent'); mkdirSync(agentDir);
    writeFileSync(join(agentDir, 'main.js'), 'export const v = 1;\n');
    writeFileSync(join(agentDir, 'link.js'), 'export const l = 1;\n');
    copyFileSync(join(AGENT_SRC, 'install.sh'), join(agentDir, 'install.sh'));
    copyFileSync(join(AGENT_SRC, 'install.ps1'), join(agentDir, 'install.ps1'));
    hits = [];
    server = createServer((req, res) => {
      hits.push(req.url);
      const a = scriptOf;
      const send = (b, t = 'application/octet-stream') => { res.writeHead(200, { 'Content-Type': t }); res.end(b); };
      if (req.url === '/agent/manifest.json') return send(a.manifest, 'application/json');
      if (req.url.startsWith('/agent/files/')) { const f = a.files.get(req.url.slice(13)); return f ? send(f) : (res.writeHead(404), res.end()); }
      if (req.url === '/blob/node.tgz') return send(blobs.node);
      if (req.url === '/blob/ffmpeg.zip') return send(blobs.ffmpeg);
      res.writeHead(404); res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    blobs = makeBlobs('v1');
    reload();
  });
  after(() => { server?.close(); if (root) rmSync(root, { recursive: true, force: true }); });

  // runs the script the way curl | sh does: script on stdin, token as the first argument
  const run = (home, { token, env = {}, script } = {}) => new Promise((resolve) => {
    const text = script ?? scriptOf.scripts.get('install.sh').toString();
    const args = ['-s', '--', ...(token === undefined ? [] : [token])];
    const p = spawn('sh', args, { env: { PATH: process.env.PATH, HOME: join(home, '..', 'home'), DRA_HOME: home, DRA_NO_START: '1', DRA_CONSENT: 'y', ...env } });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
    p.stdin.end(text);
  });
  const fresh = () => { const h = mkdtempSync(join(root, 'inst-')); mkdirSync(join(h, '..', 'home'), { recursive: true }); return join(h, 'agent-home'); };
  const calls = (home) => readFileSync(join(home, 'calls.log'), 'utf8').trim().split('\n');
  const TOKEN = 'AbC123_-xyzAbC123_-xyzAA';

  test('fresh install: own node + ffmpeg + agent files, paired with the token, Thai guidance, token never printed', async () => {
    const home = fresh();
    const r = await run(home, { token: TOKEN });
    assert.equal(r.code, 0, r.err + r.out);
    assert.ok(existsSync(join(home, 'node', 'bin', 'node')));
    assert.ok(existsSync(join(home, 'bin', 'ffmpeg')));
    assert.equal(readFileSync(join(home, 'app', 'main.js'), 'utf8'), 'export const v = 1;\n');
    assert.equal(readFileSync(join(home, 'app', 'package.json'), 'utf8'), '{"type":"module"}\n');
    assert.equal(readFileSync(join(home, 'node', '.sha256'), 'utf8').trim(), sha(blobs.node));
    assert.match(readFileSync(join(home, 'start.command'), 'utf8'), /exec "\$D\/node\/bin\/node" "\$D\/app\/main\.js"/);
    assert.deepEqual(calls(home), [`v1 ${join(home, 'app', 'main.js')} --server ${base} --pair-only --consent DRA_TOKEN=${TOKEN}`], 'token in the env only');
    assert.ok(!(r.out + r.err).includes(TOKEN));
    assert.match(r.out, /ติดตั้งเสร็จแล้ว/);
    assert.match(r.out, /ตัวอัดจะอัดเฉพาะตอนที่บอทสั่ง.*กด s/);
    if (host === 'darwin') { assert.match(r.out, /Screen Recording/); assert.match(r.out, /Terminal/); assert.match(r.out, /Gatekeeper/); }
    assert.ok(!existsSync(join(home, 'tmp')), 'tmp cleaned');
  });

  test('prints how to start, uninstall and update later; uninstall.command asks, then removes autostart and the folder', async () => {
    const home = fresh();
    const r = await run(home, { token: TOKEN });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /📌 คำสั่งที่ใช้ภายหลัง/);
    assert.ok(r.out.includes(`เปิดตัวอัด:  "${join(home, 'start.command')}"`), r.out);
    assert.ok(r.out.includes(`ลบตัวอัด:    "${join(home, 'uninstall.command')}"`), r.out);
    assert.match(r.out, /อัปเดต: .*\/agent/);
    const un = join(home, 'uninstall.command'), fakeHome = join(home, '..', 'home');
    const sh = (env) => new Promise((res) => {
      const p = spawn('sh', [un], { env: { PATH: process.env.PATH, HOME: fakeHome, ...env } });
      let out = ''; p.stdout.on('data', (d) => { out += d; }); p.on('close', (code) => res({ code, out }));
    });
    let u = await sh({ DRA_UNINSTALL: 'n' });
    assert.equal(u.code, 0); assert.match(u.out, /ยกเลิก ไม่ได้ลบอะไร/); assert.ok(existsSync(join(home, 'app', 'main.js')));
    const la = join(fakeHome, 'Library', 'LaunchAgents'); mkdirSync(la, { recursive: true });
    writeFileSync(join(la, 'com.discord-recorder.agent.plist'), '<plist/>');
    const lc = join(home, '..', 'fake-launchctl-un'), log = join(home, '..', 'launchctl-un.log');
    writeFileSync(lc, `#!/bin/sh\necho "$@" >> "${log}"\n`); chmodSync(lc, 0o755);
    u = await sh({ DRA_UNINSTALL: 'Yes', DRA_LAUNCHCTL: lc });
    assert.equal(u.code, 0); assert.match(u.out, /ลบตัวอัดแล้ว.*🗑️/);
    assert.ok(!existsSync(home), 'folder removed');
    assert.ok(!existsSync(join(la, 'com.discord-recorder.agent.plist')), 'autostart removed');
    assert.match(readFileSync(log, 'utf8'), /bootout gui\/\d+ /);
  });

  test('uninstall.command refuses a folder that is not an agent install', async () => {
    const home = fresh();
    await run(home, { token: TOKEN });
    const elsewhere = join(home, '..', 'not-agent'); mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, 'keep.txt'), 'x');
    writeFileSync(join(elsewhere, 'uninstall.command'), readFileSync(join(home, 'uninstall.command')));
    const code = await new Promise((res) => spawn('sh', [join(elsewhere, 'uninstall.command')], { env: { PATH: process.env.PATH, DRA_UNINSTALL: 'y' } }).on('close', res));
    assert.equal(code, 1); assert.ok(existsSync(join(elsewhere, 'keep.txt')));
  });

  describe('consent (asked once, before any download)', () => {
    const asked = (r) => /ให้บอทอัดจอเครื่องนี้ไหม|ตัวอัดจะให้บอทอัดทั้งจอ/.test(r.out);
    test('n (or anything but y): prints the cancel line, exits 0, downloads and pairs nothing', async () => {
      for (const a of ['n', '', 'maybe']) {
        const home = fresh(); hits.length = 0;
        const r = await run(home, { token: TOKEN, env: { DRA_CONSENT: a || 'x' } });
        assert.equal(r.code, 0, r.err);
        assert.match(r.out, /ตัวอัดจะให้บอทอัดทั้งจอ.*กด s/);
        assert.match(r.out, /ยกเลิกการติดตั้ง ไม่ได้ติดตั้งอะไร/);
        assert.equal(hits.length, 0, `nothing fetched: ${hits}`);
        assert.ok(!existsSync(home), 'nothing installed');
      }
    });
    test('yes in any case counts as yes', async () => {
      const home = fresh();
      const r = await run(home, { token: TOKEN, env: { DRA_CONSENT: 'Yes' } });
      assert.equal(r.code, 0, r.err + r.out);
      assert.match(calls(home)[0], /--pair-only --consent/);
    });
    test('y installs and passes --consent to the pair call', async () => {
      const home = fresh();
      const r = await run(home, { token: TOKEN, env: { DRA_CONSENT: 'y' } });
      assert.equal(r.code, 0, r.err + r.out);
      assert.ok(asked(r));
      assert.match(calls(home)[0], /--pair-only --consent/);
    });
    test('no tty and no DRA_CONSENT counts as no, with a Thai hint to run it in a terminal', { skip: spawnSync('sh', ['-c', ': </dev/tty']).status === 0 && 'a controlling tty exists here' }, async () => {
      const home = fresh(); hits.length = 0;
      const r = await run(home, { token: TOKEN, env: { DRA_CONSENT: '' } });
      assert.equal(r.code, 0);
      assert.match(r.out, /ยกเลิกการติดตั้ง ไม่ได้ติดตั้งอะไร.*Terminal/);
      assert.equal(hits.length, 0);
    });
    test('an existing config (an update, or from before this change) is never asked, even with n', async () => {
      const home = fresh(); mkdirSync(home, { recursive: true });
      writeFileSync(join(home, 'config.json'), '{"deviceId":"d","secret":"s","askFirst":true}');
      const r = await run(home, { env: { DRA_CONSENT: 'n' } });
      assert.equal(r.code, 0, r.err + r.out);
      assert.ok(!asked(r));
      assert.ok(existsSync(join(home, 'app', 'main.js')), 'updated');
    });
  });

  test('the token can come in DRA_TOKEN (nothing in argv), and is not passed on except to the pair call', async () => {
    const home = fresh();
    const r = await run(home, { env: { DRA_TOKEN: TOKEN } });
    assert.equal(r.code, 0, r.err + r.out);
    assert.deepEqual(calls(home), [`v1 ${join(home, 'app', 'main.js')} --server ${base} --pair-only --consent DRA_TOKEN=${TOKEN}`]);
    assert.ok(!(r.out + r.err).includes(TOKEN));
  });

  test('without DRA_NO_START it ends by starting the installed agent with no args (keys come from the tty, never auto-records)', async () => {
    const home = fresh();
    const r = await run(home, { token: TOKEN, env: { DRA_NO_START: '0' } });
    assert.equal(r.code, 0, r.err);
    assert.equal(calls(home).at(-1), `v1 ${join(home, 'app', 'main.js')}`);
  });

  test('re-run with a spent token updates in place and keeps the pairing; unchanged node/ffmpeg are not downloaded again', async () => {
    const home = fresh();
    assert.equal((await run(home, { token: TOKEN })).code, 0);
    writeFileSync(join(agentDir, 'main.js'), 'export const v = 2;\n'); reload();
    hits.length = 0;
    const r = await run(home, { token: TOKEN, env: { FAKE_PAIR: 'fail' } });
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /ใช้การเชื่อมต่อเดิม/);
    assert.equal(readFileSync(join(home, 'app', 'main.js'), 'utf8'), 'export const v = 2;\n');
    assert.ok(!hits.some((u) => u.startsWith('/blob/')), `no blob downloads: ${hits}`);
    assert.match(r.out, /เป็นเวอร์ชันล่าสุดแล้ว/);
    writeFileSync(join(agentDir, 'main.js'), 'export const v = 1;\n'); reload();
  });

  test('no token: an existing pairing is kept, a missing one is a Thai error', async () => {
    const home = fresh();
    const bad = await run(home);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /ยังไม่ได้เชื่อมกับบอท/);
    assert.equal((await run(home, { token: TOKEN })).code, 0);
    const again = await run(home);
    assert.equal(again.code, 0, again.err);
    assert.ok(!calls(home).slice(1).some((l) => l.includes('--pair-only')), 'no second pairing');
  });

  test('a failed pairing with no previous pairing aborts', async () => {
    const home = fresh();
    const r = await run(home, { token: TOKEN, env: { FAKE_PAIR: 'fail' } });
    assert.equal(r.code, 1);
    assert.match(r.err, /เชื่อมกับบอทไม่สำเร็จ/);
  });

  test('a node archive that does not match its pinned sha256 aborts and leaves the previous install intact', async () => {
    const home = fresh();
    assert.equal((await run(home, { token: TOKEN })).code, 0);
    const good = blobs;
    blobs = makeBlobs('v2');
    const realPins = () => JSON.parse(readFileSync(join(agentDir, 'pins.json'), 'utf8'));
    // pins describe the old node, the server serves different bytes
    writeFileSync(join(agentDir, 'pins.json'), JSON.stringify({
      node: { version: '2', [TARGET]: { url: `${base}/blob/node.tgz`, sha256: sha('something else') } },
      ffmpeg: { version: '1.0.0', [TARGET]: { url: `${base}/blob/ffmpeg.zip`, sha256: sha(good.ffmpeg) } },
    }));
    scriptOf = loadAgentAssets(agentDir, base);
    void realPins;
    const r = await run(home, { token: TOKEN });
    assert.equal(r.code, 1);
    assert.match(r.err, /ไม่ตรงกับค่า SHA-256/);
    assert.match(r.err, /ของเดิมไม่ถูกแตะ/);
    assert.match(readFileSync(join(home, 'node', 'bin', 'node'), 'utf8'), /^#!\/bin\/sh\necho "v1 /);
    assert.equal(readFileSync(join(home, 'node', '.sha256'), 'utf8').trim(), sha(good.node));
    assert.deepEqual(readdirSync(home).filter((n) => n.endsWith('.old') || n === 'tmp'), []);
    blobs = good; reload();
  });

  test('an ffmpeg archive with the wrong hash aborts before anything is replaced', async () => {
    const home = fresh();
    const good = blobs;
    writeFileSync(join(agentDir, 'pins.json'), JSON.stringify({
      node: { version: '1', [TARGET]: { url: `${base}/blob/node.tgz`, sha256: sha(good.node) } },
      ffmpeg: { version: '1', [TARGET]: { url: `${base}/blob/ffmpeg.zip`, sha256: sha('nope') } },
    }));
    scriptOf = loadAgentAssets(agentDir, base);
    const r = await run(home, { token: TOKEN });
    assert.equal(r.code, 1);
    assert.match(r.err, /ffmpeg ไม่ตรงกับค่า SHA-256/);
    assert.ok(!existsSync(join(home, 'bin', 'ffmpeg')));
    assert.ok(!existsSync(join(home, 'app')), 'agent files are not installed after a failed download');
    reload();
  });

  test('an agent file that does not match the manifest aborts and keeps the old app', async () => {
    const home = fresh();
    assert.equal((await run(home, { token: TOKEN })).code, 0);
    const a = scriptOf;
    scriptOf = { ...a, files: new Map([...a.files, ['link.js', Buffer.from('tampered')]]) };
    const r = await run(home, { token: TOKEN });
    scriptOf = a;
    assert.equal(r.code, 1);
    assert.match(r.err, /ไฟล์ link\.js ไม่ตรงกับค่า SHA-256/);
    assert.equal(readFileSync(join(home, 'app', 'link.js'), 'utf8'), 'export const l = 1;\n');
  });

  test('a hostile token never reaches a command: rejected before any request', async () => {
    const home = fresh();
    const mark = join(home, '..', 'pwned');
    hits.length = 0;
    for (const token of [`x;touch ${mark}`, '$(touch pwned)', '`id`', 'a b', "a'b", 'a\nb', '--server=https://evil.example.com', '../x']) {
      const r = await run(home, { token });
      // "--server=..." and "../x" fail the base64url check as well ('=' and '/' are outside it)
      assert.equal(r.code, 1, token);
      assert.match(r.err, /โทเคนไม่ถูกต้อง/);
    }
    assert.ok(!existsSync(mark));
    assert.deepEqual(hits, [], 'nothing was requested');
    assert.ok(!existsSync(join(home, 'calls.log')));
  });

  test('a manifest with an unsafe agent file name or a non-https download url is refused', async () => {
    const home = fresh();
    const a = scriptOf;
    const m = JSON.parse(a.manifest.toString());
    const withManifest = (mm) => { scriptOf = { ...a, manifest: Buffer.from(JSON.stringify(mm, null, 2)) }; };
    withManifest({ ...m, files: [{ name: '../evil.js', sha256: sha('x') }, ...m.files] });
    let r = await run(home, { token: TOKEN });
    assert.equal(r.code, 1);
    assert.match(r.err, /ชื่อไฟล์ในรายการไม่ถูกต้อง/);
    withManifest({ ...m, node: { ...m.node, [TARGET]: { ...m.node[TARGET], url: 'http://evil.example.com/node.tgz' } } });
    r = await run(home, { token: TOKEN });
    assert.equal(r.code, 1);
    assert.match(r.err, /ไม่ใช่ https/);
    scriptOf = a;
  });

  test('the real manifest format from loadAgentAssets is parsed (names, hashes, pins)', async () => {
    // guards against drift between A1's JSON.stringify layout and the awk reader in install.sh
    const m = JSON.parse(scriptOf.manifest.toString());
    assert.deepEqual(m.files.map((f) => f.name), ['link.js', 'main.js']);
    const home = fresh();
    assert.equal((await run(home, { token: TOKEN })).code, 0);
    assert.deepEqual(readdirSync(join(home, 'app')).sort(), ['link.js', 'main.js', 'package.json']);
  });

  test('autostart is opt-in: default writes nothing; DRA_AUTOSTART=1 writes a Terminal launcher plist and loads it, without starting a second agent', { skip: host !== 'darwin' && 'macOS only' }, async () => {
    const home = fresh();
    const fakeHome = join(home, '..', 'home');
    let r = await run(home, { token: TOKEN });
    assert.equal(r.code, 0, r.err);
    assert.ok(!existsSync(join(fakeHome, 'Library')), 'default: nothing written');
    assert.match(r.out, /ไม่ได้ตั้งเปิดอัตโนมัติ/);

    const lc = join(home, '..', 'fake-launchctl');
    writeFileSync(lc, `#!/bin/sh\necho "$@" >> "${join(home, '..', 'launchctl.log')}"\n`); chmodSync(lc, 0o755);
    r = await run(home, { token: TOKEN, env: { DRA_AUTOSTART: '1', DRA_LAUNCHCTL: lc, DRA_NO_START: '0', FAKE_PAIR: 'fail' } });
    assert.equal(r.code, 0, r.err);
    const plist = readFileSync(join(fakeHome, 'Library', 'LaunchAgents', 'com.discord-recorder.agent.plist'), 'utf8');
    assert.match(plist, /<string>\/usr\/bin\/open<\/string><string>-a<\/string><string>Terminal<\/string><string>[^<]*start\.command<\/string>/);
    assert.match(readFileSync(join(home, '..', 'launchctl.log'), 'utf8'), /bootstrap gui\/\d+ .*com\.discord-recorder\.agent\.plist/);
    assert.ok(!calls(home).some((l) => l.endsWith('main.js')), 'agent not also started in the foreground');
  });
});
