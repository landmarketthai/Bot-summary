import { describe, expect, test } from "bun:test";
import type { AssistantModelProvider } from "@/lib/ai/model-provider";
import { FIXTURE_MONEY_SATANG } from "../testing/fixture-data";
import { ScriptedThaiModel } from "../testing/scripted-provider";
import { ANSWER_EVAL_SET, type AnswerEvalCase } from "./answer-eval-set";
import { gradeAnswer, moneyMentionsSatang, normalizeForGrading } from "./grader";
import { runAnswerEval } from "./runner";

const byId = (id: string) => ANSWER_EVAL_SET.find((testCase) => testCase.id === id)!;

/** Calls `tool` with `args`, then states `answer` regardless of what the tool returned. */
function liar(tool: string, args: Record<string, unknown>, answer: string): AssistantModelProvider {
  return {
    name: "liar", model: "liar",
    async respond(request, options) {
      options.onUsage?.({ inputTokens: 100, cachedInputTokens: 0, outputTokens: 20 }, "liar");
      const done = request.transcript.some((item) => item.kind === "tool_result");
      return done
        ? { text: answer, toolCalls: [], model: "liar" }
        : { text: "", toolCalls: [{ callId: "c1", name: tool, arguments: JSON.stringify(args) }], model: "liar" };
    },
  };
}

describe("evaluation set", () => {
  test("has at least 60 questions with unique ids across every required area", () => {
    expect(ANSWER_EVAL_SET.length).toBeGreaterThanOrEqual(60);
    expect(new Set(ANSWER_EVAL_SET.map((testCase) => testCase.id)).size).toBe(ANSWER_EVAL_SET.length);
    const counts = new Map<string, number>();
    for (const testCase of ANSWER_EVAL_SET) counts.set(testCase.category, (counts.get(testCase.category) ?? 0) + 1);
    for (const category of ["financial", "produce", "stock", "slips", "white_sheet", "pending", "business_date", "memory", "ambiguous", "hallucination", "access"]) {
      expect(counts.get(category) ?? 0).toBeGreaterThanOrEqual(5);
    }
    // Every case is graded on facts or refusals, not only on tool choice.
    for (const testCase of ANSWER_EVAL_SET) {
      const graded = (testCase.expect.mustInclude?.length ?? 0) + (testCase.expect.mustIncludeAny?.length ?? 0)
        + (testCase.expect.mustNotInclude?.length ?? 0) + (testCase.expect.kind ? 1 : 0);
      expect(graded).toBeGreaterThan(0);
    }
  });
});

describe("grading rules", () => {
  test("normalization ignores separators, spacing and Thai digits", () => {
    expect(normalizeForGrading("ยืนยันแล้ว 40,550.75 บาท")).toBe(normalizeForGrading("ยืนยันแล้ว40550.75บาท"));
    expect(normalizeForGrading("๔๐,๕๕๐.๗๕")).toBe("40550.75");
    expect(moneyMentionsSatang("ขาด 120.00 บาท และ 1,650 บาท")).toEqual([12000, 165000]);
  });

  test("a correct answer passes; a missing fact, a forbidden claim and an invented amount each fail with their category", () => {
    const testCase: AnswerEvalCase = { id: "t", category: "financial", question: "q", expect: { mustInclude: ["เงินขาด 120.00"], mustNotInclude: ["เงินเกิน"] } };
    expect(gradeAnswer(testCase, { text: "• ราชพฤกษ์ (ดำ): เงินขาด 120.00 บาท (ต้องได้ 8,000.00 บาท · ส่งจริง 7,880.00 บาท)", kind: "answer" }, FIXTURE_MONEY_SATANG)).toEqual([]);
    expect(gradeAnswer(testCase, { text: "ดำเงินเกิน 120.00 บาท", kind: "answer" }, FIXTURE_MONEY_SATANG).map((error) => error.category).sort())
      .toEqual(["forbidden_content", "missing_fact"]);
    expect(gradeAnswer(testCase, { text: "เงินขาด 120.00 บาท ยอดรวม 99,999 บาท", kind: "answer" }, FIXTURE_MONEY_SATANG))
      .toEqual([{ category: "hallucinated_figure", detail: "99999.00 บาท is not an authoritative value" }]);
    expect(gradeAnswer({ ...testCase, expect: { kind: "notice" } }, { text: "ok", kind: "answer" }, FIXTURE_MONEY_SATANG)[0]!.category)
      .toBe("answered_unexpectedly");
  });
});

describe("expectations are fair to correct answers that include other markets or staff", () => {
  const grade = (id: string, text: string) => gradeAnswer(byId(id), { text, kind: "answer" }, FIXTURE_MONEY_SATANG).map((error) => error.category);
  test("a complete overview passes; the same overview with the asked-about row wrong fails", () => {
    const overview = "• ราชพฤกษ์ (ดำ): เงินขาด 120.00 บาท (ต้องได้ 8,000.00 บาท · ส่งจริง 7,880.00 บาท)\n"
      + "• พาซิโอ้ผัก (ขวัญ): ยังสรุปไม่ได้ ขาดข้อมูล: เงินสดที่ส่งจริง\n• วัดตะกล่ำ (ปลา): เงินปิดตรง (ต้องได้ 5,000.00 บาท · ส่งจริง 5,000.00 บาท)";
    expect(grade("fin-09", overview)).toEqual([]);
    expect(grade("fin-10", overview)).toEqual([]);
    expect(grade("fin-10", "• วัดตะกล่ำ (ปลา): เงินขาด 120.00 บาท")).toContain("forbidden_content");
    const sheets = "พาซิโอ้ผัก: ยังไม่ปิดใบขาว, วัดตะกล่ำ: ปิดใบขาวแล้ว, ราชพฤกษ์: ปิดใบขาวแล้ว ครับ";
    expect(grade("wsh-02", sheets)).toEqual([]);
    expect(grade("wsh-04", sheets)).toEqual([]);
    expect(grade("wsh-02", "วัดตะกล่ำ: ยังไม่ปิดใบขาว ส่วนตลาดอื่นปิดแล้ว")).toContain("forbidden_content");
    expect(grade("sli-05", "ขวัญยังไม่มีสลิปในระบบวันนี้ครับ")).toEqual([]);
    expect(grade("sli-05", "ขวัญมีสลิป 0 รายการครับ")).toEqual([]);
  });
});

describe("answer-level grading through the real pipeline", () => {
  test("the right tool with a wrong quantity fails", async () => {
    const { results } = await runAnswerEval({
      provider: liar("get_staff_produce", { staff: "ดำ" }, "ดำคืนเสียมะม่วง 2.5 กก. ครับ"),
      cases: [byId("pro-04")],
    });
    expect(results[0]!.toolMatch).toBe(true);
    expect(results[0]!.pass).toBe(false);
    expect(results[0]!.errors.map((error) => error.category)).toContain("missing_fact");
  });

  test("an invented amount in a non-financial answer is withheld by the pipeline and fails grading", async () => {
    const { results } = await runAnswerEval({
      provider: liar("get_slip_status", { staff: "เล็ก", market: null }, "เล็กมีสลิปรอตรวจ 2 รายการ รวมยอด 3,500 บาท"),
      cases: [byId("sli-01")],
    });
    expect(results[0]!.pass).toBe(false);
    expect(results[0]!.answer).toContain("ตรวจสอบกับข้อมูลระบบไม่ผ่าน");
  });

  test("a model that lies about money cannot fail a financial case: the backend fields are rendered", async () => {
    const { results } = await runAnswerEval({
      provider: liar("get_staff_settlement", { staff: "ดำ" }, "ดำเงินเกิน 999 บาท"),
      cases: [byId("fin-08")],
    });
    expect(results[0]!.pass).toBe(true);
    expect(results[0]!.answer).toContain("เงินขาด 120.00 บาท");
  });

  test("usage, latency and cost are recorded; cost is null without prices, never zero", async () => {
    const { results, summary } = await runAnswerEval({
      provider: liar("get_daily_summary", {}, "x"),
      cases: [byId("fin-01")],
      env: {},
    });
    expect(results[0]!.usage).toMatchObject({ modelCalls: 2, inputTokens: 200, outputTokens: 40 });
    expect(results[0]!.costUsd).toBeNull();
    expect(summary.costUsd).toBeNull();
    const priced = await runAnswerEval({
      provider: liar("get_daily_summary", {}, "x"),
      cases: [byId("fin-01")],
      env: { BOT_SUMMARY_ANALYST_INPUT_USD_PER_MTOK: "1", BOT_SUMMARY_ANALYST_OUTPUT_USD_PER_MTOK: "4" },
    });
    expect(priced.summary.costUsd).toBeCloseTo((200 * 1 + 40 * 4) / 1_000_000, 9);
  });

  test("the budget stops new cases and they are reported as not run", async () => {
    const { results, summary } = await runAnswerEval({
      provider: liar("get_daily_summary", {}, "x"),
      cases: [byId("fin-01"), byId("fin-02"), byId("fin-03")],
      maxUsd: 0.0000001,
      env: { BOT_SUMMARY_ANALYST_INPUT_USD_PER_MTOK: "1", BOT_SUMMARY_ANALYST_OUTPUT_USD_PER_MTOK: "4" },
    });
    expect(results.slice(1).every((result) => result.errors[0]?.category === "not_run_budget")).toBe(true);
    expect(summary.notRun).toBe(2);
  });

  test("the whole set runs end to end with the scripted stand-in (harness check, not a model score)", async () => {
    const { summary } = await runAnswerEval({ provider: new ScriptedThaiModel(), cases: ANSWER_EVAL_SET });
    expect(summary.total).toBe(ANSWER_EVAL_SET.length);
    expect(summary.notRun).toBe(0);
    expect(summary.errorCategories.provider_error ?? 0).toBe(0);
  });
});
