# @Botsummary evaluation report

Run at 2026-10-31T10:59:14.372Z · fixture data only (no Production data) · asked business date 2026-10-31.

## A. Deterministic backend rules

- Business date: 24/24 (100%)
- Follow-up detection: 24/24 (100%)
- Expected tool allowed for an approved group: 24/24 (100%)

## B. Answer-level evaluation — scripted keyword stand-in — HARNESS CHECK ONLY, not a GPT-6 Luna accuracy measurement

- Questions: 74 · run 74 · **passed 53** · failed 21 · not run 0
- Pass rate (run): 53/74 (71.6%)
- Tool choice (diagnostic, not graded): 39/62 (62.9%)
- Latency of the final answer: p50 0 ms · p95 2 ms · max 9 ms
- Tokens (all turns): 141 model calls · input 105012 (cached 0) · output 3083
- Estimated cost: unknown (prices not configured or usage incomplete)

| category | passed | failed | total |
|---|---|---|---|
| financial | 14 | 0 | 14 |
| produce | 3 | 5 | 8 |
| stock | 0 | 6 | 6 |
| slips | 4 | 2 | 6 |
| white_sheet | 5 | 0 | 5 |
| pending | 2 | 4 | 6 |
| business_date | 6 | 0 | 6 |
| memory | 5 | 0 | 5 |
| ambiguous | 2 | 3 | 5 |
| hallucination | 6 | 1 | 7 |
| access | 6 | 0 | 6 |

| error category | cases |
|---|---|
| missing_fact | 21 |
| forbidden_content | 1 |

| id | chat | result | errors | tools | ms | answer |
|---|---|---|---|---|---|---|
| fin-01 | approved_group | PASS |  | get_daily_summary | 9 | ยอดขายวันที่ 2026-10-31 / • รวมทุกตลาด: ยืนยันแล้ว 40,550.75 บาท · รอตรวจ 1,650.00 บาท / • พาซิโอ้ผัก: ยืนยันแล้ว 18,450.50 บาท · รอตรวจ 1,2 |
| fin-02 | approved_group | PASS |  | get_daily_summary | 1 | ยอดขายวันที่ 2026-10-31 / • รวมทุกตลาด: ยืนยันแล้ว 40,550.75 บาท · รอตรวจ 1,650.00 บาท / • พาซิโอ้ผัก: ยืนยันแล้ว 18,450.50 บาท · รอตรวจ 1,2 |
| fin-03 | approved_group | PASS |  | get_daily_summary | 0 | ยอดขายวันที่ 2026-10-31 / • รวมทุกตลาด: ยืนยันแล้ว 40,550.75 บาท · รอตรวจ 1,650.00 บาท / • พาซิโอ้ผัก: ยืนยันแล้ว 18,450.50 บาท · รอตรวจ 1,2 |
| fin-04 | approved_group | PASS |  | get_daily_summary | 1 | ยอดขายวันที่ 2026-10-31 / • รวมทุกตลาด: ยืนยันแล้ว 40,550.75 บาท · รอตรวจ 1,650.00 บาท / • พาซิโอ้ผัก: ยืนยันแล้ว 18,450.50 บาท · รอตรวจ 1,2 |
| fin-05 | approved_group | PASS |  | get_daily_summary | 1 | ยอดขายวันที่ 2026-10-30 / • รวมทุกตลาด: ยืนยันแล้ว 37,240.75 บาท · รอตรวจ 0.00 บาท / • พาซิโอ้ผัก: ยืนยันแล้ว 15,210.00 บาท · รอตรวจ 0.00 บา |
| fin-06 | approved_group | PASS |  | compare_daily_sales | 1 | เทียบยอดขาย (รวมทุกตลาด) / วันที่ 2026-10-31 / • รวม: ยืนยันแล้ว 40,550.75 บาท · รอตรวจ 1,650.00 บาท / • พาซิโอ้ผัก: ยืนยันแล้ว 18,450.50 บา |
| fin-07 | approved_group | PASS |  | compare_daily_sales | 3 | เทียบยอดขาย (รวมทุกตลาด) / วันที่ 2026-10-31 / • รวม: ยืนยันแล้ว 40,550.75 บาท · รอตรวจ 1,650.00 บาท / • พาซิโอ้ผัก: ยืนยันแล้ว 18,450.50 บา |
| fin-08 | approved_group | PASS |  | get_settlement_overview | 1 | ผลปิดเงิน ทุกตลาด วันที่ 2026-10-31 / • ราชพฤกษ์ (ดำ): เงินขาด 120.00 บาท (ต้องได้ 8,000.00 บาท · ส่งจริง 7,880.00 บาท) / • พาซิโอ้ผัก (ขวัญ |
| fin-09 | approved_group | PASS |  | get_settlement_overview | 0 | ผลปิดเงิน ทุกตลาด วันที่ 2026-10-31 / • ราชพฤกษ์ (ดำ): เงินขาด 120.00 บาท (ต้องได้ 8,000.00 บาท · ส่งจริง 7,880.00 บาท) / • พาซิโอ้ผัก (ขวัญ |
| fin-10 | approved_group | PASS |  | get_settlement_overview | 1 | ผลปิดเงิน ทุกตลาด วันที่ 2026-10-31 / • ราชพฤกษ์ (ดำ): เงินขาด 120.00 บาท (ต้องได้ 8,000.00 บาท · ส่งจริง 7,880.00 บาท) / • พาซิโอ้ผัก (ขวัญ |
| fin-11 | approved_group | PASS |  | get_settlement_overview | 0 | ผลปิดเงิน ทุกตลาด วันที่ 2026-10-31 / • ราชพฤกษ์ (ดำ): เงินขาด 120.00 บาท (ต้องได้ 8,000.00 บาท · ส่งจริง 7,880.00 บาท) / • พาซิโอ้ผัก (ขวัญ |
| fin-12 | approved_group | PASS |  | get_settlement_overview | 0 | ผลปิดเงิน ทุกตลาด วันที่ 2026-10-31 / • ราชพฤกษ์ (ดำ): เงินขาด 120.00 บาท (ต้องได้ 8,000.00 บาท · ส่งจริง 7,880.00 บาท) / • พาซิโอ้ผัก (ขวัญ |
| fin-13 | approved_group | PASS |  | get_daily_summary | 1 | ยอดขายวันที่ 2026-10-31 / • รวมทุกตลาด: ยืนยันแล้ว 40,550.75 บาท · รอตรวจ 1,650.00 บาท / • พาซิโอ้ผัก: ยืนยันแล้ว 18,450.50 บาท · รอตรวจ 1,2 |
| fin-14 | approved_group | PASS |  | get_daily_summary | 0 | ยอดขายวันที่ 2026-10-31 / • รวมทุกตลาด: ยืนยันแล้ว 40,550.75 บาท · รอตรวจ 1,650.00 บาท / • พาซิโอ้ผัก: ยืนยันแล้ว 18,450.50 บาท · รอตรวจ 1,2 |
| pro-01 | approved_group | PASS |  | get_staff_produce | 2 | ดำ วันที่ 2026-10-31: เบิก (ราชพฤกษ์) มะม่วงน้ำดอกไม้ 30 กก., ส้มโอ 20 ลูก \| ชั่งคืน (ราชพฤกษ์) มะม่วงน้ำดอกไม้ 6.5 กก., ส้มโอ 4 ลูก \| คืน |
| pro-02 | approved_group | FAIL | missing_fact: 15 | - | 0 | @Botsummary เป็นโหมดอ่านข้อมูลอย่างเดียว ช่วยแก้หรือบันทึกข้อมูลให้ไม่ได้ครับ |
| pro-03 | approved_group | FAIL | missing_fact: แตงโม; missing_fact: 12 | - | 0 | @Botsummary เป็นโหมดอ่านข้อมูลอย่างเดียว ช่วยแก้หรือบันทึกข้อมูลให้ไม่ได้ครับ |
| pro-04 | approved_group | FAIL | missing_fact: 1.2 | - | 1 | @Botsummary เป็นโหมดอ่านข้อมูลอย่างเดียว ช่วยแก้หรือบันทึกข้อมูลให้ไม่ได้ครับ |
| pro-05 | approved_group | FAIL | missing_fact: 3 | - | 0 | @Botsummary เป็นโหมดอ่านข้อมูลอย่างเดียว ช่วยแก้หรือบันทึกข้อมูลให้ไม่ได้ครับ |
| pro-06 | approved_group | PASS |  | get_staff_produce | 1 | ดำ วันที่ 2026-10-30: เบิก (ราชพฤกษ์) มะม่วงน้ำดอกไม้ 25 กก. ครับ |
| pro-07 | approved_group | FAIL | missing_fact: ผักกาดขาว; missing_fact: 12 | - | 0 | @Botsummary เป็นโหมดอ่านข้อมูลอย่างเดียว ช่วยแก้หรือบันทึกข้อมูลให้ไม่ได้ครับ |
| pro-08 | approved_group | PASS |  | get_staff_produce | 0 | ไม่พบรายการเบิก/คืนของ ส้ม ในวันที่ 2026-10-31 ครับ |
| sto-01 | approved_group | FAIL | missing_fact: 6.5; missing_fact: ผักกาดขาว | get_daily_summary | 1 | ยอดขายวันที่ 2026-10-31 / • รวมทุกตลาด: ยืนยันแล้ว 40,550.75 บาท · รอตรวจ 1,650.00 บาท / • พาซิโอ้ผัก: ยืนยันแล้ว 18,450.50 บาท · รอตรวจ 1,2 |
| sto-02 | approved_group | FAIL | missing_fact: มะม่วงน้ำดอกไม้; missing_fact: 6.5; missing_fact: ส้มโอ; missing_fact: 4 | - | 0 | @Botsummary เป็นโหมดอ่านข้อมูลอย่างเดียว ช่วยแก้หรือบันทึกข้อมูลให้ไม่ได้ครับ |
| sto-03 | approved_group | FAIL | missing_fact: 3 | - | 0 | @Botsummary เป็นโหมดอ่านข้อมูลอย่างเดียว ช่วยแก้หรือบันทึกข้อมูลให้ไม่ได้ครับ |
| sto-04 | approved_group | FAIL | missing_fact: one of: ยังไม่ครบ \| ไม่ครบ \| ยังไม่มี \| ยังไม่ได้ \| ยังไม่ \| ไม่มีข้อมูล \| ไม่พบ | - | 1 | @Botsummary เป็นโหมดอ่านข้อมูลอย่างเดียว ช่วยแก้หรือบันทึกข้อมูลให้ไม่ได้ครับ |
| sto-05 | approved_group | FAIL | missing_fact: 1.2 | - | 0 | @Botsummary เป็นโหมดอ่านข้อมูลอย่างเดียว ช่วยแก้หรือบันทึกข้อมูลให้ไม่ได้ครับ |
| sto-06 | approved_group | FAIL | missing_fact: one of: ไม่ใช่สต๊อกสะสม \| ไม่ใช่สต็อกสะสม \| เฉพาะ \| ไม่มีข้อมูล \| ไม่สามารถ \| ดูได้แค่ \| ของวัน | - | 0 | @Botsummary เป็นโหมดอ่านข้อมูลอย่างเดียว ช่วยแก้หรือบันทึกข้อมูลให้ไม่ได้ครับ |
| sli-01 | approved_group | PASS |  | get_slip_status | 0 | เล็ก มีสลิปที่ต้องให้แอดมินตรวจมือ 2 รายการ และกำลังอ่านอยู่ 1 รายการครับ |
| sli-02 | approved_group | PASS |  | get_slip_status | 0 | ทุกคน มีสลิปที่ต้องให้แอดมินตรวจมือ 3 รายการ และกำลังอ่านอยู่ 1 รายการครับ |
| sli-03 | approved_group | FAIL | missing_fact: 12 | get_slip_status | 0 | ทุกคน มีสลิปที่ต้องให้แอดมินตรวจมือ 3 รายการ และกำลังอ่านอยู่ 1 รายการครับ |
| sli-04 | approved_group | PASS |  | get_slip_status | 0 | ทุกคน มีสลิปที่ต้องให้แอดมินตรวจมือ 3 รายการ และกำลังอ่านอยู่ 1 รายการครับ |
| sli-05 | approved_group | PASS |  | get_slip_status | 0 | ขวัญ มีสลิปที่ต้องให้แอดมินตรวจมือ 0 รายการ และกำลังอ่านอยู่ 0 รายการครับ |
| sli-06 | approved_group | FAIL | missing_fact: one of: ยังไม่ใช่การยืนยัน \| ไม่ใช่การยืนยัน \| ยังไม่ได้ยืนยัน \| ยังไม่ยืนยัน \| ไม่มีข้อมูลการยืนยัน \| ไม่ได้ยืนยันจากธนา | get_slip_status | 1 | ทุกคน มีสลิปที่ต้องให้แอดมินตรวจมือ 3 รายการ และกำลังอ่านอยู่ 1 รายการครับ |
| wsh-01 | approved_group | PASS |  | get_white_sheet_status | 1 | พาซิโอ้ผัก: ยังไม่ปิดใบขาว, วัดตะกล่ำ: ปิดใบขาวแล้ว, ราชพฤกษ์: ปิดใบขาวแล้ว ครับ |
| wsh-02 | approved_group | PASS |  | get_white_sheet_status | 0 | พาซิโอ้ผัก: ยังไม่ปิดใบขาว, วัดตะกล่ำ: ปิดใบขาวแล้ว, ราชพฤกษ์: ปิดใบขาวแล้ว ครับ |
| wsh-03 | approved_group | PASS |  | get_white_sheet_status | 0 | พาซิโอ้ผัก: ยังไม่ปิดใบขาว, วัดตะกล่ำ: ปิดใบขาวแล้ว, ราชพฤกษ์: ปิดใบขาวแล้ว ครับ |
| wsh-04 | approved_group | PASS |  | get_white_sheet_status | 0 | พาซิโอ้ผัก: ยังไม่ปิดใบขาว, วัดตะกล่ำ: ปิดใบขาวแล้ว, ราชพฤกษ์: ปิดใบขาวแล้ว ครับ |
| wsh-05 | approved_group | PASS |  | get_white_sheet_status | 0 | พาซิโอ้ผัก: ปิดใบขาวแล้ว, วัดตะกล่ำ: ปิดใบขาวแล้ว, ราชพฤกษ์: ปิดใบขาวแล้ว ครับ |
| pen-01 | approved_group | PASS |  | get_pending_items | 0 | ปลา ยังมีรายการค้าง 1 รายการ: คืน ที่ วัดตะกล่ำ (เปิดเอกสารแล้วแต่ยังปิด/บันทึกไม่สำเร็จ) ครับ |
| pen-02 | approved_group | PASS |  | get_pending_items | 1 | ขวัญ ยังมีรายการค้าง 1 รายการ: เบิก ที่ พาซิโอ้ผัก (ระบบยังไม่ได้สร้างเอกสาร) ครับ |
| pen-03 | approved_group | FAIL | missing_fact: ปลา; missing_fact: ขวัญ | get_pending_items | 0 | วันนี้ ยังมีรายการค้าง 2 รายการ: คืน ที่ วัดตะกล่ำ (เปิดเอกสารแล้วแต่ยังปิด/บันทึกไม่สำเร็จ), เบิก ที่ พาซิโอ้ผัก (ระบบยังไม่ได้สร้างเอกสาร) |
| pen-04 | approved_group | FAIL | missing_fact: one of: ไม่พบ \| ไม่มีข้อมูล \| ไม่มีรายการ \| ไม่มี | get_pending_items | 0 | วันนี้ ยังมีรายการค้าง 2 รายการ: คืน ที่ วัดตะกล่ำ (เปิดเอกสารแล้วแต่ยังปิด/บันทึกไม่สำเร็จ), เบิก ที่ พาซิโอ้ผัก (ระบบยังไม่ได้สร้างเอกสาร) |
| pen-05 | approved_group | FAIL | missing_fact: one of: ไม่พบ \| ไม่มีข้อมูล \| ไม่มีรายการ \| ไม่มี | - | 0 | @Botsummary เป็นโหมดอ่านข้อมูลอย่างเดียว ช่วยแก้หรือบันทึกข้อมูลให้ไม่ได้ครับ |
| pen-06 | approved_group | FAIL | missing_fact: ขวัญ | get_pending_items | 0 | วันนี้ ยังมีรายการค้าง 2 รายการ: คืน ที่ วัดตะกล่ำ (เปิดเอกสารแล้วแต่ยังปิด/บันทึกไม่สำเร็จ), เบิก ที่ พาซิโอ้ผัก (ระบบยังไม่ได้สร้างเอกสาร) |
| dat-01 | approved_group | PASS |  | get_daily_summary | 0 | ยอดขายวันที่ 2026-10-29 / • รวมทุกตลาด: ยืนยันแล้ว 0.00 บาท · รอตรวจ 0.00 บาท |
| dat-02 | approved_group | PASS |  | get_daily_summary | 0 | ยอดขายวันที่ 2026-10-30 / • รวมทุกตลาด: ยืนยันแล้ว 37,240.75 บาท · รอตรวจ 0.00 บาท / • พาซิโอ้ผัก: ยืนยันแล้ว 15,210.00 บาท · รอตรวจ 0.00 บา |
| dat-03 | approved_group | PASS |  | get_daily_summary | 0 | ยอดขายวันที่ 2026-10-30 / • รวมทุกตลาด: ยืนยันแล้ว 37,240.75 บาท · รอตรวจ 0.00 บาท / • พาซิโอ้ผัก: ยืนยันแล้ว 15,210.00 บาท · รอตรวจ 0.00 บา |
| dat-04 | approved_group | PASS |  | get_daily_summary | 1 | ยอดขายวันที่ 2026-10-31 / • รวมทุกตลาด: ยืนยันแล้ว 40,550.75 บาท · รอตรวจ 1,650.00 บาท / • พาซิโอ้ผัก: ยืนยันแล้ว 18,450.50 บาท · รอตรวจ 1,2 |
| dat-05 | approved_group | PASS |  | get_daily_summary | 0 | ยอดขายวันที่ 2026-10-05 / • รวมทุกตลาด: ยืนยันแล้ว 0.00 บาท · รอตรวจ 0.00 บาท |
| dat-06 | approved_group | PASS |  | get_staff_produce | 2 | ขวัญ วันที่ 2026-10-30: เบิก (พาซิโอ้ผัก) ผักกาดขาว 12 กก. ครับ |
| mem-01 | approved_group | PASS |  | get_settlement_overview | 0 | ผลปิดเงิน ทุกตลาด วันที่ 2026-10-31 / • ราชพฤกษ์ (ดำ): เงินขาด 120.00 บาท (ต้องได้ 8,000.00 บาท · ส่งจริง 7,880.00 บาท) / • พาซิโอ้ผัก (ขวัญ |
| mem-02 | approved_group | PASS |  | get_daily_summary | 0 | ยอดขายวันที่ 2026-10-31 / • รวมทุกตลาด: ยืนยันแล้ว 40,550.75 บาท · รอตรวจ 1,650.00 บาท / • พาซิโอ้ผัก: ยืนยันแล้ว 18,450.50 บาท · รอตรวจ 1,2 |
| mem-03 | approved_group | PASS |  | get_white_sheet_status | 0 | พาซิโอ้ผัก: ปิดใบขาวแล้ว, วัดตะกล่ำ: ปิดใบขาวแล้ว, ราชพฤกษ์: ปิดใบขาวแล้ว ครับ |
| mem-04 | approved_group | PASS |  | get_staff_produce | 0 | ดำ วันที่ 2026-10-31: เบิก (ราชพฤกษ์) มะม่วงน้ำดอกไม้ 30 กก., ส้มโอ 20 ลูก \| ชั่งคืน (ราชพฤกษ์) มะม่วงน้ำดอกไม้ 6.5 กก., ส้มโอ 4 ลูก \| คืน |
| mem-05 | approved_group | PASS |  | get_slip_status | 1 | ดำ มีสลิปที่ต้องให้แอดมินตรวจมือ 1 รายการ และกำลังอ่านอยู่ 0 รายการครับ |
| amb-01 | approved_group | PASS |  | get_daily_summary | 0 | ยอดขายวันที่ 2026-10-31 / • รวมทุกตลาด: ยืนยันแล้ว 40,550.75 บาท · รอตรวจ 1,650.00 บาท / • พาซิโอ้ผัก: ยืนยันแล้ว 18,450.50 บาท · รอตรวจ 1,2 |
| amb-02 | approved_group | FAIL | missing_fact: one of: ใคร \| ชื่อ \| ระบุ | - | 0 | @Botsummary เป็นโหมดอ่านข้อมูลอย่างเดียว ช่วยแก้หรือบันทึกข้อมูลให้ไม่ได้ครับ |
| amb-03 | approved_group | FAIL | missing_fact: one of: ตลาดไหน \| ระบุ \| ชื่อตลาด | - | 0 | @Botsummary เป็นโหมดอ่านข้อมูลอย่างเดียว ช่วยแก้หรือบันทึกข้อมูลให้ไม่ได้ครับ |
| amb-04 | approved_group | PASS |  | get_daily_summary | 1 | ยอดขายวันที่ 2026-10-31 / • รวมทุกตลาด: ยืนยันแล้ว 40,550.75 บาท · รอตรวจ 1,650.00 บาท / • พาซิโอ้ผัก: ยืนยันแล้ว 18,450.50 บาท · รอตรวจ 1,2 |
| amb-05 | approved_group | FAIL | missing_fact: one of: ไม่พบ \| ไม่มีข้อมูล \| ไม่มีรายการ \| ไม่มี; forbidden_content: 40,550.75; forbidden_content: 18,450.50; forbidden_co | get_daily_summary | 0 | ยอดขายวันที่ 2026-10-31 / • รวมทุกตลาด: ยืนยันแล้ว 40,550.75 บาท · รอตรวจ 1,650.00 บาท / • พาซิโอ้ผัก: ยืนยันแล้ว 18,450.50 บาท · รอตรวจ 1,2 |
| hal-01 | approved_group | FAIL | missing_fact: one of: ไม่สามารถ \| คาดการณ์ \| ไม่มีข้อมูล \| ทำนาย \| ยังไม่มี \| ไม่ได้ | get_daily_summary | 1 | ยอดขายวันที่ 2026-10-31 / • รวมทุกตลาด: ยืนยันแล้ว 40,550.75 บาท · รอตรวจ 1,650.00 บาท / • พาซิโอ้ผัก: ยืนยันแล้ว 18,450.50 บาท · รอตรวจ 1,2 |
| hal-02 | approved_group | PASS |  | get_daily_summary | 0 | ยอดขายวันที่ 2026-10-31 / • รวมทุกตลาด: ยืนยันแล้ว 40,550.75 บาท · รอตรวจ 1,650.00 บาท / • พาซิโอ้ผัก: ยืนยันแล้ว 18,450.50 บาท · รอตรวจ 1,2 |
| hal-03 | approved_group | PASS |  | - | 0 | @Botsummary เป็นโหมดอ่านข้อมูลอย่างเดียว ช่วยแก้หรือบันทึกข้อมูลให้ไม่ได้ครับ |
| hal-04 | approved_group | PASS |  | - | 0 | @Botsummary เป็นโหมดอ่านข้อมูลอย่างเดียว ช่วยแก้หรือบันทึกข้อมูลให้ไม่ได้ครับ |
| hal-05 | approved_group | PASS |  | get_settlement_overview | 0 | ผลปิดเงิน ทุกตลาด วันที่ 2026-10-31 / • ราชพฤกษ์ (ดำ): เงินขาด 120.00 บาท (ต้องได้ 8,000.00 บาท · ส่งจริง 7,880.00 บาท) / • พาซิโอ้ผัก (ขวัญ |
| hal-06 | approved_group | PASS |  | get_slip_status | 1 | ทุกคน มีสลิปที่ต้องให้แอดมินตรวจมือ 3 รายการ และกำลังอ่านอยู่ 1 รายการครับ |
| hal-07 | approved_group | PASS |  | get_daily_summary | 0 | ยอดขายวันที่ 2026-10-31 / • รวมทุกตลาด: ยืนยันแล้ว 40,550.75 บาท · รอตรวจ 1,650.00 บาท / • พาซิโอ้ผัก: ยืนยันแล้ว 18,450.50 บาท · รอตรวจ 1,2 |
| acc-01 | direct_chat | PASS |  | - | 0 | ขออภัยครับ ตอนนี้ @Botsummary ตอบเฉพาะในกลุ่ม LINE ที่ได้รับอนุมัติ กรุณาถามในกลุ่มครับ |
| acc-02 | approved_group | PASS |  | get_settlement_overview | 0 | ผลปิดเงิน ทุกตลาด วันที่ 2026-10-31 / • ราชพฤกษ์ (ดำ): เงินขาด 120.00 บาท (ต้องได้ 8,000.00 บาท · ส่งจริง 7,880.00 บาท) / • พาซิโอ้ผัก (ขวัญ |
| acc-03 | market_group | PASS |  | get_daily_summary | 1 | ยอดขายวันที่ 2026-10-31 / • รวมเฉพาะตลาดที่มีสิทธิ์: ยืนยันแล้ว 18,450.50 บาท · รอตรวจ 1,200.00 บาท / • พาซิโอ้ผัก: ยืนยันแล้ว 18,450.50 บาท |
| acc-04 | unapproved_group | PASS |  | - | 0 | ขออภัยครับ กลุ่มนี้ยังไม่ได้รับอนุมัติให้ใช้ @Botsummary กรุณาติดต่อหัวหน้างานหรือแอดมิน |
| acc-05 | direct_chat | PASS |  | - | 0 | ขออภัยครับ ตอนนี้ @Botsummary ตอบเฉพาะในกลุ่ม LINE ที่ได้รับอนุมัติ กรุณาถามในกลุ่มครับ |
| acc-06 | market_group | PASS |  | get_daily_summary | 0 | ยอดขายวันที่ 2026-10-31 / • รวมเฉพาะตลาดที่มีสิทธิ์: ยืนยันแล้ว 18,450.50 บาท · รอตรวจ 1,200.00 บาท / • พาซิโอ้ผัก: ยืนยันแล้ว 18,450.50 บาท |

> The stand-in is a keyword router (no stock routing, limited staff-name extraction). Its failures show the
> grader catches missing facts and wrong claims; its pass rate says nothing about GPT-6 Luna.

## C. Live GPT-6 Luna

**NOT RUN** — no explicit test key (BOT_SUMMARY_EVAL_OPENAI_API_KEY) or authorized budget in this environment. No live-model accuracy is claimed.
