/**
 * P4A completion — the entry gate on the plain-text close, end to end through
 * the webhook.
 *
 * What matters here is the close BOUNDARY: a refused close must not write one,
 * because that is what keeps the session in capture where the corrected line is
 * still an ordinary item message and the original business date survives.
 */
import { describe, expect, it } from "bun:test";
import { WebhookService } from "./webhook-service";
import type { LineMessageEvent } from "./types";

type Row = Record<string, unknown>;

const SESSION_KEY = "group:group-1:user:user-1";
const GENERATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROUND = "11111111-1111-4111-8111-111111111111";
const PRODUCE_CLOSE_PENDING_REPLY =
  "รับจบรายการแล้ว กำลังตรวจสอบรายการที่ยังส่งมาไม่ถึง กรุณารอสักครู่";
const CLOSE_RACED_LATE_ITEM_REPLY =
  "มีรายการส่งเข้ามาเพิ่มพอดีตอนปิดรอบ ระบบยังไม่ได้ปิดรอบ รายการทั้งหมดยังอยู่ครบ กรุณาพิมพ์ปิดรอบอีกครั้ง";

interface Review {
  digest: string;
  presented_line_event_id: string;
  presented_delivered_at: string | null;
  confirmed_at: string | null;
}

class PlainTextGateDatabase {
  reviews: Review[] = [];
  closeRefusals: Array<{
    session_key: string;
    session_generation: string;
    close_line_event_id: string;
    reason: string;
  }> = [];
  /** Non-null makes the stamp RPC resolve with a PostgREST error. */
  closeRefusalError: string | null = null;
  presentationError: string | null = null;
  tables: Record<string, Row[]> = {
    pending_sessions: [],
    produce_transactions: [],
    raw_messages: [],
  };
  /** Scripted answer for the round binding RPC. */
  bindOutcome: Row = { outcome: "bound", accountability_round_id: ROUND };

  constructor(pending: Row, master: Row[]) {
    this.tables.pending_sessions = [pending];
    this.tables.produce_transactions = master;
  }

  get pending(): Row {
    return this.tables.pending_sessions[0]!;
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
          presented_delivered_at: null,
          confirmed_at: null,
        };
        this.reviews.push(review);
      }
      return {
        data: {
          confirmed: review.confirmed_at !== null,
          presented_line_event_id: review.presented_line_event_id,
          presented_delivered: review.presented_delivered_at !== null,
        },
        error: null,
      };
    }
    if (name === "confirm_produce_validation_review") {
      const review = this.reviews.find((r) => r.digest === args.p_validation_digest);
      if (!review) return { data: { status: "not_found" }, error: null };
      if (review.confirmed_at) return { data: { status: "already_confirmed" }, error: null };
      if (!review.presented_delivered_at) {
        return { data: { status: "not_presented" }, error: null };
      }
      if (review.presented_line_event_id === args.p_line_event_id) {
        return { data: { status: "not_found" }, error: null };
      }
      review.confirmed_at = new Date().toISOString();
      return { data: { status: "confirmed" }, error: null };
    }
    if (name === "mark_produce_validation_reviews_presented") {
      if (this.presentationError) {
        return { data: null, error: { message: this.presentationError } };
      }
      const digests = [...new Set(args.p_validation_digests as string[])];
      const reviews = digests.map((digest) => this.reviews.find((row) => row.digest === digest));
      if (reviews.some((review) => !review)) {
        return { data: { status: "unknown_digest", marked: 0 }, error: null };
      }
      let marked = 0;
      for (const review of reviews as Review[]) {
        if (!review.presented_delivered_at) {
          review.presented_delivered_at = new Date().toISOString();
          review.presented_line_event_id = args.p_presented_line_event_id as string;
          marked += 1;
        }
      }
      return { data: { status: "presented", marked }, error: null };
    }
    if (name === "admit_pending_session_event" || name === "register_pending_session_ingest") {
      return { data: null, error: null };
    }
    // P1-B: a refused close must leave durable, generation-scoped state behind,
    // or the generation waits forever with nothing scheduled.
    if (name === "mark_plain_text_close_refused") {
      // A Supabase RPC RESOLVES with { data, error }; it does not throw on a
      // PostgREST error. Model that shape exactly.
      if (this.closeRefusalError) {
        return { data: null, error: { message: this.closeRefusalError } };
      }
      this.closeRefusals.push({
        session_key: args.p_session_key as string,
        session_generation: args.p_session_generation as string,
        close_line_event_id: args.p_close_line_event_id as string,
        reason: args.p_reason as string,
      });
      return { data: { marked: true }, error: null };
    }
    if (name === "append_pending_session") {
      const pending = this.pending;
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

function pendingRow(accumulatedText: string, userId = "user-1"): Row {
  const now = new Date().toISOString();
  return {
    id: "pending-1",
    session_key: userId === "user-1" ? SESSION_KEY : `group:group-1:user:${userId}`,
    source_id: "group-1",
    session_generation: GENERATION,
    accumulated_text: accumulatedText,
    latest_reply_token: null,
    line_user_id: userId,
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

function textEvent(text: string, eventId: string, userId = "user-1"): LineMessageEvent {
  return {
    type: "message",
    timestamp: Date.now(),
    source: { type: "group", groupId: "group-1", userId },
    replyToken: `reply-${eventId}`,
    webhookEventId: eventId,
    message: { id: `msg-${eventId}`, type: "text", text },
  } as unknown as LineMessageEvent;
}

function build(db: PlainTextGateDatabase, replies: string[]) {
  return new WebhookService(db as never, {
    replyMessage: async (_token, text) => { replies.push(text); },
  });
}

const RETURN_HEADER = "ดำ-ราชพฤกษ์ ชั่งคืน 11/8/2569";

describe("P4A on the plain-text close", () => {
  it.each([
    ["ดำ-ราชพฤกษ์ เบิก 11/8/2569", "จบรายการชั่งคืน", "รายการเบิก", "จบรายการเบิก"],
    ["ดำ-ราชพฤกษ์ คืนเสีย 11/8/2569", "จบรายการเบิก", "รายการคืนเสีย", "จบรายการคืนเสีย"],
    ["ดำ-ราชพฤกษ์ คืนเสีย 11/8/2569", "จบรายการชั่งคืน", "รายการคืนเสีย", "จบรายการคืนเสีย"],
  ])("rejects %s with %s without touching pending state", async (
    header,
    closer,
    activeLabel,
    expectedCloser,
  ) => {
    const db = new PlainTextGateDatabase(
      pendingRow([header, "1.มังคุด45บาท", "4โล"].join("\n")),
      master([{}]),
    );
    const before = { ...db.pending };
    const replies: string[] = [];

    await build(db, replies).processEvents([textEvent(closer, `cross-${closer}`)], "dest");

    expect(replies[0]).toContain(activeLabel);
    expect(replies[0]).toContain(expectedCloser);
    expect(db.pending).toEqual(before);
    expect(db.closeRefusals).toEqual([]);
  });

  it("blocks an unknown unit and leaves the session in capture", async () => {
    const db = new PlainTextGateDatabase(
      pendingRow([RETURN_HEADER, "1.มังคุด45บาท", "4โลก"].join("\n")),
      master([{}]),
    );
    const replies: string[] = [];
    await build(db, replies).processEvents([textEvent("จบรายการชั่งคืน", "close-1")], "dest");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("⛔");
    expect(replies[0]).toContain("โลก");
    expect(replies[0]).toContain("โล");
    // The whole point: no close boundary, so the round is still open for a fix.
    expect(db.pending.close_event_timestamp_ms).toBeNull();
    expect(db.pending.close_line_event_id).toBeNull();
  });

  it("accepts the close once the corrected line is sent into the same capture", async () => {
    const db = new PlainTextGateDatabase(
      pendingRow([RETURN_HEADER, "1.มังคุด45บาท", "4โล"].join("\n")),
      master([{}]),
    );
    const replies: string[] = [];
    await build(db, replies).processEvents([textEvent("จบรายการชั่งคืน", "close-2")], "dest");

    expect(replies).toEqual([PRODUCE_CLOSE_PENDING_REPLY]);
    expect(db.pending.close_line_event_id).toBe("close-2");
    // The header, and therefore the original business date, never moved.
    expect(String(db.pending.accumulated_text)).toContain("11/8/2569");
  });

  it("blocks a return that exceeds what the round withdrew", async () => {
    const db = new PlainTextGateDatabase(
      pendingRow([RETURN_HEADER, "1.มังคุด45บาท", "12โล"].join("\n")),
      master([{}]),
    );
    const replies: string[] = [];
    await build(db, replies).processEvents([textEvent("จบรายการชั่งคืน", "close-3")], "dest");

    expect(replies[0]).toContain("⛔");
    expect(replies[0]).toContain("เกิน");
    expect(db.pending.close_event_timestamp_ms).toBeNull();
  });

  it("cross-user binding reaches P4A and blocks a product absent from the withdrawal", async () => {
    const actor = "user-B";
    const db = new PlainTextGateDatabase(
      pendingRow([RETURN_HEADER, "1.ทุเรียน45บาท", "4โล"].join("\n"), actor),
      master([{}]),
    );
    const before = db.tables.produce_transactions.length;
    const replies: string[] = [];
    await build(db, replies).processEvents([
      textEvent("จบรายการชั่งคืน", "close-cross-user", actor),
    ], "dest");

    expect(replies[0]).not.toContain("ไม่พบรอบเบิกของรายการนี้");
    expect(replies[0]).toContain("ทุเรียน");
    expect(replies[0]).toContain("ไม่พบในรายการเบิกของรอบนี้");
    expect(db.pending.close_event_timestamp_ms).toBeNull();
    expect(db.tables.produce_transactions).toHaveLength(before);
  });

  it("accepts a changed price on the first close without a review record", async () => {
    const db = new PlainTextGateDatabase(
      pendingRow([RETURN_HEADER, "1.มังคุด120บาท", "2โล"].join("\n")),
      master([{ price_per_unit: 100, quantity: 5 }]),
    );
    const replies: string[] = [];
    const service = build(db, replies);

    await service.processEvents([textEvent("จบรายการชั่งคืน", "close-4")], "dest");
    expect(replies).toEqual([PRODUCE_CLOSE_PENDING_REPLY]);
    expect(db.reviews).toHaveLength(0);
    expect(db.pending.close_line_event_id).toBe("close-4");
  });

  it("does not stamp a price advisory as a refused close", async () => {
    const db = new PlainTextGateDatabase(
      pendingRow([RETURN_HEADER, "1.มังคุด120บาท", "2โล"].join("\n")),
      master([{ price_per_unit: 100, quantity: 5 }]),
    );
    const replies: string[] = [];
    await build(db, replies).processEvents([textEvent("จบรายการชั่งคืน", "close-5")], "dest");

    expect(replies).toEqual([PRODUCE_CLOSE_PENDING_REPLY]);
    expect(db.reviews).toHaveLength(0);
    expect(db.pending.close_event_timestamp_ms).not.toBeNull();
    expect(db.closeRefusals).toEqual([]);
  });

  it("refuses a return with no withdrawal round rather than finalizing it unbound", async () => {
    const db = new PlainTextGateDatabase(
      pendingRow([RETURN_HEADER, "1.มังคุด45บาท", "4โล"].join("\n")),
      [],
    );
    db.bindOutcome = { outcome: "no_round" };
    const replies: string[] = [];
    await build(db, replies).processEvents([textEvent("จบรายการชั่งคืน", "close-6")], "dest");

    expect(replies[0]).toContain("ไม่พบรอบเบิกของรายการนี้");
    expect(db.pending.close_event_timestamp_ms).toBeNull();
  });

  it("refuses when two open rounds share the same seller, market and date", async () => {
    const db = new PlainTextGateDatabase(
      pendingRow([RETURN_HEADER, "1.มังคุด45บาท", "4โล"].join("\n")),
      [],
    );
    db.bindOutcome = { outcome: "ambiguous" };
    const replies: string[] = [];
    await build(db, replies).processEvents([textEvent("จบรายการชั่งคืน", "close-7")], "dest");

    expect(replies[0]).toContain("มากกว่า 1 รอบ");
    expect(db.pending.close_event_timestamp_ms).toBeNull();
  });

  it("lets a clean withdrawal close exactly as before", async () => {
    const db = new PlainTextGateDatabase(
      pendingRow(["ดำ-ราชพฤกษ์ เบิก 11/8/2569", "1.มังคุด45บาท", "10โล"].join("\n")),
      [],
    );
    const replies: string[] = [];
    await build(db, replies).processEvents([textEvent("จบรายการเบิก", "close-8")], "dest");

    expect(replies).toEqual([PRODUCE_CLOSE_PENDING_REPLY]);
    expect(db.pending.close_line_event_id).toBe("close-8");
    // P1-B: a close that DID schedule is never stamped as refused.
    expect(db.closeRefusals).toEqual([]);
  });

  it("shows the exact close CTA, then finalizes the unchanged name on second close", async () => {
    const db = new PlainTextGateDatabase(
      pendingRow([
        "ดำ-ราชพฤกษ์ เบิก 11/8/2569",
        "4.มะม่วง20บาท",
        "1โล",
      ].join("\n")),
      [],
    );
    const replies: string[] = [];
    const service = build(db, replies);

    await service.processEvents([textEvent("จบรายการเบิก", "review-close-1")], "dest");

    expect(replies.at(-1)).toContain("✅ ถ้าชื่อนี้ถูกต้องและต้องการบันทึกตามที่พิมพ์");
    expect(replies.at(-1)).toContain("ส่ง “จบรายการเบิก” อีกครั้ง");
    expect(replies.at(-1)).toContain("ส่ง “แก้ข้อ 4”");
    expect(db.pending.close_line_event_id).toBeNull();
    expect(db.reviews).toHaveLength(1);
    expect(db.reviews[0]?.confirmed_at).toBeNull();
    expect(db.reviews[0]?.presented_delivered_at).not.toBeNull();
    expect(db.reviews[0]?.presented_line_event_id).toBe("review-close-1");
    expect(db.pending.accumulated_text).not.toContain("จบรายการเบิก");

    await service.processEvents([textEvent("จบรายการเบิก", "review-close-2")], "dest");

    expect(replies.at(-1)).toBe(PRODUCE_CLOSE_PENDING_REPLY);
    expect(db.pending.close_line_event_id).toBe("review-close-2");
    expect(db.reviews[0]?.confirmed_at).not.toBeNull();
  });

  it("keeps the review identity stable when the first close event is redelivered", async () => {
    const original = [
      "ดำ-ราชพฤกษ์ เบิก 11/8/2569",
      "4.มะม่วง20บาท",
      "1โล",
    ].join("\n");
    const db = new PlainTextGateDatabase(pendingRow(original), []);
    const replies: string[] = [];
    const service = build(db, replies);

    await service.processEvents([textEvent("จบรายการเบิก", "duplicate-close")], "dest");
    const digest = db.reviews[0]?.digest;
    await service.processEvents([textEvent("จบรายการเบิก", "duplicate-close")], "dest");

    expect(db.pending.accumulated_text).toBe(original);
    expect(db.reviews.map((review) => review.digest)).toEqual([digest]);
    expect(db.reviews[0]?.confirmed_at).toBeNull();

    await service.processEvents([textEvent("จบรายการเบิก", "distinct-close")], "dest");
    expect(db.reviews[0]?.confirmed_at).not.toBeNull();
    expect(db.pending.close_line_event_id).toBe("distinct-close");
  });

  it("recovers from a failed delivery stamp without growing review rows", async () => {
    const original = [
      "ดำ-ราชพฤกษ์ เบิก 11/8/2569",
      "4.มะม่วง20บาท",
      "1โล",
    ].join("\n");
    const db = new PlainTextGateDatabase(pendingRow(original), []);
    db.presentationError = "temporary database failure";
    const replies: string[] = [];
    const service = build(db, replies);

    await service.processEvents([textEvent("จบรายการเบิก", "failed-stamp")], "dest");
    expect(db.reviews).toHaveLength(1);
    expect(db.reviews[0]?.presented_delivered_at).toBeNull();

    db.presentationError = null;
    await service.processEvents([textEvent("จบรายการเบิก", "re-present")], "dest");
    expect(db.reviews).toHaveLength(1);
    expect(db.reviews[0]?.presented_delivered_at).not.toBeNull();
    expect(db.reviews[0]?.presented_line_event_id).toBe("re-present");
    expect(db.reviews[0]?.confirmed_at).toBeNull();

    await service.processEvents([textEvent("จบรายการเบิก", "confirm-after-recovery")], "dest");
    expect(db.reviews[0]?.confirmed_at).not.toBeNull();
    expect(db.pending.close_line_event_id).toBe("confirm-after-recovery");
  });

  it("invalidates a delivered review when the Produce document changes", async () => {
    const db = new PlainTextGateDatabase(pendingRow([
      "ดำ-ราชพฤกษ์ เบิก 11/8/2569",
      "4.มะม่วง20บาท",
      "1โล",
    ].join("\n")), []);
    const replies: string[] = [];
    const service = build(db, replies);

    await service.processEvents([textEvent("จบรายการเบิก", "before-change")], "dest");
    const oldDigest = db.reviews[0]!.digest;
    db.pending.accumulated_text = `${db.pending.accumulated_text}\n5.ฝรั่ง30บาท\n1โล`;
    db.pending.ingest_revision = 1;

    await service.processEvents([textEvent("จบรายการเบิก", "after-change")], "dest");
    expect(db.reviews).toHaveLength(2);
    expect(db.reviews[1]?.digest).not.toBe(oldDigest);
    expect(db.reviews[0]?.confirmed_at).toBeNull();
    expect(db.reviews[1]?.confirmed_at).toBeNull();
    expect(db.pending.close_event_timestamp_ms).toBeNull();
  });
});

/**
 * 2026-09-19 — false-missing on a forwarded session (items 1-25 all present,
 * arrival order after 15 was 24,16,25,17,20,18,19,21,23,22).
 *
 * The entry gate's item-number-gap check itself is order-independent (it
 * reads the operator's printed numbers into a Set, not a sequence — see
 * item-number-gap.test.ts). What can still fabricate a gap is the SAME
 * straggler race #108/#118 already guard: the gate evaluates a snapshot
 * captured before its own async round-binding work, and a same-generation
 * append can land while that work is in flight. The existing guard only
 * checked whether ingest_revision moved; it never confirmed the move
 * actually cleared the gap, so an unrelated append (or a partial one) could
 * either wrongly excuse a real gap or — the case this file did not cover —
 * wrongly leave a NOW-COMPLETE document blocked. This section pins the fix:
 * completeness is recomputed from the live snapshot, not inferred from the
 * revision counter.
 */
describe("close gate completeness — recomputed from the live snapshot, not arrival order", () => {
  /** A ชั่งเบิก withdrawal whose lines carry exactly the given printed numbers. */
  function withdrawalText(numbers: number[]): string {
    const lines = ["ดำ-ราชพฤกษ์ เบิก 11/8/2569"];
    for (const n of numbers) lines.push(`${n}.มังคุด${90 + n}บาท`, "1โล");
    return lines.join("\n");
  }

  /** Mutates the canonical pending row (a NEW object, not an in-place edit,
   * so a `pending` reference already captured by the running request keeps
   * seeing the old document) the first time the given RPC fires — the same
   * point in the flow where Production's straggler landed: after the gate
   * captured its document, during the round-binding work that follows. */
  function raceRpcResult(db: PlainTextGateDatabase, onFirstRpc: string, mutate: () => void) {
    const original = db.rpc;
    let fired = false;
    db.rpc = async (name, args) => {
      if (!fired && name === onFirstRpc) {
        fired = true;
        mutate();
      }
      return original(name, args);
    };
  }

  it("clears a fabricated gap once the live snapshot actually completes it", async () => {
    // Sent 1..14 and 16 — a genuine hole at 15. It lands mid-flight, closing
    // the gap the gate saw against the stale snapshot.
    const db = new PlainTextGateDatabase(pendingRow(withdrawalText(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16],
    )), []);
    raceRpcResult(db, "bind_plain_text_accountability_round", () => {
      const old = db.pending;
      db.tables.pending_sessions[0] = {
        ...old,
        accumulated_text: `${old.accumulated_text}\n15.มังคุด105บาท\n1โล`,
        ingest_revision: (old.ingest_revision as number) + 1,
      };
    });
    const replies: string[] = [];

    await build(db, replies).processEvents([textEvent("จบรายการเบิก", "close-race-clears")], "dest");

    expect(replies).toEqual([CLOSE_RACED_LATE_ITEM_REPLY]);
    expect(db.pending.close_event_timestamp_ms).toBeNull();
  });

  it("still blocks a genuinely missing item even when something else moves the revision", async () => {
    // Sent 1..14 and 16 — a genuine hole at 15 that never arrives. A
    // DIFFERENT item lands mid-flight (17) — the revision moves, but the
    // hole at 15 is still real.
    const db = new PlainTextGateDatabase(pendingRow(withdrawalText(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16],
    )), []);
    raceRpcResult(db, "bind_plain_text_accountability_round", () => {
      const old = db.pending;
      db.tables.pending_sessions[0] = {
        ...old,
        accumulated_text: `${old.accumulated_text}\n17.มังคุด107บาท\n1โล`,
        ingest_revision: (old.ingest_revision as number) + 1,
      };
    });
    const replies: string[] = [];

    await build(db, replies).processEvents([textEvent("จบรายการเบิก", "close-race-persists")], "dest");

    expect(replies[0]).not.toBe(CLOSE_RACED_LATE_ITEM_REPLY);
    expect(replies[0]).toContain("⛔");
    expect(replies[0]).toContain("ขาดข้อ 15");
    expect(db.pending.close_event_timestamp_ms).toBeNull();
  });

  it("reports no gap for the exact production arrival order (1..15, then 24,16,25,17,20,18,19,21,23,22)", async () => {
    const db = new PlainTextGateDatabase(pendingRow(withdrawalText(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 24, 16, 25, 17, 20, 18, 19, 21, 23, 22],
    )), []);
    const replies: string[] = [];

    await build(db, replies).processEvents([textEvent("จบรายการเบิก", "close-arrival-order")], "dest");

    expect(replies).toEqual([PRODUCE_CLOSE_PENDING_REPLY]);
    expect(db.pending.close_line_event_id).toBe("close-arrival-order");
    expect(db.closeRefusals).toEqual([]);
  });

  it("reports no gap for another arbitrary out-of-order complete set", async () => {
    const db = new PlainTextGateDatabase(pendingRow(withdrawalText(
      [3, 1, 2, 7, 5, 4, 6, 10, 9, 8],
    )), []);
    const replies: string[] = [];

    await build(db, replies).processEvents([textEvent("จบรายการเบิก", "close-scrambled-set")], "dest");

    expect(replies).toEqual([PRODUCE_CLOSE_PENDING_REPLY]);
    expect(db.closeRefusals).toEqual([]);
  });
});

/**
 * P1-B. Production pending 313eaa61 sat non-terminal for hours with the exact
 * close `จบรายการชั่งคืน` in accumulated_text, an unconfirmed review, and
 * close_requested_at / close_deadline_at / next_attempt_at all NULL. Leaving the
 * session in capture is the intended correction window; leaving NO record that a
 * valid close arrived is what made it permanent.
 */
describe("a refused close cannot strand its generation", () => {
  it("stamps the refusal, generation-scoped, without writing a close boundary", async () => {
    const db = new PlainTextGateDatabase(
      pendingRow([RETURN_HEADER, "1.มังคุด45บาท", "4โลก"].join("\n")),
      master([{}]),
    );
    const replies: string[] = [];
    await build(db, replies).processEvents([textEvent("จบรายการชั่งคืน", "close-9")], "dest");

    expect(replies[0]).toContain("⛔");
    expect(db.pending.close_event_timestamp_ms).toBeNull();
    expect(db.closeRefusals).toEqual([{
      session_key: db.pending.session_key as string,
      session_generation: db.pending.session_generation as string,
      close_line_event_id: "close-9",
      reason: "entry_gate_refusal",
    }]);
  });

  it("a rejected stamp is logged, and the operator still gets the refusal", async () => {
    // Supabase resolves RPC failures as { data: null, error } rather than
    // throwing, so a try/catch alone would report this as a successful stamp.
    const db = new PlainTextGateDatabase(
      pendingRow([RETURN_HEADER, "1.มังคุด45บาท", "4โลก"].join("\n")),
      master([{}]),
    );
    db.closeRefusalError = "permission denied for function mark_plain_text_close_refused";
    const replies: string[] = [];
    await build(db, replies).processEvents([textEvent("จบรายการชั่งคืน", "close-11")], "dest");

    expect(db.closeRefusals).toEqual([]);
    // The operator-facing outcome is unchanged: still refused, still no close
    // boundary, still told what to fix.
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("⛔");
    expect(db.pending.close_event_timestamp_ms).toBeNull();
  });

  it("stamps an ambiguous-round refusal too — the จิ้ว shape", async () => {
    const db = new PlainTextGateDatabase(
      pendingRow([RETURN_HEADER, "1.มังคุด45บาท", "4โล"].join("\n")),
      [],
    );
    db.bindOutcome = { outcome: "ambiguous" };
    const replies: string[] = [];
    await build(db, replies).processEvents([textEvent("จบรายการชั่งคืน", "close-10")], "dest");

    expect(replies[0]).toContain("มากกว่า 1 รอบ");
    expect(db.closeRefusals).toHaveLength(1);
    expect(db.closeRefusals[0].close_line_event_id).toBe("close-10");
  });
});
