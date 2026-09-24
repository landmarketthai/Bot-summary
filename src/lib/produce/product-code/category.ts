/**
 * Authoritative product → category mapping for the 08:00 good-return report.
 *
 * Source of truth: the approved Produce Product Code Dictionary
 * (`dictionary.ts`, generated from `dictionary.csv`). This is a lookup, not an
 * allowlist — unknown products stay visible as ไม่จัดหมวด.
 *
 * Exact NFC match on the canonical dictionary name only. No substring, no
 * "starts with", no durian-marker guessing, no fuzzy category from words.
 * Reviewed aliases (PRODUCT_ALIASES) may rewrite identity BEFORE this lookup;
 * this module does not invent aliases and does not mutate the displayed name.
 */

import { PRODUCT_CODE_ENTRIES, type ProductCodeEntry } from "./dictionary";
import { runtimeProductCodeEntryForName } from "./resolver";

export const UNCATEGORIZED_CATEGORY_ID = "uncategorized" as const;

/** Dictionary category codes plus the explicit uncategorized bucket. */
export type ReportCategoryId =
  | "ท"
  | "ม"
  | "ผ"
  | "ป"
  | "ห"
  | "พ"
  | typeof UNCATEGORIZED_CATEGORY_ID;

export const REPORT_CATEGORY_ORDER: readonly ReportCategoryId[] = [
  "ท",
  "ม",
  "ผ",
  "ป",
  "ห",
  "พ",
  UNCATEGORIZED_CATEGORY_ID,
];

/**
 * LINE heading labels. ผ keeps its dictionary semantics
 * (ผัก / สมุนไพร / เครื่องประกอบอาหาร); the heading stays concise.
 */
export const REPORT_CATEGORY_LABEL: Record<ReportCategoryId, string> = {
  ท: "ทุเรียน",
  ม: "ผลไม้",
  ผ: "ผัก",
  ป: "ปลา / อาหารแห้ง / ของแห้ง",
  ห: "เห็ด",
  พ: "รายการพิเศษ",
  [UNCATEGORIZED_CATEGORY_ID]: "ไม่จัดหมวด",
};

export const REPORT_CATEGORY_EMOJI: Record<ReportCategoryId, string> = {
  ท: "🥭",
  ม: "🍉",
  ผ: "🥬",
  ป: "🐟",
  ห: "🍄",
  พ: "📦",
  [UNCATEGORIZED_CATEGORY_ID]: "❓",
};

const DICTIONARY_CATEGORY_IDS = new Set<ReportCategoryId>(["ท", "ม", "ผ", "ป", "ห", "พ"]);

function isDictionaryCategoryId(code: string): code is Exclude<ReportCategoryId, typeof UNCATEGORIZED_CATEGORY_ID> {
  return DICTIONARY_CATEGORY_IDS.has(code as ReportCategoryId);
}

function buildCanonicalMap(): ReadonlyMap<string, ProductCodeEntry> {
  const map = new Map<string, ProductCodeEntry>();
  for (const entry of PRODUCT_CODE_ENTRIES) {
    const key = entry.canonicalName.normalize("NFC").trim();
    if (!key) continue;
    const existing = map.get(key);
    // First writer wins, except an enabled row may replace a retired one so a
    // still-current code keeps its category if a retired duplicate exists.
    if (!existing) map.set(key, entry);
    else if (!existing.enabled && entry.enabled) map.set(key, entry);
  }
  return map;
}

const BY_CANONICAL_NAME = buildCanonicalMap();

/** Dictionary entry for an exact canonical name, or null if unknown. */
export function dictionaryEntryFor(productName: string): ProductCodeEntry | null {
  const key = productName.normalize("NFC").trim();
  if (!key) return null;
  return BY_CANONICAL_NAME.get(key) ?? runtimeProductCodeEntryForName(key);
}

/**
 * Resolve a (already identity-normalized) product name to a report category.
 * Unknown / blank names return ไม่จัดหมวด. Never guesses.
 */
export function dictionaryCategoryFor(productName: string): ReportCategoryId {
  const entry = dictionaryEntryFor(productName);
  if (!entry) return UNCATEGORIZED_CATEGORY_ID;
  return isDictionaryCategoryId(entry.categoryCode) ? entry.categoryCode : UNCATEGORIZED_CATEGORY_ID;
}

export function reportCategoryHeading(id: ReportCategoryId): string {
  return `${REPORT_CATEGORY_EMOJI[id]} ${REPORT_CATEGORY_LABEL[id]}`;
}

export function reportCategoryIndex(id: ReportCategoryId): number {
  const index = REPORT_CATEGORY_ORDER.indexOf(id);
  return index === -1 ? REPORT_CATEGORY_ORDER.length : index;
}
