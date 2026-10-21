# PR #182 — Integration Verification Report (17 ตุลาคม 2026)

**Independent Review: GO สำหรับรับช่วงตรวจแบบ read-only / UAT: NO-GO**

รายงานนี้เป็นผล integration verification หลังรวมงานและแก้ข้อผิดพลาดเพิ่มเติม ไม่ใช่ independent approval ของผู้แก้ และไม่อนุญาต commit, push, merge, deploy, เริ่ม UAT, ใช้ Production, ส่ง LINE จริง หรือ apply migration กับ remote DB

## ขอบเขตและตัวตนของงาน

- Worktree ที่มีอยู่จริง: `C:\GitHub\_worktrees\bot-summary-p0-slip-ingest-20261017` (path `C:\GitHub_worktrees\...` ตามข้อความรับช่วงไม่มีอยู่)
- Branch: `fix/p0-slip-image-ingestion-20261017`
- HEAD: `11854d80c3ffee2af1825ae5593bf2316b7eead5`
- Baseline: freshly fetched `origin/main` = `11e2f4342a900d6dcaf0107f47970ed2a2bc46e4`
- Candidate คือ HEAD พร้อม **uncommitted changes** ทั้งหมด ไม่ใช่ published PR head รุ่นใหม่ ยังไม่มี staging/commit/push
- Source manifest: `.tmp-pr182-verification/source-manifest.json` ครอบคลุม 35 ไฟล์ source/test/config/migration ที่เปลี่ยน ไม่รวมเอกสาร
- SHA256 ของรายการ source hashes: `4cdcd3c159bec6a67965096a4350562b48c0272f26cbd12e3821128300199715`
- เก็บ inherited patch/hash ก่อนแก้ใน `.tmp-pr182-verification/initial.patch` และ `initial-hashes.json`; ไม่ reset หรือทิ้ง uncommitted changes
- ตรวจ process และความนิ่งของไฟล์ก่อนเริ่ม พบ Bun test เดิมค้างสอง process จึงหยุดเฉพาะสอง PID นั้น ไม่มีหลักฐานว่ามี agent อื่นกำลังเขียนไฟล์ แต่การดู process อย่างเดียวไม่รับประกันอนาคต จึงใช้ source hash ตรวจซ้ำก่อนส่งต่อ

ใช้ PostgreSQL 17 เฉพาะ `127.0.0.1:5432` และฐานข้อมูลชั่วคราวที่ harness สร้างเอง ใช้ mock LINE/Storage/OCR และ fetch guard ปฏิเสธ external hosts ไม่มีการ replay batch Production จริง

ติดตั้ง dependencies แยกสำหรับ worktree เพราะ node_modules เดิมเป็น junction ไป repo หลักและมี Next 16.2.6 ซึ่งไม่ตรง package.json 16.3.4 ปัจจุบันทดสอบด้วย Node 24.16.0, Bun 1.3.14, Next 16.3.4; package.json/lockfile ของ repo ไม่ถูกแก้ การติดตั้งใช้ `--ignore-scripts` baseline และ candidate ใช้ installation เดียวกันเพื่อเปรียบเทียบอย่างเป็นธรรม Shared node_modules ของ repo หลักไม่ถูกแก้

## ผลทดสอบที่รันจริง

| รายการ | ผล | หลักฐานใน `.tmp-pr182-verification/` |
| --- | --- | --- |
| P0 PostgreSQL gate ทั้ง 7 ไฟล์ | 88 ผ่าน / 0 ล้มเหลว, exit 0 | `p0-pg-final.log`, `p0-pg-final.xml`, result JSON |
| Unit/caller gate ตาม CI ที่ปรับแล้ว 12 ไฟล์ | 176 ผ่าน / 0 ล้มเหลว, exit 0 | `p0-unit-gate.log`, result JSON |
| PostgreSQL ทั้ง repo 50 ไฟล์ | 818 ผ่าน / 1 ล้มเหลว / 3 skipped sentinel | `final-pg-summary.json` และ log/XML รายไฟล์ |
| Unit tests candidate ทั้ง repo (ไม่รวม PG) | 5,347 ผ่าน / 22 ล้มเหลว, 5,369 tests / 289 files, exit 1 | `candidate-unit-report.log`, `.xml`, result JSON |
| Unit tests clean origin/main ด้วย dependencies เดียวกัน | 5,293 ผ่าน / 22 ล้มเหลว, 5,315 tests / 285 files, exit 1 | `baseline-unit-declared.log`, `.xml`, result JSON |
| TypeScript `tsc --noEmit --incremental false` | exit 0 | `tsc-final.log`, result JSON |
| ESLint ทั้ง repo | 718 files, 0 errors / 71 warnings, exit 0 | `eslint-report.json`, `eslint-report.log`, result JSON |
| Next.js 16.3.4 build (`next build --webpack`) | exit 0; generated manifest ระบุ cron maxDuration 60 | `build-final.log`, result JSON; `.next/server/functions-config-manifest.json` |
| `git diff --check` | exit 0; มีเพียง LF/CRLF advisory | ตรวจซ้ำก่อนส่งต่อ |

จำนวนของ gate เป็น subset ของชุดใหญ่ ห้ามนำมาบวกเป็นจำนวน unique tests ทั้งหมด

PostgreSQL ทั้ง 50 ไฟล์มี 49 ไฟล์ exit 0 และ 1 ไฟล์ exit 1; 3 skipped เป็น **inverse availability sentinel** ที่ตั้งใจข้ามเมื่อ PostgreSQL พร้อมใช้งาน ไม่ใช่ functional suite ที่ไม่ได้รัน: migration-0047 มี functional 11 ผ่าน, migration-p4a-review-presentation-guard มี 13 ผ่าน และ migration-p4a มี 15 ผ่าน ตรวจทั้ง log และ `describe.skipIf(pgAvailable)` แล้ว

สอง suite เดิมเกิน watchdog 240 วินาที จึงรันใหม่โดยให้ 1,200 วินาที: inventory-cost migration-0054 ได้ 33/0 (ประมาณ 890 วินาที) และ purchase-capture integration-slice-c2 ได้ 9/0 (ประมาณ 332 วินาที) ผล timeout เดิมไม่ใช่ผลสุดท้าย ดู `pg-04-retry.*`, `pg-37-retry.*`

### Regression เทียบ baseline

เปรียบเทียบ failing testcase identities จาก JUnit XML: **Unit regression ใหม่ 0, resolved 0**; candidate เพิ่ม 54 tests และมี failure เดิมตรงกันทั้ง 22 รายการ รายชื่อเต็มอยู่ใน `unit-baseline-failures.txt` กลุ่มที่ล้มเหลวครอบคลุม central-price/financial report expectations, LINE logging และ migration-history assertions ไม่ได้แก้ประวัติ Production หรือเปลี่ยน assertions เหล่านั้นเพื่อให้เขียว

PostgreSQL ที่ล้มเหลวคือ `src/lib/produce/migration-finalized-session-replacement.pg.test.ts` ใน fixture setup เมื่อใช้ `20261007060911_produce_nonblocking_item_count.sql`: `produce item count: unexpected finalizer count-check definition` ตรวจแยกบน clean origin/main แล้วล้มเหลวแบบเดียวกัน (0 ผ่าน / 1 ล้มเหลว) ดู `baseline-produce-replacement-pg.log` จึงไม่พบ failure ใหม่จาก candidate ใน PG run นี้ แต่ **ไม่อ้างว่าชุด PG ทั้ง repo ผ่านหมด** และไม่ได้รัน PG ทุกไฟล์ซ้ำบน baseline; รัน baseline เฉพาะไฟล์ที่ล้มเหลวเพื่อจำแนก regression

## สถานะ 8 findings เดิม

| Finding | ผล local integration verification | หลักฐาน / ขอบเขต |
| --- | --- | --- |
| P0-1 accounting ล้มเหลวแล้วกลายเป็น missing=0 / partial complete | ผ่านกรณีที่ทดสอบ | accounting timeout/throw/malformed/missing RPC หยุดก่อนส่ง summary; healthy retry ส่งพร้อม missing notice; recovery route ไม่ push/update เมื่อ accounting error |
| P0-2 open + images payload เดียวก่อนมี session | ผ่านกรณีที่ทดสอบ | receipt เป็น unbound ก่อน drain; ordered open/images/close; 25 รูปและรูปที่ 13 เสีย ทั้ง inline/deferred; 24 attached + 1 explicit missing |
| P0-3 trigger/RPC error แล้วตกไป legacy silently | ผ่านกรณีที่ทดสอบ | trigger failure rollback queue receipt; transient/malformed begin คง pending; missing RPC บน migrated schema ไม่ bypass ledger; redelivery/recovery ทำต่อได้ |
| P1 OCR redrive ไม่มี atomic claim/fence | ผ่านกรณีที่ทดสอบ | competing workers, expired/stale token, terminal checks, finalized/processing batch ไม่ถูกเขียนทับ; missing claim บน ledger DB ไม่ใช้ unfenced upsert |
| P1 scheduler เทียบ retry/deadline | **ผ่าน policy model แบบมีเงื่อนไข; ยังไม่ยืนยัน actual runtime cadence หรือ five-attempt guarantee** | scheduler ทุก 300 วินาที; default cutoff 1200; modeled short failures/in-request retries ผ่าน รวม degraded case; ไม่มีการเปลี่ยน scheduler จริง |
| P1 image lease ไม่มี owner fencing | ผ่านกรณีที่ทดสอบ | A หมด lease → B/C claim แล้ว A attach/fail เปลี่ยน lease ใหม่ไม่ได้; crash ยังใช้ attempt budget; concurrent claim มีผู้ชนะคนเดียว |
| P1 compatibility / rollout / rollback อ้างเกินจริง | ผ่าน local protocol ที่แก้แล้ว | old-schema open/close fail explicit; partial migration fail closed; guarded rollback, audit + RLS/privileges; old/new concurrent workers ยังไม่ปลอดภัย ต้องหยุด workers ก่อน rollout |
| P1 overall budget ไม่ครอบ provider I/O | ผ่านกรณีที่ทดสอบ | hanging download/OCR bounded; ไม่เริ่มงานที่เวลาไม่พอ; cron recovery 45s, route 60s literal, caller 70s; default recovery redrive OCR ได้จริง |

ดังนั้น 7 findings มี regression evidence สำหรับพฤติกรรมที่แก้ ส่วน scheduler ยังมีเงื่อนไขสำคัญ ห้ามสรุปว่า 8 findings ปิดโดยไม่มีข้อจำกัด หรือรับรองจากรายงานผู้ implement เพียงอย่างเดียว

### เหตุการณ์ 25 รูป / ไม่มีรูปหายเงียบ

- Pre-fix synthetic baseline ทำซ้ำรูปร่างปัญหา 25 received / 5 attached / 1 failed / 19 ไม่มี evidence ได้จริง ไม่ใช่ replay payload จริงของ incident
- Candidate ทดสอบ 25 รูปที่รูปที่ 6 เสียถาวร: อีก 24 รูปเดินต่อ ไม่มีการหายตามรูปเสีย และ summary แสดง 25 received / 24 attached / 1 incomplete ยอดไม่ถูกประกาศครบ; ถ้าเสียครั้งเดียว retry แล้วได้ 25 attached
- อีกชุดส่ง `[open, 25 images, close]` ใน payload เดียว โดยรูปที่ 13 เสีย ทั้ง inline และ deferred: ledger ครบ 25, 24 attached, 1 failed_permanent, summary มีข้อความยอดยังไม่ครบและสถานะ review_needed
- ตรวจ redelivery/deduplication, worker crash หลังเก็บ evidence, stale leases, finalizer race, หลัง close, สอง sessions/สอง groups และ accounting unavailable ด้วย local PG + mocked providers

## สิ่งที่แก้เพิ่มใน session นี้

งานค้างเดิมยังอยู่ครบ ไม่เริ่ม implementation ใหม่ แก้ integration gaps ที่ตรวจพบดังนี้:

1. `src/app/api/cron/finalize-slip-batches/route.ts`: Next static config ต้องเป็น `maxDuration = 60` literal; build ก่อนแก้ล้มเหลว หลังแก้ exit 0
2. `src/lib/line/webhook-service.ts`: default recovery cap เดิมสั้นกว่าเวลาขั้นต่ำที่จะเริ่ม OCR จึงไม่ redrive; ปรับให้ cron ใช้ 45s; ปิด missing-begin-RPC bypass บน ledger schema
3. `src/lib/slips/check-service.ts`: missing OCR claim RPC บน ledger DB ต้องหยุดและแจ้ง prerequisite migration แทน unfenced fallback
4. `src/lib/slips/slip-session-service.ts`: ตรวจ presence ของ ledger-era column ใน session row เพื่อแยก legacy schema จาก missing RPC บน migrated schema
5. `.github/workflows/finalize-slip-batches.yml`: HTTP timeout 30 → 70s ให้พอกับ route 60s; ไม่เปลี่ยน cron expression
6. `.github/workflows/pg-tests.yml`: ให้ P0 gate ครอบคลุม caller suites ที่ integration พบ stale mocks รวมเป็น 12 unit files
7. `src/app/api/cron/finalize-slip-batches/recover/route.test.ts`: ปรับ accounting RPC mock และเพิ่ม assertion ว่า error ไม่ส่ง/ไม่ update
8. `src/lib/slips/image-ingestion.pg.test.ts`: regression default OCR redrive และแก้ลำดับ positional SQL args ในสอง test calls
9. `src/lib/slips/image-ingestion-ordering.pg.test.ts`: เปลี่ยน assertions ที่เคยยอม permissive missing-RPC fallback ให้ตรวจ pending/no legacy attachment บน migrated schema
10. `src/lib/slips/ocr-claim.pg.test.ts`: regression partial OCR migration
11. `src/lib/slips/ingest-policy.test.ts`: static route duration และ scheduler caller timeout ต้องสอดคล้องกัน
12. `supabase/rollback/20261017100000_slip_image_ingestion_ledger.down.sql` และ `src/lib/slips/schema-compat.pg.test.ts`: ป้องกัน rollback audit tables ด้วย RLS/revoke client privileges และทดสอบจริง
13. `.env.example`: ระบุ default 1200 และเงื่อนไขของ cutoff
14. `docs/handoffs/p0-slip-image-ingestion-reliability.md`, `p0-pr182-crosscheck-remediation-20261017.md` และรายงานนี้: อัปเดตผลจริง/ข้อจำกัด โดยรักษารายงานเดิมเป็นประวัติ

รายชื่อ 16 ไฟล์ที่เปลี่ยนจาก takeover snapshot ก่อนเพิ่มรายงานนี้อยู่ใน `session-changed-files.json`; รวมรายงานใหม่เป็น 17 ไฟล์ใน session นี้ (ไม่ได้แปลว่า diff ทั้ง PR มีเพียง 17 ไฟล์)

## Migration, rollback, CI และ scheduler

ทั้ง `20261017100000_slip_image_ingestion_ledger.sql` และ `20261017110000_slip_ocr_claim_fencing.sql` ถูก apply บน disposable local DB ผ่าน harness เท่านั้น ตรวจ function behavior/privileges/idempotency และ rollback ด้วย PG จริง ไม่ได้ apply remote

Rollout ต้องหยุด intake/cron/old workers แล้ว apply **ทั้งสอง migration ตามลำดับก่อน** application ใหม่ ไม่ปล่อย old/new OCR workers ทำงานร่วมกัน ledger health อย่างเดียวไม่ยืนยัน migration OCR ครบ Old-schema explicit failure เป็น prerequisite ที่ต้องยอมรับ ไม่ใช่ seamless compatibility

Rollback script ปฏิเสธ inflight receipts โดย default; forced override เก็บ audit แต่ยอม degraded legacy behavior จึงไม่ใช่ lossless rollback อัตโนมัติ คง ledger audit และ additive OCR functions/columns ไว้ ไม่มี destructive OCR down script หลัง rollback/reapply ต้อง apply ทั้งสอง migrations อีกครั้งเพื่อคืน fenced OCR redrive

CI gate ใหม่รันคำสั่งเทียบเท่าในเครื่องแล้ว แต่ **ยังไม่เคยรันบน GitHub สำหรับ uncommitted candidate นี้** จึงไม่มี remote CI green ของ source ชุดนี้

Scheduler จริงใน repo ทุก 300 วินาที ส่วน 1200 วินาทีเป็น ingest cutoff หาก in-request retries ทำงานและ failure สั้น policy model รับได้ แต่ worker ถูก kill / provider ช้า / queue backlog / cron ช้าหรือข้ามรอบ อาจ cutoff ก่อนครบ 5 attempts; model กรณีไม่มี in-request retries ต้องใช้ 2040 วินาที เมื่อ cutoff ต้องแสดง incomplete ไม่รับรองว่ากู้ภาพได้ครบทุกกรณี Independent reviewer ต้องตัดสินเงื่อนไขนี้ก่อนอนุมัติ UAT

## ขั้นต่อไปและสิ่งที่ยังไม่ตรวจ

หยุดแก้ code หลัง source seal และส่งให้ **Codex chat ใหม่ที่ไม่มี fork history** ตรวจ read-only จาก working tree จริง Reviewer ต้องอ่าน diff และสร้างหลักฐานทดสอบของตัวเอง เอกสารนี้เป็นเพียง index ไม่ใช่หลักฐานแทนการตรวจ ห้ามใช้ commit SHA อย่างเดียวเพราะ fixes ยัง uncommitted และห้าม review repo หลักแทน target worktree

**GO: รับเข้า Independent Review ได้ เพราะมี candidate ที่ระบุ identity ได้, P0 local gates ผ่าน และไม่พบ test regression ใหม่จาก baseline ที่เปรียบเทียบ** ไม่ใช่ GO สำหรับ UAT หรือ release

**NO-GO: UAT** จนกว่า independent review จะเสร็จ, scheduler/rollout conditions และ baseline failures ได้รับ disposition ที่ชัดเจน และผู้ใช้อนุมัติขั้นถัดไปโดยตรง

ยังไม่ตรวจ Production data/payload, remote migration state, actual scheduler execution/lateness, Vercel deployed runtime, real LINE/Storage/OCR, remote CI ของ candidate หรือ staging rollout/rollback rehearsal ไม่มีการเริ่ม UAT ความเสี่ยงหลักคือ scheduler cutoff ก่อนครบ retry, mixed-version OCR writes ระหว่าง rollout และ failure เดิม 22 unit + 1 PG ที่ยังไม่แก้

ส่งต่อ Independent Review แล้ว: Codex chat `PR #182 — Independent Review หลัง Integration Verification` (`01a149d5-2f02-71f3-9a11-b92dbde841ec`) เริ่มด้วย fresh prompt ไม่มี fork history และกำหนด read-only source พร้อมสร้างหลักฐานเอง การส่งต่อไม่ใช่ผลอนุมัติ review และ UAT ยัง NO-GO
