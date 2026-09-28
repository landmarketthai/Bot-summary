import {
  dictionaryCategoryFor,
  reportCategoryHeading,
  REPORT_CATEGORY_LABEL,
  REPORT_CATEGORY_ORDER,
  type ReportCategoryId,
} from "@/lib/produce/product-code/category";
import { roundHalfUp } from "@/lib/sales/calculate";
import { normalizeProductName } from "@/lib/summary/remaining-fruit";
import { baseTransactionType, type TransactionBucket } from "@/lib/summary/transactions";
import type { RuntimeDictionarySnapshot } from "@/lib/produce/product-code/resolver";

/**
 * Shared category-aware money aggregation for produce output.
 *
 * Category is presentation only, derived at output time from the approved
 * Product Code Dictionary (see product-code/category.ts) — never a second,
 * hand-maintained classification and never a change to what the operator
 * types. This module owns exactly two things: resolving a raw product name to
 * its report category the one mandatory way, and turning a set of rows into
 * exact-integer-satang totals per category per transaction bucket.
 */

/**
 * One row of produce money. Deliberately row-type-agnostic: it matches the
 * shape produce_transactions exposes (`product_name`, `transaction_type`,
 * `total_amount` as a JS float) but any equivalently-shaped computed total
 * (e.g. a parsed session item's price × quantity) works the same way.
 */
export interface ProduceCategoryRow {
  /** Raw, as-recorded product name — normalization happens inside this module. */
  product_name: string;
  /** Raw transaction type — bucketed via baseTransactionType (เบิกเพิ่ม/ชั่งคืนเพิ่ม/คืนเสียเพิ่ม fold in). */
  transaction_type: string;
  /** Baht amount for this row, as a JS float. May be null/invalid — treated as 0 satang. */
  total_amount: number | null;
}

/** One category's confirmed money within one transaction bucket. */
export interface ProduceCategoryEntry {
  id: ReportCategoryId;
  /** REPORT_CATEGORY_LABEL[id] verbatim — never a second label. */
  label: string;
  /** reportCategoryHeading(id) verbatim (emoji + label). */
  heading: string;
  totalSatang: number;
  itemCount: number;
}

/** One transaction bucket's (เบิก / คืน / คืนเสีย) category breakdown. */
export interface ProduceCategoryBucket {
  /** Ordered by REPORT_CATEGORY_ORDER. Empty categories are omitted; a
   *  populated "ไม่จัดหมวด" bucket is never special-cased away. */
  categories: ProduceCategoryEntry[];
  /** Integer sum of every category's totalSatang — the whole-bucket total. */
  totalSatang: number;
}

export interface CategoryBreakdown {
  เบิก: ProduceCategoryBucket;
  คืน: ProduceCategoryBucket;
  คืนเสีย: ProduceCategoryBucket;
  /** เบิก − คืน − คืนเสีย, in satang. */
  netSatang: number;
  /** Rows whose transaction_type baseTransactionType could not classify —
   *  excluded from every bucket above, counted here so nothing vanishes silently. */
  skipped: number;
}

/**
 * Decimal baht (a JS float, exactly as produce_transactions.total_amount is
 * exposed, or an equivalent computed total) → integer satang, rounded
 * half-up exactly once.
 *
 * Same string-parsing + BigInt technique as sales/calculate.ts's
 * quantityTimesSatang and daily-good-return-value.ts's priceSatang, so this
 * never re-derives the rounding rule: the float is read as text (never
 * multiplied as a float, which is how 0.1 + 0.2 style drift happens), split
 * into whole/fraction/exponent, and shifted to satang with a single
 * half-up BigInt division for any leftover sub-satang digit.
 */
export function satangOf(amount: number | null | undefined): number {
  return scaledMoney(amount, 2);
}

/**
 * The scale sub-satang money is accumulated at when rows are NOT individually
 * displayed. `total_amount` is numeric(10,3) × numeric(10,2), so five decimal
 * places hold it exactly.
 */
const EXACT_SCALE = 5;
const EXACT_PER_SATANG = 10 ** (EXACT_SCALE - 2);

/** Decimal baht → an integer at `decimals` places, half-up, exactly once. */
function scaledMoney(amount: number | null | undefined, decimals: number): number {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return 0;

  const negative = amount < 0;
  const text = Math.abs(amount).toString().toLowerCase();
  const [coefficient, exponentText] = text.split("e");
  const [whole, fraction = ""] = coefficient!.split(".");
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
  const shift = decimals - (fraction.length - exponent);
  const scaled = shift >= 0
    ? BigInt(digits) * BigInt(10) ** BigInt(shift)
    : roundHalfUp(BigInt(digits), BigInt(10) ** BigInt(-shift));
  const bounded = scaled <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(scaled) : Number.MAX_SAFE_INTEGER;
  return negative ? -bounded : bounded;
}

/** Half-up, on a plain integer count of hundred-thousandths of a baht. */
function exactToSatang(exact: number): number {
  const negative = exact < 0;
  const absolute = Math.abs(exact);
  const satang = Math.floor(absolute / EXACT_PER_SATANG)
    + (absolute % EXACT_PER_SATANG >= EXACT_PER_SATANG / 2 ? 1 : 0);
  return negative ? -satang : satang;
}

/**
 * The one mandatory category resolution path: normalize the raw name through
 * the alias map FIRST, then classify against the dictionary. Calling
 * dictionaryCategoryFor on a raw name silently drops reviewed aliases into
 * ไม่จัดหมวด — proven by the existing category tests. `knownNames` should be
 * every already-normalized name present in the same row set, so the "เพิ่ม"
 * prefix strip is authorized exactly as remaining-fruit.ts and
 * daily-good-return-value.ts already do it.
 */
export function resolveProduceCategory(
  rawProductName: string,
  knownNames?: ReadonlySet<string>,
  runtimeDictionary?: RuntimeDictionarySnapshot,
): ReportCategoryId {
  return dictionaryCategoryFor(normalizeProductName(rawProductName, undefined, knownNames), runtimeDictionary);
}

interface MutableCategoryEntry {
  id: ReportCategoryId;
  totalSatang: number;
  itemCount: number;
}

function finalizeBucket(byId: ReadonlyMap<ReportCategoryId, MutableCategoryEntry>): ProduceCategoryBucket {
  const categories = REPORT_CATEGORY_ORDER
    .map((id) => byId.get(id))
    .filter((entry): entry is MutableCategoryEntry => entry !== undefined && entry.itemCount > 0)
    .map((entry) => ({
      id: entry.id,
      label: REPORT_CATEGORY_LABEL[entry.id],
      heading: reportCategoryHeading(entry.id),
      totalSatang: entry.totalSatang,
      itemCount: entry.itemCount,
    }));
  // Integer sum of already-integer category subtotals — never re-derived
  // from the rows, so this can never drift from the categories above it.
  const totalSatang = categories.reduce((sum, category) => sum + category.totalSatang, 0);
  return { categories, totalSatang };
}

/**
 * Group produce rows into category totals per transaction bucket, with a net
 * satang figure and an explicit skipped count so an unrecognized
 * transaction_type never silently vanishes.
 *
 * `knownNames` is an EXPLICIT parameter and is never derived from `rows`.
 * Deriving it here made a row's category depend on which other rows happened
 * to be in the same call — a lone `เพิ่มหมอนทอง` classified as ไม่จัดหมวด, the
 * same row next to a `หมอนทอง` sibling classified as ทุเรียน. A caller with
 * genuine wider context (the day-wide 08:00 report) passes its own set; a
 * caller with only one message passes nothing and gets a pure function of each
 * row's own name. Any caller that also groups rows itself MUST resolve
 * categories with the same argument, or a row can be totalled under one
 * category and printed under another.
 *
 * Money invariant: every row is converted to satang exactly once (satangOf),
 * and every subtotal from there on is an integer sum of those satang values —
 * so SUM(bucket.categories[*].totalSatang) === bucket.totalSatang, and
 * SUM(all buckets' totals) === SUM(satangOf(row) for every classified row),
 * exactly, for any grouping or row order.
 */
/** One category's confirmed money across all three transaction buckets — the
 *  seller/market/day ledger view (as opposed to CategoryBreakdown's one-row-
 *  per-bucket view). */
export interface CategoryLedgerEntry {
  id: ReportCategoryId;
  /** REPORT_CATEGORY_LABEL[id] verbatim — never a second label. */
  label: string;
  /** reportCategoryHeading(id) verbatim (emoji + label). */
  heading: string;
  withdrawnSatang: number;
  goodReturnSatang: number;
  badReturnSatang: number;
  /** withdrawn − goodReturn − badReturn, in satang. */
  netSatang: number;
}

/**
 * Transpose a CategoryBreakdown (one row per transaction bucket, each bucket
 * holding categories) into a per-category ledger (one row per category,
 * holding all three buckets) — the view a seller/market/day summary needs.
 *
 * A category appears exactly once if it has money or items in ANY of the
 * three buckets, ordered by REPORT_CATEGORY_ORDER. Every field here is an
 * integer sum of the same already-final satang subtotals produceCategoryTotals
 * computed — this function reconciles nothing and re-derives no money, it
 * only regroups final totals — so SUM(entries[*].withdrawnSatang) ===
 * breakdown.เบิก.totalSatang exactly (and likewise for the return / bad-return
 * columns), and therefore SUM(entries[*].netSatang) === breakdown.netSatang
 * exactly, for any breakdown.
 */
export function categoryLedger(breakdown: CategoryBreakdown): CategoryLedgerEntry[] {
  const byId = new Map<ReportCategoryId, { withdrawnSatang: number; goodReturnSatang: number; badReturnSatang: number }>();

  const merge = (
    bucket: ProduceCategoryBucket,
    field: "withdrawnSatang" | "goodReturnSatang" | "badReturnSatang",
  ): void => {
    for (const category of bucket.categories) {
      const entry = byId.get(category.id) ?? { withdrawnSatang: 0, goodReturnSatang: 0, badReturnSatang: 0 };
      entry[field] += category.totalSatang;
      byId.set(category.id, entry);
    }
  };

  merge(breakdown.เบิก, "withdrawnSatang");
  merge(breakdown.คืน, "goodReturnSatang");
  merge(breakdown.คืนเสีย, "badReturnSatang");

  const entries: CategoryLedgerEntry[] = [];
  for (const id of REPORT_CATEGORY_ORDER) {
    const totals = byId.get(id);
    if (!totals) continue;
    entries.push({
      id,
      label: REPORT_CATEGORY_LABEL[id],
      heading: reportCategoryHeading(id),
      withdrawnSatang: totals.withdrawnSatang,
      goodReturnSatang: totals.goodReturnSatang,
      badReturnSatang: totals.badReturnSatang,
      netSatang: totals.withdrawnSatang - totals.goodReturnSatang - totals.badReturnSatang,
    });
  }
  return entries;
}

export function produceCategoryTotals(
  rows: readonly ProduceCategoryRow[],
  knownNames?: ReadonlySet<string>,
  /**
   * How a raw transaction_type maps to a bucket. Defaults to
   * `baseTransactionType`, which also folds the legacy ชั่งคืนเพิ่ม /
   * คืนเสียเพิ่ม marker rows.
   *
   * A caller whose category subtotals must reconcile against an EXISTING
   * grand total has to pass the same predicate that total uses. The daily
   * summary passes `transactionBucket`, because the grand totals it sits
   * beside recognize only เบิก/เบิกเพิ่ม/คืน/คืนเสีย/เสีย — counting a legacy
   * marker row here would put money in the categories that is absent from the
   * total printed directly underneath them. transactions.ts says as much:
   * baseTransactionType is "not for existing report buckets".
   */
  bucketOf: (transactionType: string) => TransactionBucket | null = baseTransactionType,
  /**
   * Whether each row is rounded to satang before being summed.
   *
   * TRUE for output that prints the rows themselves: the per-document receipt
   * shows each line at 0.13, so its subtotal has to be the sum of those printed
   * 0.13s or the receipt contradicts itself.
   *
   * FALSE for output that prints only subtotals. `total_amount` is
   * numeric(10,3) × numeric(10,2), so sub-satang row values are ordinary data;
   * rounding each one first would inflate a subtotal above the true sum — two
   * rows of 10.005 are 20.01, not 20.02 — and disagree with a grand total that
   * was accumulated from the same rows without per-row rounding. Rows are then
   * summed exactly and rounded once, at the end.
   */
  roundPerRow = true,
  runtimeDictionary?: RuntimeDictionarySnapshot,
): CategoryBreakdown {
  const byBucket: Record<TransactionBucket, Map<ReportCategoryId, MutableCategoryEntry>> = {
    เบิก: new Map(),
    คืน: new Map(),
    คืนเสีย: new Map(),
  };

  let skipped = 0;

  for (const row of rows) {
    const bucket = bucketOf(row.transaction_type);
    if (!bucket) {
      skipped += 1;
      continue;
    }

    const categoryId = resolveProduceCategory(row.product_name, knownNames, runtimeDictionary);
    const map = byBucket[bucket];
    const entry = map.get(categoryId) ?? { id: categoryId, totalSatang: 0, itemCount: 0 };
    entry.totalSatang += roundPerRow
      ? satangOf(row.total_amount)
      : scaledMoney(row.total_amount, EXACT_SCALE);
    entry.itemCount += 1;
    map.set(categoryId, entry);
  }

  if (!roundPerRow) {
    for (const map of Object.values(byBucket)) {
      for (const entry of map.values()) entry.totalSatang = exactToSatang(entry.totalSatang);
    }
  }

  const เบิก = finalizeBucket(byBucket.เบิก);
  const คืน = finalizeBucket(byBucket.คืน);
  const คืนเสีย = finalizeBucket(byBucket.คืนเสีย);

  return {
    เบิก,
    คืน,
    คืนเสีย,
    netSatang: เบิก.totalSatang - คืน.totalSatang - คืนเสีย.totalSatang,
    skipped,
  };
}
