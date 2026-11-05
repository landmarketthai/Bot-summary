import { withApprovedCategoryRules } from "@/lib/produce/category-learning/rules";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { fetchRemainingFruitRows } from "@/lib/summary/remaining-fruit-data";
import { buildStockSummaryFromRows, type StockSummary } from "@/lib/summary/stock-summary";

/**
 * The one and only way to produce a StockSummary from the database.
 *
 * Both the manual `สรุปคงเหลือ` LINE command and the scheduled daily delivery
 * go through here, so the two paths can never drift apart. Reads
 * produce_transactions, which is already void-filtered at the view level
 * (migration 0037), and trusted/active only.
 */
export async function loadStockSummary(
  supabase: SupabaseClient<Database>,
  businessDate: string,
  marketFilter: string | null = null,
): Promise<StockSummary> {
  // Fetch and classify against one category snapshot (category-learning/rules.ts).
  return withApprovedCategoryRules(supabase, async () => {
    const rows = await fetchRemainingFruitRows(supabase, businessDate, marketFilter);
    return buildStockSummaryFromRows(businessDate, rows, { marketFilter });
  });
}
