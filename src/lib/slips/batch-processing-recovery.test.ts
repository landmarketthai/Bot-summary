import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { recoverStaleProcessingSlipBatches } from "./batch-finalizer";

type RecoveryRow = {
  id: string;
  source_id: string;
  status: string;
  summary_sent_at: string | null;
  closing_at: string | null;
  created_at: string;
  updated_at: string;
};

function makeRecoverySupabase(rows: RecoveryRow[]): SupabaseClient<Database> {
  return {
    from(table: string) {
      if (table !== "slip_batches") throw new Error(`Unexpected table: ${table}`);
      let filtered = [...rows];
      const builder = {
        select() { return builder; },
        eq(column: keyof RecoveryRow, value: unknown) {
          filtered = filtered.filter((row) => row[column] === value);
          return builder;
        },
        is(column: keyof RecoveryRow, value: unknown) {
          filtered = filtered.filter((row) => row[column] === value);
          return builder;
        },
        lte(column: keyof RecoveryRow, value: string) {
          filtered = filtered.filter((row) => String(row[column]) <= value);
          return builder;
        },
        order(column: keyof RecoveryRow) {
          filtered.sort((a, b) => String(a[column]).localeCompare(String(b[column])));
          return builder;
        },
        limit(limit: number) {
          return Promise.resolve({ data: filtered.slice(0, limit), error: null });
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient<Database>;
}

function row(id: string, updatedMinutesAgo: number, createdHoursAgo = 1): RecoveryRow {
  const now = Date.now();
  return {
    id,
    source_id: `source-${id}`,
    status: "processing",
    summary_sent_at: null,
    closing_at: new Date(now - createdHoursAgo * 60 * 60 * 1000).toISOString(),
    created_at: new Date(now - createdHoursAgo * 60 * 60 * 1000).toISOString(),
    updated_at: new Date(now - updatedMinutesAgo * 60 * 1000).toISOString(),
  };
}

describe("recoverStaleProcessingSlipBatches", () => {
  it("uses the production defaults: stale after 2 minutes and at most 20 batches", async () => {
    const supabase = makeRecoverySupabase([
      row("fresh", 1),
      ...Array.from({ length: 21 }, (_, index) => row(`stale-${index}`, 3)),
    ]);
    const finalized: string[] = [];

    const result = await recoverStaleProcessingSlipBatches(
      supabase,
      async () => {},
      undefined,
      undefined,
      async (_db, batchId) => {
        finalized.push(batchId);
        return { delivered: true, persisted: true };
      },
    );

    expect(finalized).toHaveLength(20);
    expect(finalized).not.toContain("fresh");
    expect(result.due).toBe(20);
    expect(result.recovered).toBe(20);
  });

  it("reuses the batch id as LINE retry key", async () => {
    const supabase = makeRecoverySupabase([row("stale", 3)]);
    const pushes: Array<{ to: string; retryKey?: string }> = [];

    await recoverStaleProcessingSlipBatches(
      supabase,
      async (to, _text, retryKey) => { pushes.push({ to, retryKey }); },
      2,
      20,
      async (_db, _batchId, sendMessage) => {
        await sendMessage("summary");
        return { delivered: true, persisted: true };
      },
    );

    expect(pushes).toEqual([{ to: "source-stale", retryKey: "stale" }]);
  });

  it("does not auto-send a stale batch outside LINE's 24-hour retry-key window", async () => {
    const supabase = makeRecoverySupabase([row("too-old", 3, 25)]);
    let finalizeCalls = 0;

    const result = await recoverStaleProcessingSlipBatches(
      supabase,
      async () => {},
      2,
      20,
      async () => {
        finalizeCalls += 1;
        return { delivered: true, persisted: true };
      },
    );

    expect(finalizeCalls).toBe(0);
    expect(result.skippedOutsideRetryWindow).toBe(1);
    expect(result.recovered).toBe(0);
  });

  it("keeps sweeping after one recovered batch fails", async () => {
    const supabase = makeRecoverySupabase([row("a", 3), row("b", 3)]);
    const finalized: string[] = [];

    const result = await recoverStaleProcessingSlipBatches(
      supabase,
      async () => {},
      2,
      20,
      async (_db, batchId) => {
        finalized.push(batchId);
        if (batchId === "a") throw new Error("temporary DB outage");
        return { delivered: true, persisted: true };
      },
    );

    expect(finalized).toEqual(["a", "b"]);
    expect(result.failed).toBe(1);
    expect(result.recovered).toBe(1);
  });
});
