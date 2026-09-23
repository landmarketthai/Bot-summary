import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { pushLineMessage } from "@/lib/line/reply";
import { isStrictBusinessDate } from "@/lib/sales/cron";
import {
  morningBriefRetryKey,
  parseStockSummaryTargets,
  resolveStockSummaryDate,
} from "@/lib/summary/daily-stock-cron";
import { buildMorningBriefMessages } from "@/lib/summary/morning-brief-message";
import { loadMorningBriefReport } from "@/lib/summary/morning-brief-service";
import { createMorningBriefPdfArtifact, morningBriefPdfLineMessage } from "@/lib/summary/morning-brief-pdf";
import { createServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Env var holding the comma-separated LINE target IDs for the Morning Brief push. */
export const MORNING_BRIEF_TARGETS_ENV = "MORNING_BRIEF_LINE_TARGETS";

/**
 * Scheduled Executive Morning Brief (Task 5) — ONE concise message meant to
 * eventually replace the separate morning pushes (Purchase Planning, Sales,
 * Stock) for whichever targets are migrated onto it. See
 * docs/morning-brief-activation-plan.md for the exact cutover steps; nothing
 * in this route performs any part of that cutover by itself.
 *
 * NOT ACTIVATED:
 *   - No GitHub Actions schedule and no vercel.json cron call this route.
 *   - No Supabase Cron entry exists for it either (that scheduling layer is
 *     configured outside this repo, the same way it is for the existing
 *     daily-purchase-planning / daily-sales-summary / daily-stock-summary
 *     routes — see their own route.ts headers).
 *   - Delivery is additionally inert until MORNING_BRIEF_LINE_TARGETS is
 *     configured, the same double-gate every other report in this codebase
 *     uses before Production activation.
 * This route can only ever be reached today via a manual authenticated call
 * (e.g. the paired workflow_dispatch-only GitHub Actions workflow) or a
 * direct curl with the CRON_SECRET, both for debug/manual use only.
 *
 * Contract (identical in shape to the existing report cron routes):
 *   - Auth: Bearer CRON_SECRET, same convention as every other cron route.
 *   - Report date: with no ?date=, the PREVIOUS Bangkok business date (see
 *     resolveStockSummaryDate — reused verbatim, no second date rule).
 *     An explicit ?date=YYYY-MM-DD is used verbatim and never shifted; a
 *     malformed one is a 400.
 *   - Idempotent: a deterministic X-Line-Retry-Key per (date, target, part)
 *     in its own "daily-morning-brief" namespace (morningBriefRetryKey) —
 *     this can never collide with any existing report's retry keys, even for
 *     the identical date and target.
 *   - Per-target isolation: one failing push never blocks the remaining
 *     targets.
 *   - Any failure returns 500 for monitoring/manual recovery. A same-date
 *     rerun is safe and idempotent via the deterministic retry keys.
 *   - ?debug=1 previews the exact messages without sending anything.
 *   - Every underlying number is loaded from the existing Purchase Planning,
 *     Sales, and authoritative House Stock contracts, never recomputed here.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    logger.error("morning brief cron rejected - CRON_SECRET is missing");
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 500 });
  }

  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    logger.warn("morning brief cron rejected - invalid authorization");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dateParam = req.nextUrl.searchParams.get("date");
  if (dateParam !== null && !isStrictBusinessDate(dateParam)) {
    return NextResponse.json(
      { error: "date must be a real ISO business date (YYYY-MM-DD)", date: dateParam },
      { status: 400 },
    );
  }

  const debugMode = req.nextUrl.searchParams.get("debug") === "1";
  const targetOverride = req.nextUrl.searchParams.get("target")?.trim() ?? "";
  const retryNonce = req.nextUrl.searchParams.get("retry_nonce")?.trim() ?? "";
  if (targetOverride && !/^[CUR][0-9A-Za-z]{10,}$/.test(targetOverride)) {
    return NextResponse.json({ error: "invalid LINE target override" }, { status: 400 });
  }
  if (retryNonce && (!targetOverride || !/^[A-Za-z0-9_-]{1,64}$/.test(retryNonce))) {
    return NextResponse.json({ error: "retry_nonce requires a manual target and must be 1-64 safe characters" }, { status: 400 });
  }
  const businessDate = resolveStockSummaryDate(dateParam);
  const targets = targetOverride
    ? [targetOverride]
    : parseStockSummaryTargets(process.env[MORNING_BRIEF_TARGETS_ENV]);
  const supabase = createServiceClient();

  logger.info("morning brief cron started", {
    businessDate,
    hasDateParam: Boolean(dateParam),
    debugMode,
    targetOverride: Boolean(targetOverride),
    targetCount: targets.length,
  });

  let messages: string[];
  let report: Awaited<ReturnType<typeof loadMorningBriefReport>>;
  try {
    report = await loadMorningBriefReport(supabase, businessDate);
    messages = buildMorningBriefMessages(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("morning brief cron failed - report build error", {
      businessDate,
      error: message,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }

  if (debugMode) {
    logger.info("morning brief cron debug completed", {
      businessDate,
      messageCount: messages.length,
      targetCount: targets.length,
      wouldSendLine: targets.length > 0,
    });
    return NextResponse.json({
      ok: true,
      debug: true,
      businessDate,
      messageCount: messages.length,
      targetCount: targets.length,
      wouldSendLine: targets.length > 0,
      messages,
    });
  }

  if (targets.length === 0) {
    logger.warn("morning brief cron skipped - no LINE targets configured", {
      businessDate,
      envVar: MORNING_BRIEF_TARGETS_ENV,
    });
    return NextResponse.json({
      ok: true,
      businessDate,
      sent: false,
      reason: "no_targets_configured",
      messageCount: messages.length,
      targetCount: 0,
    });
  }

  let pdfUrl: string | null = null;
  let pdfError: string | null = null;
  try {
    const artifact = await createMorningBriefPdfArtifact(supabase, report);
    pdfUrl = artifact.signedUrl;
  } catch (error) {
    pdfError = error instanceof Error ? error.message : String(error);
    logger.error("morning brief PDF generation failed", { businessDate, error: pdfError });
  }

  let sentCount = 0;
  const failedTargets: string[] = [];
  for (const target of targets) {
    try {
      for (const [index, message] of messages.entries()) {
        await pushLineMessage(target, message, morningBriefRetryKey(businessDate, target, index, retryNonce || undefined));
      }
      if (pdfUrl) {
        const pdfMessage = morningBriefPdfLineMessage(pdfUrl);
        await pushLineMessage(target, pdfMessage, morningBriefRetryKey(businessDate, target, messages.length, retryNonce || undefined));
      }
      sentCount += 1;
    } catch (error) {
      failedTargets.push(target);
      logger.error("morning brief cron push failed", {
        businessDate,
        target,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (failedTargets.length > 0 || pdfError) {
    logger.error("morning brief cron completed with failures", {
      businessDate,
      sentCount,
      failedCount: failedTargets.length,
      pdfFailed: Boolean(pdfError),
    });
    // pg_net/the manual caller does not automatically retry this failure.
    // Keep it observable; a manual same-date rerun is safe via retry keys.
    return NextResponse.json(
      {
        ok: false,
        businessDate,
        sent: sentCount > 0,
        sentCount,
        failedCount: failedTargets.length,
        pdfFailed: Boolean(pdfError),
        messageCount: messages.length,
        targetCount: targets.length,
      },
      { status: 500 },
    );
  }

  logger.info("morning brief cron sent", { businessDate, sentCount });
  return NextResponse.json({
    ok: true,
    businessDate,
    sent: true,
    sentCount,
    messageCount: messages.length,
    targetCount: targets.length,
    pdfDelivered: Boolean(pdfUrl),
  });
}
