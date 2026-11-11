# 7. การตั้งค่าราย server

```mermaid
sequenceDiagram
    actor U as Admin
    participant B as index.js
    participant S as settings.js
    participant F as data/settings.json
    U->>B: /settings หรือปุ่ม ⚙️ หรือข้อความต้อนรับ
    B->>S: getSettings guildId
    S-->>B: ค่าเริ่มต้นจาก env (SCREEN_MODE = screen/window/browser) ทับด้วยค่าที่บันทึกไว้
    B-->>U: หน้าแบบง่าย (quick): 3 ปุ่มพรีเซ็ต, 🔧 ปรับละเอียด, 👥 ทุกคนกดอัดได้ / 🔑 เฉพาะผู้ดูแลกดอัด, ✔️ เสร็จ<br/>configView (หน้าละเอียด): ปุ่มเปิด/ปิด, select minMembers 1-5, select mode<br/>(แสดงเฉพาะโหมดที่ใช้ได้: screen/window ถ้าเปิด Mac screen, browser ถ้ามี PUBLIC_URL<br/>ซ่อนเมื่อมีโหมดเดียว)
    U->>B: กดปุ่มหรือเลือกค่า (mode = browser → "จอของคนที่แชร์ (ผ่านลิงก์ในเบราว์เซอร์)")
    B->>S: updateSettings guildId patch
    S->>F: เขียน settings.json.tmp แล้ว rename ตามคิว
    B-->>U: แสดง configView ใหม่
    B->>B: checkAutoScreen ถ้ามีคนแชร์อยู่แล้วจะเริ่มอัดทันที
    U->>B: กด 👥 / 🔑 บนหน้าแบบง่าย (config:anyone, ผู้ดูแลเท่านั้น)
    B->>S: updateSettings guildId anyoneRecords สลับค่า
    B-->>U: แสดงหน้าแบบง่ายใหม่ (สีและข้อความของปุ่มตามค่า)
    U->>B: ✔️ เสร็จ
    B-->>U: ✅ บันทึกแล้ว พร้อมสรุปค่าที่ตั้ง
```

> ค่า mode ที่บันทึกไว้แต่ใช้ไม่ได้แล้ว (เช่น window บน k8s) จะถูกใช้เป็นโหมดแรกที่มีอยู่แทน (`modeOf`) และสรุปค่าแสดงโหมดที่ใช้จริง
> 👥 ทุกคนกดอัดได้ (`anyoneRecords`, ค่าเริ่มต้นปิด) ให้ทุกคนกด 🎙️ 🎥 ⏹️ ได้ แต่ไม่ได้เปลี่ยนสิทธิ์ตั้งค่า ปุ่มนี้ซ่อนเมื่อตั้ง `ALLOWED_USER_IDS` (รายชื่อนั้นแทนสิทธิ์ทั้งหมด)
