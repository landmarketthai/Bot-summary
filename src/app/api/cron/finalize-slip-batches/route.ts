import { after, NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { WebhookService } from "@/lib/line/webhook-service";
import {
  finalizeDueSlipBatches,
  finalizeClosingSlipBatches,
  recoverStaleProcessingSlipBatches,
  loadSlipBatchHealth,
  parseAbandonedMinutes,
  parseCloseSeconds,
} from "@/lib/slips/batch-finalizer";
import { checkCronAuth } from "./auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
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

  const supabase = createServiceClient();

  // Ingest recovery runs BEFORE finalization: retry due images, drain queue
  // events that never started, re-drive stalled OCR. A failure here must not
  // block finalization (which is itself bounded by the ingest wait limit).
  const ingestService = new WebhookService(supabase, {
    scheduleBackgroundTask: (task) => after(task),
  });
  let imageRecovery: Awaited<ReturnType<WebhookService["recoverSlipIngest"]>> | null = null;
  try {
    imageRecovery = await ingestService.recoverSlipIngest({ budgetMs: 12_000 });
  } catch (error) {
    logger.error("finalize-slip-batches: image ingest recovery failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const [abandonedCount, closedCount] = await Promise.all([
    finalizeDueSlipBatches(supabase),
    finalizeClosingSlipBatches(supabase),
  ]);
  // Run recovery only after normal claims finish; the two-minute stale guard
  // keeps freshly claimed work out of this sweep.
  const processingRecovery = await recoverStaleProcessingSlipBatches(supabase);
  // Post-sweep backlog: what is still stuck after this run (internal only).
  const health = await loadSlipBatchHealth(supabase);
  const imageLedger = await ingestService.slipImageHealth();

  const abandonedMinutes  = parseAbandonedMinutes(process.env.SLIP_ABANDONED_SESSION_MINUTES);
  const closeQuietSeconds = parseCloseSeconds(process.env.SLIP_CLOSE_QUIET_SECONDS, 10);
  const closeMaxSeconds   = parseCloseSeconds(process.env.SLIP_CLOSE_MAX_SECONDS, 120);

  logger.info("finalize-slip-batches completed", {
    abandonedCount,
    closedCount,
    processingRecovery,
    health,
    imageRecovery,
    imageLedger,
    abandonedMinutes,
    closeQuietSeconds,
    closeMaxSeconds,
  });
  return NextResponse.json({
    ok: true,
    abandonedCount,
    closedCount,
    processingRecovery,
    health,
    imageRecovery,
    imageLedger,
    finalizedCount: abandonedCount + closedCount + processingRecovery.recovered,
    abandonedSessionMinutes: abandonedMinutes,
    closeQuietSeconds,
    closeMaxSeconds,
    triggeredAt: new Date().toISOString(),
  });
}
