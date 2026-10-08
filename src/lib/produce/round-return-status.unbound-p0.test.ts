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
});
