import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { logger } from "@/lib/logger";
import {
  approvedCategoryFor,
  dictionaryCategoryFor,
  dictionaryEntryFor,
  UNCATEGORIZED_CATEGORY_ID,
  type ApprovedCategoryCode,
} from "@/lib/produce/product-code/category";
import { PRODUCT_CODE_ENTRIES } from "@/lib/produce/product-code/dictionary";
import { canonicalProduceProductIdentity } from "@/lib/produce/product-vocabulary";
import { produceSectionOf } from "@/lib/summary/produce-section";
import { stockCategoryEntries, stockCategoryFor } from "@/lib/summary/stock-categories";
import { enterCategoryPolicy, loadApprovedCategoryPolicy } from "./rules";
import { buildCategoryReviewMessage, categoryReviewGroupIds, type CategoryCandidate } from "./review";

/**
 * Self-learning CATEGORY discovery. Deterministic, read-only on business data:
 * it scans persisted produce_transactions, finds names every report would file
 * under "อื่นๆ" although nothing has classified them, and records a reviewable
 * candidate with evidence. It never creates a rule, alias or product code —
 * only an authorized admin decision (review.ts) does.
 */

export type SuggestableCode = Exclude<ApprovedCategoryCode, "other">;

export interface TransactionNameRow {
  product_name: string;
  unit: string | null;
  transaction_date: string;
  market_name: string | null;
}

export interface CategorySuggestion {
  code: SuggestableCode | null;
  confidence: "high" | "medium" | "low";
  reason: string;
  similar: string | null;
}

export interface DiscoveredCandidate extends CategorySuggestion {
  productName: string;
  occurrences: number;
  dates: string[];
  markets: string[];
}

const STOCK_CODE = { ทุเรียน: "ท", ผลไม้: "ม", ผัก: "ผ" } as const;

/** Category the current policy gives a KNOWN name, or null when it has none. */
export function policyCodeFor(name: string): SuggestableCode | null {
  const approved = approvedCategoryFor(name);
  if (approved) return approved === "other" ? null : approved;
  const dictionary = dictionaryCategoryFor(name);
  if (dictionary !== UNCATEGORIZED_CATEGORY_ID) return dictionary;
  const stock = stockCategoryFor(name);
  return stock in STOCK_CODE ? STOCK_CODE[stock as keyof typeof STOCK_CODE] : null;
}

/** A name is a genuinely unknown candidate only when no source classifies it. */
export function needsCategoryReview(name: string): boolean {
  return produceSectionOf(name) === "other"
    && approvedCategoryFor(name) === undefined
    && dictionaryEntryFor(name) === null; // code table knows it: legitimate other (fish, dry goods, packs)
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  const x = [...a], y = [...b];
  if (Math.abs(x.length - y.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (x.length > y.length) i++;
    else if (y.length > x.length) j++;
    else { i++; j++; }
  }
  return edits + (x.length - i) + (y.length - j) <= 1;
}

let knownNames: string[] | null = null;
function knownClassifiedNames(): string[] {
  knownNames ??= [...new Set([
    ...PRODUCT_CODE_ENTRIES.filter((entry) => entry.enabled).map((entry) => entry.canonicalName),
    ...stockCategoryEntries().map(([name]) => name),
  ])].filter((name) => policyCodeFor(name) !== null);
  return knownNames;
}

/**
 * Deterministic suggestion with evidence. Similarity only proposes a CATEGORY;
 * it never makes the two names one product.
 */
export function suggestCategory(name: string): CategorySuggestion {
  const known = knownClassifiedNames();
  // ponytail: linear scan over ~600 names per candidate; index if candidates grow past hundreds/run.
  const typo = [...name].length >= 4 ? known.find((k) => k !== name && editDistanceAtMostOne(name, k)) : undefined;
  if (typo) {
    return { code: policyCodeFor(typo), confidence: "high", similar: typo,
      reason: `สะกดต่างจาก "${typo}" 1 ตัวอักษร` };
  }
  const prefix = known
    .filter((k) => [...k].length >= 2 && name !== k && name.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  if (prefix) {
    return { code: policyCodeFor(prefix), confidence: "medium", similar: prefix,
      reason: `ขึ้นต้นด้วย "${prefix}"` };
  }
  return { code: null, confidence: "low", similar: null, reason: "ไม่พบชื่อใกล้เคียงในพจนานุกรม" };
}

/** Pure: group rows by report identity and keep only names needing review. */
export function discoverCategoryCandidates(rows: readonly TransactionNameRow[]): DiscoveredCandidate[] {
  const byName = new Map<string, { occurrences: number; dates: Set<string>; markets: Set<string> }>();
  for (const row of rows) {
    if (!row.product_name?.trim()) continue;
    const name = canonicalProduceProductIdentity(row.product_name, row.unit);
    if (!name || !needsCategoryReview(name)) continue;
    const entry = byName.get(name) ?? { occurrences: 0, dates: new Set(), markets: new Set() };
    entry.occurrences += 1;
    entry.dates.add(row.transaction_date);
    if (row.market_name) entry.markets.add(row.market_name);
    byName.set(name, entry);
  }
  return [...byName.entries()]
    .map(([productName, e]) => ({
      productName,
      occurrences: e.occurrences,
      dates: [...e.dates].sort(),
      markets: [...e.markets].sort((a, b) => a.localeCompare(b, "th")).slice(0, 5),
      ...suggestCategory(productName),
    }))
    .sort((a, b) => b.occurrences - a.occurrences || a.productName.localeCompare(b.productName, "th"));
}

async function fetchTransactionNames(
  supabase: SupabaseClient,
  fromDate: string,
  toDate: string,
): Promise<TransactionNameRow[]> {
  const rows: TransactionNameRow[] = [];
  const page = 1000;
  for (let offset = 0; ; offset += page) {
    const { data, error } = await supabase
      .from("produce_transactions")
      .select("product_name, unit, transaction_date, market_name")
      .gte("transaction_date", fromDate)
      .lte("transaction_date", toDate)
      .order("transaction_date", { ascending: true })
      .order("item_created_at", { ascending: true })
      .range(offset, offset + page - 1);
    if (error) throw new Error(`category discovery read failed: ${error.message}`);
    rows.push(...((data ?? []) as TransactionNameRow[]));
    if (!data || data.length < page) return rows;
  }
}

/** LINE retry keys must be UUIDs; one per (candidate, revision, group). */
function retryKey(...parts: string[]): string {
  const h = createHash("sha256").update(parts.join("|")).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export type PushMessages = (to: string, messages: Record<string, unknown>[], retryKey: string) => Promise<unknown>;

/** Cap per run so a first backfill cannot flood the review group. */
export const ANNOUNCE_PER_RUN = 10;

export interface DiscoveryResult {
  scannedRows: number;
  discovered: number;
  notified: number;
  /** Cards LINE definitively rejected (4xx); skipped so the queue keeps moving. */
  undeliverable: number;
  notifyMode: "disabled" | "no_recipient" | "sent";
}

/**
 * Discover → record candidates → notify the review group about candidates
 * whose current revision has not been announced. Announcing is opt-in
 * (CATEGORY_REVIEW_NOTIFY_ENABLED=true) and only ever goes to
 * CATEGORY_REVIEW_LINE_GROUP_IDS (the test group until owner approval).
 */
export async function runCategoryDiscovery(
  supabase: SupabaseClient,
  window: { fromDate: string; toDate: string },
  push: PushMessages,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DiscoveryResult> {
  // One category snapshot for the whole run (rules.ts).
  enterCategoryPolicy(await loadApprovedCategoryPolicy(supabase));
  const rows = await fetchTransactionNames(supabase, window.fromDate, window.toDate);
  const discovered = discoverCategoryCandidates(rows);

  for (const c of discovered) {
    const { error } = await supabase.rpc("observe_produce_category_candidate", {
      p_product_name: c.productName,
      p_suggested_category: c.code,
      p_confidence: c.confidence,
      p_reason: c.reason,
      p_similar_product_name: c.similar,
      p_occurrence_count: c.occurrences,
      p_distinct_dates: c.dates.length,
      p_first_seen: c.dates[0],
      p_last_seen: c.dates[c.dates.length - 1],
      p_sample_markets: c.markets,
    });
    if (error) throw new Error(`observe category candidate failed: ${error.message}`);
  }

  const result: DiscoveryResult = { scannedRows: rows.length, discovered: discovered.length, notified: 0, undeliverable: 0, notifyMode: "disabled" };
  if (env.CATEGORY_REVIEW_NOTIFY_ENABLED !== "true") return result;
  const groups = [...categoryReviewGroupIds(env)];
  if (groups.length === 0) return { ...result, notifyMode: "no_recipient" };

  const { data, error } = await supabase
    .from("produce_category_candidates")
    .select("id, product_name, suggested_category, confidence, suggestion_reason, similar_product_name, occurrence_count, distinct_dates, first_seen, last_seen, sample_markets, revision, notified_revision")
    // FIFO over exactly the unannounced revisions (generated column, migration
    // 20261022130000), so the queue drains and nothing waits behind others forever.
    .eq("needs_announcement", true)
    .order("created_at", { ascending: true })
    .order("product_name", { ascending: true })
    .limit(ANNOUNCE_PER_RUN);
  if (error) throw new Error(`category candidate read failed: ${error.message}`);

  const unannounced = (data ?? []) as CategoryCandidate[];
  for (const candidate of unannounced) {
    const message = buildCategoryReviewMessage(candidate, policyCodeFor(candidate.similar_product_name ?? ""));
    let rejected = false;
    for (const group of groups) {
      try {
        await push(group, [message], retryKey(candidate.id, String(candidate.revision), group));
      } catch (error) {
        // Retryable / unknown (network, 429, 5xx): stop; the next run resends
        // with the same retry key and LINE de-duplicates. A definite rejection
        // (4xx) would fail forever, so it is logged and skipped instead of
        // blocking the FIFO queue head.
        if ((error as { retryable?: unknown }).retryable !== false) throw error;
        rejected = true;
        logger.error("category review card rejected by LINE; skipped", {
          candidateId: candidate.id,
          revision: candidate.revision,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (rejected) result.undeliverable += 1;
    // Only this revision is marked: a newer revision races in as unannounced.
    const { error: markError } = await supabase
      .from("produce_category_candidates")
      .update({ notified_revision: candidate.revision })
      .eq("id", candidate.id)
      .eq("revision", candidate.revision);
    if (markError) logger.warn("category candidate notify mark failed", { candidateId: candidate.id });
    if (!rejected) result.notified += 1;
  }
  return { ...result, notifyMode: "sent" };
}
