import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authErrorStatus, requireAdminActor } from "@/lib/auth/admin";
import { EasySlipVerificationError, type BankSlipVerifier } from "@/lib/slips/easyslip-bank";
import type { Database } from "@/types/database";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_BYTES + 16 * 1024;
const ALLOWED_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function reply(body: object, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Admin-only and deliberately DB/LINE write-free. The uploaded image goes
 * straight to EasySlip for a one-off verification; no evidence/check/batch or
 * reconciliation row is created. Requires a separate UAT switch, NOT the
 * production accounting switch. Never log or return API secrets or image bytes.
 */
export async function handleEasySlipTest(
  req: NextRequest,
  supabase: SupabaseClient<Database>,
  verifier: BankSlipVerifier,
) {
  try {
    await requireAdminActor(supabase);
  } catch (err) {
    const status = authErrorStatus(err);
    if (status) return reply({ error: status === 401 ? "Login required" : "Admin permission required" }, status);
    return reply({ error: "Authorization unavailable" }, 503);
  }

  if (process.env.EASYSLIP_UAT_ENABLED !== "true") {
    return reply({ error: "Read-only EasySlip test is not enabled" }, 503);
  }
  // Session cookies require same-origin POSTs. Deny absent/foreign Origin.
  if (req.headers.get("origin") !== req.nextUrl.origin) {
    return reply({ error: "Same-origin request required" }, 403);
  }

  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (!Number.isFinite(contentLength) || contentLength > MAX_REQUEST_BYTES) {
    return reply({ error: "Image is too large" }, 413);
  }
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
    return reply({ error: "Upload one image using multipart/form-data" }, 415);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return reply({ error: "Cannot read uploaded image" }, 400);
  }
  const uploads = form.getAll("image");
  if (uploads.length !== 1 || !(uploads[0] instanceof File)) {
    return reply({ error: "Exactly one slip image is required" }, 400);
  }
  const image = uploads[0];
  if (!ALLOWED_MIMES.has(image.type) || image.size === 0 || image.size > MAX_BYTES) {
    return reply({ error: "Use a JPEG, PNG, GIF or WebP image up to 4 MB" }, 400);
  }

  try {
    const result = await verifier.verifyImage({
      bytes: new Uint8Array(await image.arrayBuffer()),
      mimeType: image.type,
    });
    if (result.kind === "not_found") {
      return reply({ status: "not_found", persisted: false, countedAsRevenue: false });
    }
    const { extraction, accountMatched, isDuplicate } = result;
    return reply({
      status: isDuplicate ? "duplicate" : accountMatched ? "verified" : "receiver_mismatch",
      amountBaht: extraction.transferAmount,
      referenceId: extraction.referenceId,
      transferTime: extraction.transactionTime,
      receiverName: extraction.receiverName,
      receiverAccountTail: extraction.receiverAccountTail,
      accountMatched,
      isDuplicate,
      persisted: false,
      countedAsRevenue: false,
    });
  } catch (err) {
    if (err instanceof EasySlipVerificationError) {
      const status = err.reason === "invalid_image" ? 400 : err.reason === "not_configured" ? 503 : 502;
      return reply({ error: "EasySlip verification unavailable", reason: err.reason, persisted: false }, status);
    }
    return reply({ error: "EasySlip verification failed", persisted: false }, 502);
  }
}
