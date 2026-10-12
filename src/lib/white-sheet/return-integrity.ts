/**
 * Server-side ชั่งคืน verdict for the Digital White Sheet.
 *
 * Kept out of ./load on purpose: client components import ./load (through
 * ./market-scopes), and the Daily Close preflight pulls the Sales loader and
 * node:crypto into whatever bundle imports it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { runDailyClosePreflight } from "@/lib/produce/preflight-service";
import { marketProduceValueStatus } from "@/lib/settlement/produce-value-status";
import type { WhiteSheetReturnIntegrity } from "./load";

export function preflightReturnIntegrity(
  supabase: SupabaseClient<Database>,
): WhiteSheetReturnIntegrity {
  return async (businessDate, marketLabel, rowRoundIds) => {
    try {
      return marketProduceValueStatus(
        await runDailyClosePreflight(supabase, businessDate),
        marketLabel,
        rowRoundIds,
      );
    } catch {
      // The page still renders, under a hard stop: no verdict certifies nothing.
      return "blocked";
    }
  };
}
