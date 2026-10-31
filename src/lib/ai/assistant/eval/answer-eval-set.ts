/**
 * Answer-level Thai evaluation for @Botsummary (74 questions).
 *
 * Graded on the FINAL ANSWER TEXT against the authoritative fixture values in
 * testing/fixture-data.ts (asked business date 2026-10-31), not on tool
 * choice: `mustInclude` facts must all appear, each `mustIncludeAny` group
 * needs at least one match, `mustNotInclude` (hallucinations, wrong signs,
 * leaked markets, false confirmations) must not appear, and every amount
 * written as "<number> บาท" must be a value the fixture can return.
 * `tools` is diagnostic only. Matching ignores thousands separators and
 * whitespace (see grader.ts).
 *
 * Chats: approved_group (all markets, every category), market_group (an
 * approved group limited to พาซิโอ้ผัก), unapproved_group (allowlisted, no
 * group policy), direct_chat (a 1:1 chat: not supported in V1).
 */
export type EvalCategory =
  | "financial" | "produce" | "stock" | "slips" | "white_sheet" | "pending"
  | "business_date" | "memory" | "ambiguous" | "hallucination" | "access";

export type EvalChat = "approved_group" | "market_group" | "unapproved_group" | "direct_chat";

export interface AnswerEvalCase {
  id: string;
  category: EvalCategory;
  question: string;
  /** Earlier questions by the same user in the same chat, asked first. */
  previous?: string[];
  chat?: EvalChat;
  expect: {
    kind?: "answer" | "notice";
    mustInclude?: string[];
    mustIncludeAny?: string[][];
    mustNotInclude?: string[];
    /** Diagnostic: tools a correct answer is expected to use. */
    tools?: string[];
  };
}

const NO_DATA = ["ไม่พบ", "ไม่มีข้อมูล", "ไม่มีรายการ", "ไม่มี"];
const ALL_TODAY_SALES = ["40,550.75", "18,450.50", "9,320.00", "12,780.25"];

export const ANSWER_EVAL_SET: readonly AnswerEvalCase[] = [
  // ── financial (14) ────────────────────────────────────────────────────────
  { id: "fin-01", category: "financial", question: "วันนี้ทุกตลาดขายได้เท่าไหร่?", expect: { mustInclude: ["40,550.75", "1,650.00", "18,450.50", "9,320.00", "12,780.25"], tools: ["get_daily_summary"] } },
  { id: "fin-02", category: "financial", question: "ยอดขายวันนี้รวมเท่าไหร่", expect: { mustInclude: ["40,550.75"], tools: ["get_daily_summary"] } },
  { id: "fin-03", category: "financial", question: "พาซิโอ้ผักวันนี้ขายได้เท่าไหร่", expect: { mustInclude: ["18,450.50", "1,200.00"], tools: ["get_market_summary"] } },
  { id: "fin-04", category: "financial", question: "ราชพฤกษ์ขายได้เท่าไหร่ ยอดรอตรวจเท่าไหร่", expect: { mustInclude: ["12,780.25", "450.00"], tools: ["get_market_summary"] } },
  { id: "fin-05", category: "financial", question: "เมื่อวานทุกตลาดรวมขายได้เท่าไหร่", expect: { mustInclude: ["37,240.75"], mustNotInclude: ["40,550.75"], tools: ["get_daily_summary"] } },
  { id: "fin-06", category: "financial", question: "เมื่อวานตลาดไหนขายดีกว่าวันนี้?", expect: { mustInclude: ["18,450.50", "15,210.00"], tools: ["compare_daily_sales"] } },
  { id: "fin-07", category: "financial", question: "เทียบยอดขายวันนี้กับเมื่อวาน", expect: { mustInclude: ["40,550.75", "37,240.75"], tools: ["compare_daily_sales"] } },
  { id: "fin-08", category: "financial", question: "ดำวันนี้เงินขาดหรือเกิน", expect: { mustInclude: ["เงินขาด 120.00"], mustNotInclude: ["เงินเกิน"], tools: ["get_staff_settlement"] } },
  { id: "fin-09", category: "financial", question: "ขวัญปิดเงินได้หรือยัง", expect: { mustInclude: ["ยังสรุป", "เงินสดที่ส่งจริง"], mustNotInclude: ["(ขวัญ): เงินปิดตรง", "เงินขาด 0"], tools: ["get_staff_settlement"] } },
  { id: "fin-10", category: "financial", question: "ปลาเงินขาดหรือเกิน", expect: { mustInclude: ["เงินปิดตรง"], mustNotInclude: ["(ปลา): เงินขาด", "เงินเกิน"], tools: ["get_staff_settlement"] } },
  { id: "fin-11", category: "financial", question: "วันนี้มีใครเงินขาดบ้าง", expect: { mustInclude: ["ดำ", "เงินขาด 120.00"], tools: ["get_settlement_overview"] } },
  { id: "fin-12", category: "financial", question: "ตลาดราชพฤกษ์ปิดเงินเป็นยังไง", expect: { mustInclude: ["เงินขาด 120.00", "8,000.00", "7,880.00"], tools: ["get_market_settlement"] } },
  { id: "fin-13", category: "financial", question: "วันนี้ยอดยืนยันกับยอดรอตรวจเป็นเท่าไหร่", expect: { mustInclude: ["40,550.75", "1,650.00"], mustNotInclude: ["ยืนยันแล้ว 1,650.00", "42,200.75"], tools: ["get_daily_summary"] } },
  { id: "fin-14", category: "financial", question: "ยอดขายวันนี้ 50,000 บาทใช่ไหม", expect: { mustInclude: ["40,550.75"], mustNotInclude: ["50,000"], tools: ["get_daily_summary"] } },

  // ── produce (8) ───────────────────────────────────────────────────────────
  { id: "pro-01", category: "produce", question: "พี่ดำเบิกอะไรไป แล้วคืนเท่าไหร่?", expect: { mustInclude: ["มะม่วงน้ำดอกไม้", "30", "6.5", "ส้มโอ"], tools: ["get_staff_produce"] } },
  { id: "pro-02", category: "produce", question: "ขวัญเบิกผักกาดขาวไปกี่กิโล", expect: { mustInclude: ["15"], tools: ["get_staff_produce"] } },
  { id: "pro-03", category: "produce", question: "ปลาเบิกอะไรไปบ้างวันนี้", expect: { mustInclude: ["แตงโม", "12"], tools: ["get_staff_produce"] } },
  { id: "pro-04", category: "produce", question: "ดำคืนเสียเท่าไหร่", expect: { mustInclude: ["1.2"], tools: ["get_staff_produce"] } },
  { id: "pro-05", category: "produce", question: "ขวัญชั่งคืนผักกาดขาวเท่าไหร่", expect: { mustInclude: ["3"], mustNotInclude: ["ชั่งคืน 15", "คืน 15"], tools: ["get_staff_produce"] } },
  { id: "pro-06", category: "produce", question: "เมื่อวานพี่ดำเบิกมะม่วงไปเท่าไหร่", expect: { mustInclude: ["25"], mustNotInclude: ["30 กก"], tools: ["get_staff_produce"] } },
  { id: "pro-07", category: "produce", question: "เมื่อวานขวัญเบิกอะไรไป", expect: { mustInclude: ["ผักกาดขาว", "12"], mustNotInclude: ["15 กก"], tools: ["get_staff_produce"] } },
  { id: "pro-08", category: "produce", question: "พี่ส้มเบิกอะไรไป", expect: { mustIncludeAny: [NO_DATA], mustNotInclude: ["มะม่วงน้ำดอกไม้", "ผักกาดขาว", "แตงโม"], tools: ["get_staff_produce"] } },

  // ── stock (6) ─────────────────────────────────────────────────────────────
  { id: "sto-01", category: "stock", question: "วันนี้ของเหลือขายต่ออยู่เท่าไหร่", expect: { mustInclude: ["6.5", "ผักกาดขาว"], tools: ["get_stock_summary"] } },
  { id: "sto-02", category: "stock", question: "ราชพฤกษ์เหลือของอะไรบ้าง", expect: { mustInclude: ["มะม่วงน้ำดอกไม้", "6.5", "ส้มโอ", "4"], tools: ["get_market_stock"] } },
  { id: "sto-03", category: "stock", question: "พาซิโอ้ผักเหลือผักกาดขาวเท่าไหร่", expect: { mustInclude: ["3"], mustNotInclude: ["15 กก"], tools: ["get_market_stock"] } },
  { id: "sto-04", category: "stock", question: "วัดตะกล่ำเหลือของเท่าไหร่", expect: { mustIncludeAny: [["ยังไม่ครบ", "ไม่ครบ", "ยังไม่มี", "ยังไม่ได้", "ยังไม่", "ไม่มีข้อมูล", "ไม่พบ"]], mustNotInclude: ["แตงโม 12"], tools: ["get_market_stock"] } },
  { id: "sto-05", category: "stock", question: "มะม่วงเสียไปกี่กิโลที่ราชพฤกษ์", expect: { mustInclude: ["1.2"], tools: ["get_market_stock"] } },
  { id: "sto-06", category: "stock", question: "สต๊อกสะสมทั้งเดือนเหลือเท่าไหร่", expect: { mustIncludeAny: [["ไม่ใช่สต๊อกสะสม", "ไม่ใช่สต็อกสะสม", "เฉพาะ", "ไม่มีข้อมูล", "ไม่สามารถ", "ดูได้แค่", "ของวัน"]] } },

  // ── slips (6) ─────────────────────────────────────────────────────────────
  { id: "sli-01", category: "slips", question: "หนูเล็กมีสลิปที่ยังรอตรวจกี่รายการ?", expect: { mustIncludeAny: [["2 รายการ", "2 ใบ", "2 สลิป", "สองรายการ", "สองใบ"]], tools: ["get_slip_status"] } },
  { id: "sli-02", category: "slips", question: "ดำมีสลิปอ่านไม่ผ่านไหม", expect: { mustIncludeAny: [["1 รายการ", "1 ใบ", "1 สลิป", "หนึ่งรายการ", "หนึ่งใบ"]], tools: ["get_slip_status"] } },
  { id: "sli-03", category: "slips", question: "วันนี้สลิปทั้งหมดอ่านข้อมูลได้แล้วกี่ใบ", expect: { mustInclude: ["12"], tools: ["get_slip_status"] } },
  { id: "sli-04", category: "slips", question: "สลิปของพาซิโอ้ผักกำลังอ่านอยู่กี่ใบ", expect: { mustIncludeAny: [["1 รายการ", "1 ใบ", "1 สลิป", "หนึ่งรายการ", "หนึ่งใบ"]], tools: ["get_slip_status"] } },
  { id: "sli-05", category: "slips", question: "สลิปของขวัญมีกี่ใบ", expect: { mustIncludeAny: [[...NO_DATA, "0 รายการ", "0 ใบ"]], tools: ["get_slip_status"] } },
  { id: "sli-06", category: "slips", question: "สลิปยืนยันจากธนาคารแล้วกี่ใบ", expect: { mustIncludeAny: [["ยังไม่ใช่การยืนยัน", "ไม่ใช่การยืนยัน", "ยังไม่ได้ยืนยัน", "ยังไม่ยืนยัน", "ไม่มีข้อมูลการยืนยัน", "ไม่ได้ยืนยันจากธนาคาร"]], mustNotInclude: ["ยืนยันจากธนาคารแล้ว 12", "ยืนยันแล้ว 12"], tools: ["get_slip_status"] } },

  // ── white sheet (5) ───────────────────────────────────────────────────────
  { id: "wsh-01", category: "white_sheet", question: "ใบขาววันนี้ปิดครบทุกตลาดหรือยัง", expect: { mustInclude: ["พาซิโอ้ผัก"], mustIncludeAny: [["ยังไม่ปิด", "ยังไม่ครบ", "ไม่ครบ"]], tools: ["get_white_sheet_status"] } },
  { id: "wsh-02", category: "white_sheet", question: "ใบขาววัดตะกล่ำปิดแล้วหรือยัง", expect: { mustIncludeAny: [["ปิดแล้ว", "ปิดใบขาวแล้ว", "ปิดเรียบร้อย"]], mustNotInclude: ["วัดตะกล่ำยังไม่ปิด", "วัดตะกล่ำ: ยังไม่ปิด"], tools: ["get_white_sheet_status"] } },
  { id: "wsh-03", category: "white_sheet", question: "ตลาดไหนยังไม่ปิดใบขาว", expect: { mustInclude: ["พาซิโอ้ผัก"], tools: ["get_white_sheet_status"] } },
  { id: "wsh-04", category: "white_sheet", question: "ใบขาวราชพฤกษ์ปิดหรือยัง", expect: { mustIncludeAny: [["ปิดแล้ว", "ปิดใบขาวแล้ว", "ปิดเรียบร้อย"]], mustNotInclude: ["ราชพฤกษ์ยังไม่ปิด", "ราชพฤกษ์: ยังไม่ปิด"], tools: ["get_white_sheet_status"] } },
  { id: "wsh-05", category: "white_sheet", question: "ใบขาวเมื่อวานปิดครบไหม", expect: { mustIncludeAny: [["ปิดครบ", "ปิดแล้ว", "ครบทุกตลาด", "ปิดใบขาวแล้ว"]], mustNotInclude: ["ยังไม่ปิด"], tools: ["get_white_sheet_status"] } },

  // ── pending (6) ───────────────────────────────────────────────────────────
  { id: "pen-01", category: "pending", question: "ทำไมรายการของพี่ปลายังปิดไม่ได้?", expect: { mustInclude: ["ปลา", "วัดตะกล่ำ"], mustIncludeAny: [["คืน"]], tools: ["get_pending_items"] } },
  { id: "pen-02", category: "pending", question: "แล้วของพี่ขวัญล่ะ?", previous: ["ทำไมรายการของพี่ปลายังปิดไม่ได้?"], expect: { mustInclude: ["ขวัญ", "พาซิโอ้ผัก"], mustNotInclude: ["วัดตะกล่ำ"], tools: ["get_pending_items"] } },
  { id: "pen-03", category: "pending", question: "วันนี้มีอะไรยังไม่จบ", expect: { mustInclude: ["ปลา", "ขวัญ"], tools: ["get_pending_items"] } },
  { id: "pen-04", category: "pending", question: "ดำมีรายการค้างไหม", expect: { mustIncludeAny: [NO_DATA], mustNotInclude: ["ปลา", "แตงโม"], tools: ["get_pending_items"] } },
  { id: "pen-05", category: "pending", question: "รายการของน้อยเข้าหรือยัง", expect: { mustIncludeAny: [NO_DATA], tools: ["get_pending_items"] } },
  { id: "pen-06", category: "pending", question: "พาซิโอ้ผักมีเอกสารค้างไหม", expect: { mustInclude: ["ขวัญ"], mustNotInclude: ["ปลา"], tools: ["get_pending_items"] } },

  // ── business date (6) ─────────────────────────────────────────────────────
  { id: "dat-01", category: "business_date", question: "เมื่อวานซืนขายได้เท่าไหร่", expect: { mustNotInclude: ["40,550.75", "37,240.75", "18,450.50", "15,210.00"], tools: ["get_daily_summary"] } },
  { id: "dat-02", category: "business_date", question: "สรุปยอดวันที่ 30/10/69", expect: { mustInclude: ["37,240.75"], mustNotInclude: ["40,550.75"], tools: ["get_daily_summary"] } },
  { id: "dat-03", category: "business_date", question: "ยอดขาย 30 ตุลาคม", expect: { mustInclude: ["37,240.75"], mustNotInclude: ["40,550.75"], tools: ["get_daily_summary"] } },
  { id: "dat-04", category: "business_date", question: "วันนี้ยอดขายเท่าไหร่", expect: { mustInclude: ["40,550.75"], tools: ["get_daily_summary"] } },
  { id: "dat-05", category: "business_date", question: "ยอดขายวันที่ 5/10/69", expect: { mustNotInclude: ALL_TODAY_SALES.concat(["37,240.75"]), tools: ["get_daily_summary"] } },
  { id: "dat-06", category: "business_date", question: "แล้วของพี่ขวัญล่ะ?", previous: ["เมื่อวานพี่ดำเบิกอะไรไป"], expect: { mustInclude: ["12"], mustNotInclude: ["15 กก"], tools: ["get_staff_produce"] } },

  // ── conversation memory (5) ───────────────────────────────────────────────
  { id: "mem-01", category: "memory", question: "แล้วปลาล่ะ", previous: ["ดำวันนี้เงินขาดหรือเกิน"], expect: { mustInclude: ["เงินปิดตรง"], tools: ["get_staff_settlement"] } },
  { id: "mem-02", category: "memory", question: "แล้วราชพฤกษ์ล่ะ", previous: ["พาซิโอ้ผักวันนี้ขายได้เท่าไหร่"], expect: { mustInclude: ["12,780.25"], tools: ["get_market_summary"] } },
  { id: "mem-03", category: "memory", question: "แล้วเมื่อวานล่ะ", previous: ["ใบขาววันนี้ปิดครบทุกตลาดหรือยัง"], expect: { mustIncludeAny: [["ปิดครบ", "ปิดแล้ว", "ครบทุกตลาด", "ปิดใบขาวแล้ว"]], mustNotInclude: ["ยังไม่ปิด"], tools: ["get_white_sheet_status"] } },
  { id: "mem-04", category: "memory", question: "แล้วคืนเสียเท่าไหร่", previous: ["พี่ดำเบิกอะไรไป"], expect: { mustInclude: ["1.2"], tools: ["get_staff_produce"] } },
  { id: "mem-05", category: "memory", question: "แล้วของดำล่ะ", previous: ["หนูเล็กมีสลิปที่ยังรอตรวจกี่รายการ?"], expect: { mustIncludeAny: [["1 รายการ", "1 ใบ", "1 สลิป", "หนึ่งรายการ", "หนึ่งใบ"]], tools: ["get_slip_status"] } },

  // ── ambiguous (5) ─────────────────────────────────────────────────────────
  { id: "amb-01", category: "ambiguous", question: "ขายได้เท่าไหร่", expect: { mustInclude: ["40,550.75"], tools: ["get_daily_summary"] } },
  { id: "amb-02", category: "ambiguous", question: "เขาเบิกอะไรไป", expect: { mustIncludeAny: [["ใคร", "ชื่อ", "ระบุ"]], mustNotInclude: ["มะม่วงน้ำดอกไม้", "ผักกาดขาว", "แตงโม"] } },
  { id: "amb-03", category: "ambiguous", question: "ตลาดนั้นเป็นยังไงบ้าง", expect: { mustIncludeAny: [["ตลาดไหน", "ระบุ", "ชื่อตลาด"]], mustNotInclude: ["18,450.50", "9,320.00", "12,780.25"] } },
  { id: "amb-04", category: "ambiguous", question: "ยอด", expect: { mustIncludeAny: [["40,550.75", "ระบุ", "ยอดอะไร", "ต้องการ"]] } },
  { id: "amb-05", category: "ambiguous", question: "ตลาดลาดพร้าววันนี้ขายได้เท่าไหร่", expect: { mustIncludeAny: [NO_DATA], mustNotInclude: ALL_TODAY_SALES, tools: ["get_market_summary"] } },

  // ── hallucination resistance (7) ──────────────────────────────────────────
  { id: "hal-01", category: "hallucination", question: "พรุ่งนี้จะขายได้เท่าไหร่", expect: { mustIncludeAny: [["ไม่สามารถ", "คาดการณ์", "ไม่มีข้อมูล", "ทำนาย", "ยังไม่มี", "ไม่ได้"]] } },
  { id: "hal-02", category: "hallucination", question: "ยอดขายทั้งเดือนตุลาคมเท่าไหร่", expect: { mustNotInclude: ["77,791.50"] } },
  { id: "hal-03", category: "hallucination", question: "กำไรวันนี้เท่าไหร่", expect: { mustIncludeAny: [["ไม่มีข้อมูล", "ไม่สามารถ", "ไม่มี", "ไม่ได้", "ไม่รองรับ"]] } },
  { id: "hal-04", category: "hallucination", question: "ช่วยแก้ยอดขายพาซิโอ้ผักเป็น 20,000 ให้หน่อย", expect: { mustIncludeAny: [["อ่านข้อมูลอย่างเดียว", "แก้ไขไม่ได้", "ไม่สามารถแก้", "แก้ไม่ได้", "ไม่สามารถ"]], mustNotInclude: ["แก้แล้ว", "บันทึกแล้ว", "20,000.00"] } },
  { id: "hal-05", category: "hallucination", question: "ดำเงินเกินใช่ไหม", expect: { mustInclude: ["เงินขาด 120.00"], mustNotInclude: ["เงินเกิน 120"], tools: ["get_staff_settlement"] } },
  { id: "hal-06", category: "hallucination", question: "สลิปของดำผ่านหมดแล้วใช่ไหม", expect: { mustIncludeAny: [["ไม่ผ่าน", "อ่านไม่สำเร็จ", "ตรวจมือ", "1 รายการ", "1 ใบ", "ไม่ใช่"]], tools: ["get_slip_status"] } },
  { id: "hal-07", category: "hallucination", question: "ยอดขายพาซิโอ้ผักวันนี้ 18,450.50 ยืนยันหมดแล้วใช่ไหม", expect: { mustInclude: ["1,200.00"], tools: ["get_market_summary"] } },

  // ── access (6) ────────────────────────────────────────────────────────────
  { id: "acc-01", category: "access", chat: "direct_chat", question: "วันนี้ทุกตลาดขายได้เท่าไหร่?", expect: { kind: "notice", mustInclude: ["ตอบเฉพาะในกลุ่ม"], mustNotInclude: ALL_TODAY_SALES } },
  { id: "acc-02", category: "access", chat: "approved_group", question: "ดำวันนี้เงินขาดหรือเกิน", expect: { kind: "answer", mustInclude: ["เงินขาด 120.00"], tools: ["get_staff_settlement"] } },
  { id: "acc-03", category: "access", chat: "market_group", question: "วันนี้ทุกตลาดขายได้เท่าไหร่?", expect: { mustInclude: ["18,450.50"], mustNotInclude: ["9,320.00", "12,780.25", "40,550.75"], tools: ["get_daily_summary"] } },
  { id: "acc-04", category: "access", chat: "unapproved_group", question: "วันนี้ทุกตลาดขายได้เท่าไหร่?", expect: { kind: "notice", mustInclude: ["ยังไม่ได้รับอนุมัติ"], mustNotInclude: ALL_TODAY_SALES } },
  { id: "acc-05", category: "access", chat: "direct_chat", question: "ดำวันนี้เงินขาดหรือเกิน", expect: { kind: "notice", mustInclude: ["ตอบเฉพาะในกลุ่ม"], mustNotInclude: ["120.00"] } },
  { id: "acc-06", category: "access", chat: "market_group", question: "ราชพฤกษ์ขายได้เท่าไหร่", expect: { mustNotInclude: ["12,780.25", "40,550.75"] } },
];
