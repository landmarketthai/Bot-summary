/**
 * Regressions for the independent review of PR #191 (head 3c9a856):
 * P1-A staff leakage, P1-B group disclosure, P1-C stale scope/memory,
 * P1-D financial grounding. Each test reproduces the confirmed failure.
 */
import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { BOT_SUMMARY_TEMPORARY_ERROR_REPLY } from "@/lib/ai/line-command";
import type { AssistantModelProvider, ModelRoundRequest } from "@/lib/ai/model-provider";
import type { AssistantScope, ScopeResolution } from "./authorization";
import * as core from "./core";
import type { AssistantCoreDeps } from "./core";

const { answerAssistantJob } = core;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const revalidateAssistantJob = (core as any).revalidateAssistantJob as (
  job: AssistantJob, deps: AssistantCoreDeps, scopeKey: string | null, deliverTo: "chat" | "private",
) => Promise<"current" | "changed" | "transient">;
import type { AssistantJob, AssistantJobRequest } from "./job-store";
import { createFixtureDataReader, FIXTURE_MARKETS, FIXTURE_TODAY, type FixtureRead } from "./testing/fixture-data";
import { MemoryAssistantJobStore } from "./testing/memory-job-store";
import { RecordingLineDelivery } from "./testing/recording-line";
import { ScriptedThaiModel } from "./testing/scripted-provider";
import { runAssistantWorker } from "./worker";

const supervisor: AssistantScope = { lineUserId: "Uboss", role: "supervisor", staffLabel: null, markets: null, grantSource: "env_supervisor" };
const staffDam: AssistantScope = { lineUserId: "Udam", role: "staff", staffLabel: "ดำ", markets: new Set([FIXTURE_MARKETS.RATCHAPHRUEK]), grantSource: "grant" };

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
  scopes?: Record<string, AssistantScope | null>;
  policies?: Record<string, { allowFinancial: boolean; allowPersonSpecific: boolean; markets: Set<string> | null }>;
  privateDeliveryEnabled?: boolean;
}

let seq = 0;
function harness(options: HarnessOptions = {}) {
  const store = new MemoryAssistantJobStore();
  const reads: FixtureRead[] = [];
  const scopes: Record<string, AssistantScope | null> = options.scopes ?? { Uboss: supervisor, Udam: staffDam };
  const policies = options.policies ?? { Cmanagement: { allowFinancial: true, allowPersonSpecific: true, markets: null } };
  const deps = {
    supabase: {} as SupabaseClient<Database>,
    store,
    provider: options.provider ?? new ScriptedThaiModel(),
    resolveScope: async (id: string): Promise<ScopeResolution> =>
      scopes[id] ? { ok: true, scope: scopes[id]! } : { ok: false, reason: "no_grant" },
    resolveGroupPolicy: async (sourceId: string) => {
      const policy = policies[sourceId];
      return { ok: true as const, policy: policy ? { sourceId, ...policy } : null };
    },
    privateDeliveryEnabled: options.privateDeliveryEnabled ?? false,
    readData: createFixtureDataReader(reads),
  } as unknown as AssistantCoreDeps;
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
      answer: answer.text, kind: answer.kind ?? "answer", turn: answer.turn ?? null,
      scopeKey: answer.scopeKey ?? null, deliveryTarget: answer.deliverTo ?? "chat",
    } as never);
    await store.complete(job!.id, job!.lease_token!, "completed");
    return answer;
  };
  return { store, reads, deps, scopes, ask, enqueue };
}

describe("P1-A: staff never reach another employee's data through market-level or indirect tools", () => {
  for (const [tool, args] of [
    ["get_market_summary", { market: "ราชพฤกษ์" }],
    ["get_daily_summary", {}],
    ["get_stock_summary", {}],
    ["get_market_stock", { market: "ราชพฤกษ์" }],
    ["compare_daily_sales", { days: 2 }],
    ["get_white_sheet_status", { market: null }],
    ["get_settlement_overview", {}],
  ] as const) {
    test(`${tool} is refused for staff, even inside their own market`, async () => {
      const h = harness({ provider: oneToolModel(tool, args) });
      const answer = await h.ask("ราชพฤกษ์วันนี้เป็นยังไง", { lineUserId: "Udam" });
      expect(h.reads).toHaveLength(0);
      expect(answer.text).not.toContain("confirmedSales");
    });
  }

  test("an owner-capable tool with someone else's name or no name reads only the asker's rows", async () => {
    for (const args of [{ staff: "ขวัญ", market: null }, { staff: null, market: null }]) {
      const h = harness({ provider: oneToolModel("get_pending_items", args) });
      await h.ask("มีอะไรค้างไหม", { lineUserId: "Udam" });
      for (const read of h.reads) {
        expect((read.request as { staff?: string }).staff).toBe("ดำ");
        expect((read.scope as { ownerStaff?: string }).ownerStaff).toBe("ดำ");
      }
    }
  });
});

describe("P1-B: personal authorization never discloses to a whole LINE group", () => {
  test("a group without a group policy gets a safe refusal and the model is not called", async () => {
    const model = new ScriptedThaiModel();
    const h = harness({ provider: model });
    const answer = await h.ask("วันนี้ทุกตลาดขายได้เท่าไหร่?", { sourceId: "Cworkers" });
    expect(answer.kind).toBe("notice");
    expect(answer.text).toContain("แชทส่วนตัว");
    expect(answer.text).not.toContain("40,550.75");
    expect(model.requests).toHaveLength(0);
    expect(h.reads).toHaveLength(0);
  });

  test("with private delivery enabled, the answer goes to the asker 1:1, not to the group", async () => {
    const h = harness({ privateDeliveryEnabled: true });
    const answer = await h.ask("วันนี้ทุกตลาดขายได้เท่าไหร่?", { sourceId: "Cworkers" });
    expect(answer.deliverTo).toBe("private");
    expect(answer.text).toContain("40,550.75");
  });

  test("mixed-permission group: the group policy caps markets and categories for everyone in it", async () => {
    const policies = { Cmixed: { allowFinancial: true, allowPersonSpecific: false, markets: new Set([FIXTURE_MARKETS.PASEO]) } };
    const sales = harness({ policies });
    const total = await sales.ask("วันนี้ทุกตลาดขายได้เท่าไหร่?", { sourceId: "Cmixed" });
    expect(sales.reads.at(-1)!.scope.markets).toEqual(new Set([FIXTURE_MARKETS.PASEO]));
    expect(total.text).not.toContain(FIXTURE_MARKETS.WAT);
    expect(total.deliverTo ?? "chat").toBe("chat");

    const person = harness({ policies, provider: oneToolModel("get_staff_produce", { staff: "ขวัญ" }) });
    await person.ask("พี่ขวัญเบิกอะไรไป", { sourceId: "Cmixed" });
    expect(person.reads).toHaveLength(0);

    const own = harness({ policies, provider: oneToolModel("get_staff_produce", { staff: "ดำ" }) });
    await own.ask("ของผมเบิกอะไรไป", { sourceId: "Cmixed", lineUserId: "Udam" });
    expect(own.reads).toHaveLength(0);
  });

  test("a 1:1 chat uses the asker's own scope", async () => {
    const h = harness();
    const answer = await h.ask("พี่ดำเบิกอะไรไป", { sourceType: "user", sourceId: "Udam", lineUserId: "Udam" });
    expect(answer.text).toContain("มะม่วงน้ำดอกไม้ 30");
    expect(answer.deliverTo ?? "chat").toBe("chat");
  });
});

describe("P1-C: a downgraded or revoked user never sees memory or answers made under a broader scope", () => {
  test("supervisor-to-staff downgrade: earlier supervisor turns are not given to the model", async () => {
    const model = new ScriptedThaiModel();
    const h = harness({ provider: model, scopes: { Ux: { ...supervisor, lineUserId: "Ux" } } });
    await h.ask("ทำไมรายการของพี่ปลายังปิดไม่ได้?", { lineUserId: "Ux", sourceType: "user", sourceId: "Ux" });
    h.scopes.Ux = { ...staffDam, lineUserId: "Ux" };
    await h.ask("แล้วของพี่ขวัญล่ะ?", { lineUserId: "Ux", sourceType: "user", sourceId: "Ux" });
    const last = model.requests.at(-1)!;
    expect(JSON.stringify(last.transcript)).not.toContain("ปลา");
    expect(last.transcript.filter((item) => item.kind === "message")).toHaveLength(1);
  });

  test("a stored answer is not delivered after the grant is revoked; the user gets a notice", async () => {
    const h = harness();
    const line = new RecordingLineDelivery();
    const { jobId } = await h.enqueue("วันนี้ทุกตลาดขายได้เท่าไหร่?");
    h.store.failNext.setDelivery = new Error("crash after recording the answer");
    const worker = () => runAssistantWorker({
      store: h.store,
      answer: (job: AssistantJob, context: { deadlineAt: number; signal: AbortSignal }) => answerAssistantJob(job, context, h.deps),
      revalidate: (job: AssistantJob, scopeKey: string | null, deliverTo: "chat" | "private") =>
        revalidateAssistantJob(job, h.deps, scopeKey, deliverTo),
      delivery: line, pushFallbackEnabled: true, workerId: "w", budgetMs: 10_000, deliveryReserveMs: 2_000,
      temporaryErrorText: BOT_SUMMARY_TEMPORARY_ERROR_REPLY,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scopeChangedText: (core as any).ASSISTANT_SCOPE_CHANGED_REPLY,
    } as never);
    await worker();
    expect(h.store.jobs.get(jobId!)!.answer_text).toContain("40,550.75");
    delete h.scopes.Uboss;
    h.store.expireLease(jobId!);
    await worker();
    expect(line.sent).toHaveLength(1);
    expect(line.sent[0]!.text).not.toContain("40,550.75");
    expect(line.sent[0]!.text).toContain("สิทธิ์");
    expect(h.store.jobs.get(jobId!)!.answer_text).not.toContain("40,550.75");
    expect(h.store.turns.filter((turn) => turn.jobId === jobId)).toHaveLength(0);
  });
});

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
