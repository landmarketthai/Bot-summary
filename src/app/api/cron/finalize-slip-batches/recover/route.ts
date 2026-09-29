import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { finalizeSlipBatch } from "@/lib/slips/batch-finalizer";
import { pushLineMessage, type PushResult } from "@/lib/line/reply";
import { checkCronAuth } from "../auth";
import type { Database } from "@/types/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Supabase = SupabaseClient<Database>;
type PushFn = (to: string, text: string, retryKey?: string) => Promise<PushResult | void>;

// LINE's retry key window — requests with the same key beyond 24 hours are
// treated as new requests, risking duplicate delivery.
const LINE_RETRY_KEY_WINDOW_HOURS = 24;

// RFC 4122 canonical UUID (case-insensitive).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RecoverResult {
  ok: boolean;
  result:
    | "finalized"
    | "already_finalized"
    | "delivery_failed"
    | "persistence_failed"
    | "requires_manual_review";
  batchId: string;
  reason?: string;
  error?:  string;
}

/**
 * Attempts to (re-)deliver the summary for a single slip batch that is stuck
 * in processing with summary_sent_at IS NULL.
 *
 * Safety guarantees:
 *   - Only operates on status IN (processing, review_needed) AND summary_sent_at IS NULL.
 *   - Reuses the deterministic batch-id retry key; 409 → already_accepted (no duplicate).
 *   - Refuses to re-send if the batch is older than LINE's 24-hour retry key window.
 *   - Never reverts status to collecting or closing.
 *   - Never retries already-finalized batches (idempotent no-op).
 *   - Surfaces persistence failures explicitly so the caller can distinguish
 *     "LINE delivered but DB failed" from "LINE never received it".
 */
export async function recoverSlipBatch(
  supabase: Supabase,
  batchId:  string,
  push:     PushFn = pushLineMessage,
): Promise<RecoverResult> {
  const log = logger.child({ batchId });

  const { data: batch, error: fetchError } = await supabase
    .from("slip_batches")
    .select("id, source_id, status, summary_sent_at, closing_at, created_at")
    .eq("id", batchId)
    .maybeSingle();

  if (fetchError) {
    log.error("recover-slip-batch: fetch failed", { reason: fetchError.message });
    throw new Error(`Failed to load batch: ${fetchError.message}`);
  }

  if (!batch) {
    throw new Error(`Batch not found: ${batchId}`);
  }

  // Already finalized: idempotent no-op — do not re-send.
  if (batch.summary_sent_at) {
    log.info("recover-slip-batch: already finalized — no-op", {
      summarySetAt: batch.summary_sent_at,
    });
    return { ok: true, result: "already_finalized", batchId };
  }

  // Guard: only operate on processing batches, or unsent review_needed batches
  // parked by stale recovery after a permanent LINE rejection (summary_sent_at
  // is null here — sent batches returned above). Never collecting / closing.
  if (batch.status !== "processing" && batch.status !== "review_needed") {
    log.warn("recover-slip-batch: wrong status", { status: batch.status });
    throw Object.assign(
      new Error(`Batch is not in processing or unsent review_needed status (current: ${batch.status})`),
      { statusCode: 422 },
    );
  }

  // Safety guard: LINE's retry key window is 24 hours. After that the same
  // key would be treated as a fresh request and could cause duplicate delivery.
  const referenceTime = batch.closing_at ?? batch.created_at;
  const ageHours = (Date.now() - new Date(referenceTime).getTime()) / (1000 * 60 * 60);

  if (ageHours > LINE_RETRY_KEY_WINDOW_HOURS) {
    log.warn("recover-slip-batch: outside LINE retry key window", {
      ageHours: Math.round(ageHours),
      referenceTime,
    });
    return {
      ok:      false,
      result:  "requires_manual_review",
      batchId,
      reason:  `Batch is ${Math.round(ageHours)}h old — outside LINE 24-hour retry key window. Manual delivery required.`,
    };
  }

  log.info("recover-slip-batch: attempting delivery", {
    sourceId: batch.source_id,
    ageHours: Math.round(ageHours),
  });

  try {
    const finalResult = await finalizeSlipBatch(
      supabase,
      batch.id,
      async (text) => { await push(batch.source_id, text, batch.id); },
    );

    // finalResult is void when the idempotency guard fires (summary_sent_at was
    // set by a concurrent caller between our check above and the finalizer's own
    // check).  That is still a success — the batch is finalized.
    if (finalResult && !finalResult.persisted) {
      log.error("recover-slip-batch: LINE delivered but DB update failed", {
        persistError: finalResult.persistError,
      });
      return {
        ok:     false,
        result: "persistence_failed",
        batchId,
        error:  finalResult.persistError,
      };
    }

    log.info("recover-slip-batch: delivery succeeded", { batchId: batch.id });
    return { ok: true, result: "finalized", batchId };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error("recover-slip-batch: delivery failed", { error });
    return { ok: false, result: "delivery_failed", batchId, error };
  }
}

// ── Injectable dependencies for the HTTP handler (enables unit testing) ────────

export interface RecoverHandlerDeps {
  getSupabase?: () => Supabase;
  push?:        PushFn;
}

export async function handleRecoverRequest(
  req:  NextRequest,
  deps: RecoverHandlerDeps = {},
): Promise<NextResponse> {
  const secret            = process.env.CRON_SECRET;
  const authHeader        = req.headers.get("authorization");
  const xCronSecretHeader = req.headers.get("x-cron-secret");
  const auth = checkCronAuth(secret, authHeader, xCronSecretHeader);

  logger.info("recover-slip-batch auth check", {
    secretConfigured:  auth.secretConfigured,
    authHeaderPresent: auth.authHeaderPresent,
    headerTypeUsed:    auth.headerTypeUsed,
  });

  if (!auth.secretConfigured) {
    logger.error("recover-slip-batch rejected — CRON_SECRET is missing");
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 500 });
  }

  if (!auth.authorized) {
    logger.warn("recover-slip-batch rejected — invalid authorization");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── Body parsing ────────────────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  // ── batch_id extraction and UUID validation ─────────────────────────────────
  //
  // Validate before any database call to avoid exposing PostgreSQL UUID-cast
  // errors or touching external systems with garbage input.
  const rawBatchId =
    body !== null &&
    typeof body === "object" &&
    "batch_id" in body &&
    typeof (body as { batch_id: unknown }).batch_id === "string"
      ? (body as { batch_id: string }).batch_id
      : null;

  if (rawBatchId === null) {
    return NextResponse.json(
      { ok: false, result: "invalid_batch_id", error: "batch_id (string) is required" },
      { status: 400 },
    );
  }

  if (!UUID_RE.test(rawBatchId)) {
    return NextResponse.json(
      { ok: false, result: "invalid_batch_id", error: "batch_id must be a valid UUID" },
      { status: 400 },
    );
  }

  const batchId = rawBatchId;

  // ── Business logic ──────────────────────────────────────────────────────────
  const supabase = (deps.getSupabase ?? createServiceClient)();

  let result: RecoverResult;
  try {
    result = await recoverSlipBatch(supabase, batchId, deps.push);
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    const message    = err instanceof Error ? err.message : String(err);
    if (statusCode === 422) {
      return NextResponse.json({ ok: false, error: message }, { status: 422 });
    }
    if (message.includes("Batch not found")) {
      return NextResponse.json({ ok: false, error: message }, { status: 404 });
    }
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }

  const httpStatus =
    result.ok                                      ? 200
    : result.result === "requires_manual_review"   ? 422
    : result.result === "persistence_failed"       ? 500
    : /* delivery_failed */                          502;

  return NextResponse.json(result, { status: httpStatus });
}

export const POST = (req: NextRequest) => handleRecoverRequest(req);
