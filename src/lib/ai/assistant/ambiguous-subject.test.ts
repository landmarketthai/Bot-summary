import { describe, expect, test } from "bun:test";
import type { AssistantModelProvider, ModelRoundRequest } from "@/lib/ai/model-provider";
import type { ReadonlyAnalystToolName } from "@/lib/ai/readonly-tools";
import { answerAssistantJob, ASSISTANT_UNGROUNDED_REPLY, type AssistantCoreDeps } from "./core";
import { resolveAmbiguousSubject } from "./ambiguous-subject";
import type { AssistantJobRequest, ConversationTurn } from "./job-store";
import { createFixtureDataReader, FIXTURE_MARKETS, FIXTURE_TODAY, type FixtureRead } from "./testing/fixture-data";
import { MemoryAssistantJobStore } from "./testing/memory-job-store";

function model(tool: ReadonlyAnalystToolName, args: Record<string, unknown>, text = "ข้อมูลจากระบบ"): AssistantModelProvider & { requests: ModelRoundRequest[] } {
  const requests: ModelRoundRequest[] = [];
  return {
    name: "ambiguity-regression", model: "fixture", requests,
    async respond(request) {
      requests.push(request);
      return request.transcript.some(item => item.kind === "tool_result")
        ? { text, toolCalls: [], model: "fixture" }
        : { text: "", toolCalls: [{ callId: "c1", name: tool, arguments: JSON.stringify(args) }], model: "fixture" };
    },
  };
}

let seq = 0;
function harness(provider = model("get_daily_summary", {})) {
  const store = new MemoryAssistantJobStore();
  const reads: FixtureRead[] = [];
  const policy = { markets: null as Set<string> | null };
  const deps: AssistantCoreDeps = {
    supabase: {} as AssistantCoreDeps["supabase"], store, provider,
    sourceAllowed: () => true,
    resolveGroupPolicy: async sourceId => ({ ok: true, policy: { sourceId, markets: policy.markets } }),
    readData: createFixtureDataReader(reads),
  };
  const ask = async (question: string, overrides: Partial<AssistantJobRequest> = {}) => {
    await store.enqueue({
      lineEventId: `ambiguity-${++seq}`, rawMessageId: null, destination: "Ubot", sourceType: "group",
      sourceId: "Capproved", lineUserId: "Umember", question, askedBusinessDate: FIXTURE_TODAY,
      eventTimestampMs: 1_793_000_000_000 + seq, replyToken: null, replyTokenExpiresAt: null, ...overrides,
    });
    const [job] = await store.claim("w", { limit: 1, leaseSeconds: 60, maxRunning: 5 });
    const answer = await answerAssistantJob(job!, { deadlineAt: Date.now() + 10_000, signal: new AbortController().signal }, deps);
    await store.recordAnswer(job!.id, job!.lease_token!, {
      answer: answer.text, kind: answer.kind ?? "answer", turn: answer.turn ?? null, scopeKey: answer.scopeKey ?? null,
    });
    await store.complete(job!.id, job!.lease_token!, "completed");
    return answer;
  };
  return { ask, reads, store, deps, policy, provider };
}

function turn(subjects: Record<string, string>[]): ConversationTurn {
  return {
    question: "คำถามก่อนหน้า", answer: "ข้อความเก่าไม่ใช่หลักฐาน", businessDate: FIXTURE_TODAY, eventTimestampMs: 1,
    context: { tools: subjects.map(args => ({ tool: "get_pending_items", arguments: args })) },
  };
}

describe("unresolved references clarify before model calls or business reads", () => {
  for (const [question, clarification] of [
    ["เขาเบิกอะไรไป", "คนขายคนไหน"],
    ["แล้วเค้าคืนเท่าไหร่", "คนขายคนไหน"],
    ["ของคนนั้นมีสลิปไหม", "คนขายคนไหน"],
    ["ตลาดนั้นเป็นยังไงบ้าง", "ตลาดไหน"],
    ["ตลาดนี้เหลือเท่าไหร่", "ตลาดไหน"],
  ]) {
    test(question!, async () => {
      const h = harness();
      const answer = await h.ask(question!);
      expect(answer.kind).toBe("notice");
      expect(answer.text).toContain(clarification!);
      expect(answer.text).not.toContain("40,550.75");
      expect(answer.turn).toBeUndefined();
      expect(h.provider.requests).toHaveLength(0);
      expect(h.reads).toHaveLength(0);
    });
  }

  test("an unavailable memory lookup cannot broaden a referential question", async () => {
    const h = harness();
    h.store.failNext.loadTurns = new Error("unavailable");
    expect((await h.ask("ตลาดนั้นเป็นยังไงบ้าง")).text).toContain("ตลาดไหน");
    expect(h.provider.requests).toHaveLength(0);
    expect(h.reads).toHaveLength(0);
  });

  test("one user/chat/access scope cannot lend another its subject", async () => {
    for (const change of ["user", "chat", "scope"] as const) {
      const provider = model("get_staff_produce", { staff: "ดำ" });
      const h = harness(provider);
      await h.ask("พี่ดำเบิกอะไรไป");
      provider.requests.length = 0;
      h.reads.length = 0;
      if (change === "scope") h.policy.markets = new Set([FIXTURE_MARKETS.PASEO]);
      const answer = await h.ask("เขาเบิกอะไรไป", change === "user" ? { lineUserId: "Uother" } : change === "chat" ? { sourceId: "Cother" } : {});
      expect(answer.text).toContain("คนขายคนไหน");
      expect(provider.requests).toHaveLength(0);
      expect(h.reads).toHaveLength(0);
    }
  });
});

describe("clear references use explicit subjects or the latest successful turn only", () => {
  test("same-question staff and reviewed market aliases resolve without history", () => {
    expect(resolveAmbiguousSubject("พี่ดำเบิกอะไร แล้วเขาคืนเท่าไหร่", []).question).toBe("พี่ดำเบิกอะไร แล้วดำคืนเท่าไหร่");
    expect(resolveAmbiguousSubject("พาซีโอ้ผักขายเท่าไหร่ แล้วตลาดนั้นเหลืออะไร", []).question).toBe("พาซีโอ้ผักขายเท่าไหร่ แล้วพาซิโอ้ผักเหลืออะไร");
  });

  test("latest context supplies one staff or market; repeated identical subjects are unambiguous", () => {
    expect(resolveAmbiguousSubject("เขาเบิกอะไรไป", [turn([{ staff: "พี่ดำ" }, { staff: "ดำ" }])]).question).toBe("ดำเบิกอะไรไป");
    expect(resolveAmbiguousSubject("ตลาดนั้นเป็นยังไงบ้าง", [turn([{ market: "พาซีโอ้ผัก" }])]).question).toBe("พาซิโอ้ผักเป็นยังไงบ้าง");
  });

  test("several subjects, missing tool context, and an intervening broad turn require clarification", () => {
    for (const turns of [
      [turn([{ staff: "ดำ" }, { staff: "ขวัญ" }])],
      [turn([{ staff: "ดำ" }]), turn([{}])],
      [{ ...turn([]), answer: "พี่ดำเบิกมะม่วง 30 กก.", context: {} }],
      [turn([{ staff: "เขา" }])],
    ]) expect(resolveAmbiguousSubject("เขาเบิกอะไรไป", turns).clarification).toContain("คนขายคนไหน");
    expect(resolveAmbiguousSubject("ตลาดนั้นเป็นยังไง", [turn([{ market: "พาซิโอ้ผัก" }, { market: "ราชพฤกษ์" }])]).clarification).toContain("ตลาดไหน");
    expect(resolveAmbiguousSubject("พี่ดำเบิกอะไร พี่ขวัญเบิกอะไร แล้วเขาคืนเท่าไหร่", []).clarification).toContain("คนขายคนไหน");
    expect(resolveAmbiguousSubject("พี่ดำกับพี่ขวัญเบิกอะไร แล้วเขาคืนเท่าไหร่", [turn([{ staff: "ดำ" }])]).clarification).toContain("คนขายคนไหน");
  });

  test("resolved same-user followup reaches the analyst as a concrete subject and re-reads evidence", async () => {
    const provider = model("get_staff_produce", { staff: "ดำ" });
    const h = harness(provider);
    await h.ask("พี่ดำเบิกอะไรไป");
    provider.requests.length = 0;
    h.reads.length = 0;
    const answer = await h.ask("เขาเบิกอะไรไป");
    expect(answer.kind).toBe("answer");
    expect(answer.text).toContain("มะม่วงน้ำดอกไม้");
    const users = provider.requests[0]!.transcript.filter(item => item.kind === "message" && item.role === "user");
    expect(users.at(-1)).toMatchObject({ text: "ดำเบิกอะไรไป" });
    expect(h.reads).toHaveLength(1);
  });

  test("explicit broad and supported questions, including a name containing เขา, remain unchanged", () => {
    for (const question of [
      "วันนี้ทุกตลาดขายได้เท่าไหร่", "ดำวันนี้เงินขาดหรือเกิน", "พี่ดำเบิกอะไรไป", "พี่ภูเขาเบิกอะไรไป",
      "หนูเล็กมีสลิปรอตรวจกี่รายการ", "ใบขาววันนี้ปิดครบไหม", "รายการของพี่ปลาค้างอะไร", "แก้ไขสลิปของดำเสร็จหรือยัง",
    ]) expect(resolveAmbiguousSubject(question, [])).toEqual({ question });
  });

  test("an explicit all-market question still returns its authorized daily figures", async () => {
    const h = harness();
    expect((await h.ask("วันนี้ทุกตลาดขายได้เท่าไหร่")).text).toContain("40,550.75");
    expect(h.reads).toHaveLength(1);
  });
});

describe("stock rendering ignores model prose only when stock evidence is returned", () => {
  const invented = "ยอดขายยืนยันแล้ว 999,999.99 บาท เหลือขายต่อ 999999 กก.";
  test("daily stock evidence is delivered even if the model invents quantities or money", async () => {
    const h = harness(model("get_stock_summary", {}, invented));
    const answer = await h.ask("วันนี้สต๊อกเหลืออะไรบ้าง");
    expect(answer.kind).toBe("answer");
    expect(answer.text).toContain("มะม่วงน้ำดอกไม้");
    expect(answer.text).toContain("6.5");
    expect(answer.text).not.toContain("999");
    expect(answer.text).not.toContain("บาท");
  });

  test("empty stock evidence remains missing, without forwarding model figures", async () => {
    const h = harness(model("get_stock_summary", {}, invented));
    h.deps.readData = async () => ({ tool: "get_stock_summary", markets: [] });
    const answer = await h.ask("วันนี้สต๊อกเหลืออะไรบ้าง");
    expect(answer.text).toContain("ไม่พบข้อมูล");
    expect(answer.text).not.toContain("999");
  });

  test("errors, denied reads, and malformed stock evidence cannot bypass the model-claim guard", async () => {
    for (const output of [
      { tool: "get_stock_summary", error: "unavailable", markets: [] },
      { tool: "get_stock_summary", status: "forbidden", markets: [] },
      { tool: "get_stock_summary", status: "unsupported", markets: [] },
      { tool: "get_stock_summary" },
      { tool: "get_daily_summary", markets: [] },
    ]) {
      const h = harness(model("get_stock_summary", {}, invented));
      h.deps.readData = async () => output;
      const answer = await h.ask("วันนี้สต๊อกเหลืออะไรบ้าง");
      expect(answer.kind).toBe("notice");
      expect(answer.text).toBe(ASSISTANT_UNGROUNDED_REPLY);
    }
  });

  test("the existing non-stock prose guard remains in force", async () => {
    const h = harness(model("get_staff_produce", { staff: "ดำ" }, invented));
    expect((await h.ask("พี่ดำเบิกอะไรไป")).text).toBe(ASSISTANT_UNGROUNDED_REPLY);
  });
});
