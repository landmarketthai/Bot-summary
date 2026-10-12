import { describe, expect, test } from "bun:test";
import {
  activeFailureIds,
  activeIncompleteReturnRoundIds,
  classifyProduceFailure,
  classifyProduceFailures,
  type FinalizedProduceOutcome,
  type ProduceFailureAttempt,
} from "./failure-lifecycle";

function attempt(overrides: Partial<ProduceFailureAttempt> = {}): ProduceFailureAttempt {
  return {
    attemptId: "attempt-a",
    origin: "pending_session",
    businessDate: "2026-08-13",
    sourceId: "group:C1",
    staffLabel: "เมย์",
    marketLabel: "ทรัพย์พัน",
    transactionKind: "คืน",
    accountabilityRoundId: null,
    attemptedAtMs: 1_000,
    ...overrides,
  };
}

function outcome(overrides: Partial<FinalizedProduceOutcome> = {}): FinalizedProduceOutcome {
  return {
    produceSessionId: "session-b",
    businessDate: "2026-08-13",
    sourceId: "group:C1",
    staffLabel: "เมย์",
    marketLabel: "ทรัพย์พัน",
    transactionKind: "คืน",
    accountabilityRoundId: null,
    sessionKind: "main",
    finalizedAtMs: 2_000,
    ...overrides,
  };
}

describe("produce failure lifecycle", () => {
  test("a failure with no replacement stays active", () => {
    const result = classifyProduceFailure(attempt(), []);
    expect(result.state).toBe("active_failed");
    expect(result.supersededByProduceSessionId).toBeNull();
    expect(result.ambiguousSuccessor).toBe(false);
  });

  test("a later successful document with the same intent supersedes it", () => {
    const result = classifyProduceFailure(attempt(), [outcome()]);
    expect(result.state).toBe("superseded");
    expect(result.supersededByProduceSessionId).toBe("session-b");
  });

  test("several failed attempts are all superseded by the one success", () => {
    const results = classifyProduceFailures(
      [
        attempt({ attemptId: "a", attemptedAtMs: 1_000 }),
        attempt({ attemptId: "b", attemptedAtMs: 1_500 }),
      ],
      [outcome({ finalizedAtMs: 2_000 })],
    );
    expect(results.map((row) => row.state)).toEqual(["superseded", "superseded"]);
    expect(activeFailureIds(results).size).toBe(0);
  });

  test("a success in another market never supersedes", () => {
    const result = classifyProduceFailure(attempt(), [outcome({ marketLabel: "ราชพฤกษ์" })]);
    expect(result.state).toBe("active_failed");
  });

  test("a success by another seller never supersedes", () => {
    const result = classifyProduceFailure(attempt(), [outcome({ staffLabel: "จิ๋ว" })]);
    expect(result.state).toBe("active_failed");
  });

  test("a success from another LINE source never supersedes", () => {
    const result = classifyProduceFailure(attempt(), [outcome({ sourceId: "group:C2" })]);
    expect(result.state).toBe("active_failed");
  });

  test("a success on another business date never supersedes", () => {
    const result = classifyProduceFailure(attempt(), [outcome({ businessDate: "2026-08-12" })]);
    expect(result.state).toBe("active_failed");
  });

  test("a success of a different transaction kind never supersedes", () => {
    const result = classifyProduceFailure(attempt(), [outcome({ transactionKind: "เบิก" })]);
    expect(result.state).toBe("active_failed");
  });

  test("an earlier success never supersedes a later failure", () => {
    const result = classifyProduceFailure(
      attempt({ attemptedAtMs: 5_000 }),
      [outcome({ finalizedAtMs: 2_000 })],
    );
    expect(result.state).toBe("active_failed");
  });

  test("an additional batch is additive, never a replacement", () => {
    const result = classifyProduceFailure(attempt(), [outcome({ sessionKind: "additional" })]);
    expect(result.state).toBe("active_failed");
  });

  test("an unknown session kind is not assumed to be a main replacement", () => {
    expect(classifyProduceFailure(attempt(), [outcome({ sessionKind: null })]).state)
      .toBe("active_failed");
  });

  test("two candidate successors fail closed and are flagged ambiguous", () => {
    const result = classifyProduceFailure(attempt(), [
      outcome({ produceSessionId: "s1", finalizedAtMs: 2_000 }),
      outcome({ produceSessionId: "s2", finalizedAtMs: 3_000 }),
    ]);
    expect(result.state).toBe("active_failed");
    expect(result.ambiguousSuccessor).toBe(true);
  });

  test("an unknown transaction kind can never be superseded", () => {
    const result = classifyProduceFailure(attempt({ transactionKind: null }), [outcome()]);
    expect(result.state).toBe("active_failed");
  });

  test("a missing identity dimension can never be superseded", () => {
    for (const missing of ["sourceId", "businessDate", "marketLabel", "staffLabel"] as const) {
      const result = classifyProduceFailure(attempt({ [missing]: null }), [outcome()]);
      expect(result.state).toBe("active_failed");
    }
  });

  test("an unprovable ordering can never be superseded", () => {
    expect(classifyProduceFailure(attempt({ attemptedAtMs: null }), [outcome()]).state)
      .toBe("active_failed");
    expect(classifyProduceFailure(attempt(), [outcome({ finalizedAtMs: null })]).state)
      .toBe("active_failed");
  });

  describe("round path", () => {
    const bound = attempt({ accountabilityRoundId: "round-1" });

    test("the same round and every other identity dimension, later, is proof", () => {
      const result = classifyProduceFailure(bound, [
        outcome({ accountabilityRoundId: "round-1" }),
      ]);
      expect(result.state).toBe("superseded");
    });

    test("a round id never overrides seller, exact market, source, or date", () => {
      for (const changed of [
        { staffLabel: "จิ๋ว" },
        { marketLabel: "ราชพฤกษ์" },
        { sourceId: "group:C2" },
        { businessDate: "2026-08-12" },
      ]) {
        expect(
          classifyProduceFailure(bound, [
            outcome({ accountabilityRoundId: "round-1", ...changed }),
          ]).state,
        ).toBe("active_failed");
      }
    });

    test("another round never supersedes, however similar the labels", () => {
      const result = classifyProduceFailure(bound, [
        outcome({ accountabilityRoundId: "round-2" }),
      ]);
      expect(result.state).toBe("active_failed");
    });

    test("a bound attempt is never rescued by the label identity path", () => {
      // Same seller/market/date, but the success belongs to no round at all.
      const result = classifyProduceFailure(bound, [outcome({ accountabilityRoundId: null })]);
      expect(result.state).toBe("active_failed");
    });

    test("an unbound attempt is superseded by one bound outcome with exact business identity", () => {
      const result = classifyProduceFailure(attempt(), [
        outcome({ accountabilityRoundId: "round-1" }),
      ]);
      expect(result.state).toBe("superseded");
    });

    test("a retired round is abandoned, not an active failure", () => {
      const result = classifyProduceFailure(bound, [], {
        cancelledRoundIds: new Set(["round-1"]),
      });
      expect(result.state).toBe("abandoned");
      expect(result.ambiguousSuccessor).toBe(false);
    });
  });

  test("a voided later success is not a successor", () => {
    const result = classifyProduceFailure(attempt(), [outcome({ voidedAtMs: 2_100 })]);
    expect(result.state).toBe("active_failed");
  });

  test("a voided success is ignored in favor of its sole active replacement", () => {
    const result = classifyProduceFailure(attempt(), [
      outcome({ produceSessionId: "voided", finalizedAtMs: 2_000, voidedAtMs: 2_500 }),
      outcome({ produceSessionId: "replacement", finalizedAtMs: 3_000 }),
    ]);
    expect(result).toMatchObject({
      state: "superseded",
      supersededByProduceSessionId: "replacement",
      ambiguousSuccessor: false,
    });
  });

  test("only active bound return attempts suppress sold-out inference", () => {
    const attempts = [
      attempt({ attemptId: "return-active", accountabilityRoundId: "round-1" }),
      attempt({ attemptId: "withdraw-active", accountabilityRoundId: "round-2", transactionKind: "เบิก" }),
      attempt({ attemptId: "return-fixed", accountabilityRoundId: "round-3" }),
    ];
    const classifications = [
      classifyProduceFailure(attempts[0], []),
      classifyProduceFailure(attempts[1], []),
      classifyProduceFailure(attempts[2], [outcome({ accountabilityRoundId: "round-3" })]),
    ];

    expect(activeIncompleteReturnRoundIds(attempts, classifications)).toEqual(new Set(["round-1"]));
  });

  test("label comparison is normalized, not fuzzy", () => {
    expect(
      classifyProduceFailure(attempt({ marketLabel: " ทรัพย์พัน  " }), [outcome()]).state,
    ).toBe("superseded");
    // พุทรา and พุทราไทย are NOT the same identity — no silent aliasing here.
    expect(
      classifyProduceFailure(attempt({ marketLabel: "ทรัพย์พัน2" }), [outcome()]).state,
    ).toBe("active_failed");
  });
});

describe("P0: an unbound refused return is released only by every round it could belong to", () => {
  const master = (round: string, marketLabel: string, overrides: Partial<FinalizedProduceOutcome> = {}) =>
    outcome({
      produceSessionId: `withdrawal-${round}`, accountabilityRoundId: round, marketLabel,
      transactionKind: "เบิก", finalizedAtMs: 500, ...overrides,
    });
  const laterReturn = (round: string, marketLabel: string) =>
    outcome({ produceSessionId: `return-${round}`, accountabilityRoundId: round, marketLabel });

  test("an exact-identity return must cover every candidate round too", () => {
    const outcomes = [master("r1", "ทรัพย์พัน"), master("r2", "ทรัพย์พัน"), laterReturn("r2", "ทรัพย์พัน")];
    expect(classifyProduceFailure(attempt(), outcomes).state).toBe("active_failed");
    expect(classifyProduceFailure(attempt(), [...outcomes, laterReturn("r1", "ทรัพย์พัน")]).state)
      .toBe("superseded");
  });

  test("two later main returns on one candidate round remain ambiguous", () => {
    const result = classifyProduceFailure(attempt(), [master("r1", "ทรัพย์พัน"),
      laterReturn("r1", "ทรัพย์พัน"), { ...laterReturn("r1", "ทรัพย์พัน"), produceSessionId: "another-return" }]);
    expect(result.state).toBe("active_failed");
    expect(result.ambiguousSuccessor).toBe(true);
  });

  test("a mistyped market is released by the corrected return on the seller's only round", () => {
    const result = classifyProduceFailure(
      attempt({ marketLabel: "ทรัพย์พันน" }),
      [master("r1", "ทรัพย์พัน"), laterReturn("r1", "ทรัพย์พัน")],
    );
    expect(result.state).toBe("superseded");
    expect(result.supersededByProduceSessionId).toBe("return-r1");
  });

  test("a real market is never released by the seller's other market's return (ต้อม)", () => {
    const result = classifyProduceFailure(attempt(), [
      master("r1", "ทรัพย์พัน"), master("r2", "ราชพฤกษ์"), laterReturn("r2", "ราชพฤกษ์"),
    ]);
    expect(result.state).toBe("active_failed");
  });

  test("a typo spanning several of the seller's markets waits for every one of them", () => {
    const outcomes = [master("r1", "ทรัพย์พัน"), master("r2", "ราชพฤกษ์"), laterReturn("r2", "ราชพฤกษ์")];
    expect(classifyProduceFailure(attempt({ marketLabel: "ตลาดผิด" }), outcomes).state).toBe("active_failed");
    expect(classifyProduceFailure(
      attempt({ marketLabel: "ตลาดผิด" }), [...outcomes, laterReturn("r1", "ทรัพย์พัน")],
    ).state).toBe("superseded");
  });

  test("another seller's return on the same market never releases it", () => {
    const result = classifyProduceFailure(attempt(), [
      master("r1", "ทรัพย์พัน"), master("r2", "ทรัพย์พัน", { staffLabel: "จิ๋ว" }),
      { ...laterReturn("r2", "ทรัพย์พัน"), staffLabel: "จิ๋ว" },
    ]);
    expect(result.state).toBe("active_failed");
  });

  test("an earlier return on the round is not a correction; withdrawals are never released", () => {
    const early = { ...laterReturn("r1", "ทรัพย์พัน"), finalizedAtMs: 900 };
    expect(classifyProduceFailure(attempt({ marketLabel: "ทรัพย์พันน" }), [master("r1", "ทรัพย์พัน"), early]).state)
      .toBe("active_failed");
    expect(classifyProduceFailure(
      attempt({ marketLabel: "ทรัพย์พันน", transactionKind: "เบิก" }),
      [master("r1", "ทรัพย์พัน"), { ...master("r1", "ทรัพย์พัน"), produceSessionId: "w2", finalizedAtMs: 2_000 }],
    ).state).toBe("active_failed");
  });
});
