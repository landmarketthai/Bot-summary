import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { recoverSlipBatch, type RecoverResult, type Supabase, type PushFn } from "@/lib/slips/batch-recovery";
import { checkCronAuth } from "../auth";

// RFC 4122 canonical UUID (case-insensitive).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
