# 11. อัดจอผ่านเบราว์เซอร์ (BrowserCapture)

คนแชร์อัดจอตัวเองในเบราว์เซอร์ แล้วส่งชิ้นวิดีโอให้บอททาง HTTP (`capture-server.js`) ใช้ได้เมื่อตั้ง `PUBLIC_URL`

## ลำดับเหตุการณ์

```mermaid
sequenceDiagram
    actor S as คนแชร์
    participant D as Discord
    participant B as index.js
    participant C as BrowserCapture
    participant H as capture-server.js
    participant P as หน้าอัดจอ (เบราว์เซอร์)
    participant F as ffmpeg
    participant G as Google Drive

    S->>D: แชร์จอในห้องเสียง
    D->>B: voiceStateUpdate → checkShares (mode = browser)
    B->>C: new BrowserCapture (state offered, ไม่มีเวลาหมดอายุ)
    B->>B: บอทเข้าห้องเสียงทันที และเริ่มอัดเสียง (ไม่รอ ▶️)
    B->>D: การ์ดสาธารณะ 🎥 แชร์จอในห้อง + ping @คนแชร์ + ปุ่มลิงก์บนการ์ด + ปุ่ม ✖️ ไม่อัด
    B->>D: หลังบอทเข้าห้องได้: การ์ดเป็น 🔴 กำลังอัดเสียงในห้อง + ปุ่ม ⏹️ หยุดอัด
    B->>C: link() ครั้งเดียวตอนโพสต์การ์ด → token (HMAC, อายุตาม maxMinutes ถ้า 0 = 24 ชม.)
    S->>D: กดปุ่มลิงก์บนการ์ด (เจ้าของกดได้โดยไม่ต้องมี role)
    Note over S,B: ปุ่มลิงก์เปิด URL ตรง ๆ บอทไม่ได้ตอบ
    S->>H: GET /capture/token
    H-->>P: HTML + CSP (token ยังไม่ถูกใช้)
    S->>P: ▶️ เริ่มอัดจอ → getDisplayMedia เลือกจอ
    P->>H: POST /api/capture/capId/start {token, mime}
    H->>C: claim (เช็กแล้ว set พร้อมกัน ครั้งเดียว)
    C-->>P: session bearer, chunkMs 3000
    C->>B: onLive → การ์ดแสดงว่ามีภาพ (อัตโนมัติ: เสียงอัดอยู่แล้ว ไม่เริ่มซ้ำ / กดเอง: ตอนนี้จึงเข้าห้องและโพสต์การ์ด)
    opt อุปกรณ์ที่อัดจอไม่ได้ (มือถือ ไม่มี getDisplayMedia)
        P->>H: POST /api/capture/capId/voice {token}
        H->>C: voiceOnly → state voice (ใช้ได้ครั้งเดียว)
        C->>B: onVoiceOnly
        alt อัตโนมัติ และบอทอยู่ในห้องแล้ว
            B-->>C: paired true (ไม่เริ่มอะไรใหม่)
        else กดเอง และอยู่ในห้องเสียง
            B->>D: การ์ดสาธารณะ 🔴 กำลังอัดเสียงในห้อง (อัดได้แค่เสียง)
            B-->>C: paired false (ข้อเสนอส่วนตัวจบเงียบ ๆ)
        else อยู่นอกห้อง หรือเข้าห้องไม่ได้
            B-->>C: error novoice หรือ voice
            C->>C: กลับเป็น offered (ยังใช้จากคอมพิวเตอร์ได้)
        end
        C-->>P: 200 {ok, paired} หรือ 409 {error}
    end
    loop ทุก 3 วินาที
        P->>H: PUT chunk/seq (Bearer)
        H->>C: putChunk → chunks/seq.bin (ซ้ำ seq = 200 เฉยๆ)
        H-->>P: {ok, stop}
    end
    loop ทุก 5 วินาที
        P->>H: GET status (Bearer)
        H-->>P: {state, stop}
    end

    Note over C,B: ตัวหยุดทั้ง 6 แบบ
    alt 1 กด ⏹️ ใน Discord
        S->>D: ⏹️
        D->>B: screen:stop (เจ้าของหรือคนมี role)
    else 2 คนแชร์เลิกแชร์หรือออกห้อง
        B->>B: checkShares เห็นว่าเลิกแชร์
    else 3 ครบความยาวสูงสุด
        B->>B: maxTimer (session ตั้งตอนกด 🔴, manual ตั้งตอน onLive)
    else 4 หน้าเว็บหยุดเอง
        P->>H: POST stop {page ⏹️ / ended เลิกแชร์ / unload ปิดแท็บ, last}
        H->>C: pageStop → exit(reason, skip)
    else 5 heartbeat ขาด เกิน 45 วินาที
        C->>C: exit "หน้าอัดจอถูกปิดหรือเน็ตหลุด" (skip)
    else 6 ไฟล์ถึง CAPTURE_MAX_MB หรือพื้นที่รวมถึง CAPTURE_TOTAL_MB
        H->>C: putChunk 413 → exit "ไฟล์ใหญ่ถึงขีดจำกัด" (skip)
    end

    C-->>B: exited (exitReason, exitSkip) หรือ B เรียก stop() เอง
    B->>D: การ์ด ⏳ กำลังบันทึกไฟล์
    B->>C: stop() → stopping
    C->>P: stop:true ในคำตอบของ chunk/status
    P->>H: ส่งชิ้นที่ค้างให้หมด แล้ว POST stop {last}
    Note over C: รอหน้า flush สูงสุด 35 วินาที แล้วรอ write ที่ค้างครบ<br/>→ finalizing ทุก request หลังจากนี้ได้ 410
    C->>F: ป้อน chunks ตามลำดับเลข ผ่าน stdin (remux ไม่ encode ภาพใหม่)
    alt ffmpeg สำเร็จ
        F-->>C: screen.mp4 (H.264) หรือ screen.webm (VP8/VP9), ลบ chunks/
    else ffmpeg ล้มเหลว
        C->>C: ต่อ chunk ดิบเป็น screen-raw.* + หมายเหตุ ⚠️
    end
    C-->>B: path (notes เช่น วิดีโอขาดหาย N ช่วง)
    opt มี voice.mp3 คู่กัน
        B->>F: mergeAudio: ใส่เสียงห้องเข้าวิดีโอ เลื่อนตาม liveAt − voice.startedAt (-c:v copy)
        F-->>B: screen-with-audio.* (พลาด → วิดีโอเงียบ + ⚠️)
    end
    B->>G: deliver ▶️ วิดีโอมีเสียง ไฟล์เดียว (merge พลาด → วิดีโอเงียบ + voice.mp3)
    P->>H: GET /result → location.replace(ลิงก์วิดีโอใน Drive)
    B->>D: การ์ดผลลัพธ์ ✅ พร้อมลิงก์
    opt DELETE_AFTER_UPLOAD=true และอัปโหลดครบทุกไฟล์ และไม่มี recorder ใช้ dir อยู่
        B->>B: ลบ recordings/guild-timestamp/
    end
    Note over B: screen.delete แล้ว checkShares ทันที<br/>คนที่ยังแชร์อยู่ได้การ์ด 🔴 ใหม่ (ยกเว้นคนใน cardSkip)
```

ลิงก์บนการ์ดของ session (กด 🔴 หรืออัดอัตโนมัติ, ไม่มีตัวอัดหรือตั้งอัดจอด้วยเบราว์เซอร์) ไม่มีเวลาหมดอายุ บอทเข้าห้องและอัดเสียง **ทันทีที่ session เริ่ม** (โหมดส่งการ์ด: หลังมีคนกด 🔴) ลิงก์มี `?area=discord` เมื่อตั้งกรอบอัดเป็นแค่หน้าต่าง Discord หน้าเว็บจะบอกให้เลือกหน้าต่าง Discord การอัดจบตาม state machine ใน 12.3 (คนแชร์เลิกแชร์ ⏹️ ครบเวลาสูงสุด หรือหน้าอัดจอจบเอง) ถ้าหน้าจบเอง (ปิดแท็บ heartbeat ขาด ไฟล์เต็ม) คนแชร์จะอยู่ใน `cardSkip` จนกว่าจะเลิกแชร์ ถ้าไม่มีใครเปิดลิงก์ เสียงในห้องก็ยังอัดอยู่ ข้อเสนอส่วนตัวของ 🌐 อัดผ่านเบราว์เซอร์ หมดเวลาใน 5 นาที ตัวอัด (agent) ใช้ chunk API เดียวกันนี้ ดู 12

## สถานะของ BrowserCapture

```mermaid
stateDiagram-v2
    [*] --> offered: new BrowserCapture
    offered --> live: claim (token ถูกต้อง ครั้งเดียว)
    offered --> done: ครบ 5 นาที (เฉพาะข้อเสนอส่วนตัว) หรือกด ⏹️ / เลิกแชร์ (stop ไม่มีไฟล์ คืน null)
    offered --> voice: POST /voice จากมือถือ (ครั้งเดียว)
    voice --> offered: ไม่สำเร็จ (ยังใช้จากคอมพิวเตอร์ได้)
    voice --> done: จบ (ข้อเสนอส่วนตัวจบ หรือการแชร์จบ)
    live --> stopping: stop() — ปุ่ม, เลิกแชร์, maxTimer, หรือ exit จากหน้าเว็บ/heartbeat/ไฟล์เต็ม
    stopping --> finalizing: หน้า flush แล้ว หรือ 35 วินาที หรือหน้าหาย, write ค้างครบ
    finalizing --> done: remux สำเร็จ หรือส่งไฟล์ดิบ หรือ error ไม่มี chunk 0
    done --> [*]: ลบออกจาก registry หลัง 10 นาที
    note right of finalizing
        ทุก request ได้ 410 stop true
    end note
```
