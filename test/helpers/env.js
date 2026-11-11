import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// import this BEFORE any src module: it isolates settings + recordings/ in a tmp dir (each test file = own process)
export const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'dr-test-')));
process.env.SETTINGS_FILE = join(tmp, 'data', 'settings.json');
process.env.TIMEZONE = 'Asia/Bangkok';
process.chdir(tmp); // recordings/ is relative to cwd
process.on('exit', () => { // leave the dir first, then remove it
  try { process.chdir(tmpdir()); } catch {}
  rmSync(tmp, { recursive: true, force: true });
});
