# 10. Deploy 2 แบบ

```mermaid
flowchart LR
    subgraph MAC["Mac (local)"]
        M1["SCREEN_ENABLED=true<br/>PUBLIC_URL ไม่ตั้ง = ไม่เปิดพอร์ต"]
        M2["อัดเสียง ✅<br/>อัดจอเครื่อง ✅<br/>อัดอัตโนมัติ ✅<br/>/settings ✅<br/>อัดจอผ่านเบราว์เซอร์ ✅ ถ้าตั้ง PUBLIC_URL<br/>(localhost หรือ tunnel)"]
        M3[("recordings/<br/>data/settings.json")]
        M1 --> M2 --> M3
    end
    subgraph K8S["Kubernetes"]
        K1["SCREEN_ENABLED=false<br/>PUBLIC_URL + HTTP_PORT 8080<br/>replicas 1 + Recreate"]
        K2["อัดเสียง ✅<br/>อัดจอเครื่อง ❌ ไม่มีจอให้อัด<br/>อัดจอผ่านเบราว์เซอร์ ✅ คนแชร์อัดเอง"]
        K3[("emptyDir 20Gi<br/>หายเมื่อ pod restart<br/>DELETE_AFTER_UPLOAD=true")]
        K4["ConfigMap + Secret<br/>probe /healthz<br/>terminationGracePeriod 60s"]
        K5["Service ClusterIP :80 → :8080"]
        K6["Ingress nginx + TLS<br/>เปิดเฉพาะ /capture /static /api/capture<br/>body 20m, ไม่ buffer request"]
        K4 --> K1 --> K2 --> K3
        K6 --> K5 --> K1
    end
    USR["เบราว์เซอร์ของคนแชร์<br/>https://recorder.example.com"] --> K6
    MAC --> GD["Google Drive"]
    K8S --> GD
```

> โค้ดยังไม่ได้จัดการ `SIGTERM` ถ้า pod ถูก restart ระหว่างอัด ไฟล์ที่อัดอยู่จะหายไปกับ `emptyDir` และลิงก์อัดจอที่ออกไปแล้วใช้ไม่ได้ (key ของลิงก์สุ่มใหม่ทุกครั้งที่ process เริ่ม) ถึงจะตั้ง grace period ไว้ 60 วินาทีก็ไม่ช่วย
