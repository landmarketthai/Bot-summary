/**
 * Produce boundary recovery — before-opener / after-close / orphan replay.
 *
 * Replay uses append_pending_session into a newly opened same-source header.
 * It never guesses seller, market, date, or type, and never writes after-close
 * items into an already closed generation.
 */
import { describe, expect, it } from "bun:test";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import {
  RECOVER_LATEST_COMMAND,
  RECOVER_REFUSED_AFTER_CLOSE_PROVENANCE_REPLY,
  RECOVER_REFUSED_AMBIGUOUS_REPLY,
  RECOVER_REFUSED_NO_HEADER_REPLY,
  RECOVER_REFUSED_UNKEYED_REPLY,
} from "@/lib/line/pending-produce-recovery";
import { PendingSessionService } from "@/lib/line/pending-session-service";
import { WebhookService } from "@/lib/line/webhook-service";
import { getRuntimeEnvironment } from "@/lib/runtime-environment";
import type { LineMessageEvent } from "@/lib/line/types";

type Row = Record<string, unknown>;
type QueryMode = "select" | "insert" | "update" | "delete" | "upsert";

const SESSION_KEY = "group:group-1:user:user-1";
const HEADER = "ดำ-ราชพฤกษ์ เบิก 30/06/2569";
const RETURN_HEADER = "ดำ-ราชพฤกษ์ ชั่งคืน 30/06/2569";
const PRODUCTS = [
  "ทุเรียน", "มังคุด", "เงาะ", "ลำไย", "แตงโม", "กล้วย",
  "ส้ม", "มะพร้าว", "ชมพู่", "น้อยหน่า", "ลองกอง", "ลิ้นจี่",
  "แตงไทย", "ทับทิม", "มะละกอ", "สับปะรด",
];

function itemMessage(n: number): string {
  return `${n}.${PRODUCTS[(n - 1) % PRODUCTS.length]}100บาท\n2โล`;
}

class MemoryQuery {
  private filters: Array<(row: Row) => boolean> = [];
  private maxRows: number | null = null;
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  private returning = false;

  constructor(
    private readonly db: RecoveryDatabase,
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
      error: { code?: string; message: string } | null;
      count: number | null;
    }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }

  private execute(): {
    data: Row[] | Row | null;
    error: { code?: string; message: string } | null;
    count: number | null;
  } {
    const rows = this.db.rows(this.table);
    const matches = () => rows.filter((row) => this.filters.every((filter) => filter(row)));

    if (this.mode === "select") {
      const matched = matches();
      let selected = matched;
      if (this.rangeFrom !== null && this.rangeTo !== null) {
        selected = matched.slice(this.rangeFrom, this.rangeTo + 1);
      }
      if (this.maxRows !== null) selected = selected.slice(0, this.maxRows);
      return { data: selected, error: null, count: matched.length };
    }

    if (this.mode === "insert" || this.mode === "upsert") {
      const payloads = Array.isArray(this.payload) ? this.payload : [this.payload ?? {}];
      if (this.table === "raw_messages") {
        for (const payload of payloads) {
          if (rows.some((row) => row.line_event_id === payload.line_event_id)) {
            return { data: null, error: { code: "23505", message: "duplicate key" }, count: null };
          }
        }
      }
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

class RecoveryDatabase {
  private readonly tables = new Map<string, Row[]>();
  generationSequence = 0;
  appendFailAfter: number | null = null;
  appendCalls = 0;

  rows(table: string): Row[] {
    const existing = this.tables.get(table);
    if (existing) return existing;
    const created: Row[] = [];
    this.tables.set(table, created);
    return created;
  }

  insert(table: string, payload: Row, mode: QueryMode): Row {
    const rows = this.rows(table);
    if (table === "pending_produce_deferred_events") {
      const existing = rows.find((row) => row.line_event_id === payload.line_event_id);
      if (existing) return existing;
    }
    if (
      table === "pending_session_admission"
      || table === "pending_session_ingest"
    ) {
      const existing = rows.find((row) =>
        row.session_generation === payload.session_generation
        && row.line_event_id === payload.line_event_id
      );
      if (existing) return existing;
    }
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
      row.created_at = row.created_at ?? new Date().toISOString();
      row.updated_at = row.updated_at ?? new Date().toISOString();
      row.entry_origin = row.entry_origin ?? null;
      row.terminalized = row.terminalized ?? false;
      row.ingest_revision = row.ingest_revision ?? 0;
    }
    rows.push(row);
    return row;
  }

  remove(table: string, removed: Set<Row>): void {
    this.tables.set(table, this.rows(table).filter((row) => !removed.has(row)));
  }

  pending(sessionKey = SESSION_KEY): Row | undefined {
    return this.rows("pending_sessions").find((row) => row.session_key === sessionKey);
  }

  deferred(): Row[] {
    return this.rows("pending_produce_deferred_events");
  }

  recoverable(): Row[] {
    return this.deferred().filter((row) =>
      ["waiting", "rejected_before_opener", "rejected_after_close", "rejected_orphan"]
        .includes(String(row.status)),
    );
  }

  from = (table: string) => ({
    select: () => new MemoryQuery(this, table, "select"),
    insert: (payload: Row | Row[]) => new MemoryQuery(this, table, "insert", payload),
    upsert: (payload: Row | Row[]) => new MemoryQuery(this, table, "upsert", payload),
    update: (payload: Row) => new MemoryQuery(this, table, "update", payload),
    delete: () => new MemoryQuery(this, table, "delete"),
  });

  private appendPending(args: Row) {
    const pending = this.pending(String(args.p_session_key));
    this.appendCalls += 1;
    if (this.appendFailAfter != null && this.appendCalls > this.appendFailAfter) {
      throw new Error("injected append crash");
    }
    if (!pending) return { data: { accepted: false, reason: "not_found" }, error: null };
    if (pending.terminalized) {
      return { data: { accepted: false, reason: "terminalized", session: pending }, error: null };
    }
    if (
      args.p_expected_session_generation != null
      && pending.session_generation !== args.p_expected_session_generation
    ) {
      return { data: { accepted: false, reason: "generation_conflict" }, error: null };
    }
    const isDuplicate = args.p_line_event_id != null && (
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
      return { data: { accepted: true, reason: "duplicate_event", session: pending }, error: null };
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
    }
    return { data: { accepted: true, reason: "appended", session: pending }, error: null };
  }

  rpc = async (name: string, args: Row) => {
    if (name === "bind_plain_text_accountability_round") {
      return { data: { outcome: "no_round" }, error: null };
    }
    if (name === "admit_pending_session_event" || name === "register_pending_session_ingest") {
      return { data: null, error: null };
    }
    if (name === "mark_plain_text_close_refused") {
      return { data: { marked: true }, error: null };
    }
    if (name === "append_pending_session") return this.appendPending(args);

    if (name === "recover_pending_produce_deferred_event") {
      // Mirrors 20260825090000: append and the deferred-status flip happen
      // together. The crash-injection point stays inside appendPending, so a
      // simulated crash aborts BEFORE the status flip too — matching a real
      // rolled-back Postgres transaction.
      const appended = this.appendPending({
        p_session_key: args.p_session_key,
        p_new_text: args.p_raw_text,
        p_reply_token: args.p_reply_token,
        p_line_event_id: args.p_line_event_id,
        p_line_timestamp_ms: args.p_line_timestamp_ms,
        p_mark_close: false,
        p_expected_session_generation: args.p_expected_session_generation,
      });
      const result = appended.data as { accepted?: boolean } | null;
      if (result?.accepted) {
        const deferredRow = this.deferred()
          .find((row) => row.line_event_id === args.p_line_event_id);
        if (
          deferredRow
          && ["waiting", "rejected_before_opener", "rejected_after_close", "rejected_orphan"]
            .includes(String(deferredRow.status))
        ) {
          Object.assign(deferredRow, {
            status: "admitted",
            defer_reason: "explicit_recovery",
            session_generation: args.p_expected_session_generation,
            resolved_at: new Date().toISOString(),
          });
        }
      }
      return appended;
    }

    if (name === "open_pending_plain_text_generation") {
      let pending = this.pending(String(args.p_session_key));
      if (
        pending
        && args.p_expected_session_generation != null
        && pending.session_generation !== args.p_expected_session_generation
      ) {
        return { data: { opened: false, reason: "generation_conflict" }, error: null };
      }
      const priorGeneration = pending?.session_generation;
      const priorOpener = pending?.plain_text_opened_line_event_id;
      const priorClose = pending?.close_line_event_id;
      const generation = crypto.randomUUID();
      const now = new Date().toISOString();
      if (!pending) {
        pending = this.insert("pending_sessions", {
          session_key: args.p_session_key,
          source_id: args.p_source_id,
          line_user_id: args.p_line_user_id,
          accumulated_text: args.p_raw_text,
          latest_reply_token: args.p_reply_token,
          session_generation: generation,
          created_at: now,
          updated_at: now,
          entry_origin: null,
          terminalized: false,
          ingest_revision: 1,
          close_event_timestamp_ms: args.p_mark_close ? args.p_line_timestamp_ms : null,
          close_line_event_id: args.p_mark_close ? args.p_line_event_id : null,
          plain_text_opened_line_event_id: args.p_line_event_id,
          plain_text_opened_line_timestamp_ms: args.p_line_timestamp_ms,
          runtime_environment: args.p_runtime_environment,
        }, "insert");
      } else {
        Object.assign(pending, {
          accumulated_text: args.p_raw_text,
          latest_reply_token: args.p_reply_token,
          session_generation: generation,
          created_at: now,
          updated_at: now,
          entry_origin: null,
          terminalized: false,
          ingest_revision: 1,
          close_event_timestamp_ms: args.p_mark_close ? args.p_line_timestamp_ms : null,
          close_requested_at: args.p_mark_close ? now : null,
          close_line_event_id: args.p_mark_close ? args.p_line_event_id : null,
          close_session_generation: args.p_mark_close ? generation : null,
          close_finalize_started_at: null,
          next_attempt_at: args.p_mark_close ? new Date(Date.now() + 8_000).toISOString() : null,
          close_deadline_at: args.p_mark_close ? new Date(Date.now() + 30_000).toISOString() : null,
          plain_text_opened_line_event_id: args.p_line_event_id,
          plain_text_opened_line_timestamp_ms: args.p_line_timestamp_ms,
          finalized_produce_session_id: null,
          finalization_status: "pending",
        });
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
        raw_text: args.p_raw_text,
      }, "insert");
      let carriedForwardCount = 0;
      if (priorGeneration != null) {
        const stranded = this.rows("pending_session_ingest")
          .filter((row) => row.session_key === args.p_session_key)
          .filter((row) => row.session_generation === priorGeneration)
          .filter((row) => Number(row.line_timestamp_ms) > Number(args.p_line_timestamp_ms))
          .filter((row) => !args.p_mark_close
            || Number(row.line_timestamp_ms) < Number(args.p_line_timestamp_ms))
          .filter((row) => row.line_event_id !== args.p_line_event_id)
          .filter((row) => row.line_event_id !== priorOpener && row.line_event_id !== priorClose)
          .sort((a, b) => Number(a.line_timestamp_ms) - Number(b.line_timestamp_ms));
        for (const row of stranded) {
          const appended = this.appendPending({
            p_session_key: args.p_session_key,
            p_new_text: row.raw_text,
            p_reply_token: args.p_reply_token,
            p_line_event_id: row.line_event_id,
            p_line_timestamp_ms: row.line_timestamp_ms,
            p_mark_close: false,
            p_expected_session_generation: generation,
          });
          if ((appended.data as { accepted?: boolean } | null)?.accepted) {
            carriedForwardCount += 1;
          }
        }
      }
      return {
        data: {
          opened: true,
          reason: "created",
          reconciled_count: carriedForwardCount,
          carried_forward_count: carriedForwardCount,
          session: pending,
        },
        error: null,
      };
    }

    if (name === "append_or_defer_pending_produce_item") {
      const pending = this.pending(String(args.p_session_key));
      const openerTs = pending ? Number(pending.plain_text_opened_line_timestamp_ms ?? NaN) : NaN;
      const closeTs = pending ? pending.close_event_timestamp_ms : null;
      const itemTs = Number(args.p_line_timestamp_ms);
      const live = Boolean(
        pending
        && pending.terminalized !== true
        && pending.entry_origin == null
        && Number.isFinite(openerTs)
        && itemTs > openerTs
        && (closeTs == null || itemTs < Number(closeTs)),
      );
      if (live) {
        const appended = this.appendPending({
          ...args,
          p_new_text: args.p_raw_text,
          p_mark_close: false,
          p_expected_session_generation: pending?.session_generation,
        });
        const result = appended.data as { accepted?: boolean; session?: Row; reason?: string };
        if (result?.accepted) {
          return {
            data: {
              action: "admitted",
              idempotent: result.reason === "duplicate_event",
              session_generation: pending?.session_generation,
              session: result.session,
            },
            error: null,
          };
        }
      }

      const existing = this.deferred().find((row) => row.line_event_id === args.p_line_event_id);
      if (existing && existing.status !== "waiting") {
        return {
          data: {
            action: existing.status,
            idempotent: true,
            session_generation: existing.session_generation,
          },
          error: null,
        };
      }
      const deferred = existing ?? this.insert("pending_produce_deferred_events", {
        line_event_id: args.p_line_event_id,
        raw_message_id: args.p_raw_message_id,
        session_key: args.p_session_key,
        source_id: args.p_source_id,
        line_user_id: args.p_line_user_id,
        line_timestamp_ms: args.p_line_timestamp_ms,
        raw_text: args.p_raw_text,
        reply_token: args.p_reply_token,
        runtime_environment: args.p_runtime_environment ?? getRuntimeEnvironment(),
        status: "waiting",
        defer_reason: "opener_not_materialized",
        session_generation: pending?.session_generation ?? null,
        opener_line_event_id: pending?.plain_text_opened_line_event_id ?? null,
        close_line_event_id: pending?.close_line_event_id ?? null,
        close_line_timestamp_ms: pending?.close_event_timestamp_ms ?? null,
        expires_at: new Date(Date.now() + 30_000).toISOString(),
        received_at: new Date().toISOString(),
        resolved_at: null,
      }, "insert");

      if (!pending || pending.terminalized || pending.entry_origin != null
          || pending.plain_text_opened_line_timestamp_ms == null) {
        return { data: { action: "deferred", idempotent: false }, error: null };
      }
      if (itemTs <= Number(pending.plain_text_opened_line_timestamp_ms)) {
        Object.assign(deferred, {
          status: "rejected_before_opener",
          defer_reason: "item_timestamp_not_after_opener",
          session_generation: pending.session_generation,
          opener_line_event_id: pending.plain_text_opened_line_event_id,
          resolved_at: new Date().toISOString(),
        });
        return { data: { action: "rejected_before_opener", session: pending }, error: null };
      }
      if (pending.close_event_timestamp_ms != null
          && itemTs >= Number(pending.close_event_timestamp_ms)) {
        Object.assign(deferred, {
          status: "rejected_after_close",
          defer_reason: "item_timestamp_not_before_close",
          session_generation: pending.session_generation,
          opener_line_event_id: pending.plain_text_opened_line_event_id,
          close_line_event_id: pending.close_line_event_id,
          close_line_timestamp_ms: pending.close_event_timestamp_ms,
          resolved_at: new Date().toISOString(),
        });
        return { data: { action: "rejected_after_close", session: pending }, error: null };
      }
      return { data: { action: "deferred", idempotent: false }, error: null };
    }

    throw new Error(`Unexpected RPC: ${name}`);
  };
}

let eventSequence = 0;
function textEvent(
  text: string,
  timestamp: number,
  options: { userId?: string; eventId?: string; groupId?: string } = {},
): LineMessageEvent {
  eventSequence += 1;
  const eventId = options.eventId ?? `recovery-event-${eventSequence}`;
  return {
    type: "message",
    webhookEventId: eventId,
    deliveryContext: { isRedelivery: false },
    timestamp,
    source: {
      type: "group",
      groupId: options.groupId ?? "group-1",
      userId: options.userId ?? "user-1",
    },
    mode: "active",
    replyToken: `reply-${eventId}`,
    message: { id: `recovery-message-${eventSequence}`, type: "text", text },
  } as LineMessageEvent;
}

function service(db: RecoveryDatabase, replies: string[] = []) {
  return new WebhookService(db as never, {
    replyMessage: async (_token, text) => { replies.push(text); },
    replyMessages: async (_token, texts) => { replies.push(texts.join("\n\n")); },
  });
}

async function send(
  webhook: WebhookService,
  text: string,
  timestamp: number,
  options?: { userId?: string; eventId?: string },
) {
  return webhook.processEvents([textEvent(text, timestamp, options)], "destination");
}

function parsedItemCount(db: RecoveryDatabase): number {
  const pending = db.pending();
  if (!pending) return 0;
  return parseWeighSession(String(pending.accumulated_text)).items.length;
}

function seedDeferred(
  db: RecoveryDatabase,
  count: number,
  status: "waiting" | "rejected_before_opener" | "rejected_after_close" | "rejected_orphan",
  extras: Partial<Row> = {},
) {
  for (let n = 1; n <= count; n += 1) {
    db.insert("pending_produce_deferred_events", {
      line_event_id: extras.line_event_id_prefix
        ? `${extras.line_event_id_prefix}-${n}`
        : `${status}-${n}`,
      raw_message_id: `seed-raw-${status}-${n}`,
      session_key: extras.session_key ?? SESSION_KEY,
      source_id: extras.source_id ?? "group-1",
      line_user_id: extras.line_user_id ?? "user-1",
      line_timestamp_ms: n,
      raw_text: itemMessage(n),
      reply_token: null,
      runtime_environment: getRuntimeEnvironment(),
      status,
      defer_reason: status,
      session_generation: extras.session_generation ?? null,
      opener_line_event_id: extras.opener_line_event_id !== undefined
        ? extras.opener_line_event_id
        : (status === "rejected_before_opener" ? "opener-seed" : null),
      close_line_event_id: extras.close_line_event_id ?? null,
      close_line_timestamp_ms: extras.close_line_timestamp_ms ?? null,
      expires_at: extras.expires_at ?? new Date(Date.now() + 30_000).toISOString(),
      received_at: new Date().toISOString(),
      resolved_at: status === "waiting" ? null : new Date().toISOString(),
    }, "insert");
  }
}

describe("2026-09-23 stale-generation ordering incident", () => {
  it("executes exact ITEM1 first, then timestamp-earlier HEADER, and keeps Item 1 in the saved generation", async () => {
    const db = new RecoveryDatabase();
    const webhook = service(db);
    await send(webhook, "รายการชั่งคืนก่อนหน้า", 1790176000000, {
      eventId: "sep23-stale-head",
    });
    const staleGeneration = db.pending()?.session_generation;

    await send(webhook, "1.น้อยหน่า40บาท\n30.5โล", 1790176127487, {
      eventId: "sep23-item-1",
    });
    expect(db.pending()?.session_generation).toBe(staleGeneration);
    expect(db.deferred()).toHaveLength(0);

    await send(webhook, "พี่เต้ย-ตลาด72 ชั่งคืน 23/9/2569", 1790176127327, {
      eventId: "sep23-head",
    });
    const saved = db.pending();
    expect(saved?.session_generation).not.toBe(staleGeneration);
    expect(parseWeighSession(String(saved?.accumulated_text)).items).toEqual([
      expect.objectContaining({ item_number: 1, product_name: "น้อยหน่า", quantity: 30.5 }),
    ]);
    expect(db.rows("pending_session_ingest")).toContainEqual(expect.objectContaining({
      session_generation: saved?.session_generation,
      line_event_id: "sep23-item-1",
      line_timestamp_ms: 1790176127487,
    }));
    expect(db.rows("raw_messages")).toContainEqual(expect.objectContaining({
      line_event_id: "sep23-item-1",
      raw_text: "1.น้อยหน่า40บาท\n30.5โล",
    }));
  });
});

describe("before-opener Produce recovery", () => {
  it("refuses recovery before a valid header exists", async () => {
    const db = new RecoveryDatabase();
    const replies: string[] = [];
    const webhook = service(db, replies);
    for (let n = 1; n <= 12; n += 1) {
      await send(webhook, itemMessage(n), n * 10);
    }
    expect(db.recoverable()).toHaveLength(12);
    await send(webhook, RECOVER_LATEST_COMMAND, 200);
    expect(replies.at(-1)).toBe(RECOVER_REFUSED_NO_HEADER_REPLY);
    expect(db.pending()).toBeUndefined();
    expect(parsedItemCount(db)).toBe(0);
  });

  it("replays 12 retained before-opener items once after the operator opens a header", async () => {
    const db = new RecoveryDatabase();
    const replies: string[] = [];
    const webhook = service(db, replies);
    for (let n = 1; n <= 12; n += 1) {
      await send(webhook, itemMessage(n), n * 10);
    }
    expect(replies.at(-1)).toContain("พบ 12 ข้อความที่ยังไม่ถูกบันทึก");
    expect(replies.at(-1)).toContain(RECOVER_LATEST_COMMAND);

    await send(webhook, HEADER, 1_000);
    expect(replies.at(-1)).toContain("เปิดหัวรายการแล้ว");
    expect(replies.at(-1)).toContain("พบ 12 ข้อความที่ยังเก็บไว้");

    await send(webhook, RECOVER_LATEST_COMMAND, 1_100);
    expect(replies.at(-1)).toContain("กู้แล้ว 12 ข้อความ");
    expect(parsedItemCount(db)).toBe(12);
    expect(String(db.pending()?.accumulated_text)).toContain(HEADER);
    expect(String(db.pending()?.accumulated_text)).not.toContain(RECOVER_LATEST_COMMAND);
    expect(db.recoverable()).toHaveLength(0);
    expect(db.deferred().every((row) => row.status === "admitted")).toBe(true);
    expect(db.deferred().every((row) => row.defer_reason === "explicit_recovery")).toBe(true);

    await send(webhook, RECOVER_LATEST_COMMAND, 1_200);
    expect(parsedItemCount(db)).toBe(12);
    expect(db.rows("raw_messages").length).toBeGreaterThanOrEqual(14);
  });
});

describe("after-close Produce recovery", () => {
  it("retains 16 after-close messages without mutating the closed generation", async () => {
    const db = new RecoveryDatabase();
    const replies: string[] = [];
    const webhook = service(db, replies);
    await send(webhook, HEADER, 1_000);
    await send(webhook, itemMessage(1), 2_000);
    await send(webhook, "จบรายการเบิก", 3_000);
    const closed = { ...db.pending()! };
    const ingestAfterClose = db.rows("pending_session_ingest").length;

    for (let n = 1; n <= 16; n += 1) {
      await send(webhook, itemMessage(n), 3_000 + n);
    }
    expect(db.pending()?.accumulated_text).toBe(closed.accumulated_text);
    expect(db.pending()?.ingest_revision).toBe(closed.ingest_revision);
    expect(db.rows("pending_session_ingest")).toHaveLength(ingestAfterClose);
    expect(db.recoverable()).toHaveLength(16);
    expect(db.recoverable().every((row) => row.status === "rejected_after_close")).toBe(true);
    expect(replies.at(-1)).toContain("พบ 16 ข้อความที่ยังไม่ถูกบันทึก");
    expect(replies.at(-1)).toContain("หลังปิดรอบก่อนแล้ว");
  });

  it("replays the 16 retained messages into a new header once the previous generation is terminalized", async () => {
    const db = new RecoveryDatabase();
    const replies: string[] = [];
    const webhook = service(db, replies);
    await send(webhook, HEADER, 1_000);
    await send(webhook, itemMessage(1), 2_000);
    await send(webhook, "จบรายการเบิก", 3_000);
    const finalizedText = String(db.pending()?.accumulated_text);
    for (let n = 1; n <= 16; n += 1) {
      await send(webhook, itemMessage(n), 4_000 + n);
    }
    expect(db.recoverable()).toHaveLength(16);
    db.insert("produce_sessions", {
      id: "produce-finalized-1",
      raw_text: finalizedText,
      session_generation: db.pending()?.session_generation,
    }, "insert");
    Object.assign(db.pending()!, {
      terminalized: true,
      finalization_status: "finalized",
      finalized_produce_session_id: "produce-finalized-1",
    });
    await send(webhook, HEADER, 10_000);
    await send(webhook, RECOVER_LATEST_COMMAND, 10_100);
    expect(parsedItemCount(db)).toBe(16);
    expect(db.rows("produce_sessions")[0]?.raw_text).toBe(finalizedText);
    expect(String(db.rows("produce_sessions")[0]?.raw_text)).not.toContain(PRODUCTS[15]);
    expect(db.recoverable()).toHaveLength(0);

    await send(webhook, RECOVER_LATEST_COMMAND, 10_200);
    expect(parsedItemCount(db)).toBe(16);
  });

  it("refuses after-close return evidence when the new header is a withdrawal", async () => {
    const db = new RecoveryDatabase();
    const replies: string[] = [];
    const webhook = service(db, replies);
    await send(webhook, RETURN_HEADER, 1_000);
    await send(webhook, itemMessage(1), 2_000);
    await send(webhook, "จบรายการชั่งคืน", 3_000);
    for (let n = 1; n <= 3; n += 1) {
      await send(webhook, itemMessage(n), 4_000 + n);
    }
    Object.assign(db.pending()!, { terminalized: true, finalization_status: "finalized" });
    await send(webhook, HEADER, 10_000);
    await send(webhook, RECOVER_LATEST_COMMAND, 10_100);
    expect(replies.at(-1)).toContain("ยังกู้รายการไม่ได้");
    expect(replies.at(-1)).toContain("รายการชั่งคืน");
    expect(replies.at(-1)).toContain("รายการเบิก");
    expect(parsedItemCount(db)).toBe(0);
    expect(db.recoverable()).toHaveLength(3);
  });

  it("recovers after-close ชั่งคืน evidence into a matching ชั่งคืน header", async () => {
    const db = new RecoveryDatabase();
    const replies: string[] = [];
    const webhook = service(db, replies);
    await send(webhook, RETURN_HEADER, 1_000);
    await send(webhook, itemMessage(1), 2_000);
    await send(webhook, "จบรายการชั่งคืน", 3_000);
    for (let n = 1; n <= 4; n += 1) {
      await send(webhook, itemMessage(n), 4_000 + n);
    }
    expect(db.recoverable()).toHaveLength(4);
    Object.assign(db.pending()!, { terminalized: true, finalization_status: "finalized" });
    await send(webhook, RETURN_HEADER, 10_000);
    await send(webhook, RECOVER_LATEST_COMMAND, 10_100);
    expect(parsedItemCount(db)).toBe(4);
    expect(db.recoverable()).toHaveLength(0);
    expect(replies.at(-1)).toContain("กู้แล้ว 4 ข้อความ");
  });

  it("refuses after-close recovery when the new header's seller differs", async () => {
    const db = new RecoveryDatabase();
    const replies: string[] = [];
    const webhook = service(db, replies);
    await send(webhook, HEADER, 1_000);
    await send(webhook, itemMessage(1), 2_000);
    await send(webhook, "จบรายการเบิก", 3_000);
    for (let n = 1; n <= 3; n += 1) {
      await send(webhook, itemMessage(n), 4_000 + n);
    }
    Object.assign(db.pending()!, { terminalized: true, finalization_status: "finalized" });
    await send(webhook, "แดง-ราชพฤกษ์ เบิก 30/06/2569", 10_000);
    await send(webhook, RECOVER_LATEST_COMMAND, 10_100);
    expect(replies.at(-1)).toContain("ยังกู้รายการไม่ได้");
    expect(parsedItemCount(db)).toBe(0);
    expect(db.recoverable()).toHaveLength(3);
    expect(db.recoverable().every((row) => row.status === "rejected_after_close")).toBe(true);
  });

  it("refuses after-close recovery when the new header's market differs", async () => {
    const db = new RecoveryDatabase();
    const replies: string[] = [];
    const webhook = service(db, replies);
    await send(webhook, HEADER, 1_000);
    await send(webhook, itemMessage(1), 2_000);
    await send(webhook, "จบรายการเบิก", 3_000);
    for (let n = 1; n <= 3; n += 1) {
      await send(webhook, itemMessage(n), 4_000 + n);
    }
    Object.assign(db.pending()!, { terminalized: true, finalization_status: "finalized" });
    await send(webhook, "ดำ-ตลาดทดสอบ เบิก 30/06/2569", 10_000);
    await send(webhook, RECOVER_LATEST_COMMAND, 10_100);
    expect(replies.at(-1)).toContain("ยังกู้รายการไม่ได้");
    expect(parsedItemCount(db)).toBe(0);
    expect(db.recoverable()).toHaveLength(3);
  });

  it("refuses after-close recovery when the new header's business date differs", async () => {
    const db = new RecoveryDatabase();
    const replies: string[] = [];
    const webhook = service(db, replies);
    await send(webhook, HEADER, 1_000);
    await send(webhook, itemMessage(1), 2_000);
    await send(webhook, "จบรายการเบิก", 3_000);
    for (let n = 1; n <= 3; n += 1) {
      await send(webhook, itemMessage(n), 4_000 + n);
    }
    Object.assign(db.pending()!, { terminalized: true, finalization_status: "finalized" });
    await send(webhook, "ดำ-ราชพฤกษ์ เบิก 01/07/2569", 10_000);
    await send(webhook, RECOVER_LATEST_COMMAND, 10_100);
    expect(replies.at(-1)).toContain("ยังกู้รายการไม่ได้");
    expect(parsedItemCount(db)).toBe(0);
    expect(db.recoverable()).toHaveLength(3);
  });

  it("refuses after-close recovery when original provenance cannot be reconstructed", async () => {
    const db = new RecoveryDatabase();
    const replies: string[] = [];
    const webhook = service(db, replies);
    seedDeferred(db, 5, "rejected_after_close", {
      session_generation: "gen-vanished-opener",
      close_line_event_id: "close-vanished-opener",
    });
    await send(webhook, HEADER, 1_000);
    await send(webhook, RECOVER_LATEST_COMMAND, 1_100);
    expect(replies.at(-1)).toBe(RECOVER_REFUSED_AFTER_CLOSE_PROVENANCE_REPLY);
    expect(parsedItemCount(db)).toBe(0);
    expect(db.recoverable()).toHaveLength(5);
    expect(db.recoverable().every((row) => row.status === "rejected_after_close")).toBe(true);
  });
});

describe("orphan and attribution safety", () => {
  it("refuses an ambiguous pair of bundles rather than guessing", async () => {
    const db = new RecoveryDatabase();
    const replies: string[] = [];
    const webhook = service(db, replies);
    seedDeferred(db, 2, "rejected_before_opener");
    seedDeferred(db, 3, "rejected_after_close", { close_line_event_id: "close-a" });
    await send(webhook, HEADER, 1_000);
    await send(webhook, RECOVER_LATEST_COMMAND, 1_100);
    expect(replies.at(-1)).toBe(RECOVER_REFUSED_AMBIGUOUS_REPLY);
    expect(parsedItemCount(db)).toBe(0);
    expect(db.recoverable()).toHaveLength(5);
  });

  it("will not recover another source's bundle", async () => {
    const db = new RecoveryDatabase();
    const replies: string[] = [];
    const webhook = service(db, replies);
    seedDeferred(db, 6, "rejected_after_close", {
      session_key: "group:group-1:user:user-2",
      line_user_id: "user-2",
      close_line_event_id: "close-other",
    });
    await send(webhook, HEADER, 1_000);
    await send(webhook, RECOVER_LATEST_COMMAND, 1_100);
    expect(parsedItemCount(db)).toBe(0);
    expect(db.recoverable()).toHaveLength(6);
  });

  it("does not combine two unkeyed orphan episodes from the same source", async () => {
    const db = new RecoveryDatabase();
    const replies: string[] = [];
    const webhook = service(db, replies);
    seedDeferred(db, 5, "rejected_orphan", { line_event_id_prefix: "morning" });
    seedDeferred(db, 7, "rejected_orphan", { line_event_id_prefix: "afternoon" });
    await send(webhook, HEADER, 1_000);
    await send(webhook, RECOVER_LATEST_COMMAND, 1_100);
    expect(replies.at(-1)).toBe(RECOVER_REFUSED_UNKEYED_REPLY);
    expect(parsedItemCount(db)).toBe(0);
    expect(db.recoverable()).toHaveLength(12);
  });

  it("does not recover a sole stale unkeyed orphan just because it is the only row", async () => {
    const db = new RecoveryDatabase();
    const replies: string[] = [];
    const webhook = service(db, replies);
    seedDeferred(db, 1, "rejected_orphan");
    await send(webhook, HEADER, 1_000);
    await send(webhook, RECOVER_LATEST_COMMAND, 1_100);
    expect(replies.at(-1)).toBe(RECOVER_REFUSED_UNKEYED_REPLY);
    expect(parsedItemCount(db)).toBe(0);
    expect(db.recoverable()).toHaveLength(1);
  });
});

describe("recovered draft still uses PR #81 and PR #77", () => {
  it("lets แก้ข้อ N correct one recovered item", async () => {
    const db = new RecoveryDatabase();
    const replies: string[] = [];
    const webhook = service(db, replies);
    seedDeferred(db, 2, "rejected_before_opener");
    db.deferred()[0]!.raw_text = "1.อะโวคาโด้80บาท\n15โล";
    db.deferred()[1]!.raw_text = "2.มังคุด45บาท\n10โล";
    await send(webhook, HEADER, 1_000);
    await send(webhook, RECOVER_LATEST_COMMAND, 1_100);
    await send(webhook, "แก้ข้อ 1\n1.อะโวคาโด80บาท\n16โล", 1_200);
    expect(replies.at(-1)).toContain("✅ แก้ข้อ 1 แล้ว");
    const parsed = parseWeighSession(String(db.pending()?.accumulated_text));
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]).toMatchObject({ product_name: "อะโวคาโด", quantity: 16 });
    expect(parsed.items[1]?.product_name).toBe("มังคุด");
  });

  it("lets ลบข้อ N remove one recovered item", async () => {
    const db = new RecoveryDatabase();
    const replies: string[] = [];
    const webhook = service(db, replies);
    seedDeferred(db, 2, "rejected_before_opener");
    await send(webhook, HEADER, 1_000);
    await send(webhook, RECOVER_LATEST_COMMAND, 1_100);
    await send(webhook, "ลบข้อ 1", 1_200);
    expect(replies.at(-1)).toContain("ลบข้อ 1 แล้ว");
    const parsed = parseWeighSession(String(db.pending()?.accumulated_text));
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.product_name).toBe("มังคุด");
  });

  it("refuses a wrong closer and finalizes exactly once on the correct closer", async () => {
    const db = new RecoveryDatabase();
    const replies: string[] = [];
    const webhook = service(db, replies);
    seedDeferred(db, 1, "rejected_before_opener");
    await send(webhook, RETURN_HEADER, 1_000);
    await send(webhook, RECOVER_LATEST_COMMAND, 1_100);
    const beforeWrong = String(db.pending()?.accumulated_text);
    await send(webhook, "จบรายการเบิก", 1_200);
    expect(replies.at(-1)).toContain("จบรายการชั่งคืน");
    expect(db.pending()?.accumulated_text).toBe(beforeWrong);
    expect(db.pending()?.close_event_timestamp_ms).toBeNull();

    await send(webhook, "จบรายการชั่งคืน", 1_300);
    expect(db.pending()?.close_event_timestamp_ms).toBe(1_300);
    const closedAt = db.pending()?.close_event_timestamp_ms;
    await send(webhook, "จบรายการชั่งคืน", 1_400);
    expect(db.pending()?.close_event_timestamp_ms).toBe(closedAt);
  });

  it("does not append an incomplete closer into the draft", async () => {
    const db = new RecoveryDatabase();
    const replies: string[] = [];
    const webhook = service(db, replies);
    await send(webhook, RETURN_HEADER, 1_000);
    await send(webhook, itemMessage(1), 1_100);
    const before = String(db.pending()?.accumulated_text);
    await send(webhook, "จบราย", 1_200);
    expect(replies.at(-1)).toContain("คำสั่งปิดรายการไม่ครบ");
    expect(db.pending()?.accumulated_text).toBe(before);
    expect(db.pending()?.close_event_timestamp_ms).toBeNull();
  });
});

describe("recovery idempotency", () => {
  it("treats a webhook retry of the same recover event as a duplicate", async () => {
    const db = new RecoveryDatabase();
    const replies: string[] = [];
    const webhook = service(db, replies);
    seedDeferred(db, 3, "rejected_before_opener");
    await send(webhook, HEADER, 1_000);
    const recoverEvent = textEvent(RECOVER_LATEST_COMMAND, 1_100, { eventId: "recover-same" });
    const first = await webhook.processEvents([recoverEvent], "destination");
    const second = await webhook.processEvents([recoverEvent], "destination");
    expect(first[0]?.status).toBe("saved");
    expect(second[0]?.status).toBe("duplicate");
    expect(parsedItemCount(db)).toBe(3);
  });

  it("lets concurrent recoveries produce one effective winner", async () => {
    const db = new RecoveryDatabase();
    const replies: string[] = [];
    const webhook = service(db, replies);
    seedDeferred(db, 5, "rejected_before_opener");
    await send(webhook, HEADER, 1_000);
    await Promise.all([
      send(webhook, RECOVER_LATEST_COMMAND, 1_100, { eventId: "recover-a" }),
      send(webhook, RECOVER_LATEST_COMMAND, 1_101, { eventId: "recover-b" }),
    ]);
    expect(parsedItemCount(db)).toBe(5);
    expect(db.recoverable()).toHaveLength(0);
  });

  it("can finish a partial replay without duplicating already appended items", async () => {
    const db = new RecoveryDatabase();
    seedDeferred(db, 4, "rejected_before_opener");
    const replies: string[] = [];
    const webhook = service(db, replies);
    await send(webhook, HEADER, 1_000);
    db.appendFailAfter = 2;
    await expect(send(webhook, RECOVER_LATEST_COMMAND, 1_100)).rejects.toThrow("injected append crash");
    expect(parsedItemCount(db)).toBe(2);
    expect(db.recoverable().length).toBeGreaterThan(0);
    db.appendFailAfter = null;
    await send(webhook, RECOVER_LATEST_COMMAND, 1_200);
    expect(parsedItemCount(db)).toBe(4);
    expect(db.recoverable()).toHaveLength(0);
  });

  it("marks each event admitted as it is recovered — no manual cleanup after a partial crash", async () => {
    // Closes the known PR #82 limitation: a non-boundary error partway
    // through recovery used to leave already-appended events' deferred rows
    // permanently at 'waiting'/'rejected_*', which the finalization guard
    // trigger reads as unresolved forever unless an operator hand-fixes the
    // row. recoverDeferredEvent (20260825090000) commits the append and the
    // status flip together, so this must already be true with NO manual fixup.
    const db = new RecoveryDatabase();
    seedDeferred(db, 4, "rejected_before_opener");
    const replies: string[] = [];
    const webhook = service(db, replies);
    await send(webhook, HEADER, 1_000);
    db.appendFailAfter = 2;
    await expect(send(webhook, RECOVER_LATEST_COMMAND, 1_100)).rejects.toThrow("injected append crash");
    const appended = db.rows("pending_session_ingest")
      .filter((row) => String(row.line_event_id).startsWith("rejected_before_opener-"));
    expect(appended).toHaveLength(2);
    // No manual Object.assign here — the first two deferred rows must already
    // read 'admitted' purely from the crashed recovery attempt.
    expect(db.deferred().slice(0, 2).every((row) => row.status === "admitted")).toBe(true);
    expect(db.recoverable().map((row) => row.line_event_id)).toEqual([
      "rejected_before_opener-3",
      "rejected_before_opener-4",
    ]);
    db.appendFailAfter = null;
    db.appendCalls = 0;
    await send(webhook, RECOVER_LATEST_COMMAND, 1_200);
    expect(parsedItemCount(db)).toBe(4);
    expect(db.recoverable()).toHaveLength(0);
    await send(webhook, RECOVER_LATEST_COMMAND, 1_300);
    expect(parsedItemCount(db)).toBe(4);
    expect(replies.at(-1)).toContain("ไม่มีรายการที่กู้ได้");
  });
});

describe("Production-shaped retained clusters", () => {
  it.each([16, 11, 6])(
    "recovers a %s-message cluster without retyping when attribution is deterministic",
    async (count) => {
      const db = new RecoveryDatabase();
      const replies: string[] = [];
      const webhook = service(db, replies);
      // A real after_close bundle only exists because a real header closed —
      // seed that origin explicitly so provenance reconstruction succeeds
      // and matches the header the operator reopens with below.
      const originGeneration = "prod-origin-generation";
      db.insert("pending_session_ingest", {
        session_key: SESSION_KEY,
        session_generation: originGeneration,
        line_event_id: "prod-opener",
        line_timestamp_ms: 500,
        raw_text: HEADER,
      }, "insert");
      seedDeferred(db, count, "rejected_after_close", {
        close_line_event_id: "close-prod",
        session_generation: originGeneration,
        opener_line_event_id: "prod-opener",
      });
      await send(webhook, HEADER, 1_000);
      await send(webhook, RECOVER_LATEST_COMMAND, 1_100);
      expect(parsedItemCount(db)).toBe(count);
      expect(db.deferred().every((row) => row.status === "admitted")).toBe(true);
      expect(db.rows("raw_messages").some((row) => row.raw_text === RECOVER_LATEST_COMMAND)).toBe(true);
      expect(replies.at(-1)).toContain(`กู้แล้ว ${count} ข้อความ`);
    },
  );
});

describe("PendingSessionService recovery helpers", () => {
  it("lists only same-environment recoverable rows", async () => {
    const db = new RecoveryDatabase();
    seedDeferred(db, 2, "rejected_before_opener");
    db.deferred()[0]!.runtime_environment = "production";
    const rows = await new PendingSessionService(db as never)
      .listRecoverableDeferredEvents(SESSION_KEY);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.line_event_id).toBe("rejected_before_opener-2");
  });
});
