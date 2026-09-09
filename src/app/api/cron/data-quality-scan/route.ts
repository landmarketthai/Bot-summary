import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { previousBangkokCalendarDateFromTimestamp } from "@/lib/business-date";
import { scanDataQualityIssues } from "@/lib/data-quality/scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Data Quality Inbox — daily Production scan, plus an idempotent manual/backfill endpoint.
 * Idempotent: re-running for a date that
 * already has issues on file only refreshes last_seen / reopens / touches
 * IGNORED rows — see src/lib/data-quality/inbox.ts. Safe to re-run, safe to
 * backfill via ?date=.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    logger.error("data quality scan cron rejected - CRON_SECRET is missing");
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 500 });
  }

  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${secret}`) {
    logger.warn("data quality scan cron rejected - invalid authorization");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dateParam = req.nextUrl.searchParams.get("date");
  const businessDate = dateParam && isIsoDate(dateParam)
    ? dateParam
    : previousBangkokCalendarDateFromTimestamp(Date.now())
      ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  logger.info("data quality scan cron started", { businessDate, hasDateParam: Boolean(dateParam) });

  try {
    const supabase = createServiceClient();
    const result = await scanDataQualityIssues(supabase, businessDate);
    logger.info("data quality scan cron completed", {
      businessDate,
      candidateCount: result.candidateCount,
    });
    return NextResponse.json({ ok: true, businessDate, candidateCount: result.candidateCount });
  } catch (err) {
    logger.error("data quality scan cron failed", {
      businessDate,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "scan failed" },
      { status: 500 },
    );
  }
}
