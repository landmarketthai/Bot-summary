# Bot Summary AI Consultant — simulated LINE UAT transcript

**This is a SIMULATION, not a live test.** Every conversation below was produced by running the real code
(`answerBotSummaryForLine`: authorization, database reads, evidence, guard, fallback) against an in-memory fake
database, with the AI model replaced by a **scripted model**: a fixed list of OpenAI Responses API payloads
(a `function_call`, then a text message). The model's wording and tool choices below are therefore *scripted*,
not produced by GPT-6 Luna. What is real is everything the backend decides: which rows the asker may see, the
evidence it returns (state, saved or not, allowed next steps), the Thai text it generates, and what the guard does
when the scripted model lies. A live run against GPT-6 Luna is still required before rollout.

How to regenerate: `UAT_TRANSCRIPT_OUT=<file>.json bun test src/lib/ai/consultant/answer.test.ts`; the replies
below are copied from that JSON, not typed by hand. Test data: workers น้อย (U-noi) and แดง (U-daeng), supervisor
หัวหน้า, one worker group, "now" = 2026-10-08 10:00 Bangkok; the incident row mirrors the 2026-10-07 production
failure (น้อย / ราชพฤกษ์ / ชั่งคืน, 24 lines, 23 accepted, item 22 unreadable, failed_closed, terminalized,
reason close_refused_unresolved, no accountability round).

How to read each entry: **Asker** is the signed LINE identity. **Scripted model** lists the tool calls the script made
and the final text the script returned. **Evidence the model was shown** is the backend result (status, lifecycle
state, whether a saved row is proven). **LINE reply** is the text the worker would actually receive.

---

## 1. วิธีส่งรายการเบิก

- **Chat:** worker chat (consultant only)
- **Asker:** พนักงาน (น้อย)
- **Tools offered to the model:** get_usage_guide, get_submission_status, get_unfinished_submissions, get_submission_problem

**Message:**

> @Botsummary ส่งรายการเบิกต้องพิมพ์ยังไง

**Scripted model:**

- turn 1: calls `get_usage_guide({"topic":"produce_withdrawal"})`
- turn 2: returns the backend's suggested reply verbatim (scripted)

**Evidence the model was shown:** `status=ok knowledge=เบิกสินค้า`

**LINE reply:**

> พิมพ์หัวรายการก่อน แล้วส่งสินค้าทีละข้อครับ
> หัวรายการ: ชื่อคนขาย-ตลาด เบิก วันที่ (ปี พ.ศ.)
> สินค้าแต่ละข้อ 2 บรรทัด: เลขข้อ ชื่อ ราคา บาท แล้วขึ้นบรรทัดใหม่ใส่จำนวนกับหน่วย
> ครบแล้วพิมพ์ “จบรายการเบิก”

---

## 2. วิธีส่งรายการชั่งคืน

- **Chat:** worker chat (consultant only)
- **Asker:** พนักงาน (แดง)
- **Tools offered to the model:** get_usage_guide, get_submission_status, get_unfinished_submissions, get_submission_problem

**Message:**

> @Botsummary ชั่งคืนต้องพิมพ์ยังไง

**Scripted model:**

- turn 1: calls `get_usage_guide({"topic":"produce_return"})`
- turn 2: returns the backend's suggested reply verbatim (scripted)

**Evidence the model was shown:** `status=ok knowledge=ชั่งคืน`

**LINE reply:**

> ชั่งคืนพิมพ์เหมือนเบิก แต่ใช้หัว “ชั่งคืน” ครับ
> หัวรายการ: ชื่อคนขาย-ตลาด ชั่งคืน วันที่ (ปี พ.ศ.)
> ใช้ชื่อสินค้า ราคา และหน่วยให้ตรงกับที่เบิกไว้
> ครบแล้วพิมพ์ “จบรายการชั่งคืน”

---

## 3. วิธีแก้ข้อที่ไม่ผ่าน

- **Chat:** worker chat (consultant only)
- **Asker:** พนักงาน (แดง)
- **Tools offered to the model:** get_usage_guide, get_submission_status, get_unfinished_submissions, get_submission_problem

**Message:**

> @Botsummary ถ้าอยากแก้ข้อที่ส่งไปแล้ว ต้องพิมพ์ยังไง

**Scripted model:**

- turn 1: calls `get_usage_guide({"topic":"item_correction"})`
- turn 2: returns the backend's suggested reply verbatim (scripted)

**Evidence the model was shown:** `status=ok knowledge=แก้ข้อที่ส่งผิดก่อนจบรายการ`

**LINE reply:**

> แก้ได้ตอนที่ยังไม่จบรายการครับ
> พิมพ์ “แก้ข้อ” ตามด้วยเลขข้อ เช่น “แก้ข้อ 2”
> แล้วส่งสินค้าข้อนั้นใหม่ให้ครบ ทั้งชื่อ ราคา จำนวน และหน่วย
> ข้ออื่นยังอยู่ครบ ไม่ต้องส่งใหม่
> แก้เสร็จแล้วพิมพ์คำสั่งจบรายการตามปกติ

---

## 4. ส่งสำเร็จและบันทึกแล้ว

- **Chat:** worker chat (consultant only)
- **Asker:** พนักงาน (น้อย)
- **Tools offered to the model:** get_usage_guide, get_submission_status, get_unfinished_submissions, get_submission_problem

**Message:**

> @Botsummary เมื่อกี้รายการผมเข้าหรือยัง

**Scripted model:**

- turn 1: calls `get_submission_status({"staff":"","transaction_kind":"any"})`
- turn 2: returns the backend's suggested reply verbatim (scripted)

**Evidence the model was shown:** `status=ok state=finalized persisted=true savedItemCount=24 allowedNextActions=[nothing_needed]`

**LINE reply:**

> รายการชั่งคืนของน้อย–ราชพฤกษ์ วันที่ 7 ต.ค. บันทึกเรียบร้อยแล้ว 24 รายการครับ ไม่ต้องทำอะไรเพิ่มครับ

---

## 5. ธง finalized แต่หาแถวบันทึกไม่เจอ

- **Chat:** worker chat (consultant only)
- **Asker:** พนักงาน (น้อย)
- **Tools offered to the model:** get_usage_guide, get_submission_status, get_unfinished_submissions, get_submission_problem

**Message:**

> @Botsummary รายการที่ส่งไปบันทึกแล้วใช่ไหม

**Scripted model:**

- turn 1: calls `get_submission_status({"staff":"","transaction_kind":"any"})`
- turn 2: scripted text, NOT passed to the user as-is:

> บันทึกแล้วครับ เรียบร้อยดี


**Evidence the model was shown:** `status=ok state=unknown persisted=false allowedNextActions=[contact_admin_recovery]`

**LINE reply:**

> ยังตรวจสอบสถานะของรายการได้ไม่ชัดเจนครับ ข้อมูลที่มีตอนนี้ยังยืนยันไม่ได้ว่าบันทึกสำเร็จหรือไม่ กรุณาแจ้งผู้ดูแลให้ตรวจสอบครับ

---

## 6. ส่งมาแต่อ่านบางข้อไม่ได้ (ยังเปิดอยู่)

- **Chat:** worker chat (consultant only)
- **Asker:** พนักงาน (แดง)
- **Tools offered to the model:** get_usage_guide, get_submission_status, get_unfinished_submissions, get_submission_problem

**Message:**

> @Botsummary รายการผมเข้าหรือยัง

**Scripted model:**

- turn 1: calls `get_submission_status({"staff":"","transaction_kind":"any"})`
- turn 2: returns the backend's suggested reply verbatim (scripted)

**Evidence the model was shown:** `status=ok state=needs_correction persisted=false acceptedButNotSaved=5 allowedNextActions=[correct_item_in_open_draft, remove_item_in_open_draft]`

**LINE reply:**

> รายการเบิกของแดง–วิหาร วันที่ 7 ต.ค. ยังเปิดอยู่และยังไม่ได้บันทึกครับ ระบบอ่านได้ 5 รายการ แต่ข้อ 4 ต้องแก้ กรุณาพิมพ์ “แก้ข้อ 4” แล้วส่งข้อนั้นที่ถูกต้องใหม่ หรือพิมพ์ “ลบข้อ 4” ถ้าไม่ใช้ข้อนี้ครับ

---

## 7. เหตุการณ์ 7 ต.ค.: ชั่งคืนของน้อยไม่เข้า (หัวหน้าถาม)

- **Chat:** worker chat (consultant only)
- **Asker:** ผู้ดูแล (หัวหน้า)
- **Tools offered to the model:** get_usage_guide, get_submission_status, get_unfinished_submissions, get_submission_problem

**Message:**

> @Botsummary ทำไมรายการชั่งคืนของน้อยยังไม่เข้า

**Scripted model:**

- turn 1: calls `get_submission_problem({"staff":"น้อย","item_number":0})`
- turn 2: returns the backend's suggested reply verbatim (scripted)

**Evidence the model was shown:** `status=ok state=failed_terminal persisted=false acceptedButNotSaved=23 allowedNextActions=[contact_admin_recovery]`

**LINE reply:**

> รายการชั่งคืนของน้อย–ราชพฤกษ์ วันที่ 7 ต.ค. ยังบันทึกไม่สำเร็จครับ ระบบอ่านได้ 23 รายการ แต่ข้อ 22 ต้องแก้ และรอบเดิมปิดไปแล้ว ตอนนี้ไม่ควรส่งคำสั่งแก้ต่อในรอบเดิม กรุณาให้ผู้ดูแลตรวจและดำเนินการกู้รายการตามขั้นตอนที่ระบบรองรับครับ

---

## 8. เหตุการณ์ 7 ต.ค.: น้อยถามเรื่องข้อ 22 ของตัวเอง

- **Chat:** worker chat (consultant only)
- **Asker:** พนักงาน (น้อย)
- **Tools offered to the model:** get_usage_guide, get_submission_status, get_unfinished_submissions, get_submission_problem

**Message:**

> @Botsummary ทำไมข้อ 22 ไม่ผ่าน

**Scripted model:**

- turn 1: calls `get_submission_problem({"staff":"","item_number":22})`
- turn 2: returns the backend's suggested reply verbatim (scripted)

**Evidence the model was shown:** `status=ok state=failed_terminal persisted=false acceptedButNotSaved=23 allowedNextActions=[contact_admin_recovery]`

**LINE reply:**

> รายการชั่งคืนของน้อย–ราชพฤกษ์ วันที่ 7 ต.ค. ยังบันทึกไม่สำเร็จครับ ระบบอ่านได้ 23 รายการ แต่ข้อ 22 ต้องแก้ และรอบเดิมปิดไปแล้ว ตอนนี้ไม่ควรส่งคำสั่งแก้ต่อในรอบเดิม กรุณาให้ผู้ดูแลตรวจและดำเนินการกู้รายการตามขั้นตอนที่ระบบรองรับครับ

---

## 9. โมเดลล่ม: เหตุการณ์ 7 ต.ค. (น้อยถามเอง)

- **Chat:** worker chat (consultant only)
- **Asker:** พนักงาน (น้อย)
- **Tools offered to the model:** get_usage_guide, get_submission_status, get_unfinished_submissions, get_submission_problem

**Message:**

> @Botsummary รายการชั่งคืนของผมยังไม่เข้า ทำไม

**Scripted model:**

- (no model response: the model call failed or was skipped)
- the AI request failed (HTTP error / timeout) — the reply below is the deterministic fallback

**Evidence the model was shown:** none (no tool result)

**LINE reply:**

> รายการชั่งคืนของน้อย–ราชพฤกษ์ วันที่ 7 ต.ค. ยังบันทึกไม่สำเร็จครับ ระบบอ่านได้ 23 รายการ แต่ข้อ 22 ต้องแก้ และรอบเดิมปิดไปแล้ว ตอนนี้ไม่ควรส่งคำสั่งแก้ต่อในรอบเดิม กรุณาให้ผู้ดูแลตรวจและดำเนินการกู้รายการตามขั้นตอนที่ระบบรองรับครับ

---

## 10. พนักงานถามรายการของคนอื่น

- **Chat:** worker chat (consultant only)
- **Asker:** พนักงาน (แดง)
- **Tools offered to the model:** get_usage_guide, get_submission_status, get_unfinished_submissions, get_submission_problem

**Message:**

> @Botsummary รายการของน้อยเข้าหรือยัง

**Scripted model:**

- turn 1: calls `get_submission_status({"staff":"น้อย","transaction_kind":"any"})`
- turn 2: returns the backend's suggested reply verbatim (scripted)

**Evidence the model was shown:** `status=forbidden`

**LINE reply:**

> ดูสถานะได้เฉพาะรายการที่คุณส่งเองครับ ถ้าต้องการดูรายการของคนอื่น กรุณาสอบถามผู้ดูแลครับ

---

## 11. เอกสารสองใบอัปเดตพร้อมกัน (ผู้ดูแลถามกว้างๆ)

- **Chat:** worker chat (consultant only)
- **Asker:** ผู้ดูแล (หัวหน้า)
- **Tools offered to the model:** get_usage_guide, get_submission_status, get_unfinished_submissions, get_submission_problem

**Message:**

> @Botsummary รายการล่าสุดเข้าหรือยัง

**Scripted model:**

- turn 1: calls `get_submission_status({"staff":"","transaction_kind":"any"})`
- turn 2: returns the backend's suggested reply verbatim (scripted)

**Evidence the model was shown:** `status=ambiguous`

**LINE reply:**

> มีมากกว่าหนึ่งรายการครับ หมายถึงรายการไหนครับ
> • เบิก แดง วิหาร 2026-10-07
> • ชั่งคืน น้อย ราชพฤกษ์ 2026-10-07

---

## 12. ฐานข้อมูลอ่านไม่ได้

- **Chat:** worker chat (consultant only)
- **Asker:** พนักงาน (น้อย)
- **Tools offered to the model:** get_usage_guide, get_submission_status, get_unfinished_submissions, get_submission_problem

**Message:**

> @Botsummary รายการผมเข้าหรือยัง

**Scripted model:**

- turn 1: calls `get_submission_status({"staff":"","transaction_kind":"any"})`
- turn 2: returns the backend's suggested reply verbatim (scripted)

**Evidence the model was shown:** `status=unavailable`

**LINE reply:**

> ตอนนี้ตรวจสถานะรายการจากระบบไม่ได้ชั่วคราวครับ ยังยืนยันไม่ได้ว่าบันทึกแล้วหรือยัง กรุณาลองถามใหม่อีกครั้งครับ

---

## 13. AI ล่มกลางทาง → ตอบจากกฎตายตัว

- **Chat:** worker chat (consultant only)
- **Asker:** พนักงาน (แดง)
- **Tools offered to the model:** get_usage_guide, get_submission_status, get_unfinished_submissions, get_submission_problem

**Message:**

> @Botsummary รายการผมเข้าหรือยัง

**Scripted model:**

- turn 1: calls `get_submission_status({"staff":"","transaction_kind":"any"})`
- the AI request failed (HTTP error / timeout) — the reply below is the deterministic fallback

**Evidence the model was shown:** `status=ok state=needs_correction persisted=false acceptedButNotSaved=5 allowedNextActions=[correct_item_in_open_draft, remove_item_in_open_draft]`

**LINE reply:**

> รายการเบิกของแดง–วิหาร วันที่ 7 ต.ค. ยังเปิดอยู่และยังไม่ได้บันทึกครับ ระบบอ่านได้ 5 รายการ แต่ข้อ 4 ต้องแก้ กรุณาพิมพ์ “แก้ข้อ 4” แล้วส่งข้อนั้นที่ถูกต้องใหม่ หรือพิมพ์ “ลบข้อ 4” ถ้าไม่ใช้ข้อนี้ครับ

---

## 14. AI ล่ม: คำถามวิธีใช้

- **Chat:** worker chat (consultant only)
- **Asker:** พนักงาน (แดง)
- **Tools offered to the model:** get_usage_guide, get_submission_status, get_unfinished_submissions, get_submission_problem

**Message:**

> @Botsummary ชั่งคืนต้องพิมพ์ยังไง

**Scripted model:**

- (no model response: the model call failed or was skipped)
- the AI request failed (HTTP error / timeout) — the reply below is the deterministic fallback

**Evidence the model was shown:** none (no tool result)

**LINE reply:**

> ชั่งคืนพิมพ์เหมือนเบิก แต่ใช้หัว “ชั่งคืน” ครับ
> หัวรายการ: ชื่อคนขาย-ตลาด ชั่งคืน วันที่ (ปี พ.ศ.)
> ใช้ชื่อสินค้า ราคา และหน่วยให้ตรงกับที่เบิกไว้
> ครบแล้วพิมพ์ “จบรายการชั่งคืน”

---

## 15. ถามครั้งแรก: ยังเปิดอยู่

- **Chat:** worker chat (consultant only)
- **Asker:** พนักงาน (แดง)
- **Tools offered to the model:** get_usage_guide, get_submission_status, get_unfinished_submissions, get_submission_problem

**Message:**

> @Botsummary รายการผมเข้าหรือยัง

**Scripted model:**

- turn 1: calls `get_submission_status({"staff":"","transaction_kind":"any"})`
- turn 2: returns the backend's suggested reply verbatim (scripted)

**Evidence the model was shown:** `status=ok state=needs_correction persisted=false acceptedButNotSaved=5 allowedNextActions=[correct_item_in_open_draft, remove_item_in_open_draft]`

**LINE reply:**

> รายการเบิกของแดง–วิหาร วันที่ 7 ต.ค. ยังเปิดอยู่และยังไม่ได้บันทึกครับ ระบบอ่านได้ 5 รายการ แต่ข้อ 4 ต้องแก้ กรุณาพิมพ์ “แก้ข้อ 4” แล้วส่งข้อนั้นที่ถูกต้องใหม่ หรือพิมพ์ “ลบข้อ 4” ถ้าไม่ใช้ข้อนี้ครับ

---

## 16. ถามต่อ: แล้วตอนนี้ล่ะ (สถานะเปลี่ยนไปแล้ว)

- **Chat:** worker chat (consultant only)
- **Asker:** พนักงาน (แดง)
- **Tools offered to the model:** get_usage_guide, get_submission_status, get_unfinished_submissions, get_submission_problem

**Message:**

> @Botsummary แล้วตอนนี้ล่ะ

**Scripted model:**

- turn 1: calls `get_submission_status({"staff":"","transaction_kind":"any"})`
- turn 2: returns the backend's suggested reply verbatim (scripted)

**Evidence the model was shown:** `status=ok state=finalized persisted=true savedItemCount=6 allowedNextActions=[nothing_needed]`

**LINE reply:**

> รายการเบิกของแดง–วิหาร วันที่ 7 ต.ค. บันทึกเรียบร้อยแล้ว 6 รายการครับ ไม่ต้องทำอะไรเพิ่มครับ

---

## 17. ขอให้บอทแก้ข้อ 22 และบันทึกให้

- **Chat:** worker chat (consultant only)
- **Asker:** พนักงาน (น้อย)
- **Tools offered to the model:** get_usage_guide, get_submission_status, get_unfinished_submissions, get_submission_problem

**Message:**

> @Botsummary ช่วยแก้ข้อ 22 ให้หน่อย แล้วบันทึกให้เลย

**Scripted model:**

- turn 1: calls `get_submission_problem({"staff":"","item_number":22})`
- turn 2: returns the backend's suggested reply verbatim (scripted)

**Evidence the model was shown:** `status=ok state=failed_terminal persisted=false acceptedButNotSaved=23 allowedNextActions=[contact_admin_recovery]`

**LINE reply:**

> รายการชั่งคืนของน้อย–ราชพฤกษ์ วันที่ 7 ต.ค. ยังบันทึกไม่สำเร็จครับ ระบบอ่านได้ 23 รายการ แต่ข้อ 22 ต้องแก้ และรอบเดิมปิดไปแล้ว ตอนนี้ไม่ควรส่งคำสั่งแก้ต่อในรอบเดิม กรุณาให้ผู้ดูแลตรวจและดำเนินการกู้รายการตามขั้นตอนที่ระบบรองรับครับ

---

## 18. โมเดลพยายามเรียกเครื่องมือปิดเงินในแชทพนักงาน

- **Chat:** worker chat (consultant only)
- **Asker:** พนักงาน (แดง)
- **Tools offered to the model:** get_usage_guide, get_submission_status, get_unfinished_submissions, get_submission_problem

**Message:**

> @Botsummary ดำวันนี้เงินขาดหรือเกิน

**Scripted model:**

- turn 1: calls `get_staff_settlement({"staff":"ดำ"})`
- turn 2: returns the backend's suggested reply verbatim (scripted)

**Evidence the model was shown:** `status=tool_refused error=tool get_staff_settlement is not available in this chat`

**LINE reply:**

> ผลจากเครื่องมือ: {"error":"tool get_staff_settlement is not available in this chat"}

---

## 19. ผู้ใช้เดียวกันถามจากอีกกลุ่ม

- **Chat:** worker chat (consultant only)
- **Asker:** พนักงาน (น้อย) ในกลุ่ม A
- **Tools offered to the model:** get_usage_guide, get_submission_status, get_unfinished_submissions, get_submission_problem

**Message:**

> @Botsummary รายการผมเข้าหรือยัง

**Scripted model:**

- turn 1: calls `get_submission_status({"staff":"","transaction_kind":"any"})`
- turn 2: returns the backend's suggested reply verbatim (scripted)

**Evidence the model was shown:** `status=none`

**LINE reply:**

> ไม่พบรายการผักที่ตรงกับคำถามในช่วง 3 วันนี้ครับ ถ้าเพิ่งส่ง กรุณาดูข้อความตอบกลับของบอทหรือถามใหม่อีกครั้งครับ

---

## What this transcript does NOT prove

- Real model behaviour: GPT-6 Luna's tool choice, argument extraction (e.g. whether it passes `staff: ""` for "ของผม") and wording were never exercised. Every model turn above is scripted.
- Live data: the database is an in-memory fake that applies the same filters the code requests; Postgres/RLS behaviour and production row shapes beyond the 2026-10-07 incident fixture are not covered here.
- Open gap found while writing the tests: "ข้อที่ไม่ผ่านต้องแก้ยังไง" (a how-to phrased like a status question) is answered with a status lookup even when the model correctly used the usage guide; see the `GAP` tests in `src/lib/ai/consultant/answer.test.ts`.
