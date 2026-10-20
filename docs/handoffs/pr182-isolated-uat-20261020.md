# PR #182 — Isolated UAT (Local / Mock) — 20 ต.ค. 2569

**ผล: ISOLATED UAT GO · PRODUCTION RELEASE: NOT AUTHORIZED**

หลักฐานดิบอยู่ใน [`pr182-isolated-uat-20261020/`](pr182-isolated-uat-20261020/) (ผลรายสถานการณ์ `results.jsonl`, manifest การ replay, snapshot ยอดเงิน, ข้อความ LINE จำลอง และสคริปต์ทั้งหมดที่ใช้)

## 1. HEAD และ Environment

| รายการ | ค่า |
|---|---|
| PR code | `0bb0088` (`fix/p0-slip-image-ingestion-20261017`) |
| โค้ดก่อน PR (ใช้ทดสอบ rollback) | `11e2f43` (`origin/main`) ใน worktree แยก |
| App | `next start` โหมด production ผูกกับ `127.0.0.1:3100` เท่านั้น |
| Database | PostgreSQL 17.11 ใน Docker บนเครื่อง, DB `botsummary_baseline_replay_20261009c` |
| REST | PostgREST v16.4 (`uat182-rest`) ต่อกับ DB ด้านบน + nginx (`uat182-gw`, `127.0.0.1:54400`) |
| Storage | Supabase Storage local (จริง ไม่ได้ mock) ผ่าน gateway |
| LINE / OCR | mock แบบ preload (`mock-providers.mjs`) |

## 2. หลักฐานว่าแยกจาก Production

- env ทั้งหมดชี้ `127.0.0.1` เท่านั้น ไม่มี `supabase.co` หรือ `vercel.app`
- token ของ LINE/OpenAI เป็นค่าปลอม และ worktree ไม่มีไฟล์ `.env*` ที่ Next จะโหลด (มีแค่ `.env.example`)
- preload ของ mock ปฏิเสธทุก host ภายนอก: ตลอดการทดสอบมี `blockedExternalCalls = 0`, provider ที่ถูกเรียกมีแค่ `line`/`openai` แบบ mock (OCR 271 ครั้ง, ดาวน์โหลดรูป 307 ครั้ง, reply 54 ครั้ง, push 20 ครั้ง)
- DB เป็น container บนเครื่อง (IP 172.19.x) ไม่มีการใช้ Supabase MCP หรือ credential จริง
- Container อีกตัวของ session อื่น (`bot-summary-pr184-uat-rest`) ใช้ DB/port คนละชุด ไม่ชนกัน

## 3. การสร้าง Schema (Blocker และวิธีแก้)

**สาเหตุ:** ถ้า replay migration ใน repo แบบต่อเนื่องและข้าม error จะผ่าน 91 ล้ม 42 (ดู `repo-chain-failures.txt`)
- จุดล้มแรกคือ `0032` เพราะ "0042-era baseline" ถูก apply เข้า Production นอกประวัติ migration และ migration หลังจากนั้นล้มต่อกันเป็นทอด
- error `extensions.digest` เป็นเรื่องของ environment (Supabase ติดตั้ง pgcrypto ไว้ใน schema `extensions`)

**วิธีแก้ที่มีหลักฐานใน repo** (ไม่ดึง schema จาก Production และไม่เดาตาราง):
1. `0031` ระบุใน header เองว่า baseline คือ `0042_pending_close_ingest.sql` จาก commit `48450f0` ซึ่งตรงกับ `origin/backup/main-before-legacy` และ blob `e55e853e…` ยืนยันตรงกัน
2. ใช้ลำดับ phase ตาม `docs/staging-baseline-recovery-20261009.md` (commit `87b7c46`): `staging_platform_prerequisites.sql` → 0001..0030 → baseline + test-only ledger RLS → 0031… → `staging_p2e_legacy_unique_name.sql` ก่อน P2E contract → migration ที่เหลือ
3. hash ของ migration ใน branch นี้ตรงกับ manifest ที่ pin ไว้ 129/130 ไฟล์
4. ผล: **replay ผ่าน 137/137 phase** รวม migration ของ PR #182 ทั้ง 3 ไฟล์ (bundle sha256 `bea8eb7a…`)
5. `staging_baseline_verification.sql` ล้มที่ `pending_session_retired_generations` เพราะ migration `20261008150000` อยู่บน branch อื่น ไม่มีใน main และไม่มีใน branch นี้ จึงไม่ใช่ข้อผิดพลาดของ schema PR #182

ลบ scratch DB `uat_chain_probe` (PG 5432) และ `uat_probe` (container) แล้ว

## 4. สถานการณ์ End-to-End

ทุก scenario ส่ง webhook จำลองที่ลงลายเซ็น HMAC ถูกต้องเข้า `/api/webhook/line` จริง และเรียก cron ผ่าน `/api/cron/*` จริง ใช้ข้อมูลสังเคราะห์ทั้งหมด (1 รูป = 100 บาท)

| # | สถานการณ์ | ผลที่คาด | ผลจริง | ผล |
|---|---|---|---|---|
| 1 | 25 รูปตามลำดับปกติ | ครบ 25 ทุกขั้น, completed, สรุป 1 ครั้ง | raw 25 / ledger 25 / evidence 25 / OCR 25, `completed`, 2,500 บาท, push 1 | PASS |
| 2 | รูปที่ 6 เสียชั่วคราว | retry แล้วกลับมาได้ | รูป 6 `attached` (attempt ≥2), 25/25, `completed`, 2,500 | PASS |
| 3 | รูปที่ 6 เสียถาวร | สถานะชัด ห้ามหายเงียบ | `failed_permanent:5:download_failed`, `review_needed`, `failed_count=1`, 2,400 + "ยังไม่ครบ: 1 รูป"; claim ช่วงแรกยัง `closing` | PASS |
| 4 | ปิดชุดทันทีหลังรูป 25 ใบ (payload เดียว, 15 รูป retry) | ห้ามสรุปก่อนครบ | timeline ไม่มี push ขณะ attached <25, สุดท้าย 25/25 `completed`, push 1 | PASS |
| 5 | ส่ง webhook ซ้ำ (redelivery + message id ซ้ำ) | ไม่มีรายการ/ยอดซ้ำ | raw 11 (ซ้ำ 1 ที่ webhookEventId ใหม่), ledger 10, evidence 10, OCR 10, 1,000 บาท, push 1 | PASS |
| 6 | รูปผิดลำดับ, `จบสลิป` มาก่อนรูปท้าย 5 ใบ, มีรูปที่ส่งหลังปิดจริง | ไม่ตกหล่น และรูปหลังปิดไม่เข้าชุด | 25 `attached`, รูปหลังปิด `excluded_after_close`, `completed`, 2,500 | PASS |
| 7 | Cron หยุดหลายรอบ (3 รูปเสีย) | เห็นรายการค้าง, ไม่ completed | ก่อนหมดเวลา: accounting `waiting=3`, health `retry_pending=3`; หลังเกิน 2,160 วินาที: `review_needed`, "ยังไม่ครบ: 3 รูป", 2,200 บาท; ภายหลัง 3 รูปถูกบันทึกเป็น `late_after_finalize` | PASS |
| 8 | OCR timeout + DB error | ไม่รายงานยอดผิด | รูป 3 ได้ `FAILED:extractor_http_timeout` ไม่ถูกนับ; ช่วงที่ accounting RPC หาย: `processing`, push 0; กู้แล้ว `review_needed`, 400 บาท, push 1 | PASS |
| 9 | Alert dry-run และกันแจ้งซ้ำ | ไม่แจ้งซ้ำ | dry-run: `sent:false` ทั้งสองครั้ง แต่ `unhealthy` มองเห็นได้; ตั้งผู้รับ mock: ครั้งแรก `sent:true incident`, ครั้งที่ 2-3 `throttled`, push 1 | PASS |
| 10 | Batch ที่ครบสรุปครั้งเดียว | 1 push ต่อ batch | 20 กลุ่ม กลุ่มละ push เดียว, เรียก cron ซ้ำไม่เกิดซ้ำ | PASS |

ไฟล์ `results-run1-invalid.jsonl` คือรอบแรกที่ใช้ไม่ได้เพราะ bug ของ harness (ดูข้อ 8) เก็บไว้เป็นหลักฐาน ไม่ได้นับรวม

## 5. ข้อความ LINE จำลองที่ผู้ใช้เห็น (ตัดบางส่วน)

ตัวอย่างชุดครบ (S1):
```
สรุปชุดสลิปเงินโอน ยูเอที — ราชพฤกษ์ — 20/10/2569
รับทั้งหมด: 25 รูป
อ่านครบ: 25 รูป
รอตรวจมือ: 0 รูป
ยอดรวมที่อ่านได้: 2,500 บาท
```
ตัวอย่างชุดไม่ครบ (S7):
```
รับทั้งหมด: 22 รูป … ยอดรวมที่อ่านได้: 2,200 บาท
⚠️ ยอดนี้ยังไม่ครบ ห้ามใช้เป็นยอดรวมทั้งหมด
รับรูปจาก LINE: 25 รูป
เข้าชุดแล้ว: 22 รูป
ยังไม่ครบ: 3 รูป (ส่งใหม่หรือให้แอดมินตรวจมือ)
- ยังประมวลผลไม่เสร็จ: 3 รูป
```
ข้อความ reply ระหว่างทาง: "เปิดชุดสลิปเงินโอนแล้ว…", "รับรูปหลักฐานแล้วครับ…", "รับคำสั่งจบชุดแล้ว กำลังตรวจสอบสลิปทั้งหมด…" (ทั้งหมดอยู่ใน `mock-line-pushes.json`)

## 6. Financial Integrity — Gate 2: PASS

- **ไม่มี false complete:** ทั้ง DB ไม่มี batch `completed` ที่มีรูปขาด (`failed_permanent`/`late`/ยังค้าง) เลย (`batches_completed_with_missing = 0`)
- **ไม่มี silent loss:** ทุกรูปที่รับมามีสถานะใน ledger และรูปที่หายถูกบันทึกเป็น `failed_permanent` (2) หรือ `late_after_finalize` (3) และ alert รายงาน
- รูปที่หายหรืออ่านไม่ได้ไม่ถูกนับเป็น 0 บาท (S3 2,400 / S7 2,200 / S8 400 คือผลรวมเฉพาะที่ verify แล้ว พร้อมคำเตือนว่ายังไม่ครบ)
- webhook ซ้ำไม่ทำให้ยอดเพิ่ม (S5) และ batch ที่ครบสรุปครั้งเดียว (S10)
- จำนวน raw / queue / ledger / evidence / OCR / สถานะ batch สอดคล้องกันทุก scenario (ตารางข้อ 4)

## 7. Recovery และ Rollback — Gate 3: PASS

**Worker crash:** ฆ่า process แอปกลาง burst 25 รูป
- ก่อนฆ่า: ledger `attached 8 / ingesting 1 / received 16`, queue `processed 9 / processing 1 / pending 16`
- restart แล้วให้ cron กู้: `attached 25`, evidence 25 (ไม่ซ้ำ), `batch_index` 25 ค่าไม่ซ้ำ, OCR 25, `completed`, push 1

**Full rollback ทำบน UAT DB เดียวกัน:**
1. ปิด flag alert → `mode: disabled`, push 0
2. alert down สำเร็จ ตาราง/ฟังก์ชันของ alert หายไป ledger ยังอยู่
3. ledger down ขณะมีรูปค้าง 1 รูป → ถูกปฏิเสธ (exit 3) และไม่มีอะไรถูก drop จากนั้น drain จน `failed_permanent:5` แล้ว batch เป็น `failed` พร้อมแจ้งว่ารูปหาย
4. rollback แอป: หยุดแอปของ PR แล้วเปิด **โค้ดก่อน PR `11e2f43` จริง** (Next 16.2.6)
5. ledger down สำเร็จ: ฟังก์ชัน ledger 0, trigger 0, คอลัมน์ window 0, `claim_closing_slip_batch` กลับเป็น 3 argument, เก็บแถว ledger ไว้ 273 แถวสำหรับ audit, OCR fencing ยังอยู่
6. โค้ดก่อน PR บน schema ที่ rollback แล้ว: เปิดชุด → 5 รูป → `จบสลิป` → finalize ได้ `completed`, 500 บาท, push 1 และไม่เขียน ledger
7. ข้อมูลเงินที่สรุปไปแล้ว 18 batch ตรงกันทุกไบต์ก่อนและหลัง rollback (`finalizedUnchanged: true`)
8. รัน down script ทั้งสองซ้ำได้ exit 0 และ snapshot hash ไม่เปลี่ยน

## 8. Defects ที่พบ

| ประเภท | รายละเอียด | การแก้ |
|---|---|---|
| Harness (ไม่ใช่ product) | message id ซ้ำข้ามกลุ่มใน run เดียว ทำให้ ledger รับรูปซ้ำไม่ได้ | ใช้ id จาก md5 ของกลุ่ม แล้วรันใหม่ทั้งหมด |
| Harness | time-travel ของ S7 เลื่อนแค่ `closing_at` แต่เพดานเวลานับจากรูปที่รับล่าสุด (`received_at`) ซึ่งเป็นพฤติกรรมที่ถูกต้อง | เลื่อน `received_at` ด้วย |
| Harness | trigger `updated_at` เขียนทับ time-travel ของ S8 | ปิด trigger เฉพาะคำสั่งนั้นด้วย `session_replication_role` |
| P2 UX (ไม่กระทบยอด) | ชุดไม่ครบ: บรรทัดแรก "รับทั้งหมด: 22 รูป" ขัดกับคำเตือน "รับรูปจาก LINE: 25 รูป" | ไม่ได้แก้ อยู่นอก scope P0 (งานปรับรูปแบบสรุปคือ P1) แต่คำเตือนยังชัด |
| Environment | ไฟล์ verification ที่ pin ไว้ต้องการ migration จาก branch อื่น | บันทึกไว้ ไม่ใช่ข้อบกพร่องของ PR #182 |

**ไม่พบ P0/P1 ใน product และไม่ได้แก้โค้ดของ product ในรอบนี้**

## 9. สิ่งที่ Mock พิสูจน์ไม่ได้ (แยกจาก Real Integration UAT)

- พฤติกรรมจริงของ LINE: ลำดับและเวลาการส่ง webhook, redelivery, ขนาดและความเร็วของ content API, การหมดอายุของ reply token, quota และ rate limit ของ push
- OCR จริง (`gpt-6-luna`): ความแม่นยำ, latency, 429 และค่าใช้จ่าย
- ข้อจำกัดของ Vercel: `maxDuration`, memory, cold start, พฤติกรรม `after()` ใน serverless, concurrency
- GitHub cron จริง: ความล่าช้าและการข้ามรอบ (ในทดสอบใช้ time-travel แทน)
- ความตรงกันกับ schema ของ Production: replay ยืนยันได้แค่ประวัติ migration ใน repo + fixture ที่มีหลักฐาน ไม่ได้ยืนยันว่าตรงกับ Production ทุกจุด
- ความเร็วและขนาดของ Supabase Storage จริงบน cloud (Storage local ทำงานจริง แต่เป็น local)

## 10. การตัดสิน

- **PR #182 — ISOLATED UAT: GO**: Isolation, End-to-End 10/10, Financial Integrity, Recovery และ Rollback ผ่านครบ ไม่พบ P0/P1
- **PRODUCTION RELEASE: NOT AUTHORIZED**: ต้องมี real-integration UAT แยก (ข้อ 9) ตรวจ migration history ของ Production ก่อน apply และให้เจ้าของอนุมัติ release รอบเดียว ครอบคลุม merge, migration 3 ไฟล์, env `SLIP_CLOSE_INGEST_MAX_SECONDS=2160` และผู้รับ alert

## Cleanup ที่ยังเหลือ (รอผู้ใช้ตัดสินใจ)

ตั้งใจเก็บไว้เพื่อให้ตรวจสอบย้อนหลังได้:
- DB `botsummary_baseline_replay_20261009c` และ DB `postgres` ของ stack (มี schema ชุดย่อยจากความพยายามรอบแรก)
- container `uat182-rest`, `uat182-gw` และ Supabase local stack (`bot-summary-staging`)
- worktree ของโค้ดก่อน PR: `C:\GitHub\_worktrees\bot-summary-pr182-prepr-uat` (มี junction `node_modules`: ต้อง `rmdir` junction ก่อน `git worktree remove`)
