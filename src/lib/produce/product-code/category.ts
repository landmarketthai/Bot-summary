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

/**
 * Admin-approved runtime CATEGORY rules (produce_category_rules). Exact NFC
 * name → category only: never identity, never a product code. "other" marks a
 * reviewed legitimate other. Every report surface reads these through
 * approvedCategoryFor so one approval reaches Stock Summary, Morning Brief,
 * PDF and LINE category totals without a deployment.
 */
export type ApprovedCategoryCode = Exclude<ReportCategoryId, typeof UNCATEGORIZED_CATEGORY_ID> | "other";
export const APPROVED_CATEGORY_CODES: readonly ApprovedCategoryCode[] = ["ท", "ม", "ผ", "ป", "ห", "พ", "other"];

/** Dictionary category names (dictionary.csv `category`) per code. */
export const DICTIONARY_CATEGORY_NAME: Record<ApprovedCategoryCode, string> = {
  ท: "ทุเรียน",
  ม: "ผลไม้",
  ผ: "ผัก / สมุนไพร / เครื่องประกอบอาหาร",
  ป: "ปลา / อาหารแห้ง / ของแห้ง",
  ห: "เห็ด",
  พ: "รายการพิเศษ",
  other: "อื่นๆ",
};

/**
 * Business-approved rules shipped in code; admin rules from the database are
 * layered on top. Category only — มะละกอดิบ (green papaya, vegetable) and
 * มะละกอ (ripe papaya, fruit) stay two separate products.
 */
const BUSINESS_CATEGORY_RULES: ReadonlyArray<readonly [string, ApprovedCategoryCode]> = [
  ["มะละกอดิบ", "ผ"],
  // Legitimately "other" per business; listed so it never raises a review.
  // (ปลาทู / ขนมจีน are already ป in the code table.)
  ["เต้าหู้แผ่น", "other"],
];

/** One complete, immutable rule set. A report reads exactly one for its whole run. */
export type CategoryPolicy = ReadonlyMap<string, ApprovedCategoryCode>;

/** Business rules + the given admin rows. Never mutated after it is built. */
export function buildCategoryPolicy(rules: Iterable<readonly [string, string]>): CategoryPolicy {
  const policy = new Map<string, ApprovedCategoryCode>(BUSINESS_CATEGORY_RULES);
  for (const [name, code] of rules) {
    const key = name.normalize("NFC").trim();
    if (key && (APPROVED_CATEGORY_CODES as readonly string[]).includes(code)) {
      policy.set(key, code as ApprovedCategoryCode);
    }
  }
  return policy;
}

export const BUSINESS_CATEGORY_POLICY: CategoryPolicy = buildCategoryPolicy([]);

/**
 * Where the current report's policy comes from. This module stays free of
 * server-only imports; category-learning/rules.ts registers a per-request
 * (AsyncLocalStorage) source. Outside a report run — e.g. session-close
 * receipts on the ingestion path — only the shipped business rules apply.
 */
let policySource: () => CategoryPolicy | undefined = () => undefined;

export function setCategoryPolicySource(source: () => CategoryPolicy | undefined): void {
  policySource = source;
}

export function approvedCategoryFor(productName: string): ApprovedCategoryCode | undefined {
  return (policySource() ?? BUSINESS_CATEGORY_POLICY).get(productName.normalize("NFC").trim());
}

/** Dictionary entry for an exact canonical name, or null if unknown. */
export function dictionaryEntryFor(productName: string): ProductCodeEntry | null {
  const key = productName.normalize("NFC").trim();
  if (!key) return null;
  return BY_CANONICAL_NAME.get(key) ?? null;
}

/**
 * Resolve a (already identity-normalized) product name to a report category.
 * Unknown / blank names return ไม่จัดหมวด. Never guesses.
 */
export function dictionaryCategoryFor(productName: string): ReportCategoryId {
  const approved = approvedCategoryFor(productName);
  if (approved) return approved === "other" ? UNCATEGORIZED_CATEGORY_ID : approved;
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
