/**
 * Product Code resolution — optional identification, never an allowlist.
 *
 * Operators type product names by hand, so one physical product accumulates
 * many spellings (กล้วยน้ำว้า / กล้วยน้ำหว้า / น้ำว้า / กล้วหว้า). A short code
 * lets them key ม02 instead. The code is a way of *writing* a product, not a
 * list of permitted products:
 *
 *   ม02 35 บาท          → resolves to กล้วยน้ำว้า
 *   กล้วยน้ำว้า 35 บาท    → unchanged, exactly as before
 *   เสาวรส 50 บาท        → unchanged, a brand-new product still works
 *
 * Nothing here rejects a product for being absent from the dictionary. The one
 * thing that fails is a token that *looks* like a code but is not registered
 * (ม999) — silently persisting that as a literal product named "ม999" would
 * put junk identity into the round, so it fails closed instead.
 *
 * Resolution is deliberately narrow. It rewrites one token, in product-name
 * position, on a line the parser has already decided is an item line — never a
 * blind string replacement over the message, which would corrupt seller names,
 * markets, dates and comments that happen to contain the same characters.
 */

import { PRODUCT_CODE_ENTRIES, type ProductCodeEntry } from "./dictionary";

/** The approved namespaces: ผลไม้, ผัก, ปลา/ของแห้ง, ทุเรียน, เห็ด, พิเศษ. */
export const PRODUCT_CODE_PREFIXES = "มผปทหพ";

/**
 * A whole token that is a product code: one namespace character plus digits.
 *
 * Digit width is open (ผ already runs past 99 to ผ118) but bounded, so an
 * arbitrary Thai word followed by a long number can never be read as a code.
 */
export const PRODUCT_CODE_TOKEN = new RegExp(`^[${PRODUCT_CODE_PREFIXES}]\\d{1,4}$`, "u");

/**
 * A product code in product-name position at the head of an item line, behind
 * the scale's optional item number ("1.ม01 50 บาท", "ม01 50 บาท").
 *
 * The trailing lookahead requires whitespace or end-of-line after the code, so
 * the compact scale form "ม0150บาท" is left to the existing patterns exactly as
 * it reads today. A code is only ever recognized where the operator separated
 * it from the price, which is how the coded syntax is specified.
 */
const ITEM_LINE_PRODUCT_CODE = new RegExp(
  `^(\\d+\\s*\\.?\\s*)?([${PRODUCT_CODE_PREFIXES}]\\d{1,4})(?=$|\\s)`,
  "u",
);

const BY_CODE: ReadonlyMap<string, ProductCodeEntry> = new Map(
  PRODUCT_CODE_ENTRIES.map((entry) => [entry.code, entry]),
);

const RUNTIME_BY_CODE = new Map<string, ProductCodeEntry>();
const RUNTIME_PRODUCT_CODE_LIMIT = 5000;

interface RuntimeDictionaryClient {
  from(table: string): {
    select(columns: string): unknown;
  };
}

interface RuntimeDictionaryQuery {
  eq(column: string, value: unknown): RuntimeDictionaryQuery;
  limit(count: number): Promise<{ data: unknown[] | null; error: { message: string } | null }>;
}

/** Refresh the bounded DB overlay used by the synchronous parser and reports. */
export async function preloadRuntimeProductCodes(supabase: RuntimeDictionaryClient): Promise<void> {
  try {
    const query = supabase.from("produce_product_codes").select(
      "product_code,category_code,category_name,canonical_name,code_enabled",
    ) as RuntimeDictionaryQuery;
    const response = await query.eq("code_enabled", true).limit(RUNTIME_PRODUCT_CODE_LIMIT);
    if (response.error) return;

    const next = new Map<string, ProductCodeEntry>();
    for (const raw of response.data ?? []) {
      const row = raw as {
        product_code?: unknown;
        category_code?: unknown;
        category_name?: unknown;
        canonical_name?: unknown;
        code_enabled?: unknown;
      };
      if (
        typeof row.product_code !== "string"
        || typeof row.category_code !== "string"
        || typeof row.category_name !== "string"
        || typeof row.canonical_name !== "string"
        || row.code_enabled !== true
        || !PRODUCT_CODE_TOKEN.test(row.product_code)
        || !row.canonical_name.trim()
      ) continue;
      next.set(row.product_code, {
        code: row.product_code,
        categoryCode: row.category_code,
        category: row.category_name,
        canonicalName: row.canonical_name.normalize("NFC").replace(/\s+/g, " ").trim(),
        enabled: true,
      });
    }
    RUNTIME_BY_CODE.clear();
    for (const [code, entry] of next) RUNTIME_BY_CODE.set(code, entry);
  } catch {
    // The static dictionary remains authoritative if the optional refresh fails.
  }
}

/** Runtime entry, or the generated entry when no DB overlay exists. */
export function productCodeEntryFor(code: string): ProductCodeEntry | null {
  return RUNTIME_BY_CODE.get(code) ?? BY_CODE.get(code) ?? null;
}

export function runtimeProductCodeEntryForName(productName: string): ProductCodeEntry | null {
  const key = productName.normalize("NFC").trim();
  for (const entry of RUNTIME_BY_CODE.values()) {
    if (entry.canonicalName.normalize("NFC").trim() === key) return entry;
  }
  return null;
}

export type ProductCodeResolution =
  /** No code-shaped token here — the line is an ordinary product line. */
  | { kind: "none"; content: string }
  /** The code resolved; `content` carries its canonical name in its place. */
  | { kind: "resolved"; content: string; code: string; canonicalName: string }
  /** Code-shaped but unregistered or retired. Callers must fail closed. */
  | { kind: "unknown"; code: string };

/** The canonical product a code identifies, or null if it does not resolve. */
export function resolveProductCode(code: string): string | null {
  const entry = productCodeEntryFor(code);
  return entry && entry.enabled ? entry.canonicalName : null;
}

export function isProductCodeToken(token: string): boolean {
  return PRODUCT_CODE_TOKEN.test(token);
}

/**
 * Rewrites a leading product code on an item line to its canonical product
 * name, leaving every other character of the line untouched, so the existing
 * item patterns then read it as the ordinary product line it stands for.
 *
 * "ม02 35 บาท"     → "กล้วยน้ำว้า 35 บาท"
 * "1.ม02 35 บาท"   → "1.กล้วยน้ำว้า 35 บาท"
 * "กระท้อน 40 บาท" → untouched
 * "ม999 50 บาท"    → { kind: "unknown", code: "ม999" }
 */
export function resolveItemLineProductCode(content: string): ProductCodeResolution {
  const match = content.match(ITEM_LINE_PRODUCT_CODE);
  if (!match) return { kind: "none", content };

  const code = match[2];
  const canonicalName = resolveProductCode(code);
  if (canonicalName === null) return { kind: "unknown", code };

  const itemNumberPrefix = match[1] ?? "";
  const rest = content.slice(match[0].length);

  return {
    kind: "resolved",
    content: `${itemNumberPrefix}${canonicalName}${rest}`,
    code,
    canonicalName,
  };
}

/**
 * The parse error recorded for an unrecognized code, in the shape
 * buildWeighSessionValidationReply renders back to the operator.
 */
export function unknownProductCodeError(code: string, line: string): string {
  return `unknown product code ${code} in line: "${line}"`;
}

export const UNKNOWN_PRODUCT_CODE_ERROR =
  /^unknown product code (\S+) in line: "(.+)"$/u;
