import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { google } from 'googleapis';

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, DRIVE_FOLDER_ID } = process.env;

export const driveEnabled = Boolean(GOOGLE_REFRESH_TOKEN && DRIVE_FOLDER_ID);

/** upload a local file into DRIVE_FOLDER_ID, returns the Drive view link */
export async function uploadToDrive(file, name = basename(file)) {
  const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  const drive = google.drive({ version: 'v3', auth });
  const { data } = await drive.files.create({
    requestBody: { name, parents: [DRIVE_FOLDER_ID] },
    media: { body: createReadStream(file) },
    fields: 'id, webViewLink',
    supportsAllDrives: true,
  });
  return data.webViewLink;
}
