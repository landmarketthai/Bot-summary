import { describe, expect, test } from "bun:test";
import {
  buildRemainingFruitReport,
  dedupeRemainingSourceRows,
  UNIDENTIFIED_MARKET_SECTION,
  type RemainingFruitSourceRow,
  normalizeProductName,
} from "./remaining-fruit";

const TX_WITHDRAW = "\u0E40\u0E1A\u0E34\u0E01";
const TX_RETURN = "\u0E04\u0E37\u0E19";
const TX_DAMAGED = "\u0E04\u0E37\u0E19\u0E40\u0E2A\u0E35\u0E22";
const UNIT_PIECE = "\u0E25\u0E39\u0E01";
const UNIT_KG = "\u0E42\u0E25";
const WATERMELON = "\u0E41\u0E15\u0E07\u0E42\u0E21";
const MARKET_KEE = "\u0E15\u0E25\u0E32\u0E14\u0E01\u0E35\u0E49";
const MARKET_NOI = "\u0E15\u0E25\u0E32\u0E14\u0E19\u0E49\u0E2D\u0E22";
const MARKET_WAT = "\u0E27\u0E31\u0E14\u0E17\u0E38\u0E48\u0E07\u0E25\u0E32\u0E19\u0E19\u0E32";

function row(
  overrides: Partial<RemainingFruitSourceRow> & Pick<RemainingFruitSourceRow, "product_name">,
): RemainingFruitSourceRow {
  return {
    market_name: MARKET_KEE,
    quantity: 0,
    unit: UNIT_PIECE,
    transaction_type: TX_WITHDRAW,
    ...overrides,
  };
}

describe("buildRemainingFruitReport", () => {
  test("one fruit: remaining equals \u0E0A\u0E31\u0E48\u0E07\u0E04\u0E37\u0E19 only (20), not 75 or 80", () => {
    const source = [
      row({ product_name: WATERMELON, quantity: 100, transaction_type: TX_WITHDRAW }),
      row({ product_name: WATERMELON, quantity: 20, transaction_type: TX_RETURN }),
      row({ product_name: WATERMELON, quantity: 5, transaction_type: TX_DAMAGED }),
    ];
    const { markets } = buildRemainingFruitReport(source);
    const item = markets[0]?.items[0];

    expect(item?.remainingForResaleQuantity).toBe(20);
    expect(item?.returnGoodQuantity).toBe(20);
    expect(item?.remainingForResaleQuantity).toBe(item?.returnGoodQuantity);
    expect(item?.remainingForResaleQuantity).not.toBe(75);
    expect(item?.remainingForResaleQuantity).not.toBe(80);
    expect(item?.withdrawnQuantity).toBe(100);
    expect(item?.damagedQuantity).toBe(5);
  });

  test("multiple entries for same fruit, market, date, and unit sum correctly", () => {
    const source = [
      row({ product_name: WATERMELON, quantity: 60, transaction_type: TX_WITHDRAW }),
      row({ product_name: WATERMELON, quantity: 40, transaction_type: TX_WITHDRAW }),
      row({ product_name: WATERMELON, quantity: 12, transaction_type: TX_RETURN }),
      row({ product_name: WATERMELON, quantity: 8, transaction_type: TX_RETURN }),
      row({ product_name: WATERMELON, quantity: 2, transaction_type: TX_DAMAGED }),
      row({ product_name: WATERMELON, quantity: 3, transaction_type: TX_DAMAGED }),
    ];
    const item = buildRemainingFruitReport(source).markets[0]?.items[0];

    expect(item?.withdrawnQuantity).toBe(100);
    expect(item?.remainingForResaleQuantity).toBe(20);
    expect(item?.damagedQuantity).toBe(5);
  });

  test("same fruit from multiple markets sums in overall summary", () => {
    const source = [
      row({ market_name: MARKET_KEE, product_name: WATERMELON, quantity: 20, transaction_type: TX_RETURN }),
      row({ market_name: MARKET_NOI, product_name: WATERMELON, quantity: 15, transaction_type: TX_RETURN }),
    ];
    const report = buildRemainingFruitReport(source);

    expect(report.markets).toHaveLength(2);
    expect(report.markets.find((m) => m.marketName === MARKET_KEE)?.items[0]?.remainingForResaleQuantity).toBe(20);
    expect(report.markets.find((m) => m.marketName === MARKET_NOI)?.items[0]?.remainingForResaleQuantity).toBe(15);

    const overall = report.overall.find((r) => r.fruitName === WATERMELON && r.unit === UNIT_PIECE);
    expect(overall?.totalRemainingForResale).toBe(35);
    expect(overall?.marketBreakdown).toEqual([
      { marketName: MARKET_KEE, quantity: 20 },
      { marketName: MARKET_NOI, quantity: 15 },
    ]);
  });

  test("overall breakdown lists each market contribution", () => {
    const source = [
      row({ market_name: MARKET_KEE, product_name: WATERMELON, quantity: 20, transaction_type: TX_RETURN }),
      row({ market_name: MARKET_NOI, product_name: WATERMELON, quantity: 15, transaction_type: TX_RETURN }),
    ];
    const overall = buildRemainingFruitReport(source).overall[0];

    expect(overall.totalRemainingForResale).toBe(35);
    expect(overall.marketBreakdown.map((b) => b.marketName)).toEqual([MARKET_KEE, MARKET_NOI]);
  });

  test("same fruit with different units stays on separate rows", () => {
    const source = [
      row({ market_name: MARKET_KEE, product_name: WATERMELON, unit: UNIT_PIECE, quantity: 10, transaction_type: TX_RETURN }),
      row({ market_name: MARKET_KEE, product_name: WATERMELON, unit: UNIT_KG, quantity: 4, transaction_type: TX_RETURN }),
    ];
    const items = buildRemainingFruitReport(source).markets[0]?.items ?? [];

    expect(items).toHaveLength(2);
    expect(items.find((i) => i.unit === UNIT_PIECE)?.remainingForResaleQuantity).toBe(10);
    expect(items.find((i) => i.unit === UNIT_KG)?.remainingForResaleQuantity).toBe(4);
    expect(buildRemainingFruitReport(source).overall).toHaveLength(2);
  });

  test("different units across markets create separate overall rows", () => {
    const source = [
      row({ market_name: MARKET_KEE, product_name: WATERMELON, unit: UNIT_PIECE, quantity: 20, transaction_type: TX_RETURN }),
      row({ market_name: MARKET_NOI, product_name: WATERMELON, unit: UNIT_KG, quantity: 5, transaction_type: TX_RETURN }),
    ];

    const overall = buildRemainingFruitReport(source).overall;
    expect(overall).toHaveLength(2);
    expect(overall.find((r) => r.unit === UNIT_PIECE)?.totalRemainingForResale).toBe(20);
    expect(overall.find((r) => r.unit === UNIT_KG)?.totalRemainingForResale).toBe(5);
  });

  test("missing \u0E0A\u0E31\u0E48\u0E07\u0E04\u0E37\u0E19 is not reported as confirmed zero", () => {
    const item = buildRemainingFruitReport([
      row({ product_name: WATERMELON, quantity: 100, transaction_type: TX_WITHDRAW }),
      row({ product_name: WATERMELON, quantity: 5, transaction_type: TX_DAMAGED }),
    ]).markets[0]?.items[0];

    expect(item?.hasReturnGoodData).toBe(false);
    expect(item?.remainingForResaleQuantity).toBe(0);
    expect(item?.withdrawnQuantity).toBe(100);
  });

  test("market with \u0E40\u0E1A\u0E34\u0E01 but no \u0E0A\u0E31\u0E48\u0E07\u0E04\u0E37\u0E19 does not add zero to overall total", () => {
    const overall = buildRemainingFruitReport([
      row({ market_name: MARKET_KEE, product_name: WATERMELON, quantity: 20, transaction_type: TX_RETURN }),
      row({ market_name: MARKET_NOI, product_name: WATERMELON, quantity: 100, transaction_type: TX_WITHDRAW }),
    ]).overall[0];

    expect(overall.totalRemainingForResale).toBe(20);
    expect(overall.marketBreakdown).toEqual([{ marketName: MARKET_KEE, quantity: 20 }]);
  });

  test("market filter limits sections", () => {
    const report = buildRemainingFruitReport(
      [
        row({ market_name: MARKET_KEE, product_name: WATERMELON, quantity: 20, transaction_type: TX_RETURN }),
        row({ market_name: MARKET_NOI, product_name: WATERMELON, quantity: 15, transaction_type: TX_RETURN }),
      ],
      { marketFilter: "\u0E01\u0E35\u0E49" },
    );

    expect(report.markets).toHaveLength(1);
    expect(report.markets[0].marketName).toBe(MARKET_KEE);
    expect(report.overall[0]?.totalRemainingForResale).toBe(20);
  });

  test("normalizes malformed session title to real market label", () => {
    const report = buildRemainingFruitReport([
      row({
        market_name: "\u0E01\u0E35\u0E49 \u0E15\u0E25\u0E32\u0E14\u0E01\u0E35\u0E49 \u0E0A\u0E31\u0E48\u0E07\u0E04\u0E37\u0E19 23/06/2569",
        product_name: WATERMELON,
        quantity: 20,
        transaction_type: TX_RETURN,
      }),
    ]);

    expect(report.markets).toHaveLength(1);
    expect(report.markets[0].marketName).toBe(MARKET_KEE);
    expect(report.unidentified).toBeNull();
  });

  test("keeps transaction-only session titles in unidentified section", () => {
    const report = buildRemainingFruitReport([
      row({
        market_name: "\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23\u0E0A\u0E31\u0E48\u0E07\u0E40\u0E1A\u0E34\u0E01",
        product_name: WATERMELON,
        quantity: 100,
        transaction_type: TX_WITHDRAW,
      }),
      row({
        market_name: MARKET_KEE,
        product_name: WATERMELON,
        quantity: 20,
        transaction_type: TX_RETURN,
      }),
    ]);

    expect(report.markets).toHaveLength(1);
    expect(report.markets[0].marketName).toBe(MARKET_KEE);
    expect(report.unidentified?.markets).toHaveLength(1);
    expect(report.unidentified?.markets[0].marketName).toBe(UNIDENTIFIED_MARKET_SECTION);
    expect(report.overall[0]?.totalRemainingForResale).toBe(20);
    expect(report.unidentified?.overall ?? []).toHaveLength(0);
  });

  test("omits explicit zero remaining from summary list", () => {
    const report = buildRemainingFruitReport([
      row({ product_name: WATERMELON, quantity: 0, transaction_type: TX_RETURN }),
      row({ product_name: "\u0E40\u0E07\u0E32\u0E30", quantity: 5, transaction_type: TX_RETURN }),
    ]);

    expect(report.markets[0]?.items).toHaveLength(1);
    expect(report.markets[0]?.items[0]?.fruitName).toBe("\u0E40\u0E07\u0E32\u0E30");
    expect(report.overall).toHaveLength(1);
    expect(report.overall[0]?.totalRemainingForResale).toBe(5);
  });

  test("2026-06-23 production shape separates identified and unidentified markets", async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return;

    const { createClient } = await import("@supabase/supabase-js");
    const { fetchRemainingFruitRows } = await import("./remaining-fruit-data");
    const rows = await fetchRemainingFruitRows(createClient(url, key), "2026-06-23");
    const report = buildRemainingFruitReport(rows);

    expect(report.markets.map((m) => m.marketName)).toEqual(["\u0E15\u0E25\u0E32\u0E14\u0E01\u0E35\u0E49"]);
    expect(report.unidentified?.markets).toHaveLength(1);
    expect(report.unidentified?.markets[0].marketName).toBe(UNIDENTIFIED_MARKET_SECTION);
    expect(report.overall.every((row) =>
      row.marketBreakdown.every((entry) => entry.marketName === "\u0E15\u0E25\u0E32\u0E14\u0E01\u0E35\u0E49"),
    )).toBe(true);
    expect(report.overall.every((row) => row.totalRemainingForResale > 0)).toBe(true);
  });

  test("2026-07-01 production shape suppresses the real duplicate session's return rows, keeps everything else", async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return;

    const { createClient } = await import("@supabase/supabase-js");
    const { fetchRemainingFruitRows } = await import("./remaining-fruit-data");
    const rows = await fetchRemainingFruitRows(createClient(url, key), "2026-07-01");

    // 3bfda846 (unidentified, session_time 14:19:00) is a proven duplicate of 25f702ad
    // (\u0E27\u0E31\u0E14\u0E17\u0E38\u0E48\u0E07\u0E25\u0E32\u0E19\u0E19\u0E32, session_time 14:14:09): same LINE source, 16 of its
    // 16 \u0E04\u0E37\u0E19 rows are an exact subset of the identified session's 19 \u0E04\u0E37\u0E19 rows (16/19 \u2248 0.84 >= 0.8 coverage).
    const deduped = dedupeRemainingSourceRows(rows);
    expect(rows.length - deduped.length).toBe(16);

    const report = buildRemainingFruitReport(rows);

    // exact remaining totals for MARKET_WAT, confirmed unaffected by dedup (single contributing session per fruit)
    const watTotals: Record<string, number> = {
      "\u0E41\u0E01\u0E49\u0E27\u0E21\u0E31\u0E07\u0E01\u0E23": 11.3,
      "\u0E40\u0E07\u0E32\u0E30": 12.1,
      "\u0E0A\u0E30\u0E19\u0E35": 4.4,
      "\u0E21\u0E31\u0E07\u0E04\u0E38\u0E14": 9.9,
      "\u0E25\u0E2D\u0E07\u0E01\u0E2D\u0E07": 18.3,
      "\u0E2B\u0E21\u0E2D\u0E19\u0E17\u0E2D\u0E07": 13.5,
      "\u0E41\u0E2D\u0E1B\u0E40\u0E1B\u0E34\u0E49\u0E25": 12,
    };

    const wat = report.markets.find((m) => m.marketName === MARKET_WAT);
    const unidItems = report.unidentified?.markets[0]?.items ?? [];

    for (const [fruit, total] of Object.entries(watTotals)) {
      expect(wat?.items.find((i) => i.fruitName === fruit)?.remainingForResaleQuantity).toBe(total);
      expect(unidItems.some((i) => i.fruitName === fruit)).toBe(false);
    }
    expect(report.unidentified?.overall ?? []).toHaveLength(0);

    // 3bfda846 also has unrelated \u0E40\u0E1A\u0E34\u0E01 (withdrawal) rows that are never touched by dedup \u2014 they must
    // still surface under the unidentified section, just with no remaining-for-resale quantity.
    const longkong = unidItems.find((i) => i.fruitName === "\u0E25\u0E2D\u0E07\u0E01\u0E2D\u0E07");
    expect(longkong?.withdrawnQuantity).toBe(7.9);
    expect(longkong?.hasReturnGoodData).toBe(false);
  });
});

describe("dedupeRemainingSourceRows (session-aware duplicate suppression)", () => {
  const SOURCE_A = "Csource-a";
  const SOURCE_B = "Csource-b";
  const SENDER_A = "\u0E41\u0E21\u0E48\u0E04\u0E49\u0E32\u0E40\u0E2D";
  const SENDER_B = "\u0E41\u0E21\u0E48\u0E04\u0E49\u0E32\u0E1A\u0E35";
  const BASE_TIME = "2026-07-01T14:00:00.000Z";

  function isoPlusMinutes(minutes: number): string {
    return new Date(new Date(BASE_TIME).getTime() + minutes * 60_000).toISOString();
  }

  function identifiedRow(
    overrides: Partial<RemainingFruitSourceRow> & Pick<RemainingFruitSourceRow, "product_name" | "quantity">,
  ): RemainingFruitSourceRow {
    return row({
      session_id: "session-identified",
      source_id: SOURCE_A,
      session_time: BASE_TIME,
      market_name: MARKET_WAT,
      transaction_type: TX_RETURN,
      unit: UNIT_KG,
      ...overrides,
    });
  }

  function unidentifiedRow(
    overrides: Partial<RemainingFruitSourceRow> & Pick<RemainingFruitSourceRow, "product_name" | "quantity">,
  ): RemainingFruitSourceRow {
    return row({
      session_id: "session-unidentified",
      source_id: SOURCE_A,
      session_time: isoPlusMinutes(4),
      market_name: "",
      transaction_type: TX_RETURN,
      unit: UNIT_KG,
      ...overrides,
    });
  }

  test("suppresses an exact-match unidentified twin session (same source, sender unknown on both sides, within window)", () => {
    const duplicatePairs = [
      ["\u0E41\u0E01\u0E49\u0E27\u0E21\u0E31\u0E07\u0E01\u0E23", 11.3],
      ["\u0E40\u0E07\u0E32\u0E30", 12.1],
      ["\u0E0A\u0E30\u0E19\u0E35", 4.4],
      ["\u0E21\u0E31\u0E07\u0E04\u0E38\u0E14", 9.9],
      ["\u0E25\u0E2D\u0E07\u0E01\u0E2D\u0E07", 18.3],
      ["\u0E2B\u0E21\u0E2D\u0E19\u0E17\u0E2D\u0E07", 13.5],
      ["\u0E41\u0E2D\u0E1B\u0E40\u0E1B\u0E34\u0E49\u0E25", 12],
    ] as const;

    const source: RemainingFruitSourceRow[] = duplicatePairs.flatMap(([product, quantity]) => [
      identifiedRow({ product_name: product, quantity, unit: product === "\u0E41\u0E2D\u0E1B\u0E40\u0E1B\u0E34\u0E49\u0E25" ? UNIT_PIECE : UNIT_KG }),
      unidentifiedRow({ product_name: product, quantity, unit: product === "\u0E41\u0E2D\u0E1B\u0E40\u0E1B\u0E34\u0E49\u0E25" ? UNIT_PIECE : UNIT_KG }),
    ]);

    expect(dedupeRemainingSourceRows(source)).toHaveLength(duplicatePairs.length);

    const report = buildRemainingFruitReport(source);
    const wat = report.markets.find((m) => m.marketName === MARKET_WAT);
    const unid = report.unidentified?.markets[0];

    for (const [product] of duplicatePairs) {
      expect(wat?.items.find((i) => i.fruitName === product)?.remainingForResaleQuantity).toBeDefined();
      expect(unid?.items.find((i) => i.fruitName === product)).toBeUndefined();
    }
    expect(report.unidentified?.overall ?? []).toHaveLength(0);
  });

  test("suppresses a proper subset twin session at exactly the 80% coverage boundary", () => {
    // identified: 5 distinct products; unidentified: same 4 of them (missing the 5th) => 4/5 = 0.80
    const source: RemainingFruitSourceRow[] = [
      identifiedRow({ product_name: "A1", quantity: 1 }),
      identifiedRow({ product_name: "A2", quantity: 2 }),
      identifiedRow({ product_name: "A3", quantity: 3 }),
      identifiedRow({ product_name: "A4", quantity: 4 }),
      identifiedRow({ product_name: "A5", quantity: 5 }),
      unidentifiedRow({ product_name: "A1", quantity: 1 }),
      unidentifiedRow({ product_name: "A2", quantity: 2 }),
      unidentifiedRow({ product_name: "A3", quantity: 3 }),
      unidentifiedRow({ product_name: "A4", quantity: 4 }),
    ];

    const deduped = dedupeRemainingSourceRows(source);
    expect(deduped).toHaveLength(5);
    expect(deduped.every((r) => r.market_name === MARKET_WAT)).toBe(true);
  });

  test("does not dedupe across a different LINE source/group", () => {
    const source: RemainingFruitSourceRow[] = [
      identifiedRow({ product_name: WATERMELON, quantity: 10, unit: UNIT_PIECE }),
      identifiedRow({ product_name: "\u0E40\u0E07\u0E32\u0E30", quantity: 5 }),
      unidentifiedRow({ product_name: WATERMELON, quantity: 10, unit: UNIT_PIECE, source_id: SOURCE_B }),
      unidentifiedRow({ product_name: "\u0E40\u0E07\u0E32\u0E30", quantity: 5, source_id: SOURCE_B }),
    ];

    expect(dedupeRemainingSourceRows(source)).toHaveLength(source.length);
  });

  test("does not dedupe when both sides have a known, differing sender/seller", () => {
    const source: RemainingFruitSourceRow[] = [
      identifiedRow({ product_name: WATERMELON, quantity: 10, unit: UNIT_PIECE, sender_name: SENDER_A }),
      identifiedRow({ product_name: "\u0E40\u0E07\u0E32\u0E30", quantity: 5, sender_name: SENDER_A }),
      unidentifiedRow({ product_name: WATERMELON, quantity: 10, unit: UNIT_PIECE, sender_name: SENDER_B }),
      unidentifiedRow({ product_name: "\u0E40\u0E07\u0E32\u0E30", quantity: 5, sender_name: SENDER_B }),
    ];

    expect(dedupeRemainingSourceRows(source)).toHaveLength(source.length);
  });

  test("does not dedupe when sessions are more than 10 minutes apart", () => {
    const source: RemainingFruitSourceRow[] = [
      identifiedRow({ product_name: WATERMELON, quantity: 10, unit: UNIT_PIECE }),
      identifiedRow({ product_name: "\u0E40\u0E07\u0E32\u0E30", quantity: 5 }),
      unidentifiedRow({ product_name: WATERMELON, quantity: 10, unit: UNIT_PIECE, session_time: isoPlusMinutes(11) }),
      unidentifiedRow({ product_name: "\u0E40\u0E07\u0E32\u0E30", quantity: 5, session_time: isoPlusMinutes(11) }),
    ];

    expect(dedupeRemainingSourceRows(source)).toHaveLength(source.length);
  });

  test("never touches rows shared between two identified markets", () => {
    const source: RemainingFruitSourceRow[] = [
      identifiedRow({ product_name: WATERMELON, quantity: 10, unit: UNIT_PIECE, session_id: "session-a", market_name: MARKET_KEE }),
      identifiedRow({ product_name: WATERMELON, quantity: 10, unit: UNIT_PIECE, session_id: "session-b", market_name: MARKET_NOI, session_time: isoPlusMinutes(1) }),
    ];

    expect(dedupeRemainingSourceRows(source)).toHaveLength(2);
  });

  test("preserves duplicate-line multiplicity: two matching copies suppressed, only one is not enough", () => {
    const source: RemainingFruitSourceRow[] = [
      identifiedRow({ product_name: "A1", quantity: 5 }),
      identifiedRow({ product_name: "A1", quantity: 5 }),
      identifiedRow({ product_name: "A2", quantity: 2 }),
      unidentifiedRow({ product_name: "A1", quantity: 5 }),
      unidentifiedRow({ product_name: "A1", quantity: 5 }),
      unidentifiedRow({ product_name: "A2", quantity: 2 }),
    ];

    expect(dedupeRemainingSourceRows(source)).toHaveLength(3);
  });

  test("refuses to dedupe when the unidentified session has more copies of an item than the identified one", () => {
    const source: RemainingFruitSourceRow[] = [
      identifiedRow({ product_name: "A1", quantity: 5 }),
      identifiedRow({ product_name: "A2", quantity: 2 }),
      unidentifiedRow({ product_name: "A1", quantity: 5 }),
      unidentifiedRow({ product_name: "A1", quantity: 5 }),
      unidentifiedRow({ product_name: "A2", quantity: 2 }),
    ];

    expect(dedupeRemainingSourceRows(source)).toHaveLength(source.length);
  });

  test("does not dedupe below the 80% subset coverage threshold", () => {
    // identified: 6 distinct products; unidentified matches only 4 => 4/6 \u2248 0.667 < 0.8
    const source: RemainingFruitSourceRow[] = [
      identifiedRow({ product_name: "A1", quantity: 1 }),
      identifiedRow({ product_name: "A2", quantity: 2 }),
      identifiedRow({ product_name: "A3", quantity: 3 }),
      identifiedRow({ product_name: "A4", quantity: 4 }),
      identifiedRow({ product_name: "A5", quantity: 5 }),
      identifiedRow({ product_name: "A6", quantity: 6 }),
      unidentifiedRow({ product_name: "A1", quantity: 1 }),
      unidentifiedRow({ product_name: "A2", quantity: 2 }),
      unidentifiedRow({ product_name: "A3", quantity: 3 }),
      unidentifiedRow({ product_name: "A4", quantity: 4 }),
    ];

    expect(dedupeRemainingSourceRows(source)).toHaveLength(source.length);
  });

  test("a single coincidentally matching item is never enough to suppress", () => {
    const source: RemainingFruitSourceRow[] = [
      identifiedRow({ product_name: WATERMELON, quantity: 10, unit: UNIT_PIECE }),
      unidentifiedRow({ product_name: WATERMELON, quantity: 10, unit: UNIT_PIECE }),
    ];

    expect(dedupeRemainingSourceRows(source)).toHaveLength(source.length);
  });

  test("does not dedupe when multiple identified sessions could equally explain the unidentified one (ambiguous)", () => {
    const source: RemainingFruitSourceRow[] = [
      identifiedRow({ product_name: "A1", quantity: 1, session_id: "session-i1", market_name: MARKET_KEE }),
      identifiedRow({ product_name: "A2", quantity: 2, session_id: "session-i1", market_name: MARKET_KEE }),
      identifiedRow({ product_name: "A1", quantity: 1, session_id: "session-i2", market_name: MARKET_NOI }),
      identifiedRow({ product_name: "A2", quantity: 2, session_id: "session-i2", market_name: MARKET_NOI }),
      unidentifiedRow({ product_name: "A1", quantity: 1 }),
      unidentifiedRow({ product_name: "A2", quantity: 2 }),
    ];

    expect(dedupeRemainingSourceRows(source)).toHaveLength(source.length);
  });

  test("does not use a session with conflicting resolved markets as an identified candidate", () => {
    const source: RemainingFruitSourceRow[] = [
      identifiedRow({ product_name: "A1", quantity: 1, session_id: "session-conflicted", market_name: MARKET_KEE }),
      identifiedRow({ product_name: "A2", quantity: 2, session_id: "session-conflicted", market_name: MARKET_NOI }),
      unidentifiedRow({ product_name: "A1", quantity: 1 }),
      unidentifiedRow({ product_name: "A2", quantity: 2 }),
    ];

    expect(dedupeRemainingSourceRows(source)).toHaveLength(source.length);
  });

  test("leaves rows with no session_id untouched (never guesses)", () => {
    const source: RemainingFruitSourceRow[] = [
      row({ market_name: MARKET_WAT, product_name: WATERMELON, quantity: 10, unit: UNIT_PIECE, transaction_type: TX_RETURN }),
      row({ market_name: "", product_name: WATERMELON, quantity: 10, unit: UNIT_PIECE, transaction_type: TX_RETURN }),
    ];

    expect(dedupeRemainingSourceRows(source)).toHaveLength(2);
  });
});

describe("exact confirmed product aliases", () => {
  test("หมอนทอน aggregates under หมอนทอง when units match", () => {
    const report = buildRemainingFruitReport([
      row({ product_name: "หมอนทอง", quantity: 218.9, unit: UNIT_KG, transaction_type: TX_RETURN }),
      row({ product_name: "หมอนทอน", quantity: 33.1, unit: UNIT_KG, transaction_type: TX_RETURN }),
    ]);

    const overall = report.overall.find((o) => o.fruitName === "หมอนทอง");
    expect(overall?.totalRemainingForResale).toBe(252);
    expect(report.overall.find((o) => o.fruitName === "หมอนทอน")).toBeUndefined();
  });

  test("ทุเนียนกวน aggregates under ทุเรียนกวน when units match", () => {
    const report = buildRemainingFruitReport([
      row({ product_name: "ทุเรียนกวน", quantity: 5, unit: "ปุก", transaction_type: TX_RETURN }),
      row({ product_name: "ทุเนียนกวน", quantity: 12, unit: "ปุก", transaction_type: TX_RETURN }),
    ]);

    const overall = report.overall.find((o) => o.fruitName === "ทุเรียนกวน");
    expect(overall?.totalRemainingForResale).toBe(17);
    expect(report.overall.find((o) => o.fruitName === "ทุเนียนกวน")).toBeUndefined();
  });

  test("หมอนทอง and หมอนทอน never merge across different units", () => {
    const report = buildRemainingFruitReport([
      row({ product_name: "หมอนทอง", quantity: 100, unit: UNIT_KG, transaction_type: TX_RETURN }),
      row({ product_name: "หมอนทอน", quantity: 10, unit: UNIT_PIECE, transaction_type: TX_RETURN }),
    ]);

    const kg = report.overall.find((o) => o.fruitName === "หมอนทอง" && o.unit === UNIT_KG);
    const piece = report.overall.find((o) => o.fruitName === "หมอนทอง" && o.unit === UNIT_PIECE);
    expect(kg?.totalRemainingForResale).toBe(100);
    expect(piece?.totalRemainingForResale).toBe(10);
  });

  test("an unapproved similar typo stays a separate product", () => {
    const report = buildRemainingFruitReport([
      row({ product_name: "หมอนทอง", quantity: 50, unit: UNIT_KG, transaction_type: TX_RETURN }),
      row({ product_name: "หมอนทิง", quantity: 7, unit: UNIT_KG, transaction_type: TX_RETURN }),
    ]);

    expect(report.overall.find((o) => o.fruitName === "หมอนทอง")?.totalRemainingForResale).toBe(50);
    expect(report.overall.find((o) => o.fruitName === "หมอนทิง")?.totalRemainingForResale).toBe(7);
  });
});

describe("QA/test-market exclusion (P0)", () => {
  test("the exact QA market ทดสอบ contributes nothing to the report", () => {
    const report = buildRemainingFruitReport([
      row({ market_name: "ทดสอบ", product_name: "แตงโม", quantity: 999, unit: UNIT_KG, transaction_type: TX_RETURN }),
      row({ market_name: MARKET_KEE, product_name: "แตงโม", quantity: 5, unit: UNIT_KG, transaction_type: TX_RETURN }),
    ]);

    expect(report.markets.find((m) => m.marketName === "ทดสอบ")).toBeUndefined();
    expect(report.overall.find((o) => o.fruitName === "แตงโม")?.totalRemainingForResale).toBe(5);
  });

  test("a legitimate market whose name contains ทดสอบ is not excluded", () => {
    const report = buildRemainingFruitReport([
      row({
        market_name: "ตลาดทดสอบทองผาภูมิ",
        product_name: "แตงโม",
        quantity: 12,
        unit: UNIT_KG,
        transaction_type: TX_RETURN,
      }),
    ]);

    expect(report.markets.find((m) => m.marketName === "ตลาดทดสอบทองผาภูมิ")).toBeDefined();
    expect(report.overall.find((o) => o.fruitName === "แตงโม")?.totalRemainingForResale).toBe(12);
  });

  test("includeQaScopes: true keeps ทดสอบ — debug/dashboard escape hatch", () => {
    const report = buildRemainingFruitReport(
      [
        row({ market_name: "ทดสอบ", product_name: "แตงโม", quantity: 999, unit: UNIT_KG, transaction_type: TX_RETURN }),
        row({ market_name: MARKET_KEE, product_name: "แตงโม", quantity: 5, unit: UNIT_KG, transaction_type: TX_RETURN }),
      ],
      { includeQaScopes: true },
    );

    expect(report.markets.find((m) => m.marketName === "ทดสอบ")).toBeDefined();
    expect(report.overall.find((o) => o.fruitName === "แตงโม")?.totalRemainingForResale).toBe(1004);
  });
});

describe("PRODUCT_ALIASES — อะโวคาโด spellings", () => {
  // Required by the alias map's own rule: every entry gets a regression test.
  // Added 2026-08-15 from the Production duplicate incident — แทน — ราชพฤก sent
  // one 16-item withdrawal from two LINE groups whose ONLY difference was the
  // tone mark on this product, and both persisted.
  test("the tone-marked spelling is the same product", () => {
    expect(normalizeProductName("อะโวคาโด้")).toBe("อะโวคาโด");
  });

  test("the previously deployed spellings still canonicalize", () => {
    for (const spelling of ["อะโวคาโด", "อโวคาโด", "อโวคาโด้", "อะโวอาโด้"]) {
      expect(normalizeProductName(spelling)).toBe("อะโวคาโด");
    }
  });

  test("a genuinely different fruit is not swept in", () => {
    expect(normalizeProductName("อะโวคาโดเวียดนาม")).not.toBe("อะโวคาโด");
  });
});

describe("PRODUCT_ALIASES — ม54 dictionary spelling correction (20260818100000)", () => {
  // Required by the alias map's own rule: every entry gets a regression test.
  // ม54 was seeded with the misspelling ไชมัส; the dictionary row itself was
  // corrected to ไซมัส in migration 20260818100000. This alias folds the
  // pre-correction spelling into the corrected canonical identity for every
  // downstream comparison that keys on normalizeProductName — same shape as
  // the อะโวคาโด block above.
  test("the legacy misspelling is the same product as the corrected spelling", () => {
    expect(normalizeProductName("ไชมัส")).toBe("ไซมัส");
  });

  test("the corrected spelling is left unchanged (it is already canonical)", () => {
    expect(normalizeProductName("ไซมัส")).toBe("ไซมัส");
  });

  test("a genuinely different near-miss spelling is not swept in", () => {
    for (const name of ["ไชมัสเก่า", "ไซมัสส", "องุ่นไซมัส"]) {
      expect(normalizeProductName(name)).not.toBe("ไซมัส");
    }
  });
});

describe("PRODUCT_ALIASES — สาลี spelling", () => {
  test("the unmarked spelling is the same product as canonical สาลี่", () => {
    expect(normalizeProductName("สาลี")).toBe("สาลี่");
  });

  test("canonical and distinct pear names are not changed", () => {
    expect(normalizeProductName("สาลี่")).toBe("สาลี่");
    expect(normalizeProductName("สาลี่หอม")).toBe("สาลี่หอม");
    expect(normalizeProductName("สาลี่น้ำผึ้ง")).toBe("สาลี่น้ำผึ้ง");
  });
});

describe("PRODUCT_ALIASES — เขียวมรกต shop-floor short form (ม31)", () => {
  // Required by the alias map's own rule: every entry gets a regression test.
  // เขียวมรกต is the shop-floor short form of the existing ม31 canonical name
  // มะม่วงเขียวมรกต — 733 uses of the short form against 31 of the full name in
  // Production, same shape as the อะโวคาโด and ไซมัส blocks above.
  test("the short form is the same product as the full canonical name", () => {
    expect(normalizeProductName("เขียวมรกต")).toBe("มะม่วงเขียวมรกต");
  });

  test("the full canonical name is left unchanged (it is already canonical)", () => {
    expect(normalizeProductName("มะม่วงเขียวมรกต")).toBe("มะม่วงเขียวมรกต");
  });

  test("real, distinct Production near-miss names are not swept in", () => {
    // เขียวมรกตเก่า (7 uses), เขียวมรกตใหม่ (1 use) and มรกต (5 uses) are real
    // operational names on the floor, not typos of เขียวมรกต.
    for (const name of ["เขียวมรกตเก่า", "เขียวมรกตใหม่", "มรกต", "มะม่วงมรกต"]) {
      expect(normalizeProductName(name)).not.toBe("มะม่วงเขียวมรกต");
    }
  });
});

describe("PRODUCT_ALIASES — องุ่นคินสัน typo of องุ่นคิมสัน (ม68)", () => {
  // Required by the alias map's own rule: every entry gets a regression test.
  // Production audit 2026-09-08: a one-character typo (น for ม) of the existing
  // ม68 canonical name องุ่นคิมสัน, folded so both keyings share one identity.
  test("the typo is the same product as the canonical องุ่นคิมสัน", () => {
    expect(normalizeProductName("องุ่นคินสัน")).toBe("องุ่นคิมสัน");
  });

  test("the canonical name is left unchanged (it is already canonical)", () => {
    expect(normalizeProductName("องุ่นคิมสัน")).toBe("องุ่นคิมสัน");
  });

  test("distinct grape names are not swept in", () => {
    for (const name of ["องุ่นดำ", "องุ่นแดง", "องุ่นไร้ออส", "องุ่นเคียวโฮ"]) {
      expect(normalizeProductName(name)).not.toBe("องุ่นคิมสัน");
    }
  });
});
