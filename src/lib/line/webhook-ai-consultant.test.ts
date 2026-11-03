/**
 * @Botsummary AI Consultant through the LINE webhook (simulated events).
 *
 * Real WebhookService + real answerBotSummaryForLine; only the edges are fakes:
 * the database (FakeDatabase family, filters really applied for the consultant
 * tables), the LINE reply function, and the OpenAI Responses API, which is a
 * SCRIPT of function_call / message payloads — not a live model.
 */
import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { LineMessageEvent } from "@/lib/line/types";
import { answerBotSummaryForLine, type ConsultantAnswerDependencies } from "@/lib/ai/consultant/answer";
import { claimsSaved } from "@/lib/ai/consultant/answer";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import { buildProducePartialCapture } from "@/lib/produce/partial-capture";
import type { ProduceValidationResult } from "@/lib/produce/entry-validation";
import type { Row } from "@/lib/summary/test-fake-supabase";
import { ReviewDatabase } from "@/lib/white-sheet-reader/test-review-database";
import { PREVIEW_START_REPLY } from "@/lib/white-sheet-reader/reader";
import { BOT_SUMMARY_TEMPORARY_ERROR_REPLY } from "@/lib/ai/line-command";
import { WebhookService } from "./webhook-service";

// ── Database: filters really applied for the consultant tables ──────────────

const STRICT_TABLES = new Set(["pending_sessions", "produce_sessions", "line_operator_identities", "raw_messages"]);

interface QueryLog { table: string; eq: Record<string, unknown>; returned: Row[] }

class StrictQuery implements PromiseLike<{ data: Row[]; error: null }> {
  private predicates: Array<(row: Row) => boolean> = [];
  private orderBy: { column: string; ascending: boolean } | null = null;
  private max: number | null = null;
  private readonly log: QueryLog;

  constructor(private db: ConsultantDb, private table: string) {
    this.log = { table, eq: {}, returned: [] };
    db.queries.push(this.log);
  }

  select() { return this; }
  eq(column: string, value: unknown) { this.log.eq[column] = value; this.predicates.push((row) => row[column] === value); return this; }
  in(column: string, values: unknown[]) { this.predicates.push((row) => values.includes(row[column])); return this; }
  or(expression: string) {
    const parts = expression.split(",").map((part) => {
      const [column, op, ...rest] = part.split(".");
      const value = rest.join(".");
      return op === "eq" ? (row: Row) => row[column!] === value : (row: Row) => row[column!] == null;
    });
    this.predicates.push((row) => parts.some((part) => part(row)));
    return this;
  }
  gte(column: string, value: string) { this.predicates.push((row) => Date.parse(String(row[column])) >= Date.parse(value)); return this; }
  lt(column: string, value: string) { this.predicates.push((row) => Date.parse(String(row[column])) < Date.parse(value)); return this; }
  order(column: string, options: { ascending: boolean }) { this.orderBy = { column, ascending: options.ascending }; return this; }
  limit(count: number) { this.max = count; return this; }
  async maybeSingle() { return { data: this.run()[0] ?? null, error: null }; }
  async single() { return { data: this.run()[0] ?? null, error: null }; }
  then<A, B = never>(
    onfulfilled?: ((value: { data: Row[]; error: null }) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve({ data: this.run(), error: null as null }).then(onfulfilled, onrejected);
  }
  private run(): Row[] {
    let rows = this.db.rows(this.table).filter((row) => this.predicates.every((predicate) => predicate(row)));
    if (this.orderBy) {
      const { column, ascending } = this.orderBy;
      rows = [...rows].sort((a, b) => (Date.parse(String(a[column])) - Date.parse(String(b[column]))) * (ascending ? 1 : -1));
    }
    if (this.max !== null) rows = rows.slice(0, this.max);
    const out = rows.map((row) => structuredClone(row));
    this.log.returned.push(...out);
    return out;
  }
}

class ConsultantDb extends ReviewDatabase {
  queries: QueryLog[] = [];
  duplicateRawInserts = 0;

  override from(table: string) {
    const base = super.from(table);
    const strict = STRICT_TABLES.has(table)
      ? { ...base, select: (() => new StrictQuery(this, table).select()) as unknown as typeof base.select }
      : base;
    if (table !== "raw_messages") return strict;
    return {
      ...strict,
      // Mirrors the unique index on raw_messages.line_event_id (Postgres 23505).
      insert: ((payload: Row) => {
        if (this.rows("raw_messages").some((row) => row.line_event_id === payload.line_event_id)) {
          this.duplicateRawInserts += 1;
          return { select: () => ({ single: async () => ({ data: null, error: { code: "23505", message: "duplicate key" } }) }) };
        }
        const stamp = (payload.payload as { timestamp?: number } | undefined)?.timestamp;
        return base.insert({ ...payload, ...(stamp ? { created_at: new Date(stamp).toISOString() } : {}) });
      }) as unknown as typeof base.insert,
    };
  }

  tablesQueried(): string[] { return [...new Set(this.queries.map((query) => query.table))].sort(); }
  queriesOn(table: string) { return this.queries.filter((query) => query.table === table); }
  /** Reads of the data only the consultant touches (the webhook and White Sheet code read raw_messages themselves). */
  consultantReads(): QueryLog[] {
    return this.queries.filter((query) => query.table !== "raw_messages");
  }
  /** Every table a write touched, other than the webhook ledger itself. */
  businessWrites(): string[] { return this.writes.filter((table) => table !== "raw_messages"); }
}

// ── Scripted OpenAI Responses API ───────────────────────────────────────────

interface RequestBody {
  instructions: string;
  input: Array<Record<string, unknown>>;
  tools?: Array<{ name: string }>;
}
type Payload = Record<string, unknown>;
type Step = Payload | Response | ((body: RequestBody) => Payload | Response);

let seq = 0;
const toolCall = (name: string, args: Record<string, unknown>): Payload => {
  seq += 1;
  return { id: `r${seq}`, status: "completed", output: [{ type: "function_call", call_id: `c${seq}`, name, arguments: JSON.stringify(args), status: "completed" }] };
};
const modelText = (text: string): Payload => ({
  id: "t", status: "completed",
  output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] }],
});
const httpError = (status: number) => new Response("{}", { status });
const outputsIn = (body: RequestBody): Array<Record<string, unknown>> =>
  body.input.filter((item) => item.type === "function_call_output").map((item) => JSON.parse(String(item.output)) as Record<string, unknown>);
const echo: Step = (body) => {
  const last = outputsIn(body).at(-1);
  return modelText(typeof last?.suggestedReply === "string" ? last.suggestedReply : "ไม่มีข้อมูล");
};

class ScriptedModel {
  bodies: RequestBody[] = [];
  constructor(private steps: Step[]) {}
  fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as RequestBody;
    this.bodies.push(body);
    const step = this.steps[this.bodies.length - 1];
    if (step === undefined) throw new Error(`scripted model: no step #${this.bodies.length}`);
    const resolved = typeof step === "function" ? step(body) : step;
    return resolved instanceof Response ? resolved
      : new Response(JSON.stringify(resolved), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  get requestCount() { return this.bodies.length; }
  toolNames(index = 0) { return (this.bodies[index]?.tools ?? []).map((tool) => tool.name); }
  userText(index = 0) { return (this.bodies[index]!.input[0]!.content as Array<{ text: string }>)[0]!.text; }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-10-08T03:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const WORKER_GROUP = "C-worker-group"; // consultant only
const MGMT_GROUP = "C-management-group"; // analyst + consultant
const ELSEWHERE = "C-elsewhere";
const NOI = "U-noi";
const DAENG = "U-daeng";
const SUPERVISOR = "U-supervisor";
const BOT = "Ubot";

const CLEAN: ProduceValidationResult = { status: "clean", blocking: [], reviews: [], advisories: [], reconciliation: [], digest: "" };

function documentText(staff: string, market: string, kind: string, opts: { items: number; broken?: number }) {
  const lines = [`${staff}-${market} ${kind} 7/10/2569`];
  for (let n = 1; n <= opts.items; n += 1) {
    if (n === opts.broken) { lines.push(`${n}.กล้วยน้ำหว้า15บาม`, "8หวี"); continue; }
    lines.push(`${n}.มะม่วง${20 + n}บาท`, "2โล");
  }
  return lines.join("\n");
}
const captureOf = (text: string) =>
  JSON.parse(JSON.stringify(buildProducePartialCapture(parseWeighSession(text, null), CLEAN)));

function pendingRow(overrides: Row & { session_key: string; line_user_id: string }): Row {
  return {
    session_generation: "gen-1", source_id: WORKER_GROUP, created_at: minutesAgo(120), updated_at: minutesAgo(5),
    terminalized: false, finalization_status: "pending", finalization_error: null, finalized_produce_session_id: null,
    close_requested_at: null, close_event_timestamp_ms: null, close_refused_at: null, close_refused_session_generation: null,
    next_attempt_at: null, finalize_hold_until: null, finalize_confirmed_at: null, entry_origin: null, business_date: null,
    staff_label: null, market_label: null, initial_transaction_type: null, declared_transaction_type: null,
    runtime_environment: "production", accountability_round_id: null, ingest_revision: 10, partial_capture: null,
    partial_capture_revision: null, partial_capture_updated_at: null, accumulated_text: "", ...overrides,
  };
}
const keyOf = (user: string, group = WORKER_GROUP) => `group:${group}:user:${user}`;

function incidentRow(overrides: Row = {}): Row {
  const text = documentText("น้อย", "ราชพฤกษ์", "ชั่งคืน", { items: 24, broken: 22 });
  return pendingRow({
    session_key: keyOf(NOI), line_user_id: NOI,
    created_at: "2026-10-07T09:00:00.000Z", updated_at: "2026-10-07T10:05:00.000Z",
    terminalized: true, finalization_status: "failed_closed",
    finalization_error: { reason: "close_refused_unresolved", close_refused_reason: "entry_gate_refusal" },
    close_refused_at: "2026-10-07T09:34:00.000Z", close_refused_session_generation: "gen-1",
    ingest_revision: 25, partial_capture: captureOf(text), partial_capture_revision: 25,
    partial_capture_updated_at: "2026-10-07T09:33:00.000Z", accumulated_text: text, ...overrides,
  });
}

function openDraftRow(user = DAENG, staff = "แดง", market = "วิหาร", overrides: Row = {}): Row {
  const text = documentText(staff, market, "เบิก", { items: 6, broken: 4 });
  return pendingRow({
    session_key: keyOf(user), line_user_id: user, ingest_revision: 7, partial_capture: captureOf(text),
    partial_capture_revision: 7, partial_capture_updated_at: minutesAgo(5), accumulated_text: text, ...overrides,
  });
}

function seedIdentities(db: ConsultantDb) {
  db.rows("line_operator_identities").push(
    { line_user_id: NOI, staff_label: "น้อย", active: true },
    { line_user_id: DAENG, staff_label: "แดง", active: true },
    { line_user_id: SUPERVISOR, staff_label: "หัวหน้า", active: true },
  );
}

// ── Harness ─────────────────────────────────────────────────────────────────

interface Harness {
  db: ConsultantDb;
  service: WebhookService;
  replies: Array<{ token: string; text: string }>;
  asked: string[];
  clock: { now: number };
}

function harness(options: {
  model?: ScriptedModel;
  db?: ConsultantDb;
  analystEnabled?: boolean;
  consultantEnabled?: boolean;
  analystChats?: string[];
  consultantChats?: string[];
  whiteSheetReaderEnabled?: boolean;
  answerer?: boolean;
  deps?: Partial<ConsultantAnswerDependencies>;
}): Harness {
  const db = options.db ?? new ConsultantDb();
  if (db.rows("line_operator_identities").length === 0) seedIdentities(db);
  const model = options.model ?? new ScriptedModel([]);
  const replies: Harness["replies"] = [];
  const asked: string[] = [];
  const clock = { now: NOW };
  const consultantEnabled = options.consultantEnabled ?? true;
  const analystChats = options.analystChats ?? [MGMT_GROUP];
  const consultantChats = options.consultantChats ?? [WORKER_GROUP];
  const client = db.client() as SupabaseClient<Database>;
  const service = new WebhookService(client, {
    botSummaryAnalystEnabled: options.analystEnabled ?? true,
    botSummaryAnalystSourceAllowed: (sourceId) => analystChats.includes(sourceId),
    botSummaryConsultantEnabled: consultantEnabled,
    botSummaryConsultantSourceAllowed: (sourceId) => consultantChats.includes(sourceId),
    whiteSheetReaderEnabled: options.whiteSheetReaderEnabled ?? true,
    ...(options.answerer === false ? {} : {
      botSummaryAnalystAnswerer: (question, ctx) => {
        asked.push(question);
        return answerBotSummaryForLine(client, question, ctx, {
          consultantEnabled,
          openai: { apiKey: "test-key", fetchImpl: model.fetchImpl },
          scopeOptions: {
            allowedSourceIds: new Set([...analystChats, ...consultantChats]),
            supervisorIds: new Set([SUPERVISOR]),
            runtimeEnvironment: "production",
          },
          now: () => clock.now,
          budgetMs: 10 * 365 * 24 * 3600 * 1000,
          ...options.deps,
        });
      },
    }),
    replyMessage: async (token, text) => { replies.push({ token, text }); },
  });
  return { db, service, replies, asked, clock };
}

let eventSeq = 0;
function textEvent(text: string, options: { group?: string; user?: string; id?: string; timestamp?: number; redelivery?: boolean } = {}): LineMessageEvent {
  eventSeq += 1;
  const id = options.id ?? `evt-${eventSeq}`;
  return {
    type: "message",
    webhookEventId: id,
    deliveryContext: { isRedelivery: options.redelivery ?? false },
    timestamp: options.timestamp ?? NOW,
    source: { type: "group", groupId: options.group ?? WORKER_GROUP, userId: options.user ?? DAENG },
    mode: "active",
    replyToken: `reply-${id}`,
    message: { id: `msg-${id}`, type: "text", quoteToken: `q-${id}`, text },
  };
}

function expectNoBusinessWrites(h: Harness) {
  expect(h.db.appendCalls).toBe(0);
  expect(h.db.businessWrites()).toEqual([]);
}

const hasNoEnglish = (message: string) => expect(message).not.toMatch(/[A-Za-z]/);

// ═══════════════════════════════════════════════════════════════════════════

describe("worker chat (consultant only): scenarios end to end", () => {
  test("1 how-to: 'ส่งรายการเบิกต้องพิมพ์ยังไง' → one reply with the real closer; question stripped of @Botsummary", async () => {
    const model = new ScriptedModel([toolCall("get_usage_guide", { topic: "produce_withdrawal" }), echo]);
    const h = harness({ model });
    const result = await h.service.processEvents([textEvent("@Botsummary ส่งรายการเบิกต้องพิมพ์ยังไง")], BOT);
    expect(result[0]).toMatchObject({ status: "saved", parsed: true });
    expect(h.asked).toEqual(["ส่งรายการเบิกต้องพิมพ์ยังไง"]);
    expect(h.replies).toHaveLength(1);
    expect(h.replies[0]!.text).toContain("จบรายการเบิก");
    expect(h.db.rows("raw_messages")[0]?.is_processed).toBe(true);
    expectNoBusinessWrites(h);
  });

  test("7 incident: supervisor asks 'ทำไมรายการชั่งคืนของน้อยยังไม่เข้า' → honest reply, no English, no saved claim", async () => {
    const db = new ConsultantDb();
    db.rows("pending_sessions").push(incidentRow());
    const model = new ScriptedModel([toolCall("get_submission_problem", { staff: "น้อย", item_number: 0 }), echo]);
    const h = harness({ model, db });
    await h.service.processEvents([textEvent("@Botsummary ทำไมรายการชั่งคืนของน้อยยังไม่เข้า", { user: SUPERVISOR })], BOT);
    const reply = h.replies[0]!.text;
    expect(reply).toContain("ยังบันทึกไม่สำเร็จ");
    expect(reply).toContain("ระบบอ่านได้ 23 รายการ");
    expect(reply).toContain("ข้อ 22");
    expect(reply).toContain("รอบเดิมปิดไปแล้ว");
    expect(reply).toContain("ผู้ดูแล");
    expect(reply).not.toContain("บันทึกแล้ว");
    expect(claimsSaved(reply)).toBe(false);
    hasNoEnglish(reply);
    expect(h.db.appendCalls).toBe(0);
    expect(h.db.businessWrites()).toEqual([]);
  });

  test("7 incident, model lies ('บันทึกแล้วครับ') → the webhook reply is the deterministic one", async () => {
    const db = new ConsultantDb();
    db.rows("pending_sessions").push(incidentRow());
    const model = new ScriptedModel([toolCall("get_submission_problem", { staff: "", item_number: 22 }), modelText("บันทึกแล้วครับ")]);
    const h = harness({ model, db });
    await h.service.processEvents([textEvent("@Botsummary ข้อ 22 ทำไมไม่ผ่าน", { user: NOI })], BOT);
    expect(h.replies[0]!.text).not.toBe("บันทึกแล้วครับ");
    expect(h.replies[0]!.text).toContain("ข้อ 22");
  });

  test("8 a worker asking about another worker gets the forbidden reply; the other's rows are never read", async () => {
    const db = new ConsultantDb();
    db.rows("pending_sessions").push(incidentRow(), openDraftRow(DAENG));
    const model = new ScriptedModel([toolCall("get_submission_status", { staff: "น้อย", transaction_kind: "any" }), echo]);
    const h = harness({ model, db });
    await h.service.processEvents([textEvent("@Botsummary รายการของน้อยเข้าหรือยัง", { user: DAENG })], BOT);
    expect(h.replies[0]!.text).toContain("เฉพาะรายการที่คุณส่งเอง");
    expect(db.queriesOn("pending_sessions")).toEqual([]);
    expect(JSON.stringify(model.bodies[1]!.input)).not.toContain("ราชพฤกษ์");
  });

  test("12 three workers in ONE payload: each reply token gets only that worker's own status", async () => {
    const db = new ConsultantDb();
    db.rows("pending_sessions").push(
      incidentRow(),
      openDraftRow(DAENG),
    );
    // Requests of different conversations may interleave, so the script decides per request.
    const interleaved = new ScriptedModel([]);
    interleaved.fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as RequestBody;
      interleaved.bodies.push(body);
      const hasOutput = body.input.some((item) => item.type === "function_call_output");
      const payload = hasOutput ? echo(body) : toolCall("get_submission_status", { staff: "", transaction_kind: "any" });
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as typeof fetch;
    const h = harness({ model: interleaved, db });
    const noi = textEvent("@Botsummary รายการผมเข้าหรือยัง", { user: NOI });
    const daeng = textEvent("@Botsummary รายการผมเข้าหรือยัง", { user: DAENG });
    const newcomer = textEvent("@Botsummary รายการผมเข้าหรือยัง", { user: "U-newcomer" });
    await h.service.processEvents([noi, daeng, newcomer], BOT);

    const byToken = new Map(h.replies.map((reply) => [reply.token, reply.text]));
    expect(byToken.size).toBe(3);
    const noiReply = byToken.get(noi.replyToken)!;
    const daengReply = byToken.get(daeng.replyToken)!;
    const newcomerReply = byToken.get(newcomer.replyToken)!;
    expect(noiReply).toContain("น้อย");
    expect(noiReply).not.toMatch(/แดง|วิหาร/);
    expect(daengReply).toContain("แดง");
    expect(daengReply).not.toMatch(/น้อย|ราชพฤกษ์/);
    expect(newcomerReply).toMatch(/ไม่พบรายการ/);
    expect(newcomerReply).not.toMatch(/น้อย|แดง|ราชพฤกษ์|วิหาร/);
    for (const query of db.queriesOn("pending_sessions")) {
      expect(query.returned.every((row) => row.line_user_id === query.eq.line_user_id)).toBe(true);
    }
  });

  test("13 the same webhookEventId delivered twice → one reply, one conversation, zero business writes", async () => {
    const model = new ScriptedModel([toolCall("get_usage_guide", { topic: "produce_return" }), echo]);
    const h = harness({ model });
    const first = textEvent("@Botsummary ชั่งคืนต้องพิมพ์ยังไง", { id: "evt-dup" });
    const second = { ...first, deliveryContext: { isRedelivery: true } };

    const r1 = await h.service.processEvents([first], BOT);
    const r2 = await h.service.processEvents([second], BOT);
    expect(r1[0]?.status).toBe("saved");
    expect(r2[0]?.status).toBe("duplicate");
    expect(h.replies).toHaveLength(1);
    expect(h.asked).toHaveLength(1);
    expect(model.requestCount).toBe(2); // one conversation = tool call + answer
    expect(h.db.rows("raw_messages")).toHaveLength(1); // the ledger holds the event once
    expect(h.db.rpcCalls.filter((name) => name === "receive_line_webhook_event")).toHaveLength(2); // …but was offered twice
    expect(h.db.appendCalls).toBe(0);
    expect(h.db.businessWrites()).toEqual([]);
    expect(h.db.rpcCalls.filter((name) => !/^(receive|claim|complete)_line_webhook_event$/u.test(name))).toEqual([]);
  });

  test("13b the same duplicate inside ONE payload is also answered once", async () => {
    const model = new ScriptedModel([modelText("ครับ")]);
    const h = harness({ model });
    const event = textEvent("@Botsummary สวัสดี", { id: "evt-twice" });
    await h.service.processEvents([event, { ...event }], BOT);
    expect(h.replies).toHaveLength(1);
    expect(h.asked).toHaveLength(1);
    expect(h.db.rows("raw_messages")).toHaveLength(1);
  });

  test("11 model outage: status question is answered deterministically; unanswerable one gets the temporary-error text", async () => {
    const db = new ConsultantDb();
    db.rows("pending_sessions").push(openDraftRow(DAENG));
    const h = harness({ model: new ScriptedModel([httpError(500)]), db });
    await h.service.processEvents([textEvent("@Botsummary รายการผมเข้าหรือยัง", { user: DAENG })], BOT);
    expect(h.replies[0]!.text).toContain("แก้ข้อ 4");

    const h2 = harness({ model: new ScriptedModel([httpError(500)]), db });
    await h2.service.processEvents([textEvent("@Botsummary ช่วยเล่าเรื่องตลกให้ฟังหน่อย", { user: DAENG })], BOT);
    expect(h2.replies[0]!.text).toBe(BOT_SUMMARY_TEMPORARY_ERROR_REPLY);
    expect(h2.db.appendCalls).toBe(0);
  });

  test("16 follow-up through the webhook: the first QUESTION is context, the answer comes from a fresh read", async () => {
    const db = new ConsultantDb();
    db.rows("pending_sessions").push(openDraftRow(DAENG));
    const first = new ScriptedModel([toolCall("get_submission_status", { staff: "", transaction_kind: "any" }), echo]);
    const h = harness({ model: first, db });
    await h.service.processEvents([textEvent("@Botsummary รายการผมเข้าหรือยัง", { user: DAENG, timestamp: NOW - 120_000 })], BOT);
    expect(h.replies[0]!.text).toContain("แก้ข้อ 4");

    // The worker fixes it; the finalizer saves it.
    Object.assign(db.rows("pending_sessions")[0]!, {
      terminalized: true, finalization_status: "finalized", finalized_produce_session_id: "ps-1", partial_capture: null, updated_at: minutesAgo(0),
    });
    db.rows("produce_sessions").push({
      id: "ps-1", ingest_idempotency_key: `${keyOf(DAENG)}:gen-1`, voided_at: null, replacement_session_id: null,
      total_items: 6, session_date: "2026-10-07", staff_name: "แดง", session_title: "วิหาร",
    });

    const second = new ScriptedModel([toolCall("get_submission_status", { staff: "", transaction_kind: "any" }), echo]);
    const h2 = harness({ model: second, db });
    await h2.service.processEvents([textEvent("@Botsummary แล้วตอนนี้ล่ะ", { user: DAENG, timestamp: NOW })], BOT);
    expect(second.userText()).toContain("รายการผมเข้าหรือยัง"); // previous question travelled as context
    expect(second.userText()).not.toContain("แก้ข้อ 4"); // the previous ANSWER did not
    expect(h2.replies[0]!.text).toContain("บันทึกเรียบร้อยแล้ว 6 รายการ");
  });

  test("follow-up context never mixes users: another worker's earlier question is not in my user turn", async () => {
    const db = new ConsultantDb();
    const noiModel = new ScriptedModel([modelText("ครับ")]);
    const hNoi = harness({ model: noiModel, db });
    await hNoi.service.processEvents([textEvent("@Botsummary ความลับของน้อย", { user: NOI, timestamp: NOW - 60_000 })], BOT);

    const model = new ScriptedModel([modelText("ครับ")]);
    const h = harness({ model, db });
    await h.service.processEvents([textEvent("@Botsummary แล้วตอนนี้ล่ะ", { user: DAENG })], BOT);
    expect(model.userText()).toBe("แล้วตอนนี้ล่ะ");
  });

  test("usage help: bare '@Botsummary' → help text, no model call", async () => {
    const model = new ScriptedModel([]);
    const h = harness({ model });
    await h.service.processEvents([textEvent("@Botsummary")], BOT);
    expect(model.requestCount).toBe(0);
    expect(h.asked).toEqual([]);
    expect(h.replies[0]!.text).toContain("ถาม @Botsummary ได้");
    expect(h.replies[0]!.text).toContain("ชั่งคืนต้องพิมพ์ยังไง");
  });
});

describe("flags and allowlists", () => {
  test("consultant flag OFF + worker chat → 'ยังไม่เปิดใช้งานในแชทนี้', no model call, no reads", async () => {
    const model = new ScriptedModel([]);
    const h = harness({ model, consultantEnabled: false });
    await h.service.processEvents([textEvent("@Botsummary ชั่งคืนต้องพิมพ์ยังไง")], BOT);
    expect(h.replies[0]!.text).toContain("ยังไม่เปิดใช้งานในแชทนี้");
    expect(model.requestCount).toBe(0);
    expect(h.asked).toEqual([]);
    expect(h.db.consultantReads()).toEqual([]);
  });

  test("consultant ON but the chat is on neither allowlist → not available, nothing runs", async () => {
    const model = new ScriptedModel([]);
    const h = harness({ model });
    await h.service.processEvents([textEvent("@Botsummary รายการผมเข้าหรือยัง", { group: ELSEWHERE })], BOT);
    expect(h.replies[0]!.text).toContain("ยังไม่เปิดใช้งานในแชทนี้");
    expect(model.requestCount).toBe(0);
    expect(h.db.consultantReads()).toEqual([]);
  });

  test("analyst flag OFF globally but consultant ON for the worker chat → consultant still works there", async () => {
    const model = new ScriptedModel([toolCall("get_usage_guide", { topic: "item_correction" }), echo]);
    const h = harness({ model, analystEnabled: false });
    await h.service.processEvents([textEvent("@Botsummary แก้ข้อ ต้องพิมพ์ยังไง")], BOT);
    expect(h.replies[0]!.text).toContain("แก้ข้อ");
    expect(model.toolNames()).toEqual(["get_usage_guide", "get_submission_status", "get_unfinished_submissions", "get_submission_problem"]);
  });

  test("worker chat request body offers ONLY the consultant tools; a model attempt at settlement is refused end to end", async () => {
    const model = new ScriptedModel([
      toolCall("get_staff_settlement", { staff: "ดำ" }),
      (body) => modelText(String(outputsIn(body).at(-1)!.error)),
    ]);
    const h = harness({ model });
    await h.service.processEvents([textEvent("@Botsummary ดำวันนี้เงินขาดหรือเกิน")], BOT);
    expect(model.toolNames()).toEqual(["get_usage_guide", "get_submission_status", "get_unfinished_submissions", "get_submission_problem"]);
    expect(h.replies[0]!.text).toBe("tool get_staff_settlement is not available in this chat");
    for (const table of h.db.tablesQueried()) expect(["line_operator_identities", "raw_messages"]).toContain(table);
  });

  test("in the worker chat the white-sheet read command is NOT special: it is just a question for the consultant", async () => {
    const model = new ScriptedModel([modelText("ผมช่วยเรื่องวิธีใช้ได้ครับ")]);
    const h = harness({ model });
    const event = textEvent("@Botsummary อ่านใบขาว", { timestamp: Date.now() - 1000 });
    await h.service.processEvents([event], BOT);
    expect(h.replies.map((reply) => reply.text)).not.toContain(PREVIEW_START_REPLY);
    expect(model.requestCount).toBe(1);
  });
});

describe("management chat (analyst + consultant) keeps its existing behaviour", () => {
  test("15 sales/settlement question: analyst AND consultant tools are offered, the analyst tool really executes", async () => {
    const model = new ScriptedModel([
      toolCall("get_staff_settlement", { staff: "ดำ" }),
      (body) => modelText(`ผล ${JSON.stringify(outputsIn(body).at(-1))}`),
    ]);
    const h = harness({ model });
    await h.service.processEvents([textEvent("@Botsummary ดำวันนี้เงินขาดหรือเกิน", { group: MGMT_GROUP, user: SUPERVISOR })], BOT);
    const names = model.toolNames();
    expect(names).toContain("get_staff_settlement");
    expect(names).toContain("get_daily_summary");
    expect(names).toContain("get_usage_guide");
    expect(names).toContain("get_submission_status");
    const reply = h.replies[0]!.text;
    expect(reply).not.toContain("not available in this chat");
    expect(reply).toContain('"found":false'); // the real read-only settlement tool ran against the fake DB
    expect(h.db.appendCalls).toBe(0);
    expect(h.db.businessWrites()).toEqual([]);
  });

  test("15 flag OFF: the management chat offers exactly the analyst tools (no consultant tools)", async () => {
    const model = new ScriptedModel([modelText("ยอดขายวันนี้ยังไม่มีข้อมูลครับ")]);
    const h = harness({ model, consultantEnabled: false });
    await h.service.processEvents([textEvent("@Botsummary วันนี้ยอดขายเท่าไหร่", { group: MGMT_GROUP, user: SUPERVISOR })], BOT);
    const names = model.toolNames();
    expect(names).toContain("get_daily_summary");
    for (const name of ["get_usage_guide", "get_submission_status", "get_unfinished_submissions", "get_submission_problem"]) {
      expect(names).not.toContain(name);
    }
    expect(model.userText()).toBe("วันนี้ยอดขายเท่าไหร่");
    expect(h.db.consultantReads()).toEqual([]);
  });

  test("15 '@Botsummary อ่านใบขาว' in the management chat starts the white-sheet preview and never reaches the answerer", async () => {
    const model = new ScriptedModel([]);
    const h = harness({ model });
    const event = textEvent("@Botsummary อ่านใบขาว", { group: MGMT_GROUP, user: SUPERVISOR, timestamp: Date.now() - 1000 });
    await h.service.processEvents([event], BOT);
    expect(h.replies.map((reply) => reply.text)).toEqual([PREVIEW_START_REPLY]);
    expect(h.asked).toEqual([]);
    expect(model.requestCount).toBe(0);
    expect(h.db.businessWrites().every((table) => table === "white_sheet_review_turns")).toBe(true);
    expect(h.db.appendCalls).toBe(0);
  });

  test("15 plain analyst question with the consultant ON still goes to the answerer exactly once", async () => {
    const model = new ScriptedModel([modelText("ยอดขายวันนี้ 12,345 บาท")]);
    const h = harness({ model });
    await h.service.processEvents([textEvent("@Botsummary สรุปยอดขายวันนี้", { group: MGMT_GROUP, user: SUPERVISOR })], BOT);
    expect(h.replies.map((reply) => reply.text)).toEqual(["ยอดขายวันนี้ 12,345 บาท"]);
    expect(h.asked).toEqual(["สรุปยอดขายวันนี้"]);
  });
});

describe("14 ordinary (non-@Botsummary) messages are untouched by the consultant", () => {
  const ORDINARY = [
    "น้อย-ราชพฤกษ์ ชั่งคืน 7/10/2569",
    "1.มะม่วง20บาท\n2โล",
    "สวัสดีครับ ชั่งคืนต้องพิมพ์ยังไง",          // looks like a question but is not addressed to the bot
    "ถาม @Botsummary หน่อย รายการเข้าหรือยัง",    // mention in the middle is not a command
    "จบรายการชั่งคืน",
  ];

  test("none of them is routed to the answerer or the model, in a worker chat and in a management chat", async () => {
    for (const group of [WORKER_GROUP, MGMT_GROUP]) {
      const model = new ScriptedModel([]);
      const h = harness({ model });
      for (const text of ORDINARY) {
        await h.service.processEvents([textEvent(text, { group, user: NOI })], BOT);
      }
      expect(h.asked).toEqual([]);
      expect(model.requestCount).toBe(0);
    }
  });

  test("the produce workflow reacts identically with the consultant ON and OFF (same replies, same tables written)", async () => {
    async function run(consultantEnabled: boolean) {
      const h = harness({ model: new ScriptedModel([]), consultantEnabled, answerer: false });
      for (const text of ORDINARY.slice(0, 2)) {
        try {
          await h.service.processEvents([textEvent(text, { user: NOI })], BOT);
        } catch {
          // The unseeded fake may reject deep workflow steps; both runs must fail the same way.
        }
      }
      return {
        replies: h.replies.map((reply) => reply.text),
        writes: [...h.db.writes],
        appendCalls: h.db.appendCalls,
        tables: h.db.tablesQueried(),
      };
    }
    const on = await run(true);
    const off = await run(false);
    expect(on).toEqual(off);
    expect(on.writes.length).toBeGreaterThan(0); // the ordinary message DID enter the normal pipeline (raw_messages ledger at least)
  });

  test("a plain produce header does not open the consultant: no consultant tables are read", async () => {
    const h = harness({ model: new ScriptedModel([]), answerer: false });
    await h.service.processEvents([textEvent("น้อย-ราชพฤกษ์ ชั่งคืน 7/10/2569", { user: NOI })], BOT).catch(() => undefined);
    expect(h.db.queriesOn("line_operator_identities")).toEqual([]);
  });
});
