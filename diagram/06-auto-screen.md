# 6. Flow อัดอัตโนมัติเมื่อมีคนแชร์จอ

```mermaid
flowchart TD
    EV["voiceStateUpdate จากคนที่ไม่ใช่บอท<br/>หรือเปลี่ยน settings"] --> EN{"เปิดการอัดจอ?<br/>(Mac screen หรือ PUBLIC_URL)"}
    EN -->|"ไม่"| X0["จบ"]
    EN -->|"ใช่"| CUR{"มีการอัดจอของ guild นี้อยู่?"}
    CUR -->|"มี และอัดด้วยมือ"| X1["ไม่ยุ่ง"]
    CUR -->|"มี และเป็นอัตโนมัติ"| CHK{"คนที่แชร์ยังอยู่ห้องเดิม<br/>และยังแชร์อยู่?"}
    CHK -->|"ใช่"| X2["อัดต่อ"]
    CHK -->|"ไม่"| FIN["finishScreen<br/>⏹️ หยุดแชร์ — อัดวิดีโอเสร็จแล้ว + ไฟล์"]
    CUR -->|"ไม่มี"| ST{"กำลัง start อยู่<br/>หรือ autoScreen ปิด<br/>หรือนอกช่วงเวลา?"}
    ST -->|"ใช่"| X3["จบ"]
    ST -->|"ไม่"| CL["ล้าง autoSkip ถ้าคนที่ถูกข้ามเลิกแชร์แล้ว"]
    CL --> LOOP["วนทุก voice channel<br/>กรองด้วย AUTO_SCREEN_CHANNEL_IDS"]
    LOOP --> H{"คนในห้อง ≥ minMembers?"}
    H -->|"ไม่"| LOOP
    H -->|"ใช่"| SH{"มีคนแชร์จอ<br/>ที่ไม่อยู่ใน autoSkip<br/>และอยู่ใน AUTO_SCREEN_USER_IDS ถ้าตั้งไว้?"}
    SH -->|"ไม่"| LOOP
    SH -->|"ใช่"| BM{"mode = browser?"}
    BM -->|"ใช่"| BO["offerBrowser: สร้าง BrowserCapture (state offered, ไม่มีเวลาหมดอายุ)<br/>บอทเข้าห้องเสียงทันทีและเริ่มอัดเสียง (pairVoice)<br/>โพสต์การ์ดสาธารณะ + ping เจ้าของ + ปุ่มลิงก์บนการ์ด<br/>ไม่ต้องรอ screenBusy"]
    BO --> BP["คนแชร์กดปุ่มลิงก์บนการ์ด → เปิดหน้า → ▶️ เริ่มอัดจอ<br/>onLive: การ์ดแสดงว่ามีภาพ (เสียงเริ่มไปแล้ว ไม่เริ่มซ้ำ) ดู 11"]
    BP --> RE
    BM -->|"ไม่"| BZ{"Mac screen ว่าง?<br/>(screenBusy ไม่นับ browser)"}
    BZ -->|"ไม่"| X5["จบ"]
    BZ -->|"ใช่"| MK["startingAuto.add<br/>screenRecorder ตาม settings.mode<br/>window หาไม่เจอ → fallback ทั้งจอ"]
    MK --> SR{"ffmpeg start สำเร็จ?"}
    SR -->|"ใช่"| OK["บันทึก auto=sharerId, autoChannelId<br/>แจ้ง 🔴 ในห้องที่ใช้ /record<br/>หรือแชทของ voice channel"]
    SR -->|"ไม่"| ERR["autoSkip.set sharer<br/>แจ้ง อัดวิดีโอไม่ได้ + ปุ่มแก้"]
    OK --> FN["startingAuto.delete"]
    ERR --> FN
    FN --> RE{"เป็นการอัดอัตโนมัติอยู่?"}
    RE -->|"ใช่"| CUR
    RE -->|"ไม่"| X4["จบ"]
```

> โหมด browser: ข้อเสนออัตโนมัติไม่หมดเวลา (เสียงอัดตั้งแต่แชร์จนกว่าการแชร์จะจบ) จึงไม่มี `autoSkip` จากการไม่กด การอัดที่จบเอง (heartbeat ขาด, ไฟล์เต็ม, ปิดหน้า) จะใส่คนแชร์ลง `autoSkip` เพื่อไม่เสนอซ้ำจนกว่าเขาจะเลิกแชร์ และ guild มีการอัดแบบ browser ได้ครั้งละ 1 (คนแชร์คนถัดไปได้ข้อเสนอเมื่อช่องว่าง)
