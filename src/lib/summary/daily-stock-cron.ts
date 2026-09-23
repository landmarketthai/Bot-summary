import { createHash } from "node:crypto";
import { bangkokBusinessDateFromTimestamp } from "@/lib/business-date";

/** Env var holding the comma-separated LINE target IDs for the daily Stock push. */
export const STOCK_SUMMARY_TARGETS_ENV = "STOCK_SUMMARY_LINE_TARGETS";

export function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function shiftIsoDate(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * The business date a SCHEDULED run must report: the previous Bangkok business
 * date, never the one currently in progress.
 *
 * The morning delivery runs at 08:00 Bangkok so P'Krai and Je can decide what
 * to buy that morning, and what they need is the day that just closed. The
 * existing 04:00 business-day cutoff still defines "today", so this is
 * literally (business date now) − 1 day:
 *
 *   26/07 08:00 Bangkok → business date 26/07 → reports 25/07
 *   27/07 08:00 Bangkok → business date 27/07 → reports 26/07
 *
 * Around the cutoff the rule stays consistent because it is derived from the
 * business date rather than the calendar date:
 *
 *   26/07 03:59 Bangkok → business date 25/07 → reports 24/07
 *   26/07 04:00 Bangkok → business date 26/07 → reports 25/07
 */
export function previousBangkokBusinessDate(timestamp = Date.now()): string {
  const businessDate =
    bangkokBusinessDateFromTimestamp(timestamp) ?? new Date(timestamp).toISOString().slice(0, 10);
  return shiftIsoDate(businessDate, -1);
}

/**
 * Report date for a cron invocation.
 *
 * An explicit ISO ?date= always wins and is used verbatim — backfill and UAT
 * must never be shifted backwards. With no parameter the scheduled semantics
 * apply: the previous Bangkok business date.
 */
export function resolveStockSummaryDate(dateParam: string | null, timestamp = Date.now()): string {
  if (dateParam && isIsoDate(dateParam)) return dateParam;
  return previousBangkokBusinessDate(timestamp);
}

/**
 * Deterministic X-Line-Retry-Key (UUID shape) per business date + target +
 * message part. A repeated scheduler call re-derives the exact same keys, so
 * LINE answers 409 for anything already delivered instead of re-sending it.
 * Same construction as dailySummaryRetryKey — different namespace.
 */
function retryKey(namespace: string, ...parts: Array<string | number>): string {
  const bytes = createHash("sha256")
    .update(`${namespace}:${parts.join(":")}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // UUID version bits (name-based)
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function stockSummaryRetryKey(
  businessDate: string,
  targetId: string,
  partIndex: number,
): string {
  return retryKey("daily-stock-summary", businessDate, targetId, partIndex);
}

export function houseStockSummaryRetryKey(
  businessDate: string,
  targetId: string,
  partIndex: number,
): string {
  return retryKey("daily-house-stock", businessDate, targetId, partIndex);
}

export function stockSummaryPdfRetryKey(
  businessDate: string,
  targetId: string,
): string {
  return retryKey("daily-stock-summary-pdf", businessDate, targetId);
}

export function purchasePlanningRetryKey(
  businessDate: string,
  targetId: string,
  partIndex: number,
): string {
  return retryKey("daily-purchase-planning", businessDate, targetId, partIndex);
}

export function houseStockImmediateRetryKey(
  sessionGeneration: string,
  partIndex: number,
): string {
  return retryKey("house-stock-finalization", sessionGeneration, partIndex);
}

/**
 * Own namespace ("daily-morning-brief") — distinct from every sibling above,
 * so a business date + target that already received (say) the Stock summary
 * cannot collide with, or be mistaken for, its Morning Brief delivery.
 */
export function morningBriefRetryKey(
  businessDate: string,
  targetId: string,
  partIndex: number,
  retryNonce?: string,
): string {
  return retryNonce
    ? retryKey("daily-morning-brief", businessDate, targetId, partIndex, retryNonce)
    : retryKey("daily-morning-brief", businessDate, targetId, partIndex);
}

/**
 * Parse the configured LINE targets. Blank/duplicate entries are dropped.
 * An unset or empty variable yields [] — the route then does nothing, which is
 * how automatic delivery stays inactive until the business supplies real IDs.
 */
export function parseStockSummaryTargets(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,\s]+/)) {
    const id = part.trim();
    if (id) seen.add(id);
  }
  return [...seen];
}
