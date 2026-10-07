/**
 * Non-financial entry issues never block a produce session.
 *
 * If product + quantity + unit + price are readable, the line is calculable
 * and the session must finalize: duplicate / missing / out-of-order item
 * numbers are renumbered by the parser, and unknown products or unit
 * mismatches against the round are recorded for reconciliation only.
 * Missing quantity or price still blocks, because the amount is unknown.
 */
import { describe, expect, it } from "bun:test";
import { finalizePendingGeneration } from "./pending-session-finalizer";
import type { PendingSession } from "./pending-session-service";
import { parseWeighSession, getWeighSessionFinalizationErrors } from "@/lib/parsers/weigh-session/parser";
import type { WeighSession } from "@/lib/parsers/weigh-session/types";
import { validateProduceEntry, type RoundMasterRow } from "@/lib/produce/entry-validation";
import { canonicalProduceProductIdentity } from "@/lib/produce/product-vocabulary";
import { exactLineTotalScaled, scaledToBaht } from "@/lib/produce/exact-line-total";

const DATE = "2026-10-06";

function numbered(numbers: number[], header = "ดำ-ตลาด เบิก 6/10/2569"): WeighSession {
  const products = ["องุ่นแดง", "มะม่วง", "ส้ม", "ทุเรียน", "กล้วย", "มะละกอ", "เงาะ", "ลำไย"];
  const lines = [header];
  numbers.forEach((number, index) => {
    lines.push(`${number}.${products[index % products.length]}${(index + 1) * 10}บาท`, "2โล");
  });
  return parseWeighSession(lines.join("\n"), DATE);
}

const numbers = (parsed: WeighSession) => parsed.items.map((item) => item.item_number);
const originals = (parsed: WeighSession) => parsed.items.map((item) => item.original_item_number);

function validate(parsed: WeighSession, roundRows: RoundMasterRow[] = []) {
  return validateProduceEntry({ parsed, roundRows, roundBound: true });
}

describe("item numbering is input metadata, never a blocker", () => {
  it("renumbers a duplicate 12 into one sequential list (10..15)", () => {
    const parsed = numbered([10, 11, 12, 12, 13, 14]);
    expect(numbers(parsed)).toEqual([10, 11, 12, 13, 14, 15]);
    expect(originals(parsed)).toEqual([undefined, undefined, undefined, 12, 13, 14]);
    expect(getWeighSessionFinalizationErrors(parsed)).toEqual([]);
    expect(validate(parsed).status).toBe("clean");
  });

  it("renumbers 4, 4, 4", () => {
    const parsed = numbered([4, 4, 4]);
    expect(numbers(parsed)).toEqual([4, 5, 6]);
    expect(originals(parsed)).toEqual([undefined, 4, 4]);
    expect(validate(parsed).status).toBe("clean");
  });

  it("closes missing numbers instead of reporting a gap", () => {
    const parsed = numbered([1, 2, 4, 6, 7]);
    expect(numbers(parsed)).toEqual([1, 2, 3, 4, 5]);
    expect(originals(parsed)).toEqual([undefined, undefined, 4, 6, 7]);
    expect(validate(parsed).blocking).toEqual([]);
  });

  it("numbers out-of-order lines in message order", () => {
    const parsed = numbered([3, 1, 2]);
    expect(parsed.items.map((item) => item.product_name)).toEqual(["องุ่นแดง", "มะม่วง", "ส้ม"]);
    expect(numbers(parsed)).toEqual([1, 2, 3]);
    expect(originals(parsed)).toEqual([3, 1, 2]);
    expect(validate(parsed).status).toBe("clean");
  });

  it("leaves normal, already-sequential input exactly as before", () => {
    const parsed = numbered([1, 2, 3]);
    expect(numbers(parsed)).toEqual([1, 2, 3]);
    expect(parsed.items.every((item) => !("original_item_number" in item))).toBe(true);
    expect(validate(parsed)).toMatchObject({ status: "clean", blocking: [], reviews: [] });
  });
});

describe("financially complete lines save; mismatches are recorded internally", () => {
  it("saves an unknown product with complete quantity, unit and price", () => {
    const parsed = parseWeighSession(
      ["ดำ-ตลาด เบิก 6/10/2569", "1.ผักกูดป่าพิเศษ35บาท", "2ถุง"].join("\n"),
      DATE,
    );
    const result = validate(parsed);
    expect(result.status).toBe("clean");
    expect(result.reviews).toEqual([]);
    expect(result.reconciliation).toMatchObject([
      { kind: "unknown_product_vocabulary", itemNumber: 1, productName: "ผักกูดป่าพิเศษ" },
    ]);
  });

  it("saves a return booked in another unit (แพค → ถุง) without converting it", () => {
    const withdrawn: RoundMasterRow[] = [
      { product_name: "องุ่นแดง", unit: "แพค", quantity: 5, price_per_unit: 120, transaction_type: "เบิก" },
    ];
    const parsed = parseWeighSession(
      ["ดำ-ตลาด ชั่งคืน 6/10/2569", "1.องุ่นแดง120บาท", "3ถุง"].join("\n"),
      DATE,
    );
    const result = validate(parsed, withdrawn);
    expect(result.status).toBe("clean");
    expect(parsed.items[0]).toMatchObject({ quantity: 3, unit: "ถุง", price_per_unit: 120 });
    expect(result.reconciliation).toEqual([{
      kind: "unit_not_withdrawn",
      itemNumber: 1,
      productName: "องุ่นแดง",
      unit: "ถุง",
      withdrawnUnits: ["แพค"],
    }]);
  });

  it("normalizes the confirmed typo ส้มเชียวหวาน to ส้มเขียวหวาน", () => {
    expect(canonicalProduceProductIdentity("ส้มเชียวหวาน", "โล")).toBe("ส้มเขียวหวาน");
  });

  it("handles a duplicate number and an unknown product together", () => {
    const parsed = parseWeighSession(
      ["ดำ-ตลาด เบิก 6/10/2569", "1.มังคุด60บาท", "2โล", "1.ผักกูดป่าพิเศษ35บาท", "2ถุง"].join("\n"),
      DATE,
    );
    expect(numbers(parsed)).toEqual([1, 2]);
    const result = validate(parsed);
    expect(result.status).toBe("clean");
    expect(result.reconciliation.map((entry) => "itemNumber" in entry ? entry.itemNumber : null)).toEqual([2]);
  });

  it("still blocks a line whose price is missing — the amount is unknown", () => {
    const parsed = parseWeighSession(["ดำ-ตลาด เบิก 6/10/2569", "1.มังคุด", "2โล"].join("\n"), DATE);
    expect(getWeighSessionFinalizationErrors(parsed).length).toBeGreaterThan(0);
  });
});

// ── Real case: ดำ-วัดทุ่งลานนา ชั่งคืน 6/10/2569 — 19 lines, 12 typed twice ──
//
// FIELD_TEXT is the operator's item text verbatim. The header and closer
// lines around it are the session's own (the field text arrived inside them).

const FIELD_TEXT = `1.น้อยหน่า40บาท
13.1โล
2.แก้วมังกร40บาท
8โล
3.สาลี่หอม40บาท
15.3โล
4.ส้มเชียวหวาน45บาท
7.9โล
5.พุทราจีน130บาท
0.3โล
6.เงาะ55บาท
3โล
7.ลองกอง40บาท
2.4โล
8.ไชมัส60บาท
5.7โล
9.องุ่นแดง60บาท
0.6โล
10.องุ่นแดง80บาท
0.8โล
11.ไชมัส120บาท
1.6โล
12.องุ่นคิมสัน120บาท
3.7โล
12.ไชมัส120บาท
0.8โล
13.ฝรั่งแดง45บาท
8.5โล
14.ฝรั่ง35บาท
24.2โล
15.แตงโม30บาท
3ลูก
16.แตงไทย16บาท
1ลูก
17.สาลี่10บาท
14ลูก
18.แอปเปิ้ล8บาท
45ลูก`;

const REAL_CASE = ["ดำ-วัดทุ่งลานนา ชั่งคืน 6/10/2569", FIELD_TEXT, "จบรายการชั่งคืน"].join("\n");

type Row = Record<string, unknown>;

/** Minimal Supabase stand-in; same shape as pending-session-finalizer-multiline-item.test.ts. */
class FinalizerDouble {
  rpcCalls: Array<{ name: string; args: Row }> = [];
  constructor(private readonly tables: Record<string, Row[]>) {}

  from = (table: string) => {
    const rows = this.tables[table] ?? [];
    const filters: Array<(row: Row) => boolean> = [];
    const orderBy: string[] = [];
    const result = () => rows
      .filter((row) => filters.every((f) => f(row)))
      .sort((a, b) => {
        for (const column of orderBy) {
          const [x, y] = [a[column] as string | number, b[column] as string | number];
          if (x !== y) return x < y ? -1 : 1;
        }
        return 0;
      });
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
      order: (column: string) => {
        orderBy.push(column);
        return builder;
      },
      limit: () => builder,
      maybeSingle: async () => ({ data: result()[0] ?? null, error: null }),
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
        Promise.resolve({ data: result(), error: null }).then(resolve),
    };
    return builder;
  };

  rpc = async (name: string, args: Row) => {
    this.rpcCalls.push({ name, args });
    if (name === "try_finalize_pending_generation") {
      return { data: { status: "finalized", session_id: "produce-1", notification_id: "notify-1" }, error: null };
    }
    if (name === "upsert_data_quality_issues") return { data: [], error: null };
    if (name === "bind_plain_text_accountability_round") {
      return { data: { outcome: "bound", accountability_round_id: ROUND_ID, market_label: "วัดทุ่งลานนา" }, error: null };
    }
    return { data: null, error: null };
  };
}

const SESSION_KEY = "group:group-1:user:user-1";
const GENERATION = "44444444-4444-4444-8444-444444444444";
const ROUND_ID = "round-1";

function snapshot(text: string, closeTimestampMs = 2_000): PendingSession {
  const now = new Date().toISOString();
  return {
    id: "pending-1",
    session_key: SESSION_KEY,
    source_id: "group-1",
    accumulated_text: text,
    latest_reply_token: null,
    line_user_id: "user-1",
    created_at: now,
    updated_at: now,
    session_generation: GENERATION,
    close_event_timestamp_ms: closeTimestampMs,
    close_requested_at: now,
    close_line_event_id: "close-event-1",
    close_finalize_started_at: null,
    terminalized: false,
    next_attempt_at: now,
    close_deadline_at: now,
    close_session_generation: GENERATION,
    expected_item_count: null,
    ingest_revision: 2,
    runtime_environment: "development",
  };
}

describe("real case: ดำ-วัดทุ่งลานนา ชั่งคืน 6/10/2569", () => {
  it("finalizes 19 sequential items worth 5,121.00 THB without any correction", async () => {
    const db = new FinalizerDouble({
      pending_session_ingest: [{
        session_key: SESSION_KEY,
        session_generation: GENERATION,
        line_event_id: "event-1",
        line_timestamp_ms: 1_000,
        raw_text: REAL_CASE,
      }],
      raw_messages: [{ id: "raw-close-1", line_event_id: "close-event-1" }],
      // Part of the morning withdrawal. ไซมัส went out short (5 โล against
      // 8.1 returned) and most returned lines have no withdrawal here at all:
      // both are reconciled later, neither refuses the session.
      produce_transactions: [
        { accountability_round_id: ROUND_ID, product_name: "ไซมัส", unit: "โล", quantity: 5, price_per_unit: 60, transaction_type: "เบิก" },
        { accountability_round_id: ROUND_ID, product_name: "องุ่นแดง", unit: "โล", quantity: 3, price_per_unit: 60, transaction_type: "เบิก" },
        { accountability_round_id: ROUND_ID, product_name: "แตงโม", unit: "ลูก", quantity: 10, price_per_unit: 30, transaction_type: "เบิก" },
      ],
      daily_summaries: [],
      produce_entry_validation_reviews: [],
    });

    const result = await finalizePendingGeneration(db as never, snapshot(REAL_CASE), async () => ({}));
    expect(result.status).toBe("finalized");

    const call = db.rpcCalls.find((c) => c.name === "try_finalize_pending_generation")!;
    const session = call.args.p_session as Row;
    const items = call.args.p_items as Row[];

    expect(session.validation_errors).toEqual([]);
    expect(items).toHaveLength(19);
    expect(items.map((item) => item.item_number)).toEqual(Array.from({ length: 19 }, (_, i) => i + 1));
    // Typed 12 twice: the second becomes 13 and everything after shifts by one.
    expect(items[11]).toMatchObject({ item_number: 12, product_name: "องุ่นคิมสัน", quantity: 3.7 });
    expect(items[12]).toMatchObject({ item_number: 13, product_name: "ไซมัส", quantity: 0.8, price_per_unit: 120 });
    expect(items[13]).toMatchObject({ item_number: 14, product_name: "ฝรั่งแดง" });
    expect(items[18]).toMatchObject({ item_number: 19, product_name: "แอปเปิ้ล", quantity: 45, unit: "ลูก" });
    expect(items[3]).toMatchObject({ item_number: 4, product_name: "ส้มเขียวหวาน" });

    const total = scaledToBaht(items.reduce<bigint>((sum, item) => sum + exactLineTotalScaled({
      quantity: item.quantity as number,
      pricePerUnit: item.price_per_unit as number,
      basisQuantity: item.basis_quantity as number | null,
      basisPrice: item.basis_price as number | null,
    })!, BigInt(0)));
    expect(total).toBe(5121);

    const notification = String(session.notification_payload);
    expect(notification.startsWith("บันทึกแล้ว ✅")).toBe(true);
    expect(notification).toContain("13. ไซมัส");
    expect(notification).not.toMatch(/12[AB]/);
    expect(notification).toContain("รวมคืน: 5,121.00 บาท");
    expect(notification).not.toContain("แก้ข้อ");

    // Non-blocking issues are persisted for audit (ADVISORY), never shown.
    const audit = db.rpcCalls.find((c) => c.name === "upsert_data_quality_issues");
    const rows = (audit?.args.p_candidates ?? []) as Array<{
      category: string; severity: string; business_date: string; technical_context: Record<string, unknown>;
    }>;
    expect(new Set(rows.map((row) => row.severity))).toEqual(new Set(["ADVISORY"]));
    expect(rows.every((row) => row.business_date === "2026-10-06")).toBe(true);
    const renumbered = rows.filter((row) => row.category === "produce_item_renumbered");
    expect(renumbered.map((row) => [row.technical_context.original_item_number, row.technical_context.item_number]))
      .toEqual([[12, 13], [13, 14], [14, 15], [15, 16], [16, 17], [17, 18], [18, 19]]);
    expect(renumbered[0]!.technical_context).toMatchObject({
      produce_session_id: "produce-1",
      pending_session_key: SESSION_KEY,
      pending_session_generation: GENERATION,
      product_name: "ไซมัส",
      quantity: 0.8,
      unit: "โล",
    });
    const excess = rows.filter((row) => row.category === "produce_return_exceeds_withdrawal");
    expect(excess.map((row) => row.technical_context)).toMatchObject([{
      product_name: "ไซมัส", unit: "โล", withdrawn_quantity: 5, good_return_quantity: 8.1, excess_quantity: 3.1,
    }]);
    expect(rows.some((row) => row.category === "produce_unknown_product")).toBe(true);
    expect(notification).not.toContain("ตรวจสอบ");
  });
});

// ── Late LINE events: transport ordering, never human numbering ─────────────
//
// The finalizer rebuilds the document from pending_session_ingest by LINE
// timestamp up to the immutable close boundary. A straggler that was SENT
// before the close but DELIVERED after it is still included; an item sent
// after the close never is. This holds no matter how the items are numbered.

describe("late LINE events are reconciled by event timestamp", () => {
  it("includes a pre-close straggler delivered late and excludes a post-close item", async () => {
    const CLOSE_MS = 3_000;
    const row = (lineEventId: string, ms: number, rawText: string) => ({
      session_key: SESSION_KEY,
      session_generation: GENERATION,
      line_event_id: lineEventId,
      line_timestamp_ms: ms,
      raw_text: rawText,
    });
    // Table order = arrival order. The 15/16 message (sent at 2 s) arrived
    // after the close (sent at 3 s); the 19 message was sent after the close.
    const ingest = [
      row("event-a", 1_000, "ป้อม-ราชพฤกษ์ ชั่งคืน 3/9/2569\n14.องุ่น10บาท\n1โล"),
      row("event-c", 1_500, "17.มะม่วง10บาท\n1โล\n18.ส้ม10บาท\n1โล"),
      row("close-event-1", CLOSE_MS, "จบรายการชั่งคืน"),
      row("event-late-after", 4_000, "19.ลำไย10บาท\n1โล"),
      row("event-straggler", 2_000, "15.กล้วย10บาท\n1โล\n16.เงาะ10บาท\n1โล"),
    ];
    const db = new FinalizerDouble({
      pending_session_ingest: ingest,
      raw_messages: [{ id: "raw-close-1", line_event_id: "close-event-1" }],
      produce_transactions: [],
      daily_summaries: [],
      produce_entry_validation_reviews: [],
    });
    // The snapshot the close saw did not have 15/16 yet.
    const stale = [ingest[0].raw_text, ingest[1].raw_text, ingest[2].raw_text].join("\n");

    const result = await finalizePendingGeneration(db as never, snapshot(stale, CLOSE_MS), async () => ({}));
    expect(result.status).toBe("finalized");

    const call = db.rpcCalls.find((c) => c.name === "try_finalize_pending_generation")!;
    const items = call.args.p_items as Row[];
    expect((call.args.p_session as Row).validation_errors).toEqual([]);
    // LINE-timestamp order: 14, 17, 18, then the straggler's 15, 16. No 19.
    expect(items.map((item) => item.product_name)).toEqual(["องุ่น", "มะม่วง", "ส้ม", "กล้วย", "เงาะ"]);
    expect(items.map((item) => item.item_number)).toEqual([14, 15, 16, 17, 18]);
  });
});
