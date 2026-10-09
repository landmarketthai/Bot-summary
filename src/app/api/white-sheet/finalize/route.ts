import { NextRequest, NextResponse } from "next/server";
import { authErrorStatus, requireAdminActor } from "@/lib/auth/admin";
import { createClient } from "@/lib/supabase/server";
import {
  normalizedMarketLabel,
  WhiteSheetHardStopError,
  WhiteSheetNotSubmittedError,
} from "@/lib/white-sheet";
import { WhiteSheetPersistenceError } from "@/lib/white-sheet/persist";
import { finalizeServerWhiteSheetCashEntry } from "@/lib/white-sheet/server";

/**
 * BR-06: SUBMITTED -> FINALIZED. Admin-only privileged action, separate from
 * the operator's normal LINE/website "ปิดยอด" submission (which only ever
 * reaches SUBMITTED). After this call, normal resubmission is rejected until
 * an admin explicitly reopens (see /api/white-sheet/reopen).
 */
interface FinalizeRequestBody {
  sourceId?: string;
  market?: string;
  date?: string;
  accountabilityRoundId?: string | null;
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  let actor;
  try {
    actor = await requireAdminActor(supabase);
  } catch (err) {
    const status = authErrorStatus(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    throw err;
  }

  const body = (await req.json()) as FinalizeRequestBody;
  const { sourceId, market, date } = body;
  if (!sourceId || !market || !date) {
    return NextResponse.json({ error: "sourceId, market, and date are required" }, { status: 400 });
  }

  try {
    const state = await finalizeServerWhiteSheetCashEntry(
      {
        sourceId,
        marketLabelNormalized: normalizedMarketLabel(market),
        businessDate: date,
        accountabilityRoundId: body.accountabilityRoundId ?? null,
      },
      actor.id,
    );
    return NextResponse.json(state);
  } catch (err) {
    if (err instanceof WhiteSheetPersistenceError || err instanceof WhiteSheetNotSubmittedError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof WhiteSheetHardStopError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "finalize failed" },
      { status: 500 },
    );
  }
}
