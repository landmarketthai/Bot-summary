/**
 * Explicit fruit / vegetable / other classification by EXACT product name.
 *
 * Nothing is fruit merely for not being a vegetable. The code table decides
 * first; its mixed "รายการพิเศษ" packs are assigned one by one; names the code
 * table does not know fall back to the explicit stock category map. Durian is
 * fruit; fish / dry goods, unmapped special packs and unknown names are "other".
 */
import { PRODUCT_CODE_ENTRIES } from "@/lib/produce/product-code/dictionary";
import { stockCategoryFor } from "@/lib/summary/stock-categories";

const CATEGORY_BY_EXACT_NAME = new Map(
  PRODUCT_CODE_ENTRIES.filter((entry) => entry.enabled).map((entry) => [entry.canonicalName, entry.category] as const),
);

const VEGETABLE_CODE_CATEGORIES: ReadonlySet<string> = new Set([
  "ผัก / สมุนไพร / เครื่องประกอบอาหาร",
  "เห็ด",
]);

/**
 * The code table's รายการพิเศษ mixes packed fruit and packed vegetables, so
 * each special item is assigned by exact name. A new special item lands in
 * "other" until it is added here — never silently in fruit.
 */
const SPECIAL_FRUIT: ReadonlySet<string> = new Set(["ผลไม้กล่อง", "ขนุนแพ็ค", "ส้มโอแพ็ค", "สับปะรดแบบหัว"]);
const SPECIAL_VEGETABLE: ReadonlySet<string> = new Set(["บวบหอมแพ็ค", "แตงร้านถุง", "มะระถุง"]);

/** Business-approved Morning Brief classifications for exact field spellings. */
const BUSINESS_FRUIT: ReadonlySet<string> = new Set([
  "กล้วยน้ำหว้า",
  "ลูกพลุน",
  "ลูกพรุน",
  "ลูกไหนดำแดง",
  "องุ่นมีเม็ด",
]);
const BUSINESS_VEGETABLE: ReadonlySet<string> = new Set(["กันจอง"]);

export type ProduceSection = "fruit" | "vegetable" | "other";
export const PRODUCE_SECTIONS: readonly ProduceSection[] = ["fruit", "vegetable", "other"];
export const PRODUCE_SECTION_LABEL: Record<ProduceSection, string> = {
  fruit: "ผลไม้", vegetable: "ผัก", other: "อื่นๆ",
};

export function produceSectionOf(productName: string): ProduceSection {
  if (BUSINESS_FRUIT.has(productName)) return "fruit";
  if (BUSINESS_VEGETABLE.has(productName)) return "vegetable";

  const category = CATEGORY_BY_EXACT_NAME.get(productName);
  if (category === "ผลไม้" || category === "ทุเรียน") return "fruit";
  if (category !== undefined && VEGETABLE_CODE_CATEGORIES.has(category)) return "vegetable";
  if (category === "รายการพิเศษ") {
    return SPECIAL_FRUIT.has(productName) ? "fruit" : SPECIAL_VEGETABLE.has(productName) ? "vegetable" : "other";
  }
  // ปลา / อาหารแห้ง / ของแห้ง stay outside fruit and vegetable totals.
  if (category !== undefined) return "other";
  const stock = stockCategoryFor(productName);
  return stock === "ผลไม้" || stock === "ทุเรียน" ? "fruit" : stock === "ผัก" ? "vegetable" : "other";
}

/** The code-table category by exact name, or undefined when the table does not list it. */
export function codeTableCategory(productName: string): string | undefined {
  return CATEGORY_BY_EXACT_NAME.get(productName);
}
