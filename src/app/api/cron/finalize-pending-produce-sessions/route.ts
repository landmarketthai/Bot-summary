import { after, NextRequest, NextResponse } from "next/server";
import { checkCronAuth } from "@/app/api/cron/finalize-slip-batches/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { finalizeDuePendingGenerations } from "@/lib/line/pending-session-finalizer";
import { logger } from "@/lib/logger";
import {
  processDueProduceNotifications,
  resendProduceNotification,
} from "@/lib/line/produce-notification-delivery";
import { processExpiredPendingProduceEvents } from "@/lib/line/pending-produce-reorder";
import { WebhookService } from "@/lib/line/webhook-service";
import { recoverStrandedPendingCloses } from "@/lib/line/pending-close-recovery";
import {
  sweepPendingSessionInactivityWarnings,
  sweepPendingSessionInactivityExpiry,
} from "@/lib/line/pending-inactivity-recovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const auth = checkCronAuth(
    process.env.CRON_SECRET,
    req.headers.get("authorization"),
    req.headers.get("x-cron-secret"),
  );

  if (!auth.secretConfigured) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured" },
      { status: 500 },
    );
  }
  if (!auth.authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const supabase = createServiceClient();
    // Reuse the existing once-per-minute durable scheduler as a wake-up source for
    // recent ordered webhook backlog, but do not delay the Produce finalizer.
    // The recovery itself runs after this response and stays bounded.
    const webhookQueueService = new WebhookService(supabase, {
      scheduleBackgroundTask: (task) => after(task),
    });
    // Quarantine >60-minute queue rows (never auto-replayed) and read bounded
    // queue metrics concurrently with the Produce work below. Internal output
    // only; a failure here never fails the finalizer.
    const webhookQueuePromise = webhookQueueService.reconcileOrderedQueue()
      .then((reconcile) => {
        if (reconcile?.surfaced.length) {
          // Surfaced once per row by the database (stale_surfaced_at), so log
          // here before any later Produce failure can drop the response.
          logger.warn("ordered webhook events went stale and need manual review", {
            count: reconcile.surfaced.length,
            events: reconcile.surfaced,
          });
        }
        return reconcile;
      })
      .catch((error: unknown) => {
        logger.error("ordered webhook reconcile failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
    after(async () => {
      try {
        // Recent rows only; the claim RPC itself refuses anything >60 minutes.
        const recovery = await webhookQueueService.recoverPendingOrderedEvents();
        if (recovery.processed > 0) {
          logger.info("ordered webhook recovery completed", recovery);
        }
      } catch (error) {
        logger.error("ordered webhook recovery failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    // Resolve/reject the bounded reorder ledger before any closing generation
    // is allowed to enter authoritative Produce persistence.
    const deferredProduceEvents = await processExpiredPendingProduceEvents(supabase);
    const result = await finalizeDuePendingGenerations(supabase);
    const notifications = await processDueProduceNotifications(supabase);
    // P1-B: after the scheduled work, retire the generations whose valid close
    // was refused and never resolved. Deliberately last — it only ever touches
    // rows with NO close scheduled, which the finalizer above never looks at.
    const closeRecovery = await recoverStrandedPendingCloses(supabase);
    // Inactivity lifecycle for OPEN pending sessions: never touches a row any
    // sweep above already claimed (all four require a close boundary this
    // pair deliberately excludes). Warning before expiry, so a session that
    // crosses 30 minutes in one sweep run still gets its 25-minute warning
    // recorded first.
    const inactivityWarnings = await sweepPendingSessionInactivityWarnings(supabase);
    const inactivityExpiry = await sweepPendingSessionInactivityExpiry(supabase);
    const webhookQueueReconcile = await webhookQueuePromise;
    const webhookQueue = webhookQueueReconcile && {
      pendingCount: webhookQueueReconcile.pending_count,
      oldestPendingAgeSeconds: webhookQueueReconcile.oldest_pending_age_seconds,
      processingCount: webhookQueueReconcile.processing_count,
      staleCount: webhookQueueReconcile.stale_count,
      oldestStaleAgeSeconds: webhookQueueReconcile.oldest_stale_age_seconds,
      quarantined: webhookQueueReconcile.quarantined,
      surfacedStale: webhookQueueReconcile.surfaced.length,
    };
    logger.info("pending produce finalizer completed", {
      ...result,
      deferredProduceEvents,
      notifications,
      closeRecovery,
      inactivityWarnings,
      inactivityExpiry,
      webhookQueue,
    });
    return NextResponse.json({
      ok: true,
      ...result,
      deferredProduceEvents,
      notifications,
      closeRecovery,
      inactivityWarnings,
      inactivityExpiry,
      webhookQueue,
      triggeredAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("pending produce finalizer sweep failed", { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = checkCronAuth(
    process.env.CRON_SECRET,
    req.headers.get("authorization"),
    req.headers.get("x-cron-secret"),
  );

  if (!auth.secretConfigured) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured" },
      { status: 500 },
    );
  }
  if (!auth.authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const produceSessionId = body && typeof body === "object"
    && "produceSessionId" in body
    ? (body as { produceSessionId?: unknown }).produceSessionId
    : null;
  if (
    typeof produceSessionId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(produceSessionId)
  ) {
    return NextResponse.json(
      { error: "produceSessionId must be a UUID" },
      { status: 400 },
    );
  }

  try {
    const result = await resendProduceNotification(
      createServiceClient(),
      produceSessionId,
    );
    if (result === "not_requeued") {
      return NextResponse.json(
        { error: "Notification was not found or is currently sending" },
        { status: 409 },
      );
    }

    logger.info("operator produce notification resend completed", {
      produceSessionId,
      result,
    });
    const status = result === "sent"
      ? 200
      : result === "retry_scheduled"
        ? 202
        : result === "failed"
          ? 502
          : 409;
    return NextResponse.json({ ok: result === "sent", result }, { status });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("operator produce notification resend failed", {
      produceSessionId,
      error: message,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
