/**
 * Test/demo-only stand-in for GPT-6 Luna: a deterministic Thai keyword
 * router that picks a read-only tool, then phrases an answer ONLY from the
 * tool output it was given. It exists to exercise the real pipeline (queue,
 * worker, authorization, memory, grounding, delivery) without a model API.
 * Results produced with it say nothing about GPT-6 Luna answer quality.
 */
import type {
  AssistantModelProvider,
  ModelRoundRequest,
  ModelRoundResult,
  ModelTranscriptItem,
} from "@/lib/ai/model-provider";

type Intent = { tool: string; args: Record<string, unknown> };

const NAME = /(?:พี่|หนู|น้อง|คุณ|ของ)\s*([ก-๙]{1,12}?)(?=เบิก|มี|ยัง|ล่ะ|หละ|วันนี้|เมื่อวาน|เงิน|ปิด|ส่ง|คืน|\s|[?？]|$)/u;

function staffIn(question: string): string | null {
  const name = question.match(NAME)?.[1]?.replace(/^(?:พี่|หนู|น้อง|คุณ)/u, "");
  return name && !["ผม", "หนู", "ฉัน"].includes(name) ? name : null;
}

export function routeQuestion(question: string, previous: Intent | null): Intent | null {
  const q = question.normalize("NFC");
  const staff = staffIn(q);
  if (/^(?:แล้ว|ส่วน)/u.test(q) && previous) {
    if (staff && "staff" in previous.args) return { tool: previous.tool, args: { ...previous.args, staff } };
    return previous;
  }
  if (/แก้|ลบ|บันทึกให้/u.test(q)) return null;
  if (/สลิป/u.test(q)) return { tool: "get_slip_status", args: { staff, market: null } };
  if (/ใบขาว/u.test(q)) return { tool: "get_white_sheet_status", args: { market: null } };
  if (/เงินขาด|เงินเกิน|ปิดเงิน/u.test(q)) {
    return staff ? { tool: "get_staff_settlement", args: { staff } } : { tool: "get_settlement_overview", args: {} };
  }
  if (/ปิดไม่ได้|ค้าง|ยังไม่จบ|ไม่เข้า/u.test(q)) return { tool: "get_pending_items", args: { staff, market: null } };
  if (/เบิก|คืน/u.test(q) && staff) return { tool: "get_staff_produce", args: { staff } };
  if (/ขายดีกว่า|เทียบ/u.test(q)) return { tool: "compare_daily_sales", args: { days: 2 } };
  if (/ขาย|ยอด/u.test(q)) return { tool: "get_daily_summary", args: {} };
  return null;
}

const baht = (value: unknown) =>
  typeof value === "number" ? value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "-";

export function phraseAnswer(output: Record<string, unknown>): string {
  if (output.status === "forbidden") return "ขออภัยครับ คุณไม่มีสิทธิ์ดูข้อมูลส่วนนี้";
  if (typeof output.error === "string") return "ตอนนี้อ่านข้อมูลส่วนนี้ไม่สำเร็จครับ";
  switch (output.tool) {
    case "get_daily_summary": {
      const total = output.total as Record<string, unknown>;
      const markets = (output.markets as Array<Record<string, unknown>>)
        .map((market) => `${market.market} ${baht(market.confirmedSalesBaht)} บาท`).join(", ");
      return `วันที่ ${output.businessDate} ยอดขายยืนยันรวม ${baht(total.confirmedSalesBaht)} บาท (รอตรวจ ${baht(total.pendingReviewSalesBaht)} บาท) แยกตามตลาด: ${markets || "ไม่มีข้อมูล"} ครับ`;
    }
    case "compare_daily_sales": {
      const [today, yesterday] = output.dates as Array<{ businessDate: string; markets: Array<Record<string, unknown>> }>;
      const best = (day: typeof today | undefined) => [...(day?.markets ?? [])]
        .sort((a, b) => Number(b.confirmedSalesBaht) - Number(a.confirmedSalesBaht))[0];
      const t = best(today);
      const y = best(yesterday);
      return `วันนี้ (${today?.businessDate}) ตลาดที่ขายดีสุดคือ ${t?.market ?? "-"} ${baht(t?.confirmedSalesBaht)} บาท; เมื่อวาน (${yesterday?.businessDate}) คือ ${y?.market ?? "-"} ${baht(y?.confirmedSalesBaht)} บาท ครับ`;
    }
    case "get_staff_produce": {
      const documents = output.documents as Array<{ market: string; transactionType: string; items: Array<{ product: string; quantity: number | null; unit: string | null }> }>;
      if (!documents.length) return `ไม่พบรายการเบิก/คืนของ ${output.requestedStaff} ในวันที่ ${output.businessDate} ครับ`;
      return `${output.requestedStaff} วันที่ ${output.businessDate}: ` + documents.map((document) =>
        `${document.transactionType} (${document.market}) ${document.items.map((item) => `${item.product} ${item.quantity ?? "?"} ${item.unit ?? ""}`.trim()).join(", ")}`,
      ).join(" | ") + " ครับ";
    }
    case "get_slip_status": {
      const batches = output.batches as Array<{ seller: string | null; checkStatusCounts: Record<string, number> }>;
      const needReview = batches.reduce((sum, batch) => sum + (batch.checkStatusCounts.NEED_REVIEW ?? 0) + (batch.checkStatusCounts.FAILED ?? 0), 0);
      const processing = batches.reduce((sum, batch) => sum + (batch.checkStatusCounts.PROCESSING ?? 0), 0);
      return `${output.requestedStaff ?? "ทุกคน"} มีสลิปที่ต้องให้แอดมินตรวจมือ ${needReview} รายการ และกำลังอ่านอยู่ ${processing} รายการครับ`;
    }
    case "get_pending_items": {
      const items = output.items as Array<{ market: string | null; transactionKind: string | null; origin: string }>;
      if (!items.length) return `ไม่พบรายการค้างของ ${output.requestedStaff ?? "ใคร"} ในวันที่ ${output.businessDate} ครับ`;
      return `${output.requestedStaff ?? "วันนี้"} ยังมีรายการค้าง ${items.length} รายการ: ` + items.map((item) =>
        `${item.transactionKind ?? "เอกสาร"} ที่ ${item.market ?? "ไม่ทราบตลาด"} (${item.origin === "pending_session" ? "เปิดเอกสารแล้วแต่ยังปิด/บันทึกไม่สำเร็จ" : "ระบบยังไม่ได้สร้างเอกสาร"})`,
      ).join(", ") + " ครับ";
    }
    case "get_staff_settlement": {
      const settlements = output.settlements as Array<Record<string, unknown>>;
      if (!settlements.length) return `ไม่พบข้อมูลปิดเงินของ ${output.requestedStaff} ครับ`;
      return settlements.map((settlement) => settlement.status === "INCOMPLETE"
        ? `${settlement.market}: ยังสรุปเงินขาด/เกินไม่ได้ ข้อมูลที่ขาด ${(settlement.missingInputs as string[]).join(", ")}`
        : `${settlement.market}: ${Number(settlement.cashDifferenceBaht) < 0 ? "เงินขาด" : Number(settlement.cashDifferenceBaht) > 0 ? "เงินเกิน" : "เงินปิดตรง"} ${baht(Math.abs(Number(settlement.cashDifferenceBaht)))} บาท`,
      ).join("; ") + " ครับ";
    }
    case "get_white_sheet_status": {
      const sheets = output.sheets as Array<{ market: string; finalized: boolean }>;
      return sheets.map((sheet) => `${sheet.market}: ${sheet.finalized ? "ปิดใบขาวแล้ว" : "ยังไม่ปิดใบขาว"}`).join(", ") + " ครับ";
    }
    default:
      return "ได้ข้อมูลแล้วครับ";
  }
}

function lastUserIndex(transcript: readonly ModelTranscriptItem[]): number {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index]!;
    if (item.kind === "message" && item.role === "user") return index;
  }
  return -1;
}

export class ScriptedThaiModel implements AssistantModelProvider {
  readonly name = "scripted-thai-test-model";
  readonly model = "scripted-thai-v1";
  readonly requests: ModelRoundRequest[] = [];
  /** Inject failures per round (e.g. provider outage). */
  failures: Error[] = [];
  /** Answer text override for the final round (e.g. an ungrounded figure). */
  answerOverride: string | null = null;

  async respond(request: ModelRoundRequest, options: { onUsage?: (usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | null, model: string | null) => void }): Promise<ModelRoundResult> {
    this.requests.push(request);
    const failure = this.failures.shift();
    if (failure) throw failure;
    const transcript = request.transcript;
    const userIndex = lastUserIndex(transcript);
    const after = transcript.slice(userIndex + 1);
    let result: ModelRoundResult;
    if (after.length === 0) {
      const question = (transcript[userIndex] as { text: string }).text;
      const previousUser = transcript.slice(0, userIndex).filter((item) => item.kind === "message" && item.role === "user");
      const previous = previousUser.length
        ? routeQuestion((previousUser.at(-1) as { text: string }).text, null)
        : null;
      const intent = routeQuestion(question, previous);
      result = intent && request.tools.some((tool) => tool.name === intent.tool)
        ? { text: "", toolCalls: [{ callId: `call_${this.requests.length}`, name: intent.tool, arguments: JSON.stringify(intent.args) }], model: this.model }
        : intent
          ? { text: "ขออภัยครับ คุณไม่มีสิทธิ์ดูข้อมูลส่วนนี้", toolCalls: [], model: this.model }
          : { text: "@Botsummary เป็นโหมดอ่านข้อมูลอย่างเดียว ช่วยแก้หรือบันทึกข้อมูลให้ไม่ได้ครับ", toolCalls: [], model: this.model };
    } else {
      const outputs = after.filter((item): item is Extract<ModelTranscriptItem, { kind: "tool_result" }> => item.kind === "tool_result");
      const text = this.answerOverride ?? outputs.map((item) => phraseAnswer(JSON.parse(item.output) as Record<string, unknown>)).join("\n");
      result = { text, toolCalls: [], model: this.model };
    }
    const inputChars = request.instructions.length + JSON.stringify(transcript).length;
    options.onUsage?.({ inputTokens: Math.ceil(inputChars / 4), cachedInputTokens: 0, outputTokens: Math.ceil(result.text.length / 4) + 8 }, this.model);
    return result;
  }
}
