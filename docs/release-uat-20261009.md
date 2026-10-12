# Release UAT — Bot Summary — 9 ตุลาคม 2026

**คำตัดสิน: NO-GO สำหรับ Production release. Local Release UAT เสร็จแล้ว**

ตรวจ commit `cb21a1f914feed4c1cbb13907ed6d2eba66007b3`, branch
`fix/failed-return-sales-integrity-20261008` ใน worktree
`C:\GitHub\_worktrees\bot-summary-p0-return-integrity` เท่านั้น
โค้ดแอปที่นำมาทดสอบคือ commit นี้; งานรอบนี้เพิ่มหลักฐาน, UAT harness และ tests
ไม่เปลี่ยน implementation ของแอป, layout, Next config, dependency หรือ migration
หลังจบ UAT มีการเก็บรายงานและชุดทดสอบใน local commit แยก (ดู Git log สำหรับ SHA)
โดยไม่ Push, Merge หรือ Deploy

อ่าน `AGENTS.md`, `docs/p0-return-sales-integrity-20261008.md` และเอกสาร Next.js
ที่ติดตั้งจริงก่อนปรับวิธี build ใช้ผู้เชี่ยวชาญ read-only 3 คนตามที่อนุมัติ:
A ตรวจ build/font/env, B รัน consumer mocks, C ตรวจ migration และออกแบบ profiling
ผู้ประสานงานเป็นผู้เขียนไฟล์, เริ่ม/หยุด disposable PG และตรวจผลรวม

## ผลและขอบเขตหลักฐาน

| Gate | ผลที่เกิดขึ้นจริง | ข้อจำกัด |
|---|---|---|
| Full webpack build | ผ่าน 2 ครั้ง, exit 0 ทั้งสอง; compile, TypeScript, prerender 43/43, optimization และ build traces จบครบ | synthetic loopback env + font test hook; ห้าม deploy artifact นี้ |
| Core invariant/lifecycle/cutoff | 172 pass / 0 fail ใน 4 ไฟล์ | local fixtures |
| Binding/attribution เพิ่มเติม | 37 pass / 0 fail ใน 2 ไฟล์ | local fixtures |
| Consumer smoke จาก specialist B | 136 pass / 2 fail ใน 16 ไฟล์ | 2 failures ตรงหมวด baseline ที่เอกสารเดิมระบุ; ไม่ได้ rerun baseline SHA |
| Retention migration PG17 | 12 pass / 0 fail / 0 skip; exit 0 | PG17.10 cluster ใหม่บน loopback; prerequisite schema เป็น fixture |
| yod-song route ใหม่ | 5 pass / 0 fail; exit 0 | ใช้ real preflight กับ fake PostgREST |
| Server White Sheet finalize ใหม่ | 1 pass / 0 fail; exit 0 | real trust guard; page model และ persistence boundary เป็น mocks |
| Finalizer cutoff ใหม่ | 1 case เพิ่ม ผ่านทั้ง 04:00 และ 04:05; ไฟล์เต็ม 7 pass / 0 fail | fake finalize RPC และ injected reply callback |
| Financial PDF ข้อมูล 31 วัน | 2 pass / 0 fail; 310 กลุ่มทั้ง pending/resolved, real local PDF renderer | fake PostgREST, ไม่มี settlements ใน fixture; ไม่ใช่ deployed E2E |
| Typegen / typecheck | exit 0 / exit 0 | ทำ typecheck ก่อน final build; final build ตรวจ TypeScript อีกครั้ง |
| ESLint ทุกไฟล์ UAT ที่เพิ่ม/แก้ | exit 0, 0 errors, 0 warnings | targeted lint ไม่ใช่ทั้ง repository |
| git diff --check | exit 0 | Git มีคำเตือน CRLF และ global ignore อ่านไม่ได้; ไม่มี whitespace errors |

รวม **test identities ไม่ซ้ำ 366 pass / 2 fail ใน 26 ไฟล์** ไม่รวม benchmark/self-check
และไม่นับ finalizer 6 tests เดิมซ้ำกับการรันไฟล์เต็ม 7 tests ภายหลัง
นี่เป็นชุด release-focused UAT ไม่ใช่ผล full repository suite
ตัวเลข baseline 31 failures จาก handoff ไม่ได้ทดสอบใหม่ครบทั้งหมดในรอบนี้

## Build ที่ตรวจครบจริง

Next.js 16.3.4, Bun 1.3.14 บน Windows เอกสาร local ที่อ่าน:

- `node_modules/next/dist/docs/01-app/01-getting-started/13-fonts.md`
- `node_modules/next/dist/docs/01-app/02-guides/building.md` (specialist A)
- `node_modules/next/dist/docs/01-app/02-guides/environment-variables.md`
- `node_modules/next/dist/docs/01-app/03-api-reference/06-cli/next.md`

คำสั่งเต็มทั้งสองรอบ: `bun run build -- --webpack` ไม่จำกัด routes และไม่ปิด typecheck

| Phase | รอบแรก | รอบสุดท้ายหลังเพิ่ม tests |
|---|---:|---:|
| Compile | 10.7 s, ผ่าน | 5.7 s, ผ่าน |
| TypeScript | 9.7 s, ผ่าน | 3.2 s, ผ่าน |
| Static prerender | 43/43, 7.9 s | 43/43, 7.8 s |
| Optimization / traces / route table | ครบ | ครบ |
| Process exit | 0 | 0 |
| Network guard rejected attempts | 0 | 0 |

พบเฉพาะ `.env.example` ไม่อ่าน/ใช้ live env files ตั้ง process-local synthetic values ให้
`NEXT_PUBLIC_SUPABASE_URL` ชี้ loopback port 55998 และ anon/service keys เป็นข้อความ
NONPRODUCTION ที่ไม่ใช่ credential ลบ inherited LINE token/secret, OpenAI key,
notification target vars และ cron secret ใน process ที่ build; ปิด Next telemetry

`scripts/release-uat-fonts.cjs` ใช้ `NEXT_FONT_GOOGLE_MOCKED_RESPONSES` ซึ่ง source ของ
Next ที่ติดตั้งระบุว่าเป็น test hook โมดูลคืน CSS ของ Sarabun weights 300–700 จาก
`@fontsource/sarabun` ที่มีอยู่แล้ว ตรวจ signature `wOF2` ของไฟล์จริง 20 ไฟล์ ไม่ใช้
URL เป็น font bytes ปลอม Windows ต้องใช้ rooted current-drive slash path ให้ Next
mock reader อ่านไฟล์ได้ วิธีนี้เป็น test-only และไม่ได้แก้ `next/font/google` ใน layout

ตั้ง `NEXT_FONT_GOOGLE_MOCKED_RESPONSES` เป็น absolute path ของ helper และ
`NODE_OPTIONS=--require=./scripts/release-uat-no-network.cjs`
guard ปฏิเสธ non-loopback fetch/TCP และสืบทอดไปยัง Node workers
self-check ใช้ `example.invalid` ยืนยันว่า fetch/TCP ถูกปฏิเสธก่อนออก network
ทุก build มี guard loaded และ rejected=0 ไม่มี real LINE transport ถูกเรียก

Log: `.tmp-release-uat-20261009/build.log`, `build.exit`, `build-final.log`,
`build-final.exit` ข้อความ PowerShell `NativeCommandError` ใน log เกิดจาก redirect
stderr ของ Bun ตามปกติ ตัดสินจาก `$LASTEXITCODE` และ phase output ไม่ใช่ข้อความนั้น

**Build success นี้ไม่ยืนยัน authenticated runtime, real Supabase/PostgREST, cron,
deployed E2E หรือ Production. `.next` มี synthetic public configuration ห้ามนำไป release**

## Disposable PG17 migration rehearsal

สร้าง cluster ใหม่ด้วย `initdb.exe` ใน `.tmp-release-uat-20261009/pg` ไม่ reuse หรือแก้
`.tmp-p0-pg` เดิมและไม่ต่อ remote database มี PostgreSQL 17.10 บน
`127.0.0.1:56127` เท่านั้น PID 17664 ที่เริ่มด้วย direct `postgres.exe`
การลอง `Start-Process` ครั้งแรกไม่สำเร็จเพราะ environment มี Path/PATH ซ้ำ จึงใช้ direct
process ใน exec session โดยไม่แก้ environment ของ host หรือ cluster อื่น

คำสั่งที่สำเร็จ:

```powershell
& 'C:/Program Files/PostgreSQL/17/bin/initdb.exe' -D .tmp-release-uat-20261009/pg -U postgres -A trust --encoding=UTF8 --locale=C
& 'C:/Program Files/PostgreSQL/17/bin/postgres.exe' -D .tmp-release-uat-20261009/pg -h 127.0.0.1 -p 56127
$env:PGHOST='127.0.0.1'
$env:PGPORT='56127'
$env:PGUSER='postgres'
$env:ALLOW_DISPOSABLE_POSTGRES_TESTS='1'
bun test src/lib/produce/migration-retired-generations.pg.test.ts
& 'C:/Program Files/PostgreSQL/17/bin/pg_ctl.exe' -D .tmp-release-uat-20261009/pg -m fast stop
```

ตั้ง password ของ test process เป็น synthetic ข้อความที่ไม่ใช่ credential; cluster ใช้
trust เฉพาะ loopback ระหว่าง rehearsal คำสั่งด้านบนเป็นหลักฐานที่รันแล้ว ไม่ควรรัน
initdb ซ้ำบน directory ที่มีอยู่; rehearsal ครั้งถัดไปต้องใช้ directory และ port ใหม่

Test สร้าง DB `retired_generation_<random>` และ prerequisite tables/functions ใน DB นี้
เท่านั้น แล้ว apply ตามลำดับ:

1. `20260815094931_produce_out_of_order_admission.sql`
2. `20260924090000_produce_generation_rotation_carry_forward.sql`
3. `20261008150000_pending_session_retired_generations.sql`

ยืนยัน failed_closed content/error/round identity, close-refused stamp ของ generation
นั้นและ open pending content ยังอยู่หลัง rotation; finalized, duplicate และ expired-empty
ไม่สร้าง blocker; same-generation update ไม่เขียน retired row; duplicate opener เป็น
idempotent (RPC คืน opened=true และ generation เดิม) โดยไม่มี ingest ซ้ำหรือ retirement;
missing expected generation บน active draft และ stale expected generation ถูกปฏิเสธ
ON CONFLICT เก็บ evidence ครั้งแรกโดยไม่ overwrite, wrong-generation refusal stamp
ไม่ถูกคัดลอก, legacy NULL old generation ไม่ทำ trigger ล้มเหลว และ old explicit date
7 ต.ค. ยังอยู่เมื่อ header ใหม่เกิดตรง 04:00 วันที่ 8 ต.ค.

ตรวจ anon/authenticated ไม่มี SELECT, service_role มี SELECT แต่ไม่มี UPDATE/INSERT/DELETE,
RLS เปิดและ anon เรียก trigger function ไม่ได้ ตรวจผ่าน catalog privilege functions
ใน disposable cluster; ยังไม่ได้พิสูจน์จริงผ่าน deployed PostgREST/service-role configuration

ผล `12 pass / 0 fail / 40 expect() / 3.76 s`, exit 0, ไม่มี skip
`afterAll` drop DB และตรวจรายชื่อ DB แล้วไม่มี `retired_generation_%` เหลือ
`pg_ctl stop` exit 0 และ direct process จบ exit 0 พร้อม shutdown log
เก็บ cluster ที่หยุดแล้วและ evidence ไว้ ไม่ทำ recursive cleanup
Log: `initdb.log`, `pg-tests.log` ใน `.tmp-release-uat-20261009`

## No-send consumer และ financial smoke

ทุกคำสั่งต่อไปนี้เรียก handler/function ใน process ทดสอบ ไม่ใช่ HTTP ไปยัง production
ใช้ fake DB, formatter หรือ injected/mock LINE callback ไม่ override target group
Morning Brief debug มี `wouldSendLine=true` เพราะ fixture มี fake target แต่ assertion
`pushCalls=[]` ผ่าน; flag นี้เป็น hypothetical readiness ไม่ใช่หลักฐานว่าได้ส่งข้อความ
Daily-stock debug มี `targetOverride=false`, `wouldSendLine=false` และ push mock จะ throw
หากถูกเรียก Tests ใหม่ติดตั้ง fetch guard และตรวจ network attempts=0
PDF อนุญาตเฉพาะ Yoga WASM `data:` URL ที่เป็น embedded bytes ไม่เปิด socket

คำสั่งและผลจาก specialist B (แต่ละ command เป็น process แยก):

| Command (`bun test …`) | Pass / Fail | Exit |
|---|---:|---:|
| `src/lib/business-date.test.ts src/lib/summary/morning-brief.test.ts src/lib/summary/morning-brief-message.test.ts src/lib/summary/report.test.ts src/lib/line/daily-summary-message.test.ts src/lib/line/settlement-message.test.ts src/lib/settlement/produce-value-status.test.ts` | 80 / 2 | 1 |
| `src/lib/line/white-sheet-close-service.test.ts -t 'P0:'` | 2 / 0 | 0 |
| `src/lib/line/webhook-plain-text-entry-gate.test.ts -t 'P0:'` | 3 / 0 | 0 |
| `src/app/api/cron/daily-stock-summary/return-integrity.test.ts` | 4 / 0 | 0 |
| `src/app/api/pdf/financial-summary/route.test.ts` | 1 / 0 | 0 |
| `src/app/api/pdf/report-summary/route.test.ts` | 8 / 0 | 0 |
| `src/app/api/cron/daily-morning-brief/route.test.ts -t 'debug returns exact messages without sending LINE'` | 1 / 0 | 0 |
| `src/app/api/settlement/route.test.ts` | 5 / 0 | 0 |
| `src/lib/line/daily-summary-cron.test.ts` | 26 / 0 | 0 |
| `src/lib/line/pending-session-finalizer-additional.test.ts` (ก่อนเพิ่ม cutoff case) | 6 / 0 | 0 |

คำสั่งที่ผู้ประสานงานรันเพิ่ม:

```text
bun test src/lib/produce/failure-lifecycle-cutoff.test.ts src/lib/produce/failure-lifecycle.test.ts src/lib/sales/load.test.ts src/lib/sales/round-return-sold-out.test.ts
bun test src/lib/produce/plain-text-round-binding.test.ts src/lib/produce/round-return-status.unbound-p0.test.ts
bun test src/app/api/settlement/yod-song/route.test.ts
bun test src/lib/white-sheet/server-finalize.test.ts
bun test src/lib/line/pending-session-finalizer-additional.test.ts
bun test src/app/api/pdf/financial-summary/monthly-uat.test.ts
```

ยืนยัน unresolved unbound return ห้ามสรุป sold-out/confirmed money; corrected retry
ปล่อย blocker ได้เมื่อครอบคลุม candidate rounds ทั้งหมด และ later-day ordinary return
ไม่ล้าง earlier-day failure ใกล้ cutoff การ read evidence ไม่สำเร็จต้อง blocked
business date เปลี่ยนตรง 04:00 Bangkok; scheduled daily-summary มี contract ใช้วันก่อนหน้า
แม้รันล่าช้าถึง 04:30 ทั้งสองพฤติกรรมมี tests ผ่าน

White Sheet read แสดง warnings ได้; close เก็บ fake cash inputs แต่ไม่บอกตรง/ขาด/เกิน
เมื่อ blocked; server finalize เรียก real trust guard และไม่ถึง persistence เมื่อ hard-stop
กรณี trusted ไปถึง fake finalize เพียงครั้งเดียว
yod-song มี withdrawal 5,000 แต่ส่งยอดส่ง=null/blocked เมื่อ unresolved หรือ evidence table
ใช้ไม่ได้; resolved/ready fixture ส่ง 4,000/complete; missing seller/market/date ไม่รับรองเงิน
Finalizer สำหรับ undated return ที่เริ่ม 03:55 แล้วทำงาน 04:00/04:05 ส่ง validation refusal
ไปยัง callback จำลอง ไม่มี bind RPC หรือ actual network send

Financial PDF ใหม่ใช้ 4,650 transactions, 310 seller/date groups และ actual local renderer
PDF header/bytes ผ่าน pending groups ทั้งหมดเป็น return_incomplete และ resolved groups
ทั้งหมด trusted ตรวจ props ที่ route ส่งไป renderer; ไม่ได้ OCR/extract Thai PDF text หรือ
ตรวจภาพทุกหน้า Existing message/PDF-model tests ตรวจ provisional markers ประกอบ
resolved fixture ตัด unresolved retired evidence ออกจากชุดข้อมูล; lifecycle retry proof
อยู่ใน core tests ไม่ได้อ้างว่าการลบ evidence เป็นวิธีแก้ข้อมูลจริง

Failures ที่ยังคงอยู่:

1. `Morning Brief section financial purity > mixed market rows and house stock stay exclusively in their explicit sections`
   expected withdrawal sections `[300,700,1800]`, actual `[800,700,1300]`
2. `Morning Brief LINE layout — Production 2026-09-07 regression > the PDF keeps purchase status but omits internal review dumps`
   unknown purchase name ยังปรากฏใน fruit stock PDF model

เอกสาร handoff ระบุ Morning Brief service/PDF baseline failures และไฟล์ที่เกี่ยวข้องไม่เปลี่ยน
ระหว่าง fd274e6 กับ cb21a1f แต่รอบนี้ไม่ได้ reproduce สอง identities บน baseline SHA
จึงไม่อ้างว่าได้ยืนยัน before/after ใหม่ และไม่ถือว่าชุด consumer ทั้งหมด green
ไม่ได้แก้ classification/expectations เดิมเพื่อทำให้ suite ผ่านโดยไม่มี scope ตรวจเพิ่ม

## Monthly financial latency ที่วัดจริง

คำสั่ง `bun run scripts/release-uat-monthly.ts`, exit 0
เรียก real `markUncertifiedProduceNets` → resolver → preflight → lifecycle/round queries
fake เฉพาะ PostgREST table responses และ query delay มี self-assert จำนวน rows/groups,
สถานะ unresolved, query count คงเดิมทุกรอบ และ network attempts=0

Fixture: 31 วัน × 10 rounds × 3 document types × 5 products = 4,650 transactions;
930 finalized sessions + 930 raw source rows; 620 retired failed returns แชร์ 20 session keys
เพื่อจำลองการ rotate; attempted timestamps ช้ากว่า finalized returns จึงยัง unresolved
filters eq/in/is/not/range ทำงานจริง; OR inputs เป็น pending ว่างและ raw processed-only
จึงไม่จำเป็นต้อง parse PostgREST OR language ใน fake นี้

| Synthetic delay/query | Samples | min | p50 | p95 | max |
|---|---:|---:|---:|---:|---:|
| 0 ms (ไม่มี service delay) | 5 | 1.305 s | 1.579 s | 1.621 s | 1.621 s |
| 25 ms | 5 | 8.640 s | 8.714 s | 8.763 s | 8.763 s |
| 100 ms | 5 | 25.593 s | 25.727 s | 25.791 s | 25.791 s |
| 250 ms stress | 1 | 58.206 s | — | — | 58.206 s |

ใช้ nearest-rank percentile สำหรับ n=5; stress n=1 ไม่ใช่ tail-latency distribution
รวม logging/local CPU overhead ใน wall clock และมี targeted verification บางงานรันร่วม
ระหว่าง delayed samples จึงเป็น profiling fixture บนเครื่องพัฒนา ไม่ใช่ isolated lab SLA

**434 queries/เดือน**: produce_transactions 93, accountability_rounds 93,
pending_sessions 62, raw_messages 62, produce_sessions 31,
pending_session_retired_generations 31, pending_session_ingest 31,
pending_produce_deferred_events 31 ภายใน preflight มี query parallelism สูงสุด 5
แต่ทั้ง 31 dates ยังทำตามลำดับและอ่าน retained history ซ้ำทั้งหมดทุกวัน

Full mocked monthly financial PDF route + real renderer วัดเพิ่ม (อย่างละ 1 sample,
ไม่มี query delay): pending **4.626 s**, 440 queries, 77,128 bytes;
resolved **2.989 s**, 409 queries, 75,749 bytes ทั้งสอง 310 groups และ network attempts=0
resolved ไม่ต้องอ่าน pending ingest เพราะไม่มี retired failures ใน fixture

Stress preflight 58.206 s เหลือเพียง 1.794 s จากเป้าหมาย 60 s ก่อน initial report reads
และ PDF rendering จึงยังรับรอง timeout margin ไม่ได้ ไม่บวก timings จากคนละ run แล้ว
อ้างว่าได้วัด full delayed PDF >60 s และไม่อ้าง 60 s เป็น timeout ที่ยืนยันจาก deployment config
Actual DB latency, retained-history volume, cold starts, page/PDF load และ concurrency
ของ nonproduction deployment ยังไม่ได้วัด Production latency ไม่มีหลักฐานในรอบนี้

ไม่เปลี่ยน concurrency/cache ของ app จาก synthetic stress เพียงอย่างเดียว เพราะยังไม่พิสูจน์
typical deployed latency ให้ separately authorized nonproduction rehearsal วัดก่อน;
ถ้าไม่ผ่าน budget ให้ batch/read reuse หรือ bounded concurrency พร้อม duplicate-date,
error fail-closed และ maximum concurrency tests แล้ว rerun fixture เดิมเปรียบเทียบ
ห้าม filter retired history ตาม date แบบตรง ๆ จนตัด cross-cutoff/undated evidence หาย

## Local changes และ verification

เพิ่ม `scripts/release-uat-fonts.cjs`, `release-uat-no-network.cjs`, `release-uat-monthly.ts`;
เพิ่ม yod-song route test, financial PDF monthly test และ White Sheet server-finalize test;
ขยาย PG retention และ finalizer additional tests ไม่แก้ production application behavior

UAT harness ครั้งแรกมี TypeScript fetch-preconnect/narrow type errors และ CommonJS lint
errors แก้ใน helper/tests แล้ว final typecheck และ lint exit 0
fixture cutoff ครั้งแรกใช้ closer ที่ parser ไม่ยอมรับ แก้เป็น syntax ที่ถูกแล้ว 7/7 ผ่าน
PDF instrumentation ครั้งแรกเกิด mock recursion และ guard ปฏิเสธ embedded data WASM
แก้เป็น captured renderer function และอนุญาต data bytes เท่านั้น แล้ว 2/2 ผ่าน
ทั้งหมดเป็น harness setup failures ไม่ใช่ regression ที่พิสูจน์ใน app

```text
node node_modules/next/dist/bin/next typegen
bun run type-check
bun run lint scripts/release-uat-no-network.cjs scripts/release-uat-fonts.cjs scripts/release-uat-monthly.ts src/app/api/settlement/yod-song/route.test.ts src/app/api/pdf/financial-summary/monthly-uat.test.ts src/lib/white-sheet/server-finalize.test.ts src/lib/line/pending-session-finalizer-additional.test.ts src/lib/produce/migration-retired-generations.pg.test.ts
git diff --check
```

Evidence logs อยู่ใน ignored `.tmp-release-uat-20261009/` ไม่ได้ commit หรือ upload
เก็บผล specialist แบบ command/result ในรายงานนี้ ส่วน coordinator logs มีไฟล์จริง
บันทึกหลักฐานและไฟล์ทดสอบใน local commit แยกจาก SHA ของแอปที่ใช้ UAT
เพื่อให้ตรวจสอบซ้ำได้ โดยไม่เปลี่ยนพฤติกรรมของแอปหรือ Build artifact ที่ตรวจ

## Blockers และลำดับ release ที่ปลอดภัยสำหรับ operator ที่ได้รับอนุมัติแยก

NO-GO เพราะ (1) Production capability/migration gate ยังไม่มีหลักฐานผ่าน
handoff ระบุ table absent จาก read-only verification ก่อนหน้า ซึ่งรอบนี้ไม่ได้ตรวจซ้ำ;
(2) ยังไม่มี real safe nonproduction deployed E2E; (3) monthly latency มี stress ใกล้
60 s และยังไม่มี measured deployment margin; (4) consumer baseline failures สองรายการ
ยังไม่ได้ปิด; (5) historical incident/outgoing amounts ไม่ได้ reconcile ในรอบนี้

Release sequence ที่เสนอเท่านั้น ไม่มีขั้นใดถูกทำกับ Production:

1. Withhold financial certification/delivery ระหว่าง capability ยังไม่พร้อม เก็บ deployed
   artifact, incident evidence และ notification identities เดิม ทวนเงินที่เผยแพร่แล้วแยกต่างหาก
2. ตรวจ prerequisite schema/RPC และ generation/refusal identity columns ให้ตรงกับ
   migrations `20260815094931` และ `20260924090000`
3. Apply `20261008150000_pending_session_retired_generations.sql` แบบ transaction
   **ก่อน application code** ตรวจ trigger enabled, retained row หลัง rotation จริง,
   RLS/privileges และ table อ่านได้ผ่าน actual server role/PostgREST schema cache
   ตารางว่างเพียงอย่างเดียวไม่พิสูจน์ retention และไม่คืน evidence ที่หายไปก่อน migration
4. Rehearse ใน nonproduction: failed/refused/open rotation, proven retry ทุก candidate,
   04:00 attribution, unrelated seller/market/source isolation, missing evidence fail-closed,
   White Sheet read/close/finalize, yod-song, reports/PDF, stock และ planning
5. Build reviewed artifact ใหม่ด้วย real safe nonproduction configuration และ font strategy
   ที่ใช้จริง ทดสอบ authenticated runtime โดย LINE delivery ถูก stub/ปิด และวัด monthly
   page/PDF กับปริมาณ history ที่เป็นตัวแทน เทียบ actual configured timeout และ latency budget
6. ปิด/ยอมรับ baseline issues ด้วยเจ้าของ release และ reconcile historical incidents
   แล้วจึงขอ authorization แยกสำหรับ Production migration/release/delivery
   ห้าม reuse `.next` จาก UAT นี้ และห้ามล้าง settlement sent markers เพื่อบังคับส่งซ้ำ

Rollback: เก็บ additive retention table/rows/enabled trigger, withhold financial certification
และ delivery แล้ว fix forward การกลับไป fd274e6 หรือเก่ากว่าเปิดช่อง P0 เดิมอีก
ไม่ใช่ safe money rollback; อย่า drop trigger/table จนมี retention replacement ที่ตรวจแล้ว
ไม่มี migration rollback หรือ data repair ถูกทำใน UAT นี้

ความเสี่ยงคงเหลือจาก contract: erased generations ก่อน migration กู้ด้วย patch นี้ไม่ได้;
settlement notification เป็น one-shot เมื่อเคยส่ง provisional แล้วไม่มี confirmed follow-up
อัตโนมัติ; undated return เกิน 30 นาทีจาก 04:00 ยังใช้ event business date ต้องให้ผู้ใช้ระบุ
วันที่ชัดเจนสำหรับ late returns; identity ambiguity อาจคง provisional เพื่อไม่รับรองเงินผิด

**หยุดเมื่อ local UAT เสร็จ: ไม่มี push, merge, PR, deploy, Production/shared DB access
หรือ write, credentialed connector, production cron call, real LINE API/notification,
secret output หรือการแก้ไฟล์นอก worktree นี้**
