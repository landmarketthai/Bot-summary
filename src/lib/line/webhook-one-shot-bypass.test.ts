/**
 * Regression — a pasted complete produce document must not bypass P4A.
 *
 * Production 2026-08-11: operators started sending the whole document in one
 * message. With no pending row to find, the webhook took the legacy direct
 * parser/persist path, which never calls bindPlainTextRound and never runs the
 * entry gate. Twenty sessions persisted with accountability_round_id NULL and
 * answered บันทึกแล้ว ✅ over mismatched product names and units — exactly what
 * P4A exists to refuse.
 *
 * These tests drive the real thing end to end: webhook → pending generation →
 * deferred finalizer → round binding → entry gate. The refusal case is the
 * มิ้น evidence in miniature (withdrawal ปลาหวานแดง 4 แพค, return 4 กล่อง).
 */
import { describe, expect, it } from "bun:test";
import { WebhookService } from "./webhook-service";
import { finalizePendingGeneration } from "./pending-session-finalizer";
import type { PendingSession } from "./pending-session-service";
import type { LineMessageEvent } from "./types";

type Row = Record<string, unknown>;

const ROUND = "22222222-2222-4222-8222-222222222222";
const PRODUCE_CLOSE_PENDING_REPLY =
  "รับจบรายการแล้ว กำลังตรวจสอบรายการที่ยังส่งมาไม่ถึง กรุณารอสักครู่";

const WITHDRAWAL = [
  "มิ้น-ทรัพย์พันธ์2 เบิก 11/8/2569",
  "1.ปลาหวานแดง100บาท",
  "4แพค",
  "จบรายการเบิก",
].join("\n");

const RETURN_WRONG_UNIT = [
  "มิ้น-ทรัพย์พันธ์2 ชั่งคืน 11/8/2569",
  "1.ปลาหวานแดง100บาท",
  "4กล่อง",
  "จบรายการชั่งคืน",
].join("\n");

const RETURN_MATCHING = [
  "มิ้น-ทรัพย์พันธ์2 ชั่งคืน 11/8/2569",
  "1.ปลาหวานแดง100บาท",
  "4แพค",
  "จบรายการชั่งคืน",
].join("\n");

const RETURN_PRICE_MISMATCHES = [
  "ขวัญ-ตลาด72 ชั่งคืน 20/8/2569",
  "1.แตงไทย25บาท",
  "22ลูก",
  "2.ทับทิม35บาท",
  "6ลูก",
  "จบรายการชั่งคืน",
].join("\n");

const RETURN_PRICE_AND_EXCESS = [
  "ขวัญ-ตลาด72 ชั่งคืน 20/8/2569",
  "1.มังคุด50บาท",
  "35.2โล",
  "2.แตงไทย25บาท",
  "22ลูก",
  "จบรายการชั่งคืน",
].join("\n");

/** The round's persisted withdrawal — what a return is validated against. */
const MASTER: Row[] = [{
  accountability_round_id: ROUND,
  product_name: "ปลาหวานแดง",
  unit: "แพค",
  quantity: 4,
  price_per_unit: 100,
  transaction_type: "เบิก",
}];

const PRICE_MASTER: Row[] = [
  {
    accountability_round_id: ROUND,
    product_name: "แตงไทย",
    unit: "ลูก",
    quantity: 28,
    price_per_unit: 20,
    transaction_type: "เบิก",
  },
  {
    accountability_round_id: ROUND,
    product_name: "ทับทิม",
    unit: "ลูก",
    quantity: 15,
    price_per_unit: 20,
    transaction_type: "เบิก",
  },
];

const PRICE_AND_EXCESS_MASTER: Row[] = [
  {
    accountability_round_id: ROUND,
    product_name: "มังคุด",
    unit: "โล",
    quantity: 28.8,
    price_per_unit: 45,
    transaction_type: "เบิก",
  },
  PRICE_MASTER[0]!,
];

class Query {
  private readonly filters: Array<(row: Row) => boolean> = [];

  constructor(
    private readonly db: BypassDatabase,
    private readonly table: string,
    private readonly mode: "select" | "insert" | "upsert" | "update" | "delete",
    private readonly payload?: Row | Row[],
  ) {}

  select = () => this;
  order = () => this;
  limit = () => this;
  not = () => this;
  eq(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value);
    return this;
  }
  is(column: string, value: unknown) {
    return this.eq(column, value);
  }
  lte(column: string, value: unknown) {
    this.filters.push((row) => Number(row[column]) <= Number(value));
    return this;
  }
  async single() {
    const { data } = this.run();
    return { data: Array.isArray(data) ? data[0] ?? null : data, error: null };
  }
  maybeSingle = () => this.single();
  then<T>(resolve: (value: { data: Row[] | Row | null; error: null }) => T) {
    return Promise.resolve(this.run()).then(resolve);
  }

  private run(): { data: Row[] | Row | null; error: null } {
    const rows = this.db.rows(this.table);
    const matched = () => rows.filter((row) => this.filters.every((f) => f(row)));
    if (this.mode === "select") return { data: matched(), error: null };
    if (this.mode === "insert" || this.mode === "upsert") {
      const payloads = Array.isArray(this.payload) ? this.payload : [this.payload ?? {}];
      const mode = this.mode;
      return { data: payloads.map((p) => this.db.write(this.table, p, mode)), error: null };
    }
    if (this.mode === "update") {
      const updated = matched();
      for (const row of updated) Object.assign(row, this.payload);
      return { data: updated, error: null };
    }
    const removed = new Set(matched());
    this.db.replace(this.table, rows.filter((row) => !removed.has(row)));
    return { data: [...removed], error: null };
  }
}

class BypassDatabase {
  private readonly tables = new Map<string, Row[]>();
  /** Every call to the authoritative persistence RPC, in order. */
  finalizeCalls: Row[] = [];

  constructor(master: Row[] = []) {
    this.tables.set("produce_transactions", [...master]);
  }

  rows(table: string): Row[] {
    const existing = this.tables.get(table);
    if (existing) return existing;
    const created: Row[] = [];
    this.tables.set(table, created);
    return created;
  }

  replace(table: string, rows: Row[]): void {
    this.tables.set(table, rows);
  }

  write(table: string, payload: Row, mode: "insert" | "upsert"): Row {
    const rows = this.rows(table);
    if (mode === "upsert" && table === "pending_sessions") {
      const existing = rows.find((row) => row.session_key === payload.session_key);
      if (existing) return Object.assign(existing, payload);
    }
    const row: Row = { ...payload };
    if (table === "raw_messages") row.id = row.id ?? `raw-${rows.length + 1}`;
    if (table === "pending_sessions") {
      row.id = row.id ?? `pending-${rows.length + 1}`;
      row.session_generation = row.session_generation
        ?? "33333333-3333-4333-8333-333333333333";
      row.ingest_revision = row.ingest_revision ?? 0;
    }
    rows.push(row);
    return row;
  }

  get pending(): PendingSession {
    return this.rows("pending_sessions")[0] as unknown as PendingSession;
  }

  from = (table: string) => ({
    select: () => new Query(this, table, "select"),
    insert: (payload: Row | Row[]) => new Query(this, table, "insert", payload),
    upsert: (payload: Row | Row[]) => new Query(this, table, "upsert", payload),
    update: (payload: Row) => new Query(this, table, "update", payload),
    delete: () => new Query(this, table, "delete"),
  });

  rpc = async (name: string, args: Row) => {
    const pending = this.rows("pending_sessions")
      .find((row) => row.session_key === args.p_session_key);

    if (name === "bind_plain_text_accountability_round") {
      return { data: { outcome: "bound", accountability_round_id: ROUND }, error: null };
    }
    if (name === "record_produce_validation_review") {
      // Never confirmed: a review that was only presented must not persist.
      return {
        data: { confirmed: false, presented_line_event_id: args.p_line_event_id },
        error: null,
      };
    }
    if (name === "admit_pending_session_event") {
      if (pending) {
        this.write("pending_session_admission", {
          session_key: pending.session_key,
          session_generation: pending.session_generation,
          line_event_id: args.p_line_event_id,
          line_timestamp_ms: args.p_line_timestamp_ms,
        }, "insert");
      }
      return { data: null, error: null };
    }
    if (name === "register_pending_session_ingest") {
      if (pending) {
        this.write("pending_session_ingest", {
          session_key: pending.session_key,
          session_generation: pending.session_generation,
          line_event_id: args.p_line_event_id,
          line_timestamp_ms: args.p_line_timestamp_ms,
          raw_text: args.p_raw_text,
        }, "insert");
      }
      return { data: null, error: null };
    }
    if (name === "append_pending_session") {
      if (!pending) return { data: { accepted: false, reason: "not_found" }, error: null };
      pending.accumulated_text = `${pending.accumulated_text}\n${args.p_new_text}`;
      pending.latest_reply_token = args.p_reply_token;
      pending.ingest_revision = Number(pending.ingest_revision ?? 0) + 1;
      if (args.p_mark_close) {
        pending.close_event_timestamp_ms = args.p_line_timestamp_ms;
        pending.close_requested_at = new Date().toISOString();
        pending.close_line_event_id = args.p_line_event_id;
        pending.close_session_generation = pending.session_generation;
        pending.next_attempt_at = new Date().toISOString();
        pending.close_deadline_at = new Date(Date.now() + 30_000).toISOString();
      }
      return { data: { accepted: true, reason: "appended", session: pending }, error: null };
    }
    if (name === "try_finalize_pending_generation") {
      this.finalizeCalls.push(args);
      const payload = args.p_session as Row;
      const errors = (payload.validation_errors ?? []) as string[];
      // Mirrors Production: the RPC refuses to persist a document that carries
      // validation errors, so a blocked entry writes no produce rows at all.
      if (errors.length > 0) {
        return { data: { status: "failed_closed", reason: "validation_errors" }, error: null };
      }
      this.write("produce_sessions", {
        ...payload,
        id: `produce-${this.rows("produce_sessions").length + 1}`,
      }, "insert");
      return {
        data: { status: "finalized", session_id: "produce-1", notification_id: "notify-1" },
        error: null,
      };
    }
    throw new Error(`Unexpected RPC: ${name}`);
  };
}

let eventSequence = 0;
function textEvent(text: string): LineMessageEvent {
  eventSequence += 1;
  return {
    type: "message",
    webhookEventId: `one-shot-${eventSequence}`,
    deliveryContext: { isRedelivery: false },
    timestamp: 1_000 * eventSequence,
    source: { type: "group", groupId: "group-1", userId: "user-1" },
    mode: "active",
    replyToken: `reply-${eventSequence}`,
    message: { id: `message-${eventSequence}`, type: "text", text },
  } as unknown as LineMessageEvent;
}

function webhook(db: BypassDatabase, replies: string[]) {
  return new WebhookService(db as never, {
    replyMessage: async (_token, text) => { replies.push(text); },
    replyMessages: async (_token, texts) => { replies.push(texts.join("\n\n")); },
  });
}

/** Paste one complete document into a group with no pending session. */
async function paste(db: BypassDatabase, document: string): Promise<string[]> {
  const replies: string[] = [];
  await webhook(db, replies).processEvents([textEvent(document)], "destination");
  return replies;
}

describe("a pasted complete produce document cannot bypass P4A", () => {
  it.each([
    [RETURN_MATCHING.replace("จบรายการชั่งคืน", "จบรายการเบิก"), "จบรายการชั่งคืน"],
    [RETURN_MATCHING.replace("จบรายการชั่งคืน", "จบรายการอะไรก็ได้"), "จบรายการชั่งคืน"],
  ])("refuses an incompatible complete main document before opening pending", async (
    document,
    expectedCloser,
  ) => {
    const db = new BypassDatabase(MASTER);
    const replies = await paste(db, document);

    expect(replies[0]).toContain(expectedCloser);
    expect(db.rows("pending_sessions")).toHaveLength(0);
    expect(db.finalizeCalls).toHaveLength(0);
    expect(db.rows("produce_sessions")).toHaveLength(0);
  });

  it("rejects a cross-type closer, then finalizes the same return generation once", async () => {
    const db = new BypassDatabase(MASTER);
    const replies: string[] = [];
    const service = webhook(db, replies);
    const returnBody = RETURN_MATCHING.split("\n").slice(0, -1).join("\n");

    await service.processEvents([textEvent(returnBody)], "destination");
    const generation = db.pending.session_generation;
    const originalText = db.pending.accumulated_text;

    await service.processEvents([textEvent("จบรายการเบิก")], "destination");

    expect(replies.at(-1)).toContain("ตอนนี้กำลังบันทึกรายการชั่งคืน");
    expect(replies.at(-1)).toContain("จบรายการชั่งคืน");
    expect(db.pending.session_generation).toBe(generation);
    expect(db.pending.accumulated_text).toBe(originalText);
    expect(db.pending.close_event_timestamp_ms).toBeNull();
    expect(db.rows("produce_sessions")).toHaveLength(0);
    expect(db.rows("produce_transactions")).toHaveLength(MASTER.length);

    await service.processEvents([textEvent("จบรายการชั่งคืน")], "destination");

    expect(db.pending.session_generation).toBe(generation);
    expect(db.pending.accumulated_text).toBe(`${originalText}\nจบรายการชั่งคืน`);
    expect(db.pending.close_event_timestamp_ms).not.toBeNull();
    const result = await finalizePendingGeneration(db as never, db.pending);
    expect(result.status).toBe("finalized");
    expect(db.finalizeCalls).toHaveLength(1);
    expect(db.rows("produce_sessions")).toHaveLength(1);
    expect(db.finalizeCalls[0].p_items).toMatchObject([
      { product_name: "ปลาหวานแดง", quantity: 4, transaction_type: "คืน" },
    ]);
  });

  it("routes through pending generation instead of persisting directly", async () => {
    const db = new BypassDatabase();

    const replies = await paste(db, WITHDRAWAL);

    // The bug: this used to be one produce_sessions row, written by runParser
    // with no round and no gate.
    expect(db.rows("produce_sessions")).toHaveLength(0);
    expect(db.finalizeCalls).toHaveLength(0);

    const pending = db.rows("pending_sessions");
    expect(pending).toHaveLength(1);
    expect(pending[0].close_event_timestamp_ms).not.toBeNull();
    expect(pending[0].accumulated_text).toContain("ปลาหวานแดง");
    expect(replies).toEqual([PRODUCE_CLOSE_PENDING_REPLY]);
  });

  it("binds the round and persists when the document is clean", async () => {
    const db = new BypassDatabase(MASTER);
    await paste(db, RETURN_MATCHING);

    const pushes: string[] = [];
    const result = await finalizePendingGeneration(
      db as never,
      db.pending,
      async (_target, message) => { pushes.push(message); },
    );

    expect(result.status).toBe("finalized");
    expect(db.finalizeCalls).toHaveLength(1);
    const payload = db.finalizeCalls[0].p_session as Row;
    expect(payload.accountability_round_id).toBe(ROUND);
    expect(payload.validation_errors).toEqual([]);
    expect(db.rows("produce_sessions")).toHaveLength(1);
  });

  it("finalizes two price mismatches once, preserves entered prices, and warns in success", async () => {
    const db = new BypassDatabase(PRICE_MASTER);
    const replies = await paste(db, RETURN_PRICE_MISMATCHES);

    expect(replies).toEqual([PRODUCE_CLOSE_PENDING_REPLY]);
    expect(db.rows("produce_entry_validation_reviews")).toHaveLength(0);

    const result = await finalizePendingGeneration(db as never, db.pending);

    expect(result.status).toBe("finalized");
    expect(db.rows("produce_sessions")).toHaveLength(1);
    expect(db.rows("produce_entry_validation_reviews")).toHaveLength(0);

    const call = db.finalizeCalls[0];
    const payload = call.p_session as Row;
    expect(payload.validation_errors).toEqual([]);
    expect(payload.notification_payload).toContain("⚠️ พบ 2 รายการที่ราคาแตกต่างจากตอนเบิก");
    expect(payload.notification_payload).toContain("แตงไทย — เบิก 20 บาท/ลูก → ชั่งคืน 25 บาท/ลูก");
    expect(payload.notification_payload).toContain("ทับทิม — เบิก 20 บาท/ลูก → ชั่งคืน 35 บาท/ลูก");
    expect(payload.notification_payload).toContain("ระบบบันทึกตามราคาที่กรอกไว้แล้ว");

    expect(call.p_items).toMatchObject([
      { product_name: "แตงไทย", quantity: 22, unit: "ลูก", price_per_unit: 25 },
      { product_name: "ทับทิม", quantity: 6, unit: "ลูก", price_per_unit: 35 },
    ]);
  });

  it("finalizes a return above the recorded withdrawal and keeps the price advisory visible", async () => {
    // Calculate first, reconcile later: the withdrawal record may be incomplete.
    const db = new BypassDatabase(PRICE_AND_EXCESS_MASTER);
    await paste(db, RETURN_PRICE_AND_EXCESS);

    const result = await finalizePendingGeneration(db as never, db.pending, async () => {});

    expect(result.status).toBe("finalized");
    expect(db.rows("produce_sessions")).toHaveLength(1);
    const payload = db.finalizeCalls[0].p_session as Row;
    expect(payload.validation_errors).toEqual([]);
    expect(payload.notification_payload).toContain("ราคาแตกต่างจากตอนเบิก");
  });

  it("finalizes a return in a unit the product was not withdrawn in, without asking for a correction", async () => {
    const db = new BypassDatabase(MASTER);
    await paste(db, RETURN_WRONG_UNIT);

    const pushes: string[] = [];
    const result = await finalizePendingGeneration(
      db as never,
      db.pending,
      async (_target, message) => { pushes.push(message); },
    );

    expect(result.status).toBe("finalized");
    expect(db.rows("produce_sessions")).toHaveLength(1);

    const payload = db.finalizeCalls[0].p_session as Row;
    expect(payload.accountability_round_id).toBe(ROUND);
    expect(payload.validation_errors).toEqual([]);
    expect(pushes.join(" ")).not.toContain("แก้ข้อ");
  });
});
