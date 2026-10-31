# @Botsummary AI Assistant — Preview demonstration transcript

Generated 2026-10-31T03:59:24.241Z by `scripts/ai-assistant-preview-demo.ts`. Business date 2026-10-31.

- Queue: real SQL queue on disposable PostgreSQL (ai_assistant_dd2f4104)
- LINE: simulated events in, recording adapter out (nothing sent to LINE)
- Model: scripted Thai stand-in (not GPT-6 Luna); data: invented fixtures behind the real authorization layer

## 1. Six-question conversation (supervisor)

**หัวหน้า (supervisor, ทุกตลาด):** @Botsummary วันนี้ทุกตลาดขายได้เท่าไหร่?
  ↳ webhook saved in 26 ms
  ↳ worker: claimed=1 completed=1 delivered=1
  ↳ **Bot (reply):** วันที่ 2026-10-31 ยอดขายยืนยันรวม 40,550.75 บาท (รอตรวจ 1,650.00 บาท) แยกตามตลาด: พาซิโอ้ผัก 18,450.50 บาท, วัดตะกล่ำ 9,320.00 บาท, ราชพฤกษ์ 12,780.25 บาท ครับ

**หัวหน้า (supervisor, ทุกตลาด):** @Botsummary พี่ดำเบิกอะไรไป แล้วคืนเท่าไหร่?
  ↳ webhook saved in 3 ms
  ↳ worker: claimed=1 completed=1 delivered=1
  ↳ **Bot (reply):** ดำ วันที่ 2026-10-31: เบิก (ราชพฤกษ์) มะม่วงน้ำดอกไม้ 30 กก., ส้มโอ 20 ลูก | ชั่งคืน (ราชพฤกษ์) มะม่วงน้ำดอกไม้ 6.5 กก., ส้มโอ 4 ลูก | คืนเสีย (ราชพฤกษ์) มะม่วงน้ำดอกไม้ 1.2 กก. ครับ

**หัวหน้า (supervisor, ทุกตลาด):** @Botsummary หนูเล็กมีสลิปที่ยังรอตรวจกี่รายการ?
  ↳ webhook saved in 2 ms
  ↳ worker: claimed=1 completed=1 delivered=1
  ↳ **Bot (reply):** เล็ก มีสลิปที่ต้องให้แอดมินตรวจมือ 2 รายการ และกำลังอ่านอยู่ 1 รายการครับ

**หัวหน้า (supervisor, ทุกตลาด):** @Botsummary เมื่อวานตลาดไหนขายดีกว่าวันนี้?
  ↳ webhook saved in 2 ms
  ↳ worker: claimed=1 completed=1 delivered=1
  ↳ **Bot (reply):** วันนี้ (2026-10-31) ตลาดที่ขายดีสุดคือ พาซิโอ้ผัก 18,450.50 บาท; เมื่อวาน (2026-10-30) คือ พาซิโอ้ผัก 15,210.00 บาท ครับ

**หัวหน้า (supervisor, ทุกตลาด):** @Botsummary ทำไมรายการของพี่ปลายังปิดไม่ได้?
  ↳ webhook saved in 2 ms
  ↳ worker: claimed=1 completed=1 delivered=1
  ↳ **Bot (reply):** ปลา ยังมีรายการค้าง 1 รายการ: คืน ที่ วัดตะกล่ำ (เปิดเอกสารแล้วแต่ยังปิด/บันทึกไม่สำเร็จ) ครับ

**หัวหน้า (supervisor, ทุกตลาด):** @Botsummary แล้วของพี่ขวัญล่ะ?
  ↳ webhook saved in 2 ms
  ↳ worker: claimed=1 completed=1 delivered=1
  ↳ **Bot (reply):** ขวัญ ยังมีรายการค้าง 1 รายการ: เบิก ที่ พาซิโอ้ผัก (ระบบยังไม่ได้สร้างเอกสาร) ครับ

## 2. Duplicate LINE delivery

**หัวหน้า (supervisor, ทุกตลาด):** @Botsummary วันนี้มีอะไรยังไม่จบ
  ↳ webhook saved in 1 ms
**หัวหน้า (supervisor, ทุกตลาด):** @Botsummary วันนี้มีอะไรยังไม่จบ
  ↳ webhook saved in 1 ms (LINE redelivery of the same webhookEventId)
  ↳ worker: claimed=1 completed=1 delivered=1
  ↳ **Bot (reply):** วันนี้ ยังมีรายการค้าง 2 รายการ: คืน ที่ วัดตะกล่ำ (เปิดเอกสารแล้วแต่ยังปิด/บันทึกไม่สำเร็จ), เบิก ที่ พาซิโอ้ผัก (ระบบยังไม่ได้สร้างเอกสาร) ครับ

## 3. Model outage, retry with backoff

**หัวหน้า (supervisor, ทุกตลาด):** @Botsummary เทียบยอดขายวันนี้กับเมื่อวาน
  ↳ webhook saved in 1 ms
  ↳ worker attempt 1: claimed=1 retried=1
  ↳ (backoff elapses)
  ↳ worker attempt 2: claimed=1 completed=1 delivered=1
  ↳ **Bot (reply):** วันนี้ (2026-10-31) ตลาดที่ขายดีสุดคือ พาซิโอ้ผัก 18,450.50 บาท; เมื่อวาน (2026-10-30) คือ พาซิโอ้ผัก 15,210.00 บาท ครับ

## 4. Reply token already expired (slow queue) → push with a stable retry key

**หัวหน้า (supervisor, ทุกตลาด):** @Botsummary ใบขาววันนี้ปิดครบทุกตลาดหรือยัง
  ↳ webhook saved in 1 ms
  ↳ worker: claimed=1 completed=1 delivered=1
  ↳ **Bot (push, retry key 41d7687b…):** พาซิโอ้ผัก: ยังไม่ปิดใบขาว, วัดตะกล่ำ: ปิดใบขาวแล้ว, ราชพฤกษ์: ปิดใบขาวแล้ว ครับ

## 5. Permission boundaries (staff ดำ)

**ดำ (staff, ราชพฤกษ์):** @Botsummary พี่ดำเบิกอะไรไป
  ↳ webhook saved in 2 ms
  ↳ worker: claimed=1 completed=1 delivered=1
  ↳ **Bot (reply):** ดำ วันที่ 2026-10-31: เบิก (ราชพฤกษ์) มะม่วงน้ำดอกไม้ 30 กก., ส้มโอ 20 ลูก | ชั่งคืน (ราชพฤกษ์) มะม่วงน้ำดอกไม้ 6.5 กก., ส้มโอ 4 ลูก | คืนเสีย (ราชพฤกษ์) มะม่วงน้ำดอกไม้ 1.2 กก. ครับ
**ดำ (staff, ราชพฤกษ์):** @Botsummary พี่ขวัญเบิกอะไรไป
  ↳ webhook saved in 2 ms
  ↳ worker: claimed=1 completed=1 delivered=1
  ↳ **Bot (reply):** ขออภัยครับ คุณไม่มีสิทธิ์ดูข้อมูลส่วนนี้
**ดำ (staff, ราชพฤกษ์):** @Botsummary ดำวันนี้เงินขาดหรือเกิน
  ↳ webhook saved in 2 ms
  ↳ worker: claimed=1 completed=1 delivered=1
  ↳ **Bot (reply):** ขออภัยครับ คุณไม่มีสิทธิ์ดูข้อมูลส่วนนี้
**Ustranger:** @Botsummary วันนี้ทุกตลาดขายได้เท่าไหร่?
  ↳ webhook saved in 2 ms
  ↳ worker: claimed=1 completed=1 delivered=1
  ↳ **Bot (reply):** ขออภัยครับ บัญชี LINE นี้ยังไม่ได้รับสิทธิ์ดูข้อมูลผ่าน @Botsummary กรุณาติดต่อหัวหน้างานหรือแอดมิน

Total messages a LINE user would see: 13 (attempts incl. de-duplicated: 13).
