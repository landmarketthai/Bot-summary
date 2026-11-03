import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authErrorStatus, requireAdminActor } from "@/lib/auth/admin";
import {
  reviewManualSlipEntry,
  reviewSlipCheck,
  revokeSlipCheckReview,
  SlipCheckReviewError,
} from "@/lib/slips/check-approval";
import type { Database } from "@/types/database";

/**
 * Admin decisions on slip money (migrations 20261102120000 + 20261102130000):
 * approve / reject one AI slip check or one manual slip entry, or revoke a
 * decision. Admin-only and server-authorized like /api/admin/data-quality/*:
 * the cookie-session client only proves WHO is asking; the reviewer recorded
 * in the audit row is that verified admin, never a value from the body. Every
 * write goes through the service-role client (the RPCs are service-role only).
 *
 * Kept apart from route.ts so tests never import `@/lib/supabase/server`
 * (Bun's process-wide mock.module registry; see data-quality/resolve).
 */
interface SlipReviewBody {
  action?: "review" | "revoke";
  target?: "slip_check" | "manual_entry";
  id?: string;
  decision?: "approved" | "rejected";
  amount?: number;
  reason?: string;
}

const CONFLICT_CODES = new Set([
  "slip_check_already_reviewed", "slip_check_is_duplicate", "manual_entry_is_ai_slip", "slip_check_round_finalized",
  "manual_entry_is_duplicate", "slip_check_superseded_by_manual", "slip_check_review_has_dependents", "slip_reference_credited",
]);

export async function handleSlipReviewRequest(
  req: NextRequest,
  supabase: SupabaseClient<Database>,
  serviceClient: SupabaseClient<Database>,
) {
  let actor;
  try {
    actor = await requireAdminActor(supabase);
  } catch (err) {
    const status = authErrorStatus(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    throw err;
  }

  const body = (await req.json().catch(() => ({}))) as SlipReviewBody;
  const id = body.id?.trim();
  const reason = body.reason?.trim();
  if (!id || !reason) return NextResponse.json({ error: "id and reason are required" }, { status: 400 });
  const reviewer = actor.email ?? actor.id;

  try {
    if (body.action === "revoke") {
      await revokeSlipCheckReview(serviceClient, { approvalId: id, revokedBy: reviewer, reason });
      return NextResponse.json({ revoked: true });
    }
    if (body.action !== "review" || (body.decision !== "approved" && body.decision !== "rejected")) {
      return NextResponse.json({ error: "action must be review|revoke and decision approved|rejected" }, { status: 400 });
    }
    const input = { decision: body.decision, amount: body.amount, reason, reviewer };
    if (body.target === "slip_check") {
      return NextResponse.json(await reviewSlipCheck(serviceClient, { checkId: id, ...input }));
    }
    if (body.target === "manual_entry") {
      return NextResponse.json(await reviewManualSlipEntry(serviceClient, { entryId: id, ...input }));
    }
    return NextResponse.json({ error: "target must be slip_check|manual_entry" }, { status: 400 });
  } catch (err) {
    if (err instanceof SlipCheckReviewError) {
      const status = CONFLICT_CODES.has(err.code) ? 409 : err.code === "review_failed" ? 500 : 422;
      return NextResponse.json({ error: err.code }, { status });
    }
    return NextResponse.json({ error: "review failed" }, { status: 500 });
  }
}
