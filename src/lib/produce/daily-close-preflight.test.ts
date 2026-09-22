import { describe, expect, test } from "bun:test";
import { SYSTEM_WITHDRAWAL_SEED_ACTOR } from "@/lib/white-sheet/pricing";
import { buildCentralPriceReview } from "./central-price-candidates";
import { classifyProduceFailures, type ProduceFailureAttempt } from "./failure-lifecycle";
import type { RoundReturnStatus } from "./round-return-status";
import {
  buildDailyClosePreflight,
  groupUnboundProduce,
  loadDailyClosePreflight,
  roundPriceKeysFromRows,
  type DailyClosePreflightInput,
  type PreflightRoundRecord,
} from "./daily-close-preflight";

const DATE = "2026-08-13";

test("preloaded round statuses and produce rows skip duplicate paged reads", async () => {
  const queried: string[] = [];
  const supabase = {
    from(table: string) {
      queried.push(table);
      if (table === "produce_transactions" || table === "pending_sessions") {
        throw new Error(`duplicate read: ${table}`);
      }
      const result = { data: [], error: null };
      const node: Record<string, unknown> = {};
      const self = () => node;
      node.select = self;
      node.eq = self;
      node.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
      return node;
    },
  };

  const result = await loadDailyClosePreflight(supabase as never, DATE, {
    failureAttempts: [],
    withdrawalRows: [],
    outcomes: [],
    cancelledRoundIds: new Set(),
    roundStatuses: [],
    produceRows: [],
  });

  expect(result.status).toBe("ready");
  expect(queried).toEqual(["accountability_rounds"]);
});

function round(overrides: Partial<RoundReturnStatus> = {}): RoundReturnStatus {
  return {
    accountabilityRoundId: "round-1",
    sellerLabel: "วุฒิ",
    marketLabel: "เลียบด่วน",
    withdrawalItemCount: 4,
    hasPersistedReturn: true,
    state: "persisted",
    ...overrides,
  };
}

function attempt(overrides: Partial<ProduceFailureAttempt> = {}): ProduceFailureAttempt {
  return {
    attemptId: "attempt-1",
    origin: "pending_session",
    businessDate: DATE,
    sourceId: "group:C1",
    staffLabel: "จิ๋ว",
    marketLabel: "ราชพฤกษ์",
    transactionKind: "คืน",
    accountabilityRoundId: "round-2",
    attemptedAtMs: 1_000,
    ...overrides,
  };
}

function openRound(overrides: Partial<PreflightRoundRecord> = {}): PreflightRoundRecord {
  return {
    accountabilityRoundId: "round-8",
    sourceId: "group:C1",
    ownerLineUserId: "U1",
    staffName: "จิ๋ว",
    marketName: "เลียบด่วน",
    status: "open",
    transactionCount: 5,
    ...overrides,
  };
}

function input(overrides: Partial<DailyClosePreflightInput> = {}): DailyClosePreflightInput {
  return {
    businessDate: DATE,
    roundStatuses: [round()],
    failureAttempts: [],
    failureClassifications: [],
    priceReview: [],
    openRounds: [],
    unboundProduce: [],
    ...overrides,
  };
}

/** Builds the classification the loader would produce, so the rules stay honest. */
function withFailures(
  attempts: ProduceFailureAttempt[],
  overrides: Partial<DailyClosePreflightInput> = {},
): DailyClosePreflightInput {
  return input({
    ...overrides,
    failureAttempts: attempts,
    failureClassifications: classifyProduceFailures(attempts, []),
  });
}

describe("daily close preflight", () => {
  test("1. a clean day is READY", () => {
    const result = buildDailyClosePreflight(input());
    expect(result.status).toBe("ready");
    expect(result.summary).toMatchObject({
      readyRounds: 1,
      blockedRounds: 0,
      activeFailedSessions: 0,
      unresolvedPriceProducts: 0,
      integrityIssues: 0,
    });
  });

  test("2. a refused ชั่งคืน with no replacement BLOCKS the day", () => {
    const attempts = [attempt()];
    const result = buildDailyClosePreflight(
      withFailures(attempts, {
        roundStatuses: [
          round(),
          round({
            accountabilityRoundId: "round-2",
            sellerLabel: "จิ๋ว",
            marketLabel: "ราชพฤกษ์",
            hasPersistedReturn: false,
            state: "blocked",
          }),
        ],
      }),
    );

    expect(result.status).toBe("blocked");
    expect(result.summary.blockedRounds).toBe(1);
    expect(result.summary.activeFailedSessions).toBe(1);

    const blocked = result.rounds.find((row) => row.accountabilityRoundId === "round-2");
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.blockers.map((row) => row.code)).toEqual([
      "missing_successful_return",
      "active_failed_produce_session",
    ]);
    // Every count is explainable: the blocker names the record behind it.
    expect(blocked?.blockers[1].evidenceIds).toEqual(["attempt-1"]);
  });

  test("3. a superseded failure stops blocking and is recorded for audit", () => {
    const attempts = [attempt()];
    const classifications = classifyProduceFailures(attempts, [
      {
        produceSessionId: "session-ok",
        businessDate: DATE,
        sourceId: "group:C1",
        staffLabel: "จิ๋ว",
        marketLabel: "ราชพฤกษ์",
        transactionKind: "คืน",
        accountabilityRoundId: "round-2",
        sessionKind: "main",
        finalizedAtMs: 5_000,
      },
    ]);

    const result = buildDailyClosePreflight(
      input({
        failureAttempts: attempts,
        failureClassifications: classifications,
        roundStatuses: [
          round({
            accountabilityRoundId: "round-2",
            sellerLabel: "จิ๋ว",
            marketLabel: "ราชพฤกษ์",
          }),
        ],
      }),
    );

    expect(result.status).toBe("ready_with_warnings");
    expect(result.summary.activeFailedSessions).toBe(0);
    expect(result.summary.supersededFailures).toBe(1);
    expect(result.supersededFailures[0]).toMatchObject({
      attemptId: "attempt-1",
      state: "superseded",
      supersededByProduceSessionId: "session-ok",
    });
    expect(result.rounds[0].blockers).toHaveLength(0);
  });

  test("7. two candidate successors stay blocked and are flagged ambiguous", () => {
    const attempts = [attempt()];
    const successor = {
      businessDate: DATE,
      sourceId: "group:C1",
      staffLabel: "จิ๋ว",
      marketLabel: "ราชพฤกษ์",
      transactionKind: "คืน" as const,
      accountabilityRoundId: "round-2",
      sessionKind: "main",
      finalizedAtMs: 5_000,
    };
    const classifications = classifyProduceFailures(attempts, [
      { ...successor, produceSessionId: "s1" },
      { ...successor, produceSessionId: "s2", finalizedAtMs: 6_000 },
    ]);

    const result = buildDailyClosePreflight(
      input({
        failureAttempts: attempts,
        failureClassifications: classifications,
        roundStatuses: [
          round({ accountabilityRoundId: "round-2", sellerLabel: "จิ๋ว", marketLabel: "ราชพฤกษ์" }),
        ],
      }),
    );

    expect(result.status).toBe("blocked");
    expect(result.rounds[0].blockers.map((row) => row.code)).toContain("round_identity_ambiguity");
  });

  test("8. same-round price variation warns without blocking the date", () => {
    const priceReview = buildCentralPriceReview(
      [
        {
          accountabilityRoundId: "round-1",
          productName: "อะโวคาโด",
          unit: "โล",
          marketName: "ตลาด72",
          pricePerUnit: 50,
          basisQuantity: null,
          baseTransactionType: "เบิก",
        },
        {
          accountabilityRoundId: "round-1",
          productName: "อะโวคาโด",
          unit: "โล",
          marketName: "ตลาด72",
          pricePerUnit: 70,
          basisQuantity: null,
          baseTransactionType: "เบิก",
        },
      ],
      DATE,
      new Map([["อะโวคาโด โล", { priceSatang: 5_000, setBy: SYSTEM_WITHDRAWAL_SEED_ACTOR }]]),
    );

    const result = buildDailyClosePreflight(input({ priceReview }));

    expect(result.status).toBe("ready_with_warnings");
    expect(result.summary.unresolvedPriceProducts).toBe(1);
    expect(result.pricingConflicts[0].candidates.map((row) => row.priceSatang)).toEqual([
      5_000, 7_000,
    ]);
    expect(result.rounds[0].status).toBe("ready");
    expect(result.rounds[0].warnings.map((row) => row.code)).toContain("unresolved_central_price");
  });

  test("8b. the advisory stays attached to its own round", () => {
    const priceReview = buildCentralPriceReview(
      [
        {
          accountabilityRoundId: "r-72",
          productName: "อะโวคาโด",
          unit: "โล",
          marketName: "ตลาด72",
          pricePerUnit: 50,
          basisQuantity: null,
          baseTransactionType: "เบิก",
        },
        {
          accountabilityRoundId: "r-72",
          productName: "อะโวคาโด",
          unit: "โล",
          marketName: "ตลาด72",
          pricePerUnit: 70,
          basisQuantity: null,
          baseTransactionType: "เบิก",
        },
      ],
      DATE,
      new Map([["อะโวคาโด โล", { priceSatang: 5_000, setBy: SYSTEM_WITHDRAWAL_SEED_ACTOR }]]),
    );

    const result = buildDailyClosePreflight(
      input({
        priceReview,
        roundStatuses: [
          round({ accountabilityRoundId: "r-72", marketLabel: "ตลาด72", sellerLabel: "นาง" }),
          round({ accountabilityRoundId: "r-lb", marketLabel: "เลียบด่วน", sellerLabel: "วุฒิ" }),
        ],
        roundPriceKeys: roundPriceKeysFromRows(
          [
            {
              session_id: "s1",
              market_name: "ตลาด72",
              accountability_round_id: "r-72",
              product_name: "อะโวคาโด",
              unit: "โล",
            },
            {
              session_id: "s2",
              market_name: "เลียบด่วน",
              accountability_round_id: "r-lb",
              product_name: "หมอนทอง",
              unit: "โล",
            },
          ],
          DATE,
        ),
      }),
    );

    expect(result.rounds.find((row) => row.marketName === "ตลาด72")?.status).toBe("ready");
    expect(result.rounds.find((row) => row.marketName === "เลียบด่วน")?.status).toBe("ready");
    expect(result.summary).toMatchObject({ readyRounds: 2, partialRounds: 0, blockedRounds: 0 });
    expect(result.status).toBe("ready_with_warnings");
  });

  test("9. cross-round 50 vs 70 is valid and produces no conflict", () => {
    const priceReview = buildCentralPriceReview(
      [
        {
          accountabilityRoundId: "round-1",
          productName: "อะโวคาโด",
          unit: "โล",
          marketName: "ตลาด72",
          pricePerUnit: 50,
          basisQuantity: null,
          baseTransactionType: "เบิก",
        },
        {
          accountabilityRoundId: "round-2",
          productName: "อะโวคาโด",
          unit: "โล",
          marketName: "เลียบด่วน",
          pricePerUnit: 70,
          basisQuantity: null,
          baseTransactionType: "เบิก",
        },
      ],
      DATE,
      new Map(),
    );

    const result = buildDailyClosePreflight(input({ priceReview }));
    expect(result.status).toBe("ready");
    expect(result.summary.unresolvedPriceProducts).toBe(0);
  });

  test("12. a duplicate round with one provable canonical round is a warning, not a merge", () => {
    const openRounds: PreflightRoundRecord[] = [
      {
        accountabilityRoundId: "canonical",
        sourceId: "group:C1",
        ownerLineUserId: "U1",
        staffName: "ต้อม",
        marketName: "พาชิโอ้",
        status: "open",
        transactionCount: 12,
      },
      {
        accountabilityRoundId: "empty",
        sourceId: "group:C1",
        ownerLineUserId: "U1",
        staffName: "ต้อม",
        marketName: "พาชิโอ้",
        status: "open",
        transactionCount: 0,
      },
    ];

    const result = buildDailyClosePreflight(input({ openRounds }));
    expect(result.status).toBe("ready_with_warnings");
    const duplicate = result.integrityIssues[0];
    expect(duplicate.code).toBe("duplicate_open_accountability_round");
    expect(duplicate.severity).toBe("warning");
    expect(duplicate.accountabilityRoundId).toBe("canonical");
    expect(duplicate.evidenceIds).toEqual(["canonical", "empty"]);
  });

  test("12b. two duplicate rounds that both hold produce fail closed", () => {
    const openRounds: PreflightRoundRecord[] = [
      {
        accountabilityRoundId: "a",
        sourceId: "group:C1",
        ownerLineUserId: "U1",
        staffName: "ต้อม",
        marketName: "พาชิโอ้",
        status: "open",
        transactionCount: 3,
      },
      {
        accountabilityRoundId: "b",
        sourceId: "group:C1",
        ownerLineUserId: "U1",
        staffName: "ต้อม",
        marketName: "พาชิโอ้",
        status: "open",
        transactionCount: 5,
      },
    ];

    const result = buildDailyClosePreflight(input({ openRounds }));
    expect(result.status).toBe("blocked");
    expect(result.integrityIssues[0].severity).toBe("blocker");
  });

  test("13. unbound produce blocks only where the market demonstrably uses rounds", () => {
    const mixed = groupUnboundProduce([
      { session_id: "s1", market_name: "ตลาด72", accountability_round_id: "r1" },
      { session_id: "s2", market_name: "ตลาด72", accountability_round_id: null },
      { session_id: "s3", market_name: "ตลาดเก่า", accountability_round_id: null },
    ]);

    const result = buildDailyClosePreflight(input({ unboundProduce: mixed }));
    const codes = result.integrityIssues.map((row) => `${row.marketName}:${row.severity}`);
    expect(codes).toEqual(["ตลาด72:blocker", "ตลาดเก่า:warning"]);
    expect(result.status).toBe("blocked");
  });

  test("14. a failure belonging to another business date is never part of this day", () => {
    // The loader attributes by business date; nothing dated elsewhere reaches
    // the builder, so a day with no attempts stays clean.
    const result = buildDailyClosePreflight(input({ failureAttempts: [], failureClassifications: [] }));
    expect(result.status).toBe("ready");
    expect(result.summary.activeFailedSessions).toBe(0);
  });

  test("a round with no return at all is READY, with a warning a human can check", () => {
    const result = buildDailyClosePreflight(
      input({
        roundStatuses: [round({ hasPersistedReturn: false, state: "none", withdrawalItemCount: 7 })],
      }),
    );
    expect(result.status).toBe("ready_with_warnings");
    expect(result.rounds[0].status).toBe("ready");
    expect(result.rounds[0].warnings[0].code).toBe("missing_successful_return");
    expect(result.rounds[0].warnings[0].message).toContain("7");
  });

  test("an open, never-closed return document blocks its round", () => {
    const result = buildDailyClosePreflight(
      input({ roundStatuses: [round({ hasPersistedReturn: false, state: "pending" })] }),
    );
    expect(result.rounds[0].blockers[0].code).toBe("pending_produce_session");
    expect(result.status).toBe("blocked");
  });

  test("an active failure no round can claim is reported at day level", () => {
    const attempts = [attempt({ accountabilityRoundId: null, marketLabel: null })];
    const result = buildDailyClosePreflight(
      input({
        failureAttempts: attempts,
        failureClassifications: classifyProduceFailures(attempts, []),
      }),
    );
    expect(result.status).toBe("blocked");
    expect(result.integrityIssues[0].code).toBe("active_failed_produce_session");
    expect(result.integrityIssues[0].evidenceIds).toEqual(["attempt-1"]);
    // Nothing on the date proves what group:C1 works, so it stays day-wide.
    expect(result.integrityIssues[0].sourceMarketScope).toBeUndefined();
  });

  test("an unclaimable failure is scoped to the markets its own source ran", () => {
    const attempts = [attempt({ accountabilityRoundId: null, marketLabel: null, staffLabel: null })];
    const result = buildDailyClosePreflight(
      input({
        failureAttempts: attempts,
        failureClassifications: classifyProduceFailures(attempts, []),
        openRounds: [
          openRound({ sourceId: "group:C1", marketName: "ตลาดทุ่งลานนา" }),
          openRound({
            accountabilityRoundId: "round-9",
            sourceId: "group:C2",
            marketName: "ทรัพพันย์",
            staffName: "จ้า",
          }),
        ],
      }),
    );

    const [issue] = result.integrityIssues;
    expect(issue.code).toBe("active_failed_produce_session");
    expect(issue.sourceId).toBe("group:C1");
    // Canonical identity, not the raw label — the same one settlement compares.
    expect(issue.sourceMarketScope).toEqual(["วัดทุ่งลานนา"]);
    expect(result.status).toBe("blocked");
  });

  test("each source gets its own issue rather than one merged day-wide scope", () => {
    const attempts = [
      attempt({ attemptId: "a-1", accountabilityRoundId: null, marketLabel: null, sourceId: "group:C1" }),
      attempt({ attemptId: "a-2", accountabilityRoundId: null, marketLabel: null, sourceId: "group:C2" }),
      attempt({ attemptId: "a-3", accountabilityRoundId: null, marketLabel: null, sourceId: null }),
    ];
    const result = buildDailyClosePreflight(
      input({
        failureAttempts: attempts,
        failureClassifications: classifyProduceFailures(attempts, []),
        openRounds: [
          openRound({ sourceId: "group:C1", marketName: "เลียบด่วน" }),
          openRound({ accountabilityRoundId: "round-9", sourceId: "group:C2", marketName: "วัดตะกล่ำ" }),
        ],
      }),
    );

    expect(result.integrityIssues.map((row) => [row.sourceId, row.sourceMarketScope])).toEqual([
      // The unowned attempt sorts first and carries no scope: still day-wide.
      [null, undefined],
      ["group:C1", ["เลียบด่วน"]],
      ["group:C2", ["วัดตะกล่ำ"]],
    ]);
  });

  test("a source running several markets is scoped to all of them, never fewer", () => {
    const attempts = [attempt({ accountabilityRoundId: null, marketLabel: null })];
    const result = buildDailyClosePreflight(
      input({
        failureAttempts: attempts,
        failureClassifications: classifyProduceFailures(attempts, []),
        openRounds: [
          openRound({ sourceId: "group:C1", marketName: "เลียบด่วน" }),
          openRound({ accountabilityRoundId: "round-9", sourceId: "group:C1", marketName: "วัดตะกล่ำ" }),
          // A retired round still proves the group worked that market today.
          openRound({
            accountabilityRoundId: "round-10",
            sourceId: "group:C1",
            marketName: "ราชพฤกษ์",
            status: "cancelled",
          }),
        ],
      }),
    );

    expect(result.integrityIssues[0].sourceMarketScope)
      .toEqual(["ราชพฤกษ์", "วัดตะกล่ำ", "เลียบด่วน"]);
  });

  test("a retired round makes its failure abandoned, not active", () => {
    const attempts = [attempt()];
    const classifications = classifyProduceFailures(attempts, [], {
      cancelledRoundIds: new Set(["round-2"]),
    });
    const result = buildDailyClosePreflight(
      input({ failureAttempts: attempts, failureClassifications: classifications }),
    );
    expect(result.summary.activeFailedSessions).toBe(0);
    expect(result.supersededFailures[0].state).toBe("abandoned");
    expect(result.status).toBe("ready_with_warnings");
  });
});

describe("duplicate anomalies in the preflight", () => {
  const exact = {
    kind: "exact_duplicate_withdrawal",
    fingerprint: "abc123",
    sessions: [
      {
        sessionId: "s-a",
        accountabilityRoundId: "d5ae8a20-6e41-4293-8065-dcfab9ff2b97",
        sellerLabel: "แทน",
        marketLabel: "ราชพฤก",
        itemCount: 16,
        totalAmount: 7187,
        fingerprint: "abc123",
      },
      {
        sessionId: "s-b",
        accountabilityRoundId: "0874d4f3-9e6a-4aba-afad-02f6c848fcaf",
        sellerLabel: "แทน",
        marketLabel: "ราชพฤก",
        itemCount: 16,
        totalAmount: 7187,
        fingerprint: "abc123",
      },
    ],
  } as const;

  const composite = {
    kind: "possible_composite_duplicate",
    whole: {
      sessionId: "s-palee",
      accountabilityRoundId: "1846c8a3-3c46-4181-92b7-fc85a1834c20",
      sellerLabel: "ป้าลี",
      marketLabel: "ตลาด72",
      itemCount: 30,
      totalAmount: 19571.5,
      fingerprint: "whole",
    },
    parts: [
      {
        sessionId: "s-kwan",
        accountabilityRoundId: "69e0770b-9cea-4273-99c3-2ae40d98ca9e",
        sellerLabel: "ขวัญ",
        marketLabel: "72ผลไม้",
        itemCount: 27,
        totalAmount: 15901.5,
        fingerprint: "part-1",
      },
      {
        sessionId: "s-do",
        accountabilityRoundId: "bbf1c5bf-460f-451f-a64a-41f2a43a1338",
        sellerLabel: "โด้",
        marketLabel: "72ทุเรียน",
        itemCount: 3,
        totalAmount: 3670,
        fingerprint: "part-2",
      },
    ],
  } as const;

  test("an exact duplicate blocks the date and names both rounds", () => {
    const result = buildDailyClosePreflight(input({ duplicateAnomalies: [exact] }));

    expect(result.status).toBe("blocked");
    const found = result.integrityIssues.find((i) => i.code === "exact_duplicate_withdrawal");
    expect(found?.severity).toBe("blocker");
    expect(found?.evidenceIds).toEqual([
      "s-a", "s-b",
      "d5ae8a20-6e41-4293-8065-dcfab9ff2b97",
      "0874d4f3-9e6a-4aba-afad-02f6c848fcaf",
      "fingerprint:abc123",
    ]);
  });

  test("a composite overlap only warns, and never proposes a merge", () => {
    const result = buildDailyClosePreflight(input({ duplicateAnomalies: [composite] }));

    expect(result.status).toBe("ready_with_warnings");
    const found = result.integrityIssues.find((i) => i.code === "possible_composite_duplicate");
    expect(found?.severity).toBe("warning");
    expect(found?.evidenceIds).toContain("s-palee");
    expect(found?.evidenceIds).toContain("s-kwan");
    expect(found?.evidenceIds).toContain("s-do");
    // Evidence for a human, not an instruction to the system.
    expect(found?.message).toContain("ผู้ดูแลตรวจสอบ");
  });

  test("CASE Q — a day with no duplicates reconciles exactly as before", () => {
    const before = buildDailyClosePreflight(input());
    const after = buildDailyClosePreflight(input({ duplicateAnomalies: [] }));
    expect(after).toEqual(before);
    expect(after.summary.integrityIssues).toBe(0);
  });
});
