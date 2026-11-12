# 12. ตัวอัด (agent) และ session

ตัวอัดคือโปรแกรมเล็กๆ บนเครื่องของคนแชร์จอ บอทสั่งให้อัดเมื่อมีคนกด 🔴, เจ้าของเครื่องกด 🖥️ อัดจอ หรือ server ตั้ง ⚡ อัดอัตโนมัติ แล้วเจ้าของเครื่องแชร์จอใน Discord (ตัวอัดเองไม่เคยเริ่มเอง ต้องมีคำสั่ง start จากบอทเสมอ) ไม่มีโทเคน Discord อยู่ในตัวอัด เจ้าของเครื่องตกลงครั้งเดียวตอนติดตั้ง ตอนอัดไม่ถามอีก

## 12.1 ติดตั้งและจับคู่ (ครั้งเดียวต่อเครื่อง)

```mermaid
sequenceDiagram
    actor U as ผู้ใช้
    participant B as บอท (index.js)
    participant H as agent-hub (HTTP)
    participant T as Terminal บนเครื่องผู้ใช้
    participant UP as เว็บ upstream (Node / ffmpeg)
    U->>B: /agent
    B->>H: newPairing userId (token 128 bit, รหัส 6 หลักเฉพาะเมื่อเปิด code pairing, หมดอายุ 10 นาที)
    B-->>U: ephemeral: คำสั่ง macOS/Linux, คำสั่ง Windows, ใช้ได้ถึงกี่โมง, คำสั่งเปิด/เชื่อมใหม่/ลบตัวอัดทีหลัง, รายการเครื่องที่จับคู่แล้ว + ปุ่ม 🗑️ ยกเลิก (ผู้ดูแล: + ตัวอัดใน server นี้ + ปุ่ม 🗑️ agent:kick)
    U->>T: วางคำสั่ง curl ... / install.sh | DRA_TOKEN=token sh
    alt ยังไม่มี config.json (ติดตั้งครั้งแรก)
        T->>U: ตัวอัดจะอัดทั้งจอที่เลือกได้ทุกครั้งที่มีคนกดอัดหรืออัดอัตโนมัติ โดยไม่ถามอีก กด s หยุดได้<br/>ให้บอทอัดจอเครื่องนี้ไหม? (y/N) (อ่านจาก /dev/tty, Windows: Read-Host)
        U-->>T: ไม่ใช่ y หรือไม่มีหน้าต่างให้ตอบ = ยกเลิกการติดตั้ง ไม่ได้ติดตั้งอะไร (ไม่โหลด ไม่จับคู่ token ยังใช้ได้)
    end
    T->>H: GET /agent/install.sh และ /agent/manifest.json (สาธารณะ ไม่มีความลับ)
    T->>UP: โหลด Node + ffmpeg ตามที่ pin ไว้ (pins.json)
    T->>T: ตรวจ SHA-256 ก่อนแตกไฟล์ ไม่ตรง = หยุด ของเดิมยังอยู่
    T->>H: GET /agent/files/name แล้วตรวจ SHA-256 ตาม manifest
    T->>H: POST /api/agent/pair {token, name, os} (main.js --pair-only --consent)
    H-->>T: deviceId.secret (ใช้ครั้งเดียว เก็บฝั่งบอทเป็น sha256 เท่านั้น)
    T->>T: เขียน config.json (สิทธิ์ 0600, consent: true)
    T-->>U: ถามว่าจะเปิดอัตโนมัติทุกครั้งที่เข้าเครื่องไหม (ไม่บังคับ) แล้วรันตัวอัด ⚪ พร้อม
    Note over U,T: macOS จะขอสิทธิ์ Screen Recording ให้ Terminal ตอนอัดครั้งแรก
    U->>B: 🗑️ ยกเลิกเครื่อง (agent:revoke)
    B->>H: revoke userId deviceId
    H-->>T: poll ตอบ revoked, ตัวอัดลบ credential ของตัวเอง
    U->>B: 🗑️ ลบตัวอัดของสมาชิก (agent:kick, ผู้ดูแลเท่านั้น)
    B->>B: เช็กใหม่: isAdmin + เครื่องจับคู่จาก server นี้ (เครื่องเก่า: เจ้าของยังเป็นสมาชิก)
    B->>H: revokeDevice deviceId
    H-->>T: poll ตอบ revoked, ตัวอัดหยุดอัด (ส่งส่วนที่อัดแล้ว) ลบ credential แล้วปิด
```

> รันซ้ำคำสั่งเก่าได้ จะเป็นการอัปเดต (มี config อยู่แล้ว = ไม่ถามซ้ำ, token ที่ใช้แล้ว = ข้ามการจับคู่) เครื่องที่ติดตั้งไว้ก่อนมีคำถามนี้ถือว่าตกลงแล้ว ค่า askFirst เก่าใน config ถูกลบตอนเปิดตัวอัดครั้งถัดไป `npm run agent` ครั้งแรกถามคำถามเดียวกันในเทอร์มินัล (หรือใส่ `--consent`) นักพัฒนาใช้ `npm run agent -- --server URL --code 123456` แทนได้ ส่วนผู้ดูแลใช้ `npm run build:agent` เพื่อรีเฟรช hash ที่ pin ไว้

## 12.2 long-poll และการอัดหนึ่งครั้ง

```mermaid
sequenceDiagram
    actor S as คนแชร์จอ
    participant A as ตัวอัด
    participant H as agent-hub
    participant B as บอท (session)
    participant C as BrowserCapture via agent
    A->>H: POST /api/agent/hello {session, displays} (ตัวอัดรุ่นเก่าส่ง askFirst มาด้วย: รับแต่ไม่ใช้)
    H-->>A: user, pollMs (เครื่องล่าสุดของคนนี้ชนะ เครื่องเก่าได้ replaced)
    loop ทุก ~25 วินาที
        A->>H: GET /api/agent/poll (ค้างไว้ได้ 25 วินาที)
        H-->>A: cmds ว่าง หรือมีคำสั่ง
    end
    Note over H: ออนไลน์ = poll ล่าสุดไม่เกิน 40 วินาที
    S->>B: กด 🔴 บนการ์ด / 🖥️ อัดจอ (หรืออัดอัตโนมัติ: เจ้าของเครื่องแชร์จอ ผ่านตัวกรอง)
    par บอทเข้าห้องทันที
        B->>B: joinSession บอทเข้าห้องเสียง เริ่มอัดเสียง การ์ด 🔴 กำลังอัด … ⏳ กำลังสั่งเครื่องของ X
    and สั่งตัวอัด (อัดจอด้วย = ตัวอัด)
        B->>C: สร้าง capture (via agent) + token ที่เซ็นแล้ว
        B->>H: start userId capture (area)
        H-->>A: poll ตอบ start {capId, token, maxMs, chunkMs, videoBps, room, by, area}
    end
    A->>A: area = discord: หาหน้าต่าง Discord (Windows gdigrab title=, macOS crop ตามตำแหน่งตอนเริ่ม ไม่ต้องขอสิทธิ์เพิ่ม, Linux/หาไม่เจอ = ทั้งจอ + หมายเหตุ)
    A->>A: เปิด ffmpeg จับจอทันที ไม่ถาม (ไม่เคยเปิดเองโดยไม่มี start)
    A->>C: POST /api/capture/capId/start {token}
    A->>H: POST /api/agent/ack ok (detail = หมายเหตุกรอบอัด ถ้ามี)
    H-->>B: ack ok (+ note บนการ์ด) หรือไม่สำเร็จ: timeout 15 วิ / busy / ffmpeg / display (declined จากตัวอัดรุ่นเก่า)
    alt ไม่สำเร็จ
        B->>B: เสียงอัดต่อ หมายเหตุ ⚠️ บนการ์ด แล้วใช้ลิงก์ 🎥 แทน (กดเอง: ลิงก์ส่วนตัวในข้อความที่เห็นคนเดียว)
    end
    loop ทุก 3 วินาที
        A->>C: PUT /api/capture/capId/chunk/N
    end
    A->>A: เก็บไฟล์สำรองในเครื่อง (~/.discord-recorder-agent/recordings)
    alt กด s ที่ตัวอัด
        A->>C: POST stop {reason: agent}
        C-->>B: exitKind local
    else บอทสั่งหยุด หรือ status บอกให้หยุด
        B->>H: stop userId capId
        A->>C: POST stop (ส่งชิ้นที่ค้างให้ครบก่อน)
    else ตัวอัดหลุด (ไม่มี heartbeat 45 วินาที)
        C-->>B: exitKind gone
    end
    C-->>B: ต่อชิ้นเป็นไฟล์ (remux) แล้วลบไฟล์สำรองในเครื่องเมื่อสำเร็จ
```

## 12.3 สถานะของ session (หนึ่งต่อหนึ่ง server)

```mermaid
stateDiagram-v2
    [*] --> starting: กด 🔴 / 🖥️ หรืออัดอัตโนมัติ (จอง screen ทันที บอทเข้าห้องพร้อมกัน แต่ยังไม่อัด = เตรียมอัด)
    starting --> live: segment แรกถูกรับ (ตัวอัด / จอ Mac = มีภาพแล้ว / ลิงก์ = ยังเตรียมอัดจนเปิด)
    starting --> starting: ตัวอัดเริ่มไม่สำเร็จ: หมายเหตุ แล้วใช้ลิงก์ (ยังเตรียมอัด)
    starting --> [*]: ไม่ได้ภาพเลย (เลิกแชร์ / จอ Mac พลาด): ⚪ ไม่ได้อัด ไม่มีไฟล์
    live --> [*]: ยังเตรียมอัด (ลิงก์ยังไม่เปิด) แล้วเลิกแชร์ / ออก / ✖️ / ทุกคนออก / ครบเวลา / บอทหลุด: ⚪ ไม่ได้อัด ไม่มีไฟล์
    starting --> [*]: บอทเข้าห้องไม่ได้ (joinFailed รอผลสั่งจอก่อน) และไม่มีภาพที่ live: ยกเลิก ไม่ส่งไฟล์ (ลิงก์ที่ยังไม่เปิดไม่นับ)
    starting --> live: บอทเข้าห้องไม่ได้ แต่มีภาพ live อยู่: อัดภาพต่อ พร้อมหมายเหตุ
    live --> live: กด 🔁 เปลี่ยนไปอัดจอคนอื่น (เริ่มคนใหม่ก่อน สำเร็จแล้วค่อยหยุดคนเก่า)
    live --> waiting: คนที่อัดหยุดแชร์ ออกจากห้อง หรือตัวอัดหลุด แต่ยังมีคนแชร์อยู่
    waiting --> live: กด 🔴 อัดจอ ... ต่อ ภายใน 2 นาที หรือ (อัดอัตโนมัติ) มีคนแชร์ที่ตัวอัดออนไลน์ = ต่อทันที
    live --> finishing: กด ⏹️ / ไม่มีคนแชร์เหลือ / ทุกคนออกจากห้อง / ครบเวลาสูงสุด
    waiting --> finishing: กด ⏹️ จบ / ครบ 2 นาที / บอทหลุดห้อง / ครบเวลาสูงสุด
    finishing --> [*]: รวมเป็น meeting.mp4 ส่งผล บอทออกจากห้อง
```

> อัดอัตโนมัติ: segment ที่บอทเริ่มเองมี `seg.auto` (การ์ดขึ้น ⚡ อัดอัตโนมัติ ชื่อบอท `<ชื่อ> - 🔴 อัดจออัตโนมัติ` log ลงท้าย `(อัตโนมัติ)`) ไม่สลับเองระหว่าง live (🔁 ยังต้องกด) เมื่อคนที่อัดหยุด waiting จะเรียก `autoNext` ทันที (ตัวอัดก่อน ไม่งั้นลิงก์) เครื่องที่หลุด/เกินขนาดอยู่ใน `sess.noAuto` (ต้องกด 🔴 ต่อ) ถ้าตัวอัดเริ่มไม่สำเร็จ คนนั้นเข้า `cardSkip` (ไม่สั่งตัวอัดซ้ำ) แต่ session ใช้ลิงก์ของเขาต่อ ตัวอัดรุ่นเก่าไม่รู้จัก `area` และอัดทั้งจอ บอทไม่รู้ว่าเป็นรุ่นเก่า
> **เตรียมอัด**: ตั้งแต่เริ่มจนภาพแรก live (`recorded(sess)`) บอทอยู่ในห้องแต่ไม่อัดอะไร (การ์ด/ชื่อบอท `⏳ เตรียมอัด`) ไม่มีเวลาหมดของตัวเอง ภาพแรกขึ้น (ตัวอัด claim, เปิดลิงก์, จอ Mac) → `startAudio` เสียงเริ่มที่ `videoAt` จบก่อนมีภาพ = `cancelSession` ไม่มีไฟล์ (อัดเสียงอย่างเดียวได้จาก 🎙️ เท่านั้น) หลังมีภาพแล้ว เสียงในห้องอัดต่อเนื่องตลอด session แม้ช่วง waiting ส่วน session แบบกดเอง (🖥️ อัดจอ ที่มีตัวอัด) ไม่มี 🔁 และไม่มี waiting จบทันทีเมื่อกด ⏹️ คนกดออกจากห้อง หรือตัวอัดหลุด
