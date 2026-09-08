import { describe, expect, it } from "bun:test";
import { finalizePendingGeneration } from "./pending-session-finalizer";
import type { PendingSession } from "./pending-session-service";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import { validateProduceEntry } from "@/lib/produce/entry-validation";

// Close-barrier regression: prior LINE events/messages for the SAME session
// are still being admitted/ingested as separate rows when จบรายการเบิก
// arrives. The barrier must merge them into one document and validate
// completeness on the merged result — a three-line item split across one of
// those pending messages must not be silently dropped just because it
// crossed a message boundary. See pending-session-finalizer-additional.test.ts
// for the harness this reuses (additional-batch flavor); this file covers
// the main-session flow the production incident actually hit.

type Row = Record<string, unknown>;

class FinalizerDouble {
  rpcCalls: Array<{ name: string; args: Row }> = [];
  rpcResult: Row = { status: "finalized", session_id: "produce-1", notification_id: "notify-1" };

  constructor(private readonly tables: Record<string, Row[]>) {}

  from = (table: string) => {
    const rows = this.tables[table] ?? [];
    const filters: Array<(row: Row) => boolean> = [];
    const builder = {
      select: () => builder,
      upsert: () => builder,
      update: () => builder,
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return builder;
      },
      lte: (column: string, value: unknown) => {
        filters.push((row) => Number(row[column]) <= Number(value));
        return builder;
      },
      not: () => builder,
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () => ({
        data: rows.filter((row) => filters.every((f) => f(row)))[0] ?? null,
        error: null,
      }),
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
        Promise.resolve({
          data: rows.filter((row) => filters.every((f) => f(row))),
          error: null,
        }).then(resolve),
    };
    return builder;
  };

  rpc = async (name: string, args: Row) => {
    this.rpcCalls.push({ name, args });
    if (name === "try_finalize_pending_generation") {
      return { data: this.rpcResult, error: null };
    }
    // No accountability_rounds in this double: the honest answer is that the
    // document has no round to join, which is legacy-unbound behaviour.
    if (name === "bind_plain_text_accountability_round") {
      return { data: { outcome: "no_round" }, error: null };
    }
    return { data: null, error: null };
  };
}

const SESSION_KEY = "group:group-1:user:user-1";
const GENERATION = "33333333-3333-4333-8333-333333333333";

// Four separate LINE messages, admitted as they arrived — the three-line
// ปลาหวานงา item is entirely message 3, exactly as in the production
// incident (one LINE message, its content split across lines).
const MESSAGES = [
  "กี้-วัดทุ่งลานนา เบิก 29/6/2569\n13อินตผารัม100บาท\n3.9.โล",
  "14ปลาอินทรี120บาท\n5กระปุก",
  "15ปลาหวานงา\n100บาท\n6ถุง",
  "16ปลาหวานไม่งา100บาท\n4ถุง",
];

function ingestRows(messages: string[], generation = GENERATION): Row[] {
  return messages.map((raw_text, index) => ({
    session_key: SESSION_KEY,
    session_generation: generation,
    line_event_id: `event-${index + 1}`,
    line_timestamp_ms: (index + 1) * 1_000,
    raw_text,
  }));
}

function snapshot(
  accumulatedText: string,
  generation = GENERATION,
  messageCount = MESSAGES.length,
): PendingSession {
  const now = new Date().toISOString();
  return {
    id: "pending-1",
    session_key: SESSION_KEY,
    source_id: "group-1",
    accumulated_text: accumulatedText,
    latest_reply_token: null,
    line_user_id: "user-1",
    created_at: now,
    updated_at: now,
    session_generation: generation,
    // Bare close (no declared count) — matches the incident's จบรายการเบิก.
    close_event_timestamp_ms: (messageCount + 1) * 1_000,
    close_requested_at: now,
    close_line_event_id: "close-event-1",
    close_finalize_started_at: null,
    terminalized: false,
    next_attempt_at: now,
    close_deadline_at: now,
    close_session_generation: generation,
    expected_item_count: null,
    ingest_revision: messageCount + 1,
    runtime_environment: "development",
  };
}

function tables(messages: string[]): Record<string, Row[]> {
  // อินตผารัม is not an approved dictionary spelling, so the merged document
  // carries a vocabulary review. It was presented and confirmed at the close
  // gate; the deferred finalizer only re-checks it, and this is that record.
  const review = validateProduceEntry({
    parsed: parseWeighSession(messages.join("\n")),
    roundRows: [],
    roundBound: false,
  });
  return {
    pending_session_ingest: ingestRows(messages),
    raw_messages: [{ id: "raw-close-1", line_event_id: "close-event-1" }],
    produce_transactions: [],
    daily_summaries: [],
    produce_entry_validation_reviews: review.reviews.length > 0
      ? [{
          session_key: SESSION_KEY,
          session_generation: GENERATION,
          validation_digest: review.digest,
          confirmed_at: "2026-08-15T00:00:00Z",
        }]
      : [],
  };
}

describe("close barrier — pending events merged before validation (main session)", () => {
  it("merges 4 separately-admitted messages, including the split ปลาหวานงา, and finalizes with zero validation errors", async () => {
    const db = new FinalizerDouble(tables(MESSAGES));
    const snap = snapshot(MESSAGES.join("\n"));

    const result = await finalizePendingGeneration(db as never, snap, async () => ({}));

    expect(result.status).toBe("finalized");
    const call = db.rpcCalls.find((c) => c.name === "try_finalize_pending_generation")!;
    const session = call.args.p_session as Row;
    const items = call.args.p_items as Row[];

    expect(session.validation_errors).toEqual([]);
    expect(items).toHaveLength(4);
    expect(items.find((i) => i.item_number === 15)).toMatchObject({
      product_name: "ปลาหวานงา",
      price_per_unit: 100,
      quantity: 6,
      unit: "ถุง",
    });
  });

  it("fails closed with a specific error when the split item's quantity line never arrives, instead of silently dropping it", async () => {
    const incompleteMessages = [
      MESSAGES[0],
      MESSAGES[1],
      "15ปลาหวานงา\n100บาท", // price arrives, quantity line never sent
      MESSAGES[3],
    ];
    const db = new FinalizerDouble(tables(incompleteMessages));
    const snap = snapshot(incompleteMessages.join("\n"));

    await finalizePendingGeneration(db as never, snap, async () => ({}));

    const call = db.rpcCalls.find((c) => c.name === "try_finalize_pending_generation")!;
    const session = call.args.p_session as Row;
    const errors = session.validation_errors as string[];

    // Never silently absorbed into item 14 or item 16, and never omitted —
    // it surfaces as an explicit validation error naming item 15.
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("15") && e.includes("ปลาหวานงา"))).toBe(true);
  });

  it("keeps correction evidence append-only but finalizes only the corrected effective item", async () => {
    const messages = [
      "กี้-ตลาดทดสอบ เบิก 24/8/2569\n17. อะโวคาโด้ 80 บาท\n15 โล",
      "แก้ข้อ 17",
      "17. อะโวคาโด 75 บาท\n16 โล",
    ];
    const fixture = tables(messages);
    const db = new FinalizerDouble(fixture);
    const snap = snapshot(messages.join("\n"), GENERATION, messages.length);

    const result = await finalizePendingGeneration(db as never, snap, async () => ({}));

    expect(result.status).toBe("finalized");
    expect(fixture.pending_session_ingest.map((row) => row.raw_text)).toEqual(messages);
    const call = db.rpcCalls.find((entry) => entry.name === "try_finalize_pending_generation")!;
    const items = call.args.p_items as Row[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      item_number: 17,
      product_name: "อะโวคาโด",
      price_per_unit: 75,
      quantity: 16,
      unit: "โล",
    });
  });

  it("finalizes a deterministic alias without a review and preserves raw evidence", async () => {
    const messages = [
      "กี้-ตลาดทดสอบ เบิก 24/8/2569\n1. อะโวคาโด้ 70 บาท\n3 โล",
    ];
    const fixture = tables(messages);
    const db = new FinalizerDouble(fixture);
    const snap = snapshot(messages.join("\n"), GENERATION, messages.length);

    const result = await finalizePendingGeneration(db as never, snap, async () => ({}));

    expect(result.status).toBe("finalized");
    expect(fixture.pending_session_ingest[0]?.raw_text).toBe(messages[0]);
    expect(fixture.produce_entry_validation_reviews).toEqual([]);
    const call = db.rpcCalls.find((entry) => entry.name === "try_finalize_pending_generation")!;
    expect(call.args.p_items).toEqual([
      expect.objectContaining({
        product_name: "อะโวคาโด",
        price_per_unit: 70,
        quantity: 3,
        unit: "โล",
      }),
    ]);
  });

  it("keeps removal evidence append-only and excludes the removed item from finalization", async () => {
    const messages = [
      "กี้-ตลาดทดสอบ เบิก 24/8/2569\n16. มังคุด 45 บาท\n2 โล\n17. อะโวคาโด 80 บาท\n4 โล",
      "ลบข้อ 17",
    ];
    const fixture = tables(messages);
    const db = new FinalizerDouble(fixture);
    const snap = snapshot(messages.join("\n"), GENERATION, messages.length);

    const result = await finalizePendingGeneration(db as never, snap, async () => ({}));

    expect(result.status).toBe("finalized");
    expect(fixture.pending_session_ingest.map((row) => row.raw_text)).toEqual(messages);
    const call = db.rpcCalls.find((entry) => entry.name === "try_finalize_pending_generation")!;
    const items = call.args.p_items as Row[];
    expect(items.map((row) => row.item_number)).toEqual([16]);
  });
});
