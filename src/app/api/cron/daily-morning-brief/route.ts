import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/server";
import { pushLineMessage } from "@/lib/line/reply";
import { logger } from "@/lib/logger";
import {
  morningBriefRetryKey,
  morningBriefPdfRetryKey,
  parseStockSummaryTargets,
  resolveStockSummaryDate,
} from "@/lib/summary/daily-stock-cron";
import { loadMorningBriefReport } from "@/lib/summary/morning-brief-service";
import { buildMorningBriefMessages } from "@/lib/summary/morning-brief-message";
import {
  createMorningBriefPdfArtifact,
  morningBriefPdfLineMessage,
} from "@/lib/summary/morning-brief-pdf";

import { briefDelivery, briefTargetKey, type BriefDelivery } from "@/lib/summary/morning-brief-delivery";
import { morningBriefSlot } from "@/lib/summary/morning-brief-schedule";
const MORNING_BRIEF_TARGETS_ENV = "MORNING_BRIEF_LINE_TARGETS";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 240;

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
  const arrival = Date.now();
  const started = performance.now();
  let stage = "configuration";
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
  const reportScope = req.nextUrl.searchParams.get("scope") ?? "fruit";
  if (reportScope !== "fruit" && reportScope !== "vegetable") {
    return NextResponse.json({ error: "scope must be fruit or vegetable" }, { status: 400 });
  }
  const targetsEnv = reportScope === "vegetable" ? "MORNING_BRIEF_VEGETABLE_LINE_TARGETS" : MORNING_BRIEF_TARGETS_ENV;
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
  // Explicit dispatcher mode retains the legacy marker but requires the
  // same slot and private target parity gates as configured ENV sends.
  const scheduledParam = req.nextUrl.searchParams.get("scheduled");
  const scheduledMarker = scheduledParam === "1";
  if (scheduledParam !== null && !scheduledMarker) {
    return NextResponse.json({ error: "invalid scheduled mode" }, { status: 400 });
  }
  if (scheduledMarker && (!dateParam || !targetMarker || targetOverride || debugMode || retryNonce
    || ["scheduled", "date", "scope", "target_marker", "target", "debug", "retry_nonce"].some((key) => req.nextUrl.searchParams.getAll(key).length > 1))) {
    return NextResponse.json({ error: "scheduled mode requires one date and marker, without manual overrides" }, { status: 400 });
  }
  const hasManualTarget = !scheduledMarker && Boolean(targetOverride || targetMarker);
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
      logger.error("morning brief marker target lookup failed", { businessDate });
      return NextResponse.json({ error: "marker target lookup failed" }, { status: 500 });
    }
    if (!resolved.target) {
      return NextResponse.json({ error: "marker target not found" }, { status: 404 });
    }
    if (scheduledMarker && !/^C[0-9A-Za-z]{10,}$/.test(resolved.target)) {
      return NextResponse.json({ ok: false, status: "invalid_scheduled_marker_target", sent: false }, { status: 409 });
    }
    targets = [resolved.target];
  } else {
    targets = parseStockSummaryTargets(process.env[targetsEnv]);
  }

  if (retryNonce && !debugMode) {
    return NextResponse.json({ error: "retry_nonce cannot bypass durable delivery state" }, { status: 400 });
  }
  try {
    if (!debugMode && reportScope === "vegetable" && !morningBriefSlot(reportScope, arrival)) {
      logger.warn("morning brief outside slot grace", { businessDate, reportScope, stage: "window" });
      return NextResponse.json({ ok: false, status: "outside_window", sent: false, graceMinutes: 5 }, { status: 409 });
    }
    // Configured sends, including recovery, obey the slots and bounded date range.
    if (!debugMode && !hasManualTarget) {
      if (!morningBriefSlot(reportScope, arrival)) {
        logger.warn("morning brief outside slot grace", { businessDate, reportScope, stage: "window" });
        return NextResponse.json({ ok: false, status: "outside_window", sent: false, graceMinutes: 5 }, { status: 409 });
      }
    }
    // Check the additive schema before claiming, rendering, or sending, including manual UAT.
    stage = "context";
    const context = await (supabase as SupabaseClient).rpc("morning_brief_context", { p_date: businessDate, p_scope: reportScope });
    if (context.error || !["ready", "not_ready"].includes(context.data?.readiness?.status)) {
      logger.error("morning brief schema context unavailable", { businessDate, reportScope, stage });
      return NextResponse.json({ ok: false, status: "schema_unavailable", stage, sent: false }, { status: 503 });
    }
    if (!debugMode && !hasManualTarget) {
      stage = "target_parity";
      const parity = await (supabase as SupabaseClient).rpc("morning_brief_target_parity", {
        p_scope: reportScope, p_targets: targets.map(briefTargetKey),
      });
      if (parity.error || typeof parity.data?.matched !== "boolean") throw new Error("morning brief target parity unavailable");
      if (!parity.data.matched || targets.length === 0) {
        // Allowlist count fields; never reflect private RPC payloads or hashes.
        const counts = Object.fromEntries(["configuredCount", "requestedCount", "missingCount", "excessCount"].map((key) =>
          [key, Number.isSafeInteger(parity.data[key]) && parity.data[key] >= 0 ? parity.data[key] : null]));
        logger.warn("morning brief target config mismatch", { reportScope, ...counts });
        return NextResponse.json({ ok: false, status: "target_config_mismatch", sent: false, ...counts }, { status: 409 });
      }
      stage = "preflight";
      const { data, error } = await (supabase as SupabaseClient).rpc("morning_brief_should_invoke", {
        p_date: businessDate, p_scope: reportScope, p_targets: targets.map(briefTargetKey),
        p_now: new Date(arrival).toISOString(),
      });
      if (error) throw new Error("morning brief preflight unavailable");
      if (!data) {
        stage = "delivery_status";
        const status = await (supabase as SupabaseClient).rpc("morning_brief_delivery_status", {
          p_date: businessDate, p_scope: reportScope, p_targets: targets.map(briefTargetKey), p_now: new Date(arrival).toISOString(),
        });
        if (status.error || !status.data) throw new Error("morning brief status unavailable");
        const review = status.data.reviewCount > 0;
        return NextResponse.json({ ok: !review, status: review ? "needs_review" : context.data.readiness.status === "not_ready" ? "not_ready" : "skipped",
          readiness: context.data.readiness, deliveryStatus: status.data, sent: false, sentCount: 0,
          newlyAcceptedCount: 0, previouslyAcceptedCount: status.data.acceptedCount, pdfDelivered: false }, { status: review ? 409 : 200 });
      }
    }
    if (debugMode) {
      const report = await loadMorningBriefReport(supabase, businessDate, reportScope);
      const messages = report.readiness?.status === "not_ready" ? [] : buildMorningBriefMessages(report);
      return NextResponse.json({ ok: true, debug: true, reportScope, businessDate, readiness: report.readiness,
        messages, messageCount: messages.length, targetCount: targets.length, wouldSendLine: messages.length > 0 && targets.length > 0 });
    }
    let newlyAcceptedCount = 0;
    let previouslyAcceptedCount = 0;
    let failedCount = 0;
    const failureStages = new Set<string>();
    let busyCount = 0;
    let reviewCount = 0;
    let notReady = false;
    let deferredCount = 0;
    let artifactCreated = false;
    let artifact: Awaited<ReturnType<typeof createMorningBriefPdfArtifact>> | undefined;
    let report: Awaited<ReturnType<typeof loadMorningBriefReport>> | undefined;
    for (const target of targets) {
      if (performance.now() - started >= 195_000) { deferredCount++; continue; }
      let claim: BriefDelivery | undefined;
      try {
        stage = "claim";
        claim = await briefDelivery(supabase, businessDate, reportScope, target, "claim");
        if (claim.state === "accepted") { previouslyAcceptedCount++; continue; }
        if (claim.state === "busy") { busyCount++; continue; }
        if (claim.state === "needs_review") { reviewCount++; continue; }
        if (!claim.payload) {
          stage = "report";
          report ??= await loadMorningBriefReport(supabase, businessDate, reportScope);
          if (report.readiness?.status === "not_ready") { notReady = true; continue; }
          if (performance.now() - started >= 195_000) { deferredCount++; continue; }
          // Artifact success is required before sending; freeze both text and URL
          // so a partial/unknown retry uses exactly the same request body.
          stage = "artifact";
          artifact ??= await createMorningBriefPdfArtifact(supabase, report, new Date(Date.now()), `${briefTargetKey(target)}-${claim.lease_token}`);
          artifactCreated = true;
          const parts = buildMorningBriefMessages(report).map((text, index) => ({ text, kind: "text" as const,
            key: morningBriefRetryKey(businessDate, target, index, undefined, reportScope) }));
          const payload = { artifactPath: artifact.path, parts: [...parts, {
            text: morningBriefPdfLineMessage(artifact.signedUrl), kind: "pdf" as const,
            key: morningBriefPdfRetryKey(businessDate, target, reportScope),
          }] };
          stage = "freeze";
          claim = await briefDelivery(supabase, businessDate, reportScope, target, "freeze", claim, payload);
        }
        const parts = claim.payload!.parts;
        for (let index = claim.next_part; index < parts.length; index++) {
          if (performance.now() - started >= 195_000) { deferredCount++; break; }
          stage = "prepare";
          claim = await briefDelivery(supabase, businessDate, reportScope, target, "prepare", claim, undefined, index);
          if (claim.state !== "pending") { reviewCount++; break; }
          stage = "push";
          await pushLineMessage(target, parts[index].text, parts[index].key, { signal: AbortSignal.timeout(15_000) });
          stage = "accept";
          claim = await briefDelivery(supabase, businessDate, reportScope, target, "accept", claim, undefined, index);
        }
        if (claim.state === "accepted") newlyAcceptedCount++;
      } catch {
        failedCount++;
        failureStages.add(stage);
        // No target IDs, provider bodies, signed URLs or credentials in logs.
        logger.error("morning brief delivery attempt failed", { businessDate, reportScope, stage, code: `${stage}_failed` });
      } finally {
        if (claim?.state === "pending") {
          try { await briefDelivery(supabase, businessDate, reportScope, target, "release", claim); }
          catch { /* Expired/fenced claims recover through the same stored keys. */ }
        }
      }
    }
    return NextResponse.json({ ok: failedCount === 0 && deferredCount === 0 && reviewCount === 0, businessDate, reportScope,
      status: failedCount ? "failed" : reviewCount ? "needs_review" : deferredCount ? "pending" : notReady ? "not_ready" : busyCount ? "in_progress" : "complete",
      readiness: notReady ? report?.readiness : undefined, deferredCount,
      failureStages: [...failureStages],
      sent: newlyAcceptedCount > 0, sentCount: newlyAcceptedCount, newlyAcceptedCount, previouslyAcceptedCount,
      lineAcceptedCount: newlyAcceptedCount + previouslyAcceptedCount, failedCount, busyCount, reviewCount,
      artifactCreated, pdfDelivered: newlyAcceptedCount > 0, targetCount: targets.length,
    }, { status: failedCount ? 500 : reviewCount ? 409 : deferredCount ? 503 : 200 });
  } catch {
    logger.error("morning brief preflight failed", { businessDate, reportScope, stage });
    return NextResponse.json({ error: "morning brief unavailable", stage }, { status: 500 });
  }
}
