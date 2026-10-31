/**
 * Owner decision (2026-10-31): every member of an explicitly approved LINE
 * group can ask any supported business question and see the answer there.
 * All members share the GROUP's scope (V1 has no per-user grants and no 1:1
 * Q&A). Conversation memory stays per member.
 */
import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { BOT_SUMMARY_TEMPORARY_ERROR_REPLY } from "@/lib/ai/line-command";
import type { AssistantModelProvider, ModelRoundRequest } from "@/lib/ai/model-provider";
import type { GroupPolicy } from "./authorization";
import {
  answerAssistantJob,
  ASSISTANT_DIRECT_CHAT_REPLY,
  ASSISTANT_GROUP_REFUSAL_REPLY,
  ASSISTANT_SCOPE_CHANGED_REPLY,
  revalidateAssistantJob,
  type AssistantCoreDeps,
} from "./core";
import type { AssistantJob, AssistantJobRequest } from "./job-store";
import { createFixtureDataReader, FIXTURE_MARKETS, FIXTURE_TODAY, type FixtureRead } from "./testing/fixture-data";
import { MemoryAssistantJobStore } from "./testing/memory-job-store";
import { RecordingLineDelivery } from "./testing/recording-line";
import { ScriptedThaiModel } from "./testing/scripted-provider";
import { runAssistantWorker } from "./worker";

const full = (sourceId: string): GroupPolicy => ({ sourceId, markets: null });

function oneTool(tool: string, args: Record<string, unknown>): AssistantModelProvider & { requests: ModelRoundRequest[] } {
  const requests: ModelRoundRequest[] = [];
  return {
    name: "one-tool", model: "one-tool", requests,
    async respond(request) {
      requests.push(request);
      const result = request.transcript.find((item) => item.kind === "tool_result") as { output: string } | undefined;
      return result
        ? { text: result.output, toolCalls: [], model: "one-tool" }
        : { text: "", toolCalls: [{ callId: "c1", name: tool, arguments: JSON.stringify(args) }], model: "one-tool" };
    },
  };
}

let seq = 0;
function harness(options: {
  provider?: AssistantModelProvider;
  policies?: Record<string, GroupPolicy | undefined>;
  allowlist?: string[];
} = {}) {
  const store = new MemoryAssistantJobStore();
  const reads: FixtureRead[] = [];
  const policies: Record<string, GroupPolicy | undefined> = options.policies ?? { Capproved: full("Capproved") };
  const allowlist = options.allowlist ?? ["Capproved", "Cmarket", "Cunapproved", "Uboss", "Udam"];
  const deps: AssistantCoreDeps = {
    supabase: {} as SupabaseClient<Database>,
    store,
    provider: options.provider ?? new ScriptedThaiModel(),
    resolveGroupPolicy: async (sourceId) => ({ ok: true, policy: policies[sourceId] ?? null }),
    sourceAllowed: (sourceId) => allowlist.includes(sourceId),
    readData: createFixtureDataReader(reads),
  };
  const enqueue = (question: string, overrides: Partial<AssistantJobRequest> = {}) => {
    seq += 1;
    return store.enqueue({
      lineEventId: `gs-${seq}`, rawMessageId: null, destination: "Ubot", sourceType: "group",
      sourceId: "Capproved", lineUserId: "Ustranger", question, askedBusinessDate: FIXTURE_TODAY,
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
      scopeKey: answer.scopeKey ?? null,
    });
    await store.complete(job!.id, job!.lease_token!, "completed");
    return answer;
  };
  return { store, reads, deps, policies, ask, enqueue };
}

describe("approved group: every member shares the group scope", () => {
  for (const member of ["Ustranger", "Udam", "Uboss"]) {
    test(`${member} can ask any supported question under the group's scope`, async () => {
      for (const [tool, args, fragment] of [
        ["get_daily_summary", {}, "40,550.75"],
        ["get_staff_produce", { staff: "ขวัญ" }, "ผักกาดขาว"],
        ["get_slip_status", { staff: "เล็ก", market: null }, "NEED_REVIEW"],
        ["get_staff_settlement", { staff: "ดำ" }, "เงินขาด 120.00 บาท"],
        ["get_pending_items", { staff: "ปลา", market: null }, "pending_session"],
        ["get_white_sheet_status", { market: null }, "finalized"],
      ] as const) {
        const h = harness({ provider: oneTool(tool, args) });
        const answer = await h.ask("คำถาม", { lineUserId: member });
        expect(answer.kind).toBe("answer");
        expect(answer.text).toContain(fragment);
        expect(h.reads.at(-1)!.scope).toEqual({ markets: null });
      }
    });
  }

  test("the group's markets bind every member", async () => {
    const policies = { Cmarket: { sourceId: "Cmarket", markets: new Set([FIXTURE_MARKETS.PASEO]) } };
    for (const member of ["Uboss", "Udam", "Ustranger"]) {
      const h = harness({ policies });
      const answer = await h.ask("วันนี้ทุกตลาดขายได้เท่าไหร่?", { sourceId: "Cmarket", lineUserId: member });
      expect(h.reads.at(-1)!.scope.markets).toEqual(new Set([FIXTURE_MARKETS.PASEO]));
      expect(answer.text).toContain(FIXTURE_MARKETS.PASEO);
      expect(answer.text).not.toContain(FIXTURE_MARKETS.RATCHAPHRUEK);
      expect(answer.text).not.toContain("40,550.75");
    }
  });

  test("an allowlisted group without a group policy is refused", async () => {
    const model = new ScriptedThaiModel();
    const h = harness({ provider: model });
    const answer = await h.ask("วันนี้ทุกตลาดขายได้เท่าไหร่?", { sourceId: "Cunapproved", lineUserId: "Uboss" });
    expect(answer).toEqual({ text: ASSISTANT_GROUP_REFUSAL_REPLY, kind: "notice" });
    expect(model.requests).toHaveLength(0);
    expect(h.reads).toHaveLength(0);
  });

  test("a group policy without the source allowlist is refused (signed-source allowlist re-checked by the worker)", async () => {
    const h = harness({ policies: { Cexternal: full("Cexternal") } });
    const answer = await h.ask("วันนี้ทุกตลาดขายได้เท่าไหร่?", { sourceId: "Cexternal", lineUserId: "Uboss" });
    expect(answer.kind).toBe("notice");
    expect(h.reads).toHaveLength(0);
  });

  test("members of one approved group keep separate conversation memory", async () => {
    const model = new ScriptedThaiModel();
    const h = harness({ provider: model });
    await h.ask("ทำไมรายการของพี่ปลายังปิดไม่ได้?", { lineUserId: "Uboss" });
    await h.ask("แล้วของพี่ขวัญล่ะ?", { lineUserId: "Udam" });
    const round = model.requests.at(-1)!;
    expect(round.transcript.filter((item) => item.kind === "message")).toHaveLength(1);
    expect(JSON.stringify(round.transcript)).not.toContain("ปลา");
    // ...while the same member's own follow-up keeps context.
    await h.ask("แล้วของพี่ขวัญล่ะ?", { lineUserId: "Uboss" });
    expect(model.requests.at(-1)!.transcript.filter((item) => item.kind === "message")).toHaveLength(3);
  });

  test("a revoked group policy withholds an answer recorded before the revocation", async () => {
    const h = harness();
    const line = new RecordingLineDelivery();
    const { jobId } = await h.enqueue("วันนี้ทุกตลาดขายได้เท่าไหร่?");
    h.store.failNext.setDelivery = new Error("crash after recording");
    const worker = () => runAssistantWorker({
      store: h.store,
      answer: (job, context) => answerAssistantJob(job, context, h.deps),
      revalidate: (job, scopeKey) => revalidateAssistantJob(job, h.deps, scopeKey),
      scopeChangedText: ASSISTANT_SCOPE_CHANGED_REPLY,
      delivery: line, pushFallbackEnabled: true, workerId: "w", budgetMs: 10_000, deliveryReserveMs: 2_000,
      temporaryErrorText: BOT_SUMMARY_TEMPORARY_ERROR_REPLY,
    });
    await worker();
    expect(h.store.jobs.get(jobId!)!.answer_text).toContain("40,550.75");
    delete h.policies.Capproved;
    h.store.expireLease(jobId!);
    await worker();
    expect(line.sent).toHaveLength(1);
    expect(line.sent[0]!.text).toBe(ASSISTANT_SCOPE_CHANGED_REPLY);
    expect(h.store.jobs.get(jobId!)!.answer_text).not.toContain("40,550.75");
    expect(h.store.turns.filter((turn) => turn.jobId === jobId)).toHaveLength(0);
  });

  test("narrowing a group policy's markets starts every member's memory afresh", async () => {
    const model = new ScriptedThaiModel();
    const h = harness({ provider: model });
    await h.ask("ทำไมรายการของพี่ปลายังปิดไม่ได้?", { lineUserId: "Uboss" });
    h.policies.Capproved = { ...full("Capproved"), markets: new Set([FIXTURE_MARKETS.WAT]) };
    await h.ask("แล้วของพี่ขวัญล่ะ?", { lineUserId: "Uboss" });
    expect(model.requests.at(-1)!.transcript.filter((item) => item.kind === "message")).toHaveLength(1);
  });

  test("a 1:1 chat is not supported in V1, even for an allowlisted user", async () => {
    const h = harness({ provider: oneTool("get_staff_produce", { staff: "ขวัญ" }) });
    const answer = await h.ask("พี่ขวัญเบิกอะไรไป", { sourceType: "user", sourceId: "Udam", lineUserId: "Udam" });
    expect(answer).toEqual({ text: ASSISTANT_DIRECT_CHAT_REPLY, kind: "notice" });
    expect(h.reads).toHaveLength(0);
  });
});
