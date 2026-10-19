import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_INGEST_MAX_SECONDS,
  SLIP_INGEST_POLICY,
  assessIngestPolicy,
  attemptWorstCaseMs,
  attemptsStartedBy,
  backoffAfterAttemptSeconds,
  cronIngestCapacityPerSweep,
  cronOcrCapacityPerSweep,
  cronRecoveryBudget,
  cronRouteBudgetMs,
  maxSweepGapSeconds,
  requiredIngestMaxSeconds,
  requiredOcrWaitSeconds,
  retryImageInRequest,
  runBounded,
  simulateCohortIngest,
  simulateIngestAttempts,
  worstCaseExhaustionSeconds,
  type CohortSimulation,
  type SlipIngestPolicy,
} from "./ingest-policy";
import { SLIP_CHECK_LEASE_SECONDS } from "./check-service";
import { FINALIZE_BATCH_RESERVE_MS } from "./batch-finalizer";

const P = SLIP_INGEST_POLICY;
const ROOT = join(import.meta.dir, "..", "..", "..");
const migration = readFileSync(
  join(ROOT, "supabase", "migrations", "20261017100000_slip_image_ingestion_ledger.sql"),
  "utf8",
);
const ocrMigration = readFileSync(
  join(ROOT, "supabase", "migrations", "20261017110000_slip_ocr_claim_fencing.sql"),
  "utf8",
);
const workflow = readFileSync(join(ROOT, ".github", "workflows", "finalize-slip-batches.yml"), "utf8");

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cron ticks: nominal period, random phase, each sweep late by U[0,maxDelay]. */
function jitteredTicks(rand: () => number, period: number, maxDelay: number, count = 60): number[] {
  const phase = rand() * period;
  const ticks = Array.from({ length: count }, (_, i) => phase + i * period + rand() * maxDelay);
  return ticks.sort((a, b) => a - b);
}

/** First sweep at/after the forced-finalize instant (close at t = 0, worst case). */
function forcedFinalizeTick(ticks: number[], ingestMaxSeconds: number): number {
  const tick = ticks.find((t) => t >= ingestMaxSeconds);
  if (tick === undefined) throw new Error("not enough ticks");
  return tick;
}

describe("policy mirrors the SQL it depends on", () => {
  test("attempt budget, lease and backoff formula match the migration", () => {
    expect(migration).toMatch(/begin_slip_image_attempt\([\s\S]*?p_max_attempts\s+integer DEFAULT 5/);
    expect(migration).toMatch(/begin_slip_image_attempt\([\s\S]*?p_lease_seconds\s+integer DEFAULT 120/);
    expect(migration).toMatch(/fail_slip_image_event\([\s\S]*?p_max_attempts\s+integer DEFAULT 5/);
    expect(migration).toMatch(
      /v_delay := least\(15 \* power\(2, greatest\(v_ev\.attempts - 1, 0\)\)::integer, 300\)/,
    );
    expect(P.maxAttempts).toBe(5);
    expect(P.leaseSeconds).toBe(120);
    expect([1, 2, 3, 4].map((n) => backoffAfterAttemptSeconds(n))).toEqual([15, 30, 60, 120]);
    expect(backoffAfterAttemptSeconds(5)).toBe(240);
    expect(backoffAfterAttemptSeconds(9)).toBe(300);
  });

  test("the claim function's default ingest wait is not shorter than the policy requires", () => {
    const m = migration.match(/p_ingest_max_seconds\s+integer DEFAULT (\d+)/);
    expect(m).not.toBeNull();
    const sqlDefault = Number(m![1]);
    // The application always passes its own value, but a caller that omits it
    // (old app, psql) must not get a wait the attempts cannot fit into.
    expect(sqlDefault).toBeGreaterThanOrEqual(DEFAULT_INGEST_MAX_SECONDS);
  });

  test("the cron period assumed here is the one the real scheduler uses", () => {
    const schedule = workflow.match(/cron:\s*"([^"]+)"/);
    expect(schedule).not.toBeNull();
    const minutes = schedule![1].split(" ")[0].split(",").map(Number);
    const gaps = minutes.map((m, i) => (minutes[(i + 1) % minutes.length] - m + 60) % 60);
    expect(Math.max(...gaps) * 60).toBe(P.cron.periodSeconds);
    expect(JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")).crons).toEqual([]);
  });
});

test("cron route duration is statically analyzable and its caller allows that duration", () => {
  const route = readFileSync(join(ROOT, "src/app/api/cron/finalize-slip-batches/route.ts"), "utf8");
  const duration = route.match(/export const maxDuration = (\d+);/);
  expect(duration).not.toBeNull();
  expect(Number(duration![1])).toBe(P.functions.cronMaxDurationSeconds);
  const callerSeconds = Number(workflow.match(/--max-time\s+(\d+)/)?.[1]);
  expect(callerSeconds).toBeGreaterThanOrEqual(P.functions.cronMaxDurationSeconds);
});

describe("the old assumption was wrong: sweeps every 5 minutes, 600 s cutoff", () => {
  test("pure-cron with sweeps at 0/300/600 s starts only 3 of 5 attempts before the forced finalize", () => {
    const ticks = [0, 300, 600, 900, 1200, 1500, 1800];
    const sim = simulateIngestAttempts({ sweepTicksSeconds: ticks, inRequest: false });
    expect(sim.attempts.map((a) => a.startSeconds)).toEqual([0, 300, 600, 900, 1200]);
    expect(attemptsStartedBy(sim, forcedFinalizeTick(ticks, 600))).toBe(3);
    expect(sim.exhaustedAtSeconds).toBeGreaterThan(1200);
  });

  test("the old 600 s and 1200 s waits are reported insufficient; the derived default is sufficient", () => {
    expect(assessIngestPolicy(600).sufficient).toBe(false);
    expect(assessIngestPolicy(1200).sufficient).toBe(false);
    const ok = assessIngestPolicy(DEFAULT_INGEST_MAX_SECONDS);
    expect(ok.sufficient).toBe(true);
    expect(ok.requiredSeconds).toBe(DEFAULT_INGEST_MAX_SECONDS);
    expect(DEFAULT_INGEST_MAX_SECONDS).toBe(2160);
    // The guarantee is conditional and says so.
    expect(ok.assumptions).toEqual({
      cronPeriodSeconds: 300,
      maxSweepGapSeconds: 420,
      designBurstImages: 25,
      ingestCapacityPerSweep: 25,
      attemptWorstCaseSeconds: 20,
      inRequestRetries: false,
    });
  });
});

describe("policy: in-request retries + 5-minute cron", () => {
  test("a nominal run makes attempts 1-3 inside the request, 4-5 on sweeps", () => {
    const ticks = Array.from({ length: 20 }, (_, i) => 100 + i * 300);
    const sim = simulateIngestAttempts({ sweepTicksSeconds: ticks });
    expect(sim.attempts.map((a) => a.via)).toEqual(["request", "request", "request", "cron", "cron"]);
    // 15 s then 30 s backoff (+2 s per failing attempt), all inside the 52 s start budget
    expect(sim.attempts[1].startSeconds).toBeCloseTo(17.25, 2);
    expect(sim.attempts[2].startSeconds).toBeCloseTo(49.5, 2);
    expect(sim.attempts.slice(3).map((a) => a.startSeconds)).toEqual([400, 700]);
  });

  test("5000 random schedules (random phase, every sweep up to 120 s late): all 5 attempts run before the forced finalize", () => {
    const rand = mulberry32(0x5eed);
    let latest = 0;
    for (let i = 0; i < 5000; i++) {
      const ticks = jitteredTicks(rand, P.cron.periodSeconds, P.cron.assumedMaxDelaySeconds);
      const sim = simulateIngestAttempts({ sweepTicksSeconds: ticks });
      expect(sim.attempts).toHaveLength(P.maxAttempts);
      expect(sim.exhaustedAtSeconds).not.toBeNull();
      latest = Math.max(latest, sim.exhaustedAtSeconds!);
      expect(attemptsStartedBy(sim, forcedFinalizeTick(ticks, DEFAULT_INGEST_MAX_SECONDS))).toBe(P.maxAttempts);
      // Exhaustion never exceeds the closed-form worst case.
      expect(sim.exhaustedAtSeconds!).toBeLessThanOrEqual(worstCaseExhaustionSeconds() + 1e-6);
    }
    expect(latest).toBeLessThanOrEqual(DEFAULT_INGEST_MAX_SECONDS);
  });

  test("adversarial schedule: every sweep as late as the model allows still fits", () => {
    const g = P.cron.periodSeconds + P.cron.assumedMaxDelaySeconds;
    // Sweep always lands just AFTER the retry became due, a full gap ahead.
    const ticks = Array.from({ length: 40 }, (_, i) => 0.5 + (i + 1) * g);
    const sim = simulateIngestAttempts({ sweepTicksSeconds: ticks });
    expect(sim.attempts).toHaveLength(P.maxAttempts);
    expect(attemptsStartedBy(sim, forcedFinalizeTick(ticks, DEFAULT_INGEST_MAX_SECONDS))).toBe(P.maxAttempts);
    expect(worstCaseExhaustionSeconds()).toBeCloseTo(1075.5, 1);
    expect(requiredIngestMaxSeconds()).toBe(2160);
  });

  test("without any in-request retry (function died) the default still fits one image's 5 attempts", () => {
    const g = P.cron.periodSeconds + P.cron.assumedMaxDelaySeconds;
    const ticks = Array.from({ length: 40 }, (_, i) => 0.5 + (i + 1) * g);
    const sim = simulateIngestAttempts({ sweepTicksSeconds: ticks, inRequest: false });
    expect(attemptsStartedBy(sim, forcedFinalizeTick(ticks, DEFAULT_INGEST_MAX_SECONDS))).toBe(P.maxAttempts);
  });

  test("a scheduler that runs every minute (e.g. Supabase Cron) would need a much shorter wait", () => {
    const fast: SlipIngestPolicy = { ...P, cron: { ...P.cron, periodSeconds: 60, assumedMaxDelaySeconds: 30 } };
    expect(requiredIngestMaxSeconds(fast)).toBe(840);
    expect(assessIngestPolicy(840, fast).sufficient).toBe(true);
  });

  test("a 300 s webhook function would run all attempts in-request, independent of cron", () => {
    const long: SlipIngestPolicy = { ...P, inRequest: { ...P.inRequest, maxAttempts: 5, startBudgetSeconds: 280 } };
    const sim = simulateIngestAttempts({ policy: long, sweepTicksSeconds: [] });
    expect(sim.attempts.every((a) => a.via === "request")).toBe(true);
    expect(sim.exhaustedAtSeconds).toBeLessThan(240);
  });

  test("worst-case attempt latency is bounded by the I/O caps", () => {
    expect(attemptWorstCaseMs()).toBe(20_000);
    expect(cronRouteBudgetMs()).toBe(55_000);
    expect(cronRecoveryBudget()).toEqual({ hardCapMs: 40_000, softBudgetMs: 20_000, ocrJobMs: 30_000 });
    // One worst-case attempt / OCR job per lane fits the recovery phase.
    expect(cronIngestCapacityPerSweep()).toBe(25);
    expect(cronOcrCapacityPerSweep()).toBe(10);
    // The push cap + DB reserve fits the finalize window after recovery.
    expect(cronRouteBudgetMs() - cronRecoveryBudget().hardCapMs).toBeGreaterThanOrEqual(FINALIZE_BATCH_RESERVE_MS);
  });
});

// ── P1 #5: a whole burst retried by cron only ─────────────────────────────────
describe("cohort: 25-image burst, cron-only retries (no in-request), 4 failures before the 5th succeeds", () => {
  const W = attemptWorstCaseMs() / 1000;
  const allDoneBy = (sim: CohortSimulation, cutoff: number) =>
    sim.allResolvedAtSeconds !== null && sim.allResolvedAtSeconds <= cutoff;
  /** Sweeps up to and including the one that force-finalizes (recovery runs first in that sweep). */
  const untilForced = (ticks: number[], cutoff: number) => ticks.filter((t) => t <= forcedFinalizeTick(ticks, cutoff));

  test("regression: the old sweep (10 due, oldest first) with 300 s ticks leaves 15 images at attempt 1 and cuts them off at 1200 s", () => {
    const ticks = Array.from({ length: 20 }, (_, i) => (i + 1) * 300);
    const afterFirst = simulateCohortIngest({
      burst: 25, sweepTicksSeconds: ticks.slice(0, 1), capacityPerSweep: 10,
      failuresBeforeSuccess: 4, order: "oldest_received",
    });
    expect(afterFirst.images.filter((i) => i.attempts === 1)).toHaveLength(15);
    const old = simulateCohortIngest({
      burst: 25, sweepTicksSeconds: untilForced(ticks, 1200), capacityPerSweep: 10,
      failuresBeforeSuccess: 4, order: "oldest_received",
    });
    expect(old.images.filter((i) => i.attached).length).toBeLessThan(25);
  });

  test("fair list + lanes: every sweep advances the WHOLE burst by one attempt", () => {
    const ticks = Array.from({ length: 20 }, (_, i) => (i + 1) * 300);
    const sim = simulateCohortIngest({
      burst: 25, sweepTicksSeconds: ticks.slice(0, 1), failuresBeforeSuccess: 4, attemptSeconds: W,
    });
    expect(sim.images.every((i) => i.attempts === 2)).toBe(true);
  });

  test("5000 random 300 s schedules, each sweep up to 120 s late: all 25 attach before the forced finalize", () => {
    const rand = mulberry32(0xb425);
    let latest = 0;
    for (let i = 0; i < 5000; i++) {
      const ticks = jitteredTicks(rand, P.cron.periodSeconds, P.cron.assumedMaxDelaySeconds);
      const sim = simulateCohortIngest({
        burst: 25, sweepTicksSeconds: untilForced(ticks, DEFAULT_INGEST_MAX_SECONDS),
        failuresBeforeSuccess: 4, attemptSeconds: W,
      });
      expect(sim.images.every((img) => img.attached && img.attempts === 5)).toBe(true);
      latest = Math.max(latest, sim.allResolvedAtSeconds!);
    }
    expect(latest).toBeLessThanOrEqual(DEFAULT_INGEST_MAX_SECONDS);
  });

  test("adversarial: every sweep a full 420 s gap after the previous, images that never succeed still use all 5 attempts", () => {
    const g = maxSweepGapSeconds();
    const ticks = Array.from({ length: 40 }, (_, i) => (i + 1) * g);
    for (const failures of [4, Number.POSITIVE_INFINITY]) {
      const sim = simulateCohortIngest({
        burst: 25, sweepTicksSeconds: untilForced(ticks, DEFAULT_INGEST_MAX_SECONDS),
        failuresBeforeSuccess: failures, attemptSeconds: W,
      });
      expect(sim.images.every((img) => img.attempts === 5)).toBe(true);
      expect(allDoneBy(sim, DEFAULT_INGEST_MAX_SECONDS)).toBe(true);
    }
    // ...and the closed form bounds it.
    expect(worstCaseExhaustionSeconds(P, { inRequest: false, failedAttemptSeconds: W, burst: 25 }))
      .toBeLessThanOrEqual(DEFAULT_INGEST_MAX_SECONDS - P.ingestWaitMarginSeconds);
  });

  test("a burst larger than one sweep's capacity needs more sweeps per round and is reported insufficient", () => {
    const big: SlipIngestPolicy = { ...P, designBurstImages: 60 };
    expect(requiredIngestMaxSeconds(big)).toBeGreaterThan(DEFAULT_INGEST_MAX_SECONDS);
    expect(assessIngestPolicy(DEFAULT_INGEST_MAX_SECONDS, big).sufficient).toBe(false);
  });

  test("tolerance is documented, not assumed: exactly which skipped sweeps the wait absorbs", () => {
    const assessment = assessIngestPolicy(DEFAULT_INGEST_MAX_SECONDS);
    expect(assessment.toleratedSkippedSweeps).toBe(2);
    const nominal = (phase: number) => Array.from({ length: 40 }, (_, i) => phase + i * P.cron.periodSeconds);
    const exhaustedWhenSkipping = (skip: number, from: number, phase: number) => {
      const ticks = nominal(phase).filter((_, i) => i < from || i >= from + skip);
      const sim = simulateCohortIngest({
        burst: 25, sweepTicksSeconds: untilForced(ticks, DEFAULT_INGEST_MAX_SECONDS),
        failuresBeforeSuccess: Number.POSITIVE_INFINITY, attemptSeconds: W,
      });
      return sim.images.every((img) => img.attempts === P.maxAttempts);
    };
    for (const phase of [1, 60, 150, 299]) {
      for (let from = 0; from < 6; from++) {
        expect(exhaustedWhenSkipping(assessment.toleratedSkippedSweeps, from, phase)).toBe(true);
      }
    }
    // Beyond the bound the guarantee is gone, and it is reported, not hidden:
    // the batch is finalized with an explicit missing-images notice instead.
    // (The forced sweep itself runs recovery before the claim, hence the slack.)
    expect([0, 1, 2].some((from) => !exhaustedWhenSkipping(5, from, 299))).toBe(true);
  });

  test("degraded mode is reported, not covered: a sweep (not the receipt's worker) must run attempt 1", () => {
    const assessment = assessIngestPolicy(DEFAULT_INGEST_MAX_SECONDS);
    expect(assessment.requiredIfFirstAttemptByCronSeconds).toBe(2580);
    expect(assessment.requiredIfFirstAttemptByCronSeconds).toBeGreaterThan(DEFAULT_INGEST_MAX_SECONDS);
  });
});

// ── P1 #4: OCR wait for evidence whose OCR worker crashed ─────────────────────
describe("OCR wait (claim_closing_slip_batch gate)", () => {
  test("covers lease expiry + one job + one 420 s sweep per 10 attached images", () => {
    expect(requiredOcrWaitSeconds(1)).toBe(300 + 30 + 120 + 420);
    expect(requiredOcrWaitSeconds(25)).toBe(300 + 30 + 120 + 3 * 420);
  });

  test("SQL gate mirrors requiredOcrWaitSeconds and the OCR lease", () => {
    const m = migration.match(/make_interval\(secs => (\d+) \+ ceil\(v_ev_count::numeric \/ (\d+)\)::integer \* (\d+)\)/);
    expect(m).not.toBeNull();
    const [base, lanes, gap] = [Number(m![1]), Number(m![2]), Number(m![3])];
    for (const n of [1, 9, 10, 11, 25, 60]) {
      expect(base + Math.ceil(n / lanes) * gap).toBe(requiredOcrWaitSeconds(n));
    }
    expect(SLIP_CHECK_LEASE_SECONDS).toBe(P.ocr.leaseSeconds);
    expect(ocrMigration).toMatch(/claim_slip_check\([\s\S]*?p_lease_seconds integer DEFAULT 300/);
  });

  test("both recovery lists are fair, and the limits fit the SQL cap", () => {
    expect(migration).toMatch(/ORDER BY ev\.attempts, COALESCE\(ev\.next_retry_at, ev\.lease_until, ev\.received_at\)/);
    expect(ocrMigration).toMatch(/ORDER BY COALESCE\(sc\.claim_token, 0\), ev\.resolved_at/);
    expect(P.cron.ingestListLimit).toBeLessThanOrEqual(50);
    expect(P.cron.ocrListLimit).toBeLessThanOrEqual(50);
    // A design-size burst fits one list; lanes are the guaranteed floor.
    expect(P.cron.ingestListLimit).toBeGreaterThanOrEqual(P.designBurstImages);
    expect(P.cron.ocrListLimit).toBeGreaterThanOrEqual(P.designBurstImages);
  });
});

type Outcome = { outcome: string; attempt?: number };

describe("retryImageInRequest", () => {
  const sleeps: number[] = [];
  function clock(startMs: number) {
    let t = startMs;
    sleeps.length = 0;
    return {
      now: () => t,
      sleep: async (ms: number) => { sleeps.push(ms); t += ms; },
    };
  }

  test("waits out the ledger backoff and stops after the in-request allowance", async () => {
    const c = clock(1_000_000);
    let calls = 0;
    const out = await retryImageInRequest<Outcome>(
      { outcome: "retry_pending", attempt: 1 },
      async () => { calls += 1; return { outcome: "retry_pending", attempt: calls + 1 }; },
      { startedAtMs: 1_000_000, ...c },
    );
    expect(sleeps).toEqual([15_250, 30_250]);
    expect(out.retriesRun).toBe(2);
    expect(out.stopped).toBe("in_request_limit");
    expect(calls).toBe(2);
  });

  test("stops as soon as the image resolves", async () => {
    const c = clock(0);
    const out = await retryImageInRequest<Outcome>(
      { outcome: "retry_pending", attempt: 1 },
      async () => ({ outcome: "attached", attempt: 2 }),
      { startedAtMs: 0, ...c },
    );
    expect(out).toMatchObject({ retriesRun: 1, stopped: "resolved" });
    expect(sleeps).toEqual([15_250]);
  });

  test("does not sleep past the function budget: leaves the image to cron", async () => {
    const c = clock(40_000); // request already 40 s old; next retry would start at ~55 s > 52 s
    let calls = 0;
    const out = await retryImageInRequest<Outcome>(
      { outcome: "retry_pending", attempt: 1 },
      async () => { calls += 1; return { outcome: "attached" }; },
      { startedAtMs: 0, ...c },
    );
    expect(out).toMatchObject({ retriesRun: 0, stopped: "budget" });
    expect(calls).toBe(0);
    expect(sleeps).toEqual([]);
  });

  test("a concurrent worker owning the row ends the loop without a retry storm", async () => {
    const c = clock(0);
    const out = await retryImageInRequest<Outcome>(
      { outcome: "retry_pending", attempt: 1 },
      async () => ({ outcome: "not_claimed" }),
      { startedAtMs: 0, ...c },
    );
    expect(out).toMatchObject({ retriesRun: 1, stopped: "not_claimed" });
  });

  test("nothing to do for a first outcome that is not retry_pending", async () => {
    const out = await retryImageInRequest<Outcome>(
      { outcome: "attached" },
      async () => { throw new Error("must not run"); },
      { startedAtMs: 0, ...clock(0) },
    );
    expect(out).toMatchObject({ retriesRun: 0, stopped: "resolved" });
  });
});

describe("runBounded", () => {
  test("returns at the hard cap even if the work never settles", async () => {
    const started = performance.now();
    const out = await runBounded(120, () => new Promise<never>(() => {}));
    const elapsed = performance.now() - started;
    expect(out).toEqual({ timedOut: true });
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(400);
  });

  test("passes the value through when the work finishes first", async () => {
    expect(await runBounded(500, async () => 42)).toEqual({ timedOut: false, value: 42 });
  });

  test("a late rejection after the cap is not an unhandled rejection", async () => {
    const out = await runBounded(20, () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error("late")), 60)));
    expect(out).toEqual({ timedOut: true });
    await new Promise((r) => setTimeout(r, 100)); // would crash the runner if unhandled
  });
});
