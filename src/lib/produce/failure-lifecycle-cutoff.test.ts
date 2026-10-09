/**
 * P0-D: an undated return sent just after 04:00 is evidence for both days.
 * Only a resend dated the EARLIER day may supersede it; the later day's
 * ordinary return is a different document.
 */
import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyProduceFailuresAcrossCutoff } from "./failure-lifecycle-source";
import type { ProduceFailureAttempt } from "./failure-lifecycle";

type Row = Record<string, unknown>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function filteredClient(tables: Record<string, Row[]>): SupabaseClient<any> {
  return {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const query = {
        select() { return query; },
        eq(field: string, value: unknown) { rows = rows.filter((row) => row[field] === value); return query; },
        is(field: string, value: unknown) { rows = rows.filter((row) => (row[field] ?? null) === value); return query; },
        in(field: string, values: readonly unknown[]) { rows = rows.filter((row) => values.includes(row[field])); return query; },
        order() { return query; },
        range(start: number, end: number) { return Promise.resolve({ data: rows.slice(start, end + 1), error: null }); },
        then(resolve: (value: unknown) => unknown) { return Promise.resolve({ data: rows, error: null }).then(resolve); },
      };
      return query;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as unknown as SupabaseClient<any>;
}

const D = "2026-10-07";
const NEXT = "2026-10-08";
const SOURCE = "group-1";

function landedReturn(id: string, date: string, finalizedAt: string): { session: Row; item: Row; raw: Row } {
  return {
    session: {
      id, staff_name: "น้อย", session_title: "ราชพฤกษ์", session_date: date, session_kind: "main",
      accountability_round_id: `round-${date}`, raw_message_id: `raw-${id}`, voided_at: null,
      finalized_at: finalizedAt, created_at: finalizedAt,
    },
    item: { id: `item-${id}`, session_id: id, transaction_type: "คืน", transaction_date: date },
    raw: { id: `raw-${id}`, source_id: SOURCE },
  };
}

function db(...landed: ReturnType<typeof landedReturn>[]) {
  return filteredClient({
    produce_sessions: landed.map((row) => row.session),
    produce_transactions: landed.map((row) => row.item),
    raw_messages: landed.map((row) => row.raw),
  });
}

// Sent 04:10 Bangkok on 8/10, undated: the clock says 8/10, it may be 7/10's.
const attemptedAtMs = Date.parse("2026-10-07T21:10:00.000Z");
function attempt(businessDate: string, alternateBusinessDate: string): ProduceFailureAttempt {
  return {
    attemptId: "undated-return", origin: "pending_session", businessDate, alternateBusinessDate,
    sourceId: SOURCE, staffLabel: "น้อย", marketLabel: "ราชพฤกษ์", transactionKind: "คืน",
    accountabilityRoundId: null, attemptedAtMs,
  };
}
const noEvidence = { outcomes: [], cancelledRoundIds: new Set<string>() };

describe("P0-D cross-cutoff supersession", () => {
  test("on yesterday's report, today's ordinary return never clears it", async () => {
    const today = landedReturn("today-return", NEXT, "2026-10-08T12:00:00.000Z");
    const [result] = await classifyProduceFailuresAcrossCutoff(db(today), [attempt(D, NEXT)], noEvidence);
    expect(result.state).toBe("active_failed");
  });

  test("on today's report, a resend dated yesterday clears it", async () => {
    const resend = landedReturn("dated-resend", D, "2026-10-08T01:00:00.000Z");
    const [result] = await classifyProduceFailuresAcrossCutoff(db(resend), [attempt(NEXT, D)], noEvidence);
    expect(result.state).toBe("superseded");
    expect(result.supersededByProduceSessionId).toBe("dated-resend");
  });
});
