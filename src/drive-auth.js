// one-time: npm run drive-auth  -> prints GOOGLE_REFRESH_TOKEN for .env
import 'dotenv/config';
import http from 'node:http';
import { google } from 'googleapis';

const PORT = 53682;
const auth = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, `http://localhost:${PORT}`,
);
const url = auth.generateAuthUrl({
  access_type: 'offline', prompt: 'consent', scope: ['https://www.googleapis.com/auth/drive'],
});
console.log('เปิดลิงก์นี้ในเบราว์เซอร์แล้วอนุญาต:\n\n' + url + '\n');

const server = http.createServer(async (req, res) => {
  const code = new URL(req.url, `http://localhost:${PORT}`).searchParams.get('code');
  if (!code) return res.end('waiting for code');
  const { tokens } = await auth.getToken(code);
  res.end('เสร็จแล้ว ปิดหน้านี้ได้');
  console.log('GOOGLE_REFRESH_TOKEN=' + tokens.refresh_token);
  server.close();
});
server.listen(PORT);
