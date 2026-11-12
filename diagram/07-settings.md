# 7. การตั้งค่าราย server

```mermaid
sequenceDiagram
    actor U as Admin
    participant B as index.js
    participant S as settings.js
    participant F as data/settings.json
    U->>B: /settings หรือปุ่ม ⚙️ หรือข้อความต้อนรับ (guildCreate)
    B->>S: getSettings guildId
    S-->>B: ค่าเริ่มต้นจาก env ทับด้วยค่าที่บันทึกไว้ (แปลงค่าเก่าตอนอ่าน ไม่เขียนทับไฟล์)
    B-->>U: หน้าแบบง่าย (configView quick) ข้อความ 2 บรรทัด + เมนูทีละเรื่อง<br/>config:share เมื่อมีคนแชร์จอ: ⚡ อัดอัตโนมัติ / 📣 ส่งการ์ดให้กดอัด / ⚪ ไม่ทำอะไร<br/>config:mode อัดจอด้วย: 🖥️ ตัวอัดในเครื่อง / 🌐 เบราว์เซอร์ (เฉพาะมี PUBLIC_URL)<br/>config:area กรอบอัด: 🖼️ ทั้งหน้าจอ / 💬 แค่หน้าต่าง Discord (เฉพาะมี PUBLIC_URL)<br/>config:who ใครกดอัดได้: 🔑 เฉพาะผู้ดูแล / 👥 ทุกคน (ซ่อนเมื่อมี ALLOWED_USER_IDS)<br/>ปุ่ม 🔧 ตั้งค่าเพิ่มเติม (config:page-limits), ✔️ เสร็จ
    U->>B: เลือกในเมนู (ตัวเลือกขึ้นต้นด้วยชื่อเรื่อง จึงเห็นค่าปัจจุบันในเมนู)
    B->>B: applyConfig customId values settings → patch (ตารางเดียวของทุกเมนู/ปุ่มเก่า: mode ต้องอยู่ใน modes, ตัวเลขว่าง/NaN ไม่บันทึก, who รับแค่ admins|all, days เป็น 0-6 ไม่ซ้ำ เรียงลำดับ) ไม่ได้ patch = ไม่บันทึก
    B->>S: updateSettings guildId patch (shareMode / mode / area / anyoneRecords)
    S->>F: เขียน settings.json.tmp แล้ว rename ตามคิว
    B-->>U: แสดงหน้าเดิมใหม่ (ค่าที่เลือกเป็น default ของเมนู)
    B->>B: checkShares: การ์ด 🔴 โผล่หรือหาย (อัดอัตโนมัติ: คนที่แชร์อยู่เริ่มอัดเลย)
    U->>B: 🔧 ตั้งค่าเพิ่มเติม
    B-->>U: แท็บ ⏳ เงื่อนไข (คนในห้อง, แชร์นานก่อน, ยาวสุด; ไม่มี PUBLIC_URL: อัดจอ Mac ทั้งจอ/หน้าต่าง) · 📍 ห้อง & คน · 🕘 เวลา<br/>แถวแรกมี ◀️ กลับ (config:page-quick)
    U->>B: ✔️ เสร็จ
    B-->>U: ✅ บันทึกแล้ว พร้อมสรุปค่าที่ตั้ง
```

> ปุ่มในข้อความตั้งค่าเก่ายังกดได้: `config:share-off|card|auto`, `config:cards`, `config:anyone` บันทึกค่าแล้วแสดงหน้าแบบง่ายใหม่ `config:page-main` เปิดหน้าแบบง่าย คนที่ไม่ใช่ผู้ดูแลกดอะไรใน `config:*` ได้ข้อความ 🔒
> อัดจอด้วย (`mode`): มี PUBLIC_URL มีแค่ `agent` (ค่าเริ่มต้น สั่งตัวอัดของคนนั้น ไม่มีตัวอัดได้ลิงก์ 🎥) และ `browser` (ลิงก์เสมอ ไม่สั่งตัวอัด) ใช้กับการเริ่มจากการแชร์ทุกแบบ (🔴, อัตโนมัติ, 🔁, 🔴 ต่อ) ปุ่ม 🖥️ อัดจอ / 🌐 อัดผ่านเบราว์เซอร์ บนแผงไม่ขึ้นกับค่านี้ ค่าเก่า `screen`/`window` (และ env `SCREEN_MODE`) อ่านเป็น `agent` บอทที่ไม่มี PUBLIC_URL ใช้ `screen`/`window` ของเครื่องที่รันบอท
> กรอบอัด (`area`, ค่าเริ่มต้น `screen`): ส่งไปกับคำสั่ง start ของตัวอัด และลิงก์หน้าอัดจอมี `?area=discord` (หน้าเว็บบอกให้เลือกหน้าต่าง Discord) ดู 12
> 👥 ทุกคน (`anyoneRecords`) ให้ทุกคนกด 🎙️ 🖥️ 🌐 ⏹️ ได้ แต่ไม่ได้เปลี่ยนสิทธิ์ตั้งค่า
> การย้ายค่า shareMode (อ่านตอนใช้ ตัวแรกที่เจอชนะ): `shareMode` ที่บันทึกไว้ → `shareCards: true/false` = ส่งการ์ด/ปิด → `autoScreen: true` เดิม = อัดอัตโนมัติ → `autoVoice: members` เดิม = ส่งการ์ด → `autoScreen: false` เดิม = ปิด → ไม่เคยตั้ง = ค่า env (`SHARE_CARDS` `true`/`card` = ส่งการ์ด, `auto` = อัดอัตโนมัติ, `false`/`off` = ปิด; ไม่ได้ตั้ง: `AUTO_SCREEN=true` = อัดอัตโนมัติ ไม่งั้นปิด) ไม่มีพรีเซ็ตและไม่มีตัวเลือกอัดเสียงอัตโนมัติอีกแล้ว
