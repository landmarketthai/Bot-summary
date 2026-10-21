import { formatThaiDate } from "@/lib/date";
import { satangToBahtText } from "@/lib/sales/calculate";
import { formatQuantity } from "@/lib/summary/remaining-fruit";
import {
  LINE_REPLY_MAX_MESSAGES,
} from "@/lib/summary/line-chunking";
import type {
  MorningBriefHouseStockItem,
  MorningBriefPurchaseGroup,
  MorningBriefPurchaseItem,
  MorningBriefReport,
} from "@/lib/summary/morning-brief";

import { PRODUCE_SECTIONS, PRODUCE_SECTION_LABEL } from "@/lib/summary/produce-section";

export const MORNING_BRIEF_TITLE = "🌅 สรุปเช้า";
export const MORNING_BRIEF_OVERFLOW_NOTICE =
  "\n\nรายละเอียดเพิ่มเติมอยู่ใน PDF A4";

const PRODUCT_NAME_MAX_CODE_POINTS = 80;

function boundedProductName(name: string): string {
  const codePoints = [...name];
  if (codePoints.length <= PRODUCT_NAME_MAX_CODE_POINTS) return name;
  return `${codePoints.slice(0, PRODUCT_NAME_MAX_CODE_POINTS - 1).join("")}…`;
}
function groupByCategory<T extends { category: string }>(items: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const bucket = groups.get(item.category) ?? [];
    bucket.push(item);
    groups.set(item.category, bucket);
  }
  return groups;
}

function displayUnit(unit: string): string {
  return unit === "โล" ? "กก." : unit;
}
function wrapNames(names: readonly string[], maxCodePoints = 180): string[] {
  const lines: string[] = [];
  let current = "";
  for (const name of names) {
    const candidate = current ? `${current}, ${name}` : name;
    if (current && [...candidate].length > maxCodePoints) { lines.push(current); current = name; }
    else current = candidate;
  }
  if (current) lines.push(current);
  return lines;
}

function actionableCategorySection(items: readonly MorningBriefPurchaseItem[]): string {
  const duplicateCounts = new Map<string, number>();
  for (const item of items) duplicateCounts.set(item.productName, (duplicateCounts.get(item.productName) ?? 0) + 1);
  const names = items.map((item) => {
    const name = boundedProductName(item.productName);
    return (duplicateCounts.get(item.productName) ?? 0) > 1 ? `${name} (${displayUnit(item.unit)})` : name;
  });
  return [`${items[0]?.category ?? "อื่นๆ"} — ${items.length} รายการ`, ...wrapNames(names)].join("\n");
}

function purchaseGroupBlock(icon: string, label: string, group: MorningBriefPurchaseGroup): string {
  const header = `${icon} ${label} — ${group.count} รายการ`;
  const details = group.items ?? [];
  if (details.length === 0) {
    return group.productNames.length > 0 ? `${header}\n${group.productNames.map(boundedProductName).join(", ")}` : header;
  }
  const sections = [...groupByCategory(details).values()].map(actionableCategorySection);
  return [header, ...sections].join("\n\n");
}

/** Actionable purchase groups only. Diagnostic/uncertainty reasons are never pushed to LINE. */
function buildPurchaseBlocks(report: MorningBriefReport): string[] {
  const { strong, surplus, reduce } = report.purchasePlanning;
  const groups: string[] = [];
  if (strong.count > 0) groups.push(purchaseGroupBlock("🟢", "ควรซื้อเพิ่ม", strong));
  if (surplus.count > 0) groups.push(purchaseGroupBlock("🟠", "ยังไม่ควรซื้อเพิ่ม", surplus));
  if (reduce.count > 0) groups.push(purchaseGroupBlock("🔴", "ควรลดการซื้อ", reduce));
  return ["🛒 แผนซื้อของ", ...(groups.length > 0 ? groups : ["ยังไม่มีรายการแนะนำ"])];
}

/** Money only, and always the first body block so it lands in Part 1. Zero lines are omitted. */
function buildSalesBlock(report: MorningBriefReport): string {
  if (report.produceReadiness?.transactionCount === 0) {
    return "💰 ภาพรวมเงิน\nยังไม่มีข้อมูลเบิก–ชั่งคืนสำหรับคำนวณยอดขาย";
  }
  const sales = report.sales;
  const lines = ["💰 ภาพรวมเงิน", `ยอดขายยืนยันแล้ว ${satangToBahtText(sales.confirmedSalesSatang)} บาท`];
  if (sales.pendingReviewSalesSatang !== 0) {
    lines.push(
      `ยอดรอตรวจ ${satangToBahtText(sales.pendingReviewSalesSatang)} บาท`,
      `ยอดขายคำนวณได้ (รวมรอตรวจ) ${satangToBahtText(sales.totalSalesSatang)} บาท`,
    );
  }
  if (sales.adjustmentSatang !== 0) lines.push(`ปรับราคา ${satangToBahtText(sales.adjustmentSatang)} บาท`);
  if (sales.excludedFromSalesCount > 0) lines.push(`ยังคำนวณไม่ได้ ${sales.excludedFromSalesCount} รายการ`);
  if (sales.awaitingReturnCount) lines.push(`รอชั่งคืน ${sales.awaitingReturnCount} รายการ`);
  return lines.join("\n");
}

function buildProduceFinancialBlocks(report: MorningBriefReport): string[] {
  if (report.produceReadiness?.transactionCount === 0) return [];
  return PRODUCE_SECTIONS.flatMap((section) => {
    const financial = report.produceFinancial?.[section];
    if (!financial) return [];
    return [[
      `${PRODUCE_SECTION_LABEL[section]} — ภาพรวมเงิน`,
      `ยอดขายยืนยันแล้ว ${satangToBahtText(financial.salesValueSatang)} บาท`,
      `ยอดรอตรวจ ${satangToBahtText(financial.pendingReviewSalesSatang ?? 0)} บาท`,
      ...(financial.pendingReviewSalesSatang ? [`ยอดขายคำนวณได้ (รวมรอตรวจ) ${satangToBahtText(financial.salesValueSatang + financial.pendingReviewSalesSatang)} บาท`] : []),
      ...(financial.awaitingReturnCount ? [`รอชั่งคืน ${financial.awaitingReturnCount} รายการ`] : []),
      `เบิก ${satangToBahtText(financial.withdrawalValueSatang)} บาท`,
      `ชั่งคืนดี ${satangToBahtText(financial.goodReturnValueSatang)} บาท`,
    ].join("\n")];
  });
}

function buildWhiteSheetDataBlock(report: MorningBriefReport): string | null {
  if (report.whiteSheetStatus !== "missing") return null;
  return "⚠️ ใบขาว\nยังไม่มีการกรอกใบขาวในระบบ";
}

function displayPrice(satang: number): string {
  return satangToBahtText(satang).replace(/\.00$/, "");
}
function houseCategorySection(items: readonly MorningBriefHouseStockItem[]): string {
  const lines = [`${items[0]?.category ?? "อื่นๆ"} — ${items.length} รายการ`];
  for (const item of items) {
    const unit = displayUnit(item.unit);
    lines.push(
      `• ${boundedProductName(item.productName)} — ${formatQuantity(item.quantity)} ${unit} • ${displayPrice(item.unitPriceSatang)} บาท/${unit} • มูลค่า ${satangToBahtText(item.valueSatang)} บาท`,
    );
  }
  return lines.join("\n");
}

function buildHouseStockBlock(report: MorningBriefReport): string {
  const stock = report.houseStock;
  if (stock.status === "missing") return "🏠 ของในบ้าน\nยังไม่มีข้อมูลสต๊อกบ้าน";
  if (stock.status === "unavailable") return "🏠 ของในบ้าน\nยังไม่มีข้อมูลสต๊อกบ้านสำหรับสรุปนี้";

  const header = [
    `🏠 ของในบ้าน — ${stock.groupCount} รายการ`,
    `มูลค่ารวม ${satangToBahtText(stock.totalValueSatang)} บาท`,
  ].join("\n");
  const details = stock.items ?? [];
  const sections = [...groupByCategory(details).values()].map(houseCategorySection);
  return [header, ...sections].join("\n\n");
}

/** Never conflate observed documents with markets verified complete. */
function buildDataReadinessBlock(report: MorningBriefReport): string | null {
  const evidence = report.produceReadiness;
  if (!evidence) return null;
  if (evidence.transactionCount === 0) {
    const stockStatus = report.houseStock.status === "available" ? "มีข้อมูลแล้ว"
      : report.houseStock.status === "unavailable" ? "ตรวจสอบไม่ได้ขณะนี้" : "ยังไม่มีข้อมูล";
    const whiteStatus = report.whiteSheetStatus === "entered" ? "มีข้อมูลแล้ว"
      : report.whiteSheetStatus === "unavailable" ? "ตรวจสอบไม่ได้ขณะนี้" : "ยังไม่มีข้อมูล";
    return [
      "⚠️ ยังไม่มีข้อมูลรายการเบิก–คืนสำหรับสรุปยอดขาย",
      "รายการเบิกสินค้า: ยังไม่มีข้อมูล",
      "รายการชั่งคืน: ยังไม่มีข้อมูล",
      `ใบขาว: ${whiteStatus}`,
      `สต็อกบ้าน: ${stockStatus}`,
      "ยังสรุปยอดขายไม่ได้ (ไม่ใช่ยอดขาย 0 บาท)",
    ].join("\n");
  }
  const missing = evidence.markets.flatMap((market) => {
    if (!market.hasWithdrawal) return [`${market.marketLabel}: ไม่พบรายการเบิก`];
    if (!market.hasReturn) return [`${market.marketLabel}: ไม่พบรายการชั่งคืน`];
    return [];
  });
  return [
    "📋 สถานะข้อมูลตลาด",
    ...(missing.length > 0 ? missing : ["ตลาดที่มีข้อมูล: พบทั้งเบิกและชั่งคืน"]),
    "หมายเหตุ: ยังไม่ได้รับการยืนยันว่าครบทุกตลาด",
  ].join("\n");
}

export function buildMorningBriefBlocks(report: MorningBriefReport): string[] {
  const whiteSheetDataBlock = buildWhiteSheetDataBlock(report);
  const readinessBlock = buildDataReadinessBlock(report);
  if (report.produceReadiness?.transactionCount === 0) {
    return [
      `${MORNING_BRIEF_TITLE}${report.reportScope ? ` (${report.reportScope === "fruit" ? "ผลไม้" : "ผัก"})` : ""} — ${formatThaiDate(report.businessDate)}`,
      readinessBlock!,
      ...(report.houseStock.status === "available" ? [buildHouseStockBlock(report)] : []),
    ];
  }
  return [
    `${MORNING_BRIEF_TITLE}${report.reportScope ? ` (${report.reportScope === "fruit" ? "ผลไม้" : "ผัก"})` : ""} — ${formatThaiDate(report.businessDate)}`,
    buildSalesBlock(report),
    ...buildProduceFinancialBlocks(report),
    ...(readinessBlock ? [readinessBlock] : []),
    ...(whiteSheetDataBlock ? [whiteSheetDataBlock] : []),
    ...buildPurchaseBlocks(report),
    buildHouseStockBlock(report),
  ];
}

export function buildMorningBriefMessage(report: MorningBriefReport): string {
  return buildMorningBriefBlocks(report).join("\n\n");
}

export const MORNING_BRIEF_PART_BODY_MAX_CODE_POINTS = 700;

function packMorningBody(text: string, maxCodePoints: number): string[] {
  const parts: string[] = [];
  let current = "";
  const flush = () => { if (current) { parts.push(current); current = ""; } };
  for (const line of text.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if ([...candidate].length <= maxCodePoints) { current = candidate; continue; }
    flush();
    if ([...line].length <= maxCodePoints) { current = line; continue; }
    const chars = [...line];
    for (let i = 0; i < chars.length; i += maxCodePoints) parts.push(chars.slice(i, i + maxCodePoints).join(""));
  }
  flush();
  return parts;
}

export function buildMorningBriefMessages(
  report: MorningBriefReport,
  options: { maxCodePoints?: number; maxMessages?: number } = {},
): string[] {
  const allBlocks = buildMorningBriefBlocks(report);
  const title = allBlocks[0]!;
  const maxCodePoints = options.maxCodePoints ?? MORNING_BRIEF_PART_BODY_MAX_CODE_POINTS;
  const body: string[] = [];
  let current = "";
  const flush = () => { if (current) { body.push(current); current = ""; } };
  for (const block of allBlocks.slice(1)) {
    const pieces = [...block].length <= maxCodePoints ? [block] : packMorningBody(block, maxCodePoints);
    for (const piece of pieces) {
      const candidate = current ? current + "\n\n" + piece : piece;
      if ([...candidate].length <= maxCodePoints) current = candidate;
      else { flush(); current = piece; }
    }
  }
  flush();
  const maxMessages = options.maxMessages ?? LINE_REPLY_MAX_MESSAGES;
  const shown = body.slice(0, maxMessages);
  if (body.length > maxMessages && shown.length > 0) shown[shown.length - 1] = `${shown[shown.length - 1]}${MORNING_BRIEF_OVERFLOW_NOTICE}`;
  if (shown.length === 1) return [`${title}\n\n${shown[0]}`];
  return shown.map((message, index) => `${title} • Part ${index + 1}/${shown.length}\n\n${message}`);
}
