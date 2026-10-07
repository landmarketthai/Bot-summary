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
    replyMessages: async (_token, texts) => { replies.push(...texts); },
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

  it("allows a measured return that exceeds withdrawal and leaves reconciliation to the financial guard", async () => {
    const db = new PlainTextGateDatabase(
      pendingRow([RETURN_HEADER, "1.มังคุด45บาท", "12โล"].join("\n")),
      master([{}]),
    );
    const replies: string[] = [];
    await build(db, replies).processEvents([textEvent("จบรายการชั่งคืน", "close-3")], "dest");

    expect(replies).toEqual([PRODUCE_CLOSE_PENDING_REPLY]);
    expect(db.pending.close_line_event_id).toBe("close-3");
  });

  it("cross-user binding allows a known product absent from withdrawal as an advisory", async () => {
    const actor = "user-B";
    const db = new PlainTextGateDatabase(
      pendingRow([RETURN_HEADER, "1.ทุเรียน45บาท", "4โล"].join("\n"), actor),
      master([{}]),
    );
    const replies: string[] = [];
    await build(db, replies).processEvents([
      textEvent("จบรายการชั่งคืน", "close-cross-user", actor),
    ], "dest");

    expect(replies).toEqual([PRODUCE_CLOSE_PENDING_REPLY]);
    expect(db.pending.close_line_event_id).toBe("close-cross-user");
    expect(db.tables.produce_transactions).toHaveLength(1);
  });

  it("allows a readable unknown return on the first close without field correction", async () => {
    const db = new PlainTextGateDatabase(
      pendingRow([
        RETURN_HEADER,
        "1.มังคุด45บาท", "4โล",
        "2.พักผ่อน20บาท", "4แพค",
      ].join("\n")),
      master([{}]),
    );
    const replies: string[] = [];
    const service = build(db, replies);

    await service.processEvents([textEvent("จบรายการชั่งคืน", "partial-close-1")], "dest");

    expect(replies).toEqual([PRODUCE_CLOSE_PENDING_REPLY]);
    expect(replies.join("\n")).not.toContain("แก้ข้อ");
    expect(db.pending.close_line_event_id).toBe("partial-close-1");
    expect(db.reviews).toHaveLength(0);
    expect(db.pending.partial_capture).toBeFalsy();
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

  // The only confirmable review left is a risky ขีด/กรัม price basis.
  it("shows the exact close CTA and records the item confirmation", async () => {
    const db = new PlainTextGateDatabase(pendingRow([
      "ดำ-ราชพฤกษ์ เบิก 11/8/2569",
      "4.มะม่วง2ขีด20บาท",
      "1โล",
    ].join("\n")), []);
    const replies: string[] = [];
    const service = build(db, replies);

    await service.processEvents([textEvent("จบรายการเบิก", "review-close-1")], "dest");

    expect(replies.at(-1)).toContain("ยืนยันทีละข้อ: “ยืนยันข้อ 4”");
    expect(replies.at(-1)).toContain("ส่ง “จบรายการเบิก” อีกครั้ง");
    expect(db.pending.close_line_event_id).toBeNull();
    expect(db.reviews[0]?.confirmed_at).toBeNull();
    expect(db.reviews[0]?.presented_delivered_at).not.toBeNull();
    expect(db.reviews[0]?.presented_line_event_id).toBe("review-close-1");
    expect(db.pending.accumulated_text).not.toContain("จบรายการเบิก");

    // Confirming the item is recorded; the per-item close path itself is
    // covered against the real gate in entry-validation-gate.test.ts.
    await service.processEvents([textEvent("ยืนยันข้อ 4", "confirm-4")], "dest");
    expect(replies.at(-1)).toContain("✅ ยืนยันข้อ 4 แล้ว");
    expect(db.reviews[0]?.confirmed_at).not.toBeNull();
  });

  it("keeps the review identity stable when the first close event is redelivered", async () => {
    const original = [
      "ดำ-ราชพฤกษ์ เบิก 11/8/2569",
      "4.มะม่วง2ขีด20บาท",
      "1โล",
    ].join("\n");
    const db = new PlainTextGateDatabase(pendingRow(original), []);
    const replies: string[] = [];
    const service = build(db, replies);

    await service.processEvents([textEvent("จบรายการเบิก", "duplicate-close")], "dest");
    const digests = db.reviews.map((review) => review.digest);
    await service.processEvents([textEvent("จบรายการเบิก", "duplicate-close")], "dest");

    expect(db.pending.accumulated_text).toBe(original);
    expect(db.reviews.map((review) => review.digest)).toEqual(digests);
    expect(db.reviews.every((review) => review.confirmed_at === null)).toBe(true);
    expect(db.pending.close_line_event_id).toBeNull();
  });

  it("recovers from a failed delivery stamp without growing review rows", async () => {
    const db = new PlainTextGateDatabase(pendingRow([
      "ดำ-ราชพฤกษ์ เบิก 11/8/2569",
      "4.มะม่วง2ขีด20บาท",
      "1โล",
    ].join("\n")), []);
    db.presentationError = "temporary database failure";
    const replies: string[] = [];
    const service = build(db, replies);

    await service.processEvents([textEvent("จบรายการเบิก", "failed-stamp")], "dest");
    const rows = db.reviews.length;
    expect(db.reviews[0]?.presented_delivered_at).toBeNull();

    db.presentationError = null;
    await service.processEvents([textEvent("จบรายการเบิก", "re-present")], "dest");
    expect(db.reviews).toHaveLength(rows);
    expect(db.reviews[0]?.presented_delivered_at).not.toBeNull();
    expect(db.reviews[0]?.presented_line_event_id).toBe("re-present");
    expect(db.reviews[0]?.confirmed_at).toBeNull();
  });

  it("invalidates a delivered review when the Produce document changes", async () => {
    const db = new PlainTextGateDatabase(pendingRow([
      "ดำ-ราชพฤกษ์ เบิก 11/8/2569",
      "4.มะม่วง2ขีด20บาท",
      "1โล",
    ].join("\n")), []);
    const replies: string[] = [];
    const service = build(db, replies);

    await service.processEvents([textEvent("จบรายการเบิก", "before-change")], "dest");
    const oldDigests = new Set(db.reviews.map((review) => review.digest));
    db.pending.accumulated_text = `${db.pending.accumulated_text}\n5.ฝรั่ง30บาท\n1โล`;
    db.pending.ingest_revision = 1;

    await service.processEvents([textEvent("จบรายการเบิก", "after-change")], "dest");
    expect(db.reviews.some((review) => !oldDigests.has(review.digest))).toBe(true);
    expect(db.reviews.every((review) => review.confirmed_at === null)).toBe(true);
    expect(db.pending.close_event_timestamp_ms).toBeNull();
  });
});

/**
 * 2026-09-19 — false-missing on a forwarded session, and the 2026-08-30 race.
 *
 * Printed item numbers are input metadata now: a skipped or out-of-order
 * number never blocks a close. What still matters is TRANSPORT ordering: the
 * close boundary is stamped against the exact ingest_revision the gate
 * validated (append_pending_session's p_expected_ingest_revision, enforced in
 * SQL by 20260831120000). A same-generation item that lands while the gate is
 * working refuses the boundary with recoverable copy, whatever its number.
 */
describe("close gate — late LINE events by ingest revision, never by item numbers", () => {
  /** A ชั่งเบิก withdrawal whose lines carry exactly the given printed numbers. */
  function withdrawalText(numbers: number[]): string {
    const lines = ["ดำ-ราชพฤกษ์ เบิก 11/8/2569"];
    for (const n of numbers) lines.push(`${n}.มังคุด${90 + n}บาท`, "1โล");
    return lines.join("\n");
  }

  /** Mutates the canonical pending row (a NEW object) the first time the given
   * RPC fires — after the gate captured its document, during round binding. */
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

  /** What append_pending_session does in SQL with a pinned revision. */
  function enforcePinnedRevision(db: PlainTextGateDatabase, pinned: unknown[]) {
    const original = db.rpc;
    db.rpc = async (name, args) => {
      if (name === "append_pending_session" && args.p_expected_ingest_revision != null) {
        pinned.push(args.p_expected_ingest_revision);
        const current = db.pending.ingest_revision as number;
        if (current !== args.p_expected_ingest_revision) {
          return {
            data: {
              accepted: false,
              reason: "stale_validation_snapshot",
              expected_revision: args.p_expected_ingest_revision,
              current_revision: current,
            },
            error: null,
          } as never;
        }
      }
      return original(name, args);
    };
  }

  it("refuses the boundary when a same-generation item lands mid-gate", async () => {
    const db = new PlainTextGateDatabase(pendingRow(withdrawalText([1, 2, 3, 4, 5])), []);
    const pinned: unknown[] = [];
    enforcePinnedRevision(db, pinned);
    raceRpcResult(db, "bind_plain_text_accountability_round", () => {
      const old = db.pending;
      db.tables.pending_sessions[0] = {
        ...old,
        accumulated_text: `${old.accumulated_text}\n6.มังคุด96บาท\n1โล`,
        ingest_revision: (old.ingest_revision as number) + 1,
      };
    });
    const replies: string[] = [];

    await build(db, replies).processEvents([textEvent("จบรายการเบิก", "close-race")], "dest");

    expect(pinned).toEqual([0]);
    expect(replies).toEqual([CLOSE_RACED_LATE_ITEM_REPLY]);
    expect(db.pending.close_event_timestamp_ms).toBeNull();
  });

  it("closes a stable document even when its printed numbering skips", async () => {
    const db = new PlainTextGateDatabase(pendingRow(withdrawalText(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16],
    )), []);
    const pinned: unknown[] = [];
    enforcePinnedRevision(db, pinned);
    const replies: string[] = [];

    await build(db, replies).processEvents([textEvent("จบรายการเบิก", "close-skipped")], "dest");

    expect(replies).toEqual([PRODUCE_CLOSE_PENDING_REPLY]);
    expect(db.pending.close_line_event_id).toBe("close-skipped");
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
