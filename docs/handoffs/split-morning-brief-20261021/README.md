# แยก Morning Brief ผลไม้ 08:00 / ผัก 14:00

ฐานงาน: `80a38e9dc6e266a011b19dd693e0ae767a35b0d4` (latest main รวม PR #184)

อัปเดต 22 ต.ค. 2569: เปลี่ยนเวลาผักที่กำหนดไว้เป็น **14:00 Asia/Bangkok / 07:00 UTC** งานนี้แก้ configuration, tests และคู่มือเท่านั้น **ยังไม่เปลี่ยน Production Cron และไม่ส่ง LINE จริง** เวลา 13:00 ที่อยู่ใน PDF/JSON snapshots และสคริปต์ render เดิมเป็นเวลาสร้างหลักฐานย้อนหลัง ไม่ใช่ scheduler

## ไฟล์ที่เปลี่ยน

- Entry points: `src/app/api/cron/daily-morning-brief/route.ts`, `src/app/api/cron/daily-stock-summary/route.ts` และ tests คู่กัน
- Shared loading/scope: `src/lib/summary/morning-brief-service.ts`, `src/lib/sales/load.ts`, `src/lib/summary/purchase-planning-service.ts`
- Report/template/delivery: `src/lib/summary/morning-brief.ts`, `morning-brief-message.ts`, `morning-brief-pdf.tsx`, `daily-stock-cron.ts` และ `src/lib/pdf/MorningBriefA4Doc.tsx`
- Tests: เพิ่ม `src/lib/summary/morning-brief-scope.test.ts`; เพิ่ม scoped PDF case ใน `morning-brief-pdf.test.tsx`; ปรับ inherited fixtures/assertions ใน `summary/morning-brief.test.ts`, `summary/purchase-planning-service.test.ts`, `sales/message.test.ts`, `white-sheet/central-pricing.test.tsx`, `white-sheet/withdrawal-central-price-seed.test.ts`
- Configuration: `.env.example` และ manual-only `.github/workflows/daily-morning-brief.yml`
- หลักฐาน/สคริปต์ UAT/PDF อยู่ใน directory นี้ ไม่มี migration และไม่ได้แก้ `vercel.json`

## พฤติกรรมหลังแก้

| รายงาน | เวลา Bangkok | Endpoint | ผู้รับ LINE |
| --- | --- | --- | --- |
| ผลไม้ | 08:00 / 01:00 UTC | `/api/cron/daily-morning-brief` หรือ `?scope=fruit` | `MORNING_BRIEF_LINE_TARGETS` |
| ผัก | 14:00 / 07:00 UTC — **รออนุมัติเปลี่ยน Production** | `/api/cron/daily-morning-brief?scope=vegetable` | `MORNING_BRIEF_VEGETABLE_LINE_TARGETS` |

ทั้งสองใช้ business date ก่อนหน้าจาก helper เดิม (`resolveStockSummaryDate`) และรองรับ `?date=YYYY-MM-DD` สำหรับ backfill โดยไม่เลื่อนวัน ข้อมูลอ้างอิง `produce_transactions.transaction_date` ไม่ใช่เวลาเข้า LINE

คัดตลาดก่อนเรียก calculator เดิม: ผลไม้คงทุกตลาดในขอบเขตเดิมยกเว้นพาซิโอ้ผัก; ผักรับเฉพาะพาซิโอ้ผักและ reviewed aliases ผ่าน `canonicalMarketLabel` รวมพาซีโอ้ผัก ใช้ market label ของ Accountability Round ก่อน raw label ไม่ใช้ชนิดสินค้าเพื่อตัดสิน scope และไม่แก้ transaction IDs หรือ round IDs

หัวข้อหมวดผลไม้/อื่นๆ อาจปรากฏใน PDF ผักได้เมื่อเป็นสินค้าที่ตลาดพาซิโอ้ผักขายจริง เช่นเดียวกับสินค้าผักที่ขายในตลาดผลไม้ ขอบเขตตัดที่ตลาด ไม่ตัดสินจากชื่อสินค้า

`calculateSalesReport`, purchase-planning calculator, settlement, white-sheet calculator และสูตรทางการเงินไม่ได้เปลี่ยน ค่า default ของ shared loaders ที่ caller อื่นใช้อยู่ยังคงเดิม Morning Brief ส่งแถวที่กรองแล้วและ failure scan เดียวกันให้ทั้ง sales และ purchase planning เพื่อให้ใช้หลักฐานชุดเดียวกัน

ผักต้องมีเบิกและคืนดีในวันที่ขอที่แชร์ Accountability Round อย่างน้อยหนึ่งรอบ คืนเสียไม่ทดแทนคืนดี รอบอื่นที่ยังไม่ครบยังแสดงสถานะตาม calculator เดิม ถ้ามีเอกสาร legacy ที่ยังไม่ผูก round จะ not_ready (`unbound_accountability_round`) แม้รอบอื่นพร้อมแล้ว เพื่อไม่เปิดทางให้ legacy fallback จับคู่เอกสารโดยไม่มีหลักฐานรอบ เอกสารครบไม่ยกระดับรายการให้เป็นยอดยืนยัน หากไม่มีคู่รอบที่พร้อมจะคืน HTTP 200, `status: not_ready`, `reasons`, `sent: false`, `pdfDelivered: false` ก่อน formatter, renderer, upload หรือ LINE

สต็อกบ้านฝั่งผลไม้คงข้อมูลส่วนกลางแบบเดิม ไม่ตีความว่าจัดสรรให้ตลาดใด ฝั่งผักไม่มีหลักฐาน allocation จึงแสดง unknown ทั้ง quantity, value และพร้อมขายรวมบ้าน ไม่เอาสต็อกบ้านทั้งหมดหรือชนิดสินค้าไปอ้างว่าเป็น allocation ของตลาดผัก

## ตรวจเส้นทางเดิมและความเข้ากันได้

อ่าน `cron.job` ของ Production วันที่ 21 ต.ค. 2569 โดยไม่แก้ไข พบ:

| jobid | jobname | UTC schedule | active |
| --- | --- | --- | --- |
| 9 | daily-morning-brief | `0 1 * * *` | true |
| 3 | daily-stock-summary | `5 1 * * *` | true |
| 4 | daily-sales-summary | `10 1 * * *` | true |

ก่อนแก้ 08:00 และ 08:05 ต่างเรียก `loadMorningBriefReport` + `createMorningBriefPdfArtifact` เขียน PDF/ref path เดียวกันด้วย upsert แต่ส่ง LINE ด้วย retry namespaces คนละชุด จึงส่ง PDF ซ้ำให้ผู้รับที่ซ้อนกันได้

หลังแก้ 08:00 เป็นเจ้าของ Morning Brief PDF/ref และการส่ง PDF เพียงเส้นทางเดียว แม้ไม่มีผู้รับก็ยังสร้าง reference snapshot ตามหน้าที่เดิมที่ย้ายมาจาก 08:05 ส่วน 08:05 ส่งข้อความของดีชั่งคืนและสต็อกบ้านต่อ ใช้ retry keys เดิม แต่ไม่สร้าง/ส่ง Morning Brief PDF ซ้ำ เส้นทาง 08:10 และ active Production schedules ไม่ได้เปลี่ยน

ค้น consumers ของ bucket/filename/ref JSON ใน `src`, `scripts`, `docs` แล้ว ไม่พบตัวอ่านในแอปที่ hard-code legacy paths; มี writer และ tests เท่านั้น คง helper แบบไม่ระบุ scope ให้ตอบชื่อเดิม และไม่เขียนทับ legacy PDF/ref ใดจาก cron ใหม่:

| รูปแบบ | PDF | Reference |
| --- | --- | --- |
| legacy | `DATE/morning-brief-DATE.pdf` | `DATE/morning-brief-DATE.ref.json` |
| fruit | `DATE/morning-brief-fruit-DATE.pdf` | `DATE/morning-brief-fruit-DATE.ref.json` |
| vegetable | `DATE/morning-brief-vegetable-DATE.pdf` | `DATE/morning-brief-vegetable-DATE.ref.json` |

ก่อน deploy ต้องตรวจ consumers ภายนอก repo และย้ายผู้รับ PDF ที่เคยมีเฉพาะใน `STOCK_SUMMARY_LINE_TARGETS` ไปยัง `MORNING_BRIEF_LINE_TARGETS` ตามความต้องการธุรกิจ มิฉะนั้นผู้รับกลุ่มนั้นจะยังได้ข้อความสต็อก แต่ไม่ได้ PDF ที่ 08:05 อีก

PDF retry key แยก scope/date/target และมี part identity คงที่ ไม่ขึ้นกับจำนวนข้อความ LINE ข้อความผลไม้ยังใช้ retry namespace เดิม; ผักมี namespace แยก `retry_nonce` ยังคงใช้ได้เฉพาะ manual target เพื่อการส่งซ้ำโดยตั้งใจ

## Template และ Field

ทั้งสองใช้ `MorningBriefA4Doc` และ renderer เดียวกัน คง font, ยอดสรุป, KPI และตารางคงเหลือ ตามคำขอล่าสุด PDF ผลไม้และผักไม่แสดงรายการชั่งรายสินค้า กรอบรายละเอียดการตรวจข้อมูล สถานะตามตลาด ข้อความรอตรวจ/รอชั่งคืน/คำนวณไม่ได้ หรือข้อความเตือนใต้ KPI และตาราง ช่องมูลค่าที่ไม่ทราบใช้ “-” รายละเอียดหลักฐานและสถานะยังอยู่ใน reference JSON การคำนวณและ readiness ก่อนสร้างรายงานคงเดิม

| Field | การแสดงผล |
| --- | --- |
| เบิก / ชั่งคืนดี | KPI และ market summary เดิม |
| คืนเสีย | calculator เดิมหักคืนเสียอยู่แล้ว; รายละเอียดอยู่ใน reference JSON |
| ยืนยันแล้ว / รอตรวจ / คำนวณไม่ได้ / รอชั่งคืน | PDF แสดงเฉพาะยอดขายยืนยันแล้ว; สถานะและรายละเอียดตรวจข้อมูลเก็บใน reference JSON |
| สินค้า จำนวน หน่วย ราคา | stock matrix เดิม; ไม่เพิ่มตารางรายการชั่งหรือราคารายแถว |
| คงเหลือตลาด / บ้าน / รวมคงเหลือ / มูลค่าพร้อมขาย | ตำแหน่งเดิม; บ้านผักและยอดรวมที่ต้องใช้บ้านแสดง “-” เมื่อไม่ทราบ |
| ใบขาว / reconciliation / adjustment / purchase planning | คง schema เดิม; กรอง market สำหรับข้อมูลที่มี market identity |
| source transaction identity | PDF reference JSON เก็บ original item/session/round IDs พร้อม calculator rows |

ไม่มีการตัด field เดิมเพราะข้อมูลไม่พร้อม `null` ใน PDF ผลไม้/ผักแสดง `-` ยอดยืนยัน 0 ในรายงานที่พร้อมแต่มีรายการรอตรวจหมายถึงยอดส่วนที่ยืนยันได้ตามระบบเดิม (ไม่แสดงคำอธิบายรอตรวจใน PDF) ไม่ใช่การอ้างว่าขายจริงเป็นศูนย์

## UAT

| # | กรณี | ผลและหลักฐาน |
| --- | --- | --- |
| 1 | ผลไม้ไม่มีตลาดพาซิโอ้ผัก | PASS — synthetic + read-only จริงทั้ง 3 วัน |
| 2 | ผักไม่มีตลาดผลไม้ | PASS — source IDs, market totals, white sheet/reconciliation และข้อความ PDF |
| 3 | ผักมีเบิกและคืนดี | PASS — ready โดยไม่เปลี่ยน confirmation rules |
| 4 | เบิกแต่ไม่มีคืนดี | PASS — not_ready / missing_good_return; ไม่ upload/send |
| 5 | คืนดีแต่ไม่มีเบิก | PASS — not_ready / missing_withdrawal |
| 6 | มีคืนเสีย | PASS — คำนวณผ่าน shared calculator และเก็บ quantity ใน reference JSON |
| 7 | ไม่มีคืนเสีย | PASS — ยัง ready เมื่อเบิกและคืนดีพร้อม |
| 8 | รอตรวจ | PASS — return price mismatch แยก pending; ไม่รวม confirmed |
| 9 | คำนวณไม่ได้ | PASS — invalid quantity คง null และ excluded count |
| 10 | เบิก/คืนต่างรอบ | PASS — no_matching_accountability_round; ไม่จับคู่ข้ามรอบ |
| 11 | ข้อมูลเข้าหลัง 14:00 | PASS — คง business date เดิม; manual rerun จาก not_ready เป็น ready ได้ |
| 12 | รันซ้ำ | PASS — mock provider ยอมรับครั้งเดียวด้วย key เดิม; แยก fruit/vegetable และ fixed PDF key |
| 13 | Path ไม่ชน | PASS — legacy/fruit/vegetable มี 6 paths ไม่ซ้ำ; real renderer + fake bucket ยืนยัน PDF/ref ของแต่ละ scope |
| 14 | A4 / ตัวเลข / ตาราง | PASS — geometry, ทุกเลขหน้า, ไม่มีหน้ารายการชั่ง, ตรวจ PNG และคง baseline overflow 64 สินค้า 4 หน้า |
| 15 | Field เทียบ PR #184 | PASS — shared template เดิมและ field inventory ด้านบน; ไม่เพิ่มรายการชั่งตามคำขอล่าสุด |
| 16 | 08:00 regression | PASS — input เดียวกัน 4 fixtures เทียบ clean main ได้ identical pixels ทุกหน้า |

เพิ่มเติม: reviewed aliases, raw label ขัดกับ round label, legacy unbound round, voided/superseded archive evidence, debug ไม่ส่ง/ไม่ upload และ recipient แยก scope ผ่าน tests

### ข้อมูลจริงแบบอ่านอย่างเดียว

ใช้ Supabase client ที่ปฏิเสธทุก request ที่ไม่ใช่ GET หรือไม่ใช่ `/rest/v1/` ของ project เดิม ไม่มี Storage upload, DML, migration หรือ LINE push ผลรอบสุดท้าย 71 unique GETs, 0 mutations รายงานจริง/PDF เก็บเฉพาะ local `.tmp-live-uat` ไม่ commit raw rows หรือ source IDs ขึ้น PR

| business date | ผลไม้ยืนยัน (บาท) | ผักยืนยัน (บาท) | ผักรอตรวจ (บาท) | ผักคำนวณไม่ได้ | readiness |
| --- | ---: | ---: | ---: | ---: | --- |
| 18/10/2569 | 19,416.50 | 1,680.00 | -1,820.00 | 69 | ready |
| 19/10/2569 | 18,056.50 | 2,955.00 | -30.00 | 55 | ready |
| 20/10/2569 | 17,185.00 | — | — | — | not_ready: ไม่พบเบิกและคืนดี |

ผลรวม confirmed และ pending ของ fruit + vegetable เท่ารายงานเดิมทั้ง 3 วัน ข้อมูลผิดปกติ 18/10 ไม่ถูกเปลี่ยนเป็นยอดยืนยัน รายการที่ไม่ยืนยันมี `expectedSalesSatang = null` วันที่ 20/10 ไม่สร้าง PDF ผัก

Production view ตรวจแล้วว่า `produce_transactions` อ่านจาก `produce_transactions_all WHERE voided_at IS NULL`; lifecycle supersession เดิม void เอกสารที่ถูกแทน จึงไม่อ่าน archive เป็นหลักฐานพร้อม

ไฟล์หลักฐาน: `read-only-results.json`, `read-only-pdf-verification.json`, `visual-verification.json`, `regression.json`, synthetic `pdf/`, synthetic `*.ref.json` และ `rendered/` ไม่ปะปนข้อมูล synthetic กับ Production

สร้าง PDF จริงจาก snapshot เดิมใหม่หลังเอารายการชั่งออก: 5 ไฟล์ รวม 17 หน้า ผ่าน A4/margins และยืนยันว่าไม่มีรายการชั่ง/สถานะ/ข้อความตรวจข้อมูล ไม่อ่าน Production ซ้ำ

### ตรวจ build / tests

- เปลี่ยนเวลา 22 ต.ค. 2569: **112 tests / 5 suites ผ่านทั้งหมด** — scheduler configuration 21, scoped readiness/fields/idempotency 23, PDF 39, sales integrity 7 และ Morning Brief route 22; typecheck, ESLint ของ tests ที่แก้ และ `git diff --check` ผ่าน ใช้ synthetic/mocked I/O เท่านั้น ไม่อ่านข้อมูลธุรกิจ Production และไม่ส่ง LINE จริง ตรวจ SQL เป็น configuration contract เท่านั้น ยังไม่ได้ execute หรือเปลี่ยน Production Cron
- Affected regression: **1,453 tests / 60 ไฟล์ ผ่านทั้งหมด** รันแต่ละไฟล์แยก process เพื่อกัน `mock.module` leakage ใน Bun ครอบคลุม summary, sales, physical inventory, white sheet, round returns, reconciliation, settlement, LINE reply และ cron ทั้ง 3 ตัว ดูผลราย suite ใน `regression.json`
- หลังเอาสถานะและรายละเอียดการตรวจข้อมูลออก รัน PDF/scope/sales integrity ซ้ำ **68 tests ผ่าน**, typecheck และ ESLint ผ่าน ตรวจ PNG synthetic ใหม่และเทียบ baseline ทั้ง 4 fixtures ได้ identical pixels ทุกหน้า
- Typecheck และ Next.js build ผ่าน Build ใช้ Supabase URL `http://127.0.0.1:9` กับ placeholder keys เพื่อไม่ให้ prerender อ่าน Production
- ESLint ของไฟล์ที่เปลี่ยนและ evidence scripts ผ่าน
- ไม่รัน PostgreSQL migration tests ใน local เพราะไม่มี schema change; ให้ required GitHub CI ตรวจต่อบน PostgreSQL จริง
- พบ 5 suites ล้มบน clean main ก่อนงานนี้ ดู `baseline-regression.json` แก้เฉพาะ tests ให้ตรง behavior PR #184: entered-price authority, durian เป็น fruit และ rejected produce fixture ต้องมี header ที่ scan รับได้ ไม่มีการแก้ financial implementation เพื่อทำให้ tests เขียว

ทำซ้ำ synthetic: `bun test --timeout 30000 src/lib/summary/morning-brief-scope.test.ts`, `bun docs/handoffs/split-morning-brief-20261021/render.tsx` และ Python `verify.py` (ต้องมี baseline checkout และ Poppler ตาม path ใน script)

## เปลี่ยน Production เป็น 14:00 — รออนุมัติ ยังไม่ได้ดำเนินการ

Automatic scheduling อยู่ที่ Supabase Cron เท่านั้น GitHub Actions คง manual-only และไม่เพิ่ม Vercel cron รอบนี้ไม่ต้อง rebuild รายงานหรือเปลี่ยน endpoint, ผู้รับ, PDF fields, calculator, validation หรือ readiness: ผักยังต้องมีเอกสารเบิกและคืนดีของพาซิโอ้ผักที่ผูก Accountability Round ตามเงื่อนไขเดิม คืนเสียเป็น optional และยังใช้ calculator เดิม

1. ต้องได้รับ explicit approval ก่อนเปลี่ยน Production Cron หรือส่ง LINE จริง รอบนี้ไม่ได้อ่านข้อมูลธุรกิจจาก Production
2. หลังอนุมัติ operator ตรวจ metadata ของ job `daily-morning-brief-vegetable` และ timezone ของ Cron ว่าเป็น UTC/GMT โดยไม่อ่านข้อมูลธุรกิจ
3. ใช้ [reschedule-vegetable-1400.sql](./reschedule-vegetable-1400.sql) เพื่อแก้ **job เดิม** ด้วย `cron.alter_job` เป็น `0 7 * * *` สคริปต์ไม่สร้าง job ใหม่ ไม่เปลี่ยน active state, command, auth หรือผู้รับ และไม่เรียก endpoint/ส่ง LINE หากไม่พบ job เดิม พบหลาย job ชื่อเดียวกัน หรือพบ job ผักอื่นที่ active สคริปต์จะหยุดก่อนเปลี่ยนเวลา ให้ operator ตรวจและจัดการ duplicate ภายใต้การอนุมัติก่อนรันใหม่
4. ตรวจหลังเปลี่ยนว่ามี active Vegetable job เพียงตัวเดียวที่ `0 7 * * *` และไม่มี Vegetable job เก่าที่ `0 6 * * *` active ควบคู่กัน ถ้า job เดิม inactive ให้คง inactive จนได้รับอนุมัติเปิด แถวผลไม้ `daily-morning-brief` ต้องยังเป็น `0 1 * * *` (08:00 ไทย) และงาน 08:05/08:10 คงเดิม
5. ใช้ business date ก่อนหน้าจาก `resolveStockSummaryDate` เดิม ไม่ส่ง date/target/retry_nonce override ใน cron เวลา 13:00 และ 14:00 ของวันเดียวกันยัง resolve เป็นวันขายเดียวกัน และสร้าง LINE text/PDF retry keys เดียวกัน จึงไม่เปิด namespace ใหม่จากการเลื่อนเวลา
6. ถ้ารอบ 13:00 ของวันเปลี่ยนส่งสำเร็จไปแล้ว ไม่สั่ง manual resend/nonce เพื่อบังคับส่งซ้ำตอน 14:00 การกันซ้ำยังอยู่ใน LINE retry-key window 24 ชั่วโมงตามเดิม ไม่มี hourly retry ใหม่

## Rollback เฉพาะการเลื่อนเวลา

หลังได้รับอนุมัติเท่านั้น ให้แก้ schedule ของ **job เดิมตัวเดียว** กลับเป็น `0 6 * * *` และตรวจว่าไม่มีรอบ 14:00 active แยกอยู่ ไม่สร้าง job ใหม่ ไม่ต้องย้อน PDF/calculator/deployment หรือแก้ข้อมูลธุรกิจ เพราะรอบนี้ไม่ได้เปลี่ยน implementation ของรายงาน ไม่มี migration และไม่เปลี่ยนผู้รับหรือ retry identities

ข้อจำกัด: ระบบยังไม่มี allocation สต็อกบ้านให้ผัก และยังไม่มี hourly retry การป้องกันส่งซ้ำใช้ [LINE retry-key window 24 ชั่วโมง](https://developers.line.biz/en/docs/messaging-api/retrying-api-request/) ตามระบบเดิม ไม่รับประกันการรันย้อนหลังหลายวันว่าจะไม่ส่งซ้ำ ต้องเพิ่ม durable receipts ก่อนรองรับ automatic multi-day resend
