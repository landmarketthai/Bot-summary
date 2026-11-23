import { expect, test } from "bun:test";
import type { AssistantModelProvider } from "@/lib/ai/model-provider";
import { ANSWER_EVAL_SET } from "./answer-eval-set";
import { runAnswerEval } from "./runner";
const priced = {
  BOT_SUMMARY_ANALYST_INPUT_USD_PER_MTOK: "0.10", BOT_SUMMARY_ANALYST_OUTPUT_USD_PER_MTOK: "0.50"
};
const cases = (...ids: string[]) => ids.map(id => ANSWER_EVAL_SET.find(c => c.id === id)!);
function repeat(tool: string): AssistantModelProvider {
  return {
    name: "repeat", model: "fixture", async respond(req, opt) {
      if (req.transcript.filter(t => t.kind === "message" && t.role === "user").length > 1)
        expect(req.transcript.some(t => t.kind === "message" && t.role === "assistant" && t.text.includes("Previous tool context") && t.text.includes(tool))).toBe(true);
      opt.onUsage?.({
        inputTokens: 100, cachedInputTokens: 0, outputTokens: 20
      }, "fixture");
      const question = [...req.transcript].reverse().find(t => t.kind === "message" && t.role === "user");
      const staff = question?.kind === "message" && question.text.includes("ปลา") ? "ปลา" : "ดำ";
      return {
        text: "", model: "fixture", toolCalls: [{
            callId: String(req.transcript.length), name: tool, arguments: JSON.stringify({
              staff
            })
          }]
      };
    }
  };
}
test("financial follow-up repeated tool terminates with authoritative new staff evidence", async () => { const r = await runAnswerEval({
  provider: repeat("get_staff_settlement"), cases: cases("mem-01"), env: priced
}); expect(r.results[0]!.pass).toBe(true); expect(r.results[0]!.answer).toContain("เงินปิดตรง"); });
test("non-financial follow-up retains tools and fresh quantities", async () => { const r = await runAnswerEval({
  provider: repeat("get_staff_produce"), cases: cases("mem-04"), env: priced
}); expect(r.results[0]!.pass).toBe(true); expect(r.results[0]!.answer).toContain("1.2"); });
test("failed provider response usage survives; missing usage blocks subsequent cases", async () => { let calls = 0; const provider: AssistantModelProvider = {
  name: "failure", model: "fixture", async respond(_r, o) { calls++; o.onUsage?.({
    inputTokens: 100, cachedInputTokens: 0, outputTokens: 20
  }, "fixture"); throw Error("private provider text"); }
}; const r = await runAnswerEval({
  provider, cases: cases("fin-01"), env: priced, maxUsd: .5
}); expect(r.summary.tokens.modelCalls).toBe(1); expect(r.summary.tokens.inputTokens).toBe(100); expect(r.summary.tokens.usageComplete).toBe(true); expect(r.summary.costUsd).toBeGreaterThan(0); expect(JSON.stringify(r)).not.toContain("private provider text"); const unknown = await runAnswerEval({
  provider: {
    ...provider, async respond() { throw Error("unknown"); }
  }, cases: cases("fin-01", "fin-13"), env: priced, maxUsd: .5
}); expect(unknown.results[0]!.usage.usageComplete).toBe(false); expect(unknown.results[0]!.costUsd).toBeNull(); expect(unknown.summary.notRun).toBe(1); expect(calls).toBe(1); });
test("genuine multiple tools remain available and rendered", async () => { let calls = 0; const provider: AssistantModelProvider = {
  name: "multi", model: "fixture", async respond(_r, o) { o.onUsage?.({
    inputTokens: 10, cachedInputTokens: 0, outputTokens: 1
  }, "fixture"); const name = ["get_daily_summary", "get_stock_summary"][calls++]; return {
    model: "fixture", text: "ผลตามข้อมูลระบบ", toolCalls: name ? [{
        callId: String(calls), name, arguments: "{}"
      }] : []
  }; }
}; const r = await runAnswerEval({
  provider, cases: cases("fin-01"), env: priced
}); expect(r.results[0]!.pass).toBe(true); expect(r.results[0]!.toolsUsed).toEqual(["get_daily_summary", "get_stock_summary"]); expect(calls).toBe(3); });
test("saved six-call usage trace survives explicit-question tool limit and exhausts budget", async () => { const trace = [{
    inputTokens: 1715, cachedInputTokens: 1700, outputTokens: 20
  }, {
    inputTokens: 1834, cachedInputTokens: 1712, outputTokens: 21
  }, {
    inputTokens: 1796, cachedInputTokens: 1712, outputTokens: 20
  }, {
    inputTokens: 1915, cachedInputTokens: 1793, outputTokens: 20
  }, {
    inputTokens: 2155, cachedInputTokens: 1912, outputTokens: 20
  }, {
    inputTokens: 2273, cachedInputTokens: 2152, outputTokens: 43
  }]; let n = 0; const provider: AssistantModelProvider = {
  name: "trace", model: "fixture", async respond(_r, o) { o.onUsage?.(trace[n]!, "fixture"); n++; return {
    model: "fixture", text: n === 2 ? "ข้อความไม่มีตัวเลข" : "", toolCalls: n === 2 ? [] : [{
        callId: String(n), name: "get_staff_settlement", arguments: JSON.stringify({
          staff: n === 1 ? "ดำ" : "ปลา" + n
        })
      }]
  }; }
}; const r = await runAnswerEval({
  // An explicit new question exercises the model loop; subject-only follow-ups now bypass it.
  provider, cases: [{ ...cases("mem-01")[0]!, question: "ปลาเงินขาดหรือเกิน" }, ...cases("hal-03")], env: {
    ...priced, BOT_SUMMARY_ANALYST_CACHED_INPUT_USD_PER_MTOK: "0.01"
  }, maxUsd: .0002
}); expect(n).toBe(6); expect(r.results[0]!.pass).toBe(false); expect(r.results[0]!.usage).toEqual({
  modelCalls: 6, inputTokens: 11688, cachedInputTokens: 10981, outputTokens: 144, usageComplete: true
}); expect(r.results[0]!.costUsd).toBeCloseTo(.00025251, 10); expect(r.summary.notRun).toBe(1); });

test("a response with invalid usage cannot claim complete accounting", async () => {
  const provider: AssistantModelProvider = {
    name: "invalid-usage", model: "fixture",
    async respond(_request, options) {
      options.onUsage?.({inputTokens: NaN, cachedInputTokens: 0, outputTokens: 1}, "fixture");
      return {text: "ไม่มีข้อมูล", model: "fixture", toolCalls: []};
    },
  };
  const result = await runAnswerEval({provider, cases: cases("hal-05", "fin-01"), env: priced, maxUsd: 0.5});
  expect(result.results[0]!.usage.modelCalls).toBe(1);
  expect(result.results[0]!.usage.usageComplete).toBe(false);
  expect(result.results[0]!.costUsd).toBeNull();
  expect(result.summary.notRun).toBe(1);
});
