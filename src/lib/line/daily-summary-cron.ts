import { createHash } from "node:crypto";
import { logger } from "@/lib/logger";
import {
  dailySummaryCategoryLedgerKey,
  type DailySummaryMessageRow,
} from "@/lib/line/daily-summary-message";
import { previousBangkokCalendarDateFromTimestamp } from "@/lib/business-date";
import { normalizeProductName } from "@/lib/summary/remaining-fruit";
import {
  categoryLedger,
  produceCategoryTotals,
  type CategoryLedgerEntry,
  type ProduceCategoryRow,
} from "@/lib/summary/produce-category-totals";
import { transactionBucket } from "@/lib/summary/transactions";
import type { RuntimeDictionarySnapshot } from "@/lib/produce/product-code/resolver";

export interface DailySummaryTransactionRow {
  raw_message_id: string;
  staff_name: string;
  market_name: string | null;
  transaction_type: string;
  total_amount: number | null;
  product_name: string;
}

export interface DailySummarySourceRow {
  id: string;
  source_id: string;
  source_type: string;
}

export interface GroupedDailySummaryRow extends DailySummaryMessageRow {
  source_id: string;
}

export function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function resolveDailySummaryDate(dateParam: string | null, timestamp = Date.now()): string {
  if (dateParam && isIsoDate(dateParam)) return dateParam;
  return previousBangkokCalendarDateFromTimestamp(timestamp)
    ?? new Date(timestamp - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Deterministic X-Line-Retry-Key (UUID format) per summary date + target.
// A cron retry after a partial failure reuses the same key, so LINE answers
// 409 for targets that already received the message instead of re-delivering.
export function dailySummaryRetryKey(summaryDate: string, sourceId: string): string {
  const bytes = createHash("sha256")
    .update(`daily-summary:${summaryDate}:${sourceId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // UUID version bits (name-based)
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function groupKey(sourceId: string, staffName: string, marketName: string): string {
  return `${sourceId}||${staffName}||${marketName}`;
}

function addAmount(row: GroupedDailySummaryRow, tx: DailySummaryTransactionRow): void {
  const amount = Number(tx.total_amount ?? 0);

  if (tx.transaction_type === "เบิก" || tx.transaction_type === "เบิกเพิ่ม") {
    row.borrow_total += amount;
  } else if (tx.transaction_type === "คืน") {
    row.return_total += amount;
  } else if (tx.transaction_type === "คืนเสีย" || tx.transaction_type === "เสีย") {
    row.bad_return_total += amount;
  }

  row.net_sales = row.borrow_total - row.return_total - row.bad_return_total;
  row.transaction_count += 1;
}

export function groupDailySummariesBySource(
  transactions: DailySummaryTransactionRow[],
  sources: DailySummarySourceRow[],
  summaryDate: string,
): Map<string, DailySummaryMessageRow[]> {
  const sourceByMessageId = new Map(
    sources
      .filter((row) => row.source_id && row.source_id !== "unknown")
      .map((row) => [row.id, row]),
  );

  const grouped = new Map<string, GroupedDailySummaryRow>();
  for (const tx of transactions) {
    const source = sourceByMessageId.get(tx.raw_message_id);
    if (!source) continue;

    const marketName = tx.market_name ?? "";
    const key = groupKey(source.source_id, tx.staff_name, marketName);
    const row = grouped.get(key) ?? {
      source_id: source.source_id,
      summary_date: summaryDate,
      staff_name: tx.staff_name,
      market_name: marketName,
      borrow_total: 0,
      return_total: 0,
      bad_return_total: 0,
      net_sales: 0,
      transaction_count: 0,
    };

    addAmount(row, tx);
    grouped.set(key, row);
  }

  const summariesBySource = new Map<string, DailySummaryMessageRow[]>();
  for (const row of grouped.values()) {
    const { source_id, ...summaryRow } = row;
    const rows = summariesBySource.get(source_id) ?? [];
    rows.push(summaryRow);
    summariesBySource.set(source_id, rows);
  }

  return summariesBySource;
}

/**
 * Category ledgers for the same groups `groupDailySummariesBySource` builds,
 * from the same rows, under the same skip rules.
 *
 * The grouping identity is (source_id, staff_name, market_name), NOT
 * (staff_name, market_name). The message this feeds is pushed per LINE source
 * and its grand totals are accumulated per source, so a seller/market pair
 * that posts through two sources in one day is genuinely two message rows with
 * two totals. Keying the ledger on staff+market alone produced ONE combined
 * ledger and attached it to both rows: each source's message then showed
 * category money that its own grand total did not contain, and one LINE
 * group's business leaked into another group's message.
 *
 * Rows whose raw message has no resolvable source are skipped here exactly as
 * they are skipped there — otherwise their money would appear in a category
 * column and in no total.
 *
 * Buckets come from `transactionBucket`, the predicate `addAmount` uses, not
 * from `baseTransactionType`. The legacy ชั่งคืนเพิ่ม / คืนเสียเพิ่ม marker
 * rows are absent from the grand totals, so they must be absent from the
 * categories printed above them; `produceCategoryTotals` reports them through
 * its `skipped` count rather than silently folding them in.
 *
 * `knownNames` is built once from every row of the WHOLE day — genuine
 * day-wide context, the same authorization daily-good-return-value.ts grants
 * its 08:00 report, and never derived from a single group's own narrower rows
 * (that is the sibling-dependency bug already fixed for the per-document
 * reply). It intentionally spans sources: product identity is not per-group.
 */
export function dailySummaryCategoryLedgers(
  transactions: readonly DailySummaryTransactionRow[],
  sources: readonly DailySummarySourceRow[],
  runtimeDictionary?: RuntimeDictionarySnapshot,
): Map<string, Map<string, CategoryLedgerEntry[]>> {
  const sourceByMessageId = new Map(
    sources
      .filter((row) => row.source_id && row.source_id !== "unknown")
      .map((row) => [row.id, row]),
  );

  // Built only from rows this report actually counts — the same restriction
  // fetchRemainingFruitRows applies with KNOWN_TX_TYPES before the 08:00 report
  // builds its own `known` set. Including a type neither report totals would
  // let a name be authorized here and not there, so the same product could
  // classify differently in the two outputs on the same day.
  const knownNames = new Set(
    transactions
      .filter((tx) => transactionBucket(tx.transaction_type) !== null)
      .map((tx) => normalizeProductName(tx.product_name)),
  );

  const rowsBySource = new Map<string, Map<string, ProduceCategoryRow[]>>();
  for (const tx of transactions) {
    const source = sourceByMessageId.get(tx.raw_message_id);
    if (!source) continue;

    const byIdentity = rowsBySource.get(source.source_id) ?? new Map<string, ProduceCategoryRow[]>();
    const key = dailySummaryCategoryLedgerKey(tx.staff_name, tx.market_name ?? "");
    const rows = byIdentity.get(key) ?? [];
    rows.push({
      product_name: tx.product_name,
      transaction_type: tx.transaction_type,
      total_amount: tx.total_amount,
    });
    byIdentity.set(key, rows);
    rowsBySource.set(source.source_id, byIdentity);
  }

  const ledgersBySource = new Map<string, Map<string, CategoryLedgerEntry[]>>();
  let skipped = 0;
  for (const [sourceId, byIdentity] of rowsBySource) {
    const ledgers = new Map<string, CategoryLedgerEntry[]>();
    for (const [key, rows] of byIdentity) {
      const breakdown = produceCategoryTotals(rows, knownNames, transactionBucket, false, runtimeDictionary);
      skipped += breakdown.skipped;
      ledgers.set(key, categoryLedger(breakdown));
    }
    ledgersBySource.set(sourceId, ledgers);
  }
  // The ledger view has no column for a row the grand totals do not count, so
  // the skipped figure would otherwise disappear entirely. It is expected to be
  // non-zero only for legacy marker types; anything else is worth seeing.
  if (skipped > 0) {
    logger.info("daily summary category ledgers skipped uncounted transaction types", { skipped });
  }
  return ledgersBySource;
}
