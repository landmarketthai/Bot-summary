import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { pushLineMessage } from "@/lib/line/reply";
import { fetchRemainingFruitRows, findLatestStockDataDate } from "@/lib/summary/remaining-fruit-data";
import type { LatestDataLookup } from "@/lib/summary/latest-data-hint";
import { buildDailyGoodReturnValueMessages, buildDailyGoodReturnValueReport } from "@/lib/summary/daily-good-return-value";
import { buildStockSummaryFromRows } from "@/lib/summary/stock-summary";
import { isStockSnapshotEmpty } from "@/lib/summary/stock-snapshot-message";
import {
  buildNoHouseStockMessage,
  fetchAuthoritativeHouseStockReport,
} from "@/lib/physical-inventory/house-stock-report";
import { countUnresolvedPendingSessions } from "@/lib/sales/load";
import { runDailyClosePreflight } from "@/lib/produce/preflight-service";
import {
  loadRoundReturnStatuses,
  type RoundReturnStatus,
} from "@/lib/produce/round-return-status";
import {
  parseStockSummaryTargets,
  houseStockSummaryRetryKey,
  stockSummaryPdfRetryKey,
  resolveStockSummaryDate,
  stockSummaryRetryKey,
  STOCK_SUMMARY_TARGETS_ENV,
} from "@/lib/summary/daily-stock-cron";
import { loadMorningBriefReport } from "@/lib/summary/morning-brief-service";
import {
  createMorningBriefPdfArtifact,
  morningBriefPdfLineMessage,
} from "@/lib/summary/morning-brief-pdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Scheduled daily Stock snapshot delivery.
 *
 * What goes out is the sellable remaining stock of the previous business date
 * across all markets, grouped by category then by unit — a factual snapshot the
 * humans use to decide what to buy. It contains no recommendation, no reorder
 * rule and no purchase wording. The FULL per-market inventory stays on the
 * manual `สรุปคงเหลือ` command.
 *
 * Scheduled by .github/workflows/daily-stock-summary.yml at 08:00 Asia/Bangkok
 * (01:00 UTC) — GitHub Actions, matching how finalize-slip-batches is driven,
 * because vercel.json crons are UTC-only and this project is on a Hobby plan
 * where cron firing time is approximate.
 *
 * Delivery is still INERT until STOCK_SUMMARY_LINE_TARGETS is configured: with
 * no targets the route logs and returns without sending anything.
 *
 * Contract:
 *   - Auth: Bearer CRON_SECRET, the same convention as the other cron routes.
 *   - Report date: with no ?date=, the PREVIOUS Bangkok business date (the day
 *     that just closed) — see previousBangkokBusinessDate. An explicit
 *     ?date=YYYY-MM-DD is used verbatim and never shifted.
 *   - Idempotent: a deterministic X-Line-Retry-Key per (date, target, part)
 *     means a repeated scheduler call cannot produce duplicate LINE messages.
 *   - Per-target isolation: one failing target never blocks the others.
 *   - Any failure returns 500 for monitoring/manual recovery. pg_net does not
 *     automatically retry HTTP failures; a same-date rerun is protected by
 *     deterministic retry keys.
 *   - Shares the StockSummary model with the manual command — no second
 *     business calculation lives here.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    logger.error("daily stock summary cron rejected - CRON_SECRET is missing");
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 500 });
  }

  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${secret}`) {
    logger.warn("daily stock summary cron rejected - invalid authorization");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dateParam = req.nextUrl.searchParams.get("date");
  const debugMode = req.nextUrl.searchParams.get("debug") === "1";
  const targetOverride = req.nextUrl.searchParams.get("target")?.trim() ?? "";
  if (targetOverride && !/^[CUR][0-9A-Za-z]{10,}$/.test(targetOverride)) {
    return NextResponse.json({ error: "invalid LINE target override" }, { status: 400 });
  }
  const businessDate = resolveStockSummaryDate(dateParam);
  const targets = targetOverride
    ? [targetOverride]
    : parseStockSummaryTargets(process.env[STOCK_SUMMARY_TARGETS_ENV]);

  logger.info("daily stock summary cron started", {
    businessDate,
    hasDateParam: Boolean(dateParam),
    debugMode,
    targetOverride: Boolean(targetOverride),
    targetCount: targets.length,
  });

  const supabase = createServiceClient();

  let report;
  let stockSummary;
  let houseStockReport;
  let roundStatuses: RoundReturnStatus[] = [];
  try {
    const rows = await fetchRemainingFruitRows(supabase, businessDate);
    // Round identity is loaded BEFORE the report is built: it supplies both the
    // canonical market label the report displays and the missing-return
    // classification appended below. A failure here is a real failure — a
    // silently label-keyed report is the bug this replaced.
    roundStatuses = await loadRoundReturnStatuses(supabase, businessDate);
    report = buildDailyGoodReturnValueReport(
      businessDate,
      rows,
      new Map(
        roundStatuses.map((row) => [
          row.accountabilityRoundId,
          { marketLabel: row.marketLabel },
        ]),
      ),
    );
    stockSummary = buildStockSummaryFromRows(businessDate, rows);
    houseStockReport = await fetchAuthoritativeHouseStockReport(supabase, businessDate);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("daily stock summary cron failed - summary build error", {
      businessDate,
      error: message,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }

  // Only an empty date asks what the latest date with data was, so a normal
  // morning pays for nothing extra. The lookup is context, never a substitute:
  // failing the whole delivery because it could not be read would be a worse
  // outcome than sending the empty state without it.
  //
  // A failure stays "unavailable" and NEVER becomes "none" — the report would
  // otherwise tell the business its records are empty on the strength of a
  // database error. The error text is logged here and never reaches LINE.
  // The all-market stock snapshot, grouped by category then unit, with the
  // missing-ชั่งคืน section collapsed to counts. No per-market detail: the
  // morning report has to be readable before the markets run.
  let latest: LatestDataLookup | undefined;
  if (isStockSnapshotEmpty(stockSummary)) {
    try {
      latest = await findLatestStockDataDate(supabase, businessDate);
    } catch (error) {
      latest = { status: "unavailable" };
      logger.warn("daily stock summary latest-date lookup failed", {
        businessDate,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // The good-return report values what markets actually weighed back in — a
  // withdrawal with no good return is sold, not incomplete. incomplete/
  // isComplete below describe the SEPARATE StockSummary model (still shared
  // with the manual `สรุปคงเหลือ` command) and no longer drive this message;
  // anomalyCount/anomalyMarketCount/hasAnomalies are this report's own
  // truth about fail-closed, market-level valuation problems.
  // P4A: produce the entry gate is holding never reaches produce_transactions,
  // so the report above simply cannot see it. Appended, never prepended, so the
  // existing messages keep their push retry-key indices. A lookup failure is
  // logged and the report still goes out — losing the whole morning delivery
  // over a warning line would be the worse outcome.
  //
  // The count is the Daily Close Preflight's own ACTIVE-failure count, not a
  // raw is_processed tally: a document the seller corrected and re-sent
  // successfully is not a missing entry, and announcing it every morning was
  // what buried the real ones.
  let unresolvedPendingCount = 0;
  let preflightStatus: string | null = null;
  let preflightBlockedRounds = 0;
  let hasIncompleteReturnEvidence = roundStatuses.some(
    (round) => round.state === "blocked" || round.state === "pending",
  );
  try {
    const preflight = await runDailyClosePreflight(supabase, businessDate, { roundStatuses });
    unresolvedPendingCount = preflight.summary.activeFailedSessions;
    preflightStatus = preflight.status;
    preflightBlockedRounds = preflight.summary.blockedRounds;
    hasIncompleteReturnEvidence ||= preflight.summary.blockedRounds > 0;
    logger.info("daily stock summary readiness", {
      business_date: businessDate,
      report_status: preflight.status,
      blocked_rounds: preflight.summary.blockedRounds,
      unresolved_price_products: preflight.summary.unresolvedPriceProducts,
      active_failed_sessions: preflight.summary.activeFailedSessions,
      superseded_failures: preflight.summary.supersededFailures,
      integrity_issues: preflight.summary.integrityIssues,
    });
  } catch (error) {
    // Degrade to the narrow count rather than losing the morning delivery.
    logger.warn("daily stock summary readiness lookup failed", {
      businessDate,
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      unresolvedPendingCount = await countUnresolvedPendingSessions(supabase, businessDate);
    } catch (fallbackError) {
      logger.warn("daily stock summary pending-validation lookup failed", {
        businessDate,
        error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      });
    }
  }
  // Keep readiness / return-integrity diagnostics in logs and debug metadata,
  // but never push those internal remediation details to the 08:00 LINE audience.
  const goodReturnMessages = buildDailyGoodReturnValueMessages(report, {
    latest,
    hasIncompleteReturnEvidence,
    includeDiagnostics: false,
  });
  const houseStockMessages = houseStockReport?.messages ?? buildNoHouseStockMessage(businessDate);
  const productCount = report.products.length;
  const incompleteMarketCount = new Set(stockSummary.incomplete.map((row) => row.marketName)).size;
  const anomalyCount = report.anomalies.length;
  const anomalyMarketCount = new Set(report.anomalies.map((row) => row.marketName)).size;
  const hasAnomalies = anomalyCount > 0;

  if (debugMode) {
    logger.info("daily stock summary cron debug completed", {
      businessDate,
      productCount,
      incompleteCount: stockSummary.incomplete.length,
      incompleteMarketCount,
      isComplete: stockSummary.isComplete,
      anomalyCount,
      anomalyMarketCount,
      hasAnomalies,
      preflightStatus,
      preflightBlockedRounds,
      unresolvedPendingCount,
      latestLookupStatus: latest?.status ?? null,
      latestDataDate: latest?.status === "found" ? latest.hint.date : null,
      latestDataMarketCount: latest?.status === "found" ? latest.hint.marketCount : null,
      messageCount: goodReturnMessages.length,
      houseStockFound: Boolean(houseStockReport),
      houseStockItemCount: houseStockReport?.itemCount ?? 0,
      houseStockGroupCount: houseStockReport?.groupCount ?? 0,
      houseStockTotalValueSatang: houseStockReport?.totalValueSatang ?? 0,
      targetCount: targets.length,
      wouldSendLine: targets.length > 0,
    });

    return NextResponse.json({
      ok: true,
      debug: true,
      businessDate,
      productCount,
      incompleteCount: stockSummary.incomplete.length,
      incompleteMarketCount,
      isComplete: stockSummary.isComplete,
      anomalyCount,
      anomalyMarketCount,
      hasAnomalies,
      latestLookupStatus: latest?.status ?? null,
      latestDataDate: latest?.status === "found" ? latest.hint.date : null,
      latestDataMarketCount: latest?.status === "found" ? latest.hint.marketCount : null,
      messageCount: goodReturnMessages.length,
      targetCount: targets.length,
      wouldSendLine: targets.length > 0,
      messages: goodReturnMessages,
      goodReturnMessages,
      houseStockMessages,
      houseStockFound: Boolean(houseStockReport),
      houseStockItemCount: houseStockReport?.itemCount ?? 0,
      houseStockGroupCount: houseStockReport?.groupCount ?? 0,
      houseStockTotalValueSatang: houseStockReport?.totalValueSatang ?? 0,
    });
  }

  if (targets.length === 0) {
    // Expected until Production activation — log loudly enough to notice, but
    // this is a successful no-op, not a failure the scheduler should retry.
    logger.warn("daily stock summary cron skipped - no LINE targets configured", {
      businessDate,
      envVar: STOCK_SUMMARY_TARGETS_ENV,
    });
    return NextResponse.json({
      ok: true,
      businessDate,
      sent: false,
      reason: "no_targets_configured",
      productCount,
      incompleteCount: stockSummary.incomplete.length,
      incompleteMarketCount,
      isComplete: stockSummary.isComplete,
      anomalyCount,
      anomalyMarketCount,
      hasAnomalies,
      targetCount: 0,
      houseStockFound: Boolean(houseStockReport),
      houseStockItemCount: houseStockReport?.itemCount ?? 0,
      houseStockGroupCount: houseStockReport?.groupCount ?? 0,
      houseStockTotalValueSatang: houseStockReport?.totalValueSatang ?? 0,
    });
  }

  let morningBriefPdfUrl: string;
  try {
    const morningBriefReport = await loadMorningBriefReport(supabase, businessDate);
    const artifact = await createMorningBriefPdfArtifact(supabase, morningBriefReport);
    morningBriefPdfUrl = artifact.signedUrl;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("daily stock summary cron failed - morning brief PDF generation error", {
      businessDate,
      error: message,
    });
    return NextResponse.json({ error: message, businessDate, pdfDelivered: false }, { status: 500 });
  }

  let sentCount = 0;
  const failedTargets: string[] = [];

  for (const target of targets) {
    try {
      for (const [index, message] of goodReturnMessages.entries()) {
        await pushLineMessage(target, message, stockSummaryRetryKey(businessDate, target, index));
      }
      for (const [index, message] of houseStockMessages.entries()) {
        await pushLineMessage(
          target,
          message,
          houseStockSummaryRetryKey(businessDate, target, index),
        );
      }
      await pushLineMessage(
        target,
        morningBriefPdfLineMessage(morningBriefPdfUrl),
        stockSummaryPdfRetryKey(businessDate, target),
      );
      sentCount += 1;
    } catch (error) {
      failedTargets.push(target);
      logger.error("daily stock summary cron push failed", {
        businessDate,
        target,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (failedTargets.length > 0) {
    logger.error("daily stock summary cron completed with failures", {
      businessDate,
      sentCount,
      failedCount: failedTargets.length,
    });
    return NextResponse.json(
      {
        ok: false,
        businessDate,
        sent: sentCount > 0,
        sentCount,
        pdfDelivered: sentCount > 0,
        failedCount: failedTargets.length,
        productCount,
        incompleteCount: stockSummary.incomplete.length,
        incompleteMarketCount,
        isComplete: stockSummary.isComplete,
        anomalyCount,
        anomalyMarketCount,
        hasAnomalies,
        targetCount: targets.length,
        houseStockFound: Boolean(houseStockReport),
        houseStockItemCount: houseStockReport?.itemCount ?? 0,
        houseStockGroupCount: houseStockReport?.groupCount ?? 0,
        houseStockTotalValueSatang: houseStockReport?.totalValueSatang ?? 0,
      },
      { status: 500 },
    );
  }

  logger.info("daily stock summary cron sent", {
    businessDate,
    sentCount,
    productCount,
    incompleteCount: stockSummary.incomplete.length,
    incompleteMarketCount,
    isComplete: stockSummary.isComplete,
    anomalyCount,
    anomalyMarketCount,
    hasAnomalies,
    houseStockFound: Boolean(houseStockReport),
    houseStockItemCount: houseStockReport?.itemCount ?? 0,
    houseStockGroupCount: houseStockReport?.groupCount ?? 0,
    houseStockTotalValueSatang: houseStockReport?.totalValueSatang ?? 0,
  });

  return NextResponse.json({
    ok: true,
    businessDate,
    sent: true,
    sentCount,
    pdfDelivered: true,
    productCount,
    incompleteCount: stockSummary.incomplete.length,
    incompleteMarketCount,
    isComplete: stockSummary.isComplete,
    anomalyCount,
    anomalyMarketCount,
    hasAnomalies,
    targetCount: targets.length,
    houseStockFound: Boolean(houseStockReport),
    houseStockItemCount: houseStockReport?.itemCount ?? 0,
    houseStockGroupCount: houseStockReport?.groupCount ?? 0,
    houseStockTotalValueSatang: houseStockReport?.totalValueSatang ?? 0,
  });
}
