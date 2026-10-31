import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { OpenAIAnalystError } from "@/lib/ai/openai-analyst";
import type { AssistantModelProvider, ModelRoundRequest } from "@/lib/ai/model-provider";
import { resolveAnalystBusinessDate } from "@/lib/ai/readonly-analyst";
import { authorizeToolRequest, type AssistantScope, type ScopeResolution } from "./authorization";
import {
  answerAssistantJob,
  ASSISTANT_NO_PERMISSION_REPLY,
  ASSISTANT_UNGROUNDED_REPLY,
  isFollowUpQuestion,
  resolveJobBusinessDate,
  ungroundedNumbers,
} from "./core";
import type { AssistantJob, AssistantJobRequest } from "./job-store";
import { createFixtureDataReader, FIXTURE_MARKETS, FIXTURE_TODAY, FIXTURE_YESTERDAY, type FixtureRead } from "./testing/fixture-data";
import { MemoryAssistantJobStore } from "./testing/memory-job-store";
import { ScriptedThaiModel } from "./testing/scripted-provider";

const SCOPES: Record<string, AssistantScope> = {
  Uboss: { lineUserId: "Uboss", role: "supervisor", staffLabel: null, markets: null, grantSource: "env_supervisor" },
  Udam: { lineUserId: "Udam", role: "staff", staffLabel: "ดำ", markets: new Set([FIXTURE_MARKETS.RATCHAPHRUEK]), grantSource: "grant" },
  Ulek: { lineUserId: "Ulek", role: "staff", staffLabel: "เล็ก", markets: new Set([FIXTURE_MARKETS.PASEO]), grantSource: "grant" },
  Upaseo: { lineUserId: "Upaseo", role: "supervisor", staffLabel: null, markets: new Set([FIXTURE_MARKETS.PASEO]), grantSource: "grant" },
};

const resolveScope = async (lineUserId: string): Promise<ScopeResolution> =>
  SCOPES[lineUserId] ? { ok: true, scope: SCOPES[lineUserId] } : { ok: false, reason: "no_grant" };

let seq = 0;
function harness(provider: AssistantModelProvider = new ScriptedThaiModel()) {
  const store = new MemoryAssistantJobStore();
  const reads: FixtureRead[] = [];
  const deps = {
    supabase: {} as SupabaseClient<Database>,
    store,
    provider,
    resolveScope,
    readData: createFixtureDataReader(reads),
  };
  /** Enqueue + claim + answer + record, like the worker, and return the answer. */
  const ask = async (question: string, overrides: Partial<AssistantJobRequest> = {}) => {
    seq += 1;
    const { jobId } = await store.enqueue({
      lineEventId: `evt-${seq}`, rawMessageId: null, destination: "Ubot", sourceType: "group",
      sourceId: "Cgroup", lineUserId: "Uboss", question, askedBusinessDate: FIXTURE_TODAY,
      eventTimestampMs: 1_793_000_000_000 + seq, replyToken: null, replyTokenExpiresAt: null, ...overrides,
    });
    const [job] = await store.claim("w", { limit: 1, leaseSeconds: 60, maxRunning: 5 });
    expect(job!.id).toBe(jobId!);
    const answer = await answerAssistantJob(job as AssistantJob, { deadlineAt: Date.now() + 10_000, signal: new AbortController().signal }, deps);
    await store.recordAnswer(job!.id, job!.lease_token!, {
      answer: answer.text, kind: answer.kind ?? "answer", turn: answer.turn ?? null, usage: answer.usage ?? null,
    });
    await store.complete(job!.id, job!.lease_token!, "completed");
    return answer;
  };
  return { store, reads, deps, ask, provider };
}

describe("the six target questions, one supervisor conversation", () => {
  test("each question selects the right authorized tool and answers only with tool figures", async () => {
    const h = harness();
    const sales = await h.ask("วันนี้ทุกตลาดขายได้เท่าไหร่?");
    expect(sales.toolNames).toEqual(["get_daily_summary"]);
    expect(sales.text).toContain("40,550.75");
    expect(sales.text).toContain(FIXTURE_MARKETS.PASEO);

    const produce = await h.ask("พี่ดำเบิกอะไรไป แล้วคืนเท่าไหร่?");
    expect(produce.toolNames).toEqual(["get_staff_produce"]);
    expect(produce.text).toContain("เบิก");
    expect(produce.text).toContain("ชั่งคืน");
    expect(produce.text).toContain("มะม่วงน้ำดอกไม้ 6.5");

    const slips = await h.ask("หนูเล็กมีสลิปที่ยังรอตรวจกี่รายการ?");
    expect(slips.toolNames).toEqual(["get_slip_status"]);
    expect(slips.text).toContain("ตรวจมือ 2 รายการ");

    const compare = await h.ask("เมื่อวานตลาดไหนขายดีกว่าวันนี้?");
    expect(compare.toolNames).toEqual(["compare_daily_sales"]);
    const compareRead = h.reads.find((read) => read.request.tool === "compare_daily_sales")!;
    // "เมื่อวาน ... วันนี้" is a comparison anchored at today.
    expect(compareRead.request.businessDate).toBe(FIXTURE_TODAY);
    expect(compare.text).toContain(FIXTURE_YESTERDAY);

    const pending = await h.ask("ทำไมรายการของพี่ปลายังปิดไม่ได้?");
    expect(pending.toolNames).toEqual(["get_pending_items"]);
    expect(pending.text).toContain("ปลา");
    expect(pending.text).toContain(FIXTURE_MARKETS.WAT);

    const followUp = await h.ask("แล้วของพี่ขวัญล่ะ?");
    expect(followUp.toolNames).toEqual(["get_pending_items"]);
    const last = h.reads.at(-1)!;
    expect(last.request).toMatchObject({ tool: "get_pending_items", staff: "ขวัญ", businessDate: FIXTURE_TODAY });
    expect(followUp.text).toContain("ขวัญ");
    expect(followUp.text).toContain(FIXTURE_MARKETS.PASEO);
    expect(followUp.text).not.toContain("ปลา");
  });

  test("the follow-up model round sees this user's previous turn, oldest first", async () => {
    const model = new ScriptedThaiModel();
    const h = harness(model);
    await h.ask("ทำไมรายการของพี่ปลายังปิดไม่ได้?");
    await h.ask("แล้วของพี่ขวัญล่ะ?");
    const followUpRound = model.requests.find((request: ModelRoundRequest) =>
      request.transcript.some((item) => item.kind === "message" && item.text === "แล้วของพี่ขวัญล่ะ?"))!;
    const messages = followUpRound.transcript.filter((item) => item.kind === "message");
    expect(messages.map((item) => (item as { role: string }).role)).toEqual(["user", "assistant", "user"]);
    expect((messages[0] as { text: string }).text).toBe("ทำไมรายการของพี่ปลายังปิดไม่ได้?");
    expect((messages[1] as { text: string }).text).toContain(`[businessDate ${FIXTURE_TODAY}]`);
  });

  test("a follow-up keeps the previous turn's day; a new question uses the asked day", async () => {
    const h = harness();
    await h.ask("เมื่อวานพี่ดำเบิกอะไรไป");
    expect(h.reads.at(-1)!.request.businessDate).toBe(FIXTURE_YESTERDAY);
    await h.ask("แล้วของพี่ขวัญล่ะ?");
    expect(h.reads.at(-1)!.request).toMatchObject({ tool: "get_staff_produce", staff: "ขวัญ", businessDate: FIXTURE_YESTERDAY });
    await h.ask("พี่ปลาเบิกอะไรไป");
    expect(h.reads.at(-1)!.request.businessDate).toBe(FIXTURE_TODAY);
  });
});

describe("conversation memory isolation", () => {
  test("another user in the same group never receives the first user's context", async () => {
    const model = new ScriptedThaiModel();
    const h = harness(model);
    await h.ask("ทำไมรายการของพี่ปลายังปิดไม่ได้?", { lineUserId: "Uboss" });
    const other = await h.ask("แล้วของพี่ขวัญล่ะ?", { lineUserId: "Upaseo" });
    const round = model.requests.at(-1)!;
    expect(round.transcript.filter((item) => item.kind === "message")).toHaveLength(1);
    expect(JSON.stringify(round.transcript)).not.toContain("ปลา");
    expect(other.toolNames).toEqual([]);
  });

  test("the same user in another chat starts without context", async () => {
    const model = new ScriptedThaiModel();
    const h = harness(model);
    await h.ask("ทำไมรายการของพี่ปลายังปิดไม่ได้?", { sourceId: "Cmanagement" });
    await h.ask("แล้วของพี่ขวัญล่ะ?", { sourceId: "Cother" });
    expect(model.requests.at(-1)!.transcript.filter((item) => item.kind === "message")).toHaveLength(1);
  });
});

describe("per-user and per-market authorization (server-side)", () => {
  test("a staff member cannot read another staff member's documents; nothing is queried for them", async () => {
    const h = harness();
    const answer = await h.ask("พี่ขวัญเบิกอะไรไป", { lineUserId: "Udam" });
    expect(answer.text).toContain("ไม่มีสิทธิ์");
    expect(h.reads.some((read) => "staff" in read.request && read.request.staff === "ขวัญ")).toBe(false);
    expect((answer.usage as { deniedToolCalls: string[] }).deniedToolCalls).toEqual(["get_staff_produce:other_staff"]);
  });

  test("a staff member's own question is pinned to their trusted label and markets", async () => {
    const h = harness();
    const answer = await h.ask("พี่ดำเบิกอะไรไป", { lineUserId: "Udam" });
    expect(answer.toolNames).toEqual(["get_staff_produce"]);
    expect(h.reads.at(-1)!.scope.markets).toEqual(new Set([FIXTURE_MARKETS.RATCHAPHRUEK]));
    expect(answer.text).toContain("มะม่วงน้ำดอกไม้ 30");
  });

  test("a staff member's unfiltered pending/slip question only ever reads their own rows", async () => {
    const h = harness();
    await h.ask("วันนี้มีอะไรค้างบ้าง", { lineUserId: "Udam" });
    expect(h.reads.at(-1)!.request).toMatchObject({ tool: "get_pending_items", staff: "ดำ" });
    await h.ask("มีสลิปรอตรวจไหม", { lineUserId: "Ulek" });
    expect(h.reads.at(-1)!.request).toMatchObject({ tool: "get_slip_status", staff: "เล็ก" });
  });

  test("settlement tools are not offered to staff, and a model that calls one anyway is refused", async () => {
    const offered = harness();
    await offered.ask("ดำวันนี้เงินขาดหรือเกิน", { lineUserId: "Udam" });
    const tools = (offered.provider as ScriptedThaiModel).requests[0]!.tools.map((tool) => tool.name);
    expect(tools).not.toContain("get_staff_settlement");
    expect(tools).not.toContain("get_settlement_overview");
    expect(offered.reads).toHaveLength(0);

    const rogue: AssistantModelProvider = {
      name: "rogue", model: "rogue",
      async respond(request) {
        const done = request.transcript.some((item) => item.kind === "tool_result");
        return done
          ? { text: "ok", toolCalls: [], model: "rogue" }
          : { text: "", toolCalls: [{ callId: "c1", name: "get_staff_settlement", arguments: JSON.stringify({ staff: "ดำ" }) }], model: "rogue" };
      },
    };
    const h = harness(rogue);
    await h.ask("ดำวันนี้เงินขาดหรือเกิน", { lineUserId: "Udam" });
    expect(h.reads).toHaveLength(0);
  });

  test("a market outside the requester's grant is refused before any read", async () => {
    const rogue: AssistantModelProvider = {
      name: "rogue", model: "rogue",
      async respond(request) {
        const result = request.transcript.find((item) => item.kind === "tool_result") as { output: string } | undefined;
        return result
          ? { text: result.output, toolCalls: [], model: "rogue" }
          : { text: "", toolCalls: [{ callId: "c1", name: "get_market_stock", arguments: JSON.stringify({ market: "พาซิโอ้ผัก" }) }], model: "rogue" };
      },
    };
    const h = harness(rogue);
    const answer = await h.ask("พาซิโอ้ผักเหลือของเท่าไหร่", { lineUserId: "Udam" });
    expect(h.reads).toHaveLength(0);
    expect(answer.text).toContain("market_not_permitted");
  });

  test("market-scoped requesters see only their markets, totals come from the scoped source", async () => {
    const h = harness();
    const answer = await h.ask("วันนี้ทุกตลาดขายได้เท่าไหร่?", { lineUserId: "Ulek" });
    expect(h.reads.at(-1)!.scope.markets).toEqual(new Set([FIXTURE_MARKETS.PASEO]));
    expect(answer.text).toContain(FIXTURE_MARKETS.PASEO);
    expect(answer.text).not.toContain(FIXTURE_MARKETS.WAT);
    expect(answer.text).not.toContain("40,550.75");
  });

  test("no grant: a notice, and the model is never called", async () => {
    const model = new ScriptedThaiModel();
    const h = harness(model);
    const answer = await h.ask("วันนี้ทุกตลาดขายได้เท่าไหร่?", { lineUserId: "Ustranger" });
    expect(answer).toEqual({ text: ASSISTANT_NO_PERMISSION_REPLY, kind: "notice" });
    expect(model.requests).toHaveLength(0);
  });

  test("a failed grant lookup is a retryable error, never 'no access'", async () => {
    const h = harness();
    h.deps.resolveScope = async () => ({ ok: false, reason: "grant_lookup_failed" });
    await expect(h.ask("วันนี้ขายได้เท่าไหร่")).rejects.toThrow("grant_lookup");
  });

  test("authorizeToolRequest decisions", () => {
    const dam = SCOPES.Udam!;
    expect(authorizeToolRequest(dam, { tool: "get_staff_produce", businessDate: FIXTURE_TODAY, staff: "พี่ดำ" }))
      .toEqual({ ok: true, request: { tool: "get_staff_produce", businessDate: FIXTURE_TODAY, staff: "ดำ" } });
    expect(authorizeToolRequest(dam, { tool: "get_staff_produce", businessDate: FIXTURE_TODAY, staff: "ผม" }).ok).toBe(true);
    expect(authorizeToolRequest(dam, { tool: "get_staff_produce", businessDate: FIXTURE_TODAY, staff: "ขวัญ" }))
      .toEqual({ ok: false, reason: "other_staff" });
    expect(authorizeToolRequest(dam, { tool: "get_settlement_overview", businessDate: FIXTURE_TODAY }))
      .toEqual({ ok: false, reason: "tool_not_permitted" });
    expect(authorizeToolRequest(dam, { tool: "get_market_summary", businessDate: FIXTURE_TODAY, market: "วัดตะกล่ำ" }))
      .toEqual({ ok: false, reason: "market_not_permitted" });
    expect(authorizeToolRequest(SCOPES.Upaseo!, { tool: "get_staff_settlement", businessDate: FIXTURE_TODAY, staff: "ขวัญ" }).ok).toBe(true);
  });
});

describe("financial answer grounding", () => {
  test("an answer with a figure no tool returned is withheld", async () => {
    const model = new ScriptedThaiModel();
    model.answerOverride = "วันนี้ยอดขายรวม 41,000.00 บาทครับ";
    const h = harness(model);
    const answer = await h.ask("วันนี้ทุกตลาดขายได้เท่าไหร่?");
    expect(answer.text).toBe(ASSISTANT_UNGROUNDED_REPLY);
    expect(answer.kind).toBe("notice");
    expect(answer.turn).toBeUndefined();
    // A withheld answer is not remembered either (kind notice).
  });

  test("grounding rules", () => {
    const outputs = [JSON.stringify({ total: { confirmedSalesBaht: 40550.75 }, cashDifferenceBaht: -120, rows: 3 })];
    expect(ungroundedNumbers("ยอดรวม 40,550.75 บาท", outputs)).toEqual([]);
    expect(ungroundedNumbers("เงินขาด 120.00 บาท", outputs)).toEqual([]);
    expect(ungroundedNumbers("รอตรวจ 3 รายการ วันที่ 31 ต.ค. 2569", outputs)).toEqual([]);
    expect(ungroundedNumbers("ขายดีกว่า 1,250.25 บาท", outputs)).toEqual([1250.25]);
    expect(ungroundedNumbers("ยอด ๔๐,๕๕๐.๗๕ บาท", outputs)).toEqual([]);
    expect(ungroundedNumbers("รวม 500 บาท", [...outputs, "สรุป 500 บาท"])).toEqual([]);
  });
});

describe("token accounting and provider failures", () => {
  test("usage covers every model round and names the provider", async () => {
    const h = harness();
    const answer = await h.ask("วันนี้ทุกตลาดขายได้เท่าไหร่?");
    const usage = answer.usage as Record<string, unknown>;
    expect(usage).toMatchObject({ provider: "scripted-thai-test-model", model: "scripted-thai-v1", modelCalls: 2, usageComplete: true });
    expect(usage.inputTokens as number).toBeGreaterThan(0);
    expect(usage.outputTokens as number).toBeGreaterThan(0);
  });

  test("a provider failure propagates as a typed, classifiable error", async () => {
    const model = new ScriptedThaiModel();
    model.failures = [new OpenAIAnalystError("OpenAI analyst request failed: HTTP 429", "http", 429)];
    const h = harness(model);
    await expect(h.ask("วันนี้ทุกตลาดขายได้เท่าไหร่?")).rejects.toBeInstanceOf(OpenAIAnalystError);
  });
});

describe("business-date rules", () => {
  test("explicit days resolve against the asked day, not the processing day", () => {
    expect(resolveJobBusinessDate("วันนี้ขายได้เท่าไหร่", "2026-10-30", [])).toBe("2026-10-30");
    expect(resolveJobBusinessDate("เมื่อวานขายได้เท่าไหร่", "2026-10-30", [])).toBe("2026-10-29");
    expect(resolveJobBusinessDate("เมื่อวานซืนขายได้เท่าไหร่", "2026-10-30", [])).toBe("2026-10-28");
    expect(resolveJobBusinessDate("เมื่อวานตลาดไหนขายดีกว่าวันนี้?", "2026-10-30", [])).toBe("2026-10-30");
    expect(resolveJobBusinessDate("สรุป 5/10/69", "2026-10-30", [])).toBe("2026-10-05");
    expect(resolveJobBusinessDate("ยอด 1 พฤศจิกายน", "2026-10-30", [])).toBe("2026-11-01");
  });

  test("only a follow-up inherits the previous turn's day", () => {
    const turns = [{ question: "เมื่อวานดำเบิกอะไร", answer: "...", businessDate: "2026-10-29", context: {}, eventTimestampMs: 1 }];
    expect(resolveJobBusinessDate("แล้วของพี่ขวัญล่ะ?", "2026-10-30", turns)).toBe("2026-10-29");
    expect(resolveJobBusinessDate("ส่วนพี่ปลาล่ะครับ", "2026-10-30", turns)).toBe("2026-10-29");
    expect(resolveJobBusinessDate("พี่ปลาเบิกอะไรไป", "2026-10-30", turns)).toBe("2026-10-30");
    expect(resolveJobBusinessDate("แล้ววันนี้ล่ะ", "2026-10-30", turns)).toBe("2026-10-30");
    expect(isFollowUpQuestion("แล้วของพี่ขวัญล่ะ?")).toBe(true);
    expect(isFollowUpQuestion("วันนี้ทุกตลาดขายได้เท่าไหร่?")).toBe(false);
  });

  test("the legacy resolver keeps its documented behaviour", () => {
    expect(resolveAnalystBusinessDate("เมื่อวานยอดขายเท่าไหร่", "2026-10-07")).toBe("2026-10-06");
    expect(resolveAnalystBusinessDate("วันนี้ยอดขายเท่าไหร่", "2026-10-07")).toBe("2026-10-07");
  });
});
