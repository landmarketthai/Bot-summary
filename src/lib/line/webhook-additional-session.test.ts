import { describe, expect, it } from "bun:test";
import { WebhookService, parseExpectedItemCount } from "./webhook-service";
import type { LineMessageEvent } from "./types";

// Minimal in-memory supabase double (same shape as webhook-pending-boundary.test.ts).
type Row = Record<string, unknown>;
type QueryMode = "select" | "insert" | "update" | "delete" | "upsert";

class MemoryQuery {
  private filters: Array<(row: Row) => boolean> = [];
  private returning = false;

  constructor(
    private readonly db: MemoryDatabase,
    private readonly table: string,
    private readonly mode: QueryMode,
    private readonly payload?: Row | Row[],
  ) {}

  select(): this { this.returning = true; return this; }
  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value);
    return this;
  }
  in(column: string, values: unknown[]): this {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }
  order(): this { return this; }
  limit(): this { return this; }

  async single() {
    const result = this.execute();
    return {
      data: Array.isArray(result.data) ? result.data[0] ?? null : result.data,
      error: null,
    };
  }
  async maybeSingle() { return this.single(); }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: { data: Row[] | Row | null; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }

  private execute(): { data: Row[] | Row | null; error: null } {
    const rows = this.db.rows(this.table);
    const matches = () => rows.filter((row) => this.filters.every((f) => f(row)));

    if (this.mode === "select") return { data: matches(), error: null };
    if (this.mode === "insert" || this.mode === "upsert") {
      const payloads = Array.isArray(this.payload) ? this.payload : [this.payload ?? {}];
      const inserted = payloads.map((p) => this.db.insert(this.table, p, this.mode));
      return { data: this.returning ? inserted : null, error: null };
    }
    if (this.mode === "update") {
      const updated = matches();
      for (const row of updated) Object.assign(row, this.payload);
      return { data: this.returning ? updated : null, error: null };
    }
    const removed = matches();
    this.db.remove(this.table, new Set(removed));
    return { data: this.returning ? removed : null, error: null };
  }
}

class MemoryDatabase {
  private readonly tables = new Map<string, Row[]>();
  generationSequence = 0;

  rows(table: string): Row[] {
    const existing = this.tables.get(table);
    if (existing) return existing;
    const created: Row[] = [];
    this.tables.set(table, created);
    return created;
  }

  insert(table: string, payload: Row, mode: QueryMode): Row {
    const rows = this.rows(table);
    if (mode === "upsert" && table === "pending_sessions") {
      const existing = rows.find((row) => row.session_key === payload.session_key);
      if (existing) {
        Object.assign(existing, payload);
        return existing;
      }
    }
    const row = { ...payload };
    if (table === "raw_messages") {
      row.id = row.id ?? `raw-${rows.length + 1}`;
      row.created_at = row.created_at ?? new Date().toISOString();
    }
    if (table === "pending_sessions") {
      row.id = row.id ?? `pending-${rows.length + 1}`;
      row.session_generation = row.session_generation
        ?? `00000000-0000-4000-8000-${String(++this.generationSequence).padStart(12, "0")}`;
    }
    rows.push(row);
    return row;
  }

  remove(table: string, removed: Set<Row>): void {
    this.tables.set(table, this.rows(table).filter((row) => !removed.has(row)));
  }

  from = (table: string) => ({
    select: () => new MemoryQuery(this, table, "select"),
    insert: (payload: Row | Row[]) => new MemoryQuery(this, table, "insert", payload),
    upsert: (payload: Row | Row[]) => new MemoryQuery(this, table, "upsert", payload),
    update: (payload: Row) => new MemoryQuery(this, table, "update", payload),
    delete: () => new MemoryQuery(this, table, "delete"),
  });

  rpc = async (name: string, args?: Row) => {
    if (name === "receive_line_webhook_event") {
      const row = this.insert("raw_messages", {
        line_event_id: args?.p_line_event_id,
        source_id: args?.p_source_id,
        raw_text: args?.p_raw_text,
      }, "insert");
      return { data: { raw_message_id: row.id, duplicate: false }, error: null };
    }
    throw new Error(`unexpected rpc: ${name}`);
  };
}

let eventSequence = 0;
function textEvent(text: string, timestamp: number, replyToken?: string): LineMessageEvent {
  eventSequence += 1;
  return {
    type: "message",
    webhookEventId: `additional-event-${eventSequence}`,
    deliveryContext: { isRedelivery: false },
    timestamp,
    source: { type: "group", groupId: "group-1", userId: "user-1" },
    mode: "active",
    replyToken,
    message: { id: `additional-message-${eventSequence}`, type: "text", text },
  } as LineMessageEvent;
}

function service(db: MemoryDatabase, replies: string[] = []) {
  return new WebhookService(db as never, {
    replyMessage: async (_token, text) => { replies.push(text); },
  });
}

const COMPLETE_ADDITIONAL_BLOCK = [
  "กี้-คลองเตย เบิกเพิ่ม 12/7/2569",
  "1.ทุเรียน100บาท",
  "2โล",
  "จบรายการเบิกเพิ่ม 1 รายการ",
].join("\n");

describe("additional produce batches never take the direct persist path", () => {
  it("routes a pasted complete additional block through the pending generation", async () => {
    const db = new MemoryDatabase();
    const replies: string[] = [];

    const [result] = await service(db, replies).processEvents(
      [textEvent(COMPLETE_ADDITIONAL_BLOCK, 1_000, "reply-1")],
      "destination",
    );

    // No direct produce writes in the webhook request.
    expect(result.status).toBe("saved");
    expect(db.rows("produce_sessions")).toHaveLength(0);
    expect(db.rows("produce_items")).toHaveLength(0);
    expect(db.rows("imported_sessions")).toHaveLength(0);

    // The pending generation is closed and armed for the deferred finalizer.
    const [pending] = db.rows("pending_sessions");
    expect(pending.accumulated_text).toBe(COMPLETE_ADDITIONAL_BLOCK);
    expect(pending.close_event_timestamp_ms).toBe(1_000);
    expect(pending.expected_item_count).toBe(1);
    expect(pending.next_attempt_at).not.toBeNull();
    expect(pending.close_session_generation).toBe(pending.session_generation);

    // The event is registered in both generation ledgers.
    expect(db.rows("pending_session_ingest")).toHaveLength(1);
    expect(db.rows("pending_session_admission")).toHaveLength(1);
    expect(db.rows("pending_session_ingest")[0].session_generation)
      .toBe(pending.session_generation);

    // Close is acknowledged; the real summary comes from the outbox later.
    expect(replies.at(-1)).toContain("รับจบรายการแล้ว");
  });

  it("accumulates a multi-message additional batch and defers the close", async () => {
    const db = new MemoryDatabase();
    const webhook = service(db);

    // Header alone opens a pending generation (no close yet).
    await webhook.processEvents(
      [textEvent("กี้-คลองเตย ชั่งคืนเพิ่ม 12/7/2569", 1_000)],
      "destination",
    );
    const [pending] = db.rows("pending_sessions");
    expect(pending.close_event_timestamp_ms ?? null).toBeNull();
    expect(db.rows("produce_sessions")).toHaveLength(0);
  });

  it("parses expected counts from additional closers", () => {
    expect(parseExpectedItemCount("จบรายการเบิกเพิ่ม 3 รายการ")).toBe(3);
    expect(parseExpectedItemCount("จบรายการชั่งคืนเพิ่ม 12 รายการ")).toBe(12);
    expect(parseExpectedItemCount("จบรายการคืนเสียเพิ่ม")).toBeNull();
    // Legacy form unchanged.
    expect(parseExpectedItemCount("จบรายการ 18 รายการ")).toBe(18);
  });
});
