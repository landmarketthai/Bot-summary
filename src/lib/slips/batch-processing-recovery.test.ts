import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { LinePushError } from "@/lib/line/reply";
import { loadSlipBatchHealth, recoverStaleProcessingSlipBatches } from "./batch-finalizer";

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
      let patch: Partial<RecoveryRow> | null = null;
      const builder = {
        select() { return builder; },
        update(values: Partial<RecoveryRow>) {
          patch = values;
          return builder;
        },
        maybeSingle() {
          for (const target of filtered) Object.assign(target, patch);
          return Promise.resolve({ data: filtered[0] ? { id: filtered[0].id } : null, error: null });
        },
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

// The recovery lease renews updated_at. The next scheduled sweep (5-minute
// cadence) runs after the 2-minute stale guard, which this models directly.
function nextScheduledSweep(target: RecoveryRow): void {
  target.updated_at = new Date(Date.now() - 3 * 60 * 1000).toISOString();
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

  it("moves a permanent LINE 400 to unsent review_needed so later sweeps stop retrying it", async () => {
    const rows = [row("rejected", 3)];
    const supabase = makeRecoverySupabase(rows);
    let finalizeCalls = 0;
    const finalize = async () => {
      finalizeCalls += 1;
      throw new LinePushError("LINE push HTTP 400", 400, false);
    };

    const first = await recoverStaleProcessingSlipBatches(supabase, async () => {}, 2, 20, finalize);

    expect(first.movedToReview).toBe(1);
    expect(first.failed).toBe(0);
    expect(rows[0].status).toBe("review_needed");
    expect(rows[0].summary_sent_at).toBeNull();

    const second = await recoverStaleProcessingSlipBatches(supabase, async () => {}, 2, 20, finalize);

    expect(second.due).toBe(0);
    expect(finalizeCalls).toBe(1);
  });

  for (const status of [401, 403]) {
    it(`keeps a LINE ${status} (channel auth/config) in processing for automatic retry after the fix`, async () => {
      const rows = [row(`auth-${status}`, 3)];
      const supabase = makeRecoverySupabase(rows);
      let finalizeCalls = 0;
      const finalize = async () => {
        finalizeCalls += 1;
        if (finalizeCalls === 1) throw new LinePushError(`LINE push HTTP ${status}`, status, false);
      };

      const first = await recoverStaleProcessingSlipBatches(supabase, async () => {}, 2, 20, finalize);

      expect(first.failed).toBe(1);
      expect(first.movedToReview).toBe(0);
      expect(rows[0].status).toBe("processing");

      // Token fixed: next sweep picks the batch up again and recovers it.
      nextScheduledSweep(rows[0]);
      const second = await recoverStaleProcessingSlipBatches(supabase, async () => {}, 2, 20, finalize);

      expect(second.due).toBe(1);
      expect(second.recovered).toBe(1);
      expect(finalizeCalls).toBe(2);
    });
  }

  it("keeps a non-4xx non-retryable LINE failure in processing", async () => {
    const rows = [row("redirect", 3)];
    const supabase = makeRecoverySupabase(rows);
    const finalize = async () => {
      throw new LinePushError("LINE push HTTP 302", 302, false);
    };

    const result = await recoverStaleProcessingSlipBatches(supabase, async () => {}, 2, 20, finalize);

    expect(result.movedToReview).toBe(0);
    expect(result.failed).toBe(1);
    expect(rows[0].status).toBe("processing");
  });

  it("does not count a permanent rejection as moved when a concurrent worker already changed the batch", async () => {
    const rows = [row("raced", 3)];
    const supabase = makeRecoverySupabase(rows);
    const finalize = async () => {
      // Another worker finalizes the batch before this sweep's transition runs.
      Object.assign(rows[0], { status: "completed", summary_sent_at: new Date().toISOString() });
      throw new LinePushError("LINE push HTTP 400", 400, false);
    };

    const result = await recoverStaleProcessingSlipBatches(supabase, async () => {}, 2, 20, finalize);

    expect(result.movedToReview).toBe(0);
    expect(result.failed).toBe(1);
    expect(rows[0].status).toBe("completed");
  });

  it("keeps a retryable LINE 503 in processing and retries it on the next sweep", async () => {
    const rows = [row("unavailable", 3)];
    const supabase = makeRecoverySupabase(rows);
    let finalizeCalls = 0;
    const finalize = async () => {
      finalizeCalls += 1;
      throw new LinePushError("LINE push HTTP 503", 503, true);
    };

    const first = await recoverStaleProcessingSlipBatches(supabase, async () => {}, 2, 20, finalize);
    nextScheduledSweep(rows[0]);
    const second = await recoverStaleProcessingSlipBatches(supabase, async () => {}, 2, 20, finalize);

    expect(first.failed).toBe(1);
    expect(first.movedToReview).toBe(0);
    expect(rows[0].status).toBe("processing");
    expect(second.due).toBe(1);
    expect(finalizeCalls).toBe(2);
  });

  it("overlapping sweeps finalize each stale batch exactly once", async () => {
    const rows = [row("a", 3), row("b", 3)];
    const supabase = makeRecoverySupabase(rows);
    const finalized: string[] = [];
    const finalize = async (_db: unknown, batchId: string) => {
      finalized.push(batchId);
      return { delivered: true as const, persisted: true as const };
    };

    const [first, second] = await Promise.all([
      recoverStaleProcessingSlipBatches(supabase, async () => {}, 2, 20, finalize),
      recoverStaleProcessingSlipBatches(supabase, async () => {}, 2, 20, finalize),
    ]);

    expect(finalized.sort()).toEqual(["a", "b"]);
    expect(first.recovered + second.recovered).toBe(2);
    expect(first.claimConflicts + second.claimConflicts).toBe(2);
  });

  it("a just-leased batch is not retried again by an immediate re-run", async () => {
    const rows = [row("leased", 3)];
    const supabase = makeRecoverySupabase(rows);
    let finalizeCalls = 0;
    const finalize = async () => {
      finalizeCalls += 1;
      throw new LinePushError("LINE push HTTP 503", 503, true);
    };

    await recoverStaleProcessingSlipBatches(supabase, async () => {}, 2, 20, finalize);
    const rerun = await recoverStaleProcessingSlipBatches(supabase, async () => {}, 2, 20, finalize);

    expect(rerun.due).toBe(0);
    expect(finalizeCalls).toBe(1);
    expect(rows[0].status).toBe("processing");
  });
});

describe("loadSlipBatchHealth", () => {
  function healthSupabase(rows: RecoveryRow[], failWith?: string): SupabaseClient<Database> {
    return {
      from() {
        let filtered = [...rows];
        const builder = {
          select() { return builder; },
          eq(column: keyof RecoveryRow, value: unknown) {
            filtered = filtered.filter((item) => item[column] === value);
            return builder;
          },
          is(column: keyof RecoveryRow, value: unknown) {
            filtered = filtered.filter((item) => item[column] === value);
            return builder;
          },
          order(column: keyof RecoveryRow) {
            filtered.sort((a, b) => String(a[column]).localeCompare(String(b[column])));
            return builder;
          },
          limit(limit: number) {
            return Promise.resolve(failWith
              ? { data: null, count: null, error: { message: failWith } }
              : { data: filtered.slice(0, limit), count: filtered.length, error: null });
          },
        };
        return builder;
      },
    } as unknown as SupabaseClient<Database>;
  }

  it("counts unsent processing and review_needed batches with the oldest age", async () => {
    const parked = { ...row("parked", 30, 5), status: "review_needed" };
    const sent = { ...row("sent", 30, 9), status: "review_needed", summary_sent_at: new Date().toISOString() };
    const health = await loadSlipBatchHealth(healthSupabase([row("p1", 3, 1), row("p2", 3, 2), parked, sent]));

    expect(health?.processingUnsent.count).toBe(2);
    expect(health?.processingUnsent.oldestAgeSeconds).toBeGreaterThanOrEqual(2 * 60 * 60 - 5);
    expect(health?.reviewNeededUnsent.count).toBe(1);
    expect(health?.reviewNeededUnsent.oldestAgeSeconds).toBeGreaterThanOrEqual(5 * 60 * 60 - 5);
  });

  it("reports empty backlogs as zero with no age, and read errors as null", async () => {
    expect(await loadSlipBatchHealth(healthSupabase([]))).toEqual({
      processingUnsent: { count: 0, oldestAgeSeconds: null },
      reviewNeededUnsent: { count: 0, oldestAgeSeconds: null },
    });
    expect(await loadSlipBatchHealth(healthSupabase([], "timeout"))).toBeNull();
  });
});
