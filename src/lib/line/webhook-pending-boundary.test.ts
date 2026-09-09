import { describe, expect, it } from "bun:test";
import { PendingSessionService, type PendingSession } from "./pending-session-service";
import {
  WebhookService,
  requiresFreshPendingGeneration,
} from "./webhook-service";
import type { LineMessageEvent } from "./types";
import { REMAINING_STOCK_REPORT_TITLE } from "@/lib/summary/remaining-fruit";
import { isPhysicalInventoryLineGroupAllowed } from "@/lib/physical-inventory/config";

type Row = Record<string, unknown>;
type QueryMode = "select" | "insert" | "update" | "delete" | "upsert";

class MemoryQuery {
  private filters: Array<(row: Row) => boolean> = [];
  private maxRows: number | null = null;
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  private returning = false;

  constructor(
    private readonly db: BoundaryDatabase,
    private readonly table: string,
    private readonly mode: QueryMode,
    private readonly payload?: Row | Row[],
  ) {}

  select(): this {
    this.returning = true;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  is(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  not(column: string, operator: string, value: unknown): this {
    if (operator === "is") {
      this.filters.push((row) => row[column] !== value);
      return this;
    }
    this.filters.push((row) => row[column] !== value);
    return this;
  }

  gte(column: string, value: unknown): this {
    this.filters.push((row) => String(row[column]) >= String(value));
    return this;
  }

  lt(column: string, value: unknown): this {
    this.filters.push((row) => String(row[column]) < String(value));
    return this;
  }

  lte(column: string, value: unknown): this {
    this.filters.push((row) => Number(row[column]) <= Number(value));
    return this;
  }

  in(column: string, values: unknown[]): this {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }

  order(): this {
    return this;
  }

  limit(count: number): this {
    this.maxRows = count;
    return this;
  }

  range(from: number, to: number): this {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }

  async single() {
    const result = this.execute();
    return {
      data: Array.isArray(result.data) ? result.data[0] ?? null : result.data,
      error: result.error,
    };
  }

  async maybeSingle() {
    return this.single();
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: {
      data: Row[] | Row | null;
      error: null;
      count: number | null;
    }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }

  private execute(): { data: Row[] | Row | null; error: null; count: number | null } {
    const rows = this.db.rows(this.table);
    const matches = () => rows.filter((row) => this.filters.every((filter) => filter(row)));

    if (this.mode === "select") {
      const matched = matches();
      let selected = matched;
      if (this.rangeFrom !== null && this.rangeTo !== null) {
        selected = matched.slice(this.rangeFrom, this.rangeTo + 1);
      }
      if (this.maxRows !== null) {
        selected = selected.slice(0, this.maxRows);
      }
      return { data: selected, error: null, count: matched.length };
    }

    if (this.mode === "insert" || this.mode === "upsert") {
      const payloads = Array.isArray(this.payload) ? this.payload : [this.payload ?? {}];
      const inserted = payloads.map((payload) => this.db.insert(this.table, payload, this.mode));
      return { data: this.returning ? inserted : null, error: null, count: null };
    }

    if (this.mode === "update") {
      const updated = matches();
      for (const row of updated) Object.assign(row, this.payload);
      return { data: this.returning ? updated : null, error: null, count: null };
    }

    const removed = matches();
    this.db.remove(this.table, new Set(removed));
    return { data: this.returning ? removed : null, error: null, count: null };
  }
}

class BoundaryDatabase {
  private readonly tables = new Map<string, Row[]>();
  appendCalls = 0;
  generationSequence = 0;

  constructor(pending?: PendingSession) {
    if (pending) this.tables.set("pending_sessions", [pending as unknown as Row]);
  }

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
      row.session_generation =
        row.session_generation ?? `00000000-0000-4000-8000-${String(++this.generationSequence).padStart(12, "0")}`;
      row.created_at = row.created_at ?? new Date().toISOString();
      row.updated_at = row.updated_at ?? new Date().toISOString();
      row.close_event_timestamp_ms = row.close_event_timestamp_ms ?? null;
      row.close_requested_at = row.close_requested_at ?? null;
      row.close_line_event_id = row.close_line_event_id ?? null;
      row.close_finalize_started_at = row.close_finalize_started_at ?? null;
      row.terminalized = row.terminalized ?? false;
      row.next_attempt_at = row.next_attempt_at ?? null;
      row.close_deadline_at = row.close_deadline_at ?? null;
      row.close_session_generation = row.close_session_generation ?? null;
      row.expected_item_count = row.expected_item_count ?? null;
      row.ingest_revision = row.ingest_revision ?? 0;
    }
    if (table === "produce_sessions") row.id = row.id ?? `produce-${rows.length + 1}`;
    if (table === "digital_white_sheet_cash_entries") {
      row.id = row.id ?? `cash-${rows.length + 1}`;
      row.created_at = row.created_at ?? new Date().toISOString();
      row.updated_at = row.updated_at ?? new Date().toISOString();
      row.finalized_at = row.finalized_at ?? null;
      row.finalized_by = row.finalized_by ?? null;
      row.other_note = row.other_note ?? null;
    }
    rows.push(row);
    return row;
  }

  remove(table: string, removed: Set<Row>): void {
    this.tables.set(
      table,
      this.rows(table).filter((row) => !removed.has(row)),
    );
  }

  from = (table: string) => ({
    select: () => new MemoryQuery(this, table, "select"),
    insert: (payload: Row | Row[]) => new MemoryQuery(this, table, "insert", payload),
    upsert: (payload: Row | Row[]) => new MemoryQuery(this, table, "upsert", payload),
    update: (payload: Row) => new MemoryQuery(this, table, "update", payload),
    delete: () => new MemoryQuery(this, table, "delete"),
  });

  rpc = async (name: string, args: Row) => {
    const pending = this.rows("pending_sessions")
      .find((row) => row.session_key === args.p_session_key);

    // No accountability_rounds in this double: the honest answer is that the
    // document has no round to join, which is legacy-unbound behaviour.
    if (name === "bind_plain_text_accountability_round") {
      return { data: { outcome: "no_round" }, error: null };
    }

    if (name === "admit_pending_session_event") {
      if (pending) {
        this.insert("pending_session_admission", {
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
        this.insert("pending_session_ingest", {
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
      this.appendCalls += 1;
      if (!pending) {
        return { data: { accepted: false, reason: "not_found" }, error: null };
      }
      if (pending.terminalized) {
        return { data: { accepted: false, reason: "terminalized", session: pending }, error: null };
      }
      if (
        args.p_expected_session_generation != null
        && pending.session_generation !== args.p_expected_session_generation
      ) {
        return { data: { accepted: false, reason: "generation_conflict" }, error: null };
      }
      const isDuplicate = args.p_line_event_id != null
        && (
          this.rows("pending_session_admission").some((row) =>
            row.session_generation === pending.session_generation
            && row.line_event_id === args.p_line_event_id
          )
          || this.rows("pending_session_ingest").some((row) =>
            row.session_generation === pending.session_generation
            && row.line_event_id === args.p_line_event_id
          )
        );
      if (isDuplicate) {
        return {
          data: { accepted: true, reason: "duplicate_event", session: pending },
          error: null,
        };
      }
      if (pending.close_event_timestamp_ms != null && args.p_mark_close) {
        return {
          data: { accepted: true, reason: "close_already_requested", session: pending },
          error: null,
        };
      }
      if (
        pending.close_event_timestamp_ms != null
        && !args.p_mark_close
        && Number(args.p_line_timestamp_ms) > Number(pending.close_event_timestamp_ms)
      ) {
        return {
          data: { accepted: false, reason: "after_close_boundary", session: pending },
          error: null,
        };
      }
      this.insert("pending_session_admission", {
        session_key: pending.session_key,
        session_generation: pending.session_generation,
        line_event_id: args.p_line_event_id,
        line_timestamp_ms: args.p_line_timestamp_ms,
      }, "insert");
      this.insert("pending_session_ingest", {
        session_key: pending.session_key,
        session_generation: pending.session_generation,
        line_event_id: args.p_line_event_id,
        line_timestamp_ms: args.p_line_timestamp_ms,
        raw_text: args.p_new_text,
      }, "insert");
      pending.accumulated_text = `${pending.accumulated_text}\n${args.p_new_text}`;
      pending.latest_reply_token = args.p_reply_token;
      pending.ingest_revision = Number(pending.ingest_revision ?? 0) + 1;
      if (args.p_mark_close) {
        pending.close_event_timestamp_ms = args.p_line_timestamp_ms;
        pending.close_requested_at = new Date().toISOString();
        pending.close_line_event_id = args.p_line_event_id;
        pending.close_session_generation = pending.session_generation;
        pending.close_deadline_at = new Date(Date.now() + 30_000).toISOString();
        pending.next_attempt_at = new Date(Date.now() + 8_000).toISOString();
        pending.expected_item_count = args.p_expected_item_count;
      } else if (pending.close_event_timestamp_ms != null) {
        pending.next_attempt_at = new Date(Date.now() + 8_000).toISOString();
      }
      return { data: { accepted: true, reason: "appended", session: pending }, error: null };
    }

    if (name === "claim_pending_close_finalize") {
      if (!pending) return { data: { claimed: false, reason: "gone" }, error: null };
      pending.close_finalize_started_at = new Date().toISOString();
      return {
        data: {
          claimed: true,
          session: { ...pending },
          admission_count: this.rows("pending_session_admission").length,
          ingest_count: this.rows("pending_session_ingest").length,
        },
        error: null,
      };
    }

    throw new Error(`Unexpected RPC: ${name}`);
  };
}

const SESSION_KEY = "group:group-1:user:user-1";

function pendingSession(accumulatedText: string, generation = "11111111-1111-4111-8111-111111111111"): PendingSession {
  const now = new Date().toISOString();
  return {
    id: "pending-1",
    session_key: SESSION_KEY,
    source_id: "group-1",
    session_generation: generation,
    accumulated_text: accumulatedText,
    latest_reply_token: null,
    line_user_id: "user-1",
    created_at: now,
    updated_at: now,
    close_event_timestamp_ms: null,
    close_requested_at: null,
    close_line_event_id: null,
    close_finalize_started_at: null,
    terminalized: false,
    next_attempt_at: null,
    close_deadline_at: null,
    close_session_generation: null,
    expected_item_count: null,
    ingest_revision: 0,
  };
}

function staleTerminalizedPendingSession(accumulatedText: string): PendingSession {
  return {
    ...pendingSession(accumulatedText),
    updated_at: "2026-07-10T08:00:00.000Z",
    terminalized: true,
  };
}

let eventSequence = 0;
function textEvent(
  text: string,
  timestamp: number,
  replyToken?: string,
  eventId?: string,
): LineMessageEvent {
  eventSequence += 1;
  return {
    type: "message",
    webhookEventId: eventId ?? `boundary-event-${eventSequence}`,
    deliveryContext: { isRedelivery: false },
    timestamp,
    source: { type: "group", groupId: "group-1", userId: "user-1" },
    mode: "active",
    replyToken,
    message: { id: `boundary-message-${eventSequence}`, type: "text", text },
  } as LineMessageEvent;
}

function service(db: BoundaryDatabase, replies: string[] = []) {
  return new WebhookService(db as never, {
    replyMessage: async (_token, text) => { replies.push(text); },
    replyMessages: async (_token, texts) => { replies.push(texts.join("\n\n")); },
  });
}

describe("produce pending-session generation boundary", () => {
  it("does not append a new header to stale text that already contains SESSION_END", async () => {
    const oldText = [
      "โอม-พาซิโอ้ผลไม้ คืนเสีย 29/06/2569",
      "1.ทุเรียน100บาท",
      "1โล",
      "จบรายการคืนเสีย",
    ].join("\n");
    const oldGeneration = "11111111-1111-4111-8111-111111111111";
    const db = new BoundaryDatabase(pendingSession(oldText, oldGeneration));
    const newHeader = "โอม-พาซิโอ้ผลไม้ เบิก 30/06/2569";

    await service(db).processEvents([textEvent(newHeader, 2_000)], "destination");

    const [current] = db.rows("pending_sessions");
    expect(current.accumulated_text).toBe(newHeader);
    expect(current.accumulated_text).not.toContain("29/06/2569");
    expect(current.session_generation).not.toBe(oldGeneration);
    expect(db.appendCalls).toBe(0);
    expect(db.rows("pending_session_ingest")[0].session_generation)
      .toBe(current.session_generation);
  });

  it("rotates generation when an old คืนเสีย session is followed by a เบิก header", async () => {
    const oldHeader = "โอม-พาซิโอ้ผลไม้ คืนเสีย 29/06/2569";
    const oldGeneration = "22222222-2222-4222-8222-222222222222";
    const db = new BoundaryDatabase(pendingSession(`${oldHeader}\n1.ทุเรียน100บาท\n1โล`, oldGeneration));
    const newHeader = "โอม-พาซิโอ้ผลไม้ เบิก 30/06/2569";

    expect(requiresFreshPendingGeneration(oldHeader, newHeader)).toBe(true);
    await service(db).processEvents([textEvent(newHeader, 3_000)], "destination");

    const [current] = db.rows("pending_sessions");
    expect(current.session_generation).not.toBe(oldGeneration);
    expect(current.accumulated_text).toBe(newHeader);
    expect(db.appendCalls).toBe(0);
  });

  it("rotates the same full header after a current-generation close refusal", async () => {
    const header = "พี่ปลา-โรงถ่าน คืนเสีย 8/9/2569";
    const oldGeneration = "44444444-4444-4444-8444-444444444444";
    const staleText = [
      header,
      "7.องุ่นแดง70บาท",
      "0.2โล",
      "1.สับปะรด50บาท",
      "5ถุง",
      "2.ลูกไหนดำ60บาท",
      "0.9โล",
    ].join("\n");
    const refused = pendingSession(staleText, oldGeneration);
    refused.close_refused_at = "2026-09-09T11:13:52.553Z";
    refused.close_refused_session_generation = oldGeneration;
    const db = new BoundaryDatabase(refused);

    await service(db).processEvents([textEvent(header, 4_000)], "destination");

    const [rotated] = db.rows("pending_sessions");
    expect(rotated.session_generation).not.toBe(oldGeneration);
    expect(rotated.accumulated_text).toBe(header);
    expect(String(rotated.accumulated_text)).not.toContain("7.องุ่นแดง");
    expect(db.appendCalls).toBe(0);

    const rotatedGeneration = String(rotated.session_generation);
    await service(db).processEvents([textEvent(header, 5_000)], "destination");

    const [sameGeneration] = db.rows("pending_sessions");
    expect(sameGeneration.session_generation).toBe(rotatedGeneration);
    expect(db.appendCalls).toBe(1);
  });

  it("does not treat an in-session คืนเสีย section as a different session header", () => {
    const header = "โอม-พาซิโอ้ผลไม้ เบิก 30/06/2569";
    const currentText = [
      header,
      "1.ทุเรียน100บาท",
      "1โล",
      "คืนเสีย",
      "2.มังคุด50บาท",
      "1โล",
    ].join("\n");

    expect(requiresFreshPendingGeneration(currentText, header)).toBe(false);
  });

  it("generation-pinned cleanup cannot delete a concurrent replacement", async () => {
    const replacementGeneration = "33333333-3333-4333-8333-333333333333";
    const db = new BoundaryDatabase(pendingSession(
      "โอม-พาซิโอ้ผลไม้ เบิก 30/06/2569",
      replacementGeneration,
    ));
    const pendingService = new PendingSessionService(db as never);

    const deleted = await pendingService.deleteGeneration(
      SESSION_KEY,
      "11111111-1111-4111-8111-111111111111",
    );

    expect(deleted).toBe(false);
    expect(db.rows("pending_sessions")[0].session_generation)
      .toBe(replacementGeneration);
  });

  it("accepts an eligible middle item that reaches the app after close and rearms quiet time", async () => {
    const db = new BoundaryDatabase(pendingSession(
      "โอม-พาซิโอ้ผลไม้ เบิก 30/06/2569",
    ));
    const webhook = service(db);

    await webhook.processEvents(
      [textEvent("จบรายการ 1 รายการ", 5_000, "close-reply")],
      "destination",
    );
    const pending = db.rows("pending_sessions")[0];
    const originalBoundary = pending.close_event_timestamp_ms;
    pending.next_attempt_at = "2000-01-01T00:00:00.000Z";

    await webhook.processEvents(
      [textEvent("1.ทุเรียน100บาท\n2โล", 3_000, "late-item-reply")],
      "destination",
    );

    expect(pending.close_event_timestamp_ms).toBe(originalBoundary);
    expect(pending.accumulated_text).toContain("ทุเรียน");
    expect(pending.ingest_revision).toBe(2);
    expect(String(pending.next_attempt_at)).not.toBe("2000-01-01T00:00:00.000Z");
    expect(db.rows("pending_session_ingest").some((row) =>
      String(row.raw_text).includes("ทุเรียน"),
    )).toBe(true);
  });

  it("deduplicates a repeated item before changing text, ledgers, or revision", async () => {
    const db = new BoundaryDatabase(pendingSession(
      "โอม-พาซิโอ้ผลไม้ เบิก 30/06/2569",
    ));
    const webhook = service(db);
    const itemText = "1.ทุเรียน100บาท\n2โล";
    const itemEvent = textEvent(itemText, 2_000, "item-reply", "duplicate-item-event");

    await webhook.processEvents([itemEvent], "destination");
    await webhook.processEvents([itemEvent], "destination");

    const pending = db.rows("pending_sessions")[0];
    expect(String(pending.accumulated_text).split(itemText)).toHaveLength(2);
    expect(pending.ingest_revision).toBe(1);
    expect(db.rows("pending_session_admission")).toHaveLength(1);
    expect(db.rows("pending_session_ingest")).toHaveLength(1);
  });

  it("deduplicates a repeated close without changing its immutable fields", async () => {
    const db = new BoundaryDatabase(pendingSession(
      "โอม-พาซิโอ้ผลไม้ เบิก 30/06/2569\n1.ทุเรียน100บาท\n2โล",
    ));
    const webhook = service(db);
    const closeText = "จบรายการ 1 รายการ";
    const closeEvent = textEvent(
      closeText,
      3_000,
      "close-reply",
      "duplicate-close-event",
    );

    await webhook.processEvents([closeEvent], "destination");
    const pending = db.rows("pending_sessions")[0];
    const immutableClose = {
      boundary: pending.close_event_timestamp_ms,
      requestedAt: pending.close_requested_at,
      eventId: pending.close_line_event_id,
      deadline: pending.close_deadline_at,
      nextAttempt: pending.next_attempt_at,
      expectedCount: pending.expected_item_count,
      revision: pending.ingest_revision,
    };

    await webhook.processEvents([closeEvent], "destination");

    expect(String(pending.accumulated_text).split(closeText)).toHaveLength(2);
    expect({
      boundary: pending.close_event_timestamp_ms,
      requestedAt: pending.close_requested_at,
      eventId: pending.close_line_event_id,
      deadline: pending.close_deadline_at,
      nextAttempt: pending.next_attempt_at,
      expectedCount: pending.expected_item_count,
      revision: pending.ingest_revision,
    }).toEqual(immutableClose);
    expect(db.rows("pending_session_admission")).toHaveLength(1);
    expect(db.rows("pending_session_ingest")).toHaveLength(1);
  });

  it("does not mutate pending state or ledgers when an after-close event is redelivered", async () => {
    const db = new BoundaryDatabase(pendingSession(
      "โอม-พาซิโอ้ผลไม้ เบิก 30/06/2569",
    ));
    const webhook = service(db);

    await webhook.processEvents(
      [textEvent("จบรายการ 1 รายการ", 3_000, "close-reply")],
      "destination",
    );
    const pending = db.rows("pending_sessions")[0];
    const afterCloseEvent = textEvent(
      "1.ทุเรียน100บาท\n2โล",
      4_000,
      "after-reply",
      "duplicate-after-close-event",
    );
    const before = { ...pending };
    const admissionCount = db.rows("pending_session_admission").length;
    const ingestCount = db.rows("pending_session_ingest").length;

    await webhook.processEvents([afterCloseEvent], "destination");
    await webhook.processEvents([afterCloseEvent], "destination");

    expect(pending).toEqual(before);
    expect(db.rows("pending_session_admission")).toHaveLength(admissionCount);
    expect(db.rows("pending_session_ingest")).toHaveLength(ingestCount);
  });

  it("rejects an item beyond the first close timestamp without touching old-generation ledgers", async () => {
    const db = new BoundaryDatabase(pendingSession(
      "โอม-พาซิโอ้ผลไม้ เบิก 30/06/2569",
    ));
    const replies: string[] = [];
    const webhook = service(db, replies);

    await webhook.processEvents(
      [textEvent("จบรายการ 1 รายการ", 3_000, "close-reply")],
      "destination",
    );
    const pending = db.rows("pending_sessions")[0];
    const revisionAfterClose = pending.ingest_revision;
    const ingestCountAfterClose = db.rows("pending_session_ingest").length;
    const admissionCountAfterClose = db.rows("pending_session_admission").length;

    await webhook.processEvents(
      [textEvent("1.ทุเรียน100บาท\n2โล", 4_000, "after-reply")],
      "destination",
    );

    expect(pending.accumulated_text).not.toContain("ทุเรียน");
    expect(pending.ingest_revision).toBe(revisionAfterClose);
    expect(db.rows("pending_session_ingest")).toHaveLength(ingestCountAfterClose);
    expect(db.rows("pending_session_admission")).toHaveLength(admissionCountAfterClose);
    expect(replies.at(-1)).toContain("กู้รายการล่าสุด");
    expect(replies.at(-1)).toContain("ยังไม่ถูกบันทึก");
  });

  it("close request performs no produce writes in the webhook request", async () => {
    const stale = pendingSession(
      "โอม-พาซิโอ้ผลไม้ เบิก 29/06/2569\n1.ทุเรียน100บาท\n1โล",
    );
    const db = new BoundaryDatabase(stale);

    const [result] = await service(db).processEvents(
      [textEvent("จบรายการเบิก", 4_000)],
      "destination",
    );

    expect(result.parsed).toBe(false);
    expect(db.rows("produce_sessions")).toHaveLength(0);
    expect(db.rows("produce_items")).toHaveLength(0);
    expect(db.rows("pending_sessions")).toHaveLength(1);
    expect(db.rows("pending_sessions")[0].next_attempt_at).not.toBeNull();
  });

  it("normal header → items → close is deferred for the cron finalizer", async () => {
    const db = new BoundaryDatabase();
    const webhook = service(db);

    const results = await webhook.processEvents([
      textEvent("โอม-พาซิโอ้ผลไม้ เบิก 30/06/2569", 1_000),
      textEvent("1.ทุเรียน100บาท\n2โล", 2_000),
      textEvent("จบรายการเบิก", 3_000),
    ], "destination");

    expect(results.at(-1)?.parsed).toBe(false);
    expect(db.rows("produce_sessions")).toHaveLength(0);
    expect(db.rows("produce_items")).toHaveLength(0);
    expect(db.rows("pending_sessions")).toHaveLength(1);
    expect(db.rows("pending_sessions")[0].close_event_timestamp_ms).toBe(3_000);
  });
});

describe("remaining fruit command routing", () => {
  it("handles remaining summary before stale terminalized pending session append", async () => {
    const db = new BoundaryDatabase(
      staleTerminalizedPendingSession("โอม-พาซิโอ้ผลไม้ เบิก 10/07/2569"),
    );
    const replies: string[] = [];
    const webhook = service(db, replies);

    await webhook.processEvents(
      [textEvent("16:25 user สรุปคงเหลือ 21/07/2569", Date.now(), "remaining-reply")],
      "destination",
    );

    expect(db.appendCalls).toBe(0);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain(REMAINING_STOCK_REPORT_TITLE);
  });

  it("still appends normal produce item lines to an active pending session", async () => {
    const db = new BoundaryDatabase(
      pendingSession("โอม-พาซิโอ้ผลไม้ เบิก 30/06/2569"),
    );
    const webhook = service(db);

    await webhook.processEvents(
      [textEvent("1.ทุเรียน100บาท\n2\u0E42\u0E25", 2_000)],
      "destination",
    );

    expect(db.appendCalls).toBe(1);
  });
});

describe("white sheet close command routing", () => {
  const CLOSE_TEXT = [
    "ตลาดกี้ ปิดยอด 24/07/2569",
    "ยอดขาย 100",
    "เงินให้เจ้า 0",
    "ค่าแรง 0",
    "ค่าที่ 0",
    "ค่าถุง 0",
    "ค่าขนม 0",
    "ค่าอื่น 0",
    "เงินสด 100",
    "จบปิดยอด",
  ].join("\n");

  /** Deterministic produce + price seed so close completes (not early mock failure). */
  function seedCloseableMarket(db: BoundaryDatabase) {
    db.rows("produce_transactions").push({
      id: "item-ws-1",
      product_name: "มะม่วง",
      quantity: 20,
      unit: "ลูก",
      price_per_unit: 5,
      transaction_type: "เบิก",
      base_transaction_type: "เบิก",
      item_created_at: "2026-07-24T02:00:00Z",
      session_id: "main-ws",
      transaction_date: "2026-07-24",
      market_name: "ตลาดกี้",
      raw_message_id: "raw-ws-produce",
      basis_quantity: null,
      basis_price: null,
      session_kind: "main",
    });
    db.rows("raw_messages").push({
      id: "raw-ws-produce",
      source_id: "group-1",
    });
    db.rows("central_selling_prices").push({
      product_key: "มะม่วง",
      unit_key: "ลูก",
      business_date: "2026-07-24",
      price_satang: 500,
      set_by: "admin",
      set_reason: null,
      created_at: "2026-07-24T00:00:00Z",
      updated_at: "2026-07-24T00:00:00Z",
    });
  }

  it("successfully closes via LINE while an active pending produce session is open", async () => {
    const original = "โอม-พาซิโอ้ผลไม้ เบิก 30/06/2569\n1.ทุเรียน100บาท\n2โล";
    const db = new BoundaryDatabase(pendingSession(original));
    seedCloseableMarket(db);
    const replies: string[] = [];
    const webhook = service(db, replies);

    await webhook.processEvents(
      [textEvent(CLOSE_TEXT, 2_000, "close-ws-reply")],
      "destination",
    );

    expect(db.appendCalls).toBe(0);
    expect(db.rows("pending_sessions")[0].accumulated_text).toBe(original);
    expect(db.rows("digital_white_sheet_cash_entries")).toHaveLength(1);
    expect(db.rows("digital_white_sheet_cash_entries")[0].actual_cash_submitted).toBe(100);
    const reply = replies.join("\n");
    expect(reply).toContain("สรุปปิดยอด — ตลาดกี้");
    expect(reply).toContain("✅ ยอดตรง");
    expect(reply).not.toContain("รับจบรายการ");
    expect(reply).not.toMatch(/รับ\s+\d+\s+รายการ/);
    expect(reply).not.toContain("บันทึกปิดยอดไม่สำเร็จ");
  });

  it("successfully closes LINE-export-prefixed text without pending/manual-slip capture", async () => {
    const original = "โอม-พาซิโอ้ผลไม้ เบิก 30/06/2569";
    const db = new BoundaryDatabase(pendingSession(original));
    seedCloseableMarket(db);
    const replies: string[] = [];
    const webhook = service(db, replies);
    const exported = [
      "10:15 ผู้ขาย ตลาดกี้ ปิดยอด 24/07/2569",
      "10:15 ผู้ขาย ยอดขาย 100",
      "10:15 ผู้ขาย เงินให้เจ้า 0",
      "10:15 ผู้ขาย ค่าแรง 0",
      "10:15 ผู้ขาย ค่าที่ 0",
      "10:15 ผู้ขาย ค่าถุง 0",
      "10:15 ผู้ขาย ค่าขนม 0",
      "10:15 ผู้ขาย ค่าอื่น 0",
      "10:15 ผู้ขาย เงินสด 100",
      "10:15 ผู้ขาย จบปิดยอด",
    ].join("\n");

    await webhook.processEvents(
      [textEvent(exported, 2_000, "export-close-reply")],
      "destination",
    );

    expect(db.appendCalls).toBe(0);
    expect(db.rows("pending_sessions")[0].accumulated_text).toBe(original);
    expect(db.rows("digital_white_sheet_cash_entries")).toHaveLength(1);
    const reply = replies.join("\n");
    expect(reply).toContain("สรุปปิดยอด — ตลาดกี้");
    expect(reply).toContain("✅ ยอดตรง");
  });

  it("incomplete closes stay on the close path and persist no cash entry", async () => {
    const original = "โอม-พาซิโอ้ผลไม้ เบิก 30/06/2569";
    const db = new BoundaryDatabase(pendingSession(original));
    const replies: string[] = [];
    const webhook = service(db, replies);

    await webhook.processEvents(
      [textEvent("ตลาดกี้ ปิดยอด 24/07/2569\nเงินสด 100\nจบปิดยอด", 2_000, "bad-close")],
      "destination",
    );

    expect(db.appendCalls).toBe(0);
    expect(db.rows("digital_white_sheet_cash_entries")).toHaveLength(0);
    expect(replies[0]).toContain("ยอดขาย");
    expect(replies[0]).toContain("เงินให้เจ้า");
  });
});

const STALE_LOCK_REPLY = "พบรายการเดิมที่ยังปิดไม่สมบูรณ์";
const PI_HEADER = "ผลไม้คงเหลือในบ้าน\n20/1/68";
const NEW_PRODUCE_HEADER = "โอม-พาซิโอ้ผลไม้ เบิก 26/08/2569";

function seedHistoricalAudit(db: BoundaryDatabase, pending: PendingSession) {
  db.insert("pending_session_ingest", {
    session_key: pending.session_key,
    session_generation: pending.session_generation,
    line_event_id: "hist-opener",
    line_timestamp_ms: 1_000,
    raw_text: pending.accumulated_text,
  }, "insert");
  db.insert("pending_session_admission", {
    session_key: pending.session_key,
    session_generation: pending.session_generation,
    line_event_id: "hist-opener",
    line_timestamp_ms: 1_000,
  }, "insert");
}

function terminalizedPending(
  status: NonNullable<PendingSession["finalization_status"]>,
  sessionKey = SESSION_KEY,
  sourceId = "group-1",
): PendingSession {
  return {
    ...staleTerminalizedPendingSession("โอม-พาซิโอ้ผลไม้ เบิก 10/07/2569\n1.ทุเรียน100บาท\n1โล\nจบรายการเบิก"),
    session_key: sessionKey,
    source_id: sourceId,
    finalization_status: status,
    ingest_revision: 3,
  };
}

function dmTextEvent(text: string, timestamp: number, replyToken?: string): LineMessageEvent {
  eventSequence += 1;
  return {
    type: "message",
    webhookEventId: `boundary-event-${eventSequence}`,
    deliveryContext: { isRedelivery: false },
    timestamp,
    source: { type: "user", userId: "user-1" },
    mode: "active",
    replyToken,
    message: { id: `boundary-message-${eventSequence}`, type: "text", text },
  } as LineMessageEvent;
}

describe("terminalized pending sessions are never an active Produce lock", () => {
  it("lookupActive does not return a terminalized row as the live session", async () => {
    const pending = terminalizedPending("duplicate");
    const db = new BoundaryDatabase(pending);
    const active = await new PendingSessionService(db as never).lookupActive(SESSION_KEY);
    expect(active.session).toBeNull();
    expect(active.reason).toBe("terminalized");
    const historical = await new PendingSessionService(db as never).lookup(SESSION_KEY);
    expect(historical.session?.id).toBe(pending.id);
    expect(historical.session?.terminalized).toBe(true);
  });

  it("a terminalized duplicate row does not block a new Produce opener", async () => {
    const pending = terminalizedPending("duplicate");
    const oldGeneration = pending.session_generation;
    const db = new BoundaryDatabase(pending);
    seedHistoricalAudit(db, pending);
    const replies: string[] = [];
    await service(db, replies).processEvents(
      [textEvent(NEW_PRODUCE_HEADER, 9_000, "new-opener")],
      "destination",
    );

    const current = db.rows("pending_sessions")[0];
    expect(db.rows("pending_sessions")).toHaveLength(1);
    expect(current.terminalized).toBe(false);
    expect(current.accumulated_text).toBe(NEW_PRODUCE_HEADER);
    expect(current.session_generation).not.toBe(oldGeneration);
    expect(db.appendCalls).toBe(0);
    expect(replies.join("\n")).not.toContain(STALE_LOCK_REPLY);
    expect(db.rows("pending_session_ingest").some((row) =>
      row.session_generation === oldGeneration
      && row.line_event_id === "hist-opener",
    )).toBe(true);
    expect(db.rows("pending_session_admission").some((row) =>
      row.session_generation === oldGeneration
      && row.line_event_id === "hist-opener",
    )).toBe(true);
  });

  it("a terminalized failed_closed row does not block a new Produce opener", async () => {
    const pending = terminalizedPending("failed_closed");
    const oldGeneration = pending.session_generation;
    const db = new BoundaryDatabase(pending);
    seedHistoricalAudit(db, pending);
    const replies: string[] = [];
    await service(db, replies).processEvents(
      [textEvent(NEW_PRODUCE_HEADER, 9_000, "new-opener")],
      "destination",
    );

    const current = db.rows("pending_sessions")[0];
    expect(current.terminalized).toBe(false);
    expect(current.accumulated_text).toBe(NEW_PRODUCE_HEADER);
    expect(current.session_generation).not.toBe(oldGeneration);
    expect(replies.join("\n")).not.toContain(STALE_LOCK_REPLY);
  });

  it("an unrelated Physical Inventory header is not appended to a terminalized Produce row", async () => {
    const pending = terminalizedPending("duplicate");
    const before = pending.accumulated_text;
    const generation = pending.session_generation;
    const db = new BoundaryDatabase(pending);
    seedHistoricalAudit(db, pending);
    const replies: string[] = [];
    await service(db, replies).processEvents(
      [textEvent(PI_HEADER, 9_000, "pi-header")],
      "destination",
    );

    const current = db.rows("pending_sessions")[0];
    expect(current.accumulated_text).toBe(before);
    expect(current.terminalized).toBe(true);
    expect(current.session_generation).toBe(generation);
    expect(current.ingest_revision).toBe(3);
    expect(db.appendCalls).toBe(0);
    expect(db.rows("pending_session_ingest")).toHaveLength(1);
    expect(db.rows("pending_session_admission")).toHaveLength(1);
    expect(replies.join("\n")).not.toContain(STALE_LOCK_REPLY);
    expect(isPhysicalInventoryLineGroupAllowed("group-1")).toBe(false);
  });

  it("จบ after terminalized history alone does not produce a stale-session reply", async () => {
    const pending = terminalizedPending("failed_closed");
    const db = new BoundaryDatabase(pending);
    seedHistoricalAudit(db, pending);
    const replies: string[] = [];
    await service(db, replies).processEvents(
      [textEvent("จบ", 9_000, "bare-close")],
      "destination",
    );

    expect(db.appendCalls).toBe(0);
    expect(db.rows("pending_sessions")[0].accumulated_text).toBe(pending.accumulated_text);
    expect(db.rows("pending_sessions")[0].terminalized).toBe(true);
    expect(replies).toHaveLength(0);
    expect(replies.join("\n")).not.toContain(STALE_LOCK_REPLY);
  });

  it("a genuine active Produce pending session still accepts continuation items", async () => {
    const db = new BoundaryDatabase(
      pendingSession("โอม-พาซิโอ้ผลไม้ เบิก 30/06/2569"),
    );
    await service(db).processEvents(
      [textEvent("1.ทุเรียน100บาท\n2โล", 2_000)],
      "destination",
    );
    expect(db.appendCalls).toBe(1);
    expect(db.rows("pending_sessions")[0].accumulated_text).toContain("ทุเรียน");
    expect(db.rows("pending_sessions")[0].terminalized).toBe(false);
  });

  it("duplicate active-session prevention still keeps a single live row", async () => {
    const live = pendingSession("โอม-พาซิโอ้ผลไม้ เบิก 30/06/2569");
    const db = new BoundaryDatabase(live);
    await service(db).processEvents(
      [textEvent("โอม-พาซิโอ้ผลไม้ เบิก 31/06/2569", 2_000, "conflict-opener")],
      "destination",
    );
    expect(db.rows("pending_sessions")).toHaveLength(1);
    const current = db.rows("pending_sessions")[0];
    expect(current.accumulated_text).toBe("โอม-พาซิโอ้ผลไม้ เบิก 31/06/2569");
    expect(current.terminalized).toBe(false);
  });

  it("a closing but not-terminalized session still blocks a new opener", async () => {
    const closing: PendingSession = {
      ...pendingSession("โอม-พาซิโอ้ผลไม้ เบิก 30/06/2569\n1.ทุเรียน100บาท\n1โล"),
      close_event_timestamp_ms: 5_000,
      close_requested_at: new Date().toISOString(),
      close_line_event_id: "close-live",
    };
    const db = new BoundaryDatabase(closing);
    const replies: string[] = [];
    await service(db, replies).processEvents(
      [textEvent(NEW_PRODUCE_HEADER, 9_000, "blocked-opener")],
      "destination",
    );
    expect(db.rows("pending_sessions")).toHaveLength(1);
    expect(db.rows("pending_sessions")[0].session_generation).toBe(closing.session_generation);
    expect(db.rows("pending_sessions")[0].accumulated_text).toBe(closing.accumulated_text);
    expect(db.appendCalls).toBe(0);
    expect(replies.join("\n")).toContain(STALE_LOCK_REPLY);
  });

  it("1:1 terminalized history stays readable and does not swallow a PI header", async () => {
    const pending = terminalizedPending("duplicate", "dm:user-1", "user-1");
    const db = new BoundaryDatabase(pending);
    seedHistoricalAudit(db, pending);
    const replies: string[] = [];
    await service(db, replies).processEvents(
      [dmTextEvent(PI_HEADER, 9_000, "dm-pi")],
      "destination",
    );

    expect(db.appendCalls).toBe(0);
    expect(db.rows("pending_sessions")[0].accumulated_text).toBe(pending.accumulated_text);
    expect(db.rows("pending_sessions")[0].terminalized).toBe(true);
    expect(db.rows("pending_session_ingest")).toHaveLength(1);
    expect(db.rows("pending_session_admission")).toHaveLength(1);
    expect(replies.join("\n")).not.toContain(STALE_LOCK_REPLY);
  });
});
