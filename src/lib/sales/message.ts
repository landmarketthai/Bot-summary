import { formatThaiDate } from "@/lib/date";
import { formatQuantity, displayRemainingUnit } from "@/lib/summary/remaining-fruit";
import {
  capAtMaxMessages,
  chunkBlocks,
  LINE_MESSAGE_MAX_CODE_POINTS,
} from "@/lib/summary/line-chunking";
import { latestDataBlock, type LatestDataLookup } from "@/lib/summary/latest-data-hint";
import {
  isSoldOutByAbsentReturn,
  satangToBahtText,
  type SalesBlockReason,
  type SalesIdentityRow,
  type SalesProductSummary,
  type SalesReport,
  type SalesScopeBlocker,
  type SalesTotal,
} from "./calculate";

/**
 * P1 Daily Sales — LINE presentation.
 *
 * Presentation only: every number here comes from the SalesReport the
 * calculator produced. No arithmetic, no re-derivation, and above all no
 * relabelling — a subtotal that is not authoritative is never printed under a
 * "total sales" heading.
 */

export const SALES_MANUAL_TITLE = "💰 สรุปยอดขาย";
export const SALES_AUTO_TITLE = "💰 สรุปยอดขายประจำวัน";

/** The only wording allowed for a subtotal that is not fully verified. */
export const SALES_PARTIAL_HEADING = "⚠️ ยอดที่ยืนยันได้บางส่วน";
export const SALES_TOTAL_HEADING = "ยอดขายรวมทุกตลาด";

/**
 * The headline "ยอดขายรวมทุกตลาด" figure specifically — the number a reader
 * skims first and is most likely to mistake for the whole day's sales.
 * Stronger wording than the per-market/product SALES_PARTIAL_HEADING, plus an
 * explicit line saying what the figure is NOT.
 */
export const SALES_PARTIAL_TOTAL_HEADING = "⚠️ ยอดที่ตรวจสอบได้บางส่วน";
export const SALES_PARTIAL_TOTAL_NOTICE =
  "หมายเหตุ: ยอดนี้เป็นเฉพาะรายการที่ตรวจสอบได้ ไม่ใช่ยอดขายรวมประจำวัน";
export const SALES_MARKET_TOTAL_HEADING = "ยอดขายรวม";

export const SALES_PRODUCT_SECTION_HEADING = "📦 ยอดขายรายสินค้า (ทุกตลาด)";
export const SALES_BLOCKED_HEADING =
  "⛔ สาเหตุที่ยังยืนยันไม่ได้\n(1 รายการอาจพบมากกว่า 1 สาเหตุ)";
export const SALES_SCOPE_BLOCKER_HEADING = "⚠️ ข้อมูลวันนี้ยังไม่ครบ";
export const SALES_EMPTY_NOTICE = "ไม่พบรายการขายสำหรับวันนี้";
/**
 * The scheduled report's empty state.
 *
 * "ไม่พบรายการขายสำหรับวันนี้" was ambiguous at 08:10: it did not say WHICH day
 * had nothing, and gave no way to tell "nobody sold anything" from "yesterday's
 * entries have not been made yet". This names the requested date explicitly, and
 * the latest-data block that follows names its own — so a prior date can never
 * be read as an answer for the requested one.
 */
export const SALES_NO_DATA_PREFIX = "ยังไม่พบรายการขายประจำวันที่";
/** Nothing anywhere in history, so there is no earlier date to point at. */
export const SALES_NO_HISTORY_NOTICE = "ยังไม่พบรายการขายในระบบ";
/**
 * No persisted sales rows AND something is known to be missing. Saying
 * "ไม่พบรายการขาย" here would report a broken day as a quiet day, so this
 * wording states the opposite: nothing can be concluded yet.
 */
export const SALES_NO_ROWS_BLOCKED_NOTICE =
  "⛔ ยังสรุปยอดขายไม่ได้ — ไม่พบรายการที่บันทึกไว้ และข้อมูลของวันนี้ยังไม่ครบ";
/** Used wherever a money figure would otherwise print a misleading 0.00. */
export const SALES_VALUE_UNAVAILABLE = "ยอดเงินยังคำนวณไม่ได้";
export const SALES_MARKET_SECTION_HEADING = "🏪 สถานะยอดขายรายตลาด";
/** Quantity is complete, only the money is not. */
export const SALES_QUANTITY_ONLY_NOTICE = "จำนวนที่ขายครบถ้วน • ยอดเงินยังไม่ครบ (รอราคากลาง)";
/**
 * The "no return rows means sold out" rule, stated in plain words. A
 * withdrawal-only identity is a real, valid sale — never an anomaly — so this
 * never appears under SALES_BLOCKED_HEADING.
 */
export const SALES_SOLD_OUT_NO_RETURN_LABEL = "ถือว่าขายหมดเพราะไม่มีรายการคืน";
/** Marks a single identity's ขาย line as sold out by absence of return. */
export const SALES_SOLD_OUT_NO_RETURN_SUFFIX = "ถือว่าขายหมด";
/** Replaces "คืน 0 • เสีย 0" when there is no return row to report at all. */
export const SALES_NO_RETURN_ROW_LABEL = "ไม่มีรายการคืน";

/**
 * P1 has no Sales web page, so the shared overflow notice — which points at one
 * — must not be used here. This states only what is true, and names no
 * destination that does not exist.
 */
export const SALES_OVERFLOW_NOTICE =
  "\n\nแสดงได้ไม่ครบ — ข้อความยาวเกินที่ LINE ตอบได้ในครั้งเดียว";

const REASON_LABELS: Record<SalesBlockReason, string> = {
  invalid_identity: "ข้อมูลสินค้า/หน่วยไม่ครบ",
  invalid_quantity: "จำนวนไม่ถูกต้อง",
  unknown_transaction_type: "ประเภทรายการไม่รู้จัก",
  market_unresolved: "ระบุตลาดไม่ได้",
  missing_return_evidence: "ยังไม่มีข้อมูลชั่งคืน",
  product_return_absent: "รอบนี้มีรายการชั่งคืน แต่ไม่พบสินค้านี้ในรายการชั่งคืน",
  return_without_withdrawal: "มีคืนแต่ไม่มีเบิก",
  returns_exceed_withdrawal: "คืน+เสีย มากกว่าเบิก",
  duplicate_main_session: "มีชุดหลักซ้ำในวันเดียวกัน",
  session_parser_errors: "อ่านข้อความไม่ครบ",
  session_item_count_mismatch: "จำนวนรายการที่บันทึกไม่ตรง",
  session_rows_missing: "ชุดนี้ไม่มีรายการที่บันทึกไว้เลย",
  session_date_missing: "ชุดนี้ไม่มีวันที่กำกับ",
  produce_message_never_landed: "มีข้อความชั่งที่ไม่ได้ถูกบันทึก",
  missing_central_price: "ไม่มีราคากลาง",
  central_price_conflict: "ราคากลางขัดแย้ง รอผู้ดูแลยืนยัน",
};

const UNRESOLVED_MARKET_LABEL = "ไม่ระบุตลาด";

/** The three states a market block can be in. One block, one verdict. */
export const SALES_MARKET_VERIFIED = "✅ ยืนยันครบ";
export const SALES_MARKET_PARTIAL = "⚠️ ยืนยันได้บางส่วน";
export const SALES_MARKET_BLOCKED = "⛔ ยังปิดยอดไม่ได้";
export const SALES_MARKET_CONFIRMED_PREFIX = "ยอดที่ยืนยันแล้ว";
export const SALES_MARKET_EXCLUDED_HEADING = "ยังไม่รวม:";
export const SALES_MARKET_CAUSE_HEADING = "สาเหตุ:";
export const SALES_MARKET_PENDING_PRICE_HEADING = "รอตรวจราคา:";
export const SALES_MARKET_PENDING_RETURN_HEADING = "รอข้อมูลคืน:";
/** Printed in every market block when a day-level blocker exists (see above). */
export const SALES_MARKET_SCOPE_CAVEAT = "• ข้อมูลบางส่วนของวันนี้ยังไม่ครบ (ดูหัวข้อด้านบน)";

/**
 * Markets merged by their display label.
 *
 * One real market can reach the calculator under more than one key: a
 * round-keyed identity for documents bound to a P2E round, and the legacy
 * (source + label) identity for those that are not. Rendering them as separate
 * lines is what produced Production's confusing pair —
 *
 *   ตลาด72 — ยอดเงินยังคำนวณไม่ได้
 *   ตลาด72 — 8,186.50 บาท (บางส่วน)
 *
 * — two lines about one market, neither of them the whole answer. The keys stay
 * distinct inside the calculator (they are different provenance and must not be
 * merged there); only the presentation joins them, and the joined subtotal is
 * an exact sum of the same satang integers, so nothing is re-derived.
 *
 * A label that spans several LINE sources already carries a source suffix from
 * resolveDisplayLabels, so this can never merge two genuinely different markets.
 */
export interface SalesMarketGroup {
  marketLabel: string;
  rows: SalesIdentityRow[];
  total: SalesTotal;
}

function mergeTotals(totals: readonly SalesTotal[]): SalesTotal {
  return totals.reduce<SalesTotal>(
    (merged, total) => ({
      expectedSalesSatang: merged.expectedSalesSatang + total.expectedSalesSatang,
      pendingReviewSalesSatang:
        merged.pendingReviewSalesSatang + total.pendingReviewSalesSatang,
      totalSalesSatang: merged.totalSalesSatang + total.totalSalesSatang,
      adjustmentSatang: merged.adjustmentSatang + total.adjustmentSatang,
      quantityAuthoritative: merged.quantityAuthoritative && total.quantityAuthoritative,
      valueAuthoritative: merged.valueAuthoritative && total.valueAuthoritative,
      trustedRowCount: merged.trustedRowCount + total.trustedRowCount,
      valueBlockedRowCount: merged.valueBlockedRowCount + total.valueBlockedRowCount,
      quantityBlockedRowCount: merged.quantityBlockedRowCount + total.quantityBlockedRowCount,
    }),
    {
      expectedSalesSatang: 0,
      pendingReviewSalesSatang: 0,
      totalSalesSatang: 0,
      adjustmentSatang: 0,
      quantityAuthoritative: true,
      valueAuthoritative: true,
      trustedRowCount: 0,
      valueBlockedRowCount: 0,
      quantityBlockedRowCount: 0,
    },
  );
}

export function groupMarketsByLabel(report: SalesReport): SalesMarketGroup[] {
  const groups = new Map<string, { rows: SalesIdentityRow[]; totals: SalesTotal[] }>();

  for (const market of report.markets) {
    const label = marketLabel(market);
    const group = groups.get(label) ?? { rows: [], totals: [] };
    group.rows.push(...market.rows);
    group.totals.push(market.total);
    groups.set(label, group);
  }

  return [...groups]
    .map(([label, group]) => ({
      marketLabel: label,
      rows: group.rows,
      total: mergeTotals(group.totals),
    }))
    .sort((a, b) => a.marketLabel.localeCompare(b.marketLabel, "th"));
}

/**
 * A market's verdict, from its ROWS rather than its total's trust flags.
 *
 * The flags also carry the day-wide scope demotion, which would paint every
 * market partial the moment one unattributable document exists — burying the
 * market that is actually broken. Scope blockers keep their own section; this
 * says only what is true about this market's own identities.
 */
export function marketVerdict(group: SalesMarketGroup): "verified" | "partial" | "blocked" {
  if (group.total.quantityBlockedRowCount > 0) return "blocked";
  if (group.total.valueBlockedRowCount > 0) return "partial";
  return "verified";
}

export function salesReasonLabel(reason: SalesBlockReason): string {
  return REASON_LABELS[reason];
}

function scopeBlockerLabel(blocker: SalesScopeBlocker): string {
  if (blocker.kind === "unresolved_pending_session") {
    return `มีชุดข้อมูลที่ยังไม่ปิด/ปิดไม่สำเร็จ ${blocker.count} ชุด`;
  }
  if (blocker.kind === "unattributable_session") {
    return `มีชุดรายการที่บันทึกไม่ครบและระบุตลาดไม่ได้ ${blocker.count} ชุด`;
  }
  return `มีข้อความที่อ่านไม่สำเร็จ ${blocker.count} ข้อความ`;
}

function marketLabel(row: { marketLabel: string }): string {
  return row.marketLabel || UNRESOLVED_MARKET_LABEL;
}

function unitLabel(unit: string): string {
  return displayRemainingUnit(unit);
}

/**
 * A total plus its heading. The heading is the safety mechanism: an
 * authoritative figure is a total, anything else is explicitly partial.
 */
function totalBlock(
  heading: string,
  total: SalesTotal,
  withCounts = true,
  partial: { heading?: string; notice?: string } = {},
): string {
  const lines = [
    total.valueAuthoritative ? heading : (partial.heading ?? SALES_PARTIAL_HEADING),
    // Nothing is priced yet: "0.00 บาท" would read as zero revenue, which is a
    // different (and false) claim from "the value is not calculable".
    total.trustedRowCount === 0
      && total.pendingReviewSalesSatang === 0
      && !total.valueAuthoritative
      ? SALES_VALUE_UNAVAILABLE
      : `${satangToBahtText(total.totalSalesSatang)} บาท`,
  ];
  if (total.pendingReviewSalesSatang > 0) {
    lines.push(
      `ยืนยันแล้ว ${satangToBahtText(total.expectedSalesSatang)} บาท`,
      `รอตรวจ ${satangToBahtText(total.pendingReviewSalesSatang)} บาท`,
    );
  }
  if (total.adjustmentSatang !== 0) {
    lines.push(`ปรับราคา ${satangToBahtText(total.adjustmentSatang)} บาท`);
  }
  if (!total.valueAuthoritative) {
    if (partial.notice) lines.push(partial.notice);
    const blocked = total.valueBlockedRowCount + total.quantityBlockedRowCount;
    // The Auto report states these counts on their own lines and passes
    // withCounts=false, so the figure is never printed twice.
    if (withCounts) {
      lines.push(`ยืนยันได้ ${total.trustedRowCount} รายการ • ยืนยันไม่ได้ ${blocked} รายการ`);
    }
    // Quantity trust survives a pricing problem, and saying so is the point of
    // separating the two: "we know what was sold, not what it is worth".
    if (total.quantityAuthoritative) lines.push(SALES_QUANTITY_ONLY_NOTICE);
  }
  return lines.join("\n");
}

/** The headline total specifically — stronger partial wording, see SALES_PARTIAL_TOTAL_HEADING. */
function overallTotalBlock(total: SalesTotal, withCounts: boolean): string {
  return totalBlock(SALES_TOTAL_HEADING, total, withCounts, {
    heading: SALES_PARTIAL_TOTAL_HEADING,
    notice: SALES_PARTIAL_TOTAL_NOTICE,
  });
}

/** W / R / D / sold / central price / expected sales / status for one identity. */
function identityLines(row: SalesIdentityRow): string[] {
  const soldOut = isSoldOutByAbsentReturn(row);
  const lines = [
    `${row.productName} (${unitLabel(row.unit)})`,
    soldOut
      ? `เบิก ${formatQuantity(row.withdrawnQuantity)} • ${SALES_NO_RETURN_ROW_LABEL}`
      : `เบิก ${formatQuantity(row.withdrawnQuantity)} • คืน ${formatQuantity(row.goodReturnQuantity)}`
        + ` • เสีย ${formatQuantity(row.damagedReturnQuantity)}`,
  ];

  if (row.soldQuantity === null) {
    lines.push(`ขาย — (${row.reasons.map(salesReasonLabel).join(", ")})`);
    if (row.valueStatus === "PENDING_REVIEW" && row.pendingReviewSalesSatang !== null) {
      const pendingReason = row.reasons.includes("product_return_absent")
        || row.returnEvidenceIncomplete
        ? "รอข้อมูลคืน"
        : "รอตรวจ";
      lines.push(`มูลค่าชั่วคราว ${satangToBahtText(row.pendingReviewSalesSatang)} บาท (${pendingReason})`);
      if (row.adjustmentSatang !== 0) {
        lines.push(`ปรับจากราคาเดิม ${satangToBahtText(row.adjustmentSatang)} บาท`);
      }
    }
    return lines;
  }

  lines.push(
    soldOut
      ? `ขาย ${formatQuantity(row.soldQuantity)} ${unitLabel(row.unit)} (${SALES_SOLD_OUT_NO_RETURN_SUFFIX})`
      : `ขาย ${formatQuantity(row.soldQuantity)} ${unitLabel(row.unit)}`,
  );
  if (row.valueStatus === "PENDING_REVIEW" && row.pendingReviewSalesSatang !== null) {
    lines.push(
      `ราคาเดิม ${satangToBahtText(row.enteredPriceSatang ?? 0)} → ${satangToBahtText(row.pendingReviewSalesSatang)} บาท (รอตรวจ)`,
    );
    return lines;
  }
  if (row.centralPriceSatang === null || row.expectedSalesSatang === null) {
    lines.push(`ยอดขาย — (${row.reasons.map(salesReasonLabel).join(", ")})`);
    return lines;
  }
  lines.push(
    `ราคากลาง ${satangToBahtText(row.centralPriceSatang)} → ${satangToBahtText(row.expectedSalesSatang)} บาท`,
  );
  if (row.adjustmentSatang !== 0) {
    lines.push(`ปรับจากราคาเดิม ${satangToBahtText(row.adjustmentSatang)} บาท`);
  }
  return lines;
}

function marketBlock(group: SalesMarketGroup): string {
  return [
    `🏪 ${group.marketLabel}`,
    totalBlock(SALES_MARKET_TOTAL_HEADING, group.total),
    ...group.rows.sort(compareRowsForDisplay).flatMap(identityLines),
  ].join("\n");
}

function compareRowsForDisplay(a: SalesIdentityRow, b: SalesIdentityRow): number {
  return (
    a.productName.localeCompare(b.productName, "th") || a.unit.localeCompare(b.unit, "th")
  );
}

/**
 * The scheduled report's per-market block: ONE verdict, one subtotal, and an
 * explicit list of what the subtotal leaves out and why.
 *
 * This replaces the old "label — figure" line, which could not say what was
 * missing, and the separate reason-count section, which counted the same rows a
 * second time under a different heading.
 */
function marketStatusBlock(group: SalesMarketGroup, hasScopeBlockers: boolean): string {
  const verdict = marketVerdict(group);
  const unresolved = group.rows.filter((row) => row.status !== "TRUSTED");
  const pending = unresolved.filter((row) => row.valueStatus === "PENDING_REVIEW");
  const pendingReturn = pending.filter((row) =>
    row.reasons.includes("product_return_absent") || row.returnEvidenceIncomplete);
  const pendingPrice = pending.filter((row) => !pendingReturn.includes(row));
  const excluded = unresolved.filter((row) => row.valueStatus === "UNAVAILABLE");

  const lines = [`🏪 ${group.marketLabel}`];
  // A scope blocker is a document that could belong to ANY market, so no market
  // may claim to be complete while one exists. It never upgrades a verdict —
  // only ever withholds the "ยืนยันครบ" claim.
  if (verdict === "verified" && !hasScopeBlockers) {
    lines.push(SALES_MARKET_VERIFIED, `${SALES_MARKET_TOTAL_HEADING} ${valueText(group.total)}`);
    return lines.join("\n");
  }

  if (verdict === "verified") {
    lines.push(
      SALES_MARKET_PARTIAL,
      `${SALES_MARKET_CONFIRMED_PREFIX} ${satangToBahtText(group.total.expectedSalesSatang)} บาท`,
      SALES_MARKET_SCOPE_CAVEAT,
    );
    return lines.join("\n");
  }

  lines.push(verdict === "blocked" ? SALES_MARKET_BLOCKED : SALES_MARKET_PARTIAL);
  if (pending.length > 0) {
    lines.push(
      `${SALES_MARKET_TOTAL_HEADING} ${valueText(group.total)}`,
      `${SALES_MARKET_CONFIRMED_PREFIX} ${satangToBahtText(group.total.expectedSalesSatang)} บาท`,
      `ยอดรอตรวจ ${satangToBahtText(group.total.pendingReviewSalesSatang)} บาท`,
    );
  } else {
    lines.push(
      `${SALES_MARKET_CONFIRMED_PREFIX} ${satangToBahtText(group.total.expectedSalesSatang)} บาท`,
    );
  }
  for (const [heading, rows] of [
    [SALES_MARKET_PENDING_RETURN_HEADING, pendingReturn],
    [SALES_MARKET_PENDING_PRICE_HEADING, pendingPrice],
    [SALES_MARKET_EXCLUDED_HEADING, excluded],
  ] as const) {
    if (rows.length === 0) continue;
    lines.push(heading);
    for (const row of [...rows].sort(compareRowsForDisplay)) {
      const identity = row.isSessionPlaceholder
        ? row.productName
        : `${row.productName} (${unitLabel(row.unit)})`;
      lines.push(`• ${identity} — ${row.reasons.map(salesReasonLabel).join(", ")}`);
    }
  }
  if (hasScopeBlockers) lines.push(SALES_MARKET_SCOPE_CAVEAT);
  return lines.join("\n");
}

/**
 * Quantity and value carry their own "บางส่วน" marker, because they are trusted
 * independently: a product can have a complete sold quantity and a partial value
 * when one market is still missing its central price.
 */
function productLine(product: SalesProductSummary): string {
  const quantitySuffix = product.total.quantityAuthoritative ? "" : " (บางส่วน)";
  return (
    `${product.productName} (${unitLabel(product.unit)})`
    + ` — ขาย ${formatQuantity(product.soldQuantity)}${quantitySuffix}`
    + ` • ${valueText(product.total)}`
  );
}

/** Money for a subtotal: a figure, a partial figure, or an honest "not yet". */
function valueText(total: SalesTotal): string {
  if (
    total.trustedRowCount === 0
    && total.pendingReviewSalesSatang === 0
    && !total.valueAuthoritative
  ) return SALES_VALUE_UNAVAILABLE;
  const suffix = total.valueAuthoritative ? "" : " (บางส่วน)";
  return `${satangToBahtText(total.totalSalesSatang)} บาท${suffix}`;
}

/**
 * The Auto report used to end with blocked entries grouped as reason COUNTS,
 * separate from the per-market figures. Those counts described exactly the rows
 * the market lines already summarised, under a different heading and a
 * different grouping, so nothing reconciled: a header saying "ยืนยันไม่ได้ 10
 * รายการ" could not be traced to any ten visible lines. Each blocked row is now
 * named inside its own market block instead — see marketStatusBlock.
 */

/** One line per blocked identity. Every blocked entry is listed — never a sample. */
function blockedLine(row: SalesIdentityRow): string {
  const reasons = row.reasons.map(salesReasonLabel).join(", ");
  return (
    `${marketLabel(row)} • ${row.productName} (${unitLabel(row.unit)})`
    + ` — ${reasons} [เบิก ${formatQuantity(row.withdrawnQuantity)}`
    + ` • คืน ${formatQuantity(row.goodReturnQuantity)}`
    + ` • เสีย ${formatQuantity(row.damagedReturnQuantity)}]`
  );
}

function headerBlock(title: string, report: SalesReport): string {
  return [title, `ข้อมูลวันที่ ${formatThaiDate(report.businessDate)}`].join("\n");
}

function scopeBlockerBlocks(report: SalesReport): string[] {
  if (report.scopeBlockers.length === 0) return [];
  return [
    [SALES_SCOPE_BLOCKER_HEADING, ...report.scopeBlockers.map(scopeBlockerLabel)].join("\n"),
  ];
}

function blockedBlocks(report: SalesReport): string[] {
  if (report.blocked.length === 0) return [];
  return [[SALES_BLOCKED_HEADING, ...report.blocked.map(blockedLine)].join("\n")];
}

function productBlocks(report: SalesReport): string[] {
  if (report.products.length === 0) return [];
  return [[SALES_PRODUCT_SECTION_HEADING, ...report.products.map(productLine)].join("\n")];
}

function hasNoRows(report: SalesReport): boolean {
  return report.markets.length === 0 && report.blocked.length === 0;
}

/**
 * How many market+product+unit identities are sold out purely by absence of
 * a return row. `market.rows` already carries one row per identity — TRUSTED
 * and VALUE_BLOCKED alike, aggregation done once in the calculator — so this
 * never re-derives a quantity, only counts what is already there.
 */
function soldOutByAbsentReturnCount(report: SalesReport): number {
  return report.markets.flatMap((market) => market.rows).filter(isSoldOutByAbsentReturn).length;
}

/**
 * The opening blocks when the day produced no sales rows at all.
 *
 * With nothing missing, that is a real answer: no sales. With a scope blocker
 * present it is NOT — the rows may simply never have landed — so the report
 * says so and lists every blocker. Returns [] when there are rows to report.
 */
function noRowsBlocks(report: SalesReport, header: string): string[] {
  if (!hasNoRows(report)) return [];
  if (report.scopeBlockers.length === 0) return [`${header}\n\n${SALES_EMPTY_NOTICE}`];
  return [`${header}\n\n${SALES_NO_ROWS_BLOCKED_NOTICE}`, ...scopeBlockerBlocks(report)];
}

/**
 * Manual `สรุปยอดขาย` blocks.
 *
 * Order is deliberate: the answer first, then what is not trustworthy about it,
 * then the per-market working, then the per-product roll-up. A LINE reply is
 * capped at five messages, so what a human most needs has to arrive first.
 */
export function buildSalesSummaryBlocks(report: SalesReport): string[] {
  const header = headerBlock(SALES_MANUAL_TITLE, report);
  if (hasNoRows(report)) return noRowsBlocks(report, header);

  return [
    `${header}\n\n${overallTotalBlock(report.allMarkets, true)}`,
    ...scopeBlockerBlocks(report),
    ...blockedBlocks(report),
    ...groupMarketsByLabel(report).map(marketBlock),
    ...productBlocks(report),
  ];
}

export function buildSalesSummaryMessages(
  report: SalesReport,
  options: { maxCodePoints?: number; maxMessages?: number } = {},
): string[] {
  const messages = chunkBlocks(
    buildSalesSummaryBlocks(report),
    options.maxCodePoints ?? LINE_MESSAGE_MAX_CODE_POINTS,
  );
  return capAtMaxMessages(messages, options.maxMessages, SALES_OVERFLOW_NOTICE);
}

/**
 * True when the scheduled report has nothing to show AND nothing is known to be
 * missing — the only case where pointing at the latest date we do have is
 * honest. With a scope blocker present the day is not empty, it is unproven, and
 * that keeps its own wording.
 */
export function salesAutoNeedsLatestDataHint(report: SalesReport): boolean {
  return hasNoRows(report) && report.scopeBlockers.length === 0;
}

/**
 * The scheduled 08:10 report.
 *
 * Same numbers, different shape: the per-identity working is dropped in favour
 * of product and market roll-ups, but every blocked entry is still listed in
 * full. Nothing is ever dropped to fit a message budget — this is a push, so
 * the day gets as many parts as it needs.
 *
 * `latest` is the empty state's context block and is used ONLY there — a day
 * with sales renders exactly as before, whatever is passed. It defaults to
 * "unavailable" rather than "none" on purpose: a caller that did not look
 * cannot claim there is no sales history.
 */
export function buildSalesAutoBlocks(
  report: SalesReport,
  latest: LatestDataLookup = { status: "unavailable" },
): string[] {
  const header = headerBlock(SALES_AUTO_TITLE, report);
  if (salesAutoNeedsLatestDataHint(report)) {
    return [
      [
        header,
        `${SALES_NO_DATA_PREFIX} ${formatThaiDate(report.businessDate)}`,
        latestDataBlock(latest, SALES_NO_HISTORY_NOTICE),
      ].join("\n\n"),
    ];
  }
  if (hasNoRows(report)) return noRowsBlocks(report, header);

  // WHAT ONE "รายการ" IS, everywhere in this report: one market + product +
  // unit identity, after canonical product and unit resolution — exactly one
  // SalesIdentityRow. Not a transaction row, not a message, not a session.
  //
  // Because of that the three counts below partition the same set:
  //   ยืนยันได้     TRUSTED rows
  //   ยืนยันไม่ได้   VALUE_BLOCKED + QUANTITY_BLOCKED rows
  // and every row in the second group is printed by name inside its market
  // block, so "ยืนยันไม่ได้ 10 รายการ" always has ten lines a human can point
  // at. ถือว่าขายหมด is a SUBSET of ยืนยันได้/ยืนยันไม่ได้, never a third bucket.
  const soldOutCount = soldOutByAbsentReturnCount(report);
  const counts = [
    `✅ ยืนยันได้ ${report.allMarkets.trustedRowCount} รายการ`,
    `⚠️ ยืนยันไม่ได้ ${report.allMarkets.valueBlockedRowCount + report.allMarkets.quantityBlockedRowCount} รายการ`,
    // Sold out by absence of return is a valid sale, not a blocker — its own
    // line, never folded into ยืนยันไม่ได้ or the blocked-reason section.
    ...(soldOutCount > 0 ? [`✅ ${SALES_SOLD_OUT_NO_RETURN_LABEL} — ${soldOutCount} รายการ`] : []),
  ].join("\n");

  // One coherent block per market, in place of the old figure-only line plus a
  // separate reason-count section: the same rows were previously described in
  // two places and reconciled in neither.
  const hasScopeBlockers = report.scopeBlockers.length > 0;
  const marketBlocks = groupMarketsByLabel(report).map((group) =>
    marketStatusBlock(group, hasScopeBlockers),
  );

  return [
    `${header}\n\n${overallTotalBlock(report.allMarkets, false)}\n\n${counts}`,
    ...scopeBlockerBlocks(report),
    // The section heading rides with the first market so LINE chunking can
    // never place a bare heading at the end of one message.
    ...(marketBlocks.length > 0
      ? [`${SALES_MARKET_SECTION_HEADING}\n\n${marketBlocks[0]}`, ...marketBlocks.slice(1)]
      : []),
  ];
}

export function buildSalesAutoMessages(
  report: SalesReport,
  options: { maxCodePoints?: number; latest?: LatestDataLookup } = {},
): string[] {
  return chunkBlocks(
    buildSalesAutoBlocks(report, options.latest),
    options.maxCodePoints ?? LINE_MESSAGE_MAX_CODE_POINTS,
  );
}
