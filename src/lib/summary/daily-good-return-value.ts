import { formatThaiDate } from "@/lib/date";
import { cleanMarketName } from "@/lib/market";
import { normalizeUnitAlias } from "@/lib/parsers/weigh-session/units";
import { quantityTimesSatang, roundHalfUp, satangToBahtText, toMilliQuantity } from "@/lib/sales/calculate";
import { isQaMarketLabel } from "@/lib/sales/qa-scopes";
import { latestDataBlock, type LatestDataLookup } from "@/lib/summary/latest-data-hint";
import { LINE_MESSAGE_MAX_CODE_POINTS, countCodePoints } from "@/lib/summary/line-chunking";
import {
  UNCATEGORIZED_CATEGORY_ID,
  dictionaryCategoryFor,
  reportCategoryHeading,
  reportCategoryIndex,
  REPORT_CATEGORY_ORDER,
  type ReportCategoryId,
} from "@/lib/produce/product-code/category";
import { dedupeRemainingSourceRows, formatQuantity, normalizeProductName, type RemainingFruitSourceRow } from "@/lib/summary/remaining-fruit";
import { transactionBucket } from "@/lib/summary/transactions";

type Blocker = "ไม่พบรายการเบิกที่ตรงกัน" | "รายการเบิกไม่มีราคา" | "ราคาจากรายการเบิกขัดแย้งกัน" | "คืนมากกว่าเบิก" | "คืนและคืนเสียรวมมากกว่าเบิก" | "จำนวนไม่ถูกต้อง" | "ระบุตลาดไม่ได้";

/** Aggregated across every contributing market — the number the business reads first. */
export interface GoodReturnValueProduct { productName: string; unit: string; quantity: number; valuedQuantity: number; unvaluedQuantity: number; valueSatang: number; /** Distinct markets whose cells for this product+unit are unvalued. */ anomalyMarketCount: number; }

/**
 * One market + product + unit whose valuation is fail-closed. Never aggregated away — this IS the actionable detail.
 *
 * withdrawnQuantity/returnedQuantity/damagedQuantity/unvaluedQuantity are `null`
 * when the underlying transaction row itself carried an invalid numeric
 * quantity — a dirty-data reading must never be displayed as if it were a
 * trustworthy zero or a trustworthy count.
 */
export interface MarketAnomaly { marketName: string; productName: string; unit: string; withdrawnQuantity: number | null; returnedQuantity: number | null; damagedQuantity: number | null; /** Distinct matching-withdrawal prices, in satang, ascending. */ priceEvidence: number[]; blockers: Blocker[]; valuedQuantity: number; unvaluedQuantity: number | null; valueSatang: number; }

/** hasActivity: any non-QA, resolved-bucket produce transaction row existed for this date — distinguishes a genuine sold-out day (withdrawals, zero good returns) from a genuinely empty date (no relevant rows at all). */
export interface GoodReturnValueReport { businessDate: string; products: GoodReturnValueProduct[]; anomalies: MarketAnomaly[]; hasActivity: boolean; }

/** Confirmed money for one dictionary category. Unresolved rows do not add satang. */
export interface GoodReturnCategoryTotal {
  id: ReportCategoryId;
  confirmedSatang: number;
  itemCount: number;
  unresolvedItemCount: number;
  unresolvedProductNames: string[];
}

export function confirmedGoodReturnTotalSatang(products: readonly GoodReturnValueProduct[]): number {
  return products.reduce((sum, row) => sum + row.valueSatang, 0);
}

/**
 * A product is incomplete for category presentation when any market is still
 * untrustworthy — including invalid-only evidence that contributes no quantity
 * (anomalyMarketCount > 0, unvaluedQuantity === 0). Confirmed satang is unchanged.
 */
function categoryRowNeedsReview(row: Pick<GoodReturnValueProduct, "unvaluedQuantity" | "anomalyMarketCount">): boolean {
  return row.unvaluedQuantity > 0 || row.anomalyMarketCount > 0;
}

/**
 * Partition report rows by dictionary category. Every product belongs to exactly
 * one bucket, so SUM(confirmedSatang) === confirmed grand total.
 */
export function goodReturnCategoryTotals(products: readonly GoodReturnValueProduct[]): GoodReturnCategoryTotal[] {
  const buckets = new Map<ReportCategoryId, GoodReturnCategoryTotal>(
    REPORT_CATEGORY_ORDER.map((id) => [id, { id, confirmedSatang: 0, itemCount: 0, unresolvedItemCount: 0, unresolvedProductNames: [] }]),
  );
  for (const row of products) {
    const bucket = buckets.get(dictionaryCategoryFor(row.productName))!;
    bucket.confirmedSatang += row.valueSatang;
    bucket.itemCount += 1;
    if (categoryRowNeedsReview(row)) {
      bucket.unresolvedItemCount += 1;
      bucket.unresolvedProductNames.push(row.productName);
    }
  }
  return REPORT_CATEGORY_ORDER.map((id) => buckets.get(id)!).filter((bucket) => bucket.itemCount > 0);
}

/**
 * Canonical market/seller labels for the day's accountability rounds.
 *
 * Production 2026-08-10 proved why this indirection exists: round
 * d96d2898 held a withdrawal labelled `ทุ่งลานนา` and its returns labelled
 * `วัดทุ่งลานนา`, so label-keyed reconciliation reported `วัดทุ่งลานนา — เบิก 0`
 * and raised ไม่พบรายการเบิกที่ตรงกัน against a withdrawal that was sitting in
 * the very same round. The round's own label is the one stable display identity.
 */
export type RoundLabelLookup = ReadonlyMap<string, { marketLabel: string }>;

interface Cell {
  market: string; product: string; unit: string; resolvedMarket: boolean;
  // Exact milli-unit (3 dp) integers — the same boundary as src/lib/sales/calculate.ts's
  // toMilliQuantity — so accumulation across multiple rows and the over-return comparisons
  // below never suffer IEEE-754 addition drift (e.g. 2.7 + 0.7 !== 3.4 in plain JS numbers).
  withdrawn: bigint; returned: bigint; damaged: bigint;
  invalidWithdrawn: boolean; invalidReturned: boolean; invalidDamaged: boolean;
  prices: Set<number>; hasWithdrawal: boolean; invalidPrice: boolean;
}
interface RowEntry { block: string; shortened: boolean; }
interface Entry extends RowEntry { category: ReportCategoryId; }

function priceSatang(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return null;
  const [coefficient, exponentText] = value.toString().toLowerCase().split("e");
  const [whole, fraction = ""] = coefficient.split("."); const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0"; const shift = 2 - (fraction.length - exponent);
  const satang = shift >= 0 ? BigInt(digits) * BigInt(10) ** BigInt(shift) : roundHalfUp(BigInt(digits), BigInt(10) ** BigInt(-shift));
  return satang <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(satang) : null;
}
function displayUnit(unit: string): string { return unit === "โล" ? "กก." : unit || "—"; }
/** Milli-unit bigint (see Cell) back to the plain-number quantity the public interfaces carry. */
function milliToQuantity(value: bigint): number { return Number(value) / 1000; }
function cellBlockers(cell: Cell): Blocker[] {
  if (!cell.resolvedMarket) return ["ระบุตลาดไม่ได้"];
  if (cell.invalidWithdrawn || cell.invalidReturned || cell.invalidDamaged || !cell.unit) return ["จำนวนไม่ถูกต้อง"];
  if (!cell.hasWithdrawal || cell.withdrawn <= BigInt(0)) return ["ไม่พบรายการเบิกที่ตรงกัน"];
  // Exact bigint comparisons on milli-units — no epsilon, no float addition drift.
  if (cell.returned > cell.withdrawn) return ["คืนมากกว่าเบิก"];
  if (cell.returned + cell.damaged > cell.withdrawn) return ["คืนและคืนเสียรวมมากกว่าเบิก"];
  if (cell.invalidPrice || cell.prices.size === 0) return ["รายการเบิกไม่มีราคา"];
  return cell.prices.size > 1 ? ["ราคาจากรายการเบิกขัดแย้งกัน"] : [];
}

const productOrder = (a: GoodReturnValueProduct, b: GoodReturnValueProduct) =>
  reportCategoryIndex(dictionaryCategoryFor(a.productName)) - reportCategoryIndex(dictionaryCategoryFor(b.productName)) ||
  b.quantity - a.quantity || a.productName.localeCompare(b.productName, "th") || a.unit.localeCompare(b.unit, "th");
const anomalyOrder = (a: MarketAnomaly, b: MarketAnomaly) =>
  reportCategoryIndex(dictionaryCategoryFor(a.productName)) - reportCategoryIndex(dictionaryCategoryFor(b.productName)) ||
  a.productName.localeCompare(b.productName, "th") || a.unit.localeCompare(b.unit, "th") || a.marketName.localeCompare(b.marketName, "th");

/**
 * Scheduled-only valuation; P0 rows, aliases, units, QA filtering, and dedup stay authoritative.
 *
 * Business truth: a withdrawal with no good return is normal (sold), never a
 * warning. Every fail-closed cell keeps its market identity all the way to
 * the anomaly list below — aggregation never discards which market caused it.
 * A good-return row with an invalid quantity is dirty data, not silence: it
 * still surfaces as a market-level anomaly even when it contributes zero to
 * the physical aggregate.
 */
export function buildDailyGoodReturnValueReport(businessDate: string, rows: readonly RemainingFruitSourceRow[], rounds: RoundLabelLookup = new Map()): GoodReturnValueReport {
  const source = dedupeRemainingSourceRows(rows); const known = new Set(source.map((row) => normalizeProductName(row.product_name))); const cells = new Map<string, Cell>();
  source.forEach((row, index) => {
    const bucket = transactionBucket(row.transaction_type); if (!bucket) return;
    // Round identity first, and its canonical label with it. A round is proof
    // two rows belong together; a market label is only ever a description of
    // one row, and Production has shown the two disagreeing inside one round.
    const roundId = row.accountability_round_id ?? null;
    const roundLabel = roundId ? rounds.get(roundId)?.marketLabel?.trim() || null : null;
    const market = roundLabel ?? cleanMarketName(row.market_name); if (market && isQaMarketLabel(market)) return;
    const product = normalizeProductName(row.product_name, undefined, known); const unit = row.unit?.trim() ? normalizeUnitAlias(row.unit.trim()) : "";
    // Never let two unresolved rows become matching price/withdrawal evidence.
    const identity = roundId ? `round:${roundId}` : market;
    const key = identity ? `${identity}||${product}||${unit}` : `unresolved:${index}`;
    const cell = cells.get(key) ?? { market: market ?? (row.market_name?.trim() || "ไม่ทราบตลาด"), product, unit, resolvedMarket: Boolean(market), withdrawn: BigInt(0), returned: BigInt(0), damaged: BigInt(0), invalidWithdrawn: false, invalidReturned: false, invalidDamaged: false, prices: new Set<number>(), hasWithdrawal: false, invalidPrice: false };
    // toMilliQuantity is the same exact-arithmetic gate calculate.ts uses: it returns null for
    // exactly the same not-finite/negative rows the old inline check rejected, so a row that
    // cannot be represented exactly still sets the invalid flag below rather than coercing to 0.
    const milli = row.quantity === null ? null : toMilliQuantity(row.quantity);
    if (milli === null) {
      if (bucket === "เบิก") cell.invalidWithdrawn = true; else if (bucket === "คืน") cell.invalidReturned = true; else cell.invalidDamaged = true;
    } else if (bucket === "เบิก") { cell.withdrawn += milli; cell.hasWithdrawal = true; const price = priceSatang(row.price_per_unit); if (price === null) cell.invalidPrice = true; else cell.prices.add(price); }
    else if (bucket === "คืน") cell.returned += milli; else cell.damaged += milli;
    cells.set(key, cell);
  });
  const products = new Map<string, GoodReturnValueProduct>(); const anomalies: MarketAnomaly[] = []; const anomalyMarketsByProduct = new Map<string, Set<string>>();
  for (const cell of cells.values()) {
    // Normal: a withdrawal with no good return is sold, not a warning. But an
    // invalid good-return row IS reportable dirty data even with zero valid quantity.
    if (cell.returned <= BigInt(0) && !cell.invalidReturned) continue;
    const key = `${cell.product}||${cell.unit}`;
    const blockers = cellBlockers(cell);
    // Converted once per cell back to the plain-number boundary the public
    // interfaces use. Exact by construction (milli round-trips through the
    // same string-based conversion toMilliQuantity itself relies on), so this
    // is not a re-introduction of float drift into the cell's own value.
    const returnedQty = milliToQuantity(cell.returned);
    // An invalid quantity is unknown, not zero — it must never inflate the
    // physical aggregate with a zero-quantity product row. Only a genuinely
    // positive recorded good-return quantity creates or updates the product.
    if (cell.returned > BigInt(0)) {
      const product = products.get(key) ?? { productName: cell.product, unit: cell.unit, quantity: 0, valuedQuantity: 0, unvaluedQuantity: 0, valueSatang: 0, anomalyMarketCount: 0 };
      product.quantity += returnedQty;
      const value = blockers.length ? null : quantityTimesSatang(returnedQty, [...cell.prices][0]!);
      if (value === null) product.unvaluedQuantity += returnedQty;
      else { product.valuedQuantity += returnedQty; product.valueSatang += value; }
      products.set(key, product);
    }
    if (blockers.length) {
      const markets = anomalyMarketsByProduct.get(key) ?? new Set<string>(); markets.add(cell.market); anomalyMarketsByProduct.set(key, markets);
      anomalies.push({
        marketName: cell.market, productName: cell.product, unit: cell.unit,
        withdrawnQuantity: cell.invalidWithdrawn ? null : milliToQuantity(cell.withdrawn),
        returnedQuantity: cell.invalidReturned ? null : returnedQty,
        damagedQuantity: cell.invalidDamaged ? null : milliToQuantity(cell.damaged),
        priceEvidence: [...cell.prices].sort((a, b) => a - b), blockers,
        valuedQuantity: 0, unvaluedQuantity: cell.invalidReturned ? null : returnedQty, valueSatang: 0,
      });
    }
  }
  // Only backfills markets onto a product that actually exists — an
  // invalid-only cell with no sibling valid cell never gets a product row,
  // so it stays a pure anomaly-only entry (products.length can be 0 while
  // anomalies.length > 0).
  for (const [key, markets] of anomalyMarketsByProduct) { const product = products.get(key); if (product) product.anomalyMarketCount = markets.size; }
  return { businessDate, products: [...products.values()].sort(productOrder), anomalies: anomalies.sort(anomalyOrder), hasActivity: cells.size > 0 };
}

function productBlock(row: GoodReturnValueProduct, index: number, includeDiagnostics = true): string {
  const unit = displayUnit(row.unit); const base = `${index}. ${row.productName} — ${formatQuantity(row.quantity)} ${unit}`;
  if (!row.valuedQuantity) return includeDiagnostics ? `${base}\n   ⚠️ รอตรวจทั้งหมดจาก ${row.anomalyMarketCount} ตลาด` : base;
  if (row.unvaluedQuantity) return includeDiagnostics ? `${base} • ${satangToBahtText(row.valueSatang)} บาท\n   ⚠️ รอตรวจ ${formatQuantity(row.unvaluedQuantity)} ${unit} จาก ${row.anomalyMarketCount} ตลาด` : `${base} • ${satangToBahtText(row.valueSatang)} บาท`;
  // Every quantity this product carries valued cleanly, but at least one OTHER
  // market for the same product+unit is invalid-only (contributed zero
  // quantity, not a trustworthy zero) — still flagged internally, but the
  // scheduled business-only view can suppress that diagnostic text.
  if (row.anomalyMarketCount && includeDiagnostics) return `${base} • ${satangToBahtText(row.valueSatang)} บาท\n   ⚠️ มีข้อมูลผิดปกติจาก ${row.anomalyMarketCount} ตลาด (จำนวนไม่ทราบ)`;
  return `${base} • ${satangToBahtText(row.valueSatang)} บาท`;
}
const ANOMALY_HEADING = "⚠️ รายละเอียดข้อมูลผิดปกติ";
function marketAnomalyBlock(row: MarketAnomaly, index: number): string {
  const unit = displayUnit(row.unit);
  const qty = (value: number | null) => (value === null ? "ไม่ถูกต้อง" : `${formatQuantity(value)} ${unit}`);
  const priceLine = row.priceEvidence.length ? `\nราคาที่พบ: ${row.priceEvidence.map((satang) => `${satangToBahtText(satang)} บาท`).join(", ")}` : "";
  const pendingLine = row.unvaluedQuantity === null ? "" : `\nปริมาณรอตรวจ: ${formatQuantity(row.unvaluedQuantity)} ${unit}`;
  return `${index}. ${row.marketName} — ${row.productName} — ${unit}\nเบิก ${qty(row.withdrawnQuantity)} | คืนดี ${qty(row.returnedQuantity)} | คืนเสีย ${qty(row.damagedQuantity)}${priceLine}\nปัญหา: ${row.blockers.join(", ")}${pendingLine}`;
}
function header(report: GoodReturnValueReport, part: number, totalParts: number, first: number, last: number): string[] {
  const lines = part === 1 ? ["📦 สรุปของดีชั่งคืนประจำวัน", `ข้อมูลวันที่ ${formatThaiDate(report.businessDate)}`, "หมายเหตุ: รายงานนี้สรุปเฉพาะของดีที่ชั่งคืน ไม่ใช่สต๊อกตรวจนับจริง"] : [`📦 ของดีชั่งคืน — ต่อ ${part}/${totalParts}`];
  return [...lines, `รายการ ${first}–${last} จากทั้งหมด ${report.products.length} รายการ`];
}
const NAME_LIST_CAP = 15;
/** Oversized LINE-fallback names must never be copied into the summary. */
const NAME_LIST_MAX_CODE_POINTS = 60;

function formatCategoryTotal(row: GoodReturnCategoryTotal, includeDiagnostics = true): string {
  const heading = reportCategoryHeading(row.id);
  const money = satangToBahtText(row.confirmedSatang);
  const items = `${row.itemCount} รายการ`;
  if (row.unresolvedItemCount > 0 && includeDiagnostics) {
    return `${heading} — ยืนยันได้ ${money} บาท • ${items}\n   ⚠️ มีข้อมูลรอตรวจ ${row.unresolvedItemCount} รายการ`;
  }
  return `${heading} — ${money} บาท • ${items}`;
}

function cappedNameList(names: readonly string[], indent: string): string[] {
  const unique = [...new Set(names)]
    .filter((name) => countCodePoints(name) <= NAME_LIST_MAX_CODE_POINTS)
    .sort((a, b) => a.localeCompare(b, "th"));
  if (!unique.length) return [];
  const shown = unique.slice(0, NAME_LIST_CAP);
  const lines = shown.map((name) => `${indent}• ${name}`);
  if (unique.length > shown.length) lines.push(`${indent}• … และอีก ${unique.length - shown.length} รายการ`);
  return lines;
}

function categorySummaryBlock(report: GoodReturnValueReport, includeDiagnostics = true): string | null {
  const totals = goodReturnCategoryTotals(report.products);
  if (!totals.length) return null;
  const lines = ["💰 สรุปมูลค่าของดีชั่งคืนแยกตามหมวด"];
  for (const row of totals) {
    lines.push(formatCategoryTotal(row, includeDiagnostics));
    if (row.id === UNCATEGORIZED_CATEGORY_ID) {
      const names = report.products.filter((product) => dictionaryCategoryFor(product.productName) === UNCATEGORIZED_CATEGORY_ID).map((product) => product.productName);
      lines.push(...cappedNameList(names, "   "));
    }
  }
  if (includeDiagnostics) {
    const unresolved = report.products.filter(categoryRowNeedsReview);
    if (unresolved.length) {
      lines.push(`⚠️ มีข้อมูลรอตรวจ ${unresolved.length} รายการ`);
      lines.push(...cappedNameList(unresolved.map((row) => row.productName), ""));
    }
  }
  return lines.join("\n");
}

function summaryBlock(report: GoodReturnValueReport, omittedProductCount: number, omittedAnomalyCount: number, includeDiagnostics = true): string {
  // A product is only "fully calculated" when nothing about it is flagged —
  // anomalyMarketCount > 0 means some market's evidence is still untrustworthy,
  // even when that market contributed zero to unvaluedQuantity (unknown, not zero).
  const complete = report.products.filter((row) => !row.unvaluedQuantity && !row.anomalyMarketCount).length;
  const anomalyMarketCount = new Set(report.anomalies.map((row) => row.marketName)).size;
  return [
    includeDiagnostics && omittedProductCount ? `⚠️ ไม่ได้แสดงสินค้าบางส่วน ${omittedProductCount} รายการ เนื่องจากขีดจำกัด LINE` : null,
    includeDiagnostics && omittedAnomalyCount ? `⚠️ ไม่ได้แสดงรายละเอียดผิดปกติ ${omittedAnomalyCount} รายการ เนื่องจากขีดจำกัด LINE` : null,
    categorySummaryBlock(report, includeDiagnostics),
    `รวมมูลค่าของดีที่ยืนยันได้ ${satangToBahtText(confirmedGoodReturnTotalSatang(report.products))} บาท`,
    `✅ สินค้าที่คำนวณมูลค่าได้ครบ ${complete} รายการ`,
    includeDiagnostics && report.anomalies.length ? `⚠️ พบข้อมูลผิดปกติ ${report.anomalies.length} รายการ จาก ${anomalyMarketCount} ตลาด` : null,
  ].filter((line): line is string => Boolean(line)).join("\n\n");
}
function lines(entries: readonly Entry[]): string {
  return entries.flatMap((item, index) => [index === 0 || item.category !== entries[index - 1]!.category ? reportCategoryHeading(item.category) : null, item.block]).filter(Boolean).join("\n");
}
type DeliveredGroup = { kind: "product"; entries: Entry[]; text: string } | { kind: "anomaly"; entries: RowEntry[]; text: string };

/**
 * Readability target for a fully-rendered message (heading + entries), well
 * under the 4,000 code-point LINE hard limit. Real Good Return messages were
 * hitting LINE's client-side "See more" collapse (~5-6 visible entries) long
 * before the hard limit, so packing is driven by this instead of a fixed
 * entry count. Every check against this target uses the actual rendered
 * text (see rebalanceParts below) rather than an estimated reserve.
 */
const GOOD_RETURN_READABLE_MAX_CODE_POINTS = 850;

/**
 * Rebalances an initial greedy packing so every multi-entry part's ACTUAL
 * rendered text (real heading + real total-part count) fits the readability
 * target — not an estimate. Headings depend on final part count/index, which
 * isn't known until packing is done, so this repeatedly re-renders each part
 * with its current position and, whenever a multi-entry part is still over
 * target, moves its last entry to the front of the next part (creating one
 * if needed) and re-checks. A single-entry part is left alone here even if
 * it's over target — an entry is never split, and the hard-limit check for
 * an oversized singleton happens separately, against the real 4,000 limit.
 * Moving only ever shifts the tail entry forward by one part, so entries
 * never change relative order.
 */
function rebalanceParts<T>(initialParts: readonly (readonly T[])[], renderPart: (group: readonly T[], partIndex: number, totalParts: number) => string): T[][] {
  const parts: T[][] = initialParts.map((group) => [...group]);
  for (let guard = 0; guard < parts.length * 50 + 50; guard++) {
    const overIndex = parts.findIndex((group, index) => group.length > 1 && countCodePoints(renderPart(group, index, parts.length)) > GOOD_RETURN_READABLE_MAX_CODE_POINTS);
    if (overIndex === -1) break;
    const moved = parts[overIndex]!.pop()!;
    if (overIndex + 1 < parts.length) parts[overIndex + 1]!.unshift(moved);
    else parts.push([moved]);
  }
  return parts;
}

/**
 * Packs whole product blocks and whole anomaly blocks by their actual
 * fully-rendered code-point length (heading included), never splitting an
 * entry. This is a P0-specific readability adjustment — see
 * GOOD_RETURN_READABLE_MAX_CODE_POINTS above — and is deliberately scoped to
 * this report rather than the shared line-chunking helpers.
 *
 * Every generated part is delivered: this scheduled report pushes each part
 * via its own retry-keyed pushLineMessage call, so LINE_REPLY_MAX_MESSAGES
 * (a webhook-reply-flow concept) does not apply here.
 */
export function buildDailyGoodReturnValueMessages(
  report: GoodReturnValueReport,
  options: { latest?: LatestDataLookup; hasIncompleteReturnEvidence?: boolean; includeDiagnostics?: boolean } = {},
): string[] {
  const includeDiagnostics = options.includeDiagnostics ?? true;
  // An anomaly-only report (zero product rows, but invalid-only good-return
  // evidence still flagged) is neither a sold-out day nor a genuinely empty
  // one — it falls through to the normal render path below, which already
  // handles an empty productParts list and a non-empty anomalyParts list.
  if (!report.products.length && !report.anomalies.length) {
    const date = formatThaiDate(report.businessDate);
    if (report.hasActivity) {
      if (options.hasIncompleteReturnEvidence) {
        return [[
          "📦 สรุปของดีชั่งคืนประจำวัน",
          `ข้อมูลวันที่ ${date}`,
          includeDiagnostics
            ? "วันนี้ยังไม่มีของดีชั่งคืนจากตลาด\nมีรายการชั่งคืนที่ยังบันทึกไม่สำเร็จ จึงยังสรุปว่าขายหมดไม่ได้"
            : "วันนี้ยังไม่มีของดีชั่งคืนจากตลาด",
        ].join("\n\n")];
      }
      // Withdrawals happened but nothing was weighed back — that is sold out, not missing data.
      return [["📦 สรุปของดีชั่งคืนประจำวัน", `ข้อมูลวันที่ ${date}`, "วันนี้ไม่มีของดีชั่งคืนจากตลาด\nสินค้าที่ไม่ได้คืนถือว่าขายออกแล้ว"].join("\n\n")];
    }
    return [["📦 สรุปของดีชั่งคืนประจำวัน", `ข้อมูลวันที่ ${date}`, "หมายเหตุ: รายงานนี้สรุปเฉพาะของดีที่ชั่งคืน ไม่ใช่สต๊อกตรวจนับจริง", `ยังไม่พบข้อมูลชั่งคืนประจำวันที่ ${date}`, latestDataBlock(options.latest ?? { status: "unavailable" }, "ยังไม่พบข้อมูลชั่งคืนในระบบ")].filter(Boolean).join("\n\n")];
  }

  // Each entry's own global number is already baked into its block text
  // (productBlock/marketAnomalyBlock render it from the report-wide index),
  // so regrouping entries between parts never disturbs numbering.
  const entryNumber = (block: string, fallback: number) => Number(block.match(/^(\d+)\./)?.[1] ?? fallback);

  const renderProductPart = (group: readonly Entry[], index: number, total: number): string => {
    const first = entryNumber(group[0]!.block, 1);
    return [...header(report, index + 1, total, first, first + group.length - 1), lines(group)].join("\n");
  };
  const renderAnomalyPart = (group: readonly RowEntry[], index: number, total: number): string => {
    const heading = total > 1 ? `${ANOMALY_HEADING} (ต่อ ${index + 1}/${total})` : ANOMALY_HEADING;
    return [heading, group.map((e) => e.block).join("\n\n")].join("\n\n");
  };

  // Initial greedy pack on body length alone (heading isn't known yet — it
  // depends on the final part count, which packing itself determines).
  const initialProductParts: Entry[][] = []; let currentProduct: Entry[] = [];
  for (const [index, row] of report.products.entries()) {
    const entry: Entry = { category: dictionaryCategoryFor(row.productName), block: productBlock(row, index + 1, includeDiagnostics), shortened: false };
    if (currentProduct.length && countCodePoints(lines([...currentProduct, entry])) > GOOD_RETURN_READABLE_MAX_CODE_POINTS) { initialProductParts.push(currentProduct); currentProduct = []; }
    currentProduct.push(entry);
  }
  if (currentProduct.length) initialProductParts.push(currentProduct);

  const initialAnomalyParts: RowEntry[][] = []; let currentAnomaly: RowEntry[] = [];
  if (includeDiagnostics) {
    for (const [index, row] of report.anomalies.entries()) {
      const entry: RowEntry = { block: marketAnomalyBlock(row, index + 1), shortened: false };
      if (currentAnomaly.length && countCodePoints([...currentAnomaly, entry].map((e) => e.block).join("\n\n")) > GOOD_RETURN_READABLE_MAX_CODE_POINTS) { initialAnomalyParts.push(currentAnomaly); currentAnomaly = []; }
      currentAnomaly.push(entry);
    }
    if (currentAnomaly.length) initialAnomalyParts.push(currentAnomaly);
  }

  // Rebalance against the ACTUAL rendered text (real heading, real total
  // part count) so every multi-entry message is at or below the readability
  // target — not merely an estimate of it.
  const rebalancedProductParts = rebalanceParts(initialProductParts, renderProductPart);
  const rebalancedAnomalyParts = rebalanceParts(initialAnomalyParts, renderAnomalyPart);

  // Only now — with real headings and a stable part count — can an
  // individually oversized entry be judged against the real 4,000-code-point
  // LINE hard limit. It's a singleton part at this point (rebalancing pulls
  // any sibling entries away from it), so replacing it in place doesn't
  // change part count/headings, and no further rebalancing is required.
  let shortenedProduct = 0;
  const productParts = rebalancedProductParts.map((group, index): Entry[] => {
    if (group.length === 1 && countCodePoints(renderProductPart(group, index, rebalancedProductParts.length)) > LINE_MESSAGE_MAX_CODE_POINTS) {
      shortenedProduct++;
      return [{ category: group[0]!.category, block: `${entryNumber(group[0]!.block, index + 1)}. รายการยาวเกินขีดจำกัด LINE จึงไม่แสดงรายละเอียด`, shortened: true }];
    }
    return group;
  });
  let shortenedAnomaly = 0;
  const anomalyParts = rebalancedAnomalyParts.map((group, index): RowEntry[] => {
    if (group.length === 1 && countCodePoints(renderAnomalyPart(group, index, rebalancedAnomalyParts.length)) > LINE_MESSAGE_MAX_CODE_POINTS) {
      shortenedAnomaly++;
      return [{ block: `${entryNumber(group[0]!.block, index + 1)}. รายละเอียดยาวเกินขีดจำกัด LINE จึงไม่แสดง`, shortened: true }];
    }
    return group;
  });

  // This scheduled report delivers every generated part (see function doc) —
  // no LINE_REPLY_MAX_MESSAGES budgeting/dropping here.
  const omittedProductCount = shortenedProduct;
  const omittedAnomalyCount = shortenedAnomaly;

  const deliveredProductTotal = productParts.length;
  const deliveredAnomalyTotal = anomalyParts.length;
  const groups: DeliveredGroup[] = [
    ...productParts.map((entries, index): DeliveredGroup => ({ kind: "product", entries, text: renderProductPart(entries, index, deliveredProductTotal) })),
    ...anomalyParts.map((entries, index): DeliveredGroup => ({ kind: "anomaly", entries, text: renderAnomalyPart(entries, index, deliveredAnomalyTotal) })),
  ];

  const messages = groups.map((g) => g.text);
  const final = summaryBlock(report, omittedProductCount, omittedAnomalyCount, includeDiagnostics);
  if (messages.length === 0) {
    messages.push(final);
  } else {
    const last = messages[messages.length - 1]!;
    // The summary only rides along on the final message when that stays within
    // the readability target; otherwise it ships as its own short message
    // (never dropped — this flow has no five-message cap).
    if (countCodePoints(`${last}\n\n${final}`) <= GOOD_RETURN_READABLE_MAX_CODE_POINTS) messages[messages.length - 1] = `${last}\n\n${final}`;
    else messages.push(final);
  }
  if (messages.some((message) => countCodePoints(message) > LINE_MESSAGE_MAX_CODE_POINTS)) throw new Error("daily good-return value message exceeds LINE limit");
  return messages;
}
