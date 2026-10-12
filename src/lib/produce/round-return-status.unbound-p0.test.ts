/**
 * P0 reproducer: failed-closed returns not attached to a round must never be
 * treated as conclusive evidence that the withdrawal was sold out.
 *
 * This is intentionally a RED test against origin/main (2026-10-08).
 * It is not a proposed repair or a request to write Production records.
 * Keep this branch separate from AI Consultant PR #174.
 */
import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadRoundReturnStatuses } from "./round-return-status";

type Row = Record<string, unknown>;
type Database = Record<string, Row[]>;

const DAY = "2026-10-07";
const ROUND = "round-for-2026-10-07";
const issued: Row = {
  id: "withdrawal-item",
  accountability_round_id: ROUND,
  transaction_date: DAY,
  transaction_type: "เบิก",
};
const identity: Row = {
  id: ROUND,
  seller_label: "น้อย",
  market_label: "ราชพฤกษ์",
  source_id: "source-1",
  business_date: DAY,
};
const refusedUnboundReturn: Row = {
  id: "return-not-saved",
  accountability_round_id: null,
  finalization_status: "failed_closed",
  terminalized: true,
  declared_transaction_type: null,
  accumulated_text: "น้อย-ราชพฤกษ์ ชั่งคืน 7/10/2569\n1.มะนาว 3 แพค\nจบรายการชั่งคืน",
  close_requested_at: null,
  source_id: "source-1",
  business_date: DAY,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function filteredClient(tables: Database): SupabaseClient<any> {
  return {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const query = {
        select() { return query; },
        eq(field: string, value: unknown) {
          rows = rows.filter((row) => row[field] === value);
          return query;
        },
        not(field: string, operator: string, value: unknown) {
          if (operator !== "is" || value !== null) throw new Error("Unexpected not() filter");
          rows = rows.filter((row) => row[field] !== null && row[field] !== undefined);
          return query;
        },
        or(_expression: string) {
          return query;
        },
        is(field: string, value: unknown) {
          rows = rows.filter((row) => row[field] === value);
          return query;
        },
        in(field: string, values: readonly unknown[]) {
          rows = rows.filter((row) => values.includes(row[field]));
          return query;
        },
        order() { return query; },
        range(start: number, end: number) {
          return Promise.resolve({ data: rows.slice(start, end + 1), error: null });
        },
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as unknown as SupabaseClient<any>;
}

describe("P0 — refused unbound return is not proof of selling out", () => {
  test("control: a withdrawal with no attempted return remains none", async () => {
    const db = filteredClient({
      produce_transactions: [issued],
      accountability_rounds: [identity],
      pending_sessions: [],
    });
    const result = await loadRoundReturnStatuses(db, DAY);
    expect(result).toHaveLength(1);
    expect(result[0]?.state).toBe("none");
  });

  test("regression RED: the refused 7 Oct return must block a confident sold-out classification", async () => {
    const db = filteredClient({
      produce_transactions: [issued],
      accountability_rounds: [identity],
      pending_sessions: [refusedUnboundReturn],
    });
    const result = await loadRoundReturnStatuses(db, DAY);
    expect(result).toHaveLength(1);
    expect(result[0]?.state).toBe("blocked");
  });

  test("a persisted successful return clears an old unbound failure", async () => {
    const db = filteredClient({
      produce_transactions: [issued, {
        id: "persisted-return", accountability_round_id: ROUND,
        transaction_date: DAY, transaction_type: "คืน",
      }],
      accountability_rounds: [identity],
      pending_sessions: [refusedUnboundReturn],
    });
    expect((await loadRoundReturnStatuses(db, DAY))[0]?.state).toBe("persisted");
  });

  test("a failure naming the seller's OTHER real market protects only that market's round", async () => {
    const db = filteredClient({
      produce_transactions: [issued, {
        ...issued, id: "w72", accountability_round_id: "round-72",
      }],
      accountability_rounds: [identity, {
        ...identity, id: "round-72", market_label: "เฉลิมฯ72",
      }],
      pending_sessions: [{ ...refusedUnboundReturn,
        market_label: "ตลาด72",
        accumulated_text: "น้อย-ตลาด72 ชั่งคืน 7/10/2569\n1.มะนาว 3 แพค\nจบรายการชั่งคืน",
      }],
    });
    const byRound = new Map((await loadRoundReturnStatuses(db, DAY))
      .map((row) => [row.accountabilityRoundId, row.state]));
    // ตลาด72 is a reviewed alias of เฉลิมฯ72: the same market, as the RPC sees it.
    expect(byRound.get("round-72")).toBe("blocked");
    expect(byRound.get(ROUND)).toBe("none");
  });

  test("a market typo matching no round still protects the seller's round (never silent sold-out)", async () => {
    const db = filteredClient({
      produce_transactions: [issued],
      accountability_rounds: [identity],
      pending_sessions: [{ ...refusedUnboundReturn,
        market_label: "ราชพรึก",
        accumulated_text: "น้อย-ราชพรึก ชั่งคืน 7/10/2569\n1.มะนาว 3 แพค\nจบรายการชั่งคืน",
      }],
    });
    expect((await loadRoundReturnStatuses(db, DAY))[0]?.state).toBe("blocked");
  });

  test("an unreviewed seller spelling protects the group's round in the named market", async () => {
    const db = filteredClient({
      produce_transactions: [issued, {
        ...issued, id: "w-other", accountability_round_id: "round-other-seller",
      }],
      accountability_rounds: [identity, {
        ...identity, id: "round-other-seller", seller_label: "แดง", market_label: "วัดทุ่งลานนา",
      }],
      pending_sessions: [{ ...refusedUnboundReturn,
        accumulated_text: "พี่น้อย-ราชพฤกษ์ ชั่งคืน 7/10/2569\n1.มะนาว 3 แพค\nจบรายการชั่งคืน",
        staff_label: "พี่น้อย",
      }],
    });
    const byRound = new Map((await loadRoundReturnStatuses(db, DAY))
      .map((row) => [row.accountabilityRoundId, row.state]));
    expect(byRound.get(ROUND)).toBe("blocked");
    expect(byRound.get("round-other-seller")).toBe("none");
  });

  test("a different LINE source never reaches a round when its own group holds the seller's round", async () => {
    const db = filteredClient({
      produce_transactions: [issued, {
        ...issued, id: "w-b", accountability_round_id: "round-group-b",
      }],
      accountability_rounds: [identity, { ...identity, id: "round-group-b", source_id: "other-source" }],
      pending_sessions: [{ ...refusedUnboundReturn, source_id: "other-source" }],
    });
    const byRound = new Map((await loadRoundReturnStatuses(db, DAY))
      .map((row) => [row.accountabilityRoundId, row.state]));
    expect(byRound.get("round-group-b")).toBe("blocked");
    expect(byRound.get(ROUND)).toBe("none");
  });

  test("a return sent from the wrong group still protects the seller's only matching round", async () => {
    const db = filteredClient({
      produce_transactions: [issued],
      accountability_rounds: [identity],
      pending_sessions: [{ ...refusedUnboundReturn, source_id: "group-without-rounds" }],
    });
    expect((await loadRoundReturnStatuses(db, DAY))[0]?.state).toBe("blocked");
  });

  test("an explicit previous business date never blocks the next day's withdrawal", async () => {
    const db = filteredClient({
      produce_transactions: [issued],
      accountability_rounds: [identity],
      pending_sessions: [{
        ...refusedUnboundReturn, business_date: "2026-10-06",
        accumulated_text: "น้อย-ราชพฤกษ์ ชั่งคืน 6/10/2569\\n1.มะนาว 3 แพค\\nจบรายการชั่งคืน",
      }],
    });
    expect((await loadRoundReturnStatuses(db, DAY))[0]?.state).toBe("none");
  });

  test("ambiguous same-identity rounds protect all candidates without database binding", async () => {
    const db = filteredClient({
      produce_transactions: [issued, {
        ...issued, id: "second-withdrawal", accountability_round_id: "second-round",
      }],
      accountability_rounds: [identity, { ...identity, id: "second-round" }],
      pending_sessions: [refusedUnboundReturn],
    });
    const result = await loadRoundReturnStatuses(db, DAY);
    expect(result.map((row) => row.state)).toEqual(["blocked", "blocked"]);
  });

  test("resolved or provably empty drafts do not become failed-return evidence", async () => {
    const db = filteredClient({
      produce_transactions: [issued],
      accountability_rounds: [identity],
      pending_sessions: [
        { ...refusedUnboundReturn, finalization_status: "finalized" },
        { ...refusedUnboundReturn, finalization_status: "expired_empty_draft" },
      ],
    });
    expect((await loadRoundReturnStatuses(db, DAY))[0]?.state).toBe("none");
  });
});
