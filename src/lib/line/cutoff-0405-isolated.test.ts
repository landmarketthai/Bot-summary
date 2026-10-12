/**
 * Isolated, deterministic 04:00 Asia/Bangkok cutoff gate (03:59:59.999 /
 * 04:00:00.000 / 04:05:00.000). Pure in-process: Bun's fake system clock,
 * table doubles, global fetch forbidden. No database, HTTP server, LINE call
 * or Production data, and none of the staging `--cutoff-host` fixture
 * (2026-10-09 clocks, `uat-20261009-cutoff-*` rows), which must not be rerun.
 * Business date D = 2026-11-14; its cutoff is 2026-11-14T21:00:00Z.
 *
 * Proves, end to end in one process: the finalizer refuses an undated return
 * on every side of the cutoff without binding a round; a dated failed return
 * binds idempotently to its explicit day; and the row the finalizer leaves
 * behind keeps Sales, Daily Close preflight, yod-song and the White Sheet cash
 * verdict provisional on both adjacent business days.
 */
import { describe, expect, it, setSystemTime } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { runDailyClosePreflight } from "@/lib/produce/preflight-service";
import {
  UNDATED_CUTOFF_REPLY,
  undatedBusinessDateAmbiguous,
} from "@/lib/produce/plain-text-round-binding";
import { loadSalesReport, SalesDataError } from "@/lib/sales/load";
import {
  marketProduceValueStatus,
  settlementProduceValueStatus,
} from "@/lib/settlement/produce-value-status";
import { preflightReturnIntegrity } from "@/lib/white-sheet/return-integrity";
import { finalizePendingGeneration } from "./pending-session-finalizer";
import type { PendingSession } from "./pending-session-service";

type Row = Record<string, unknown>;

const D = "2026-11-14";
const NEXT = "2026-11-15";
const SOURCE = "Csynthetic-cutoff-20261114";
const USER = "Usynthetic-cutoff-20261114";
const SESSION_KEY = `group:${SOURCE}:user:${USER}`;
const GENERATION = "c0400000-0000-4000-8000-000000001114";
const SELLER = "น้อย";
const MARKET = "ราชพฤกษ์";
const ROUND_D = "c0400000-0000-4000-8000-0000000000d0";
const ROUND_NEXT = "c0400000-0000-4000-8000-0000000000d1";

const SENT_0355 = Date.parse("2026-11-14T20:55:00.000Z"); // 03:55 Bangkok 15/11
const CLOCKS = {
  "03:59:59.999": "2026-11-14T20:59:59.999Z",
  "04:00:00.000": "2026-11-14T21:00:00.000Z",
  "04:05:00.000": "2026-11-14T21:05:00.000Z",
} as const;

const UNDATED_RETURN = [`${SELLER}-${MARKET} ชั่งคืน`, "1.มะนาว50บาท", "3แพค", "จบรายการชั่งคืน"];
// Explicit header date; item 22 has no price line, so the document is refused.
const DATED_FAILED_RETURN = [
  `${SELLER}-${MARKET} ชั่งคืน 14/11/2569`, "1.มะนาว50บาท", "3แพค", "22.มะม่วง", "จบรายการชั่งคืน",
];

/**
 * Finalizer double; the bind RPC is idempotent per (session_key, generation)
 * like SQL. Strict: an unknown table or RPC throws, and every write is
 * recorded so tests assert the exact write set instead of silently accepting it.
 */
class FinalizerDouble {
  rpcCalls: Array<{ name: string; args: Row }> = [];
  writes: string[] = [];
  private bound = new Map<string, string>();

  constructor(private readonly tables: Record<string, Row[]>, private readonly bindError = false) {}

  from = (table: string) => {
    if (!(table in this.tables)) throw new Error(`Unexpected table: ${table}`);
    const rows = this.tables[table]!;
    const filters: Array<(row: Row) => boolean> = [];
    const matching = () => rows.filter((row) => filters.every((f) => f(row)));
    const write = (op: string) => () => { this.writes.push(`${table}.${op}`); return builder; };
    const builder = {
      select: () => builder,
      insert: write("insert"),
      upsert: write("upsert"),
      update: write("update"),
      delete: write("delete"),
      eq: (column: string, value: unknown) => { filters.push((row) => row[column] === value); return builder; },
      lte: (column: string, value: unknown) => { filters.push((row) => Number(row[column]) <= Number(value)); return builder; },
      not: () => builder,
      in: () => builder,
      is: () => builder,
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () => ({ data: matching()[0] ?? null, error: null }),
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
        Promise.resolve({ data: matching(), error: null }).then(resolve),
    };
    return builder;
  };

  rpc = async (name: string, args: Row) => {
    this.rpcCalls.push({ name, args });
    if (name === "try_finalize_pending_generation") {
      return { data: { status: "failed_closed", reason: "validation_failed" }, error: null };
    }
    if (name === "bind_plain_text_accountability_round") {
      if (this.bindError) return { data: null, error: { message: "bind RPC unavailable" } };
      const key = `${args.p_session_key}|${args.p_session_generation}`;
      const existing = this.bound.get(key);
      if (existing) return { data: { outcome: "already_bound", accountability_round_id: existing, market_label: MARKET }, error: null };
      this.bound.set(key, ROUND_D);
      return { data: { outcome: "bound", accountability_round_id: ROUND_D, market_label: MARKET }, error: null };
    }
    throw new Error(`Unexpected RPC: ${name}`);
  };

  calls(name: string) { return this.rpcCalls.filter((call) => call.name === name); }
}

function finalizerTables(lines: string[], sentMs: number): Record<string, Row[]> {
  return {
    pending_session_ingest: lines.map((raw_text, index) => ({
      session_key: SESSION_KEY, session_generation: GENERATION,
      line_event_id: `cutoff-1114-${index}`, line_timestamp_ms: sentMs + index * 1_000, raw_text,
    })),
    raw_messages: [{ id: "raw-cutoff-1114-close", line_event_id: "cutoff-1114-close" }],
    produce_transactions: [],
    daily_summaries: [],
  };
}

function snapshot(lines: string[], sentMs: number): PendingSession {
  const closeMs = sentMs + lines.length * 1_000;
  return {
    id: "pending-cutoff-1114", session_key: SESSION_KEY, source_id: SOURCE,
    accumulated_text: lines.join("\n"), latest_reply_token: null, line_user_id: USER,
    created_at: new Date(sentMs).toISOString(), updated_at: new Date(closeMs).toISOString(),
    session_generation: GENERATION, close_event_timestamp_ms: closeMs,
    close_requested_at: new Date(closeMs).toISOString(), close_line_event_id: "cutoff-1114-close",
    close_finalize_started_at: null, terminalized: false,
    next_attempt_at: new Date(closeMs).toISOString(), close_deadline_at: new Date(closeMs).toISOString(),
    close_session_generation: GENERATION, expected_item_count: null,
    ingest_revision: lines.length, runtime_environment: "development",
  };
}

/** Runs `body` under a fake clock with every real network call refused. */
async function isolated<T>(clockIso: string, body: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  let networkAttempts = 0;
  globalThis.fetch = (() => { networkAttempts++; throw new Error("network forbidden"); }) as unknown as typeof fetch;
  setSystemTime(new Date(clockIso));
  try {
    const result = await body();
    expect(networkAttempts).toBe(0);
    return result;
  } finally {
    setSystemTime();
    globalThis.fetch = originalFetch;
  }
}

async function finalizeOnce(db: FinalizerDouble, lines: string[], sentMs: number) {
  const replies: string[] = [];
  const result = await finalizePendingGeneration(db as never, snapshot(lines, sentMs),
    async (_to, message) => { replies.push(message); return {}; });
  const payloads = db.calls("try_finalize_pending_generation").map((call) => call.args.p_session as Row);
  return { result, replies, payload: payloads[payloads.length - 1]! };
}

describe("04:00 cutoff margin edges (pure)", () => {
  const text = UNDATED_RETURN.join("\n");
  it.each([
    ["2026-11-14T20:29:59.999Z", false], // 03:29:59.999: margin ends before 04:00
    ["2026-11-14T20:30:00.000Z", true],  // 03:30:00.000: margin touches 04:00
    ["2026-11-14T20:59:59.999Z", true],
    ["2026-11-14T21:00:00.000Z", true],
    ["2026-11-14T21:05:00.000Z", true],
    ["2026-11-14T21:29:59.999Z", true],  // 04:29:59.999: margin reaches back past 04:00
    ["2026-11-14T21:30:00.000Z", false], // 04:30:00.000: margin starts at 04:00 itself
  ] as const)("undated return clocked %s alone: ambiguous=%s", (iso, ambiguous) => {
    expect(undatedBusinessDateAmbiguous(text, [Date.parse(iso)])).toBe(ambiguous);
  });
});

describe("finalizer at 03:59:59.999 / 04:00 / 04:05 Bangkok", () => {
  for (const [label, clock] of Object.entries(CLOCKS)) {
    it(`${label}: undated return sent 03:55 fails closed, never binds, and a retry is identical`, async () => {
      await isolated(clock, async () => {
        const db = new FinalizerDouble(finalizerTables(UNDATED_RETURN, SENT_0355));
        const first = await finalizeOnce(db, UNDATED_RETURN, SENT_0355);
        const retry = await finalizeOnce(db, UNDATED_RETURN, SENT_0355);
        for (const run of [first, retry]) {
          expect(run.result.status).toBe("failed_closed");
          expect(run.payload.validation_errors).toContain("business date ambiguous: undated document near the 04:00 cutoff");
          expect(run.payload.accountability_round_id).toBeNull();
          expect(run.replies).toEqual([UNDATED_CUTOFF_REPLY]);
        }
        expect(db.calls("bind_plain_text_accountability_round")).toHaveLength(0);
        expect(retry.payload.ingest_idempotency_key).toBe(first.payload.ingest_idempotency_key);
        expect(first.payload.ingest_idempotency_key).toBe(`${SESSION_KEY}:${GENERATION}`);
      });
    });

    it(`${label}: dated failed return binds idempotently to its header date, not the clock`, async () => {
      await isolated(clock, async () => {
        const db = new FinalizerDouble(finalizerTables(DATED_FAILED_RETURN, SENT_0355));
        const first = await finalizeOnce(db, DATED_FAILED_RETURN, SENT_0355);
        const retry = await finalizeOnce(db, DATED_FAILED_RETURN, SENT_0355);
        const binds = db.calls("bind_plain_text_accountability_round");
        expect(binds).toHaveLength(2);
        expect(binds[1]!.args).toEqual(binds[0]!.args);
        expect(binds[0]!.args).toMatchObject({
          p_session_key: SESSION_KEY, p_session_generation: GENERATION,
          p_business_date: D, p_seller_label: SELLER, p_is_new_round: false,
        });
        for (const run of [first, retry]) {
          expect(run.result.status).toBe("failed_closed");
          expect(run.payload.accountability_round_id).toBe(ROUND_D);
          expect(run.payload.validation_errors).not.toContain("business date ambiguous: undated document near the 04:00 cutoff");
          // The operator sees the parse error to fix, never the bind/cutoff text.
          expect(run.replies).toHaveLength(1);
          expect(run.replies[0]).not.toBe(UNDATED_CUTOFF_REPLY);
        }
      });
    });
  }

  it("control: the same undated return at 10:00 binds to that one business day", async () => {
    const sent = Date.parse("2026-11-15T03:00:00.000Z"); // 10:00 Bangkok 15/11
    await isolated("2026-11-15T03:05:00.000Z", async () => {
      const db = new FinalizerDouble(finalizerTables(UNDATED_RETURN, sent));
      const run = await finalizeOnce(db, UNDATED_RETURN, sent);
      expect(run.payload.validation_errors).not.toContain("business date ambiguous: undated document near the 04:00 cutoff");
      expect(db.calls("bind_plain_text_accountability_round").map((call) => call.args.p_business_date)).toEqual([NEXT]);
    });
  });
});

// ---- Consumers: the row the finalizer leaves behind ----

function consumerDb(tables: Record<string, Row[]>, errors: Record<string, string> = {}): SupabaseClient<Database> {
  const known = new Set([
    "produce_transactions", "raw_messages", "produce_sessions", "pending_sessions",
    "pending_session_ingest", "pending_session_retired_generations", "parse_errors",
    "imported_sessions", "produce_items", "central_selling_prices", "accountability_rounds",
    "pending_produce_deferred_events",
  ]);
  return {
    from(table: string) {
      if (!known.has(table)) throw new Error(`Unexpected table: ${table}`);
      const result = () => errors[table]
        ? { data: null, error: { message: errors[table] }, count: null }
        : { data: tables[table] ?? [], error: null, count: (tables[table] ?? []).length };
      // ponytail: filters ignored; every fixture holds only its own business date.
      const node: Record<string, unknown> = {};
      for (const method of ["select", "eq", "in", "not", "or", "gte", "lt", "lte", "is", "order", "limit"]) {
        node[method] = () => node;
      }
      node.range = () => Promise.resolve(result());
      node.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(result()).then(resolve, reject);
      return node;
    },
  } as unknown as SupabaseClient<Database>;
}

/** A trusted withdrawal round on `date`, plus the refused attempt's ledger rows. */
function dayTables(date: string, roundId: string, failedAttempt: Row | null): Record<string, Row[]> {
  return {
    produce_transactions: [{
      id: `withdrawal-${date}`, session_id: `session-${date}`, market_name: MARKET, product_name: "มะนาว",
      quantity: 10, unit: "แพค", transaction_type: "เบิก", base_transaction_type: "เบิก",
      price_per_unit: 50, basis_quantity: null, raw_message_id: `raw-${date}`, session_kind: "main",
      accountability_round_id: roundId, transaction_date: date, item_created_at: `${date}T01:00:00.000Z`,
    }],
    raw_messages: [{ id: `raw-${date}`, source_id: SOURCE }],
    produce_sessions: [{
      id: `session-${date}`, total_items: 1, parser_errors: null, staff_name: SELLER, session_title: MARKET,
      session_date: date, session_kind: "main", accountability_round_id: roundId, raw_message_id: `raw-${date}`,
      finalized_at: `${date}T01:00:00.000Z`, voided_at: null,
    }],
    accountability_rounds: [{
      id: roundId, source_id: SOURCE, business_date: date, seller_label: SELLER, market_label: MARKET,
      owner_line_user_id: USER, status: "open",
    }],
    central_selling_prices: [{
      product_key: "มะนาว", unit_key: "แพค", business_date: date, price_satang: 5_000,
      set_by: "admin:synthetic", set_reason: null,
      created_at: `${date}T00:30:00.000Z`, updated_at: `${date}T00:30:00.000Z`,
    }],
    pending_sessions: failedAttempt ? [failedAttempt] : [],
    pending_session_ingest: failedAttempt ? [{
      session_key: SESSION_KEY, session_generation: GENERATION,
      line_timestamp_ms: Date.parse(String(failedAttempt.created_at)),
    }] : [],
  };
}

/**
 * The pending row the finalizer leaves for the refused undated return above.
 * Typed columns stay NULL: CHECK pending_sessions_structured_metadata_complete
 * (0049) forbids business_date/labels on a plain-text row, so the payload's
 * clock-guessed session_date never reaches pending_sessions.
 */
async function refusedUndatedRow(sentMs: number, clock: string): Promise<Row> {
  return isolated(clock, async () => {
    const db = new FinalizerDouble(finalizerTables(UNDATED_RETURN, sentMs));
    const { result, payload } = await finalizeOnce(db, UNDATED_RETURN, sentMs);
    return {
      id: "pending-cutoff-1114", session_key: SESSION_KEY, session_generation: GENERATION,
      accountability_round_id: payload.accountability_round_id ?? null,
      finalization_status: result.status, terminalized: true,
      accumulated_text: UNDATED_RETURN.join("\n"), business_date: null,
      source_id: SOURCE, staff_label: null, market_label: null, declared_transaction_type: null,
      created_at: new Date(sentMs).toISOString(),
    };
  });
}

async function verdicts(db: SupabaseClient<Database>, date: string, roundId: string) {
  const sales = await loadSalesReport(db, date);
  const preflight = await runDailyClosePreflight(db, date);
  return {
    sales: sales.markets[0]!.rows[0]!,
    yodSong: settlementProduceValueStatus(preflight, { accountabilityRoundId: roundId, staffName: SELLER, marketName: MARKET }, 1),
    whiteSheetVerdict: marketProduceValueStatus(preflight, MARKET, [roundId]),
    whiteSheetCash: await preflightReturnIntegrity(db)(date, MARKET, [roundId]),
  };
}

describe("consumers fail closed on both adjacent business days", () => {
  for (const [label, clock] of Object.entries(CLOCKS)) {
    it(`${label}: Sales, preflight, yod-song and White Sheet cash stay provisional for D and D+1`, async () => {
      const failed = await refusedUndatedRow(SENT_0355, clock);
      expect(failed).toMatchObject({ finalization_status: "failed_closed", accountability_round_id: null });
      for (const [date, roundId] of [[D, ROUND_D], [NEXT, ROUND_NEXT]] as const) {
        const result = await verdicts(consumerDb(dayTables(date, roundId, failed)), date, roundId);
        expect(result.sales.status).toBe("QUANTITY_BLOCKED");
        expect(result.sales.returnEvidenceIncomplete).toBe(true);
        expect(result.sales.soldQuantity).toBeNull();
        expect(result.sales.expectedSalesSatang).toBeNull();
        expect(result.yodSong).toBe("blocked");
        expect(result.whiteSheetVerdict).toBe("blocked");
        expect(result.whiteSheetCash).toBe("blocked");
      }
    });
  }

  it("control: the clean day certifies (the gate is not blocking everything)", async () => {
    const result = await verdicts(consumerDb(dayTables(D, ROUND_D, null)), D, ROUND_D);
    expect(result.sales.status).toBe("TRUSTED");
    expect(result.yodSong).toBe("complete");
    expect(result.whiteSheetCash).toBe("complete");
  });

  it("control: a refusal sent at 10:00 on D+1 does not block D", async () => {
    const sent = Date.parse("2026-11-15T03:00:00.000Z");
    const failed = { ...(await refusedUndatedRow(sent, "2026-11-15T03:05:00.000Z")),
      finalization_status: "failed_closed", accountability_round_id: null };
    const result = await verdicts(consumerDb(dayTables(D, ROUND_D, failed)), D, ROUND_D);
    expect(result.sales.status).toBe("TRUSTED");
    expect(result.whiteSheetCash).toBe("complete");
  });

  it("an evidence read failure is a hard stop, never a sold-out", async () => {
    const failed = await refusedUndatedRow(SENT_0355, CLOCKS["04:05:00.000"]);
    const db = consumerDb(dayTables(D, ROUND_D, failed), { pending_session_retired_generations: "permission denied" });
    await expect(loadSalesReport(db, D)).rejects.toThrow(SalesDataError);
    expect(await preflightReturnIntegrity(db)(D, MARKET, [ROUND_D])).toBe("blocked");
  });
});
