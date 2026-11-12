// Maintainer tool: `npm run build:agent` refreshes src/agent/pins.json (pinned Node + ffmpeg URLs with SHA-256).
//   npm run build:agent                       re-verify the pinned URLs, print the diff, write pins.json
//   npm run build:agent -- --dry              same, write nothing
//   npm run build:agent -- --no-download      trust the publishers' hash files, do not download the archives
//   npm run build:agent -- --bump node=24.22.2 --bump ffmpeg=latest
// Sources (nothing else is ever fetched): nodejs.org (hash from the official SHASUMS256.txt), ffmpeg.martin-riedl.de
// (macOS + Linux, release builds, hash from its .sha256 file) and www.gyan.dev (Windows, versioned release "essentials"
// build, hash from its .sha256 file). Not BtbN: it keeps only the last 14 daily builds (+ one a month), so a pinned
// autobuild URL disappears; gyan.dev keeps every release package under /ffmpeg/builds/packages/.
// Archives are streamed into a hash and never written to disk or run.
// Review the printed diff in git before committing: the install scripts trust whatever hash ends up here.
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PINS_FILE = fileURLToPath(new URL('../src/agent/pins.json', import.meta.url));
export const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win-x64'];
export const TRUSTED = ['nodejs.org', 'ffmpeg.martin-riedl.de', 'www.gyan.dev'];
const NODE_EXT = { 'darwin-arm64': 'tar.gz', 'darwin-x64': 'tar.gz', 'linux-x64': 'tar.gz', 'win-x64': 'zip' };
const MARTIN = { 'darwin-arm64': 'macos/arm64', 'darwin-x64': 'macos/amd64', 'linux-x64': 'linux/amd64' };
const GYAN = 'https://www.gyan.dev/ffmpeg/builds';
export const gyanUrl = (v) => `${GYAN}/packages/ffmpeg-${v}-essentials_build.zip`;

// first version of the pins (used only when pins.json does not exist yet)
export const SEED = {
  node: { version: '24.22.2' },
  ffmpeg: {
    version: '9.0.2',
    'darwin-arm64': { url: 'https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip' },
    'darwin-x64': { url: 'https://ffmpeg.martin-riedl.de/download/macos/amd64/1789931006_9.0.2/ffmpeg.zip' },
    'linux-x64': { url: 'https://ffmpeg.martin-riedl.de/download/linux/amd64/1789931100_9.0.2/ffmpeg.zip' },
    'win-x64': { url: gyanUrl('9.0.2') },
  },
};

export const nodeUrl = (v, t) => `https://nodejs.org/dist/v${v}/node-v${v}-${t}.${NODE_EXT[t]}`;
const trusted = (u) => { const x = new URL(u); return x.protocol === 'https:' && TRUSTED.includes(x.hostname); };
const hex64 = (s) => /^[0-9a-f]{64}$/.test(s);

async function get(fetchFn, url, opts) {
  if (!trusted(url)) throw new Error(`untrusted url: ${url}`);
  const res = await fetchFn(url, opts);
  if (opts?.redirect === 'manual' && res.status >= 300 && res.status < 400) return res;
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}
const text = async (fetchFn, url) => (await get(fetchFn, url)).text();

async function sha256Of(fetchFn, url) {
  const h = createHash('sha256');
  for await (const chunk of (await get(fetchFn, url)).body) h.update(chunk);
  return h.digest('hex');
}

// "<hash>  <file>" lines (SHASUMS256.txt, checksums.sha256) -> Map(file -> hash)
export function parseSums(t) {
  const m = new Map();
  for (const line of t.split(/\r?\n/)) {
    const x = /^([0-9a-fA-F]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (x) m.set(x[2], x[1].toLowerCase());
  }
  return m;
}

// newest martin-riedl release build for a target: the redirect Location is the pinned download URL
async function martinLatest(fetchFn, t) {
  const res = await get(fetchFn, `https://ffmpeg.martin-riedl.de/redirect/latest/${MARTIN[t]}/release/ffmpeg.zip`, { redirect: 'manual' });
  const loc = res.headers.get('location');
  const m = loc && /\/download\/[a-z]+\/[a-z0-9]+\/\d+_(\d+\.\d+(?:\.\d+)?)\/ffmpeg\.zip$/.exec(new URL(loc, 'https://ffmpeg.martin-riedl.de').pathname);
  if (!m) throw new Error(`no release redirect for ${t}`);
  return { url: new URL(loc, 'https://ffmpeg.martin-riedl.de').href, version: m[1] };
}

// newest gyan.dev release version (its release-version file, e.g. "9.0.2") -> the versioned package url
async function gyanLatest(fetchFn) {
  const v = (await text(fetchFn, `${GYAN}/release-version`)).trim();
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(v)) throw new Error(`gyan.dev release-version is not a version: ${v.slice(0, 40)}`);
  return { url: gyanUrl(v), version: v };
}

// -> { pins, changes: ['path: old -> new', ...] }. Pure besides fetchFn (injectable for tests).
export async function build({ pins: old = SEED, bump = {}, fetchFn = fetch, download = true, log = () => {} } = {}) {
  const pins = JSON.parse(JSON.stringify(old));
  pins.node ??= {}; pins.ffmpeg ??= {};

  if (bump.node) {
    if (!/^\d+\.\d+\.\d+$/.test(bump.node)) throw new Error(`bad node version: ${bump.node}`);
    pins.node.version = bump.node;
  }
  if (bump.ffmpeg) {
    for (const t of Object.keys(MARTIN)) {
      const r = await martinLatest(fetchFn, t);
      if (bump.ffmpeg !== 'latest' && bump.ffmpeg !== r.version) throw new Error(`ffmpeg ${r.version} is the latest release for ${t}, not ${bump.ffmpeg}`);
      pins.ffmpeg.version = r.version;
      pins.ffmpeg[t] = { url: r.url };
    }
    const win = await gyanLatest(fetchFn);
    if (win.version !== pins.ffmpeg.version) log(`  note: Windows ffmpeg is ${win.version}, macOS/Linux ${pins.ffmpeg.version}`);
    pins.ffmpeg['win-x64'] = { url: win.url };
  }

  // node: official SHASUMS256.txt is the source of truth; an archive that hashes differently aborts
  const v = pins.node.version;
  const sums = parseSums(await text(fetchFn, `https://nodejs.org/dist/v${v}/SHASUMS256.txt`));
  for (const t of TARGETS) {
    const url = nodeUrl(v, t), sha256 = sums.get(url.split('/').pop());
    if (!sha256) throw new Error(`SHASUMS256.txt has no entry for ${url.split('/').pop()}`);
    if (download) { log(`  node ${t}`); const got = await sha256Of(fetchFn, url); if (got !== sha256) throw new Error(`node ${t}: downloaded ${got} != SHASUMS256 ${sha256}`); }
    pins.node[t] = { url, sha256 };
  }

  // ffmpeg: the publisher's <url>.sha256 file (both publishers), cross-checked against the download
  for (const t of TARGETS) {
    const url = pins.ffmpeg[t]?.url;
    if (!url || !trusted(url)) throw new Error(`ffmpeg ${t}: missing or untrusted url`);
    const sha256 = (/^[0-9a-fA-F]{64}/.exec((await text(fetchFn, `${url}.sha256`)).trim()) ?? [])[0]?.toLowerCase();
    if (!hex64(sha256 ?? '')) throw new Error(`ffmpeg ${t}: no published sha256 for ${url}`);
    if (download) { log(`  ffmpeg ${t}`); const got = await sha256Of(fetchFn, url); if (got !== sha256) throw new Error(`ffmpeg ${t}: downloaded ${got} != published ${sha256}`); }
    pins.ffmpeg[t] = { url, sha256 };
  }

  return { pins, changes: diff(old, pins) };
}

// flat "path: old -> new" lines for the maintainer to review
export function diff(a, b, path = '') {
  const obj = (x) => x && typeof x === 'object';
  if (obj(a) || obj(b)) {
    const [x, y] = [obj(a) ? a : {}, obj(b) ? b : {}];
    return [...new Set([...Object.keys(x), ...Object.keys(y)])].flatMap((k) => diff(x[k], y[k], path ? `${path}.${k}` : k));
  }
  return a === b ? [] : [`${path}: ${a ?? '(none)'} -> ${b ?? '(removed)'}`];
}

export function readPins(file = PINS_FILE) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return SEED; throw e; }
}

function parseArgs(argv) {
  const o = { bump: {}, dry: false, download: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') o.dry = true;
    else if (a === '--no-download') o.download = false;
    else if (a === '--bump') { const [k, v] = (argv[++i] ?? '').split('='); if (!['node', 'ffmpeg'].includes(k) || !v) throw new Error('--bump node=<version> | ffmpeg=latest'); o.bump[k] = v; }
    else throw new Error(`unknown option: ${a}`);
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  console.log(`checking pins (${o.download ? 'downloading to hash, nothing is saved' : 'publisher hashes only'})`);
  const { pins, changes } = await build({ pins: readPins(), bump: o.bump, download: o.download, log: console.log });
  console.log(changes.length ? `changes:\n${changes.map((c) => `  ${c}`).join('\n')}` : 'pins unchanged');
  if (o.dry) return console.log('--dry: pins.json not written');
  const tmp = `${PINS_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(pins, null, 2)}\n`);
  renameSync(tmp, PINS_FILE);
  console.log(`wrote ${PINS_FILE}: review the diff in git before committing`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(`build:agent failed: ${e.message}`); process.exit(1); });
