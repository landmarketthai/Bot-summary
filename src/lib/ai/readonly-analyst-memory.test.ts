import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { AssistantModelProvider, ModelRoundResult } from "./model-provider";
import type { ReadonlyAnalystToolRequest } from "./readonly-tools";
import { answerWithReadonlyTools, type AnalystHistoryTurn } from "./readonly-analyst";

const supabase = {} as SupabaseClient<Database>;
const businessDate = "2026-10-07";
function history(tools: Array<{ tool: string; arguments: Record<string, unknown> }>): AnalystHistoryTurn[] {
  return [{ question: "คนขายก่อนหน้าเงินขาดหรือเกิน", answer: "ข้อมูลของคนก่อนหน้า", businessDate, context: { tools } }];
}
const settlement = (staff: string) => ({ tool: "get_staff_settlement" as const, arguments: { staff } });
function provider(replies: ModelRoundResult[] = []) {
  let calls = 0;
  const model: AssistantModelProvider = {
    name: "memory-test", model: "memory-test",
    async respond() { return replies[calls++] ?? { text: "ตอบแล้ว", toolCalls: [], model: "memory-test" }; },
  };
  return { model, calls: () => calls };
}
function output(request: ReadonlyAnalystToolRequest): Record<string, unknown> {
  return { tool: request.tool, businessDate: request.businessDate,
    ...("staff" in request ? { requestedStaff: request.staff } : {}),
    ...("market" in request ? { requestedMarket: request.market } : {}), found: true };
}

describe("deterministic subject replacement from conversation memory", () => {
  for (const [prior, next, question] of [
    ["ดำ", "ปลา", "แล้วปลาล่ะ"],
    ["อรุณ", "มานะ", "แล้วมานะล่ะ"],
    ["วิไล", "สมใจ", "แล้วของพี่ สมใจล่ะครับ"],
  ]) {
    test(`uses exact current subject ${next} without trusting a wrong model name or tool`, async () => {
      const badModel = provider([{ text: "", model: "memory-test", toolCalls: [
        { callId: "wrong-tool", name: "get_staff_produce", arguments: JSON.stringify({ staff: prior }) },
        { callId: "truncated-name", name: "get_staff_settlement", arguments: JSON.stringify({ staff: next.slice(0, -1) }) },
      ] }]);
      const reads: ReadonlyAnalystToolRequest[] = [];
      const result = await answerWithReadonlyTools(supabase, question, {
        provider: badModel.model, history: history([settlement(prior)]), stopOnRepeatedTools: true,
        executeTool: async request => { reads.push(request); return output(request); },
      }, businessDate);
      expect(reads).toEqual([{ tool: "get_staff_settlement", staff: next, businessDate }]);
      expect(result.toolExecutions).toEqual([settlement(next)]);
      expect(result.clarification).toBeUndefined();
      expect(badModel.calls()).toBe(0);
    });
  }

  test("a correct model also produces the same current-subject read", async () => {
    const correctModel = provider([{ text: "", model: "memory-test", toolCalls: [
      { callId: "correct", name: "get_staff_settlement", arguments: '{"staff":"ปลา"}' },
    ] }]);
    const result = await answerWithReadonlyTools(supabase, "แล้วปลาล่ะ", {
      provider: correctModel.model, history: history([settlement("ดำ")]), executeTool: async request => output(request),
    }, businessDate);
    expect(result.toolExecutions).toEqual([settlement("ปลา")]);
    expect(correctModel.calls()).toBe(0);
  });

  test("keeps multiple topics for the same person and the backend date", async () => {
    const reads: ReadonlyAnalystToolRequest[] = [];
    const result = await answerWithReadonlyTools(supabase, "แล้วมานะเมื่อวานล่ะ", {
      provider: provider().model,
      history: history([settlement("อรุณ"), { tool: "get_staff_produce", arguments: { staff: "อรุณ" } }]),
      executeTool: async request => { reads.push(request); return output(request); },
    }, "2026-10-06");
    expect(reads).toEqual([
      { tool: "get_staff_settlement", staff: "มานะ", businessDate: "2026-10-06" },
      { tool: "get_staff_produce", staff: "มานะ", businessDate: "2026-10-06" },
    ]);
    expect(result.clarification).toBeUndefined();
  });

  for (const date of ["5/10/69", "๕/๑๐/๖๙", "5 ตุลาคม 2569"]) {
    test(`does not absorb explicit date ${date} into an entity`, async () => {
      const result = await answerWithReadonlyTools(supabase, `แล้วมานะ ${date} ล่ะ`, {
        provider: provider().model, history: history([settlement("อรุณ")]), executeTool: async request => output(request),
      }, "2026-10-05");
      expect(result.toolExecutions).toEqual([settlement("มานะ")]);
      expect(result.businessDate).toBe("2026-10-05");
    });
  }

  test("a date-only follow-up stays on the existing model path with the backend day", async () => {
    const model = provider();
    const result = await answerWithReadonlyTools(supabase, "แล้ววันนี้ล่ะ", {
      provider: model.model, history: history([settlement("อรุณ")]), executeTool: async request => output(request),
    }, "2026-10-08");
    expect(model.calls()).toBe(1);
    expect(result.businessDate).toBe("2026-10-08");
    expect(result.clarification).toBeUndefined();
  });

  test("replaces a market while preserving the operational topic", async () => {
    const result = await answerWithReadonlyTools(supabase, "แล้วตลาดสวนใหม่ล่ะ", {
      provider: provider().model,
      history: history([{ tool: "get_market_stock", arguments: { market: "สวนเก่า" } }]),
      executeTool: async request => output(request),
    }, businessDate);
    expect(result.toolExecutions).toEqual([{ tool: "get_market_stock", arguments: { market: "สวนใหม่" } }]);
  });

  test("explicit staff replacement preserves an existing market filter", async () => {
    const result = await answerWithReadonlyTools(supabase, "แล้วคนขายมานะล่ะ", {
      provider: provider().model,
      history: history([{ tool: "get_pending_items", arguments: { staff: "อรุณ", market: "สวนเก่า" } }]),
      executeTool: async request => output(request),
    }, businessDate);
    expect(result.toolExecutions).toEqual([{ tool: "get_pending_items", arguments: { staff: "มานะ", market: "สวนเก่า" } }]);
  });

  test("an unknown exact subject remains a not-found lookup, never a fuzzy match", async () => {
    const result = await answerWithReadonlyTools(supabase, "แล้วชื่อใหม่ล่ะ", {
      provider: provider().model, history: history([settlement("อรุณ")]),
      executeTool: async request => ({ ...output(request), found: false, settlements: [] }),
    }, businessDate);
    expect(result.toolExecutions).toEqual([settlement("ชื่อใหม่")]);
    expect(result.clarification).toBeUndefined();
  });

  for (const changed of ["แล้วมานะเบิกอะไรล่ะ", "แล้วใบขาวล่ะ", "แล้วตลาดสวนใหม่ล่ะ"]) {
    test(`preserves an explicit changed topic: ${changed}`, async () => {
      const model = provider();
      const result = await answerWithReadonlyTools(supabase, changed, {
        provider: model.model, history: history([settlement("อรุณ")]),
        executeTool: async () => { throw new Error("must not force inherited settlement"); },
      }, businessDate);
      expect(result.toolExecutions).toEqual([]);
      expect(model.calls()).toBe(1);
    });
  }

  for (const [question, prior] of [
    ["แล้วมานะล่ะ", []],
    ["แล้วมานะกับสมใจล่ะ", [settlement("อรุณ")]],
    ["แล้วมานะล่ะ", [settlement("อรุณ"), settlement("วิไล")]],
    ["แล้วมานะล่ะ", [{ tool: "get_pending_items", arguments: { staff: "อรุณ", market: "สวนเก่า" } }]],
    ["แล้วมานะล่ะ", [settlement("อรุณ"), { tool: "get_market_stock", arguments: { market: "สวนเก่า" } }]],
  ] as Array<[string, Array<{ tool: string; arguments: Record<string, unknown> }>]>) {
    test(`clarifies ambiguous subject/context: ${question} / ${JSON.stringify(prior)}`, async () => {
      let reads = 0;
      const model = provider();
      const result = await answerWithReadonlyTools(supabase, question, {
        provider: model.model, history: history(prior), executeTool: async () => { reads++; return {}; },
      }, businessDate);
      expect(result.clarification).toBe(true);
      expect(result.answer).toContain("กรุณาระบุ");
      expect(reads).toBe(0);
      expect(model.calls()).toBe(0);
    });
  }

  test("rejects authoritative output for a different person rather than rendering it", async () => {
    const result = await answerWithReadonlyTools(supabase, "แล้วมานะล่ะ", {
      provider: provider().model, history: history([settlement("อรุณ")]),
      executeTool: async request => ({ ...output(request), requestedStaff: "อรุณ" }),
    }, businessDate);
    expect(result.clarification).toBe(true);
    expect(result.toolExecutions).toEqual([]);
  });

  test("rejects a matching request label wrapped around a prior person's settlements", async () => {
    const result = await answerWithReadonlyTools(supabase, "แล้วมานะล่ะ", {
      provider: provider().model, history: history([settlement("อรุณ")]),
      executeTool: async request => ({ ...output(request), settlements: [{ staff: "อรุณ" }] }),
    }, businessDate);
    expect(result.clarification).toBe(true);
    expect(result.toolExecutions).toEqual([]);
  });

  test("keeps the six-call bound and rejects oversized remembered plans before reading", async () => {
    let reads = 0;
    const result = await answerWithReadonlyTools(supabase, "แล้วมานะล่ะ", {
      provider: provider().model, history: history(Array.from({ length: 7 }, () => settlement("อรุณ"))),
      executeTool: async () => { reads++; return {}; },
    }, businessDate);
    expect(result.clarification).toBe(true);
    expect(reads).toBe(0);
  });

  test("a hanging inherited read is bounded and cannot start the next tool", async () => {
    let reads = 0;
    await expect(answerWithReadonlyTools(supabase, "แล้วมานะล่ะ", {
      provider: provider().model, budgetMs: 30,
      history: history([settlement("อรุณ"), { tool: "get_staff_produce", arguments: { staff: "อรุณ" } }]),
      executeTool: async () => { reads++; return new Promise(() => {}); },
    }, businessDate)).rejects.toThrow("timed out");
    expect(reads).toBe(1);
  });

  test("does not bypass the current tool allowlist", async () => {
    let reads = 0;
    const result = await answerWithReadonlyTools(supabase, "แล้วมานะล่ะ", {
      provider: provider().model, history: history([settlement("อรุณ")]), allowedTools: new Set(["get_staff_produce"]),
      executeTool: async () => { reads++; return {}; },
    }, businessDate);
    expect(result.clarification).toBe(true);
    expect(reads).toBe(0);
  });
});
