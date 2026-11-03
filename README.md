# discord-recorder

บอท Discord อัดเสียงใน voice channel และอัดหน้าจอเครื่องที่รันบอท (macOS) แล้วส่งไฟล์กลับใน Discord หรืออัปโหลดขึ้น Google Drive

## คำสั่ง

| คำสั่ง | ทำอะไร |
|---|---|
| `/record start` | เข้า voice channel ที่คุณอยู่ แล้วอัดเสียงแยกรายคน |
| `/record stop` | หยุดอัด รวมเป็น `voice.mp3` แล้วส่งไฟล์หรือลิงก์ Drive |
| `/screen start` / `/screen stop` | อัด / หยุดอัดหน้าจอเครื่องที่รันบอท |

ระหว่าง `/record` ถ้ามีคนแชร์หน้าจอในห้อง บอทจะเริ่มอัดหน้าจอเครื่องที่รันบอทเอง และหยุดเมื่อเลิกแชร์
(Discord ไม่ให้บอทรับภาพ screen share ของคนอื่น จึงอัดได้เฉพาะจอเครื่องที่รันบอท)

## ติดตั้ง

ต้องมี Node.js และ ffmpeg (`brew install ffmpeg`)

```
npm install
cp .env.example .env   # แล้วกรอกค่า
npm start
```

- `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`: จาก Discord Developer Portal และ Copy Server ID
- `AUTO_SCREEN_USER_IDS`: (ไม่บังคับ) user ID ที่การแชร์จอจะเริ่มอัดวิดีโออัตโนมัติ
- `SCREEN_DEVICE`: index ของจอจาก `ffmpeg -f avfoundation -list_devices true -i ""`
- ครั้งแรกต้องเปิด Screen Recording ให้ Terminal/Cursor ที่ System Settings → Privacy & Security

## อัปโหลดขึ้น Google Drive

ถ้าตั้งค่าครบ บอทจะส่งลิงก์ Drive แทนการแนบไฟล์ ถ้าไม่ตั้ง จะแนบไฟล์ใน Discord (ไม่เกิน 10MB)

1. ที่ [Google Cloud Console](https://console.cloud.google.com/) สร้าง project แล้วเปิด **Google Drive API**
2. OAuth consent screen: เลือก External แล้วเพิ่มอีเมลของคุณเป็น Test user
3. Credentials → Create OAuth client ID ชนิด **Web application** ใส่ Authorized redirect URI เป็น `http://localhost:53682`
4. ใส่ `GOOGLE_CLIENT_ID` และ `GOOGLE_CLIENT_SECRET` ใน `.env`
5. ใส่ `DRIVE_FOLDER_ID` เป็นรหัสท้าย URL ของโฟลเดอร์ (`drive.google.com/drive/folders/<รหัสนี้>`)
6. รัน `npm run drive-auth` เปิดลิงก์ที่แสดงแล้วอนุญาต จะได้ `GOOGLE_REFRESH_TOKEN` ให้ใส่ใน `.env`
7. รัน `npm start` ใหม่

บัญชีที่อนุญาตต้องมีสิทธิ์แก้ไขโฟลเดอร์นั้น ถ้า OAuth app ยังเป็นโหมด Testing refresh token จะหมดอายุทุก 7 วัน
ให้รัน `drive-auth` ใหม่ หรือ Publish app เพื่อไม่ให้หมดอายุ

## ข้อควรระวัง

- แจ้งทุกคนในห้องก่อนอัดเสียง
- `/screen` อัดจอเครื่องคุณจริง ใช้ `ALLOWED_USER_IDS` จำกัดคนที่สั่งได้
- อย่า commit `.env`
