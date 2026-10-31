import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { logger } from "@/lib/logger";
import { createServiceClient } from "@/lib/supabase/server";
import { deadlineFetch } from "@/lib/slips/io-timeout";
import { isBotSummaryAnalystEnabled, isBotSummaryAnalystSourceAllowed } from "@/lib/ai/line-command";
import { createAssistantDispatcher } from "@/lib/ai/assistant/dispatch";
import { SupabaseAssistantJobStore } from "@/lib/ai/assistant/job-store";
import { recoverUnenqueuedQuestions } from "@/lib/ai/assistant/recovery";
import { runAssistantWorkerOnce } from "@/lib/ai/assistant/runtime";
import { isWhiteSheetReaderEnabled } from "@/lib/white-sheet-reader/mode";
import { checkCronAuth } from "../finalize-slip-batches/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Work budget inside maxDuration, leaving room for pruning and the response. */
const WORKER_BUDGET_MS = 40_000;

/**
 * Independent @Botsummary answer worker: claims queued jobs and jobs whose
 * lease expired (a crashed webhook kick or worker), answers them with
 * bounded concurrency and delivers to LINE. Also prunes expired conversation
 * memory and old jobs. Safe to call concurrently: claims are leased in SQL.
 */
export async function GET(req: NextRequest) {
  const auth = checkCronAuth(process.env.CRON_SECRET, req.headers.get("authorization"), req.headers.get("x-cron-secret"));
  if (!auth.secretConfigured) {
    logger.error("ai-assistant-jobs cron rejected - CRON_SECRET is missing");
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 500 });
  }
  if (!auth.authorized) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isBotSummaryAnalystEnabled()) {
    return NextResponse.json({ ok: true, skipped: "BOT_SUMMARY_ANALYST_ENABLED is not true" });
  }

  const startedAt = Date.now();
  // Questions whose enqueue failed and that LINE did not (or could not)
  // redeliver: enqueue them now so this pass answers them.
  const recoveryClient = createServiceClient({ fetch: deadlineFetch(startedAt + 8_000, 4_000) });
  const recovered = await recoverUnenqueuedQuestions({
    supabase: recoveryClient,
    dispatcher: createAssistantDispatcher(new SupabaseAssistantJobStore(recoveryClient)),
    analystEnabled: true,
    sourceAllowed: (sourceId) => isBotSummaryAnalystSourceAllowed(sourceId),
    whiteSheetReaderEnabled: isWhiteSheetReaderEnabled(),
  }).catch(() => {
    logger.warn("ai assistant recovery sweep failed");
    return null;
  });

  const worker = await runAssistantWorkerOnce({
    budgetMs: WORKER_BUDGET_MS,
    maxJobs: 12,
    workerId: `cron-${randomUUID()}`,
  });

  const maintenance = createServiceClient({ fetch: deadlineFetch(startedAt + 56_000, 5_000) });
  const [prune, health] = await Promise.all([
    maintenance.rpc("prune_ai_assistant_history", { p_job_retention_days: 14, p_limit: 500 }),
    maintenance.rpc("ai_assistant_queue_health", {}),
  ]);
  if (prune.error) logger.warn("ai assistant prune failed", { code: prune.error.code });
  if (health.error) logger.warn("ai assistant queue health failed", { code: health.error.code });

  return NextResponse.json({
    ok: true,
    recovered,
    worker,
    pruned: prune.error ? null : prune.data,
    queue: health.error ? null : health.data,
    durationMs: Date.now() - startedAt,
  });
}
