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

/** Cap per run (deliveries, across groups) so a backfill cannot flood the review group. */
export const ANNOUNCE_PER_RUN = 10;
/** Attempts per (candidate, revision, group) before it is blocked for an explicit requeue. */
export const MAX_DELIVERY_ATTEMPTS = 5;
/** A claim not completed within this lease (crash, timeout) becomes claimable again. */
export const DELIVERY_LEASE_SECONDS = 300;

export type DeliveryStatus = "pending" | "retryable" | "delivered" | "blocked";

export interface DiscoveryResult {
  scannedRows: number;
  discovered: number;
  /** Cards LINE accepted in this run. */
  notified: number;
  /** Deliveries that failed in this run and will be retried (bounded). */
  retrying: number;
  /** Deliveries blocked in this run (definitive rejection or attempts exhausted). */
  blocked: number;
  /** Current-revision deliveries by status across review groups; null when notify is off. */
  queue: Record<DeliveryStatus, number> | null;
  notifyMode: "disabled" | "no_recipient" | "sent";
}

/**
 * How a failed push is recorded. Network / 429 / 5xx and 401 / 403 (token or
 * group permission — configuration that an operator fixes) are retried,
 * bounded by MAX_DELIVERY_ATTEMPTS; any other 4xx is a definitive rejection
 * and is blocked at once. The reason is a fixed label: never a token, body or
 * raw error text.
 */
export function classifyPushFailure(error: unknown): { outcome: "retryable" | "blocked"; code: number | null; reason: string } {
  const { httpStatus, retryable } = (error ?? {}) as { httpStatus?: unknown; retryable?: unknown };
  const code = typeof httpStatus === "number" ? httpStatus : null;
  if (retryable === true) return { outcome: "retryable", code, reason: code === null ? "network" : `HTTP ${code}` };
  if (code === 401 || code === 403) return { outcome: "retryable", code, reason: `HTTP ${code} (credentials or group permission)` };
  if (code !== null && code >= 400 && code < 500) return { outcome: "blocked", code, reason: `HTTP ${code}` };
  return { outcome: "retryable", code, reason: "unknown" };
}

interface ClaimedDelivery extends Omit<CategoryCandidate, "id"> {
  candidate_id: string;
  group_id: string;
  claim_token: string;
  attempts: number;
}

async function deliveryQueue(supabase: SupabaseClient): Promise<Record<DeliveryStatus, number>> {
  const queue: Record<DeliveryStatus, number> = { pending: 0, retryable: 0, delivered: 0, blocked: 0 };
  const { data, error } = await supabase.rpc("produce_category_delivery_health");
  if (error) throw new Error(`category delivery health failed: ${error.message}`);
  for (const row of (data ?? []) as { status: DeliveryStatus; deliveries: number | string }[]) {
    queue[row.status] += Number(row.deliveries);
  }
  return queue;
}

/** Explicit recovery after credentials / group config are fixed. null = every group. */
export async function requeueCategoryDeliveries(supabase: SupabaseClient, groupId: string | null): Promise<number> {
  const { data, error } = await supabase.rpc("requeue_produce_category_deliveries", { p_group_id: groupId });
  if (error) throw new Error(`category delivery requeue failed: ${error.message}`);
  return Number(data ?? 0);
}

/**
 * Discover → record candidates → deliver review cards through the durable
 * per-recipient ledger (migration 20261023100000). Announcing is opt-in
 * (CATEGORY_REVIEW_NOTIFY_ENABLED=true) and only ever goes to
 * CATEGORY_REVIEW_LINE_GROUP_IDS (the test group until owner approval).
 *
 * Each (candidate, revision, group) is claimed under a lease, pushed with a
 * retry key derived from exactly that identity, and completed as delivered /
 * retryable / blocked. A delivered recipient is never sent the same revision
 * again; a failed one is never recorded as delivered; blocked rows leave the
 * queue so they cannot starve it.
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

  const result: DiscoveryResult = {
    scannedRows: rows.length, discovered: discovered.length,
    notified: 0, retrying: 0, blocked: 0, queue: null, notifyMode: "disabled",
  };
  if (env.CATEGORY_REVIEW_NOTIFY_ENABLED !== "true") return result;
  const groups = [...categoryReviewGroupIds(env)];
  if (groups.length === 0) return { ...result, notifyMode: "no_recipient" };

  const { data, error } = await supabase.rpc("claim_produce_category_deliveries", {
    p_groups: groups,
    p_limit: ANNOUNCE_PER_RUN,
    p_lease_seconds: DELIVERY_LEASE_SECONDS,
    p_max_attempts: MAX_DELIVERY_ATTEMPTS,
  });
  if (error) throw new Error(`category delivery claim failed: ${error.message}`);

  for (const delivery of (data ?? []) as ClaimedDelivery[]) {
    const candidate: CategoryCandidate = { ...delivery, id: delivery.candidate_id };
    const message = buildCategoryReviewMessage(candidate, policyCodeFor(candidate.similar_product_name ?? ""));
    let outcome: "delivered" | "retryable" | "blocked" = "delivered";
    let code: number | null = null;
    let reason: string | null = null;
    try {
      await push(delivery.group_id, [message], retryKey(delivery.candidate_id, String(delivery.revision), delivery.group_id));
    } catch (pushError) {
      ({ outcome, code, reason } = classifyPushFailure(pushError));
      logger.warn("category review card not delivered", {
        candidateId: delivery.candidate_id, revision: delivery.revision, attempt: delivery.attempts, outcome, reason,
      });
    }
    const { data: recorded, error: completeError } = await supabase.rpc("complete_produce_category_delivery", {
      p_candidate_id: delivery.candidate_id,
      p_revision: delivery.revision,
      p_group_id: delivery.group_id,
      p_claim_token: delivery.claim_token,
      p_outcome: outcome,
      p_error_code: code,
      p_error: reason,
      p_max_attempts: MAX_DELIVERY_ATTEMPTS,
    });
    // An unrecorded outcome is safe: the lease expires and the same retry key
    // is reused, so LINE de-duplicates an already accepted card.
    if (completeError) logger.warn("category delivery outcome not recorded", { candidateId: delivery.candidate_id });
    const status = completeError ? outcome : String(recorded);
    if (status === "delivered") result.notified += 1;
    else if (status === "blocked") result.blocked += 1;
    else if (status === "retryable") result.retrying += 1;
  }
  return { ...result, queue: await deliveryQueue(supabase), notifyMode: "sent" };
}
