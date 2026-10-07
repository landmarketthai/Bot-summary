/**
 * Real behaviour tests for the finalizer's review-presentation protocol.
 *
 * A LINE push is not transactional with PostgreSQL, so "the review exists" and
 * "the operator saw it" are separate durable facts. These drive
 * holdAndPresentFinalizerReview against an RPC double and assert the ORDER of
 * the calls and what survives each failure window — the properties that decide
 * whether an unseen review can ever be approved.
 *
 * The SQL side is proven in migration-produce-close-validation-race.pg.test.ts.
 */
import { describe, expect, it } from "bun:test";
import { holdAndPresentFinalizerReview } from "./pending-session-finalizer";
import { PendingSessionService, type PendingSession } from "./pending-session-service";
import { finalizerPresentationToken } from "@/lib/produce/entry-validation-gate";
import type { ProduceValidationResult } from "@/lib/produce/entry-validation";

const SESSION_KEY = "group:test-market-1:user:test-staff-1";
const GENERATION = "44444444-4444-4444-8444-444444444444";
const DIGEST = "a".repeat(64);
const LINE_USER = "user-1";

function snapshot(): PendingSession {
  const now = new Date().toISOString();
  return {
    id: "pending-1",
    session_key: SESSION_KEY,
    source_id: "test-market-1",
    accumulated_text: "x",
    latest_reply_token: null,
    line_user_id: LINE_USER,
    created_at: now,
    updated_at: now,
    session_generation: GENERATION,
    close_event_timestamp_ms: 2_000,
    close_requested_at: now,
    close_line_event_id: "close-event-1",
    close_finalize_started_at: null,
    terminalized: false,
    next_attempt_at: now,
    close_deadline_at: now,
    close_session_generation: GENERATION,
    expected_item_count: null,
    ingest_revision: 7,
    runtime_environment: "production",
  } as unknown as PendingSession;
}

// The only confirmable review left is a risky ขีด/กรัม subunit entry.
const REVIEW_RESULT = {
  status: "review_required",
  digest: DIGEST,
  reviews: [{
    kind: "subunit_confirmation",
    severity: "review_required",
    itemNumber: 1,
    productName: "ผลไม้ทดสอบเอ",
    enteredQuantity: 2,
    enteredUnit: "ขีด",
    canonicalQuantity: 0.2,
    canonicalUnit: "โล",
  }],
  blocking: [],
  advisories: [],
} as unknown as ProduceValidationResult;

// The finalizer needs the parsed session so the per-item subunit rows can be
// recorded alongside the whole review.
const PARSED = {
  items: [], parse_errors: [], staff_name: "ทดสอบ", session_title: "ตลาดทดสอบ",
  date: "2017-01-01", session_kind: "main",
} as unknown as import("@/lib/parsers/weigh-session/types").WeighSession;

interface DoubleOptions {
  recordFails?: boolean;
  holdAccepted?: boolean;
  markStatus?: string;
  markFails?: boolean;
}

class RpcDouble {
  calls: string[] = [];
  constructor(private readonly options: DoubleOptions = {}) {}
  rpc = async (name: string) => {
    this.calls.push(name);
    if (name === "record_produce_validation_review") {
      if (this.options.recordFails) return { data: null, error: { message: "boom" } };
      return { data: { confirmed: false, presented_delivered: false, presented_line_event_id: "tok" }, error: null };
    }
    if (name === "hold_pending_validation_review") {
      return { data: { accepted: this.options.holdAccepted !== false }, error: null };
    }
    if (name === "mark_produce_validation_reviews_presented") {
      if (this.options.markFails) return { data: null, error: { message: "boom" } };
      return { data: { status: this.options.markStatus ?? "presented", marked: 1 }, error: null };
    }
    return { data: null, error: null };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from = () => ({}) as any;
}

const silentLog = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

async function run(options: DoubleOptions, push: (to: string, text: string) => Promise<unknown>) {
  const db = new RpcDouble(options);
  const result = await holdAndPresentFinalizerReview(
    db as never,
    new PendingSessionService(db as never),
    snapshot(),
    "round-1",
    REVIEW_RESULT,
    PARSED,
    push,
    silentLog,
  );
  return { db, result };
}

const okPush = async () => ({});
const failingPush = async () => { throw new Error("LINE 500"); };

describe("finalizer review presentation protocol", () => {
  it("records, holds, pushes, then proves delivery — in that order", async () => {
    const pushes: string[] = [];
    const { db, result } = await run({}, async (_to, text) => { pushes.push(text); return {}; });

    expect(db.calls).toEqual([
      "record_produce_validation_review",
      // The subunit review also records its own per-item row.
      "record_produce_validation_review",
      "hold_pending_validation_review",
      "mark_produce_validation_reviews_presented",
    ]);
    // The push must land between the hold and the delivery proof.
    expect(pushes).toHaveLength(1);

    // And it must be the ACTUAL review, not the teaser. Marking a message that
    // only says "press again to see the review" as delivered would let the next
    // close confirm a digest whose contents nobody ever read.
    expect(pushes[0]).toContain("ผลไม้ทดสอบเอ");
    expect(pushes[0]).not.toContain('กรุณากด "จบรายการ" อีกครั้งเพื่อดูรายการที่ต้องตรวจ');
    expect(result).toEqual({ status: "validation_held", reason: "entry_review_presented" });
  });

  it("never proves delivery when the LINE push fails", async () => {
    const { db, result } = await run({}, failingPush);

    expect(db.calls).toContain("record_produce_validation_review");
    expect(db.calls).toContain("hold_pending_validation_review");
    // The whole point: an unseen review is never marked presented, so nothing
    // can confirm it.
    expect(db.calls).not.toContain("mark_produce_validation_reviews_presented");
    expect(result).toEqual({ status: "validation_held", reason: "entry_review_undelivered" });
  });

  it("reports undelivered when the delivery proof itself fails", async () => {
    const { result } = await run({ markFails: true }, okPush);
    // Push landed, but the DB cannot prove it. Fail safe: the operator may be
    // shown it again rather than the system assuming delivery.
    expect(result).toEqual({ status: "validation_held", reason: "entry_review_undelivered" });
  });

  it("reports undelivered when the mark returns a non-delivery status", async () => {
    const { result } = await run({ markStatus: "terminalized" }, okPush);
    expect(result).toEqual({ status: "validation_held", reason: "entry_review_undelivered" });
  });

  it("does not push or park when the review cannot be recorded", async () => {
    let pushed = false;
    const { db, result } = await run({ recordFails: true }, async () => { pushed = true; return {}; });

    // Falls through to normal finalization; nothing was parked and nothing
    // claims delivery.
    expect(result).toBeNull();
    expect(pushed).toBe(false);
    expect(db.calls).toEqual(["record_produce_validation_review"]);
  });

  it("does not push when the hold is refused — no stale parked decision", async () => {
    let pushed = false;
    const { db, result } = await run({ holdAccepted: false }, async () => { pushed = true; return {}; });

    expect(result).toBeNull();
    expect(pushed).toBe(false);
    expect(db.calls).not.toContain("mark_produce_validation_reviews_presented");
  });

  it("records the review before parking, so a crash never parks an unrecorded one", async () => {
    const { db } = await run({}, okPush);
    expect(db.calls.indexOf("record_produce_validation_review"))
      .toBeLessThan(db.calls.indexOf("hold_pending_validation_review"));
  });
});

describe("finalizer presentation token", () => {
  it("is deterministic, generation- and digest-bound", () => {
    expect(finalizerPresentationToken(GENERATION, DIGEST))
      .toBe(finalizerPresentationToken(GENERATION, DIGEST));
    expect(finalizerPresentationToken(GENERATION, DIGEST))
      .not.toBe(finalizerPresentationToken(GENERATION, "b".repeat(64)));
    expect(finalizerPresentationToken(GENERATION, DIGEST))
      .not.toBe(finalizerPresentationToken("55555555-5555-4555-8555-555555555555", DIGEST));
  });

  it("is namespaced so it cannot collide with a real LINE event id", () => {
    const token = finalizerPresentationToken(GENERATION, DIGEST);
    expect(token.startsWith("finalizer:")).toBe(true);
    // LINE event ids are opaque alphanumeric ids; they never carry this prefix.
    expect(/^[A-Za-z0-9_-]+$/.test(token)).toBe(false);
  });
});
