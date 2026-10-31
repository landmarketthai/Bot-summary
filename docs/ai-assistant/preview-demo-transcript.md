# @Botsummary AI Assistant — Preview demonstration transcript

Generated 2026-10-31T08:45:46.708Z by `scripts/ai-assistant-preview-demo.ts`. Business date 2026-10-31.

- Queue: real SQL queue on disposable PostgreSQL (ai_assistant_3ad0191d)
- LINE: simulated events in, recording adapter out (nothing sent to LINE)
- Model: scripted Thai stand-in (not GPT-6 Luna); data: invented fixtures behind the real authorization layer

## 1. Six-question conversation (approved group Cmanagement)

**หัวหน้า (supervisor, ทุกตลาด)** [Cmanagement]: @Botsummary วันนี้ทุกตลาดขายได้เท่าไหร่?
  ↳ webhook saved in 22 ms
  ↳ worker: claimed=1 completed=1 delivered=1
  ↳ **Bot (reply):** ยอดขายวันที่ 2026-10-31 / • รวมทุกตลาด: ยืนยันแล้ว 40,550.75 บาท · รอตรวจ 1,650.00 บาท / • พาซิโอ้ผัก: ยืนยันแล้ว 18,450.50 บาท · รอตรวจ 1,200.00 บาท / • วัดตะกล่ำ: ยืนยันแล้ว 9,320.00 บาท · รอตรวจ 0.00 บาท / • ราชพฤกษ์: ยืนยันแล้ว 12,780.25 บาท · รอตรวจ 450.00 บาท

**หัวหน้า (supervisor, ทุกตลาด)** [Cmanagement]: @Botsummary พี่ดำเบิกอะไรไป แล้วคืนเท่าไหร่?
  ↳ webhook saved in 7 ms
  ↳ worker: claimed=1 completed=1 delivered=1
  ↳ **Bot (reply):** ดำ วันที่ 2026-10-31: เบิก (ราชพฤกษ์) มะม่วงน้ำดอกไม้ 30 กก., ส้มโอ 20 ลูก | ชั่งคืน (ราชพฤกษ์) มะม่วงน้ำดอกไม้ 6.5 กก., ส้มโอ 4 ลูก | คืนเสีย (ราชพฤกษ์) มะม่วงน้ำดอกไม้ 1.2 กก. ครับ

**หัวหน้า (supervisor, ทุกตลาด)** [Cmanagement]: @Botsummary หนูเล็กมีสลิปที่ยังรอตรวจกี่รายการ?
  ↳ webhook saved in 1 ms
  ↳ worker: claimed=1 completed=1 delivered=1
  ↳ **Bot (reply):** เล็ก มีสลิปที่ต้องให้แอดมินตรวจมือ 2 รายการ และกำลังอ่านอยู่ 1 รายการครับ

**หัวหน้า (supervisor, ทุกตลาด)** [Cmanagement]: @Botsummary เมื่อวานตลาดไหนขายดีกว่าวันนี้?
  ↳ webhook saved in 1 ms
  ↳ worker: claimed=1 completed=1 delivered=1
  ↳ **Bot (reply):** เทียบยอดขาย (รวมทุกตลาด) / วันที่ 2026-10-31 / • รวม: ยืนยันแล้ว 40,550.75 บาท · รอตรวจ 1,650.00 บาท / • พาซิโอ้ผัก: ยืนยันแล้ว 18,450.50 บาท · รอตรวจ 1,200.00 บาท / • วัดตะกล่ำ: ยืนยันแล้ว 9,320.00 บาท · รอตรวจ 0.00 บาท / • ราชพฤกษ์: ยืนยันแล้ว 12,780.25 บาท · รอตรวจ 450.00 บาท /   ยอดยืนยันสูงสุด: พาซิโอ้ผัก 18,450.50 บาท / วันที่ 2026-10-30 / • รวม: ยืนยันแล้ว 37,240.75 บาท · รอตรวจ 0.00 บาท / • พาซิโอ้ผัก: ยืนยันแล้ว 15,210.00 บาท · รอตรวจ 0.00 บาท / • วัดตะกล่ำ: ยืนยันแล้ว 11,040.75 บาท · รอตรวจ 0.00 บาท / • ราชพฤกษ์: ยืนยันแล้ว 10,990.00 บาท · รอตรวจ 0.00 บาท /   ยอดยืนยันสูงสุด: พาซิโอ้ผัก 15,210.00 บาท

**หัวหน้า (supervisor, ทุกตลาด)** [Cmanagement]: @Botsummary ทำไมรายการของพี่ปลายังปิดไม่ได้?
  ↳ webhook saved in 2 ms
  ↳ worker: claimed=1 completed=1 delivered=1
  ↳ **Bot (reply):** ปลา ยังมีรายการค้าง 1 รายการ: คืน ที่ วัดตะกล่ำ (เปิดเอกสารแล้วแต่ยังปิด/บันทึกไม่สำเร็จ) ครับ

**หัวหน้า (supervisor, ทุกตลาด)** [Cmanagement]: @Botsummary แล้วของพี่ขวัญล่ะ?
  ↳ webhook saved in 1 ms
  ↳ worker: claimed=1 completed=1 delivered=1
  ↳ **Bot (reply):** ขวัญ ยังมีรายการค้าง 1 รายการ: เบิก ที่ พาซิโอ้ผัก (ระบบยังไม่ได้สร้างเอกสาร) ครับ

## 2. Duplicate LINE delivery

**หัวหน้า (supervisor, ทุกตลาด)** [Cmanagement]: @Botsummary วันนี้มีอะไรยังไม่จบ
  ↳ webhook saved in 1 ms
**หัวหน้า (supervisor, ทุกตลาด)** [Cmanagement]: @Botsummary วันนี้มีอะไรยังไม่จบ
  ↳ webhook saved in 1 ms (LINE redelivery of the same webhookEventId)
  ↳ worker: claimed=1 completed=1 delivered=1
  ↳ **Bot (reply):** วันนี้ ยังมีรายการค้าง 2 รายการ: คืน ที่ วัดตะกล่ำ (เปิดเอกสารแล้วแต่ยังปิด/บันทึกไม่สำเร็จ), เบิก ที่ พาซิโอ้ผัก (ระบบยังไม่ได้สร้างเอกสาร) ครับ

## 3. Model outage, retry with backoff

**หัวหน้า (supervisor, ทุกตลาด)** [Cmanagement]: @Botsummary เทียบยอดขายวันนี้กับเมื่อวาน
  ↳ webhook saved in 2 ms
  ↳ worker attempt 1: claimed=1 retried=1
  ↳ (backoff elapses)
  ↳ worker attempt 2: claimed=1 completed=1 delivered=1
  ↳ **Bot (reply):** เทียบยอดขาย (รวมทุกตลาด) / วันที่ 2026-10-31 / • รวม: ยืนยันแล้ว 40,550.75 บาท · รอตรวจ 1,650.00 บาท / • พาซิโอ้ผัก: ยืนยันแล้ว 18,450.50 บาท · รอตรวจ 1,200.00 บาท / • วัดตะกล่ำ: ยืนยันแล้ว 9,320.00 บาท · รอตรวจ 0.00 บาท / • ราชพฤกษ์: ยืนยันแล้ว 12,780.25 บาท · รอตรวจ 450.00 บาท /   ยอดยืนยันสูงสุด: พาซิโอ้ผัก 18,450.50 บาท / วันที่ 2026-10-30 / • รวม: ยืนยันแล้ว 37,240.75 บาท · รอตรวจ 0.00 บาท / • พาซิโอ้ผัก: ยืนยันแล้ว 15,210.00 บาท · รอตรวจ 0.00 บาท / • วัดตะกล่ำ: ยืนยันแล้ว 11,040.75 บาท · รอตรวจ 0.00 บาท / • ราชพฤกษ์: ยืนยันแล้ว 10,990.00 บาท · รอตรวจ 0.00 บาท /   ยอดยืนยันสูงสุด: พาซิโอ้ผัก 15,210.00 บาท

## 4. Reply token already expired (slow queue) → push with a stable retry key

**หัวหน้า (supervisor, ทุกตลาด)** [Cmanagement]: @Botsummary ใบขาววันนี้ปิดครบทุกตลาดหรือยัง
  ↳ webhook saved in 1 ms
  ↳ worker: claimed=1 completed=1 delivered=1
  ↳ **Bot (push to Cmanagement, retry key 0197b673…):** พาซิโอ้ผัก: ยังไม่ปิดใบขาว, วัดตะกล่ำ: ปิดใบขาวแล้ว, ราชพฤกษ์: ปิดใบขาวแล้ว ครับ

## 5. Approved group: every member shares the group scope (no per-user grant)

**ดำ (staff, ราชพฤกษ์)** [Cmanagement]: @Botsummary พี่ขวัญเบิกอะไรไป
  ↳ webhook saved in 2 ms
  ↳ worker: claimed=1 completed=1 delivered=1
  ↳ **Bot (reply):** ขวัญ วันที่ 2026-10-31: เบิก (พาซิโอ้ผัก) ผักกาดขาว 15 กก. | ชั่งคืน (พาซิโอ้ผัก) ผักกาดขาว 3 กก. ครับ
**Ustranger** [Cmanagement]: @Botsummary ใครเงินขาดบ้างวันนี้
  ↳ webhook saved in 1 ms
  ↳ worker: claimed=1 completed=1 delivered=1
  ↳ **Bot (reply):** ผลปิดเงิน ทุกตลาด วันที่ 2026-10-31 / • ราชพฤกษ์ (ดำ): เงินขาด 120.00 บาท (ต้องได้ 8,000.00 บาท · ส่งจริง 7,880.00 บาท) / • พาซิโอ้ผัก (ขวัญ): ยังสรุปเงินขาด/เกินไม่ได้ ข้อมูลที่ขาด: เงินสดที่ส่งจริง / • วัดตะกล่ำ (ปลา): เงินปิดตรง (ต้องได้ 5,000.00 บาท · ส่งจริง 5,000.00 บาท)

## 6. Permission boundaries in 1:1 chats (staff ดำ, no grant)

**ดำ (staff, ราชพฤกษ์)** [1:1 chat]: @Botsummary พี่ดำเบิกอะไรไป
  ↳ webhook saved in 2 ms
  ↳ worker: claimed=1 completed=1 delivered=1
  ↳ **Bot (reply):** ดำ วันที่ 2026-10-31: เบิก (ราชพฤกษ์) มะม่วงน้ำดอกไม้ 30 กก., ส้มโอ 20 ลูก | ชั่งคืน (ราชพฤกษ์) มะม่วงน้ำดอกไม้ 6.5 กก., ส้มโอ 4 ลูก | คืนเสีย (ราชพฤกษ์) มะม่วงน้ำดอกไม้ 1.2 กก. ครับ
**ดำ (staff, ราชพฤกษ์)** [1:1 chat]: @Botsummary พี่ขวัญเบิกอะไรไป
  ↳ webhook saved in 2 ms
  ↳ worker: claimed=1 completed=1 delivered=1
  ↳ **Bot (reply):** ขออภัยครับ คุณไม่มีสิทธิ์ดูข้อมูลส่วนนี้
**ดำ (staff, ราชพฤกษ์)** [1:1 chat]: @Botsummary ดำวันนี้เงินขาดหรือเกิน
  ↳ webhook saved in 2 ms
  ↳ worker: claimed=1 completed=1 delivered=1
  ↳ **Bot (reply):** ขออภัยครับ คุณไม่มีสิทธิ์ดูข้อมูลส่วนนี้
**Ustranger** [1:1 chat]: @Botsummary วันนี้ทุกตลาดขายได้เท่าไหร่?
  ↳ webhook saved in 2 ms
  ↳ worker: claimed=1 completed=1 delivered=1
  ↳ **Bot (reply):** ขออภัยครับ บัญชี LINE นี้ยังไม่ได้รับสิทธิ์ดูข้อมูลผ่าน @Botsummary กรุณาติดต่อหัวหน้างานหรือแอดมิน

## 7. Group disclosure: an allowlisted group without a group policy

**หัวหน้า (supervisor, ทุกตลาด)** [Cworkers]: @Botsummary วันนี้ทุกตลาดขายได้เท่าไหร่?
  ↳ webhook saved in 2 ms
  ↳ worker: claimed=1 completed=1 delivered=1
  ↳ **Bot (reply):** ขออภัยครับ คำถามนี้ตอบในกลุ่มนี้ไม่ได้ เพราะทุกคนในกลุ่มจะเห็นข้อมูล กรุณาถาม @Botsummary ในแชทส่วนตัวครับ
  ↳ (private delivery enabled: BOT_SUMMARY_ASSISTANT_PRIVATE_DELIVERY_ENABLED=true)
**หัวหน้า (supervisor, ทุกตลาด)** [Cworkers]: @Botsummary วันนี้ทุกตลาดขายได้เท่าไหร่?
  ↳ webhook saved in 2 ms
  ↳ worker: claimed=1 completed=1 delivered=1
  ↳ **Bot (push to Uboss, retry key f6f66ab8…):** ยอดขายวันที่ 2026-10-31 / • รวมทุกตลาด: ยืนยันแล้ว 40,550.75 บาท · รอตรวจ 1,650.00 บาท / • พาซิโอ้ผัก: ยืนยันแล้ว 18,450.50 บาท · รอตรวจ 1,200.00 บาท / • วัดตะกล่ำ: ยืนยันแล้ว 9,320.00 บาท · รอตรวจ 0.00 บาท / • ราชพฤกษ์: ยืนยันแล้ว 12,780.25 บาท · รอตรวจ 450.00 บาท

Total messages a LINE user would see: 17 (attempts incl. de-duplicated: 17).
