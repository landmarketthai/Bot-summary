import { AsyncLocalStorage } from "node:async_hooks";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";
import {
  BUSINESS_CATEGORY_POLICY,
  buildCategoryPolicy,
  setCategoryPolicySource,
  type CategoryPolicy,
} from "@/lib/produce/product-code/category";

/**
 * Per-report category policy.
 *
 * Each report runs inside withApprovedCategoryRules: it loads ONE complete
 * immutable snapshot and every classification in that async run reads it, so
 * a concurrent report's refresh can never change categories midway through.
 * A failed or partial load never produces a partial snapshot: the run falls
 * back to the last complete snapshot this process loaded, else to the shipped
 * business rules. Category is presentation only; money, quantities and
 * identity never depend on it.
 */
const currentPolicy = new AsyncLocalStorage<CategoryPolicy>();
setCategoryPolicySource(() => currentPolicy.getStore());

let lastComplete: CategoryPolicy | null = null;

export const CATEGORY_RULES_PAGE_SIZE = 1000;

/** Keyset pagination on the primary key: complete and deterministic, or throws. */
async function fetchAllRules(supabase: SupabaseClient): Promise<[string, string][]> {
  const rows: [string, string][] = [];
  let cursor: string | null = null;
  for (;;) {
    let query = supabase
      .from("produce_category_rules")
      .select("product_name, category_code")
      .order("product_name", { ascending: true })
      .limit(CATEGORY_RULES_PAGE_SIZE);
    if (cursor !== null) query = query.gt("product_name", cursor);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const page = (data ?? []) as { product_name: string; category_code: string }[];
    for (const row of page) rows.push([row.product_name, row.category_code]);
    if (page.length < CATEGORY_RULES_PAGE_SIZE) return rows;
    cursor = page[page.length - 1]!.product_name;
  }
}

/** A complete fresh snapshot, or the last complete one, or business rules only. */
export async function loadApprovedCategoryPolicy(supabase: SupabaseClient | unknown): Promise<CategoryPolicy> {
  try {
    const policy = buildCategoryPolicy(await fetchAllRules(supabase as SupabaseClient));
    lastComplete = policy;
    return policy;
  } catch (error) {
    logger.warn("approved category rules unavailable; using last complete snapshot", {
      error: error instanceof Error ? error.message : String(error),
      fallback: lastComplete ? "last_complete" : "business_only",
    });
    return lastComplete ?? BUSINESS_CATEGORY_POLICY;
  }
}

/** Run one report against one snapshot. Nested calls reuse the outer snapshot. */
export async function withApprovedCategoryRules<T>(
  supabase: SupabaseClient | unknown,
  run: () => T | Promise<T>,
): Promise<T> {
  if (currentPolicy.getStore()) return run();
  const policy = await loadApprovedCategoryPolicy(supabase);
  return currentPolicy.run(policy, run);
}

/**
 * Pin `policy` for the rest of the CALLING async function (and everything it
 * awaits), for long route handlers where wrapping the body would be noise:
 *   enterCategoryPolicy(await loadApprovedCategoryPolicy(supabase));
 * Must be called synchronously by that function, after an await, never from
 * a helper: the store belongs to the async context that calls it.
 */
export function enterCategoryPolicy(policy: CategoryPolicy): void {
  currentPolicy.enterWith(policy);
}

/** Test seam and explicit-snapshot entry point. */
export function runWithCategoryPolicy<T>(policy: CategoryPolicy, run: () => T): T {
  return currentPolicy.run(policy, run);
}
