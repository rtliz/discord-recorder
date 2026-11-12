# 8. การส่งไฟล์ (deliver)

```mermaid
flowchart TD
    SG["session จบ: segment วิดีโอ 1..n + เสียงห้องต่อเนื่อง voice.mp3"] --> CP{"composeMeeting (src/compose.js)<br/>มี segment เดียว และเสียงที่วิดีโอไม่ครอบคลุม<br/>ต้นและท้ายไม่เกิน 15 วินาที?"}
    CP -->|"ใช่ (ทางลัด)"| FP["mergeAudio -c:v copy ไม่ encode ภาพใหม่<br/>เปลี่ยนชื่อเป็น meeting.mp4 / .webm"]
    CP -->|"ไม่"| RE["encode ใหม่เป็น meeting.mp4: canvas = segment ที่ใหญ่สุด ไม่เกิน 1920x1080<br/>libx264 superfast crf 30 15 fps, ช่วงว่างเป็นภาพดำ<br/>เสียงห้องตลอด session + เสียงของ segment ตาม offset<br/>ทำทีละงานทั้ง process (การ์ดแจ้ง คิวที่ N), nice, timeout max(15 นาที, ความยาวประชุม)"]
    FP --> F
    RE -->|"สำเร็จ"| F
    RE -->|"ล้มเหลว"| F2["ส่งวิดีโอ segment (ไม่เกิน 3) + voice.mp3 แยก<br/>+ หมายเหตุ ⚠️ รวมเป็นไฟล์เดียวไม่สำเร็จ"] --> F
    V["การอัดแบบเดิม (Mac กดเอง / ลิงก์ส่วนตัว):<br/>screen.* + voice.mp3 คู่กัน"] --> M["mergeAudio (src/merge.js)<br/>offset = เวลาเริ่มภาพ − VoiceRecorder.startedAt<br/>-c:v copy, apad + -shortest, amix ถ้าวิดีโอมีเสียงเอง"]
    M -->|"สำเร็จ: ส่งไฟล์เดียว ไม่ส่ง voice.mp3 แยก"| F
    M -->|"ล้มเหลว (null)"| F2
    F["ไฟล์ voice.mp3 / meeting.* / screen-with-audio.* / screen.*"] --> D{"driveEnabled?<br/>มี REFRESH_TOKEN + FOLDER_ID"}
    D -->|"ใช่"| U1["editReply: กำลังอัปโหลดขึ้น Google Drive..."]
    U1 --> U2["drive.files.create<br/>ชื่อ guildId-timestamp-ชื่อไฟล์"]
    U2 --> U3["ตอบพร้อมปุ่มลิงก์<br/>▶️ เปิดไฟล์ และ 📁 Google Drive"]
    D -->|"ไม่"| SZ{"ขนาด ≤ 10MB?"}
    SZ -->|"ใช่"| AT["แนบไฟล์ใน Discord"]
    SZ -->|"ไม่"| PATH["แจ้ง path ที่เก็บไฟล์บนเครื่อง"]

    subgraph ONE["ตั้งค่าครั้งเดียว: npm run drive-auth"]
        O1["เปิด OAuth URL scope drive"] --> O2["callback localhost:53682"] --> O3["พิมพ์ GOOGLE_REFRESH_TOKEN<br/>เอาไปใส่ .env"]
    end
```

> session หนึ่งครั้งส่ง `meeting.*` ไฟล์เดียวเป็นปุ่ม ▶️ ดูวิดีโอ (ใช้เป็นปลายทางที่หน้าอัดจอเด้งไปเปิดด้วย) ถ้า session ไม่มีวิดีโอเลยจะส่ง voice.mp3 อย่างเดียว การลบโฟลเดอร์ (`DELETE_AFTER_UPLOAD`) ทำเมื่ออัปครบทุกไฟล์และไม่มี segment ของ session ที่ยังใช้โฟลเดอร์อยู่
