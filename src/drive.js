import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { google } from 'googleapis';

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, DRIVE_FOLDER_ID } = process.env;

export const driveEnabled = Boolean(GOOGLE_REFRESH_TOKEN && DRIVE_FOLDER_ID);

const FOLDER = 'application/vnd.google-apps.folder';
const shared = { supportsAllDrives: true, includeItemsFromAllDrives: true };

/** a Drive folder / file name from a Discord name: no `/` or control chars, trimmed, ~100 chars; fallback if empty */
export const safeName = (s, fallback = '-') =>
  String(s ?? '').replace(/[\x00-\x1f\x7f/]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100).trim() || String(fallback);

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/**
 * resolveFolders(['Server', 'Room']) -> the id of root/Server/Room, found or created level by level.
 * Ids are cached by path as promises (so concurrent calls share one find-or-create); a failed level is
 * forgotten. Any failure answers the root: a recording is never lost because of its folders.
 */
export function folderResolver(drive, rootId) {
  const cache = new Map(); // JSON path -> Promise<folder id>
  const level = (parent, key, name) => {
    if (cache.has(key)) return cache.get(key);
    const p = (async () => {
      const { data } = await drive.files.list({
        q: `name='${esc(name)}' and '${parent}' in parents and mimeType='${FOLDER}' and trashed=false`,
        fields: 'files(id)', pageSize: 1, ...shared,
      });
      if (data.files?.[0]?.id) return data.files[0].id;
      const made = await drive.files.create({ requestBody: { name, mimeType: FOLDER, parents: [parent] }, fields: 'id', supportsAllDrives: true });
      return made.data.id;
    })();
    cache.set(key, p);
    p.catch(() => cache.delete(key));
    return p;
  };
  const resolve = async (folders = []) => {
    try {
      let id = rootId;
      for (let k = 0; k < folders.length; k++) id = await level(id, JSON.stringify(folders.slice(0, k + 1)), folders[k]);
      return id;
    } catch (e) {
      console.error('Drive folder failed, uploading to the root:', e);
      return rootId;
    }
  };
  resolve.forget = () => cache.clear(); // a cached folder was deleted on Drive
  return resolve;
}

let client;
const getClient = () => {
  if (client) return client;
  const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  const drive = google.drive({ version: 'v3', auth });
  return (client = { drive, resolve: folderResolver(drive, DRIVE_FOLDER_ID) });
};

/** upload a local file into DRIVE_FOLDER_ID/<folders...>, returns the Drive view link */
export async function uploadToDrive(file, name = basename(file), folders = []) {
  const { drive, resolve } = getClient();
  const parent = await resolve(folders);
  try {
    const { data } = await drive.files.create({
      requestBody: { name, parents: [parent] },
      media: { body: createReadStream(file) },
      fields: 'id, webViewLink',
      supportsAllDrives: true,
    });
    return data.webViewLink;
  } catch (e) {
    if (e?.code === 404 || e?.status === 404) resolve.forget();
    throw e;
  }
}
