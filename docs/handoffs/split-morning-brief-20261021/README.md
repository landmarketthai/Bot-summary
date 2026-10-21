# แยก Morning Brief ผลไม้ 08:00 / ผัก 13:00

ฐานงาน: `80a38e9dc6e266a011b19dd693e0ae767a35b0d4` (latest main รวม PR #184)

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
| ผัก | 13:00 / 06:00 UTC — **ยังไม่เปิด schedule** | `/api/cron/daily-morning-brief?scope=vegetable` | `MORNING_BRIEF_VEGETABLE_LINE_TARGETS` |

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
| 11 | ข้อมูลเข้าหลัง 13:00 | PASS — คง business date เดิม; manual rerun จาก not_ready เป็น ready ได้ |
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

- Affected regression: **1,453 tests / 60 ไฟล์ ผ่านทั้งหมด** รันแต่ละไฟล์แยก process เพื่อกัน `mock.module` leakage ใน Bun ครอบคลุม summary, sales, physical inventory, white sheet, round returns, reconciliation, settlement, LINE reply และ cron ทั้ง 3 ตัว ดูผลราย suite ใน `regression.json`
- หลังเอาสถานะและรายละเอียดการตรวจข้อมูลออก รัน PDF/scope/sales integrity ซ้ำ **68 tests ผ่าน**, typecheck และ ESLint ผ่าน ตรวจ PNG synthetic ใหม่และเทียบ baseline ทั้ง 4 fixtures ได้ identical pixels ทุกหน้า
- Typecheck และ Next.js build ผ่าน Build ใช้ Supabase URL `http://127.0.0.1:9` กับ placeholder keys เพื่อไม่ให้ prerender อ่าน Production
- ESLint ของไฟล์ที่เปลี่ยนและ evidence scripts ผ่าน
- ไม่รัน PostgreSQL migration tests ใน local เพราะไม่มี schema change; ให้ required GitHub CI ตรวจต่อบน PostgreSQL จริง
- พบ 5 suites ล้มบน clean main ก่อนงานนี้ ดู `baseline-regression.json` แก้เฉพาะ tests ให้ตรง behavior PR #184: entered-price authority, durian เป็น fruit และ rejected produce fixture ต้องมี header ที่ scan รับได้ ไม่มีการแก้ financial implementation เพื่อทำให้ tests เขียว

ทำซ้ำ synthetic: `bun test --timeout 30000 src/lib/summary/morning-brief-scope.test.ts`, `bun docs/handoffs/split-morning-brief-20261021/render.tsx` และ Python `verify.py` (ต้องมี baseline checkout และ Poppler ตาม path ใน script)

## Production activation — ยังไม่ได้ดำเนินการ

1. ตรวจ PR/CI แล้วจึง merge และ deploy ตามขั้นตอนของเจ้าของระบบ งานนี้หยุดก่อน merge/deploy
2. ก่อน deploy ตรวจ external legacy consumers และรายชื่อผู้รับ PDF เดิมของ 08:05 ให้ครบใน Morning Brief ผู้รับข้อความสต็อกเดิมไม่ต้องเปลี่ยน ถ้าต้องการให้คนละกลุ่มได้ข้อความสต็อกกับ PDF ให้ตกลงรายชื่อ Morning Brief โดยชัดเจน
3. เรียก endpoint แบบ authenticated พร้อม `scope=fruit&debug=1` และ `scope=vegetable&date=YYYY-MM-DD&debug=1` เพื่อตรวจ scope/date/สถานะ โดยไม่ส่ง LINE และไม่ upload
4. คง Supabase Cron 08:00, 08:05, 08:10 ตามเดิม ไม่เพิ่ม GitHub schedule หรือ Vercel cron ซ้อน
5. หลังได้รับอนุมัติเปิดผักจริงเท่านั้น ตั้ง `MORNING_BRIEF_VEGETABLE_LINE_TARGETS` และสร้าง **หนึ่ง** Supabase Cron ที่ `0 6 * * *` ใช้วิธี auth เดียวกับงานเดิม เรียก `/api/cron/daily-morning-brief?scope=vegetable` โดยไม่ใส่ date/target/retry_nonce
6. เปิดที่ขอบวันรายงานใหม่เพื่อลดความเสี่ยงส่งซ้ำจากการเปลี่ยน PDF namespace ระหว่างวัน ตรวจ HTTP response, not_ready reasons, scoped paths และผู้รับหลังรันจริง ไม่มี hourly retry ใน phase นี้

## Rollback

หากยังไม่เปิด 13:00 ให้ย้อน deployment/commit เท่านั้น ถ้าเปิดแล้วให้ปิดเฉพาะ job ผักที่เพิ่มใหม่ก่อนย้อน deployment และคืน target config ที่เปลี่ยนไว้ ไม่แก้ sales, slips, white sheet, settlements หรือข้อมูลธุรกิจ ไม่ลบ legacy/scoped PDFs และไม่ต้อง rollback migration เพราะไม่มี migration ใหม่ อย่ารัน manual resend พร้อม retry_nonce ระหว่าง rollback โดยไม่ตั้งใจ

ข้อจำกัด: ระบบยังไม่มี allocation สต็อกบ้านให้ผัก และยังไม่มี hourly retry การป้องกันส่งซ้ำใช้ [LINE retry-key window 24 ชั่วโมง](https://developers.line.biz/en/docs/messaging-api/retrying-api-request/) ตามระบบเดิม ไม่รับประกันการรันย้อนหลังหลายวันว่าจะไม่ส่งซ้ำ ต้องเพิ่ม durable receipts ก่อนรองรับ automatic multi-day resend
