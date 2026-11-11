# System flow — Discord Recorder

| # | ไฟล์ | เนื้อหา |
|---|---|---|
| 0a | [00-for-everyone.md](00-for-everyone.md) | ภาพเดียวสำหรับทุกคน (ไม่ต้องรู้เทคนิค) |
| 0b | [00-end-to-end.md](00-end-to-end.md) | ตั้งแต่สร้างบอท → deploy k8s → service ต่อ Discord → อัดเสียง/อัดจอ → ส่งผล |
| 1 | [01-overview.md](01-overview.md) | ภาพรวมระบบและ module |
| 2 | [02-startup.md](02-startup.md) | ตอนบอทเริ่มทำงาน |
| 3 | [03-routing-permission.md](03-routing-permission.md) | Routing คำสั่งและการตรวจสิทธิ์ |
| 4 | [04-voice-recording.md](04-voice-recording.md) | Flow อัดเสียง |
| 5 | [05-screen-recording.md](05-screen-recording.md) | Flow อัดหน้าจอด้วยตัวเอง |
| 6 | [06-auto-screen.md](06-auto-screen.md) | Flow อัดอัตโนมัติเมื่อมีคนแชร์จอ |
| 7 | [07-settings.md](07-settings.md) | การตั้งค่าราย server |
| 8 | [08-deliver.md](08-deliver.md) | การส่งไฟล์ (Drive / แนบไฟล์) |
| 9 | [09-error-handling.md](09-error-handling.md) | Error handling |
| 10 | [10-deployment.md](10-deployment.md) | Deploy บน Mac และ Kubernetes |
| 11 | [11-browser-capture.md](11-browser-capture.md) | อัดจอผ่านเบราว์เซอร์ (offer → ลิงก์ → chunk → หยุด → ส่งผล) |
