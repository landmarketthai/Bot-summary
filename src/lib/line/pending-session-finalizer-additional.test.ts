import { describe, expect, it } from "bun:test";
import { finalizePendingGeneration } from "./pending-session-finalizer";
import type { PendingSession } from "./pending-session-service";

// Focused supabase double: table reads the finalizer performs, plus a capture
// of the authoritative RPC call.
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
const GENERATION = "11111111-1111-4111-8111-111111111111";

const ADDITIONAL_TEXT = [
  "กี้-คลองเตย เบิกเพิ่ม 12/7/2569",
  "1.ทุเรียน100บาท",
  "2โล",
  "จบรายการเบิกเพิ่ม 1 รายการ",
];

function snapshot(generation = GENERATION): PendingSession {
  const now = new Date().toISOString();
  return {
    id: "pending-1",
    session_key: SESSION_KEY,
    source_id: "group-1",
    accumulated_text: ADDITIONAL_TEXT.join("\n"),
    latest_reply_token: null,
    line_user_id: "user-1",
    created_at: now,
    updated_at: now,
    session_generation: generation,
    close_event_timestamp_ms: 4_000,
    close_requested_at: now,
    close_line_event_id: "close-event-1",
    close_finalize_started_at: null,
    terminalized: false,
    next_attempt_at: now,
    close_deadline_at: now,
    close_session_generation: generation,
    expected_item_count: 1,
    ingest_revision: ADDITIONAL_TEXT.length,
    runtime_environment: "development",
  };
}

function tables(produceTransactions: Row[] = []): Record<string, Row[]> {
  return {
    pending_session_ingest: ADDITIONAL_TEXT.map((raw_text, index) => ({
      session_key: SESSION_KEY,
      session_generation: GENERATION,
      line_event_id: `event-${index + 1}`,
      line_timestamp_ms: (index + 1) * 1_000,
      raw_text,
    })),
    raw_messages: [{ id: "raw-close-1", line_event_id: "close-event-1" }],
    produce_transactions: produceTransactions,
    daily_summaries: [],
  };
}

describe("additional-batch finalization payload", () => {
  it("passes provenance and the generation-identity idempotency key to the RPC", async () => {
    const db = new FinalizerDouble(tables([
      // Existing main batch for the same date + staff + market.
      {
        transaction_date: "2026-07-12", staff_name: "กี้", market_name: "คลองเตย",
        transaction_type: "เบิก", total_amount: 500, session_kind: "main",
      },
    ]));
    const pushes: string[] = [];

    const result = await finalizePendingGeneration(
      db as never,
      snapshot(),
      async (_to, text) => { pushes.push(text); return {}; },
    );

    expect(result.status).toBe("finalized");
    const call = db.rpcCalls.find((c) => c.name === "try_finalize_pending_generation")!;
    const session = call.args.p_session as Row;
    const items = call.args.p_items as Row[];

    expect(session.session_kind).toBe("additional");
    expect(session.declared_transaction_type).toBe("เบิก");
    expect(session.ingest_idempotency_key).toBe(`${SESSION_KEY}:${GENERATION}`);
    expect(session.ingest_source).toBe("line_webhook");
    expect(session.session_date).toBe("2026-07-12");
    expect(session.session_title).toBe("คลองเตย");
    expect(session.validation_errors).toEqual([]);

    // Accounting normalization: items are stored with base types only.
    expect(items).toHaveLength(1);
    expect(items[0].transaction_type).toBe("เบิก");

    // Reply reports batch and cumulative totals, never a modification claim.
    const payload = String(session.notification_payload);
    expect(payload).toContain("บันทึกรายการเบิกเพิ่มแล้ว ✅");
    expect(payload).toContain("เพิ่ม 1 รายการ");
    expect(payload).toContain("ยอดเพิ่ม: 200.00 บาท");
    expect(payload).toContain("ยอดสะสมของวัน: 700.00 บาท");
    expect(payload).not.toContain("ยังไม่พบชุดหลัก");

    // Success delivery is owned by the durable outbox — no direct push.
    expect(pushes).toHaveLength(0);
  });

  it("notes an unmatched addition (no main batch for the grouping key)", async () => {
    const db = new FinalizerDouble(tables([]));

    await finalizePendingGeneration(db as never, snapshot(), async () => ({}));

    const call = db.rpcCalls.find((c) => c.name === "try_finalize_pending_generation")!;
    const payload = String((call.args.p_session as Row).notification_payload);
    expect(payload).toContain("ยอดสะสมของวัน: 200.00 บาท");
    expect(payload).toContain("ยังไม่พบชุดหลัก");
  });

  it("gives two retries of the same generation the same idempotency identity", async () => {
    const db = new FinalizerDouble(tables([]));
    await finalizePendingGeneration(db as never, snapshot(), async () => ({}));
    await finalizePendingGeneration(db as never, snapshot(), async () => ({}));

    const [first, second] = db.rpcCalls
      .filter((c) => c.name === "try_finalize_pending_generation")
      .map((c) => (c.args.p_session as Row).ingest_idempotency_key);
    expect(first).toBe(second);
  });

  it("gives identical content in two different generations distinct identities but one hash", async () => {
    const otherGeneration = "22222222-2222-4222-8222-222222222222";
    const db = new FinalizerDouble(tables([]));
    // Second double with its own generation ledger for the same content.
    const dbTables = tables([]);
    dbTables.pending_session_ingest = [
      ...dbTables.pending_session_ingest,
      ...ADDITIONAL_TEXT.map((raw_text, index) => ({
        session_key: SESSION_KEY,
        session_generation: otherGeneration,
        line_event_id: `retry-event-${index + 1}`,
        line_timestamp_ms: (index + 1) * 1_000,
        raw_text,
      })),
    ];
    const db2 = new FinalizerDouble(dbTables);

    await finalizePendingGeneration(db as never, snapshot(), async () => ({}));
    await finalizePendingGeneration(db2 as never, snapshot(otherGeneration), async () => ({}));

    const call1 = db.rpcCalls.find((c) => c.name === "try_finalize_pending_generation")!;
    const call2 = db2.rpcCalls.find((c) => c.name === "try_finalize_pending_generation")!;

    // Different authoritative identities → both batches persist…
    expect((call1.args.p_session as Row).ingest_idempotency_key)
      .not.toBe((call2.args.p_session as Row).ingest_idempotency_key);
    // …while the content hash stays a shared audit fingerprint.
    expect(call1.args.p_session_hash).toBe(call2.args.p_session_hash);
  });

  it("fails closed on a wrong closer via validation errors", async () => {
    const wrongCloserText = [
      "กี้-คลองเตย เบิกเพิ่ม 12/7/2569",
      "1.ทุเรียน100บาท",
      "2โล",
      "จบรายการ",
    ];
    const dbTables = tables([]);
    dbTables.pending_session_ingest = wrongCloserText.map((raw_text, index) => ({
      session_key: SESSION_KEY,
      session_generation: GENERATION,
      line_event_id: `event-${index + 1}`,
      line_timestamp_ms: (index + 1) * 1_000,
      raw_text,
    }));
    const db = new FinalizerDouble(dbTables);

    const snap = snapshot();
    snap.accumulated_text = wrongCloserText.join("\n");
    snap.ingest_revision = wrongCloserText.length;
    await finalizePendingGeneration(db as never, snap, async () => ({}));

    const call = db.rpcCalls.find((c) => c.name === "try_finalize_pending_generation")!;
    const errors = (call.args.p_session as Row).validation_errors as string[];
    expect(errors.some((e) => e.includes("wrong closer"))).toBe(true);
  });

  it("accepts readable item labels outside 1..N when an expected count exists", async () => {
    const outOfRangeText = [
      "กี้-คลองเตย เบิกเพิ่ม 12/7/2569",
      "5.ทุเรียน100บาท",
      "2โล",
      "จบรายการเบิกเพิ่ม 1 รายการ",
    ];
    const dbTables = tables([]);
    dbTables.pending_session_ingest = outOfRangeText.map((raw_text, index) => ({
      session_key: SESSION_KEY,
      session_generation: GENERATION,
      line_event_id: `event-${index + 1}`,
      line_timestamp_ms: (index + 1) * 1_000,
      raw_text,
    }));
    const db = new FinalizerDouble(dbTables);

    const snap = snapshot();
    snap.accumulated_text = outOfRangeText.join("\n");
    snap.ingest_revision = outOfRangeText.length;
    await finalizePendingGeneration(db as never, snap, async () => ({}));

    const call = db.rpcCalls.find((c) => c.name === "try_finalize_pending_generation")!;
    const errors = (call.args.p_session as Row).validation_errors as string[];
    expect(errors).toEqual([]);
    expect((call.args.p_items as Row[]).map((item) => item.item_number)).toEqual([5]);
  });
});
