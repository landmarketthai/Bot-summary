/**
 * "ยกเลิกรายการ" — abandoning the draft, end to end through the webhook.
 *
 * The routing is the whole point. The command is intercepted as the FIRST thing
 * inside the pending branch, so it can never be appended, never become an item,
 * never become a header and never be read as a close. Everything it is allowed
 * to do is decided by the database; this layer only routes and reports.
 */
import { describe, expect, it } from "bun:test";
import { WebhookService } from "./webhook-service";
import type { LineMessageEvent } from "./types";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import {
  CANCEL_ACTIVE_DRAFT_COMMAND,
  CANCEL_ACTIVE_DRAFT_HINT,
  CANCEL_ACTIVE_DRAFT_NONE_REPLY,
  CANCEL_ACTIVE_DRAFT_REFUSED_REPLY,
  CANCEL_ACTIVE_DRAFT_SUCCESS_REPLY,
  CANCEL_ACTIVE_DRAFT_UNAVAILABLE_REASON,
  CANCEL_ACTIVE_DRAFT_UNAVAILABLE_REPLY,
  cancelActiveProduceDraft,
  isExactCancelActiveDraftCommand,
  withCancelActiveDraftHint,
} from "@/lib/produce/cancel-active-draft";

type Row = Record<string, unknown>;

const SESSION_KEY = "group:group-1:user:user-1";
const GENERATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROUND = "11111111-1111-4111-8111-111111111111";
const PRODUCE_CLOSE_PENDING_REPLY =
  "รับจบรายการแล้ว กำลังตรวจสอบรายการที่ยังส่งมาไม่ถึง กรุณารอสักครู่";
const RETURN_HEADER = "ดำ-ราชพฤกษ์ ชั่งคืน 11/8/2569";

interface Review {
  digest: string;
  presented_line_event_id: string;
  confirmed_at: string | null;
}

class CancelDatabase {
  reviews: Review[] = [];
  /** Every RPC name this run reached, in order. */
  rpcCalls: string[] = [];
  cancelArgs: Row[] = [];
  /** Scripted answer for the cancellation RPC. */
  cancelOutcome: Row = { cancelled: true, reason: "cancelled", round_outcome: "cancelled" };
  cancelError: string | null = null;
  /** PostgREST/PG error code paired with cancelError, when the test needs one. */
  cancelErrorCode: string | null = null;
  bindOutcome: Row = { outcome: "bound", accountability_round_id: ROUND };
  tables: Record<string, Row[]> = {
    pending_sessions: [],
    produce_transactions: [],
    raw_messages: [],
  };

  constructor(pending: Row | null, master: Row[] = []) {
    this.tables.pending_sessions = pending ? [pending] : [];
    this.tables.produce_transactions = master;
  }

  get pending(): Row | undefined {
    return this.tables.pending_sessions[0];
  }

  rows(table: string): Row[] {
    return this.tables[table] ?? [];
  }

  from(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    let updatePayload: Row | null = null;
    const source = () =>
      table === "produce_entry_validation_reviews"
        ? (this.reviews as unknown as Row[])
        : this.rows(table);
    const matching = () => source().filter((row) => filters.every((f) => f(row)));
    const applyUpdate = () => {
      const rows = matching();
      if (updatePayload) {
        for (const row of rows) Object.assign(row, updatePayload);
      }
      return rows;
    };
    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return builder;
      },
      limit: () => builder,
      order: () => builder,
      maybeSingle: async () => ({
        data: applyUpdate()[0] ?? null,
        error: null,
      }),
      single: async () => ({
        data: applyUpdate()[0] ?? null,
        error: null,
      }),
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
        Promise.resolve({
          data: applyUpdate(),
          error: null,
        }).then(resolve),
      insert: (payload: Row) => ({
        select: () => ({
          single: async () => {
            // raw_messages carries UNIQUE(line_event_id) since 0001. This is the
            // PRIMARY defence against a redelivered LINE event: the duplicate
            // never reaches a handler at all.
            if (
              table === "raw_messages"
              && this.rows(table).some(
                (row) => row.line_event_id === payload.line_event_id,
              )
            ) {
              return { data: null, error: { code: "23505", message: "duplicate key" } };
            }
            const row = { id: `raw-${this.rows(table).length + 1}`, ...payload };
            this.tables[table] = [...this.rows(table), row];
            return { data: row, error: null };
          },
        }),
      }),
      update: (payload: Row) => {
        updatePayload = payload;
        return builder;
      },
    };
    return builder;
  }

  rpc = async (name: string, args: Row) => {
    this.rpcCalls.push(name);
    if (name === "cancel_active_pending_produce_draft") {
      this.cancelArgs.push(args);
      if (this.cancelError) {
        return {
          data: null,
          error: { message: this.cancelError, code: this.cancelErrorCode },
        };
      }
      if (
        this.pending
        && typeof this.pending.plain_text_opened_line_timestamp_ms === "number"
        && typeof args.p_line_timestamp_ms === "number"
        && args.p_line_timestamp_ms <= this.pending.plain_text_opened_line_timestamp_ms
      ) {
        return {
          data: { cancelled: false, reason: "event_before_opener" },
          error: null,
        };
      }
      if (this.cancelOutcome.cancelled === true && this.pending) {
        // What the real RPC does, in the only respects this layer can observe.
        this.pending.terminalized = true;
        this.pending.finalization_status = "failed_closed";
        this.pending.finalization_error = {
          reason: "user_cancelled",
          cancel_line_event_id: args.p_line_event_id,
        };
      }
      return { data: this.cancelOutcome, error: null };
    }
    if (name === "bind_plain_text_accountability_round") {
      return { data: this.bindOutcome, error: null };
    }
    if (name === "record_produce_validation_review") {
      const digest = args.p_validation_digest as string;
      let review = this.reviews.find((r) => r.digest === digest);
      if (!review) {
        review = {
          digest,
          presented_line_event_id: args.p_line_event_id as string,
          confirmed_at: null,
        };
        this.reviews.push(review);
      }
      return {
        data: {
          confirmed: review.confirmed_at !== null,
          presented_line_event_id: review.presented_line_event_id,
        },
        error: null,
      };
    }
    if (name === "confirm_produce_validation_review") {
      const review = this.reviews.find((r) => r.digest === args.p_validation_digest);
      if (!review) return { data: { status: "not_found" }, error: null };
      if (review.confirmed_at) return { data: { status: "already_confirmed" }, error: null };
      review.confirmed_at = new Date().toISOString();
      return { data: { status: "confirmed" }, error: null };
    }
    if (
      name === "admit_pending_session_event"
      || name === "register_pending_session_ingest"
      || name === "mark_plain_text_close_refused"
    ) {
      return { data: { marked: true }, error: null };
    }
    if (name === "append_pending_session") {
      const pending = this.pending!;
      if (args.p_mark_close) {
        pending.close_event_timestamp_ms = args.p_line_timestamp_ms;
        pending.close_line_event_id = args.p_line_event_id;
        pending.close_session_generation = pending.session_generation;
      }
      pending.accumulated_text = `${pending.accumulated_text}\n${args.p_new_text}`;
      return { data: { accepted: true, reason: "appended", session: pending }, error: null };
    }
    throw new Error(`Unexpected RPC: ${name}`);
  };
}

function pendingRow(accumulatedText: string, overrides: Row = {}): Row {
  const now = new Date().toISOString();
  return {
    id: "pending-1",
    session_key: SESSION_KEY,
    source_id: "group-1",
    session_generation: GENERATION,
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
    accountability_round_id: null,
    entry_origin: null,
    ...overrides,
  };
}

function master(rows: Array<Partial<Row>>): Row[] {
  return rows.map((row) => ({
    accountability_round_id: ROUND,
    product_name: "มังคุด",
    unit: "โล",
    quantity: 10,
    price_per_unit: 45,
    transaction_type: "เบิก",
    ...row,
  }));
}

function textEvent(text: string, eventId: string, timestamp = Date.now()): LineMessageEvent {
  return {
    type: "message",
    timestamp,
    source: { type: "group", groupId: "group-1", userId: "user-1" },
    replyToken: `reply-${eventId}`,
    webhookEventId: eventId,
    message: { id: `msg-${eventId}`, type: "text", text },
  } as unknown as LineMessageEvent;
}

function build(db: CancelDatabase, replies: string[]) {
  return new WebhookService(db as never, {
    replyMessage: async (_token, text) => { replies.push(text); },
  });
}

const WITHDRAWAL = ["ดำ-ราชพฤกษ์ เบิก 11/8/2569", "1.มังคุด45บาท", "10โล"].join("\n");

describe("the exact cancel command", () => {
  it("matches only the exact command, trimmed", () => {
    expect(isExactCancelActiveDraftCommand("ยกเลิกรายการ")).toBe(true);
    expect(isExactCancelActiveDraftCommand("  ยกเลิกรายการ \n")).toBe(true);
    // Each of these already means something else and must stay untouched.
    expect(isExactCancelActiveDraftCommand("ยกเลิก")).toBe(false);
    expect(isExactCancelActiveDraftCommand("ออกจากเมนู")).toBe(false);
    expect(isExactCancelActiveDraftCommand("ยกเลิกซื้อ")).toBe(false);
    expect(isExactCancelActiveDraftCommand("ยกเลิกใบขาวมือ")).toBe(false);
    // No fuzzy match, no prefix match, no embedding in a longer message.
    expect(isExactCancelActiveDraftCommand("ยกเลิกรายการนี้")).toBe(false);
    expect(isExactCancelActiveDraftCommand("ขอยกเลิกรายการ")).toBe(false);
    expect(isExactCancelActiveDraftCommand("ยกเลิกรายการ ครับ")).toBe(false);
    expect(isExactCancelActiveDraftCommand("")).toBe(false);
  });
});

describe("cancelling the active draft", () => {
  it("cancels the draft the same event would otherwise have been appended to", async () => {
    const row = pendingRow(WITHDRAWAL);
    const db = new CancelDatabase(row);
    const replies: string[] = [];
    const event = textEvent(CANCEL_ACTIVE_DRAFT_COMMAND, "cancel-1", 2001);
    await build(db, replies).processEvents(
      [event],
      "dest",
    );

    expect(replies).toEqual([CANCEL_ACTIVE_DRAFT_SUCCESS_REPLY]);
    expect(db.cancelArgs).toHaveLength(1);
    // The snapshot and generation come from the ALREADY-RESOLVED row; the row
    // is never re-read to obtain them.
    expect(db.cancelArgs[0]!.p_session_key).toBe(SESSION_KEY);
    expect(db.cancelArgs[0]!.p_session_generation).toBe(GENERATION);
    expect(db.cancelArgs[0]!.p_expected_updated_at).toBe(row.updated_at);
    expect(db.cancelArgs[0]!.p_line_timestamp_ms).toBe(event.timestamp);
    expect(db.cancelArgs[0]!.p_source_id).toBe("group-1");
    expect(db.cancelArgs[0]!.p_line_event_id).toBe("cancel-1");
    expect(db.cancelArgs[0]!.p_runtime_environment).toBe("development");
  });

  it("never lets the command reach the text — not appended, not an item, not a header", async () => {
    const db = new CancelDatabase(pendingRow(WITHDRAWAL));
    await build(db, []).processEvents(
      [textEvent(CANCEL_ACTIVE_DRAFT_COMMAND, "cancel-2")],
      "dest",
    );

    expect(db.pending!.accumulated_text).toBe(WITHDRAWAL);
    expect(String(db.pending!.accumulated_text)).not.toContain(CANCEL_ACTIVE_DRAFT_COMMAND);
    // No append, no reorder admission, no generation rotation, no close.
    expect(db.rpcCalls).toEqual(["receive_line_webhook_event", "cancel_active_pending_produce_draft"]);
    expect(db.pending!.close_event_timestamp_ms).toBeNull();
    expect(db.pending!.close_line_event_id).toBeNull();
    expect(db.pending!.session_generation).toBe(GENERATION);
  });

  it("cancels a structured (guided) draft through the same one primitive", async () => {
    const db = new CancelDatabase(
      pendingRow(WITHDRAWAL, { entry_origin: "structured_menu" }),
    );
    const replies: string[] = [];
    await build(db, replies).processEvents(
      [textEvent(CANCEL_ACTIVE_DRAFT_COMMAND, "cancel-3")],
      "dest",
    );

    expect(replies).toEqual([CANCEL_ACTIVE_DRAFT_SUCCESS_REPLY]);
    expect(db.rpcCalls).toEqual(["receive_line_webhook_event", "cancel_active_pending_produce_draft"]);
    expect(db.pending!.accumulated_text).toBe(WITHDRAWAL);
  });

  it("reports a database refusal honestly and mutates nothing", async () => {
    for (const reason of ["close_in_progress", "generation_conflict", "draft_changed"]) {
      const db = new CancelDatabase(pendingRow(WITHDRAWAL));
      db.cancelOutcome = { cancelled: false, reason };
      const replies: string[] = [];
      await build(db, replies).processEvents(
        [textEvent(CANCEL_ACTIVE_DRAFT_COMMAND, `refuse-${reason}`)],
        "dest",
      );

      expect(replies).toEqual([CANCEL_ACTIVE_DRAFT_REFUSED_REPLY]);
      expect(replies[0]).not.toContain("✅");
      expect(db.pending!.terminalized).toBe(false);
      expect(db.pending!.accumulated_text).toBe(WITHDRAWAL);
      expect(db.rpcCalls).toEqual(["receive_line_webhook_event", "cancel_active_pending_produce_draft"]);
    }
  });

  it("never reports success when the RPC itself failed", async () => {
    const db = new CancelDatabase(pendingRow(WITHDRAWAL));
    db.cancelError = "permission denied for function cancel_active_pending_produce_draft";
    const replies: string[] = [];
    await build(db, replies).processEvents(
      [textEvent(CANCEL_ACTIVE_DRAFT_COMMAND, "cancel-err")],
      "dest",
    );

    expect(replies).toEqual([CANCEL_ACTIVE_DRAFT_REFUSED_REPLY]);
    expect(db.pending!.terminalized).toBe(false);
  });

  it("says the feature is unavailable — not 'try again' — when the RPC is missing", async () => {
    // App deployed ahead of its migration. The generic refusal tells the
    // operator to retry, which CANNOT succeed until the migration lands, so
    // they would retry forever. PG 42883 = function does not exist; PostgREST
    // answers PGRST202 when no function matches the posted arguments — the same
    // narrow pair src/lib/line/pending-close-recovery.ts detects.
    for (const code of ["42883", "PGRST202"]) {
      const db = new CancelDatabase(pendingRow(WITHDRAWAL));
      db.cancelError = "Could not find the function public.cancel_active_pending_produce_draft";
      db.cancelErrorCode = code;
      const replies: string[] = [];
      await build(db, replies).processEvents(
        [textEvent(CANCEL_ACTIVE_DRAFT_COMMAND, `missing-${code}`)],
        "dest",
      );

      expect(replies).toEqual([CANCEL_ACTIVE_DRAFT_UNAVAILABLE_REPLY]);
      // Distinct from the busy refusal, and never a success.
      expect(replies[0]).not.toBe(CANCEL_ACTIVE_DRAFT_REFUSED_REPLY);
      expect(replies[0]).not.toContain("✅");
      // Still fail-closed: the draft is untouched and stays capturable.
      expect(db.pending!.terminalized).toBe(false);
      expect(db.pending!.accumulated_text).toBe(WITHDRAWAL);
    }
  });

  it("keeps the generic busy refusal for every other RPC error", async () => {
    const db = new CancelDatabase(pendingRow(WITHDRAWAL));
    db.cancelError = "deadlock detected";
    db.cancelErrorCode = "40P01";
    const replies: string[] = [];
    await build(db, replies).processEvents(
      [textEvent(CANCEL_ACTIVE_DRAFT_COMMAND, "cancel-deadlock")],
      "dest",
    );

    expect(replies).toEqual([CANCEL_ACTIVE_DRAFT_REFUSED_REPLY]);
  });

  it("resolves the missing RPC to a distinct reason, not a leaked message", async () => {
    const outcome = await cancelActiveProduceDraft(
      {
        rpc: async () => ({
          data: null,
          error: { code: "PGRST202", message: "Could not find the function" },
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      {
        sessionKey: SESSION_KEY,
        sessionGeneration: GENERATION,
        expectedUpdatedAt: new Date().toISOString(),
        lineTimestampMs: 2001,
        sourceId: "group-1",
        lineEventId: "evt",
        runtimeEnvironment: "production",
      },
    );
    expect(outcome).toEqual({
      cancelled: false,
      reason: CANCEL_ACTIVE_DRAFT_UNAVAILABLE_REASON,
    });
  });

  it("passes a delayed cancel timestamp so the database cannot cancel the newer draft", async () => {
    const db = new CancelDatabase(
      pendingRow(WITHDRAWAL, { plain_text_opened_line_timestamp_ms: 2000 }),
    );
    const replies: string[] = [];
    const event = textEvent(CANCEL_ACTIVE_DRAFT_COMMAND, "cancel-delayed", 1999);

    await build(db, replies).processEvents([event], "dest");

    expect(replies).toEqual([CANCEL_ACTIVE_DRAFT_REFUSED_REPLY]);
    expect(db.cancelArgs[0]!.p_line_timestamp_ms).toBe(1999);
    expect(db.pending!.terminalized).toBe(false);
    expect(db.pending!.accumulated_text).toBe(WITHDRAWAL);
  });

  it("treats an already_cancelled replay as the success it is", async () => {
    const db = new CancelDatabase(pendingRow(WITHDRAWAL));
    db.cancelOutcome = { cancelled: true, reason: "already_cancelled" };
    const replies: string[] = [];
    await build(db, replies).processEvents(
      [textEvent(CANCEL_ACTIVE_DRAFT_COMMAND, "cancel-replay")],
      "dest",
    );

    expect(replies).toEqual([CANCEL_ACTIVE_DRAFT_SUCCESS_REPLY]);
  });

  it("lets an expired-but-present draft reach the database rather than special-casing it", async () => {
    const stale = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    const db = new CancelDatabase(
      pendingRow(WITHDRAWAL, { created_at: stale, updated_at: stale }),
    );
    const replies: string[] = [];
    await build(db, replies).processEvents(
      [textEvent(CANCEL_ACTIVE_DRAFT_COMMAND, "cancel-expired")],
      "dest",
    );

    expect(db.cancelArgs).toHaveLength(1);
    expect(db.cancelArgs[0]!.p_expected_updated_at).toBe(stale);
    expect(replies).toEqual([CANCEL_ACTIVE_DRAFT_SUCCESS_REPLY]);
  });
});

describe("cancelling with nothing to cancel", () => {
  it("answers plainly and writes nothing at all", async () => {
    const db = new CancelDatabase(null);
    const replies: string[] = [];
    await build(db, replies).processEvents(
      [textEvent(CANCEL_ACTIVE_DRAFT_COMMAND, "cancel-none")],
      "dest",
    );

    expect(replies).toEqual([CANCEL_ACTIVE_DRAFT_NONE_REPLY]);
    // ZERO domain mutation: no pending row is created and the command never
    // reaches a Produce handler. The durable receive RPC is expected.
    expect(db.tables.pending_sessions).toHaveLength(0);
    expect(db.rpcCalls).toEqual(["receive_line_webhook_event"]);
    expect(db.tables.produce_transactions).toHaveLength(0);
  });
});

describe("a redelivered cancel", () => {
  it("short-circuits on the raw_messages unique constraint before any handler runs", async () => {
    const db = new CancelDatabase(pendingRow(WITHDRAWAL));
    const replies: string[] = [];
    const service = build(db, replies);

    const first = await service.processEvents(
      [textEvent(CANCEL_ACTIVE_DRAFT_COMMAND, "cancel-dup")],
      "dest",
    );
    expect(first[0]!.status).toBe("saved");
    expect(db.cancelArgs).toHaveLength(1);

    // LINE redelivers the identical webhook event id.
    const second = await service.processEvents(
      [textEvent(CANCEL_ACTIVE_DRAFT_COMMAND, "cancel-dup")],
      "dest",
    );
    expect(second[0]!.status).toBe("duplicate");
    // processOne was never invoked: no second RPC, no second reply.
    expect(db.cancelArgs).toHaveLength(1);
    expect(replies).toEqual([CANCEL_ACTIVE_DRAFT_SUCCESS_REPLY]);
    expect(db.rows("raw_messages")).toHaveLength(1);
  });
});

describe("the cancel hint", () => {
  it("is not the default recovery path for a blocked item validation", async () => {
    const db = new CancelDatabase(
      pendingRow([RETURN_HEADER, "1.มังคุด45บาท", "4โลก"].join("\n")),
      master([{}]),
    );
    const replies: string[] = [];
    await build(db, replies).processEvents([textEvent("จบรายการชั่งคืน", "hint-1")], "dest");

    expect(replies[0]).toContain("⛔");
    expect(replies[0]).toContain("แก้ข้อ 1");
    expect(replies[0]).not.toContain(CANCEL_ACTIVE_DRAFT_HINT);
    // Still no close boundary: the operator can correct the same draft.
    expect(db.pending!.close_event_timestamp_ms).toBeNull();
  });

  it("is not appended to an accepted price advisory", async () => {
    const db = new CancelDatabase(
      pendingRow([RETURN_HEADER, "1.มังคุด120บาท", "2โล"].join("\n")),
      master([{ price_per_unit: 100, quantity: 5 }]),
    );
    const replies: string[] = [];
    await build(db, replies).processEvents([textEvent("จบรายการชั่งคืน", "hint-2")], "dest");

    expect(replies).toEqual([PRODUCE_CLOSE_PENDING_REPLY]);
    expect(replies[0]).not.toContain(CANCEL_ACTIVE_DRAFT_HINT);
  });

  it("is NEVER appended to an accepted close", async () => {
    const db = new CancelDatabase(pendingRow(WITHDRAWAL));
    const replies: string[] = [];
    await build(db, replies).processEvents([textEvent("จบรายการเบิก", "hint-3")], "dest");

    expect(replies).toEqual([PRODUCE_CLOSE_PENDING_REPLY]);
    expect(replies[0]).not.toContain(CANCEL_ACTIVE_DRAFT_HINT);
    expect(replies[0]).not.toContain(CANCEL_ACTIVE_DRAFT_COMMAND);
  });

  it("is NEVER appended to the cancellation replies themselves", () => {
    for (const reply of [
      CANCEL_ACTIVE_DRAFT_SUCCESS_REPLY,
      CANCEL_ACTIVE_DRAFT_NONE_REPLY,
      CANCEL_ACTIVE_DRAFT_REFUSED_REPLY,
    ]) {
      expect(reply).not.toContain(CANCEL_ACTIVE_DRAFT_HINT);
    }
  });

  it("sits after a blank line and is composed from the one shared constant", () => {
    expect(withCancelActiveDraftHint("เนื้อความ"))
      .toBe(`เนื้อความ\n\n${CANCEL_ACTIVE_DRAFT_HINT}`);
    expect(CANCEL_ACTIVE_DRAFT_HINT).toContain(CANCEL_ACTIVE_DRAFT_COMMAND);
  });
});

describe("same-draft correction replies", () => {
  it("acknowledges an atomic correction and keeps one effective item", async () => {
    const db = new CancelDatabase(pendingRow(WITHDRAWAL));
    const replies: string[] = [];

    await build(db, replies).processEvents([
      textEvent("แก้ข้อ 1\n1.มังคุด40บาท\n12โล", "correction-1"),
    ], "dest");

    const parsed = parseWeighSession(String(db.pending!.accumulated_text));
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toMatchObject({ price_per_unit: 40, quantity: 12 });
    expect(replies.at(-1)).toContain("✅ แก้ข้อ 1 แล้ว");
    expect(replies.at(-1)).toContain("รายการอื่นยังอยู่ครบ");
  });

  it("acknowledges removal while retaining the rest of the draft", async () => {
    const draft = [WITHDRAWAL, "2.ส้ม30บาท", "3โล"].join("\n");
    const db = new CancelDatabase(pendingRow(draft));
    const replies: string[] = [];

    await build(db, replies).processEvents([textEvent("ลบข้อ 1", "remove-1")], "dest");

    const parsed = parseWeighSession(String(db.pending!.accumulated_text));
    expect(parsed.items.map((entry) => entry.item_number)).toEqual([2]);
    expect(replies.at(-1)).toContain("✅ ลบข้อ 1 แล้ว");
    expect(replies.at(-1)).toContain("รายการอื่นยังอยู่ครบ");
  });

  it("refuses an unknown correction target without changing the effective draft", async () => {
    const db = new CancelDatabase(pendingRow(WITHDRAWAL));
    const replies: string[] = [];

    await build(db, replies).processEvents([textEvent("แก้ข้อ 17", "correction-missing")], "dest");

    const parsed = parseWeighSession(String(db.pending!.accumulated_text));
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.item_number).toBe(1);
    expect(replies.at(-1)).toContain("ไม่พบข้อ 17");
    expect(replies.at(-1)).toContain("รายการเดิมยังไม่เปลี่ยนแปลง");
  });
});
