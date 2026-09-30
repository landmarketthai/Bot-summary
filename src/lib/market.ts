const DATE_RE = /\b\d{1,2}[\/\-.]\d{1,2}[\/\-.](?:25)?\d{2}\b/g;
const LONG_DATE_RE = /วันที่\s+\d{1,2}\s+[\u0E00-\u0E7F]+\s+(?:25)?\d{2}/g;
const TALAD_RE = /ตลาด[\u0E00-\u0E7Fa-zA-Z0-9]+/;

const BARE_TX_FRAGMENTS = new Set([
  "\u0E40\u0E1A\u0E34\u0E01",
  "\u0E04\u0E37\u0E19",
  "\u0E0A\u0E31\u0E48\u0E07",
  "\u0E0A\u0E48\u0E32\u0E07",
  "\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23",
  "\u0E40\u0E1A\u0E34\u0E01\u0E1C\u0E31\u0E01",
  "\u0E04\u0E37\u0E19\u0E1C\u0E31\u0E01",
  "\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23\u0E40\u0E1A\u0E34\u0E01\u0E1C\u0E31\u0E01",
  "\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23\u0E0A\u0E31\u0E48\u0E07\u0E40\u0E1A\u0E34\u0E01",
  "\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23\u0E0A\u0E31\u0E48\u0E07",
  "\u0E44\u0E1B",
]);

function stripDates(value: string): string {
  return value
    .replace(DATE_RE, " ")
    .replace(LONG_DATE_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTaladMarket(value: string): string | null {
  const match = value.match(TALAD_RE);
  return match?.[0] ?? null;
}

function stripTransactionTokens(value: string): string {
  return value
    .replace(/\u0E40\u0E1A\u0E34\u0E01\u0E40\u0E1E\u0E34\u0E48\u0E21/g, " ")
    .replace(/\u0E04\u0E37\u0E19\u0E40\u0E2A\u0E35\u0E22/g, " ")
    .replace(/\u0E0A\u0E31\u0E48\u0E07\u0E04\u0E37\u0E19/g, " ")
    .replace(/\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23\u0E0A\u0E31\u0E48\u0E07/g, " ")
    .replace(/\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23/g, " ")
    .replace(/\u0E40\u0E1A\u0E34\u0E01/g, " ")
    .replace(/\u0E04\u0E37\u0E19/g, " ")
    .replace(/^\u0E44\u0E1B\s*/, "")
    .replace(/\s*(?:\u0E0A\u0E31\u0E48\u0E07|\u0E0A\u0E48\u0E32\u0E07)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isBareTransactionFragment(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (BARE_TX_FRAGMENTS.has(trimmed)) return true;
  if (/^(?:\u0E40\u0E1A\u0E34\u0E01|\u0E04\u0E37\u0E19|\u0E0A\u0E31\u0E48\u0E07|\u0E0A\u0E48\u0E32\u0E07)(?:\u0E1C\u0E31\u0E01)?$/.test(trimmed)) return true;
  if (/^\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23/.test(trimmed) && !TALAD_RE.test(trimmed)) return true;
  return false;
}

function isTransactionOnlyTitle(value: string): boolean {
  const stripped = stripDates(value.replace(/\r?\n/g, " "));
  if (!stripped) return true;
  if (TALAD_RE.test(stripped)) return false;
  if (/^\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23/.test(stripped)) return true;
  if (/^(?:\u0E40\u0E1A\u0E34\u0E01|\u0E04\u0E37\u0E19)(?:\u0E1C\u0E31\u0E01|\d|$)/.test(stripped)) return true;
  if (/^(?:\u0E0A\u0E31\u0E48\u0E07|\u0E0A\u0E48\u0E32\u0E07)\u0E04\u0E37\u0E19/.test(stripped)) return true;
  return false;
}

/**
 * Resolve a stored session title / market_name to a canonical market label.
 * Returns null when the source text does not identify a market.
 */
export function cleanMarketName(value: string | null | undefined): string | null {
  if (!value) return null;
  if (isTransactionOnlyTitle(value)) return null;

  let market = stripDates(value.replace(/\r?\n/g, " "));

  const talad = extractTaladMarket(market);
  if (talad) return talad;

  const dashIndex = market.indexOf("-");
  if (dashIndex >= 0) {
    market = market.slice(dashIndex + 1).trim();
    const taladAfterDash = extractTaladMarket(market);
    if (taladAfterDash) return taladAfterDash;
  }

  const postTalad = market.match(
    /(?:\u0E44\u0E1B|\u0E40\u0E1A\u0E34\u0E01|\u0E04\u0E37\u0E19|\u0E0A\u0E31\u0E48\u0E07\u0E04\u0E37\u0E19)\s*(\u0E15\u0E25\u0E32\u0E14[\u0E00-\u0E7Fa-zA-Z0-9]+)/,
  );
  if (postTalad?.[1]) return postTalad[1];

  market = stripTransactionTokens(market);

  const taladAfterStrip = extractTaladMarket(market);
  if (taladAfterStrip) return taladAfterStrip;

  if (isBareTransactionFragment(market)) return null;
  return market || null;
}

export function isIdentifiedMarket(value: string | null | undefined): boolean {
  return cleanMarketName(value) !== null;
}

export function displayMarketName(value: string | null | undefined, fallback = "—"): string {
  return cleanMarketName(value) ?? fallback;
}

/**
 * Canonical market identity for White Sheet financial comparison.
 * Same boundary for produce rows and slip evidence market_label — never use
 * SQL trim/NFC alone as the trusted identity.
 */
export function normalizedMarketLabel(marketName: string | null | undefined): string {
  return displayMarketName(marketName, "").normalize("NFC").trim();
}

/**
 * The reviewed market alias registry — the TypeScript mirror of
 * `line_guided_menu_market_aliases`.
 *
 * There is ONE market identity in this system and the reviewed catalog owns it.
 * Postgres reads it from the catalog tables via
 * `accountability_round_market_code`; the duplicate fingerprint has to compute
 * the same identity offline and deterministically (it is a hash input, and a
 * hash that depends on a database round-trip is not a hash), so the reviewed
 * rows are mirrored here.
 *
 * The mirror is not allowed to drift: `market-alias-registry.test.ts` parses the
 * catalog migrations and fails if these entries and the seeded rows disagree.
 *
 * Reviewed aliases only. Every entry traces to a shop-confirmed spelling of a
 * market that already exists in the catalog. Nothing is inferred, and a label
 * that is not in here keeps exact-normalized-equality — two unknown labels are
 * never merged.
 */
export const REVIEWED_MARKET_ALIASES: Readonly<Record<string, string>> = {
  // 0055 — the reviewed catalog as first seeded.
  "ตลาด72": "เฉลิมฯ72",
  "เฉลิม72": "เฉลิมฯ72",
  "พาชิโอ้ทุเรียน": "พาซิโอ้ทุเรียน",
  "พาสิโอ้ทุเรียน": "พาซิโอ้ทุเรียน",
  "พาชิโอ้ ทุเรียน": "พาซิโอ้ทุเรียน",
  "พาชิโอ้ผลไม้": "พาซิโอ้ผลไม้",
  "พาชิโอ้ ผลไม้": "พาซิโอ้ผลไม้",
  "ตลาดพาซิโอ้ผลไม้": "พาซิโอ้ผลไม้",
  "พาสิโอ้ผลไม้": "พาซิโอ้ผลไม้",
  "พาชิโอ้ผัก": "พาซิโอ้ผัก",
  "พาสิโอ้ผัก": "พาซิโอ้ผัก",
  "ตลาดราชพฤก": "ราชพฤกษ์",
  "ตลาดราชพฤกษ์": "ราชพฤกษ์",
  "ราชพฤก": "ราชพฤกษ์",
  "เลียบทางด่วน": "เลียบด่วน",
  "วัดตะกลํ่า": "วัดตะกล่ำ",
  "ตลาดทุ่งลานนา": "วัดทุ่งลานนา",
  "ตลาดวัดทุ่งลานนา": "วัดทุ่งลานนา",
  "ทุ่งลานนา": "วัดทุ่งลานนา",
  "หน้าเซเว่น": "หน้าเซเวน",
  "ทรัพย์พัน2": "ทรัพย์พัน",
  // Production 2026-08-14/15, seller ต้อม, group C98f83da…: the same market
  // opened two accountability rounds because these two spellings were not
  // reviewed. Confirmed by the shop as one market.
  "พาซีโอ้": "พาซิโอ้",
  "พาสิโอ้": "พาซิโอ้",
  // 20260930090100 — contiguous vegetable-market spellings only. Space forms
  // like "พาซิโอ้ ผัก" stay unmapped: "พาซิโอ้ เบิกผัก" cleans to exactly that.
  "พาซีโอ้ผัก": "พาซิโอ้ผัก",
  "ตลาดพาซิโอ้ผัก": "พาซิโอ้ผัก",
};

/** Canonical market labels, i.e. the reviewed catalog's own `label` column. */
export const REVIEWED_MARKET_LABELS: readonly string[] = [
  "เฉลิมฯ72",
  "เลียบด่วน",
  "พาซิโอ้",
  "พาซิโอ้ทุเรียน",
  "พาซิโอ้ผลไม้",
  "พาซิโอ้ผัก",
  "ราชพฤกษ์",
  "รถเร่",
  "ทรัพย์พัน",
  "หน้าเซเวน",
  "วัดตะกล่ำ",
  "วัดทุ่งลานนา",
  "วิหาร",
];

/**
 * The market identity a label belongs to — reviewed alias resolved.
 *
 * This is the value anything comparing two markets must compare. It is
 * deliberately NOT fuzzy: a label the reviewed catalog does not know comes back
 * normalized but otherwise untouched, so an unreviewed variant stays its own
 * identity and fails closed downstream rather than merging into a neighbour.
 */
export function canonicalMarketLabel(marketName: string | null | undefined): string {
  const normalized = normalizedMarketLabel(marketName);
  if (!normalized) return "";
  return REVIEWED_MARKET_ALIASES[normalized] ?? normalized;
}

const SPELLINGS_BY_CANONICAL: ReadonlyMap<string, readonly string[]> = (() => {
  const byCanonical = new Map<string, string[]>();
  for (const [alias, canonical] of Object.entries(REVIEWED_MARKET_ALIASES)) {
    const spellings = byCanonical.get(canonical) ?? [canonical];
    spellings.push(alias);
    byCanonical.set(canonical, spellings);
  }
  return byCanonical;
})();

/**
 * Every reviewed spelling of one market — the canonical label first, then its
 * aliases, sorted so callers get a stable order.
 *
 * This is the equivalence class a previous fingerprint generation could have
 * written the same business document under, back when the market component of
 * the hash was the raw label rather than the canonical identity. A label with
 * no reviewed aliases answers with just itself.
 */
export function reviewedMarketSpellings(canonicalLabel: string): readonly string[] {
  const spellings = SPELLINGS_BY_CANONICAL.get(canonicalLabel);
  if (!spellings) return canonicalLabel ? [canonicalLabel] : [];
  return [spellings[0], ...spellings.slice(1).sort()];
}
