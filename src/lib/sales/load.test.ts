import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { computeItemHash, computeSessionHash } from "@/lib/line/session-dedup-service";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import { bangkokBusinessDateWindow, loadSalesReport, SalesDataError } from "./load";

const DATE = "2026-07-25";
const SOURCE_A = "Csource000000aaaaaa";
const SOURCE_B = "Csource000000bbbbbb";

interface Fixture {
  produce?: Record<string, unknown>[];
  rawMessages?: Record<string, unknown>[];
  sessions?: Record<string, unknown>[];
  pending?: Record<string, unknown>[];
  pendingIngest?: Record<string, unknown>[];
  parseErrors?: Record<string, unknown>[];
  importedSessions?: Record<string, unknown>[];
  produceItems?: Record<string, unknown>[];
  centralPrices?: Record<string, unknown>[];
  accountabilityRounds?: Record<string, unknown>[];
  deferredProduce?: Record<string, unknown>[];
  errors?: Partial<Record<string, string>>;
}

/**
 * A fake PostgREST client: the P1 loader is the piece that has to read the
 * right tables and interpret their rows, so the tables are what get faked.
 * Filters are ignored except where a test depends on one, which keeps the
 * fixture readable — every table returns the rows the test declared.
 */
const filterLog: string[] = [];

function fakeSupabase(fixture: Fixture): SupabaseClient<Database> {
  filterLog.length = 0;
  const rowsFor = (table: string): Record<string, unknown>[] => {
    switch (table) {
      case "produce_transactions": return fixture.produce ?? [];
      case "raw_messages": return fixture.rawMessages ?? [];
      case "produce_sessions": return fixture.sessions ?? [];
      case "pending_sessions": return fixture.pending ?? [];
      case "pending_session_ingest": return fixture.pendingIngest ?? [];
      case "parse_errors": return fixture.parseErrors ?? [];
      case "imported_sessions": return fixture.importedSessions ?? [];
      case "produce_items": return fixture.produceItems ?? [];
      case "central_selling_prices": return fixture.centralPrices ?? [];
      case "accountability_rounds": return fixture.accountabilityRounds ?? [];
      case "pending_produce_deferred_events": return fixture.deferredProduce ?? [];
      default: throw new Error(`Unexpected table: ${table}`);
    }
  };

  const client = {
    from(table: string) {
      const error = fixture.errors?.[table];
      const result = () => ({
        data: error ? null : rowsFor(table),
        error: error ? { message: error } : null,
        count: error ? null : rowsFor(table).length,
      });

      const node: Record<string, unknown> = {};
      const self = () => node;
      node.select = self;
      node.eq = (column: string, value: unknown) => {
        filterLog.push(`${table}.eq:${column}=${String(value)}`);
        return node;
      };
      node.in = self;
      node.not = self;
      node.or = (filter: string) => {
        filterLog.push(`${table}.or:${filter}`);
        return node;
      };
      node.gte = self;
      node.is = (column: string, value: unknown) => {
        filterLog.push(`${table}.is:${column}=${String(value)}`);
        return node;
      };
      node.lt = self;
      node.order = self;
      node.range = () => Promise.resolve(result());
      node.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(result()).then(resolve, reject);
      return node;
    },
  };

  return client as unknown as SupabaseClient<Database>;
}

function produceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `item-${Math.random().toString(36).slice(2)}`,
    session_id: "session-1",
    market_name: "ตลาดกี้",
    product_name: "หมอนทอง",
    quantity: 10,
    unit: "โล",
    transaction_type: "เบิก",
    base_transaction_type: "เบิก",
    price_per_unit: 120,
    basis_quantity: null,
    raw_message_id: "raw-1",
    session_kind: "main",
    item_created_at: "2026-07-25T03:00:00.000Z",
    ...overrides,
  };
}

function baseFixture(overrides: Fixture = {}): Fixture {
  return {
    produce: [
      produceRow({ id: "i1", quantity: 10, transaction_type: "เบิก" }),
      produceRow({ id: "i2", quantity: 4, transaction_type: "คืน" }),
    ],
    rawMessages: [{ id: "raw-1", source_id: SOURCE_A }],
    sessions: [{ id: "session-1", total_items: 2, parser_errors: null }],
    pending: [],
    parseErrors: [],
    centralPrices: [
      {
        product_key: "หมอนทอง",
        unit_key: "โล",
        business_date: DATE,
        price_satang: 12_000,
        set_by: "admin:je",
        set_reason: null,
        created_at: "2026-07-25T01:00:00.000Z",
        updated_at: "2026-07-25T01:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

describe("P1 business-date window", () => {
  test("covers the Bangkok 04:00 business day in UTC", () => {
    // Business date 2026-07-25 runs 04:00 Bangkok 25/07 → 04:00 Bangkok 26/07,
    // which is 21:00Z on 24/07 → 21:00Z on 25/07.
    expect(bangkokBusinessDateWindow(DATE)).toEqual({
      start: "2026-07-24T21:00:00.000Z",
      end: "2026-07-25T21:00:00.000Z",
    });
  });
});

describe("P1 loader", () => {
  test("produces a trusted report from clean data", async () => {
    const report = await loadSalesReport(fakeSupabase(baseFixture()), DATE);

    expect(report.businessDate).toBe(DATE);
    expect(report.markets).toHaveLength(1);
    expect(report.markets[0].rows[0].soldQuantity).toBe(6);
    expect(report.markets[0].rows[0].expectedSalesSatang).toBe(72_000);
    expect(report.allMarkets.valueAuthoritative).toBe(true);
    expect(report.blocked).toHaveLength(0);
  });

  test("keys the market on the LINE source, not the label alone", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          produce: [
            produceRow({ id: "i1", quantity: 10, transaction_type: "เบิก" }),
            produceRow({ id: "i2", quantity: 4, transaction_type: "คืน" }),
            produceRow({
              id: "i3",
              quantity: 8,
              transaction_type: "เบิก",
              session_id: "session-2",
              raw_message_id: "raw-2",
            }),
            produceRow({
              id: "i4",
              quantity: 3,
              transaction_type: "คืน",
              session_id: "session-2",
              raw_message_id: "raw-2",
            }),
          ],
          rawMessages: [
            { id: "raw-1", source_id: SOURCE_A },
            { id: "raw-2", source_id: SOURCE_B },
          ],
          sessions: [
            { id: "session-1", total_items: 2, parser_errors: null },
            { id: "session-2", total_items: 2, parser_errors: null },
          ],
        }),
      ),
      DATE,
    );

    // Same label "ตลาดกี้" under two sources — two markets, never merged.
    expect(report.markets).toHaveLength(2);
    expect(new Set(report.markets.map((market) => market.marketKey)).size).toBe(2);
  });

  test("blocks a session whose parser reported errors", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          sessions: [{ id: "session-1", total_items: 2, parser_errors: ["unreadable line 3"] }],
        }),
      ),
      DATE,
    );

    expect(report.blocked).toHaveLength(1);
    expect(report.blocked[0].reasons).toContain("session_parser_errors");
  });

  test("blocks a session whose persisted item count does not match", async () => {
    const report = await loadSalesReport(
      fakeSupabase(baseFixture({ sessions: [{ id: "session-1", total_items: 5, parser_errors: null }] })),
      DATE,
    );

    expect(report.blocked).toHaveLength(1);
    expect(report.blocked[0].reasons).toContain("session_item_count_mismatch");
  });

  test("an unresolved pending session demotes the day's totals", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          pending: [
            {
              id: "pending-1",
              finalized_at: null,
              finalized_produce_session_id: null,
              finalization_status: "pending",
            },
          ],
        }),
      ),
      DATE,
    );

    expect(report.scopeBlockers).toEqual([{ kind: "unresolved_pending_session", count: 1 }]);
    expect(report.allMarkets.valueAuthoritative).toBe(false);
  });

  test("a finalized pending row is not a blocker", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          pending: [
            {
              id: "pending-1",
              finalized_at: "2026-07-25T05:00:00.000Z",
              finalized_produce_session_id: "session-1",
              finalization_status: "finalized",
            },
          ],
        }),
      ),
      DATE,
    );

    expect(report.scopeBlockers).toHaveLength(0);
    expect(report.allMarkets.valueAuthoritative).toBe(true);
  });

  test("a crashed Produce parse demotes the day's totals", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          parseErrors: [
            { id: "pe-1", parser_name: "weigh-session", raw_message_id: "raw-1" },
            { id: "pe-2", parser_name: "weigh-session", raw_message_id: "raw-2" },
          ],
        }),
      ),
      DATE,
    );

    expect(report.scopeBlockers).toEqual([{ kind: "message_parser_error", count: 2 }]);
    expect(report.allMarkets.quantityAuthoritative).toBe(false);
    expect(report.allMarkets.valueAuthoritative).toBe(false);
  });

  test("a crash from an unrelated parser does not demote Sales", async () => {
    // parse_errors is generic. A slip/OCR/whatever parser blowing up cannot have
    // swallowed เบิก/คืน lines, and must not block the whole day's sales.
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          parseErrors: [{ id: "pe-1", parser_name: "manual-slip-amount", raw_message_id: "raw-9" }],
          rawMessages: [
            { id: "raw-1", source_id: SOURCE_A, raw_text: null },
            { id: "raw-9", source_id: SOURCE_A, raw_text: "โอนแล้วนะ 1200" },
          ],
        }),
      ),
      DATE,
    );

    expect(report.scopeBlockers).toEqual([]);
    expect(report.allMarkets.valueAuthoritative).toBe(true);
  });

  test("a crash on a non-text message does not demote Sales", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          parseErrors: [{ id: "pe-1", parser_name: "registry", raw_message_id: "raw-9" }],
          rawMessages: [
            { id: "raw-1", source_id: SOURCE_A, raw_text: null },
            { id: "raw-9", source_id: SOURCE_A, raw_text: null },
          ],
        }),
      ),
      DATE,
    );

    expect(report.scopeBlockers).toEqual([]);
  });

  test("an unknown parser crashing on a weighing message stays fail-closed", async () => {
    // A parser P1 has never heard of still blocks when the raw message itself
    // carries produce evidence — that is how a future Produce parser is covered.
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          parseErrors: [{ id: "pe-1", parser_name: "weigh-session-v2", raw_message_id: "raw-9" }],
          rawMessages: [
            { id: "raw-1", source_id: SOURCE_A, raw_text: null },
            { id: "raw-9", source_id: SOURCE_A, raw_text: "เบิก 25/07/2569\n1.หมอนทอง 10 โล" },
          ],
        }),
      ),
      DATE,
    );

    expect(report.scopeBlockers).toEqual([{ kind: "message_parser_error", count: 1 }]);
    expect(report.allMarkets.valueAuthoritative).toBe(false);
  });

  test("a parse error whose raw message cannot be read stays fail-closed", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          parseErrors: [{ id: "pe-1", parser_name: "mystery", raw_message_id: "raw-gone" }],
        }),
      ),
      DATE,
    );

    expect(report.scopeBlockers).toEqual([{ kind: "message_parser_error", count: 1 }]);
  });

  test("a system-seeded day price never overrides the round withdrawal price", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          centralPrices: [
            {
              product_key: "หมอนทอง",
              unit_key: "โล",
              business_date: DATE,
              price_satang: 11_000,
              set_by: "system:first-withdrawal",
              set_reason: null,
              created_at: "2026-07-25T01:00:00.000Z",
              updated_at: "2026-07-25T01:00:00.000Z",
            },
          ],
        }),
      ),
      DATE,
    );

    const result = report.markets[0].rows[0];
    expect(result).toMatchObject({ enteredPriceSatang: 12_000, centralPriceSatang: null, expectedSalesSatang: 72_000, valueStatus: "CONFIRMED", status: "TRUSTED" });
    expect(result.reasons).not.toContain("central_price_conflict");
    expect(report.blocked).toHaveLength(0);
    expect(report.allMarkets.totalSalesSatang).toBe(72_000);
  });

  test("a legacy admin day price does not override a usable round withdrawal price", async () => {
    const report = await loadSalesReport(fakeSupabase(baseFixture({
      centralPrices: [{
        product_key: "หมอนทอง",
        unit_key: "โล",
        business_date: DATE,
        price_satang: 11_000,
        set_by: "admin:je",
        set_reason: "approved correction",
        created_at: "2026-07-25T01:00:00.000Z",
        updated_at: "2026-07-25T01:00:00.000Z",
      }],
    })), DATE);
    const result = report.markets[0].rows[0];
    expect(result).toMatchObject({
      centralPriceSatang: null,
      enteredPriceSatang: 12_000,
      expectedSalesSatang: 72_000,
      pendingReviewSalesSatang: null,
      adjustmentSatang: 0,
      valueStatus: "CONFIRMED",
      status: "TRUSTED",
    });
    expect(report.allMarkets.totalSalesSatang).toBe(72_000);
  });

  test("a usable round withdrawal price needs no day-wide central price", async () => {
    const report = await loadSalesReport(
      fakeSupabase(baseFixture({ centralPrices: [] })),
      DATE,
    );

    const result = report.markets[0].rows[0];
    expect(result).toMatchObject({ soldQuantity: 6, enteredPriceSatang: 12_000, centralPriceSatang: null, expectedSalesSatang: 72_000, valueStatus: "CONFIRMED", status: "TRUSTED" });
    expect(report.blocked).toHaveLength(0);
    expect(report.allMarkets.totalSalesSatang).toBe(72_000);
  });

  test("legacy rows without an entered withdrawal price may use the central fallback", async () => {
    const report = await loadSalesReport(
      fakeSupabase(baseFixture({
        produce: [
          produceRow({ id: "i1", quantity: 10, transaction_type: "เบิก", price_per_unit: null }),
          produceRow({ id: "i2", quantity: 4, transaction_type: "คืน", price_per_unit: null }),
        ],
        centralPrices: [{
          product_key: "หมอนทอง",
          unit_key: "โล",
          business_date: DATE,
          price_satang: 11_000,
          set_by: "admin:je",
          set_reason: "legacy fallback",
          created_at: "2026-07-25T01:00:00.000Z",
          updated_at: "2026-07-25T01:00:00.000Z",
        }],
      })),
      DATE,
    );

    const result = report.markets[0].rows[0];
    expect(result).toMatchObject({
      soldQuantity: 6,
      enteredPriceSatang: null,
      centralPriceSatang: 11_000,
      expectedSalesSatang: 66_000,
      valueStatus: "CONFIRMED",
      status: "TRUSTED",
    });
    expect(report.blocked).toHaveLength(0);
  });

  test("a row whose LINE source cannot be resolved is blocked, not merged", async () => {
    const report = await loadSalesReport(
      fakeSupabase(baseFixture({ rawMessages: [] })),
      DATE,
    );

    expect(report.blocked[0].reasons).toContain("market_unresolved");
    expect(report.allMarkets.valueAuthoritative).toBe(false);
  });

  test("rejects a malformed business date", async () => {
    await expect(loadSalesReport(fakeSupabase(baseFixture()), "25/07/2026")).rejects.toThrow(
      SalesDataError,
    );
  });

  test("fails closed when the produce query errors", async () => {
    await expect(
      loadSalesReport(fakeSupabase(baseFixture({ errors: { produce_transactions: "boom" } })), DATE),
    ).rejects.toThrow("boom");
  });

  test("fails closed when the pending-session query errors", async () => {
    await expect(
      loadSalesReport(fakeSupabase(baseFixture({ errors: { pending_sessions: "nope" } })), DATE),
    ).rejects.toThrow("nope");
  });
});

describe("P1 pending-session lifecycle", () => {
  /** The real shape: failed_closed stamps finalized_at but produced nothing. */
  const FAILED_CLOSED = {
    id: "pending-failed",
    accumulated_text: "เบิก 25/07/2569\n1.หมอนทอง\n10 โล",
    created_at: "2026-07-25T03:00:00.000Z",
    finalized_at: "2026-07-25T04:00:00.000Z",
    finalized_produce_session_id: null,
    finalization_status: "failed_closed",
  };

  test("failed_closed stays visible even though finalized_at is set", async () => {
    const report = await loadSalesReport(
      fakeSupabase(baseFixture({ pending: [FAILED_CLOSED] })),
      DATE,
    );

    expect(report.scopeBlockers).toEqual([{ kind: "unresolved_pending_session", count: 1 }]);
    expect(report.allMarkets.quantityAuthoritative).toBe(false);
  });

  test("a null legacy finalization status survives the SQL prefilter", async () => {
    const report = await loadSalesReport(
      fakeSupabase(baseFixture({ pending: [{ ...FAILED_CLOSED, finalization_status: null }] })),
      DATE,
    );

    expect(report.scopeBlockers).toEqual([{ kind: "unresolved_pending_session", count: 1 }]);
    expect(filterLog).toContain(
      "pending_sessions.or:finalization_status.is.null,finalization_status.not.in.(finalized,duplicate,expired_empty_draft)",
    );
  });

  test("a failed_closed session the operator corrected and re-sent stops blocking", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          // Same round, later successful main session: the correction landed.
          pending: [
            {
              ...FAILED_CLOSED,
              accumulated_text: [
                "18:53 เสือ ตลาดกี้ เบิก 25/07/2569",
                "18:53 เสือ 1.หมอนทอง119บาท",
                "38โล",
              ].join("\n"),
              business_date: DATE,
              source_id: SOURCE_A,
              staff_label: "เสือ",
              market_label: "ตลาดกี้",
              declared_transaction_type: "เบิก",
              accountability_round_id: "round-1",
            },
          ],
          produce: [
            produceRow({ id: "ok-1", session_id: "session-ok", raw_message_id: "raw-ok" }),
          ],
          sessions: [
            {
              id: "session-ok",
              total_items: 1,
              parser_errors: null,
              staff_name: "เสือ",
              session_title: "ตลาดกี้",
              session_date: DATE,
              session_kind: "main",
              accountability_round_id: "round-1",
              raw_message_id: "raw-ok",
              finalized_at: "2026-07-25T06:00:00.000Z",
              voided_at: null,
            },
          ],
          rawMessages: [{ id: "raw-ok", source_id: SOURCE_A }],
        }),
      ),
      DATE,
    );

    expect(report.scopeBlockers).toEqual([]);
  });

  test("a success after the header but before the failed document ended is not later", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          pending: [{
            ...FAILED_CLOSED,
            session_key: "group:g1:user:u1",
            session_generation: "gen-1",
            accumulated_text: [
              "18:53 เสือ ตลาดกี้ เบิก 25/07/2569",
              "18:53 เสือ 1.หมอนทอง119บาท",
              "38โล",
            ].join("\n"),
            business_date: DATE,
            source_id: SOURCE_A,
            staff_label: "เสือ",
            market_label: "ตลาดกี้",
            declared_transaction_type: "เบิก",
            accountability_round_id: "round-1",
          }],
          pendingIngest: [
            { session_key: "group:g1:user:u1", session_generation: "gen-1", line_timestamp_ms: 1_000 },
            { session_key: "group:g1:user:u1", session_generation: "gen-1", line_timestamp_ms: 3_000 },
          ],
          produce: [produceRow({ id: "ok-1", session_id: "session-ok", raw_message_id: "raw-ok" })],
          sessions: [{
            id: "session-ok",
            total_items: 1,
            parser_errors: null,
            staff_name: "เสือ",
            session_title: "ตลาดกี้",
            session_date: DATE,
            session_kind: "main",
            accountability_round_id: "round-1",
            raw_message_id: "raw-ok",
            finalized_at: new Date(2_000).toISOString(),
            voided_at: null,
          }],
          rawMessages: [{ id: "raw-ok", source_id: SOURCE_A }],
        }),
      ),
      DATE,
    );

    expect(report.scopeBlockers).toEqual([{ kind: "unresolved_pending_session", count: 1 }]);
  });

  test("an active failed return after an earlier persisted zero return suppresses sold-out", async () => {
    const roundId = "round-active-return";
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          produce: [
            produceRow({ id: "w", quantity: 10, transaction_type: "เบิก", accountability_round_id: roundId }),
            produceRow({ id: "r", quantity: 0, transaction_type: "คืน", accountability_round_id: roundId }),
          ],
          sessions: [{
            id: "session-1",
            total_items: 2,
            parser_errors: null,
            staff_name: "เสือ",
            session_title: "ตลาดกี้",
            session_date: DATE,
            session_kind: "main",
            accountability_round_id: roundId,
            raw_message_id: "raw-1",
            finalized_at: "2026-07-25T03:00:00.000Z",
            voided_at: null,
          }],
          pending: [{
            ...FAILED_CLOSED,
            id: "failed-return",
            accumulated_text: "18:53 เสือ ตลาดกี้ คืน 25/07/2569\n1.หมอนทอง\n0 โล",
            created_at: "2026-07-25T04:00:00.000Z",
            source_id: SOURCE_A,
            staff_label: "เสือ",
            market_label: "ตลาดกี้",
            business_date: DATE,
            declared_transaction_type: "คืน",
            accountability_round_id: roundId,
          }],
        }),
      ),
      DATE,
    );

    expect(report.markets[0].rows[0].returnEvidenceIncomplete).toBe(true);
  });

  test("a persisted return that omitted a withdrawn product is not trusted sold-out", async () => {
    const roundId = "round-return-coverage";
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          produce: [
            produceRow({
              id: "w-a",
              product_name: "หมอนทอง",
              quantity: 10,
              transaction_type: "เบิก",
              accountability_round_id: roundId,
            }),
            produceRow({
              id: "w-b",
              product_name: "มะม่วง",
              quantity: 5,
              transaction_type: "เบิก",
              accountability_round_id: roundId,
            }),
            produceRow({
              id: "r-a",
              product_name: "หมอนทอง",
              quantity: 2,
              transaction_type: "คืน",
              base_transaction_type: "คืน",
              accountability_round_id: roundId,
            }),
          ],
          sessions: [{
            id: "session-1",
            total_items: 3,
            parser_errors: null,
            staff_name: "เสือ",
            session_title: "ตลาดกี้",
            session_date: DATE,
            session_kind: "main",
            accountability_round_id: roundId,
            raw_message_id: "raw-1",
            finalized_at: "2026-07-25T03:00:00.000Z",
            voided_at: null,
          }],
          accountabilityRounds: [{
            id: roundId,
            seller_label: "เสือ",
            market_label: "ตลาดกี้",
            status: "open",
          }],
          centralPrices: [
            {
              product_key: "หมอนทอง",
              unit_key: "โล",
              business_date: DATE,
              price_satang: 12_000,
              set_by: "admin:je",
              set_reason: null,
              created_at: "2026-07-25T01:00:00.000Z",
              updated_at: "2026-07-25T01:00:00.000Z",
            },
            {
              product_key: "มะม่วง",
              unit_key: "โล",
              business_date: DATE,
              price_satang: 8_000,
              set_by: "admin:je",
              set_reason: null,
              created_at: "2026-07-25T01:00:00.000Z",
              updated_at: "2026-07-25T01:00:00.000Z",
            },
          ],
        }),
      ),
      DATE,
    );

    const rows = report.markets.flatMap((market) => market.rows);
    const covered = rows.find((row) => row.productName === "หมอนทอง")!;
    const omitted = rows.find((row) => row.productName === "มะม่วง")!;
    expect(covered.status).toBe("TRUSTED");
    expect(covered.soldQuantity).toBe(8);
    expect(omitted.status).toBe("QUANTITY_BLOCKED");
    expect(omitted.reasons).toContain("product_return_absent");
    expect(omitted.soldQuantity).toBeNull();
    expect(report.allMarkets.expectedSalesSatang).toBe(96_000);
  });

  test("a failed_closed session whose round was retired is not an active problem", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          pending: [{ ...FAILED_CLOSED, accountability_round_id: "round-dead" }],
          accountabilityRounds: [{ id: "round-dead", status: "cancelled" }],
        }),
      ),
      DATE,
    );

    expect(report.scopeBlockers).toEqual([]);
  });

  test("finalized and duplicate are not blockers", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          pending: [
            { ...FAILED_CLOSED, id: "p-ok", finalization_status: "finalized", finalized_produce_session_id: "session-1" },
            { ...FAILED_CLOSED, id: "p-dup", finalization_status: "duplicate" },
          ],
        }),
      ),
      DATE,
    );

    expect(report.scopeBlockers).toEqual([]);
  });

  test("a backdated session blocks the date its header names, not the day it was typed", async () => {
    // Typed on the 5th, header says 04/07/2569 → business date 2026-07-04.
    const backdated = {
      ...FAILED_CLOSED,
      accumulated_text: "ตลาดกี้ เบิก 04/07/2569\n1.หมอนทอง\n10 โล",
      created_at: "2026-07-05T06:00:00.000Z",
      finalized_at: null,
      finalization_status: "pending",
    };

    const onNamedDate = await loadSalesReport(
      fakeSupabase(baseFixture({ pending: [backdated], produce: [], sessions: [] })),
      "2026-07-04",
    );
    const onTypedDate = await loadSalesReport(
      fakeSupabase(baseFixture({ pending: [backdated], produce: [], sessions: [] })),
      "2026-07-05",
    );

    expect(onNamedDate.scopeBlockers).toEqual([{ kind: "unresolved_pending_session", count: 1 }]);
    expect(onTypedDate.scopeBlockers).toEqual([]);
  });

  test("with no explicit date the deployed created_at fallback applies", async () => {
    const noDate = {
      ...FAILED_CLOSED,
      accumulated_text: "เบิก\n1.หมอนทอง\n10 โล",
      created_at: "2026-07-25T06:00:00.000Z",
    };

    const sameDay = await loadSalesReport(fakeSupabase(baseFixture({ pending: [noDate] })), DATE);
    expect(sameDay.scopeBlockers).toEqual([{ kind: "unresolved_pending_session", count: 1 }]);
  });
});

describe("P1 zero-row produce sessions", () => {
  const BROKEN_SESSION = {
    id: "session-empty",
    session_title: "ตลาดกี้",
    total_items: 4,
    parser_errors: null,
    raw_message_id: "raw-1",
    voided_at: null,
  };

  test("a session claiming items with no persisted rows fails closed", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          sessions: [{ id: "session-1", total_items: 2, parser_errors: null, raw_message_id: "raw-1", voided_at: null }, BROKEN_SESSION],
        }),
      ),
      DATE,
    );

    // Same source + label → the existing market is blocked, not the whole scope.
    expect(report.scopeBlockers).toEqual([]);
    expect(report.markets[0].total.quantityAuthoritative).toBe(false);
    expect(report.blocked.some((row) => row.reasons.includes("session_rows_missing"))).toBe(true);
  });

  test("a session that claimed nothing is not a failure", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          sessions: [
            { id: "session-1", total_items: 2, parser_errors: null, raw_message_id: "raw-1", voided_at: null },
            { ...BROKEN_SESSION, total_items: 0 },
          ],
        }),
      ),
      DATE,
    );

    expect(report.scopeBlockers).toEqual([]);
    expect(report.allMarkets.valueAuthoritative).toBe(true);
  });

  test("a broken session with no provable market becomes a scope blocker", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          sessions: [
            { id: "session-1", total_items: 2, parser_errors: null, raw_message_id: "raw-1", voided_at: null },
            { ...BROKEN_SESSION, session_title: null, raw_message_id: "raw-unknown" },
          ],
        }),
      ),
      DATE,
    );

    expect(report.scopeBlockers).toEqual([{ kind: "unattributable_session", count: 1 }]);
  });

  test("a session already audited through its rows is not counted twice", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          sessions: [{ id: "session-1", total_items: 5, parser_errors: null, raw_message_id: "raw-1", voided_at: null }],
        }),
      ),
      DATE,
    );

    // Counted once, through the row-based item-count mismatch.
    expect(report.scopeBlockers).toEqual([]);
    expect(report.blocked).toHaveLength(1);
    expect(report.blocked[0].reasons).toContain("session_item_count_mismatch");
    expect(report.blocked[0].reasons).not.toContain("session_rows_missing");
  });
});

describe("P1 produce validation failures", () => {
  const validationError = (overrides: Record<string, unknown> = {}) => ({
    id: "pe-v1",
    parser_name: "weigh-session",
    raw_message_id: "raw-9",
    ...overrides,
  });

  test("valid produce leaves no blocker", async () => {
    const report = await loadSalesReport(fakeSupabase(baseFixture()), DATE);
    expect(report.scopeBlockers).toEqual([]);
  });

  test("a produce validation failure blocks the day", async () => {
    const report = await loadSalesReport(
      fakeSupabase(baseFixture({ parseErrors: [validationError()] })),
      DATE,
    );

    expect(report.scopeBlockers).toEqual([{ kind: "message_parser_error", count: 1 }]);
  });

  test("an unrelated validation error does not block the day", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          parseErrors: [validationError({ parser_name: "manual-slip-amount" })],
          rawMessages: [
            { id: "raw-1", source_id: SOURCE_A, raw_text: null },
            { id: "raw-9", source_id: SOURCE_A, raw_text: "โอนแล้ว 1200" },
          ],
        }),
      ),
      DATE,
    );

    expect(report.scopeBlockers).toEqual([]);
  });

  test("a webhook retry recording the same failure twice is still one blocker", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          parseErrors: [validationError(), validationError({ id: "pe-v2" })],
        }),
      ),
      DATE,
    );

    expect(report.scopeBlockers).toEqual([{ kind: "message_parser_error", count: 1 }]);
  });
});

describe("P1 session audit scope", () => {
  test("audits only this business date's active sessions — voided ones are excluded", async () => {
    await loadSalesReport(fakeSupabase(baseFixture()), DATE);

    // The exclusion is the query itself: a voided session can never reach the
    // audit, exactly as produce_transactions already excludes its rows.
    expect(filterLog).toContain(`produce_sessions.eq:session_date=${DATE}`);
    expect(filterLog).toContain("produce_sessions.is:voided_at=null");
  });
});

describe("P1 parse-error business-date attribution", () => {
  /** Received on the 26th, but the header says 25/07/2569 → the 25th. */
  const BACKDATED_TEXT = "18:53 เสือ รายการชั่งเบิกไปตลาด\n25/07/2569\n18:53 เสือ 1.หมอนทอง119บาท";
  const backdatedMessages = [
    { id: "raw-1", source_id: SOURCE_A, raw_text: null, created_at: "2026-07-25T03:00:00.000Z" },
    { id: "raw-9", source_id: SOURCE_A, raw_text: BACKDATED_TEXT, created_at: "2026-07-26T06:00:00.000Z" },
  ];

  test("a backdated produce crash blocks the date the header names", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          parseErrors: [{ id: "pe-1", parser_name: "weigh-session", raw_message_id: "raw-9" }],
          rawMessages: backdatedMessages,
        }),
      ),
      DATE,
    );

    expect(report.scopeBlockers).toEqual([{ kind: "message_parser_error", count: 1 }]);
  });

  test("…and does not block the day it was received", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          parseErrors: [{ id: "pe-1", parser_name: "weigh-session", raw_message_id: "raw-9" }],
          rawMessages: backdatedMessages,
          produce: [],
          sessions: [],
        }),
      ),
      "2026-07-26",
    );

    expect(report.scopeBlockers).toEqual([]);
  });

  test("a backdated produce validation failure behaves identically", async () => {
    const fixture = (date: string) =>
      loadSalesReport(
        fakeSupabase(
          baseFixture({
            parseErrors: [
              { id: "pe-1", parser_name: "weigh-session", raw_message_id: "raw-9", error_type: "validation_error" },
            ],
            rawMessages: backdatedMessages,
            produce: [],
            sessions: [],
          }),
        ),
        date,
      );

    expect((await fixture(DATE)).scopeBlockers).toEqual([
      { kind: "message_parser_error", count: 1 },
    ]);
    expect((await fixture("2026-07-26")).scopeBlockers).toEqual([]);
  });

  test("a same-day produce error still blocks that day", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          parseErrors: [{ id: "pe-1", parser_name: "weigh-session", raw_message_id: "raw-9" }],
          rawMessages: [
            backdatedMessages[0],
            {
              id: "raw-9",
              source_id: SOURCE_A,
              // No explicit header date → the arrival time decides, as deployed.
              raw_text: "18:53 เสือ รายการชั่งเบิกไปตลาด\n18:53 เสือ 1.หมอนทอง119บาท",
              created_at: "2026-07-25T06:00:00.000Z",
            },
          ],
        }),
      ),
      DATE,
    );

    expect(report.scopeBlockers).toEqual([{ kind: "message_parser_error", count: 1 }]);
  });

  test("an unrelated error is still ignored, whatever its date", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          parseErrors: [{ id: "pe-1", parser_name: "manual-slip-amount", raw_message_id: "raw-9" }],
          rawMessages: [
            backdatedMessages[0],
            { id: "raw-9", source_id: SOURCE_A, raw_text: "โอนแล้ว 1200", created_at: "2026-07-25T06:00:00.000Z" },
          ],
        }),
      ),
      DATE,
    );

    expect(report.scopeBlockers).toEqual([]);
  });
});

describe("P1 pending sessions have no backdating ceiling", () => {
  test("a session entered three weeks late still blocks the date it names", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          pending: [
            {
              id: "pending-late",
              accumulated_text: "ตลาดกี้ เบิก 25/07/2569\n1.หมอนทอง\n10 โล",
              created_at: "2026-08-15T06:00:00.000Z", // 21 days after the business date
              finalized_at: null,
              finalization_status: "pending",
            },
          ],
        }),
      ),
      DATE,
    );

    expect(report.scopeBlockers).toEqual([{ kind: "unresolved_pending_session", count: 1 }]);
  });

  test("a long-resolved session never blocks, however old", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          pending: [
            {
              id: "pending-old",
              accumulated_text: "ตลาดกี้ เบิก 25/07/2569\n1.หมอนทอง\n10 โล",
              created_at: "2026-08-15T06:00:00.000Z",
              finalized_at: "2026-08-15T06:05:00.000Z",
              finalization_status: "finalized",
            },
          ],
        }),
      ),
      DATE,
    );

    expect(report.scopeBlockers).toEqual([]);
  });
});

describe("P1 strict business date", () => {
  test("a date that never existed is refused before any read", async () => {
    for (const bad of ["2026-02-31", "2026-04-31", "2026-13-01", "2026-00-10", "2027-02-29"]) {
      expect(loadSalesReport(fakeSupabase(baseFixture()), bad)).rejects.toThrow(SalesDataError);
    }
  });

  test("a real leap day is accepted", async () => {
    const report = await loadSalesReport(fakeSupabase(baseFixture()), "2028-02-29");
    expect(report.businessDate).toBe("2028-02-29");
  });
});

// ── 04:00 cutoff: LINE event time is the source of truth ────────────────────

/**
 * 2026-07-26 03:59:59 Bangkok = 2026-07-25T20:59:59Z → business date 2026-07-25.
 * 2026-07-26 04:00:00 Bangkok = 2026-07-25T21:00:00Z → business date 2026-07-26.
 * The DB insert lands after the cutoff in both cases, so anything that reads
 * created_at instead of the event timestamp files the first one on the 26th.
 */
const BEFORE_CUTOFF_MS = Date.parse("2026-07-25T20:59:59.000Z");
const AT_CUTOFF_MS = Date.parse("2026-07-25T21:00:00.000Z");
const INSERTED_AFTER_CUTOFF = "2026-07-25T21:00:01.000Z";

/** A produce message with NO explicit header date — the fallback decides. */
const UNDATED_PRODUCE = "18:53 เสือ รายการชั่งเบิกไปตลาด\n18:53 เสือ 1.หมอนทอง119บาท\n38โล";
/** …and one that names its own date. */
const DATED_PRODUCE = "18:53 เสือ รายการชั่งเบิกไปตลาด\n25/07/2569\n18:53 เสือ 1.หมอนทอง119บาท\n38โล";

function parseErrorFixture(message: Record<string, unknown>): Fixture {
  return baseFixture({
    produce: [],
    sessions: [],
    parseErrors: [{ id: "pe-1", parser_name: "weigh-session", raw_message_id: "raw-9" }],
    rawMessages: [{ id: "raw-9", source_id: SOURCE_A, ...message }],
  });
}

describe("P1 business-date fallback uses the LINE event timestamp", () => {
  test("A. an event at 03:59:59 inserted after 04:00 belongs to the previous date", async () => {
    const message = {
      raw_text: UNDATED_PRODUCE,
      payload: { timestamp: BEFORE_CUTOFF_MS },
      created_at: INSERTED_AFTER_CUTOFF,
    };

    const previous = await loadSalesReport(fakeSupabase(parseErrorFixture(message)), "2026-07-25");
    const next = await loadSalesReport(fakeSupabase(parseErrorFixture(message)), "2026-07-26");

    expect(previous.scopeBlockers).toEqual([{ kind: "message_parser_error", count: 1 }]);
    // The insert time says the 26th; the event time is authoritative and says no.
    expect(next.scopeBlockers).toEqual([]);
  });

  test("B. an event at exactly 04:00:00 belongs to the new business date", async () => {
    const message = {
      raw_text: UNDATED_PRODUCE,
      payload: { timestamp: AT_CUTOFF_MS },
      created_at: INSERTED_AFTER_CUTOFF,
    };

    const previous = await loadSalesReport(fakeSupabase(parseErrorFixture(message)), "2026-07-25");
    const next = await loadSalesReport(fakeSupabase(parseErrorFixture(message)), "2026-07-26");

    expect(previous.scopeBlockers).toEqual([]);
    expect(next.scopeBlockers).toEqual([{ kind: "message_parser_error", count: 1 }]);
  });

  test("C. an explicit header date wins over both timestamps", async () => {
    const message = {
      raw_text: DATED_PRODUCE, // says 25/07/2569
      payload: { timestamp: AT_CUTOFF_MS }, // would say the 26th
      created_at: INSERTED_AFTER_CUTOFF,
    };

    const named = await loadSalesReport(fakeSupabase(parseErrorFixture(message)), "2026-07-25");
    const other = await loadSalesReport(fakeSupabase(parseErrorFixture(message)), "2026-07-26");

    expect(named.scopeBlockers).toEqual([{ kind: "message_parser_error", count: 1 }]);
    expect(other.scopeBlockers).toEqual([]);
  });

  test("D. a backdated header still wins when ingestion is much later", async () => {
    const message = {
      raw_text: DATED_PRODUCE,
      payload: { timestamp: Date.parse("2026-08-15T06:00:00.000Z") },
      created_at: "2026-08-15T06:00:01.000Z",
    };

    const named = await loadSalesReport(fakeSupabase(parseErrorFixture(message)), "2026-07-25");
    expect(named.scopeBlockers).toEqual([{ kind: "message_parser_error", count: 1 }]);
  });

  test("E. a malformed payload falls back to the insert time, never to nothing", async () => {
    const message = {
      raw_text: UNDATED_PRODUCE,
      payload: { timestamp: "not-a-number" },
      created_at: "2026-07-25T06:00:00.000Z",
    };

    const report = await loadSalesReport(fakeSupabase(parseErrorFixture(message)), DATE);
    expect(report.scopeBlockers).toEqual([{ kind: "message_parser_error", count: 1 }]);
  });

  test("E2. no timing evidence at all blocks the requested date", async () => {
    const message = { raw_text: UNDATED_PRODUCE, payload: null, created_at: null };

    const report = await loadSalesReport(fakeSupabase(parseErrorFixture(message)), "2030-01-01");
    expect(report.scopeBlockers).toEqual([{ kind: "message_parser_error", count: 1 }]);
  });
});

describe("P1 pending sessions use the stored LINE ingest timestamp", () => {
  function pendingFixture(ingest: Record<string, unknown>[]): Fixture {
    return baseFixture({
      produce: [],
      sessions: [],
      pending: [
        {
          id: "pending-1",
          session_key: "group:g1:user:u1",
          session_generation: "gen-1",
          accumulated_text: UNDATED_PRODUCE,
          created_at: INSERTED_AFTER_CUTOFF,
          finalization_status: "pending",
        },
      ],
      pendingIngest: ingest,
    });
  }

  test("A. an ingest at 03:59:59 beats a created_at after the cutoff", async () => {
    const ingest = [
      {
        session_key: "group:g1:user:u1",
        session_generation: "gen-1",
        line_timestamp_ms: BEFORE_CUTOFF_MS,
      },
    ];

    const previous = await loadSalesReport(fakeSupabase(pendingFixture(ingest)), "2026-07-25");
    const next = await loadSalesReport(fakeSupabase(pendingFixture(ingest)), "2026-07-26");

    expect(previous.scopeBlockers).toEqual([{ kind: "unresolved_pending_session", count: 1 }]);
    expect(next.scopeBlockers).toEqual([]);
  });

  test("B. an ingest at exactly 04:00:00 belongs to the new business date", async () => {
    const ingest = [
      {
        session_key: "group:g1:user:u1",
        session_generation: "gen-1",
        line_timestamp_ms: AT_CUTOFF_MS,
      },
    ];

    const next = await loadSalesReport(fakeSupabase(pendingFixture(ingest)), "2026-07-26");
    expect(next.scopeBlockers).toEqual([{ kind: "unresolved_pending_session", count: 1 }]);
  });

  test("the earliest ingest of the generation decides, not a later append", async () => {
    const ingest = [
      {
        session_key: "group:g1:user:u1",
        session_generation: "gen-1",
        line_timestamp_ms: AT_CUTOFF_MS + 60_000,
      },
      {
        session_key: "group:g1:user:u1",
        session_generation: "gen-1",
        line_timestamp_ms: BEFORE_CUTOFF_MS,
      },
    ];

    const previous = await loadSalesReport(fakeSupabase(pendingFixture(ingest)), "2026-07-25");
    expect(previous.scopeBlockers).toEqual([{ kind: "unresolved_pending_session", count: 1 }]);
  });

  test("E. with no ingest evidence the created_at fallback applies", async () => {
    const report = await loadSalesReport(fakeSupabase(pendingFixture([])), "2026-07-26");
    expect(report.scopeBlockers).toEqual([{ kind: "unresolved_pending_session", count: 1 }]);
  });
});

describe("P1 null session_date must not escape", () => {
  const nullDated = (overrides: Record<string, unknown> = {}) => ({
    id: "session-nulldate",
    session_title: "ตลาดกี้",
    total_items: 3,
    parser_errors: null,
    raw_message_id: "raw-9",
    voided_at: null,
    session_date: null,
    ...overrides,
  });

  function fixture(session: Record<string, unknown>, message: Record<string, unknown>): Fixture {
    return baseFixture({
      produce: [],
      sessions: [session],
      rawMessages: [{ id: "raw-9", source_id: SOURCE_A, ...message }],
    });
  }

  test("an explicit header date attributes it to that day only", async () => {
    const message = { raw_text: DATED_PRODUCE, payload: { timestamp: AT_CUTOFF_MS }, created_at: INSERTED_AFTER_CUTOFF };

    const named = await loadSalesReport(fakeSupabase(fixture(nullDated(), message)), "2026-07-25");
    const other = await loadSalesReport(fakeSupabase(fixture(nullDated(), message)), "2026-07-26");

    expect(named.blocked.some((row) => row.reasons.includes("session_date_missing"))).toBe(true);
    expect(named.markets[0].marketLabel).toContain("ตลาดกี้");
    // An unrelated null-dated session must not demote every other report.
    expect(other.blocked).toHaveLength(0);
    expect(other.scopeBlockers).toEqual([]);
  });

  test("with no header date the LINE event timestamp attributes it", async () => {
    const message = { raw_text: UNDATED_PRODUCE, payload: { timestamp: BEFORE_CUTOFF_MS }, created_at: INSERTED_AFTER_CUTOFF };

    const previous = await loadSalesReport(fakeSupabase(fixture(nullDated(), message)), "2026-07-25");
    const next = await loadSalesReport(fakeSupabase(fixture(nullDated(), message)), "2026-07-26");

    expect(previous.blocked.some((row) => row.reasons.includes("session_date_missing"))).toBe(true);
    expect(next.blocked).toHaveLength(0);
  });

  test("an undatable session fails closed on whatever date is asked", async () => {
    const message = { raw_text: null, payload: null, created_at: null };

    for (const date of [DATE, "2026-01-15"]) {
      const report = await loadSalesReport(fakeSupabase(fixture(nullDated(), message)), date);
      expect(report.blocked.some((row) => row.reasons.includes("session_date_missing"))).toBe(true);
    }
  });

  test("a voided null-dated session does not block", async () => {
    // The exclusion is the query: voided rows never reach the audit.
    await loadSalesReport(fakeSupabase(baseFixture()), DATE);
    expect(filterLog).toContain("produce_sessions.is:session_date=null");
    expect(filterLog).toContain("produce_sessions.is:voided_at=null");
  });

  test("ordinary dated sessions are unaffected", async () => {
    const report = await loadSalesReport(fakeSupabase(baseFixture()), DATE);
    expect(report.blocked).toHaveLength(0);
    expect(report.allMarkets.valueAuthoritative).toBe(true);
  });
});

describe("P1 durable evidence for a rejected produce message", () => {
  const lostMessage = (overrides: Record<string, unknown> = {}) => ({
    id: "raw-lost",
    source_id: SOURCE_A,
    raw_text: DATED_PRODUCE,
    payload: { timestamp: Date.parse("2026-07-25T06:00:00.000Z") },
    created_at: "2026-07-25T06:00:01.000Z",
    is_processed: false,
    ...overrides,
  });

  function fixture(messages: Record<string, unknown>[], extra: Fixture = {}): Fixture {
    return baseFixture({ produce: [], sessions: [], rawMessages: messages, ...extra });
  }

  test("an unprocessed complete produce message with no evidence at all still blocks", async () => {
    // This is the case where even the parse_errors write failed. The header
    // names a market, so the block lands on that market rather than the scope.
    const named = lostMessage({
      raw_text: ["18:53 เสือ ตลาดกี้ เบิก 25/07/2569", "18:53 เสือ 1.หมอนทอง119บาท", "38โล"].join("\n"),
    });
    const report = await loadSalesReport(fakeSupabase(fixture([named])), DATE);

    expect(report.blocked.some((row) => row.reasons.includes("produce_message_never_landed"))).toBe(true);
    expect(report.markets[0].marketLabel).toBe("ตลาดกี้");
    expect(report.allMarkets.quantityAuthoritative).toBe(false);
  });

  test("a rejected deferred item fragment is preserved as evidence but not treated as a lost document", async () => {
    const report = await loadSalesReport(fakeSupabase(fixture([], {
      deferredProduce: [{
        raw_message_id: "raw-deferred-orphan",
        source_id: SOURCE_A,
        raw_text: "1อะโวคาโด้50บาท\n26.7.โลก",
        line_timestamp_ms: Date.parse("2026-07-25T06:00:00.000Z"),
        status: "rejected_after_close",
      }],
    })), DATE);

    expect(report.scopeBlockers).toEqual([]);
    expect(report.blocked.some((row) =>
      row.reasons.includes("produce_message_never_landed"))).toBe(false);
    expect(report.allMarkets.quantityAuthoritative).toBe(true);
  });

  test("a complete rejected deferred document remains visible as possible lost Produce", async () => {
    const report = await loadSalesReport(fakeSupabase(fixture([], {
      deferredProduce: [{
        raw_message_id: "raw-deferred-document",
        source_id: SOURCE_A,
        raw_text: ["เสือ ตลาดกี้ เบิก 25/07/2569", "1.หมอนทอง119บาท", "38โล"].join("\n"),
        line_timestamp_ms: Date.parse("2026-07-25T06:00:00.000Z"),
        status: "rejected_orphan",
      }],
    })), DATE);

    expect(report.blocked.some((row) =>
      row.reasons.includes("produce_message_never_landed"))).toBe(true);
    expect(report.allMarkets.quantityAuthoritative).toBe(false);
  });

  test("an admitted deferred item is excluded from lost Produce evidence", async () => {
    const report = await loadSalesReport(fakeSupabase(fixture([], {
      deferredProduce: [{
        raw_message_id: "raw-deferred-admitted",
        source_id: SOURCE_A,
        raw_text: "1อะโวคาโด้50บาท\n26.7.โล",
        line_timestamp_ms: Date.parse("2026-07-25T06:00:00.000Z"),
        status: "admitted",
      }],
    })), DATE);

    expect(report.blocked.some((row) =>
      row.reasons.includes("produce_message_never_landed"))).toBe(false);
    expect(report.scopeBlockers).toEqual([]);
  });

  /**
   * Case A: the seller sent a bad document, it was refused, and the corrected
   * one landed. The refused raw message stays in raw_messages forever — nothing
   * ever rewrites is_processed — so before the lifecycle layer the morning
   * report announced it as an unrecorded weighing every single day.
   */
  const NAMED_LOST = ["18:53 เสือ ตลาดกี้ เบิก 25/07/2569", "18:53 เสือ 1.หมอนทอง119บาท", "38โล"].join("\n");

  function correctionFixture(successor: Record<string, unknown> = {}): Fixture {
    return baseFixture({
      produce: [produceRow({ id: "ok-1", session_id: "session-ok", raw_message_id: "raw-ok" })],
      sessions: [
        {
          id: "session-ok",
          total_items: 1,
          parser_errors: null,
          staff_name: "เสือ",
          session_title: "ตลาดกี้",
          session_date: DATE,
          session_kind: "main",
          // Production correction shape: the raw failure is unbound, while the
          // successful retry is attached to the canonical accountability round.
          accountability_round_id: "round-ok",
          raw_message_id: "raw-ok",
          finalized_at: "2026-07-25T07:00:00.000Z",
          voided_at: null,
          ...successor,
        },
      ],
      rawMessages: [
        lostMessage({ raw_text: NAMED_LOST, user_id: "operator-a" }),
        { id: "raw-ok", source_id: SOURCE_A, user_id: "operator-a" },
      ],
    });
  }

  test("a refused message that was corrected and re-sent stops polluting the report", async () => {
    const report = await loadSalesReport(fakeSupabase(correctionFixture()), DATE);

    expect(report.blocked.some((row) => row.reasons.includes("produce_message_never_landed"))).toBe(
      false,
    );
    expect(report.scopeBlockers).toEqual([]);
    expect(report.allMarkets.quantityAuthoritative).toBe(true);
  });

  test("a corrected retry by another LINE user still supersedes the unbound failure", async () => {
    const fixture = correctionFixture({ line_user_id: "operator-b" });
    fixture.rawMessages = fixture.rawMessages?.map((row) =>
      row.id === "raw-ok" ? { ...row, user_id: "operator-b" } : row
    );
    const report = await loadSalesReport(fakeSupabase(fixture), DATE);

    expect(report.blocked.some((row) => row.reasons.includes("produce_message_never_landed"))).toBe(
      false,
    );
    expect(report.allMarkets.quantityAuthoritative).toBe(true);
  });

  test("the correction must come from the same market", async () => {
    const report = await loadSalesReport(
      fakeSupabase(correctionFixture({ session_title: "ตลาดน้อย" })),
      DATE,
    );
    expect(report.blocked.some((row) => row.reasons.includes("produce_message_never_landed"))).toBe(
      true,
    );
  });

  test("the correction must come from the same seller", async () => {
    const report = await loadSalesReport(
      fakeSupabase(correctionFixture({ staff_name: "ดำ" })),
      DATE,
    );
    expect(report.blocked.some((row) => row.reasons.includes("produce_message_never_landed"))).toBe(
      true,
    );
  });

  test("a success that landed BEFORE the refusal is not a correction", async () => {
    const report = await loadSalesReport(
      fakeSupabase(correctionFixture({ finalized_at: "2026-07-25T05:00:00.000Z" })),
      DATE,
    );
    expect(report.blocked.some((row) => row.reasons.includes("produce_message_never_landed"))).toBe(
      true,
    );
  });

  test("an additional batch is additive and never counts as the correction", async () => {
    const report = await loadSalesReport(
      fakeSupabase(correctionFixture({ session_kind: "additional" })),
      DATE,
    );
    expect(report.blocked.some((row) => row.reasons.includes("produce_message_never_landed"))).toBe(
      true,
    );
  });

  test("a lost message whose header names no market becomes a scope blocker", async () => {
    const report = await loadSalesReport(fakeSupabase(fixture([lostMessage()])), DATE);

    expect(report.scopeBlockers).toEqual([{ kind: "unattributable_session", count: 1 }]);
    expect(report.allMarkets.quantityAuthoritative).toBe(false);
  });

  test("the same message is reported once when the parse_errors write DID succeed", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        fixture([lostMessage()], {
          parseErrors: [{ id: "pe-1", parser_name: "weigh-session", raw_message_id: "raw-lost" }],
        }),
      ),
      DATE,
    );

    expect(report.scopeBlockers).toEqual([{ kind: "message_parser_error", count: 1 }]);
    expect(report.blocked.some((row) => row.reasons.includes("produce_message_never_landed"))).toBe(false);
  });

  test("a message that did land is not reported as lost", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        fixture([lostMessage({ is_processed: true })], {
          sessions: [
            { id: "session-1", total_items: 1, parser_errors: null, raw_message_id: "raw-lost", voided_at: null },
          ],
        }),
      ),
      DATE,
    );

    expect(report.blocked.some((row) => row.reasons.includes("produce_message_never_landed"))).toBe(false);
  });

  test("a header-only message is left to the pending-session check", async () => {
    const report = await loadSalesReport(
      fakeSupabase(fixture([lostMessage({ raw_text: "ตลาดกี้ เบิก 25/07/2569" })])),
      DATE,
    );

    expect(report.blocked).toHaveLength(0);
  });

  test("a closing message alone is not mistaken for a complete entry", async () => {
    const report = await loadSalesReport(
      fakeSupabase(fixture([lostMessage({ raw_text: "จบรายการคืน" })])),
      DATE,
    );

    expect(report.blocked).toHaveLength(0);
  });

  test("an ordinary chat message is never reported", async () => {
    const report = await loadSalesReport(
      fakeSupabase(fixture([lostMessage({ raw_text: "พรุ่งนี้เจอกันนะ" })])),
      DATE,
    );

    expect(report.blocked).toHaveLength(0);
  });

  test("a lost message is attributed to the day its header names, not its arrival", async () => {
    const other = await loadSalesReport(fakeSupabase(fixture([lostMessage()])), "2026-07-26");
    expect(other.blocked).toHaveLength(0);
  });
});

// ── Proven duplicates are not lost produce ─────────────────────────────────

/**
 * The Production shape: a resend of a complete produce message. The produce
 * landed under an EARLIER raw message, so this one has no produce_session of
 * its own, no parse_error of its own, and (historically) is_processed = false.
 * Only the deployed dedup identity can tell it apart from genuinely lost data.
 */
const DUPLICATE_TEXT = [
  "18:53 เสือ ตลาดกี้ เบิก 25/07/2569",
  "18:53 เสือ 1.หมอนทอง119บาท",
  "38โล",
].join("\n");

function hashesOf(text: string) {
  const parsed = parseWeighSession(text);
  return {
    session_hash: computeSessionHash(parsed),
    item_hashes: parsed.items.map((item) => computeItemHash(parsed, item)),
  };
}

function resentMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "raw-resent",
    source_id: SOURCE_A,
    raw_text: DUPLICATE_TEXT,
    payload: { timestamp: Date.parse("2026-07-25T06:00:00.000Z") },
    created_at: "2026-07-25T06:00:01.000Z",
    is_processed: false,
    ...overrides,
  };
}

function lostFixture(messages: Record<string, unknown>[], extra: Fixture = {}): Fixture {
  return baseFixture({ produce: [], sessions: [], rawMessages: messages, ...extra });
}

function lostBlockers(report: Awaited<ReturnType<typeof loadSalesReport>>): number {
  return (
    report.blocked.filter((row) => row.reasons.includes("produce_message_never_landed")).length
    + report.scopeBlockers.filter((blocker) => blocker.kind === "unattributable_session").length
  );
}

describe("P1 lost-produce audit recognises proven duplicates", () => {
  /** The full proof: the dedup reservation AND every item persisted. */
  function provenDuplicate(text = DUPLICATE_TEXT): Fixture {
    const { session_hash, item_hashes } = hashesOf(text);
    return {
      importedSessions: [{ session_hash }],
      produceItems: item_hashes.map((item_hash) => ({ item_hash })),
    };
  }

  test("D. a historical unprocessed duplicate with the full proof is not a blocker", async () => {
    const report = await loadSalesReport(
      fakeSupabase(lostFixture([resentMessage()], provenDuplicate())),
      DATE,
    );

    expect(lostBlockers(report)).toBe(0);
  });

  test("a duplicate whose is_processed update failed is not a blocker", async () => {
    const report = await loadSalesReport(
      fakeSupabase(lostFixture([resentMessage()], provenDuplicate())),
      DATE,
    );

    expect(lostBlockers(report)).toBe(0);
  });

  test("a webhook redelivery of the same produce is not a blocker", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        lostFixture([resentMessage(), resentMessage({ id: "raw-redelivered" })], provenDuplicate()),
      ),
      DATE,
    );

    expect(lostBlockers(report)).toBe(0);
  });

  test("C. a ghost reservation — session hash but no persisted items — does NOT excuse it", async () => {
    // The webhook releases exactly this reservation rather than trusting it.
    const { session_hash } = hashesOf(DUPLICATE_TEXT);
    const report = await loadSalesReport(
      fakeSupabase(lostFixture([resentMessage()], { importedSessions: [{ session_hash }] })),
      DATE,
    );

    expect(lostBlockers(report)).toBe(1);
  });

  // A ขีด message imported before the 2026-08-19 subunit price fix was hashed
  // with the old rescaled price (119 / 0.1 = 1190). Re-parsing it today yields
  // 119, so without the legacy-priced reading its proof no longer matches and
  // produce that demonstrably landed is reported as lost.
  test("a duplicate imported before the subunit price fix keeps its proof", async () => {
    const kheedText = [
      "18:53 เสือ ตลาดกี้ เบิก 25/07/2569",
      "18:53 เสือ 1.หมอนทอง119บาท",
      "0.8ขีด",
    ].join("\n");
    const parsed = parseWeighSession(kheedText);
    // Exactly what the pre-fix parser produced for this message: the price
    // divided by the ขีด factor, spelled out rather than derived from the code
    // under test.
    const asImported = {
      ...parsed,
      items: parsed.items.map((item) => ({ ...item, price_per_unit: 1190 })),
    };

    expect(parsed.items[0]).toMatchObject({ quantity: 0.08, unit: "โล", price_per_unit: 119 });

    const report = await loadSalesReport(
      fakeSupabase(
        lostFixture([resentMessage({ raw_text: kheedText })], {
          importedSessions: [{ session_hash: computeSessionHash(asImported) }],
          produceItems: asImported.items.map((item) => ({
            item_hash: computeItemHash(asImported, item),
          })),
        }),
      ),
      DATE,
    );

    expect(lostBlockers(report)).toBe(0);
  });

  test("A. a partially persisted session — item A landed, item B did not — still blocks", async () => {
    const twoItems = [
      "18:53 เสือ ตลาดกี้ เบิก 25/07/2569",
      "18:53 เสือ 1.หมอนทอง119บาท",
      "38โล",
      "18:53 เสือ 2.ชะนี100บาท",
      "12โล",
    ].join("\n");
    const { session_hash, item_hashes } = hashesOf(twoItems);
    expect(item_hashes).toHaveLength(2);

    const report = await loadSalesReport(
      fakeSupabase(
        lostFixture([resentMessage({ raw_text: twoItems })], {
          importedSessions: [{ session_hash }],
          produceItems: [{ item_hash: item_hashes[0] }], // only item A
        }),
      ),
      DATE,
    );

    expect(lostBlockers(report)).toBe(1);
  });

  test("B. the same session with BOTH items persisted is accounted", async () => {
    const twoItems = [
      "18:53 เสือ ตลาดกี้ เบิก 25/07/2569",
      "18:53 เสือ 1.หมอนทอง119บาท",
      "38โล",
      "18:53 เสือ 2.ชะนี100บาท",
      "12โล",
    ].join("\n");
    const { session_hash, item_hashes } = hashesOf(twoItems);

    const report = await loadSalesReport(
      fakeSupabase(
        lostFixture([resentMessage({ raw_text: twoItems })], {
          importedSessions: [{ session_hash }],
          produceItems: item_hashes.map((item_hash) => ({ item_hash })),
        }),
      ),
      DATE,
    );

    expect(lostBlockers(report)).toBe(0);
  });

  test("two identical item lines need two persisted rows, not one", async () => {
    const repeated = [
      "18:53 เสือ ตลาดกี้ เบิก 25/07/2569",
      "18:53 เสือ 1.หมอนทอง119บาท",
      "38โล",
      "18:53 เสือ 2.หมอนทอง119บาท",
      "38โล",
    ].join("\n");
    const { session_hash, item_hashes } = hashesOf(repeated);

    const halfPersisted = await loadSalesReport(
      fakeSupabase(
        lostFixture([resentMessage({ raw_text: repeated })], {
          importedSessions: [{ session_hash }],
          produceItems: [{ item_hash: item_hashes[0] }],
        }),
      ),
      DATE,
    );
    const fullyPersisted = await loadSalesReport(
      fakeSupabase(
        lostFixture([resentMessage({ raw_text: repeated })], {
          importedSessions: [{ session_hash }],
          produceItems: item_hashes.map((item_hash) => ({ item_hash })),
        }),
      ),
      DATE,
    );

    // Identical lines hash identically, so multiplicity is what distinguishes
    // "both landed" from "one landed twice over".
    if (new Set(item_hashes).size === 1) expect(lostBlockers(halfPersisted)).toBe(1);
    expect(lostBlockers(fullyPersisted)).toBe(0);
  });

  test("F. genuinely rejected produce with no proof anywhere is still a blocker", async () => {
    const report = await loadSalesReport(fakeSupabase(lostFixture([resentMessage()])), DATE);

    expect(lostBlockers(report)).toBe(1);
    expect(report.blocked[0].reasons).toContain("produce_message_never_landed");
  });

  test("a validation failure with its parse_error is reported once, not twice", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        lostFixture([resentMessage()], {
          parseErrors: [
            { id: "pe-1", parser_name: "weigh-session", raw_message_id: "raw-resent" },
          ],
        }),
      ),
      DATE,
    );

    expect(report.scopeBlockers).toEqual([{ kind: "message_parser_error", count: 1 }]);
    expect(lostBlockers(report)).toBe(0);
  });

  test("a different session's proof does not excuse a lost message", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        lostFixture(
          [resentMessage()],
          provenDuplicate(
            ["18:53 เสือ ตลาดอื่น เบิก 25/07/2569", "18:53 เสือ 1.ชะนี100บาท", "5โล"].join("\n"),
          ),
        ),
      ),
      DATE,
    );

    expect(lostBlockers(report)).toBe(1);
  });
});

describe("P1 lost-produce scan has no created_at lower bound", () => {
  /** Sent on 20/07 but headed 25/07/2569 — a real future-dated entry shape. */
  const futureDated = (id: string, header: string) => ({
    id,
    source_id: SOURCE_A,
    raw_text: [header, "18:53 เสือ 1.หมอนทอง119บาท", "38โล"].join("\n"),
    payload: { timestamp: Date.parse("2026-07-20T06:00:00.000Z") },
    created_at: "2026-07-20T06:00:01.000Z",
    is_processed: false,
  });

  test("a message created days BEFORE the date its header names still blocks that date", async () => {
    const report = await loadSalesReport(
      fakeSupabase(lostFixture([futureDated("raw-future", "18:53 เสือ ตลาดกี้ เบิก 25/07/2569")])),
      DATE,
    );

    expect(lostBlockers(report)).toBe(1);
  });

  test("…and does not block the day it was actually sent", async () => {
    const report = await loadSalesReport(
      fakeSupabase(lostFixture([futureDated("raw-future", "18:53 เสือ ตลาดกี้ เบิก 25/07/2569")])),
      "2026-07-20",
    );

    expect(lostBlockers(report)).toBe(0);
  });

  test("four future-dated messages each attach to their own header date", async () => {
    const messages = [
      futureDated("raw-f1", "18:53 เสือ ตลาดกี้ เบิก 25/07/2569"),
      futureDated("raw-f2", "18:53 เสือ ตลาดกี้ เบิก 26/07/2569"),
      futureDated("raw-f3", "18:53 เสือ ตลาดน้อย เบิก 25/07/2569"),
      futureDated("raw-f4", "18:53 เสือ ตลาดน้อย คืน 27/07/2569"),
    ];

    const on25 = await loadSalesReport(fakeSupabase(lostFixture(messages)), "2026-07-25");
    const on26 = await loadSalesReport(fakeSupabase(lostFixture(messages)), "2026-07-26");
    const on27 = await loadSalesReport(fakeSupabase(lostFixture(messages)), "2026-07-27");

    expect(lostBlockers(on25)).toBe(2);
    expect(lostBlockers(on26)).toBe(1);
    expect(lostBlockers(on27)).toBe(1);
  });
});

describe("P1 pending ingest lookup fails closed", () => {
  const unresolved = {
    id: "pending-1",
    session_key: "group:g1:user:u1",
    session_generation: "gen-1",
    accumulated_text: UNDATED_PRODUCE, // no explicit date → the timestamp decides
    created_at: INSERTED_AFTER_CUTOFF,
    finalization_status: "pending",
  };

  test("a successful lookup uses the LINE timestamp", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          produce: [],
          sessions: [],
          pending: [unresolved],
          pendingIngest: [
            {
              session_key: "group:g1:user:u1",
              session_generation: "gen-1",
              line_timestamp_ms: BEFORE_CUTOFF_MS,
            },
          ],
        }),
      ),
      "2026-07-25",
    );

    expect(report.scopeBlockers).toEqual([{ kind: "unresolved_pending_session", count: 1 }]);
  });

  test("a successful lookup with no ledger row uses the legacy created_at fallback", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({ produce: [], sessions: [], pending: [unresolved], pendingIngest: [] }),
      ),
      "2026-07-26", // created_at 04:00:01 Bangkok on the 26th
    );

    expect(report.scopeBlockers).toEqual([{ kind: "unresolved_pending_session", count: 1 }]);
  });

  test("a FAILED lookup errors instead of inventing a business date", async () => {
    // created_at would say the 26th, the LINE timestamp might say the 25th —
    // a database error must never get to pick.
    expect(
      loadSalesReport(
        fakeSupabase(
          baseFixture({
            produce: [],
            sessions: [],
            pending: [unresolved],
            errors: { pending_session_ingest: "connection reset" },
          }),
        ),
        DATE,
      ),
    ).rejects.toThrow(SalesDataError);
  });
});

// ── QA/test scope exclusion ─────────────────────────────────────────────────

describe("P1 excludes QA market scopes from production reporting", () => {
  const QA_LABELS = [
    "ทดสอบ",
    "ทดสอบเงินโอน",
    "ทดสอบผลต่าง",
    "ทดสอบราคาA",
    "ทดสอบราคาB",
    "ทดสอบไวท์ชีท",
    "QAไวท์ชีท",
  ];

  /** One real market that sells, plus one QA scope that also "sells". */
  function withQaMarket(label: string): Fixture {
    return baseFixture({
      produce: [
        produceRow({ id: "i1", quantity: 10, transaction_type: "เบิก" }),
        produceRow({ id: "i2", quantity: 4, transaction_type: "คืน" }),
        produceRow({ id: "q1", quantity: 100, transaction_type: "เบิก", market_name: label, session_id: "session-qa", raw_message_id: "raw-qa" }),
        produceRow({ id: "q2", quantity: 40, transaction_type: "คืน", market_name: label, session_id: "session-qa", raw_message_id: "raw-qa" }),
        // …and a QA row that would otherwise be a blocker.
        produceRow({ id: "q3", quantity: 7, transaction_type: "เบิก", market_name: label, product_name: "ชะอม", unit: "กำ", session_id: "session-qa", raw_message_id: "raw-qa" }),
      ],
      rawMessages: [
        { id: "raw-1", source_id: SOURCE_A },
        { id: "raw-qa", source_id: SOURCE_A },
      ],
      sessions: [
        { id: "session-1", total_items: 2, parser_errors: null, raw_message_id: "raw-1", voided_at: null },
        { id: "session-qa", total_items: 3, parser_errors: null, raw_message_id: "raw-qa", voided_at: null },
      ],
    });
  }

  for (const label of QA_LABELS) {
    test(`${label} contributes nothing to any rollup or count`, async () => {
      const report = await loadSalesReport(fakeSupabase(withQaMarket(label)), DATE);

      expect(report.markets.map((market) => market.marketLabel)).toEqual(["ตลาดกี้"]);
      // Only the real market's 6 × 120.00 survives — the QA 60 sold never lands.
      expect(report.allMarkets.expectedSalesSatang).toBe(72_000);
      expect(report.allMarkets.trustedRowCount).toBe(1);
      expect(report.allMarkets.quantityBlockedRowCount).toBe(0);
      expect(report.allMarkets.valueBlockedRowCount).toBe(0);
      expect(report.allMarkets.valueAuthoritative).toBe(true);
      expect(report.products).toHaveLength(1);
      expect(report.products[0].soldQuantity).toBe(6);
      expect(report.blocked).toHaveLength(0);
    });
  }

  test("a real market is untouched when no QA scope is present", async () => {
    const report = await loadSalesReport(fakeSupabase(baseFixture()), DATE);

    expect(report.markets).toHaveLength(1);
    expect(report.allMarkets.expectedSalesSatang).toBe(72_000);
    expect(report.allMarkets.valueAuthoritative).toBe(true);
  });

  test("exclusion is exact — a real market that merely resembles one is kept", async () => {
    for (const label of ["ทดสอบราคาC", "ทดสอบไวท์ชีทใหม่", "ตลาดทดสอบผลต่าง", "qaไวท์ชีท", "ตลาดทดสอบใหม่"]) {
      const report = await loadSalesReport(fakeSupabase(withQaMarket(label)), DATE);

      expect(report.markets.map((market) => market.marketLabel).sort()).toEqual(
        ["ตลาดกี้", label].sort(),
      );
    }
  });

  test("a QA session that persisted nothing does not become a blocker either", async () => {
    const report = await loadSalesReport(
      fakeSupabase(
        baseFixture({
          sessions: [
            { id: "session-1", total_items: 2, parser_errors: null, raw_message_id: "raw-1", voided_at: null },
            { id: "session-qa", session_title: "ทดสอบไวท์ชีท", total_items: 4, parser_errors: null, raw_message_id: "raw-1", voided_at: null },
          ],
        }),
      ),
      DATE,
    );

    expect(report.blocked).toHaveLength(0);
    expect(report.scopeBlockers).toEqual([]);
  });

  test("the audit path can still see QA data — nothing is deleted", async () => {
    const report = await loadSalesReport(fakeSupabase(withQaMarket("ทดสอบไวท์ชีท")), DATE, {
      includeQaScopes: true,
    });

    expect(report.markets.map((market) => market.marketLabel).sort()).toEqual(
      ["ตลาดกี้", "ทดสอบไวท์ชีท"].sort(),
    );
    // Audit mode keeps 6 real + 60 QA + the extra 7-unit QA row, all at their entered 120.00 round price.
    expect(report.allMarkets.expectedSalesSatang).toBe(72_000 + 720_000 + 84_000);
    expect(report.blocked).toHaveLength(0);
  });
});
