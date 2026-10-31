/**
 * Regressions for the independent review of PR #191 (head 3c9a856).
 * P1-D financial grounding is unchanged. P1-A (staff leakage), P1-B (group
 * disclosure) and P1-C (stale scope) are now covered by the V1 access model
 * (approved groups only; no 1:1, no per-user grants, no private delivery):
 * the tests below reproduce each original exposure path and show it closed.
 */
import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { AssistantModelProvider, ModelRoundRequest } from "@/lib/ai/model-provider";
import type { GroupPolicy } from "./authorization";
import {
  answerAssistantJob,
  ASSISTANT_DIRECT_CHAT_REPLY,
  ASSISTANT_GROUP_REFUSAL_REPLY,
  type AssistantCoreDeps,
} from "./core";
import type { AssistantJob, AssistantJobRequest } from "./job-store";
import { createFixtureDataReader, FIXTURE_MARKETS, FIXTURE_TODAY, type FixtureRead } from "./testing/fixture-data";
import { MemoryAssistantJobStore } from "./testing/memory-job-store";
import { ScriptedThaiModel } from "./testing/scripted-provider";

/** A model that calls exactly one tool with the given args, then echoes `answer` (or the tool output). */
function oneToolModel(tool: string, args: Record<string, unknown>, answer?: string): AssistantModelProvider & { requests: ModelRoundRequest[] } {
  const requests: ModelRoundRequest[] = [];
  return {
    name: "one-tool", model: "one-tool", requests,
    async respond(request) {
      requests.push(request);
      const result = request.transcript.find((item) => item.kind === "tool_result") as { output: string } | undefined;
      if (result) return { text: answer ?? result.output, toolCalls: [], model: "one-tool" };
      return { text: "", toolCalls: [{ callId: "c1", name: tool, arguments: JSON.stringify(args) }], model: "one-tool" };
    },
  };
}

interface HarnessOptions {
  provider?: AssistantModelProvider;
  policies?: Record<string, GroupPolicy | undefined>;
}

let seq = 0;
function harness(options: HarnessOptions = {}) {
  const store = new MemoryAssistantJobStore();
  const reads: FixtureRead[] = [];
  const policies: Record<string, GroupPolicy | undefined> = options.policies ?? { Cmanagement: { sourceId: "Cmanagement", markets: null } };
  const deps: AssistantCoreDeps = {
    supabase: {} as SupabaseClient<Database>,
    store,
    provider: options.provider ?? new ScriptedThaiModel(),
    resolveGroupPolicy: async (sourceId) => ({ ok: true, policy: policies[sourceId] ?? null }),
    sourceAllowed: () => true,
    readData: createFixtureDataReader(reads),
  };
  const enqueue = async (question: string, overrides: Partial<AssistantJobRequest> = {}) => {
    seq += 1;
    return store.enqueue({
      lineEventId: `rf-${seq}`, rawMessageId: null, destination: "Ubot", sourceType: "group",
      sourceId: "Cmanagement", lineUserId: "Uboss", question, askedBusinessDate: FIXTURE_TODAY,
      eventTimestampMs: 1_793_000_000_000 + seq, replyToken: `token-${seq}`,
      replyTokenExpiresAt: new Date(Date.now() + 50_000).toISOString(), ...overrides,
    });
  };
  const ask = async (question: string, overrides: Partial<AssistantJobRequest> = {}) => {
    await enqueue(question, overrides);
    const [job] = await store.claim("w", { limit: 1, leaseSeconds: 60, maxRunning: 5 });
    const answer = await answerAssistantJob(job as AssistantJob, { deadlineAt: Date.now() + 10_000, signal: new AbortController().signal }, deps);
    await store.recordAnswer(job!.id, job!.lease_token!, {
      answer: answer.text, kind: answer.kind ?? "answer", turn: answer.turn ?? null, scopeKey: answer.scopeKey ?? null,
    });
    await store.complete(job!.id, job!.lease_token!, "completed");
    return answer;
  };
  return { store, reads, deps, policies, ask, enqueue };
}

const dm = (lineUserId: string) => ({ lineUserId, sourceType: "user" as const, sourceId: lineUserId });

describe("P1-A path (1:1 chats): no tool runs at all in V1", () => {
  for (const [tool, args] of [
    ["get_market_summary", { market: "ราชพฤกษ์" }],
    ["get_daily_summary", {}],
    ["get_settlement_overview", {}],
    ["get_staff_produce", { staff: "ขวัญ" }],
    ["get_pending_items", { staff: null, market: null }],
    ["get_slip_status", { staff: null, market: null }],
  ] as const) {
    test(`${tool} in a 1:1 chat: refused before the model or any read`, async () => {
      const model = oneToolModel(tool, args);
      const h = harness({ provider: model });
      const answer = await h.ask("ราชพฤกษ์วันนี้เป็นยังไง", dm("Udam"));
      expect(answer).toEqual({ text: ASSISTANT_DIRECT_CHAT_REPLY, kind: "notice" });
      expect(model.requests).toHaveLength(0);
      expect(h.reads).toHaveLength(0);
    });
  }
});

describe("P1-B path: nothing is disclosed to a group that is not approved", () => {
  test("a group without a group policy gets a safe refusal and the model is not called", async () => {
    const model = new ScriptedThaiModel();
    const h = harness({ provider: model });
    const answer = await h.ask("วันนี้ทุกตลาดขายได้เท่าไหร่?", { sourceId: "Cworkers" });
    expect(answer).toEqual({ text: ASSISTANT_GROUP_REFUSAL_REPLY, kind: "notice" });
    expect(model.requests).toHaveLength(0);
    expect(h.reads).toHaveLength(0);
  });

  test("a market-limited approved group: its markets bind everyone who asks there", async () => {
    const h = harness({ policies: { Cpaseo: { sourceId: "Cpaseo", markets: new Set([FIXTURE_MARKETS.PASEO]) } } });
    for (const user of ["Uboss", "Udam", "Ustranger"]) {
      const total = await h.ask("วันนี้ทุกตลาดขายได้เท่าไหร่?", { sourceId: "Cpaseo", lineUserId: user });
      expect(h.reads.at(-1)!.scope.markets).toEqual(new Set([FIXTURE_MARKETS.PASEO]));
      expect(total.text).not.toContain(FIXTURE_MARKETS.WAT);
      expect(total.text).not.toContain("40,550.75");
    }
  });
});

// P1-C path (revoked/narrowed approval, also after a crash): group-shared-scope.test.ts.

describe("P1-D: financial figures are rendered from backend fields, never certified from model text", () => {
  test("a false amount from the user's question is not evidence", async () => {
    const h = harness({ provider: oneToolModel("get_daily_summary", {}, "ใช่ครับ วันนี้ยอดขายยืนยัน 41,000.00 บาท") });
    const answer = await h.ask("วันนี้ขายได้ 41,000.00 บาทใช่ไหม");
    expect(answer.text).not.toContain("41,000");
    expect(answer.text).toContain("40,550.75");
  });

  test("an unsupported zero amount is not delivered for an incomplete settlement", async () => {
    const h = harness({ provider: oneToolModel("get_staff_settlement", { staff: "ขวัญ" }, "ขวัญเงินขาด 0 บาท ปิดตรงครับ") });
    const answer = await h.ask("ขวัญวันนี้เงินขาดหรือเกิน");
    expect(answer.text).not.toMatch(/ขาด\s*0|ปิดตรง/u);
    expect(answer.text).toContain("ยังสรุป");
    expect(answer.text).toContain("เงินสดที่ส่งจริง");
  });

  test("a negative cash difference is never reported as an excess", async () => {
    const h = harness({ provider: oneToolModel("get_staff_settlement", { staff: "ดำ" }, "ดำเงินเกิน 120.00 บาทครับ") });
    const answer = await h.ask("ดำวันนี้เงินขาดหรือเกิน");
    expect(answer.text).not.toContain("เงินเกิน");
    expect(answer.text).toContain("เงินขาด 120.00 บาท");
  });

  test("a pending-review amount is never reported as confirmed", async () => {
    const h = harness({ provider: oneToolModel("get_daily_summary", {}, "ยอดยืนยันรวม 1,650.00 บาทครับ") });
    const answer = await h.ask("วันนี้ขายได้เท่าไหร่");
    expect(answer.text).not.toMatch(/ยืนยัน(?:แล้ว)?\s*1,650\.00/u);
    expect(answer.text).toContain("ยืนยันแล้ว 40,550.75 บาท · รอตรวจ 1,650.00 บาท");
  });

  test("satang precision and null values are preserved", async () => {
    const h = harness({ provider: oneToolModel("get_daily_summary", {}, "ประมาณ 40,551 บาท") });
    const answer = await h.ask("วันนี้ขายได้เท่าไหร่");
    expect(answer.text).toContain("12,780.25");
    expect(answer.text).not.toContain("40,551 ");
  });

  test("a financial claim in an answer without any financial tool is withheld", async () => {
    const h = harness({ provider: oneToolModel("get_staff_produce", { staff: "ดำ" }, "ดำเบิกมะม่วง 30 กก. คิดเป็นเงิน 3,000 บาท เงินขาด 0 บาท") });
    const answer = await h.ask("พี่ดำเบิกอะไรไป");
    expect(answer.kind).toBe("notice");
    expect(answer.text).not.toContain("3,000");
  });
});
