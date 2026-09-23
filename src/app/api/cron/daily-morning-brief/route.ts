import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { pushLineMessage } from "@/lib/line/reply";
import { logger } from "@/lib/logger";
import {
  morningBriefRetryKey,
  parseStockSummaryTargets,
  resolveStockSummaryDate,
} from "@/lib/summary/daily-stock-cron";
import { loadMorningBriefReport } from "@/lib/summary/morning-brief-service";
import { buildMorningBriefMessages } from "@/lib/summary/morning-brief-message";
import {
  createMorningBriefPdfArtifact,
  morningBriefPdfLineMessage,
} from "@/lib/summary/morning-brief-pdf";

const MORNING_BRIEF_TARGETS_ENV = "MORNING_BRIEF_LINE_TARGETS";

function isStrictBusinessDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

async function resolveMarkerTarget(
  supabase: ReturnType<typeof createServiceClient>,
  marker: string,
): Promise<{ target: string | null; error: string | null }> {
  const { data, error } = await supabase
    .from("raw_messages")
    .select("source_id")
    .eq("raw_text", marker)
    .eq("source_type", "group")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return { target: null, error: error.message };
  const target = typeof data?.source_id === "string" ? data.source_id.trim() : "";
  return { target: target || null, error: null };
}

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
  const targetMarker = req.nextUrl.searchParams.get("target_marker")?.trim() ?? "";
  const retryNonce = req.nextUrl.searchParams.get("retry_nonce")?.trim() ?? "";
  if (targetOverride && !/^[CUR][0-9A-Za-z]{10,}$/.test(targetOverride)) {
    return NextResponse.json({ error: "invalid LINE target override" }, { status: 400 });
  }
  if (targetOverride && targetMarker) {
    return NextResponse.json({ error: "target and target_marker are mutually exclusive" }, { status: 400 });
  }
  if (targetMarker && [...targetMarker].length > 200) {
    return NextResponse.json({ error: "target_marker exceeds 200 characters" }, { status: 400 });
  }
  const hasManualTarget = Boolean(targetOverride || targetMarker);
  if (retryNonce && (!hasManualTarget || !/^[A-Za-z0-9_-]{1,64}$/.test(retryNonce))) {
    return NextResponse.json({ error: "retry_nonce requires a manual target and must be 1-64 safe characters" }, { status: 400 });
  }

  const businessDate = resolveStockSummaryDate(dateParam);
  const supabase = createServiceClient();

  let targets: string[];
  if (targetOverride) {
    targets = [targetOverride];
  } else if (targetMarker) {
    const resolved = await resolveMarkerTarget(supabase, targetMarker);
    if (resolved.error) {
      logger.error("morning brief marker target lookup failed", { businessDate, error: resolved.error });
      return NextResponse.json({ error: "marker target lookup failed" }, { status: 500 });
    }
    if (!resolved.target) {
      return NextResponse.json({ error: "marker target not found" }, { status: 404 });
    }
    targets = [resolved.target];
  } else {
    targets = parseStockSummaryTargets(process.env[MORNING_BRIEF_TARGETS_ENV]);
  }

  logger.info("morning brief cron started", {
    businessDate,
    hasDateParam: Boolean(dateParam),
    debugMode,
    targetOverride: Boolean(targetOverride),
    targetMarker: Boolean(targetMarker),
    targetCount: targets.length,
  });

  let messages: string[];
  let report: Awaited<ReturnType<typeof loadMorningBriefReport>>;
  try {
    report = await loadMorningBriefReport(supabase, businessDate);
    messages = buildMorningBriefMessages(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("morning brief cron failed - report build error", { businessDate, error: message });
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
    targetMode: targetMarker ? "marker" : targetOverride ? "override" : "configured",
  });
}
