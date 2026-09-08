/**
 * Product vocabulary — the approved dictionary read as a reference spelling
 * list, at withdrawal intake.
 *
 * The Product Code Dictionary is NOT an allowlist and does not become one here.
 * A genuinely new product must stay enterable; the shop sells things nobody has
 * registered yet and always will. What the dictionary *can* do is tell the
 * difference between a product nobody has registered and a product that is
 * registered under a spelling one character away:
 *
 *   มะม่วงเขียวมรกต   → known canonical name, nothing to say
 *   มะม่วงเขียวรกต    → suspicious. ม31 exists and is one character away
 *   ฝรั่งสายพันธุ์ใหม่ → unknown, and nothing in the dictionary is close
 *
 * The middle case is the one that poisons a withdrawal master: it silently
 * mints a second product identity, and the mistake only surfaces later when the
 * return is typed correctly and P4A refuses it as product_not_withdrawn.
 *
 * Reviewed deterministic aliases resolve before dictionary lookup. Everything
 * else in this module produces SUGGESTIONS. A near match is never proof of
 * identity — เขียวมรกต and เขียวมรกตเก่า are one token apart and are different
 * goods. Raw operator evidence is not rewritten.
 */

import { boundedEditDistance, normalizeUnitAlias } from "@/lib/parsers/weigh-session/units";
import { normalizeProductName, PRODUCT_ALIASES } from "@/lib/summary/remaining-fruit";
import { PRODUCT_CODE_ENTRIES } from "./product-code/dictionary";

export interface ProductVocabularySuggestion {
  readonly productCode: string;
  readonly canonicalName: string;
}

/** Enough to identify the mistake, few enough that the reply stays readable. */
const MAX_SUGGESTIONS = 3;

/** One or two wrong characters is a typo. Three is a different word. */
const MAX_TYPO_DISTANCE = 2;

/**
 * Shortest run of shared characters that can stand in for a whole missing word
 * (เขียวมรกต inside มะม่วงเขียวมรกต). Below this every long product name would
 * "match" every other one through a common syllable.
 */
const MIN_SHARED_RUN = 4;

/**
 * Basic text normalization only. Alias normalization is a separate explicit
 * step in resolveApprovedProductName, before the canonical dictionary lookup.
 */
function mechanical(name: string): string {
  return name.normalize("NFC").replace(/\s+/g, " ").trim();
}

/**
 * Approved spelling → its product code.
 *
 * Enabled rows only. A retired code stops resolving, and its canonical name
 * stops being an approved spelling with it — which costs one review press on a
 * product nobody registers any more, and errs toward asking a human.
 */
const CODE_BY_CANONICAL_NAME: ReadonlyMap<string, string> = new Map(
  PRODUCT_CODE_ENTRIES.filter((entry) => entry.enabled)
    .map((entry) => [mechanical(entry.canonicalName), entry.code] as const)
    .reverse(), // first code wins if two rows ever share a canonical name
);

export interface ApprovedProductResolution {
  readonly productCode: string;
  readonly canonicalName: string;
}

export type SafeAutoCorrectionReason =
  | "reviewed_alias"
  | "reviewed_typo";

export interface SafeAutoCorrectProductResolution extends ApprovedProductResolution {
  readonly reason: SafeAutoCorrectionReason;
}

/** Deterministic alias normalization followed by exact canonical lookup. */
export function resolveApprovedProductName(name: string): ApprovedProductResolution | null {
  const enteredName = mechanical(name);
  const exactCode = CODE_BY_CANONICAL_NAME.get(enteredName);
  if (exactCode) return { productCode: exactCode, canonicalName: enteredName };

  const canonicalName = mechanical(normalizeProductName(enteredName));
  const productCode = CODE_BY_CANONICAL_NAME.get(canonicalName);
  return productCode ? { productCode, canonicalName } : null;
}

/** Production-observed mechanical typos that are safe to fold exactly. */
const SAFE_AUTOCORRECT_ALIASES: Readonly<Record<string, string>> = {
  "กระปิ": "กะปิ",
  "ขิงออ่น": "ขิงอ่อน",
  "ฝักกระเจียบ": "ฝักกระเจี๊ยบ",
  "ใบกระเจียบ": "ใบกระเจี๊ยบ",
  "กวางตุ้งยี่ปุ่น": "กวางตุ้งญี่ปุ่น",
  "ใบต้งโอ้": "ใบตั้งโอ๋",
  "หน่อไม่ดอง": "หน่อไม้ดอง",
  "หน่อไม่ต้ม": "หน่อไม้ต้ม",
  "มะละกอก": "มะละกอ",
  "กระหล่ำปลี": "กะหล่ำปลี",
  "ใบกระเพรา": "ใบกะเพรา",
  "เครื่องผักฉ่า": "เครื่องผัดฉ่า",
  "ผักปรัง": "ผักปลัง",
  "มะกรุด": "มะกรูด",
  "คะน้าฮ้องกง": "คะน้าฮ่องกง",
  "เห็ดแพครวม": "เห็ดแพ็ครวม",
  "หอยเชลย์": "หอยเชลล์",
  "ฝักกระเจ๊ยบ": "ฝักกระเจี๊ยบ",
  "ใบกระเจ๊ยบ": "ใบกระเจี๊ยบ",
  "แก้งมังกร": "แก้วมังกร",
  "สับรด": "สับปะรด",
  "ใบตั้งโอ้": "ใบตั้งโอ๋",
  "คน้าใหญ่": "คะน้าใหญ่",
  "องุุ่นไข่ปลา": "องุ่นไข่ปลา",
  "แอปเปิ่ล": "แอปเปิ้ล",
  "น่อยหน่า": "น้อยหน่า",
  "มะม่วงฟ้าลั่่น": "มะม่วงฟ้าลั่น",
  "หัวไซเท้า": "หัวไชเท้า",
  "ทับมิม": "ทับทิม",
};

/** True when the name or a reviewed deterministic alias resolves. */
export function isApprovedProductName(name: string): boolean {
  return resolveApprovedProductName(name) !== null;
}

/** The code a canonical spelling or reviewed deterministic alias belongs to. */
export function approvedProductCode(name: string): string | null {
  return resolveApprovedProductName(name)?.productCode ?? null;
}

/**
 * Conservative automatic correction for persisted business identity.
 *
 * Only explicit reviewed aliases are automatic. Fuzzy/edit-distance matches
 * remain suggestions for a human; a one-character difference can still be a
 * different SKU in this shop.
 */
export function resolveSafeAutoCorrectProductName(
  name: string,
): SafeAutoCorrectProductResolution | null {
  const entered = mechanical(name);
  const approved = resolveApprovedProductName(entered);
  if (approved) {
    if (approved.canonicalName === entered) return null;
    return { ...approved, reason: "reviewed_alias" };
  }

  const reviewedTypo = SAFE_AUTOCORRECT_ALIASES[entered];
  if (reviewedTypo) {
    const productCode = CODE_BY_CANONICAL_NAME.get(reviewedTypo);
    if (productCode) {
      return { productCode, canonicalName: reviewedTypo, reason: "reviewed_typo" };
    }
  }

  return null;
}

/**
 * The one packaging word this rule covers. แพ็ค / ถุง / ลัง / เข่ง are
 * deliberately NOT here: each needs its own evidence that the shop uses it as
 * packaging rather than as part of a product's name.
 */
const BOX_SUFFIX = "กล่อง";

/**
 * Canonical business identity for a line whose product name carries a trailing
 * packaging word.
 *
 * The incident: "แอปเปิ้ลกล่อง 50 บาท / 3 กล่อง" parses correctly as
 * product แอปเปิ้ลกล่อง in unit กล่อง, but the dictionary holds แอปเปิ้ล. That
 * costs a needless vocabulary review, and worse, mints a second product
 * identity — so the return typed as plain แอปเปิ้ล later reads as
 * product_not_withdrawn against a master that never knew it.
 *
 * Stripping is guarded four ways, and every guard is load-bearing:
 *
 *  1. the name ends in exactly this suffix;
 *  2. the line's own unit IS that packaging word. "แอปเปิ้ลกล่อง" sold by ลูก
 *     is not an apple in a box, it is a name nobody can vouch for — it stays
 *     suspicious;
 *  3. the FULL name is not already approved. This is the one that keeps the
 *     rule honest: ผลไม้กล่อง, ทุเรียนกล่อง, หมอนทองกล่อง and ก้านยาวกล่อง are
 *     real registered products whose identity INCLUDES the word, and an
 *     endsWith-strip would silently fold them into ผลไม้ / ทุเรียน / หมอนทอง /
 *     ก้านยาว. Canonical exact match always wins;
 *  4. the stripped remainder resolves exactly — canonical spelling or reviewed
 *     deterministic alias, never fuzzy. An unregistered "สินค้าใหม่กล่อง" stays
 *     review-required, because guessing is what this whole module refuses to do.
 *
 * Returns the mechanical form of the input unchanged when any guard fails, so
 * a caller can always use the result as the comparison identity. Raw operator
 * evidence is never rewritten: callers pass raw names in and keep storing them.
 */
export function canonicalProduceProductName(
  rawName: string,
  rawUnit: string | null | undefined,
): string {
  const name = mechanical(rawName);
  if (!name.endsWith(BOX_SUFFIX)) return name;
  if (normalizeUnitAlias(mechanical(rawUnit ?? "")) !== BOX_SUFFIX) return name;
  if (resolveApprovedProductName(name)) return name;

  const stripped = name.slice(0, -BOX_SUFFIX.length).trim();
  if (!stripped) return name;
  return resolveApprovedProductName(stripped)?.canonicalName ?? name;
}

/**
 * Canonical business identity used by validation and persistence. Unknown names
 * stay mechanically normalized; only reviewed aliases, guarded box stripping,
 * or reviewed typos are rewritten.
 */
export function canonicalProduceProductIdentity(
  rawName: string,
  rawUnit: string | null | undefined,
): string {
  const packaged = canonicalProduceProductName(rawName, rawUnit);
  const corrected = resolveSafeAutoCorrectProductName(packaged);
  if (corrected) return corrected.canonicalName;
  const approved = resolveApprovedProductName(packaged);
  if (approved) return approved.canonicalName;
  return mechanical(normalizeProductName(packaged));
}

/**
 * Longest run of characters the two names share.
 *
 * This is the signal edit distance misses. เขียวมรกต is not two edits from
 * มะม่วงเขียวมรกต — it is six — but it is entirely contained in it, and shop
 * shorthand drops a leading word far more often than it misspells one.
 */
function longestSharedRun(a: string, b: string): number {
  let best = 0;
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] !== b[j - 1]) continue;
      current[j] = previous[j - 1] + 1;
      if (current[j] > best) best = current[j];
    }
    previous = current;
  }
  return best;
}

/**
 * Direct suggestion calls still rank a reviewed alias first. Normal validation
 * resolves it before reaching suggestions.
 */
function reviewedAliasTarget(name: string): string | null {
  const target = PRODUCT_ALIASES[name];
  if (!target) return null;
  const canonical = mechanical(target);
  return CODE_BY_CANONICAL_NAME.has(canonical) ? canonical : null;
}

interface Scored {
  readonly code: string;
  readonly name: string;
  /** 0 reviewed alias, 1 typo, 2 shared run. Lower is stronger evidence. */
  readonly tier: number;
  /** Within a tier: edit distance, or the negated shared run. Lower is closer. */
  readonly rank: number;
}

/**
 * Up to three dictionary products the operator might have meant, strongest
 * evidence first. Deterministic and offline: no model, no embedding, no
 * network. An empty result is a legitimate answer — most genuinely new
 * products have no near neighbour.
 */
export function suggestDictionaryProducts(name: string): ProductVocabularySuggestion[] {
  const entered = mechanical(name);
  if (entered.length < 2) return [];

  const aliasTarget = reviewedAliasTarget(entered);
  const scored: Scored[] = [];

  for (const [candidate, code] of CODE_BY_CANONICAL_NAME) {
    if (candidate === entered) continue;

    if (candidate === aliasTarget) {
      scored.push({ code, name: candidate, tier: 0, rank: 0 });
      continue;
    }

    const distance = boundedEditDistance(entered, candidate, MAX_TYPO_DISTANCE);
    if (distance !== null) {
      scored.push({ code, name: candidate, tier: 1, rank: distance });
      continue;
    }

    // Measured against what the operator typed, not against the candidate: a
    // five-character head word shared with ฝรั่ง is not evidence that
    // ฝรั่งสายพันธุ์ใหม่ของสวนลุงมี was meant to be ฝรั่ง.
    const run = longestSharedRun(entered, candidate);
    if (run >= MIN_SHARED_RUN && run * 2 >= entered.length) {
      scored.push({ code, name: candidate, tier: 2, rank: -run });
    }
  }

  scored.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.rank - b.rank ||
      a.name.length - b.name.length ||
      a.name.localeCompare(b.name, "th") ||
      a.code.localeCompare(b.code),
  );

  return scored
    .slice(0, MAX_SUGGESTIONS)
    .map(({ code, name: canonicalName }) => ({ productCode: code, canonicalName }));
}
