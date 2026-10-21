/**
 * Single source of truth for slip image ingest timing: retry budget, backoff,
 * the cadence the retries can really rely on, I/O time bounds and the wait the
 * closing-batch claim must allow so every retry can run before a batch is
 * finalized with images still missing.
 *
 * WHY THIS EXISTS (PR #182 cross-check, P1 #5/#8)
 * The real scheduler is the GitHub Actions workflow finalize-slip-batches.yml,
 * `2,7,12,...,57 * * * *` = every 5 minutes, and GitHub documents that scheduled
 * runs may be delayed or dropped under load. vercel.json crons is empty. An
 * earlier draft assumed a sweep every minute. With sweeps at 0/300/600 s only 3
 * of the 5 attempts fit before a 600 s forced finalize. So:
 *
 *   1. The NORMAL path does not depend on cron cadence: when an attempt fails,
 *      the webhook's after() task retries the same image in-request, waiting
 *      out the ledger backoff (retryImageInRequest), as long as the function
 *      can still live.
 *   2. Cron is the safety net. It makes ONE attempt per due image per sweep.
 *   3. The finalizer's ingest wait is DERIVED from this policy
 *      (requiredIngestMaxSeconds) instead of being a hand-picked number, and
 *      the cron route reports whether the configured value is sufficient.
 *
 * Mirror constraint: backoff and max attempts are enforced in SQL
 * (fail_slip_image_event / begin_slip_image_attempt). ingest-policy.test.ts
 * parses the migration and fails if this file and the SQL drift apart.
 */

export interface SlipIngestPolicy {
  /** Attempt budget per image (SQL: p_max_attempts DEFAULT 5). */
  maxAttempts: number;
  /** Ledger lease per attempt (SQL: p_lease_seconds DEFAULT 120). */
  leaseSeconds: number;
  /** Delay after failing attempt n = min(base * 2^(n-1), cap) (SQL fail_slip_image_event). */
  backoffBaseSeconds: number;
  backoffCapSeconds: number;
  inRequest: {
    /** Attempts made inside the webhook's after() task, including the first. */
    maxAttempts: number;
    /**
     * A retry is only slept for and started while it would begin within this
     * many seconds of the request start. Webhook maxDuration is 60 s; the rest
     * is the cap on one attempt (io timeouts) and teardown headroom. If the
     * platform kills the function anyway, the attempt lease expires and the
     * ledger fences the orphan: cron picks the image up.
     */
    startBudgetSeconds: number;
    /** Extra wait beyond the SQL next_retry_at so the retry is really due. */
    dueSlackMs: number;
  };
  cron: {
    /** GitHub Actions schedule period. */
    periodSeconds: number;
    /** Tolerated lateness of any single sweep. Beyond this the bound is void. */
    assumedMaxDelaySeconds: number;
    /** recoverDue() processes each due image once per sweep. */
    attemptsPerImagePerSweep: 1;
    /**
     * Due images fetched per sweep (SQL list order: fewest attempts first).
     * Lanes keep taking items while a worst-case attempt still fits, so fast
     * attempts drain more than `ingestLanes` per sweep; slow ones at least that.
     */
    ingestListLimit: number;
    /** Image attempts run concurrently per sweep (each bounded by attemptWorstCaseMs). */
    ingestLanes: number;
    /** OCR evidence fetched per sweep (SQL order: least-claimed first). */
    ocrListLimit: number;
    /** OCR redrive jobs run concurrently per sweep (each bounded by ocrJobTimeoutMs). */
    ocrLanes: number;
  };
  /**
   * Largest burst of images in ONE batch the ingest cutoff is sized for. A
   * bigger burst still never completes falsely (incomplete notice), but its
   * retries are no longer guaranteed to fit before the cutoff.
   */
  designBurstImages: number;
  ocr: {
    /** slip_checks claim lease (SLIP_CHECK_LEASE_SECONDS / claim_slip_check). */
    leaseSeconds: number;
  };
  io: {
    lineDownloadTimeoutMs: number;
    storageUploadTimeoutMs: number;
    /** Ledger/evidence/raw-message DB round trips around one attempt. */
    dbSlackMs: number;
    /** One OpenAI HTTP call (headers + body). */
    ocrCallTimeoutMs: number;
    /** Hard cap for one whole OCR job in the redrive (all retries/fallback). */
    ocrJobTimeoutMs: number;
  };
  functions: {
    cronMaxDurationSeconds: number;
    /** Kept free at the end of the function for the response itself. */
    cronTeardownSeconds: number;
    /** Time kept for the finalizer (claims, summaries, LINE push) after recovery. */
    cronFinalizeReserveSeconds: number;
    /** One LINE push (summary) in the cron route. */
    linePushTimeoutMs: number;
    /** One Supabase HTTP call (PostgREST / Storage) in the cron route. */
    dbCallTimeoutMs: number;
  };
  /** Safety margin added on top of the computed worst case. */
  ingestWaitMarginSeconds: number;
  /** Duration of a typical FAILING attempt (an HTTP 5xx, not a timeout). */
  typicalFailedAttemptSeconds: number;
}

export const SLIP_INGEST_POLICY: SlipIngestPolicy = {
  maxAttempts: 5,
  leaseSeconds: 120,
  backoffBaseSeconds: 15,
  backoffCapSeconds: 300,
  inRequest: {
    maxAttempts: 3,
    startBudgetSeconds: 52,
    dueSlackMs: 250,
  },
  cron: {
    periodSeconds: 300,
    assumedMaxDelaySeconds: 120,
    attemptsPerImagePerSweep: 1,
    ingestListLimit: 50,
    ingestLanes: 25,
    ocrListLimit: 50,
    ocrLanes: 10,
  },
  designBurstImages: 25,
  ocr: {
    leaseSeconds: 300,
  },
  io: {
    lineDownloadTimeoutMs: 8_000,
    storageUploadTimeoutMs: 8_000,
    dbSlackMs: 4_000,
    ocrCallTimeoutMs: 15_000,
    ocrJobTimeoutMs: 30_000,
  },
  functions: {
    cronMaxDurationSeconds: 60,
    cronTeardownSeconds: 5,
    cronFinalizeReserveSeconds: 15,
    linePushTimeoutMs: 8_000,
    dbCallTimeoutMs: 8_000,
  },
  ingestWaitMarginSeconds: 120,
  typicalFailedAttemptSeconds: 2,
};

// ── Derived numbers ───────────────────────────────────────────────────────────

/** Seconds the ledger waits after failing attempt n (1-based). Mirrors SQL. */
export function backoffAfterAttemptSeconds(
  failedAttempt: number,
  policy: SlipIngestPolicy = SLIP_INGEST_POLICY,
): number {
  const n = Math.max(1, Math.floor(failedAttempt));
  return Math.min(policy.backoffBaseSeconds * 2 ** (n - 1), policy.backoffCapSeconds);
}

/** Worst wall-clock of ONE ingest attempt given the I/O caps (ms). */
export function attemptWorstCaseMs(policy: SlipIngestPolicy = SLIP_INGEST_POLICY): number {
  return policy.io.lineDownloadTimeoutMs + policy.io.storageUploadTimeoutMs + policy.io.dbSlackMs;
}

/** Longest gap between two consecutive cron sweeps that still honours the model. */
export function maxSweepGapSeconds(policy: SlipIngestPolicy = SLIP_INGEST_POLICY): number {
  return policy.cron.periodSeconds + policy.cron.assumedMaxDelaySeconds;
}

export interface CronRecoveryBudget {
  /** The route's recovery phase is cut off here no matter what is hanging. */
  hardCapMs: number;
  /** Do not START another unit of work after this (leaves room for one unit). */
  softBudgetMs: number;
  /** Do not start an OCR job unless at least this much of the hard cap remains. */
  ocrJobMs: number;
}

/** End-to-end budget of one cron GET: everything (recovery, finalizers, metrics) ends by here. */
export function cronRouteBudgetMs(policy: SlipIngestPolicy = SLIP_INGEST_POLICY): number {
  return (policy.functions.cronMaxDurationSeconds - policy.functions.cronTeardownSeconds) * 1000;
}

export function cronRecoveryBudget(policy: SlipIngestPolicy = SLIP_INGEST_POLICY): CronRecoveryBudget {
  const hardCapMs = Math.max(
    5_000,
    cronRouteBudgetMs(policy) - policy.functions.cronFinalizeReserveSeconds * 1000,
  );
  return {
    hardCapMs,
    softBudgetMs: Math.max(1_000, hardCapMs - attemptWorstCaseMs(policy)),
    ocrJobMs: policy.io.ocrJobTimeoutMs,
  };
}

/**
 * Image attempts one sweep is GUARANTEED to start, even if every attempt runs
 * to its worst case: each lane starts one attempt at the beginning of the
 * phase (a second start needs a full worst case left, which list/DB overhead
 * can deny), and a lane never starts work that cannot finish in the phase.
 */
export function cronIngestCapacityPerSweep(policy: SlipIngestPolicy = SLIP_INGEST_POLICY): number {
  if (cronRecoveryBudget(policy).hardCapMs < attemptWorstCaseMs(policy)) return 0;
  return Math.min(policy.cron.ingestLanes, policy.cron.ingestListLimit);
}

/** OCR redrive jobs one sweep is guaranteed to run (one per lane, see above). */
export function cronOcrCapacityPerSweep(policy: SlipIngestPolicy = SLIP_INGEST_POLICY): number {
  return cronRecoveryBudget(policy).hardCapMs >= policy.io.ocrJobTimeoutMs ? policy.cron.ocrLanes : 0;
}

/**
 * How long a closing batch with `evidenceCount` attached images may wait for
 * OCR checks that are missing or still PROCESSING (e.g. the background OCR
 * worker crashed) before it is finalized anyway. Counted from the later of
 * the close and the last attach. Covers: the crashed claim's lease expiring,
 * one job's run time, then enough sweeps (each up to period + max delay
 * apart) for the redrive lanes to reach every image once, plus margin.
 * Mirrored in claim_closing_slip_batch (ingest-policy.test.ts checks it).
 */
export function requiredOcrWaitSeconds(
  evidenceCount: number,
  policy: SlipIngestPolicy = SLIP_INGEST_POLICY,
): number {
  const rounds = Math.ceil(Math.max(1, evidenceCount) / Math.max(1, cronOcrCapacityPerSweep(policy)));
  return policy.ocr.leaseSeconds
    + policy.io.ocrJobTimeoutMs / 1000
    + policy.ingestWaitMarginSeconds
    + rounds * maxSweepGapSeconds(policy);
}

// ── Simulation ────────────────────────────────────────────────────────────────

export interface SimulatedAttempt {
  attempt: number;
  startSeconds: number;
  via: "request" | "cron";
}

export interface IngestSimulation {
  attempts: SimulatedAttempt[];
  /** When the last attempt failed -> failed_permanent. null if budget not exhausted within the ticks. */
  exhaustedAtSeconds: number | null;
}

export interface SimulationOptions {
  policy?: SlipIngestPolicy;
  /** Cron sweep instants, seconds since the first attempt (ascending). */
  sweepTicksSeconds: number[];
  /** How long each FAILING attempt takes. */
  failedAttemptSeconds?: number;
  /** Disable the in-request retries (webhook function died / not deployed). */
  inRequest?: boolean;
}

/**
 * Pure model of one image whose every attempt fails. Attempt 1 is the queue
 * worker at t=0. After a failure the ledger sets next_retry_at = failure time +
 * backoff. The retry runs in-request while the webhook function can still
 * live; afterwards only a cron sweep can run it, and a sweep makes ONE attempt
 * per image, so consecutive cron attempts need distinct sweeps.
 */
export function simulateIngestAttempts(options: SimulationOptions): IngestSimulation {
  const policy = options.policy ?? SLIP_INGEST_POLICY;
  const fail = options.failedAttemptSeconds ?? policy.typicalFailedAttemptSeconds;
  const inRequestEnabled = options.inRequest ?? true;
  const ticks = options.sweepTicksSeconds;

  const attempts: SimulatedAttempt[] = [];
  let start = 0;
  let via: SimulatedAttempt["via"] = "request";
  let lastTickIdx = -1;

  for (let n = 1; n <= policy.maxAttempts; n++) {
    attempts.push({ attempt: n, startSeconds: start, via });
    const failedAt = start + fail;
    if (n === policy.maxAttempts) return { attempts, exhaustedAtSeconds: failedAt };

    const due = failedAt + backoffAfterAttemptSeconds(n, policy);
    if (
      via === "request"
      && inRequestEnabled
      && n < policy.inRequest.maxAttempts
      && due <= policy.inRequest.startBudgetSeconds
    ) {
      start = due + policy.inRequest.dueSlackMs / 1000;
      continue;
    }
    via = "cron";
    let idx = lastTickIdx + 1;
    while (idx < ticks.length && ticks[idx] < due) idx++;
    if (idx >= ticks.length) return { attempts, exhaustedAtSeconds: null };
    lastTickIdx = idx;
    start = ticks[idx];
  }
  return { attempts, exhaustedAtSeconds: null };
}

/** Number of attempts that STARTED at or before `seconds`. */
export function attemptsStartedBy(sim: IngestSimulation, seconds: number): number {
  return sim.attempts.filter((a) => a.startSeconds <= seconds).length;
}

export interface ExhaustionOptions {
  failedAttemptSeconds?: number;
  inRequest?: boolean;
  gapSeconds?: number;
  /** Images of one batch retrying at the same time (they share sweep capacity). */
  burst?: number;
  /** The receipt's own worker never ran attempt 1; a sweep has to. */
  firstAttemptByCron?: boolean;
}

/**
 * Worst-case time (since the first receipt) at which the attempt budget of a
 * whole burst is exhausted, assuming every sweep can be as late as the model
 * allows (period + max delay between consecutive sweeps) and every attempt
 * fails after `failedAttemptSeconds`. A burst larger than one sweep's
 * guaranteed capacity needs ceil(burst / capacity) sweeps per attempt round
 * (the due list is fair: fewest attempts first). Closed form of the
 * simulation's worst case.
 */
export function worstCaseExhaustionSeconds(
  policy: SlipIngestPolicy = SLIP_INGEST_POLICY,
  opts: ExhaustionOptions = {},
): number {
  const fail = opts.failedAttemptSeconds ?? policy.typicalFailedAttemptSeconds;
  const inRequestEnabled = opts.inRequest ?? true;
  const gap = opts.gapSeconds ?? maxSweepGapSeconds(policy);
  const sweepsPerRound = Math.ceil(
    Math.max(1, opts.burst ?? 1) / Math.max(1, cronIngestCapacityPerSweep(policy)),
  );

  let start = opts.firstAttemptByCron ? gap * sweepsPerRound : 0;
  let via: "request" | "cron" = opts.firstAttemptByCron ? "cron" : "request";
  for (let n = 1; n < policy.maxAttempts; n++) {
    const due = start + fail + backoffAfterAttemptSeconds(n, policy);
    if (
      via === "request"
      && inRequestEnabled
      && n < policy.inRequest.maxAttempts
      && due <= policy.inRequest.startBudgetSeconds
    ) {
      start = due + policy.inRequest.dueSlackMs / 1000;
    } else {
      via = "cron";
      start = due + gap * sweepsPerRound;
    }
  }
  return start + fail;
}

/**
 * Seconds a closing batch must be allowed to wait for in-flight images so that
 * every image of a design-size burst can use its whole attempt budget WITHOUT
 * any in-request retry (the webhook's after() task may be killed), with every
 * attempt running to its I/O worst case: worst-case exhaustion plus margin,
 * rounded up to a whole minute. SLIP_CLOSE_INGEST_MAX_SECONDS defaults to it.
 * The cutoff is cohort-wide: claim_closing_slip_batch counts it from the later
 * of the close and the batch's last image receipt.
 */
export function requiredIngestMaxSeconds(
  policy: SlipIngestPolicy = SLIP_INGEST_POLICY,
  opts: ExhaustionOptions = {},
): number {
  const raw = worstCaseExhaustionSeconds(policy, {
    inRequest: false,
    failedAttemptSeconds: attemptWorstCaseMs(policy) / 1000,
    burst: policy.designBurstImages,
    ...opts,
  }) + policy.ingestWaitMarginSeconds;
  return Math.ceil(raw / 60) * 60;
}

export const DEFAULT_INGEST_MAX_SECONDS = requiredIngestMaxSeconds();

export interface IngestPolicyAssessment {
  ingestMaxSeconds: number;
  requiredSeconds: number;
  /**
   * True only UNDER the stated assumptions. It is not a guarantee about the
   * real scheduler: a sweep later than maxSweepGapSeconds, more skipped
   * sweeps than toleratedSkippedSweeps, a burst above designBurstImages or a
   * receipt whose own worker died can still cut retries off. Then the batch
   * is finalized with an explicit incomplete notice, never as complete.
   */
  sufficient: boolean;
  /** Required wait if a sweep (not the receipt's worker) must run attempt 1. NOT covered by default. */
  requiredIfFirstAttemptByCronSeconds: number;
  /** How many consecutive missed/skipped sweeps the configured wait still absorbs. */
  toleratedSkippedSweeps: number;
  assumptions: {
    cronPeriodSeconds: number;
    maxSweepGapSeconds: number;
    designBurstImages: number;
    ingestCapacityPerSweep: number;
    attemptWorstCaseSeconds: number;
    inRequestRetries: false;
  };
}

/** Is the configured finalize wait long enough for the actual retry policy? */
export function assessIngestPolicy(
  ingestMaxSeconds: number,
  policy: SlipIngestPolicy = SLIP_INGEST_POLICY,
): IngestPolicyAssessment {
  // Skipped sweeps are counted against the nominal cadence (no lateness): how
  // many whole periods of slack remain between on-time sweeps and the wait.
  const nominal = worstCaseExhaustionSeconds(policy, {
    inRequest: false,
    failedAttemptSeconds: attemptWorstCaseMs(policy) / 1000,
    burst: policy.designBurstImages,
    gapSeconds: policy.cron.periodSeconds,
  });
  const requiredSeconds = requiredIngestMaxSeconds(policy);
  return {
    ingestMaxSeconds,
    requiredSeconds,
    sufficient: ingestMaxSeconds >= requiredSeconds,
    requiredIfFirstAttemptByCronSeconds: requiredIngestMaxSeconds(policy, { firstAttemptByCron: true }),
    toleratedSkippedSweeps: Math.max(
      0,
      Math.floor((ingestMaxSeconds - nominal) / policy.cron.periodSeconds),
    ),
    assumptions: {
      cronPeriodSeconds: policy.cron.periodSeconds,
      maxSweepGapSeconds: maxSweepGapSeconds(policy),
      designBurstImages: policy.designBurstImages,
      ingestCapacityPerSweep: cronIngestCapacityPerSweep(policy),
      attemptWorstCaseSeconds: attemptWorstCaseMs(policy) / 1000,
      inRequestRetries: false,
    },
  };
}

// ── Cohort simulation (a whole burst sharing the sweeps) ─────────────────────

export interface CohortSimulationOptions {
  policy?: SlipIngestPolicy;
  burst: number;
  /** Cron sweep instants, seconds since the receipts (ascending). */
  sweepTicksSeconds: number[];
  /** Image attempts one sweep can run (defaults to the guaranteed capacity). */
  capacityPerSweep?: number;
  /** Failures before the attempt that succeeds; Infinity = never succeeds. */
  failuresBeforeSuccess: number;
  attemptSeconds?: number;
  /** Sweep pick order. "fair" = SQL list order (fewest attempts, then oldest due). */
  order?: "fair" | "oldest_received";
  firstAttemptByCron?: boolean;
}

export interface CohortSimulation {
  /** Per image: attempts made and when it resolved (attached / failed_permanent), null = still in flight. */
  images: Array<{ attempts: number; resolvedAtSeconds: number | null; attached: boolean }>;
  /** When the last image resolved; null if some image is still in flight after the last tick. */
  allResolvedAtSeconds: number | null;
}

/**
 * Pure model of a burst of images retried ONLY by cron sweeps (no in-request
 * retries). Each sweep lists the due images in `order`, runs at most
 * `capacityPerSweep` of them, one attempt per image per sweep, then the ledger
 * backoff applies. Attempt 1 is the receipt's worker at t = 0 unless
 * firstAttemptByCron.
 */
export function simulateCohortIngest(options: CohortSimulationOptions): CohortSimulation {
  const policy = options.policy ?? SLIP_INGEST_POLICY;
  const capacity = options.capacityPerSweep ?? cronIngestCapacityPerSweep(policy);
  const dur = options.attemptSeconds ?? policy.typicalFailedAttemptSeconds;
  const order = options.order ?? "fair";
  const images = Array.from({ length: options.burst }, (_, i) => ({
    i, attempts: 0, due: 0, resolvedAtSeconds: null as number | null, attached: false,
  }));

  const attempt = (img: (typeof images)[number], at: number) => {
    img.attempts += 1;
    if (img.attempts > options.failuresBeforeSuccess) {
      img.resolvedAtSeconds = at + dur;
      img.attached = true;
    } else if (img.attempts >= policy.maxAttempts) {
      img.resolvedAtSeconds = at + dur;
    } else {
      img.due = at + dur + backoffAfterAttemptSeconds(img.attempts, policy);
    }
  };

  if (!options.firstAttemptByCron) for (const img of images) attempt(img, 0);
  for (const tick of options.sweepTicksSeconds) {
    const due = images.filter((img) => img.resolvedAtSeconds === null && img.due <= tick);
    due.sort(order === "fair"
      ? (a, b) => a.attempts - b.attempts || a.due - b.due || a.i - b.i
      : (a, b) => a.i - b.i);
    for (const img of due.slice(0, capacity)) attempt(img, tick);
  }
  const open = images.some((img) => img.resolvedAtSeconds === null);
  return {
    images: images.map(({ attempts, resolvedAtSeconds, attached }) => ({ attempts, resolvedAtSeconds, attached })),
    allResolvedAtSeconds: open ? null : Math.max(...images.map((img) => img.resolvedAtSeconds!)),
  };
}

// ── In-request retry (called from the webhook's after() task) ────────────────

export interface InRequestRetryResult<R> {
  result: R;
  /** Attempts executed by this helper (not counting the one that produced `first`). */
  retriesRun: number;
  stopped:
    | "resolved"          // the image reached a non-retry outcome
    | "in_request_limit"  // used the in-request attempt allowance
    | "budget"            // the next retry would start after the function budget
    | "not_claimed";      // another worker owns it / not due: leave it to them
}

/**
 * Continue the retries of ONE image inside the request that handled it.
 *
 * `first` is the outcome of the attempt that already ran (attempt 1). While it
 * is `retry_pending` and the next retry still starts within the function
 * budget, wait out the ledger backoff and call `processAgain` (which is the
 * normal ledger-claiming ingest of that same LINE message id: begin -> fence).
 * Nothing here bypasses the ledger, so a concurrent cron attempt simply gets
 * `not_claimed`/`leased`. Run it as its own scheduleBackgroundTask so the
 * ordered queue drain for the source is never blocked by the sleeping.
 */
export async function retryImageInRequest<R extends { outcome: string; attempt?: number }>(
  first: R,
  processAgain: () => Promise<R>,
  options: {
    startedAtMs: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    policy?: SlipIngestPolicy;
  },
): Promise<InRequestRetryResult<R>> {
  const policy = options.policy ?? SLIP_INGEST_POLICY;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let result = first;
  let retriesRun = 0;
  let attemptNo = first.attempt ?? 1;

  while (true) {
    if (result.outcome !== "retry_pending") {
      return { result, retriesRun, stopped: result.outcome === "not_claimed" ? "not_claimed" : "resolved" };
    }
    if (attemptNo >= policy.inRequest.maxAttempts) {
      return { result, retriesRun, stopped: "in_request_limit" };
    }
    const waitMs = backoffAfterAttemptSeconds(attemptNo, policy) * 1000 + policy.inRequest.dueSlackMs;
    const startsAtMs = now() + waitMs;
    if (startsAtMs - options.startedAtMs > policy.inRequest.startBudgetSeconds * 1000) {
      return { result, retriesRun, stopped: "budget" };
    }
    await sleep(waitMs);
    result = await processAgain();
    retriesRun += 1;
    attemptNo = result.attempt ?? attemptNo + 1;
  }
}

// ── Bounded recovery (cron route) ────────────────────────────────────────────

/**
 * Run `work` but never wait for it longer than `hardCapMs`. The caller carries
 * on (to finalization) either way; abandoned work is safe because every
 * durable effect of recovery is leased/fenced in the ledger.
 */
export async function runBounded<T>(
  hardCapMs: number,
  work: () => Promise<T>,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), hardCapMs);
  });
  try {
    return await Promise.race([work().then((value) => ({ timedOut: false as const, value })), cap]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
