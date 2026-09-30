import { describe, expect, it, setSystemTime } from "bun:test";
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

function splitTerms(expression: string): string[] {
  const terms: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of expression) {
    if (char === "," && depth === 0) {
      terms.push(current);
      current = "";
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    current += char;
  }
  terms.push(current);
  return terms;
}

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
        // PostgREST or() subset: top-level terms are OR'ed, and(...) terms
        // AND their parts; each part is `column.gte.value` or `column.is.null`.
        or(expression: string) {
          const matches = (target: RecoveryRow, term: string): boolean => {
            const nested = /^and\((.*)\)$/.exec(term);
            if (nested) return splitTerms(nested[1]).every((part) => matches(target, part));
            const [column, op, ...rest] = term.split(".");
            const value = rest.join(".");
            const actual = target[column as keyof RecoveryRow];
            if (op === "is" && value === "null") return actual === null;
            if (op === "gte") return actual !== null && String(actual) >= value;
            throw new Error(`Unsupported or() term: ${term}`);
          };
          filtered = filtered.filter((target) => splitTerms(expression).some((term) => matches(target, term)));
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
    expect(result.due).toBe(0);
    expect(result.recovered).toBe(0);
  });

  it("many stale rows outside the 24-hour window never starve younger recoverable batches", async () => {
    // 25 out-of-window rows with the oldest updated_at would fill the whole
    // 20-row oldest-first page if they were fetched.
    const expired = Array.from({ length: 25 }, (_, index) => row(`expired-${index}`, 60 * 30 + index, 30));
    const eligible = [row("eligible-a", 3), row("eligible-b", 5, 23)];
    const rows = [...expired, ...eligible];
    const supabase = makeRecoverySupabase(rows);
    const finalized: string[] = [];
    const finalize = async (_db: unknown, batchId: string) => {
      finalized.push(batchId);
      return { delivered: true as const, persisted: true as const };
    };

    for (let sweep = 0; sweep < 3; sweep += 1) {
      await recoverStaleProcessingSlipBatches(supabase, async () => {}, undefined, undefined, finalize);
    }

    expect(finalized.sort()).toEqual(["eligible-a", "eligible-b"]);
    // Out-of-window rows stay untouched in processing for manual recovery.
    for (const target of expired) {
      expect(target.status).toBe("processing");
      expect(target.summary_sent_at).toBeNull();
    }
  });

  it("uses closing_at, falling back to created_at, as the retry-window reference", async () => {
    const closedRecently = { ...row("closed-recently", 3, 30), closing_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() };
    const closedLongAgo = { ...row("closed-long-ago", 3, 1), closing_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() };
    const neverClosedYoung = { ...row("never-closed-young", 3, 1), closing_at: null };
    const neverClosedOld = { ...row("never-closed-old", 3, 25), closing_at: null };
    const supabase = makeRecoverySupabase([closedRecently, closedLongAgo, neverClosedYoung, neverClosedOld]);
    const finalized: string[] = [];

    const result = await recoverStaleProcessingSlipBatches(supabase, async () => {}, 2, 20, async (_db, batchId) => {
      finalized.push(batchId);
      return { delivered: true, persisted: true };
    });

    expect(finalized.sort()).toEqual(["closed-recently", "never-closed-young"]);
    expect(result.due).toBe(2);
  });

  it("does not lease a fetched batch that crosses the 24-hour boundary mid-sweep", async () => {
    const start = Date.now();
    const first = row("first", 5);
    const edge = { ...row("edge", 3), closing_at: new Date(start - 24 * 60 * 60 * 1000 + 500).toISOString() };
    const supabase = makeRecoverySupabase([first, edge]);
    const edgeUpdatedAt = edge.updated_at;
    const finalized: string[] = [];

    try {
      const result = await recoverStaleProcessingSlipBatches(supabase, async () => {}, 2, 20, async (_db, batchId) => {
        finalized.push(batchId);
        setSystemTime(new Date(start + 1_000));
        return { delivered: true, persisted: true };
      });

      expect(result.due).toBe(2);
      expect(finalized).toEqual(["first"]);
      expect(result.skippedOutsideRetryWindow).toBe(1);
      expect(edge.updated_at).toBe(edgeUpdatedAt);
    } finally {
      setSystemTime();
    }
  });

  it("defers unleased batches past the 15-second budget and serves them first next sweep", async () => {
    const start = Date.now();
    const rows = [row("slow", 9), row("deferred-a", 8), row("deferred-b", 7)];
    const supabase = makeRecoverySupabase(rows);
    const finalized: string[] = [];

    try {
      const first = await recoverStaleProcessingSlipBatches(supabase, async () => {}, 2, 20, async (_db, batchId) => {
        finalized.push(batchId);
        setSystemTime(new Date(start + 16_000));
        return { delivered: true, persisted: true };
      });

      expect(finalized).toEqual(["slow"]);
      expect(first.deferredByTimeBudget).toBe(2);
      // Deferred rows were never leased, so they keep the oldest updated_at.
      nextScheduledSweep(rows[0]);
      setSystemTime();
      const second = await recoverStaleProcessingSlipBatches(supabase, async () => {}, 2, 1, async (_db, batchId) => {
        finalized.push(batchId);
        return { delivered: true, persisted: true };
      });

      expect(second.recovered).toBe(1);
      expect(finalized).toEqual(["slow", "deferred-a"]);
    } finally {
      setSystemTime();
    }
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
