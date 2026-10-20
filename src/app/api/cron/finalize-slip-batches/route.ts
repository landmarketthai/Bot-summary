import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { WebhookService } from "@/lib/line/webhook-service";
import { LinePushError, pushLineMessage } from "@/lib/line/reply";
import {
  finalizeDueSlipBatches,
  finalizeClosingSlipBatches,
  recoverStaleProcessingSlipBatches,
  loadSlipBatchHealth,
  parseAbandonedMinutes,
  parseCloseSeconds,
  CLOSE_INGEST_MAX_SECONDS,
} from "@/lib/slips/batch-finalizer";
import {
  SLIP_INGEST_POLICY,
  assessIngestPolicy,
  cronRecoveryBudget,
  cronRouteBudgetMs,
  runBounded,
} from "@/lib/slips/ingest-policy";
import { deadlineFetch, withTimeout } from "@/lib/slips/io-timeout";
import { checkCronAuth } from "./auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Recovery (hard-capped) + finalization must fit; see cronRouteBudgetMs().
export const maxDuration = 60;

/**
 * ONE end-to-end deadline per request (maxDuration minus teardown). Two phases,
 * each with its own Supabase client whose fetch is aborted at the phase end:
 *
 *   recovery  [start, start + cronRecoveryBudget().hardCapMs)
 *   finalize  [recovery end, start + cronRouteBudgetMs())
 *
 * Nothing runs detached: background tasks scheduled during recovery (e.g. OCR
 * for an image the sweep just attached) are awaited inside the recovery phase,
 * not handed to after(); settlement after a summary is awaited with the
 * bounded push; every LINE push is cut at min(push cap, deadline). A phase's
 * DB/Storage calls cannot outlive it because its client aborts them, so the
 * finalizers never overlap recovery writes and nothing writes after the
 * response. Cut-off work is safe: ingest/OCR effects are fenced in SQL, and a
 * push cut mid-flight leaves the batch in processing; the stale sweep retries
 * it with the same X-Line-Retry-Key, so LINE never shows a duplicate.
 */
export async function GET(req: NextRequest) {
  const startedAtMs = Date.now();
  const routeDeadlineMs = startedAtMs + cronRouteBudgetMs();
  const secret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  const xCronSecretHeader = req.headers.get("x-cron-secret");
  const auth = checkCronAuth(secret, authHeader, xCronSecretHeader);

  logger.info("finalize-slip-batches cron auth check", {
    secretConfigured: auth.secretConfigured,
    authHeaderPresent: auth.authHeaderPresent,
    headerTypeUsed: auth.headerTypeUsed,
  });

  if (!auth.secretConfigured) {
    logger.error("finalize-slip-batches cron rejected - CRON_SECRET is missing");
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 500 });
  }

  if (!auth.authorized) {
    logger.warn("finalize-slip-batches cron rejected - invalid authorization");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dbCallMs = SLIP_INGEST_POLICY.functions.dbCallTimeoutMs;
  const recoveryDeadlineMs = startedAtMs + cronRecoveryBudget().hardCapMs;
  const recoverySupabase = createServiceClient({ fetch: deadlineFetch(recoveryDeadlineMs, dbCallMs) });
  const supabase = createServiceClient({ fetch: deadlineFetch(routeDeadlineMs, dbCallMs) });

  // Ingest recovery runs BEFORE finalization: retry due images, drain queue
  // events that never started, re-drive stalled OCR. A failure here must not
  // block finalization (which is itself bounded by the ingest wait limit).
  const background = new Set<Promise<void>>();
  const ingestService = new WebhookService(recoverySupabase, {
    scheduleBackgroundTask: (task) => {
      const run: Promise<void> = task()
        .catch((error) => {
          logger.error("finalize-slip-batches: recovery background task failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => background.delete(run));
      background.add(run);
    },
  });
  let imageRecovery: Awaited<ReturnType<WebhookService["recoverSlipIngest"]>> | null = null;
  let imageRecoveryTimedOut = false;
  try {
    // Backstop only: every recovery I/O is already aborted at the phase end.
    const bounded = await runBounded(Math.max(0, recoveryDeadlineMs - Date.now()), async () => {
      const summary = await ingestService.recoverSlipIngest({ budgetMs: recoveryDeadlineMs - Date.now() });
      while (background.size > 0) await Promise.allSettled([...background]);
      return summary;
    });
    if (bounded.timedOut) {
      imageRecoveryTimedOut = true;
      logger.error("finalize-slip-batches: image ingest recovery hit the phase deadline - continuing to finalization", {
        recoveryBudgetMs: recoveryDeadlineMs - startedAtMs,
        backgroundTasksCut: background.size,
      });
    } else {
      imageRecovery = bounded.value;
    }
  } catch (error) {
    logger.error("finalize-slip-batches: image ingest recovery failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Every LINE push (summaries, settlement) is cut at the route deadline.
  const push = async (to: string, text: string, retryKey?: string): Promise<void> => {
    const remainingMs = Math.min(SLIP_INGEST_POLICY.functions.linePushTimeoutMs, routeDeadlineMs - Date.now());
    if (remainingMs <= 0) throw new LinePushError("LINE push not started: cron deadline reached", null, true);
    await withTimeout("line_push", remainingMs, (signal) => pushLineMessage(to, text, retryKey, { signal }));
  };

  const [abandonedCount, closedCount] = await Promise.all([
    finalizeDueSlipBatches(supabase, push, undefined, routeDeadlineMs),
    finalizeClosingSlipBatches(supabase, push, undefined, undefined, undefined, undefined, undefined, routeDeadlineMs),
  ]);
  // Run recovery only after normal claims finish; the two-minute stale guard
  // keeps freshly claimed work out of this sweep.
  const processingRecovery = await recoverStaleProcessingSlipBatches(
    supabase, push, undefined, undefined, undefined, routeDeadlineMs,
  );
  // Post-sweep backlog: what is still stuck after this run (internal only).
  const health = await loadSlipBatchHealth(supabase);
  const { data: ledgerHealth, error: ledgerError } = await supabase.rpc("slip_image_ledger_health");
  const imageLedger = (ledgerError ? null : ledgerHealth) as Record<string, number | null> | null;

  // Observable deployment gate: ONLY a missing function means the ledger RPCs
  // are not deployed (migration 20261017100000 missing) - images are on the
  // legacy path and the finalizer cannot account for them. Any other error
  // (e.g. the deadline aborted the read) is reported as unknown, not missing.
  const ledgerDeployed = !(ledgerError && (ledgerError.code === "42883" || ledgerError.code === "PGRST202"));
  if (!ledgerDeployed) {
    logger.error("finalize-slip-batches: slip image ledger is NOT deployed - apply migration 20261017100000", {
      code: "slip_ledger_schema_missing",
    });
  }
  // The finalize wait must be long enough for the retry policy actually in
  // force (5-minute GitHub Actions cadence), or retries get cut off silently.
  const ingestPolicy = assessIngestPolicy(CLOSE_INGEST_MAX_SECONDS);
  if (!ingestPolicy.sufficient) {
    logger.error("finalize-slip-batches: SLIP_CLOSE_INGEST_MAX_SECONDS is shorter than the retry policy needs", {
      ...ingestPolicy,
    });
  }

  const abandonedMinutes  = parseAbandonedMinutes(process.env.SLIP_ABANDONED_SESSION_MINUTES);
  const closeQuietSeconds = parseCloseSeconds(process.env.SLIP_CLOSE_QUIET_SECONDS, 10);
  const closeMaxSeconds   = parseCloseSeconds(process.env.SLIP_CLOSE_MAX_SECONDS, 120);
  const elapsedMs = Date.now() - startedAtMs;

  logger.info("finalize-slip-batches completed", {
    abandonedCount,
    closedCount,
    processingRecovery,
    health,
    imageRecovery,
    imageRecoveryTimedOut,
    imageLedger,
    ledgerDeployed,
    ledgerHealthError: ledgerError?.code ?? null,
    ingestPolicy,
    abandonedMinutes,
    closeQuietSeconds,
    closeMaxSeconds,
    elapsedMs,
  });
  return NextResponse.json({
    ok: true,
    abandonedCount,
    closedCount,
    processingRecovery,
    health,
    imageRecovery,
    imageRecoveryTimedOut,
    imageLedger,
    ledgerDeployed,
    ingestPolicy,
    finalizedCount: abandonedCount + closedCount + processingRecovery.recovered,
    abandonedSessionMinutes: abandonedMinutes,
    closeQuietSeconds,
    closeMaxSeconds,
    elapsedMs,
    deadlineReached: Date.now() >= routeDeadlineMs,
    triggeredAt: new Date().toISOString(),
  });
}
