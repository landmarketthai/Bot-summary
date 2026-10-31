/**
 * Thai evaluation questions for @Botsummary. Sources: the six MVP target
 * questions, the existing BOT_SUMMARY_USAGE_REPLY examples (line-command.ts)
 * and the permission/read-only cases of the PR #174 UAT transcript.
 *
 * `expectedTool` is what a correct model should call (null = no tool).
 * `staffDecision` is the server-side authorization outcome when the asker is
 * the staff member ดำ (markets: ราชพฤกษ์) instead of a supervisor.
 * Dates are relative to askedBusinessDate 2026-10-31.
 */
export interface ThaiEvalCase {
  id: string;
  source: "mvp" | "usage_examples" | "pr174_uat" | "added";
  question: string;
  /** Previous question in the same conversation, if this is a follow-up. */
  previous?: string;
  expectedBusinessDate: string;
  expectedFollowUp: boolean;
  expectedTool: string | null;
  expectedArgs?: Record<string, unknown>;
  staffDecision: "allowed" | "other_staff" | "tool_not_permitted" | "market_not_permitted" | "no_tool";
}

export const THAI_EVAL_ASKED_DATE = "2026-10-31";

export const THAI_EVAL_SET: readonly ThaiEvalCase[] = [
  { id: "mvp-1", source: "mvp", question: "วันนี้ทุกตลาดขายได้เท่าไหร่?", expectedBusinessDate: "2026-10-31", expectedFollowUp: false, expectedTool: "get_daily_summary", staffDecision: "allowed" },
  { id: "mvp-2", source: "mvp", question: "พี่ดำเบิกอะไรไป แล้วคืนเท่าไหร่?", expectedBusinessDate: "2026-10-31", expectedFollowUp: false, expectedTool: "get_staff_produce", expectedArgs: { staff: "ดำ" }, staffDecision: "allowed" },
  { id: "mvp-3", source: "mvp", question: "หนูเล็กมีสลิปที่ยังรอตรวจกี่รายการ?", expectedBusinessDate: "2026-10-31", expectedFollowUp: false, expectedTool: "get_slip_status", expectedArgs: { staff: "เล็ก" }, staffDecision: "other_staff" },
  { id: "mvp-4", source: "mvp", question: "เมื่อวานตลาดไหนขายดีกว่าวันนี้?", expectedBusinessDate: "2026-10-31", expectedFollowUp: false, expectedTool: "compare_daily_sales", staffDecision: "allowed" },
  { id: "mvp-5", source: "mvp", question: "ทำไมรายการของพี่ปลายังปิดไม่ได้?", expectedBusinessDate: "2026-10-31", expectedFollowUp: false, expectedTool: "get_pending_items", expectedArgs: { staff: "ปลา" }, staffDecision: "other_staff" },
  { id: "mvp-6", source: "mvp", question: "แล้วของพี่ขวัญล่ะ?", previous: "ทำไมรายการของพี่ปลายังปิดไม่ได้?", expectedBusinessDate: "2026-10-31", expectedFollowUp: true, expectedTool: "get_pending_items", expectedArgs: { staff: "ขวัญ" }, staffDecision: "other_staff" },
  { id: "use-1", source: "usage_examples", question: "วันนี้ยอดขายเท่าไหร่", expectedBusinessDate: "2026-10-31", expectedFollowUp: false, expectedTool: "get_daily_summary", staffDecision: "allowed" },
  { id: "use-2", source: "usage_examples", question: "พาซิโอ้ผักวันนี้เป็นยังไง", expectedBusinessDate: "2026-10-31", expectedFollowUp: false, expectedTool: "get_market_summary", expectedArgs: { market: "พาซิโอ้ผัก" }, staffDecision: "market_not_permitted" },
  { id: "use-3", source: "usage_examples", question: "พาซิโอ้ผักเหลือของเท่าไหร่", expectedBusinessDate: "2026-10-31", expectedFollowUp: false, expectedTool: "get_market_stock", expectedArgs: { market: "พาซิโอ้ผัก" }, staffDecision: "market_not_permitted" },
  { id: "use-4", source: "usage_examples", question: "วันนี้มีอะไรยังไม่จบ", expectedBusinessDate: "2026-10-31", expectedFollowUp: false, expectedTool: "get_pending_items", staffDecision: "allowed" },
  { id: "use-5", source: "usage_examples", question: "ดำวันนี้เงินขาดหรือเกิน", expectedBusinessDate: "2026-10-31", expectedFollowUp: false, expectedTool: "get_staff_settlement", expectedArgs: { staff: "ดำ" }, staffDecision: "tool_not_permitted" },
  { id: "use-6", source: "usage_examples", question: "วันนี้มีใครเงินขาดบ้าง", expectedBusinessDate: "2026-10-31", expectedFollowUp: false, expectedTool: "get_settlement_overview", staffDecision: "tool_not_permitted" },
  { id: "use-7", source: "usage_examples", question: "เทียบยอดขายวันนี้กับเมื่อวาน", expectedBusinessDate: "2026-10-31", expectedFollowUp: false, expectedTool: "compare_daily_sales", staffDecision: "allowed" },
  { id: "uat-10", source: "pr174_uat", question: "รายการของน้อยเข้าหรือยัง", expectedBusinessDate: "2026-10-31", expectedFollowUp: false, expectedTool: "get_pending_items", expectedArgs: { staff: "น้อย" }, staffDecision: "other_staff" },
  { id: "uat-16", source: "pr174_uat", question: "แล้วตอนนี้ล่ะ", previous: "วันนี้มีอะไรยังไม่จบ", expectedBusinessDate: "2026-10-31", expectedFollowUp: true, expectedTool: "get_pending_items", staffDecision: "allowed" },
  { id: "uat-17", source: "pr174_uat", question: "ช่วยแก้ข้อ 22 ให้หน่อย แล้วบันทึกให้เลย", expectedBusinessDate: "2026-10-31", expectedFollowUp: false, expectedTool: null, staffDecision: "no_tool" },
  { id: "uat-18", source: "pr174_uat", question: "ดำวันนี้เงินขาดหรือเกิน", expectedBusinessDate: "2026-10-31", expectedFollowUp: false, expectedTool: "get_staff_settlement", staffDecision: "tool_not_permitted" },
  { id: "add-1", source: "added", question: "เมื่อวานพี่ดำเบิกอะไรไป", expectedBusinessDate: "2026-10-30", expectedFollowUp: false, expectedTool: "get_staff_produce", expectedArgs: { staff: "ดำ" }, staffDecision: "allowed" },
  { id: "add-2", source: "added", question: "แล้วของพี่ขวัญล่ะ?", previous: "เมื่อวานพี่ดำเบิกอะไรไป", expectedBusinessDate: "2026-10-30", expectedFollowUp: true, expectedTool: "get_staff_produce", expectedArgs: { staff: "ขวัญ" }, staffDecision: "other_staff" },
  { id: "add-3", source: "added", question: "เมื่อวานซืนขายได้เท่าไหร่", expectedBusinessDate: "2026-10-29", expectedFollowUp: false, expectedTool: "get_daily_summary", staffDecision: "allowed" },
  { id: "add-4", source: "added", question: "สรุปยอดวันที่ 5/10/69", expectedBusinessDate: "2026-10-05", expectedFollowUp: false, expectedTool: "get_daily_summary", staffDecision: "allowed" },
  { id: "add-5", source: "added", question: "ใบขาววันนี้ปิดครบทุกตลาดหรือยัง", expectedBusinessDate: "2026-10-31", expectedFollowUp: false, expectedTool: "get_white_sheet_status", staffDecision: "allowed" },
  { id: "add-6", source: "added", question: "ของผมเบิกอะไรไปบ้าง", expectedBusinessDate: "2026-10-31", expectedFollowUp: false, expectedTool: "get_staff_produce", expectedArgs: { staff: "ผม" }, staffDecision: "allowed" },
  { id: "add-7", source: "added", question: "พี่ดำมีสลิปอ่านไม่ผ่านไหม", expectedBusinessDate: "2026-10-31", expectedFollowUp: false, expectedTool: "get_slip_status", expectedArgs: { staff: "ดำ" }, staffDecision: "allowed" },
];
