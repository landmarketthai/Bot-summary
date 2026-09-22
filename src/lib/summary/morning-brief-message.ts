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

export const MORNING_BRIEF_TITLE = "🌅 สรุปเช้า";
export const MORNING_BRIEF_OVERFLOW_NOTICE =
  "\n\nรายละเอียดมากเกินขีดจำกัด LINE จึงแสดงได้ไม่ครบ";

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
    return (duplicateCounts.get(item.productName) ?? 0) > 1 ? `${name} (${item.unit})` : name;
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

/**
 * Actionable purchase groups only. Unassessable items are one count in the
 * review block; their per-product detail lives in the PDF, never in LINE.
 */
function buildPurchaseBlocks(report: MorningBriefReport): string[] {
  const { strong, surplus, reduce } = report.purchasePlanning;
  const groups: string[] = [];
  if (strong.count > 0) groups.push(purchaseGroupBlock("🟢", "ควรซื้อเพิ่ม", strong));
  if (surplus.count > 0) groups.push(purchaseGroupBlock("🟠", "ยังไม่ควรซื้อเพิ่ม", surplus));
  if (reduce.count > 0) groups.push(purchaseGroupBlock("🔴", "ควรลดการซื้อ", reduce));
  return [
    "🛒 แผนซื้อผลไม้",
    "เกณฑ์ของเหลือพร้อมขาย = ชั่งคืนดี + Stock บ้าน",
    ...(groups.length > 0 ? groups : ["ยังไม่มีรายการแนะนำ"]),
  ];
}

/** Money only, and always the first body block so it lands in Part 1. Zero lines are omitted. */
function buildSalesBlock(report: MorningBriefReport): string {
  return [
    "💰 ภาพรวมเงิน",
    `ยอดขายรวม ${satangToBahtText(report.sales.totalSalesSatang)} บาท`,
  ].join("\n");
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
  if (stock.status === "unavailable") return "🏠 ของในบ้าน\nยังตรวจสต๊อกบ้านไม่ได้";

  const header = [
    `🏠 ของในบ้าน — ${stock.groupCount} รายการ`,
    `มูลค่ารวม ${satangToBahtText(stock.totalValueSatang)} บาท`,
  ].join("\n");
  const details = stock.items ?? [];
  const sections = [...groupByCategory(details).values()].map(houseCategorySection);
  return [header, ...sections].join("\n\n");
}

export function buildMorningBriefBlocks(report: MorningBriefReport): string[] {
  return [
    `${MORNING_BRIEF_TITLE} — ${formatThaiDate(report.businessDate)}`,
    buildSalesBlock(report),
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
