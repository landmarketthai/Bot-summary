import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";
import { setApprovedCategoryRules } from "@/lib/produce/product-code/category";

/**
 * Refresh the runtime category rules from produce_category_rules.
 *
 * Fail-soft by design: a missing table (pre-migration database), a network
 * error or a test double keeps the previous snapshot, so a report is never
 * blocked by the learning feature. Category is presentation only; money,
 * quantities and identity do not depend on this call.
 */
export async function loadApprovedCategoryRules(supabase: SupabaseClient | unknown): Promise<void> {
  try {
    const { data, error } = await (supabase as SupabaseClient)
      .from("produce_category_rules")
      .select("product_name, category_code");
    if (error) throw new Error(error.message);
    setApprovedCategoryRules(
      ((data ?? []) as { product_name: string; category_code: string }[])
        .map((row) => [row.product_name, row.category_code] as const),
    );
  } catch (error) {
    logger.warn("approved category rules unavailable; keeping previous snapshot", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
