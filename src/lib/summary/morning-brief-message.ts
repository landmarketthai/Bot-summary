import { formatThaiDate } from "@/lib/date";
import { satangToBahtText } from "@/lib/sales/calculate";
import { formatQuantity } from "@/lib/summary/remaining-fruit";
import type { PurchaseUncertaintyReason } from "@/lib/summary/purchase-planning";
import {
  LINE_REPLY_MAX_MESSAGES,
} from "@/lib/summary/line-chunking";
import type {
  MorningBriefHouseStockItem,
  MorningBriefPurchaseGroup,
  MorningBriefPurchaseItem,
  MorningBriefReport,
  MorningBriefSalesReviewItem,
} from "@/lib/summary/morning-brief";

export const MORNING_BRIEF_TITLE = "🌅 สรุปเช้า";
export const MORNING_BRIEF_OVERFLOW_NOTICE =
  "\n\n⚠️ รายละเอียดมากเกินขีดจำกัด LINE จึงแสดงได้ไม่ครบ";

const PRODUCT_NAME_MAX_CODE_POINTS = 80;

function boundedProductName(name: string): string {
  const codePoints = [...name];
  if (codePoints.length <= PRODUCT_NAME_MAX_CODE_POINTS) return name;
  return `${codePoints.slice(0, PRODUCT_NAME_MAX_CODE_POINTS - 1).join("")}…`;
}
const REASON_LABELS: Record<PurchaseUncertaintyReason, string> = {
  unattributed_round: "ยังผูกรอบเบิกไม่ได้",
  return_incomplete: "รายการคืน/คืนเสียของรอบยังไม่สมบูรณ์",
  return_missing: "ยังไม่มีข้อมูลคืนครบ",
  product_return_absent: "ยังยืนยันรายการคืนของสินค้านี้ไม่ได้",
  return_not_round_tagged: "รายการคืนยังไม่ผูกรอบ",
  session_integrity: "ข้อมูลต้นทางหรือจำนวนรายการไม่ครบ",
  returns_exceed_withdrawal: "ยอดคืนมากกว่ายอดเบิก",
  no_withdrawal: "ไม่พบยอดเบิกสำหรับรายการนี้",
  invalid_quantity: "จำนวนสินค้าไม่ถูกต้อง",
  unknown_transaction_type: "ประเภทรายการไม่รู้จัก",
  unattributable_withdrawal: "รายการเบิกยังระบุตัวตนไม่ครบ",
};

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

function unknownCategorySection(items: readonly MorningBriefPurchaseItem[]): string {
  const lines = [`${items[0]?.category ?? "อื่นๆ"} — ${items.length} รายการ`];
  for (const item of items) {
    const reasons = item.uncertaintyReasons.length > 0
      ? item.uncertaintyReasons.map((reason) => REASON_LABELS[reason]).join(", ")
      : "ยังระบุสาเหตุไม่ได้";
    lines.push(`• ${boundedProductName(item.productName)} (${displayUnit(item.unit)}) — ${reasons}`);
  }
  return lines.join("\n");
}

function purchaseGroupBlock(
  icon: string,
  label: string,
  group: MorningBriefPurchaseGroup,
  unknown = false,
): string {
  const header = `${icon} ${label} — ${group.count} รายการ`;
  const details = group.items ?? [];
  if (details.length === 0) {
    return group.productNames.length > 0 ? `${header}\n${group.productNames.map(boundedProductName).join(", ")}` : header;
  }
  const sections = [...groupByCategory(details).values()].map((items) =>
    unknown ? unknownCategorySection(items) : actionableCategorySection(items));
  return [header, ...sections].join("\n\n");
}
function buildPurchaseBlocks(report: MorningBriefReport): string[] {
  const { strong, surplus, reduce, unknown } = report.purchasePlanning;
  return [
    "🛒 แผนซื้อของ",
    purchaseGroupBlock("🟢", "ควรซื้อเพิ่ม", strong),
    purchaseGroupBlock("🟠", "ยังไม่ควรซื้อเพิ่ม", surplus),
    purchaseGroupBlock("🔴", "ควรลดการซื้อ", reduce),
    purchaseGroupBlock("⚠️", "ยังประเมินไม่ได้", unknown, true),
  ];
}

function buildSalesBlock(report: MorningBriefReport): string {
  const sales = report.sales;
  const amountLabel = sales.valueAuthoritative ? "ยอดขายรวม" : "⚠️ ยอดที่ยืนยันแล้ว";
  const lines = [
    "💰 ยอดขาย",
    `${amountLabel} ${satangToBahtText(sales.confirmedSalesSatang)} บาท`,
    `✅ ยืนยันได้ ${sales.trustedCount} รายการ • ⚠️ รอตรวจ ${sales.unresolvedCount} รายการ`,
  ];
  if (sales.soldOutCount > 0) {
    lines.push(`✅ ถือว่าขายหมดเพราะไม่มีรายการคืน — ${sales.soldOutCount} รายการ`);
  }
  return lines.join("\n");
}

function salesReviewSection(label: string, items: readonly MorningBriefSalesReviewItem[]): string {
  const byMarket = new Map<string, string[]>();
  for (const item of items) {
    const names = byMarket.get(item.marketLabel) ?? [];
    names.push(`${boundedProductName(item.productName)} (${displayUnit(item.unit)})`);
    byMarket.set(item.marketLabel, names);
  }
  const lines = [`${label} — ${items.length} รายการ`];
  for (const [market, names] of byMarket) lines.push(`• ${market}: ${wrapNames(names, 140).join("\n  ")}`);
  return lines.join("\n");
}

function buildSalesReviewBlock(report: MorningBriefReport): string | null {
  const items = report.sales.reviewItems ?? [];
  if (items.length === 0) return null;
  const price = items.filter((item) => item.reasons.includes("central_price_conflict"));
  const missingReturn = items.filter((item) => !item.reasons.includes("central_price_conflict") && item.reasons.includes("product_return_absent"));
  const known = new Set([...price, ...missingReturn]);
  const other = items.filter((item) => !known.has(item));
  const sections = [`⚠️ รายละเอียดรอตรวจ — ${items.length} รายการ`];
  if (price.length) sections.push(salesReviewSection("ราคากลางขัดแย้ง", price));
  if (missingReturn.length) sections.push(salesReviewSection("หลักฐานคืนของสินค้ายังยืนยันไม่ได้", missingReturn));
  if (other.length) sections.push(salesReviewSection("ต้องตรวจข้อมูลเพิ่มเติม", other));
  return sections.join("\n\n");
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
  if (stock.status === "unavailable") return "🏠 ของในบ้าน\n⚠️ ยังตรวจสต๊อกบ้านไม่ได้";

  const header = [
    `🏠 ของในบ้าน — ${stock.groupCount} รายการ`,
    `มูลค่ารวม ${satangToBahtText(stock.totalValueSatang)} บาท`,
  ].join("\n");
  const details = stock.items ?? [];
  const sections = [...groupByCategory(details).values()].map(houseCategorySection);
  return [header, ...sections].join("\n\n");
}

export function buildMorningBriefBlocks(report: MorningBriefReport): string[] {
  const blocks = [
    `${MORNING_BRIEF_TITLE} — ${formatThaiDate(report.businessDate)}`,
    ...buildPurchaseBlocks(report),
    buildSalesBlock(report),
  ];
  blocks.push(buildHouseStockBlock(report));

  const review = buildSalesReviewBlock(report);
  if (review) blocks.push(review);
  return blocks;
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
