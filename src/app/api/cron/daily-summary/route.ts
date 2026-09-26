import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { pushLineMessage } from "@/lib/line/reply";
import { buildDailySummaryMessage } from "@/lib/line/daily-summary-message";
import { preloadRuntimeProductCodes } from "@/lib/produce/product-code/resolver";
import {
  dailySummaryCategoryLedgers,
  dailySummaryRetryKey,
  groupDailySummariesBySource,
  resolveDailySummaryDate,
  type DailySummarySourceRow,
  type DailySummaryTransactionRow,
} from "@/lib/line/daily-summary-cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    logger.error("daily summary cron rejected - CRON_SECRET is missing");
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 500 });
  }

  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${secret}`) {
    logger.warn("daily summary cron rejected - invalid authorization");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dateParam = req.nextUrl.searchParams.get("date");
  const debugMode = req.nextUrl.searchParams.get("debug") === "1";
  const summaryDate = resolveDailySummaryDate(dateParam);

  logger.info("daily summary cron started", {
    summaryDate,
    hasDateParam: Boolean(dateParam),
    debugMode,
  });

  const supabase = createServiceClient();
  const runtimeDictionary = await preloadRuntimeProductCodes(supabase);
  const { data: txData, error: txError } = await supabase
    .from("produce_transactions")
    .select("raw_message_id,staff_name,market_name,transaction_type,total_amount,product_name")
    .eq("transaction_date", summaryDate)
    .order("staff_name", { ascending: true })
    .order("market_name", { ascending: true });

  if (txError) {
    logger.error("daily summary cron failed - transaction fetch error", {
      summaryDate,
      error: txError.message,
    });
    return NextResponse.json({ error: txError.message }, { status: 500 });
  }

  const transactions = (txData ?? []) as DailySummaryTransactionRow[];
  if (transactions.length === 0) {
    logger.info("daily summary cron skipped - no rows", { summaryDate });
    return NextResponse.json({ ok: true, summaryDate, sent: false, rowCount: 0, targetCount: 0 });
  }

  const rawMessageIds = [...new Set(transactions.map((row) => row.raw_message_id))];
  const { data: sourceData, error: sourceError } = await supabase
    .from("raw_messages")
    .select("id,source_id,source_type")
    .in("id", rawMessageIds);

  if (sourceError) {
    logger.error("daily summary cron failed - source fetch error", {
      summaryDate,
      error: sourceError.message,
    });
    return NextResponse.json({ error: sourceError.message }, { status: 500 });
  }

  const sources = (sourceData ?? []) as DailySummarySourceRow[];
  const summariesBySource = groupDailySummariesBySource(transactions, sources, summaryDate);
  // Same in-memory transactions array, no second query — see
  // dailySummaryCategoryLedgers for why the key is staff_name+market_name
  // (not source_id) and why knownNames is derived from the whole date.
  const categoryLedgers = dailySummaryCategoryLedgers(transactions, sources, runtimeDictionary);
  const validSourceIds = new Set(
    sources
      .map((row) => row.source_id)
      .filter((sourceId) => sourceId && sourceId !== "unknown"),
  );

  if (debugMode) {
    logger.info("daily summary cron debug completed", {
      summaryDate,
      transactionCount: transactions.length,
      sourceIdCount: validSourceIds.size,
      wouldSendLine: summariesBySource.size > 0,
    });

    return NextResponse.json({
      ok: true,
      debug: true,
      summaryDate,
      transactionCount: transactions.length,
      sourceIdCount: validSourceIds.size,
      targetCount: summariesBySource.size,
      wouldSendLine: summariesBySource.size > 0,
    });
  }

  if (summariesBySource.size === 0) {
    logger.warn("daily summary cron skipped - no valid LINE source ids", { summaryDate });
    return NextResponse.json({
      ok: true,
      summaryDate,
      sent: false,
      rowCount: transactions.length,
      targetCount: 0,
    });
  }

  // Per-target isolation: one failing push must not block the remaining
  // targets. The deterministic retry key makes a manual rerun idempotent for
  // targets that already received today's summary.
  let sentCount = 0;
  const failedSourceIds: string[] = [];
  for (const [sourceId, rows] of summariesBySource) {
    const message = buildDailySummaryMessage(summaryDate, rows, categoryLedgers.get(sourceId));
    logger.info("daily summary cron pushing LINE message", {
      summaryDate,
      sourceId,
      rowCount: rows.length,
    });
    try {
      await pushLineMessage(sourceId, message, dailySummaryRetryKey(summaryDate, sourceId));
      sentCount += 1;
    } catch (error) {
      failedSourceIds.push(sourceId);
      logger.error("daily summary cron push failed", {
        summaryDate,
        sourceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (failedSourceIds.length > 0) {
    logger.error("daily summary cron completed with failures", {
      summaryDate,
      sent: sentCount,
      failed: failedSourceIds.length,
    });
    // Keep the partial failure observable. pg_net does not automatically retry
    // HTTP failures; a manual rerun is protected by the retry key.
    return NextResponse.json(
      {
        ok: false,
        summaryDate,
        sent: sentCount > 0,
        sentCount,
        failedCount: failedSourceIds.length,
        rowCount: transactions.length,
        targetCount: summariesBySource.size,
      },
      { status: 500 },
    );
  }

  logger.info("daily summary cron sent", {
    summaryDate,
    rowCount: transactions.length,
    targetCount: summariesBySource.size,
  });

  return NextResponse.json({
    ok: true,
    summaryDate,
    sent: true,
    rowCount: transactions.length,
    targetCount: summariesBySource.size,
  });
}
