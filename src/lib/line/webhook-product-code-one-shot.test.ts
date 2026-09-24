/**
 * Product Codes must ride the PR #45 pipeline, not a new one.
 *
 * A complete coded document pasted as one LINE message has to go
 * webhook → pending generation → deferred finalizer → round binding → P4A →
 * persistence, exactly like a document typed in words. Codes are resolved
 * inside the parse, so there is no new ingestion path here at all — these tests
 * exist to prove that stays true, because a code-aware shortcut around the
 * close boundary would silently reopen the bypass PR #45 closed.
 *
 * The harness mirrors webhook-one-shot-bypass.test.ts: a fake Supabase whose
 * finalize RPC refuses to persist a document carrying validation errors, the
 * way Production's does.
 */
import { describe, expect, it } from "bun:test";
import { WebhookService } from "./webhook-service";
import { finalizePendingGeneration } from "./pending-session-finalizer";
import { computeSessionHash } from "./session-dedup-service";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import { PRODUCT_CODE_ENTRIES } from "@/lib/produce/product-code/dictionary";
import type { PendingSession } from "./pending-session-service";
import type { LineMessageEvent } from "./types";

type Row = Record<string, unknown>;

const ROUND = "22222222-2222-4222-8222-222222222222";
const PRODUCE_CLOSE_PENDING_REPLY =
  "รับจบรายการแล้ว กำลังตรวจสอบรายการที่ยังส่งมาไม่ถึง กรุณารอสักครู่";

/** ม01 = กล้วยไข่, ม02 = กล้วยน้ำว้า in the approved dictionary. */
const CODED_WITHDRAWAL = [
  "กี้-ทดสอบ เบิก 13/8/2569",
  "ม01 50 บาท",
  "2 โล",
  "ม02 35 บาท",
  "3 โล",
  "จบรายการเบิก",
].join("\n");

const CODED_RETURN_WRONG_UNIT = [
  "กี้-ทดสอบ ชั่งคืน 13/8/2569",
  "ม01 50 บาท",
  "2 กล่อง",
  "จบรายการชั่งคืน",
].join("\n");

const RETURN_BY_WORD = [
  "กี้-ทดสอบ ชั่งคืน 13/8/2569",
  "กล้วยไข่ 50 บาท",
  "1 โล",
  "จบรายการชั่งคืน",
].join("\n");

const UNKNOWN_CODE_DOCUMENT = [
  "กี้-ทดสอบ เบิก 13/8/2569",
  "ม999 50 บาท",
  "3 โล",
  "จบรายการเบิก",
].join("\n");

/** The round's persisted withdrawal, stored under the canonical product name. */
const MASTER: Row[] = [{
  accountability_round_id: ROUND,
  product_name: "กล้วยไข่",
  unit: "โล",
  quantity: 2,
  price_per_unit: 50,
  transaction_type: "เบิก",
}];

class Query {
  private readonly filters: Array<(row: Row) => boolean> = [];
  private maxRows: number | null = null;

  constructor(
    private readonly db: CodeDatabase,
    private readonly table: string,
    private readonly mode: "select" | "insert" | "upsert" | "update" | "delete",
    private readonly payload?: Row | Row[],
  ) {}

  select = (_columns?: string) => this;
  order = () => this;
  limit = (count: number) => {
    this.maxRows = count;
    return this;
  };
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
    if (this.mode === "select") {
      return { data: matched().slice(0, this.maxRows ?? rows.length), error: null };
    }
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

class CodeDatabase {
  private readonly tables = new Map<string, Row[]>();
  finalizeCalls: Row[] = [];

  constructor(master: Row[] = []) {
    this.tables.set("produce_transactions", [...master]);
    this.tables.set("produce_product_codes", PRODUCT_CODE_ENTRIES.map((entry) => ({
      product_code: entry.code,
      category_code: entry.categoryCode,
      category_name: entry.category,
      canonical_name: entry.canonicalName,
      code_enabled: entry.enabled,
    })));
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
    select: (_columns?: string) => new Query(this, table, "select"),
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
    if (name === "try_finalize_pending_generation") {
      this.finalizeCalls.push(args);
      const payload = args.p_session as Row;
      const errors = (payload.validation_errors ?? []) as string[];
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
    webhookEventId: `coded-${eventSequence}`,
    deliveryContext: { isRedelivery: false },
    timestamp: 1_000 * eventSequence,
    source: { type: "group", groupId: "group-1", userId: "user-1" },
    mode: "active",
    replyToken: `reply-${eventSequence}`,
    message: { id: `message-${eventSequence}`, type: "text", text },
  } as unknown as LineMessageEvent;
}

function webhook(db: CodeDatabase, replies: string[]) {
  return new WebhookService(db as never, {
    replyMessage: async (_token, text) => { replies.push(text); },
    replyMessages: async (_token, texts) => { replies.push(texts.join("\n\n")); },
  });
}

async function paste(db: CodeDatabase, document: string): Promise<string[]> {
  const replies: string[] = [];
  await webhook(db, replies).processEvents([textEvent(document)], "destination");
  return replies;
}

// ── CASE N — the one-shot coded document ────────────────────────────────────

describe("CASE N — a pasted coded document uses the PR #45 pipeline", () => {
  it("opens a pending generation instead of persisting directly", async () => {
    const db = new CodeDatabase();

    const replies = await paste(db, CODED_WITHDRAWAL);

    // Nothing written by the legacy direct parser — this is the PR #45 bypass.
    expect(db.rows("produce_sessions")).toHaveLength(0);
    expect(db.finalizeCalls).toHaveLength(0);

    const pending = db.rows("pending_sessions");
    expect(pending).toHaveLength(1);
    expect(pending[0].close_event_timestamp_ms).not.toBeNull();
    // The ledger keeps what the operator actually typed.
    expect(pending[0].accumulated_text).toContain("ม01");
    expect(replies).toEqual([PRODUCE_CLOSE_PENDING_REPLY]);
  });

  it("binds the round and persists canonical product names", async () => {
    const db = new CodeDatabase();
    await paste(db, CODED_WITHDRAWAL);

    const result = await finalizePendingGeneration(
      db as never, db.pending, async () => {},
    );

    expect(result.status).toBe("finalized");
    expect(db.finalizeCalls).toHaveLength(1);

    const call = db.finalizeCalls[0];
    const payload = call.p_session as Row;
    expect(payload.accountability_round_id).toBe(ROUND);
    expect(payload.validation_errors).toEqual([]);

    // Persisted identity is the readable product, not the code the operator
    // typed — reports keep showing กล้วยไข่, never ม01.
    const items = call.p_items as Row[];
    expect(items.map((i) => i.product_name)).toEqual(["กล้วยไข่", "กล้วยน้ำว้า"]);
    expect(JSON.stringify(items)).not.toContain("ม01");

    // The raw operator text is still preserved alongside it.
    expect(call.p_raw_text).toContain("ม01");
  });

  it("refuses a coded return whose unit was never withdrawn, persisting nothing", async () => {
    const db = new CodeDatabase(MASTER);
    await paste(db, CODED_RETURN_WRONG_UNIT);

    const pushes: string[] = [];
    const result = await finalizePendingGeneration(
      db as never, db.pending, async (_target, message) => { pushes.push(message); },
    );

    expect(result.status).toBe("failed_closed");
    expect(db.rows("produce_sessions")).toHaveLength(0);

    const payload = db.finalizeCalls[0].p_session as Row;
    // The round WAS resolved — P4A is refusing, not the binding.
    expect(payload.accountability_round_id).toBe(ROUND);
    expect(payload.validation_errors).toContain("unit_not_withdrawn");

    const reply = pushes.at(-1) ?? "";
    expect(reply).toContain("รายการอื่นยังอยู่ครบ");
    expect(reply).toContain("ไม่ต้องยกเลิก");
    expect(reply).toContain("ข้อ 1");
    expect(reply).toContain("แก้ข้อ 1");
    expect(reply).not.toContain("ระบบยังไม่ได้บันทึกอะไร");
    expect(reply).not.toContain("ยกเลิกรายการ");
  });

  it("matches a word-typed return against a code-typed withdrawal", async () => {
    const db = new CodeDatabase(MASTER);
    await paste(db, RETURN_BY_WORD);

    const result = await finalizePendingGeneration(
      db as never, db.pending, async () => {},
    );

    expect(result.status).toBe("finalized");
    const payload = db.finalizeCalls[0].p_session as Row;
    expect(payload.validation_errors).toEqual([]);
  });

  it("persists nothing at all for an unregistered code", async () => {
    const db = new CodeDatabase();
    await paste(db, UNKNOWN_CODE_DOCUMENT);

    const pushes: string[] = [];
    const result = await finalizePendingGeneration(
      db as never, db.pending, async (_target, message) => { pushes.push(message); },
    );

    expect(result.status).not.toBe("finalized");
    expect(db.rows("produce_sessions")).toHaveLength(0);
    // No literal product named ม999 reached the persistence call.
    expect(JSON.stringify(db.finalizeCalls)).not.toContain('"ม999"');
  });
});

// ── CASE O — duplicate detection ────────────────────────────────────────────

describe("CASE O — duplicate coded documents", () => {
  it("gives an identical coded document the identical session hash", () => {
    const first = parseWeighSession(CODED_WITHDRAWAL);
    const resent = parseWeighSession(CODED_WITHDRAWAL);

    expect(computeSessionHash(first)).toBe(computeSessionHash(resent));
  });

  it("hashes a coded document as the transaction it represents", () => {
    // The hash is built from parsed items, so the same real transaction typed
    // in codes and in words is one transaction, not two. That is the intended
    // reading: it stops the same sheet being persisted twice because the
    // second operator keyed it differently.
    const coded = parseWeighSession(CODED_WITHDRAWAL);
    const words = parseWeighSession([
      "กี้-ทดสอบ เบิก 13/8/2569",
      "กล้วยไข่ 50 บาท",
      "2 โล",
      "กล้วยน้ำว้า 35 บาท",
      "3 โล",
      "จบรายการเบิก",
    ].join("\n"));

    expect(computeSessionHash(coded)).toBe(computeSessionHash(words));
  });

  it("keeps different documents distinct", () => {
    const a = parseWeighSession(CODED_WITHDRAWAL);
    const b = parseWeighSession(CODED_WITHDRAWAL.replace("2 โล", "4 โล"));

    expect(computeSessionHash(a)).not.toBe(computeSessionHash(b));
  });
});
