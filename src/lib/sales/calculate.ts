import { normalizeProductName } from "@/lib/summary/remaining-fruit";
import { baseTransactionType } from "@/lib/summary/transactions";
import { resolveUnitQuantity } from "@/lib/parsers/weigh-session/units";
import { centralPriceMapKey } from "@/lib/white-sheet/pricing";

/**
 * P1 Daily Sales — the pure calculator.
 *
 * It answers exactly four questions for one business date: how much product was
 * sold, what can be valued now, per market / per product / across all markets,
 * and which values are confirmed, pending review, or unavailable.
 *
 * It is NOT cash, slips, transfers, reconciliation, purchase, cost or profit.
 * Nothing in this file may read daily_summaries, settlement or slip data, and
 * expected sales is never derived from a White Sheet cash composition.
 *
 * Per market / product / unit:
 *
 *   sold_quantity  = W − R − D          (withdrawal − good return − damaged return)
 *   confirmed_sales = sold_quantity × authoritative central selling price
 *   pending_sales   = best-known quantity × usable final/entered price
 *   total_sales     = confirmed_sales + pending_sales
 *
 * Absence of a return row means the corresponding return quantity is zero
 * ONLY when the round has no persisted return document at all — a genuine
 * whole-round sold-out day. When a return DID land for the round, a withdrawn
 * product/unit missing from every return row is omitted evidence, not zero.
 *
 * FAIL CLOSED. Every rule below blocks rather than guesses:
 *   - a return with no withdrawal is not a negative sale
 *   - R + D > W is not a negative quantity
 *   - structurally invalid rows never contribute a number
 *   - trusted quantity with neither a central price nor one usable entered
 *     price yields no value
 *
 * Precision: quantity is carried as integer milli-units (3 dp, the canonical
 * quantity precision) and money as integer satang. Each atomic market/product/
 * unit row rounds half-up to satang ONCE, and every total is an integer sum of
 * those satang — so a displayed market total, product total and all-market
 * total always reconcile exactly with the rows above them.
 */

const QUANTITY_SCALE_PER_UNIT = BigInt(1000);
const SATANG_PER_BAHT = 100;

/** Separator for the composite market key — same construction as the White Sheet scope key. */
const MARKET_KEY_SEPARATOR = "\u0001";

/** Identity fields for a row that stands in for a broken session. */
export const SESSION_PLACEHOLDER_PRODUCT = "(ทั้งชุดรายการ)";
export const SESSION_PLACEHOLDER_UNIT = "-";

export type SalesRowStatus = "TRUSTED" | "VALUE_BLOCKED" | "QUANTITY_BLOCKED";

/** Monetary usability is separate from quantity/value verification status. */
export type SalesValueStatus = "CONFIRMED" | "PENDING_REVIEW" | "UNAVAILABLE";

/**
 * Why a row (or the whole scope) is not trusted. Ordered by how it is produced:
 * structural, then quantity evidence, then session integrity, then price.
 */
export type SalesBlockReason =
  | "invalid_identity"
  | "invalid_quantity"
  | "unknown_transaction_type"
  | "market_unresolved"
  /**
   * No longer produced by the calculator for a whole round with no return
   * document: that case is sold-out by design. Kept in the union (and in
   * message.ts's REASON_LABELS) for type/API compatibility only.
   */
  | "missing_return_evidence"
  /**
   * The round has a persisted return document, but this withdrawn product/unit
   * is absent from every return row. Not sold-out, not a trusted quantity.
   */
  | "product_return_absent"
  | "return_without_withdrawal"
  | "returns_exceed_withdrawal"
  | "duplicate_main_session"
  | "session_parser_errors"
  | "session_item_count_mismatch"
  | "session_rows_missing"
  | "session_date_missing"
  | "produce_message_never_landed"
  | "missing_central_price"
  | "central_price_conflict";

export type SalesScopeBlockerKind =
  | "unresolved_pending_session"
  | "message_parser_error"
  | "unattributable_session";

export interface SalesScopeBlocker {
  kind: SalesScopeBlockerKind;
  /** How many occurrences — the report states the count, never a guess at impact. */
  count: number;
}

/**
 * A produce session whose persisted rows do not reconcile with what it claimed.
 *
 * This is the case transaction rows cannot reveal: a session that persisted NO
 * rows at all is invisible to any audit that starts from produce_transactions,
 * yet its total_items says produce was weighed. The loader reconciles sessions
 * independently and passes the broken ones here.
 *
 * Attribution decides the blast radius: a session whose market identity resolves
 * blocks that market, one whose identity cannot be proven becomes a scope
 * blocker, because the missing rows could belong to any market.
 */
export interface SalesSessionAudit {
  sessionId: string;
  sourceId: string | null;
  marketName: string | null;
  reasons: readonly SalesBlockReason[];
}

/**
 * One persisted produce transaction, already adapted from produce_transactions
 * by the loader. Identity resolution (source, market label, canonical product,
 * canonical unit) happens here so it can be unit-tested without a database.
 */
export interface SalesSourceRow {
  /**
   * LINE source that owns the session. Null when it could not be resolved —
   * the row is then keyed by session and blocked, never merged into a market.
   */
  sourceId: string | null;
  /**
   * P2E accountability round. When present it IS the market identity: a
   * withdrawal and its return provably share it, and Production 2026-08-10
   * showed the two documents disagreeing about the market label inside one
   * round. Null for legacy rows, which stay on the (source + label) identity.
   */
  accountabilityRoundId?: string | null;
  /** Raw session title; display label only, never an identity on its own. */
  marketName: string | null;
  sessionId: string;
  /** "main" | "additional" — additional sessions are additive, never duplicates. */
  sessionKind: string;
  productName: string;
  unit: string | null;
  quantity: number | null;
  transactionType: string;
  /**
   * Usable entered withdrawal price after unit normalization, in satang.
   * Returns and rows without a valid entered price carry null/undefined.
   */
  enteredPriceSatang?: number | null;
  /** Session-level integrity findings from the loader (parser errors, item-count mismatch). */
  sessionIssues?: readonly SalesBlockReason[];
}

export interface SalesCalculationInput {
  businessDate: string;
  rows: readonly SalesSourceRow[];
  /** Central selling price in satang, keyed by centralPriceMapKey(productKey, unitKey). */
  centralPrices?: ReadonlyMap<string, number>;
  /** Identities whose central price is disputed and not yet admin-resolved. */
  priceConflicts?: ReadonlySet<string>;
  /** Integrity problems that cannot be attributed to one market. */
  scopeBlockers?: readonly SalesScopeBlocker[];
  /** Sessions whose persisted rows do not reconcile with what they claimed. */
  sessionAudits?: readonly SalesSessionAudit[];
  /** Canonical market label per accountability round — the display identity. */
  roundMarketLabels?: ReadonlyMap<string, string>;
  /**
   * Rounds whose ชั่งคืน is known to be unfinished: a return document is open,
   * or one was sent and refused. Known W/R/D evidence remains visible, but sold
   * quantity is not final and its calculable money stays pending review.
   */
  incompleteReturnRounds?: ReadonlySet<string>;
  /**
   * Rounds that already have a persisted ชั่งคืน / คืนเสีย document. A
   * withdrawn identity in one of these rounds that never appears in any
   * return row is omitted, not sold out.
   */
  persistedReturnRounds?: ReadonlySet<string>;
}

/** One atomic market + product + unit result — the only place a number is computed. */
export interface SalesIdentityRow {
  marketKey: string;
  /** Display label. Carries a short source suffix when one label spans several sources. */
  marketLabel: string;
  sourceId: string | null;
  businessDate: string;
  productName: string;
  unit: string;
  withdrawnQuantity: number;
  goodReturnQuantity: number;
  damagedReturnQuantity: number;
  /** null whenever the quantity itself is blocked — never a substituted zero. */
  soldQuantity: number | null;
  /** Entered withdrawal price, or the quantity-weighted average when lines differ. */
  enteredPriceSatang: number | null;
  centralPriceSatang: number | null;
  /** Confirmed central-price value only. */
  expectedSalesSatang: number | null;
  /** Best-known value awaiting price and/or return review; never also confirmed. */
  pendingReviewSalesSatang: number | null;
  /** Final-price value minus entered-price value for the same basis. Never added to total. */
  adjustmentSatang: number;
  valueStatus: SalesValueStatus;
  status: SalesRowStatus;
  reasons: SalesBlockReason[];
  /**
   * True for a stand-in row that reports a broken session rather than a
   * product. It is excluded from the product roll-up — there is no product to
   * roll up — but it appears in its market and in the blocked list.
   */
  isSessionPlaceholder?: boolean;
  /**
   * The round behind this identity has return evidence that never landed. W/R/D
   * evidence stands, but sold quantity is null and provisional money stays pending.
   */
  returnEvidenceIncomplete?: boolean;
}

/**
 * True for a quantity-trusted identity whose sold quantity equals its
 * withdrawal because no good-return row and no damaged-return row exists —
 * the "no return rows means sold out" case P1 must present, not hide.
 *
 * Independent of value trust: a VALUE_BLOCKED row (missing/conflicting
 * central price) still qualifies, since its quantity is trusted. A
 * QUANTITY_BLOCKED row never qualifies — soldQuantity is null.
 *
 * `returnEvidenceIncomplete` is the one addition to the original contract:
 * absence of a return row means zero ONLY when nothing is known to be missing.
 * Production 2026-08-10 (มิ้น / ทรัพย์พัน2) had a full return document sitting
 * refused by P4A while this rule reported the round as confidently sold out.
 */
export function isSoldOutByAbsentReturn(row: SalesIdentityRow): boolean {
  return (
    row.withdrawnQuantity > 0 &&
    row.goodReturnQuantity === 0 &&
    row.damagedReturnQuantity === 0 &&
    row.soldQuantity !== null &&
    !row.returnEvidenceIncomplete
  );
}

/**
 * A subtotal plus what makes it safe to read.
 *
 * Quantity trust and value trust are INDEPENDENT. A missing or disputed central
 * price says nothing about how much product left the market, so a VALUE_BLOCKED
 * row still contributes its sold quantity and may contribute pending money:
 *
 *   QUANTITY_BLOCKED  no final quantity; return-pending rows may carry provisional value
 *   VALUE_BLOCKED     quantity counts; value may be pending price review
 *   TRUSTED           final quantity and confirmed value
 *
 * `expectedSalesSatang` therefore sums TRUSTED rows only. When
 * `valueAuthoritative` is false it is a confirmed-partial figure and must never
 * be presented as total sales; `quantityAuthoritative` can still be true, and
 * the quantity may then be reported as complete.
 */
export interface SalesTotal {
  /** Confirmed central-price value only. */
  expectedSalesSatang: number;
  /** Calculable value awaiting price and/or return review. */
  pendingReviewSalesSatang: number;
  /** Exactly expectedSalesSatang + pendingReviewSalesSatang. */
  totalSalesSatang: number;
  /** Signed central-price correction versus entered-price value; informational only. */
  adjustmentSatang: number;
  /** Every identity behind this subtotal has a trusted sold quantity. */
  quantityAuthoritative: boolean;
  /** …and a trusted value. Implies quantityAuthoritative. */
  valueAuthoritative: boolean;
  trustedRowCount: number;
  /** Quantity trusted, value withheld. Counted in quantity roll-ups. */
  valueBlockedRowCount: number;
  /** Final quantity unavailable. May still carry provisional money. */
  quantityBlockedRowCount: number;
}

export interface SalesMarketSummary {
  marketKey: string;
  marketLabel: string;
  rows: SalesIdentityRow[];
  total: SalesTotal;
}

export interface SalesProductMarketBreakdown {
  marketKey: string;
  marketLabel: string;
  soldQuantity: number;
  /** null when this market's quantity is trusted but its value is not. */
  expectedSalesSatang: number | null;
}

export interface SalesProductSummary {
  productName: string;
  unit: string;
  /** Summed over every identity with a trusted quantity — TRUSTED and VALUE_BLOCKED. */
  soldQuantity: number;
  markets: SalesProductMarketBreakdown[];
  total: SalesTotal;
}

export interface SalesReport {
  businessDate: string;
  markets: SalesMarketSummary[];
  products: SalesProductSummary[];
  allMarkets: SalesTotal;
  /** Every non-TRUSTED identity, in full. Never sampled, never truncated. */
  blocked: SalesIdentityRow[];
  scopeBlockers: SalesScopeBlocker[];
}

export function salesMarketKey(sourceId: string, marketLabel: string): string {
  return `${sourceId}${MARKET_KEY_SEPARATOR}${marketLabel}`;
}

/** Key for a row whose market cannot be resolved: the session stands alone. */
function unresolvedMarketKey(sessionId: string): string {
  return `session${MARKET_KEY_SEPARATOR}${sessionId}`;
}

/** Key for a row that carries a P2E round — the strongest identity available. */
export function salesRoundMarketKey(accountabilityRoundId: string): string {
  return `round${MARKET_KEY_SEPARATOR}${accountabilityRoundId}`;
}

export function satangToBahtText(satang: number): string {
  const negative = satang < 0;
  const absolute = Math.abs(satang);
  const baht = Math.trunc(absolute / SATANG_PER_BAHT);
  const remainder = absolute % SATANG_PER_BAHT;
  const grouped = baht.toLocaleString("en-US");
  return `${negative ? "-" : ""}${grouped}.${String(remainder).padStart(2, "0")}`;
}

/** Half-up division of a non-negative bigint — the single rounding rule for money. */
export function roundHalfUp(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor;
  const remainder = value % divisor;
  return remainder * BigInt(2) >= divisor ? quotient + BigInt(1) : quotient;
}

/**
 * Decimal → integer milli-units with no float arithmetic, so 0.1 + 0.2 style
 * drift can never reach a reported quantity. Returns null for anything that is
 * not a finite non-negative number — the caller then blocks the identity.
 */
export function toMilliQuantity(value: number): bigint | null {
  if (!Number.isFinite(value) || value < 0) return null;

  const [coefficient, exponentText] = value.toString().toLowerCase().split("e");
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const [whole, fraction = ""] = coefficient.split(".");
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
  const unscaled = BigInt(digits);
  const decimalPlaces = fraction.length - exponent;
  const shift = 3 - decimalPlaces;
  if (shift >= 0) return unscaled * BigInt(10) ** BigInt(shift);
  return roundHalfUp(unscaled, BigInt(10) ** BigInt(-shift));
}

/** P1's approved quantity × unit-price money boundary. */
export function quantityTimesSatang(quantity: number, unitPriceSatang: number): number | null {
  const milli = toMilliQuantity(quantity);
  if (milli === null || !Number.isSafeInteger(unitPriceSatang) || unitPriceSatang < 0) return null;
  return Number(roundHalfUp(milli * BigInt(unitPriceSatang), BigInt(1000)));
}

function fromMilliQuantity(value: bigint): number {
  return Number(value) / 1000;
}

interface IdentityAggregate {
  marketKey: string;
  marketLabel: string;
  sourceId: string | null;
  accountabilityRoundId: string | null;
  productName: string;
  unit: string;
  withdrawn: bigint;
  goodReturn: bigint;
  damaged: bigint;
  hasWithdrawal: boolean;
  hasGoodReturn: boolean;
  hasDamaged: boolean;
  /** Sum of normalized withdrawal milli-quantity × that line's entered satang price. */
  enteredWithdrawalValueNumerator: bigint;
  hasUsableEnteredPrice: boolean;
  hasUnpricedWithdrawal: boolean;
  reasons: Set<SalesBlockReason>;
}

function addReason(target: Set<SalesBlockReason>, reason: SalesBlockReason): void {
  target.add(reason);
}

/**
 * Canonical product name for aggregation.
 *
 * Reuses the deployed P0 alias map and its two-pass "เพิ่ม" handling, so a
 * legitimate additional-session line lands in the same identity as the main
 * session it adds to. No fuzzy matching is introduced here; anything the alias
 * map does not explicitly cover stays a separate product and is reported as its
 * own line.
 */
function canonicalProduct(rawName: string, knownNames: ReadonlySet<string>): string {
  return normalizeProductName(rawName, undefined, knownNames);
}

/**
 * The set of already-aliased names present in the day's data, used to authorize
 * "เพิ่ม" prefix stripping. Identical construction to buildRemainingFruitReport.
 */
function knownProductNames(rows: readonly SalesSourceRow[]): Set<string> {
  return new Set(
    rows.map((row) => normalizeProductName(row.productName.normalize("NFC").replace(/\s+/g, " ").trim())),
  );
}

/**
 * Display labels for markets.
 *
 * The audit finding is that the same (or a similar) market label appears under
 * more than one LINE source and there is no authoritative market registry. The
 * identity is therefore always (source + label) — two sources are never merged.
 * When one label really does span several sources, the display label gets a
 * short source suffix so a human can tell the two apart, exactly as the White
 * Sheet market-scope selector does.
 */
function resolveDisplayLabels(aggregates: readonly IdentityAggregate[]): void {
  const sourcesByLabel = new Map<string, Set<string>>();
  for (const aggregate of aggregates) {
    if (!aggregate.sourceId) continue;
    const sources = sourcesByLabel.get(aggregate.marketLabel) ?? new Set<string>();
    sources.add(aggregate.sourceId);
    sourcesByLabel.set(aggregate.marketLabel, sources);
  }

  for (const aggregate of aggregates) {
    if (!aggregate.sourceId) continue;
    if ((sourcesByLabel.get(aggregate.marketLabel)?.size ?? 0) > 1) {
      aggregate.marketLabel = `${aggregate.marketLabel} · …${aggregate.sourceId.slice(-6)}`;
    }
  }
}

/**
 * Markets holding more than one ACTIVE main session of the same effective
 * transaction type, where "market" means the legacy (source + label) identity
 * — the one used when no accountability round is known.
 *
 * A P2E round is authoritative proof that its documents belong to the SAME
 * accountability lifecycle: one round legitimately contains several persisted
 * main documents of the same effective type (a main คืน split across two
 * messages, a correction คืน filed after the first, and so on — Production
 * 2026-08-19 showed rounds with two main คืน documents, product-disjoint, and
 * one with a second main คืน document holding a single item). Document count
 * inside a round is therefore never duplicate evidence by itself; the round
 * id already scopes every row to the correct identity via `rowMarketKey`
 * (see its docstring), so those rows are excluded from this scan entirely and
 * simply aggregate together like any other multi-document round.
 *
 * A row with NO round, by contrast, carries no proof that two main sessions
 * under the same (source + label) identity share one round — Production has
 * no unambiguous authoritative resolution for that case (the White Sheet only
 * warns), so P1 keeps failing closed there exactly as before: every identity
 * in such a market is quantity-blocked. Voided sessions never reach here —
 * produce_transactions is already void-filtered — and additional (ชุดเพิ่ม)
 * sessions are additive by design and are excluded from the check.
 *
 * This intentionally does NOT attempt to detect two DISTINCT, separately
 * populated rounds standing in for the same real-world market on the same
 * day (e.g. an accidental second round for the same seller). `SalesSourceRow`
 * carries no seller/staff identity to prove two round ids describe the same
 * business event, only source + round + label, so that scenario cannot be
 * told apart from two genuinely different rounds at this layer. Two distinct
 * round ids already never aggregate together (each is its own `marketKey`),
 * so they always surface as separate report entries rather than being
 * silently netted into one trusted total — unchanged by this function.
 */
function duplicateMainSessionMarkets(rows: readonly SalesSourceRow[]): Set<string> {
  const sessionsByMarketAndType = new Map<string, { marketKey: string; sessions: Set<string> }>();

  for (const row of rows) {
    if (row.sessionKind === "additional") continue;
    if (roundId(row)) continue;
    const type = baseTransactionType(row.transactionType);
    if (!type) continue;
    const marketKey = rowMarketKey(row);
    const key = `${marketKey}${MARKET_KEY_SEPARATOR}${type}`;
    const entry = sessionsByMarketAndType.get(key) ?? { marketKey, sessions: new Set<string>() };
    entry.sessions.add(row.sessionId);
    sessionsByMarketAndType.set(key, entry);
  }

  const blocked = new Set<string>();
  for (const entry of sessionsByMarketAndType.values()) {
    if (entry.sessions.size > 1) blocked.add(entry.marketKey);
  }
  return blocked;
}

/**
 * Session-level integrity findings, widened to every market the broken session
 * touched.
 *
 * Blocking only the identities that carry a row from that session is not
 * enough: the failure mode is a line that never made it into the data at all.
 * A return line dropped by the parser can leave a sibling product looking
 * complete — withdrawal present, return present, sold quantity plausible — when
 * the real return was larger. The market is the smallest scope that provably
 * contains the damage, so that is what gets blocked.
 */
function marketIssuesFromSessions(
  rows: readonly SalesSourceRow[],
): Map<string, Set<SalesBlockReason>> {
  const byMarket = new Map<string, Set<SalesBlockReason>>();

  for (const row of rows) {
    if (!row.sessionIssues || row.sessionIssues.length === 0) continue;
    const marketKey = rowMarketKey(row);
    const reasons = byMarket.get(marketKey) ?? new Set<SalesBlockReason>();
    for (const issue of row.sessionIssues) reasons.add(issue);
    byMarket.set(marketKey, reasons);
  }

  return byMarket;
}

function emptyTotal(): SalesTotal {
  return {
    expectedSalesSatang: 0,
    pendingReviewSalesSatang: 0,
    totalSalesSatang: 0,
    adjustmentSatang: 0,
    quantityAuthoritative: true,
    valueAuthoritative: true,
    trustedRowCount: 0,
    valueBlockedRowCount: 0,
    quantityBlockedRowCount: 0,
  };
}

/**
 * Fold one identity into a subtotal, keeping confirmed and provisional money
 * separate. Return-pending QUANTITY_BLOCKED rows may contribute provisional
 * value, while other quantity blockers remain monetarily unavailable.
 */
function accumulate(total: SalesTotal, row: SalesIdentityRow): void {
  if (row.valueStatus === "PENDING_REVIEW") {
    total.pendingReviewSalesSatang += row.pendingReviewSalesSatang ?? 0;
  }
  total.adjustmentSatang += row.adjustmentSatang;
  total.totalSalesSatang = total.expectedSalesSatang + total.pendingReviewSalesSatang;

  if (row.status === "QUANTITY_BLOCKED") {
    total.quantityBlockedRowCount += 1;
    total.quantityAuthoritative = false;
    total.valueAuthoritative = false;
    return;
  }
  if (row.status === "VALUE_BLOCKED") {
    total.valueBlockedRowCount += 1;
    total.valueAuthoritative = false;
    return;
  }
  total.expectedSalesSatang += row.expectedSalesSatang ?? 0;
  total.totalSalesSatang = total.expectedSalesSatang + total.pendingReviewSalesSatang;
  total.trustedRowCount += 1;
}

/**
 * Market label used for identity. `cleanMarketName` is deliberately NOT applied
 * here: the loader already resolved the canonical label (or decided the market
 * is unresolvable), and re-deriving it in a second place is how two paths drift.
 */
function identityLabel(marketName: string | null): string {
  return (marketName ?? "").normalize("NFC").trim();
}

/** The fields any market key derivation needs — a row or a session audit. */
type MarketIdentitySource = Pick<
  SalesSourceRow,
  "sourceId" | "marketName" | "sessionId" | "accountabilityRoundId"
>;

/** The round this row belongs to, or null. Blank strings are not identities. */
function roundId(row: MarketIdentitySource): string | null {
  const value = row.accountabilityRoundId?.trim();
  return value ? value : null;
}

/**
 * True when the row has a usable market identity: a round, or BOTH halves of
 * the legacy (source + label) identity.
 */
function isMarketResolved(row: MarketIdentitySource): boolean {
  if (roundId(row)) return true;
  return Boolean(row.sourceId) && identityLabel(row.marketName).length > 0;
}

/**
 * The one derivation of a row's market key. The duplicate-session scan and the
 * aggregation loop must agree exactly, or a duplicate could be detected against
 * a key no identity is ever filed under.
 *
 * A round wins over the label pair: it is the only key a withdrawal and its
 * return provably share, and it is exactly what label-keying got wrong in
 * Production on 2026-08-10.
 */
function rowMarketKey(row: MarketIdentitySource): string {
  const round = roundId(row);
  if (round) return salesRoundMarketKey(round);
  return isMarketResolved(row)
    ? salesMarketKey(row.sourceId as string, identityLabel(row.marketName))
    : unresolvedMarketKey(row.sessionId);
}

export function calculateSalesReport(input: SalesCalculationInput): SalesReport {
  const businessDate = input.businessDate;
  const centralPrices = input.centralPrices ?? new Map<string, number>();
  const priceConflicts = input.priceConflicts ?? new Set<string>();
  const scopeBlockers = [...(input.scopeBlockers ?? [])];
  const knownNames = knownProductNames(input.rows);
  const duplicateMarkets = duplicateMainSessionMarkets(input.rows);
  const marketIssues = marketIssuesFromSessions(input.rows);

  // Sessions that never reconciled. An attributable one blocks its market — and
  // gets a placeholder identity below if that market has nothing else, so it is
  // never silently absent. An unattributable one demotes the whole scope.
  const attributableAudits: Array<{ audit: SalesSessionAudit; marketKey: string }> = [];
  let unattributableAudits = 0;
  for (const audit of input.sessionAudits ?? []) {
    if (!isMarketResolved(audit)) {
      unattributableAudits += 1;
      continue;
    }
    const marketKey = rowMarketKey(audit);
    attributableAudits.push({ audit, marketKey });
    const reasons = marketIssues.get(marketKey) ?? new Set<SalesBlockReason>();
    for (const reason of audit.reasons) reasons.add(reason);
    marketIssues.set(marketKey, reasons);
  }
  if (unattributableAudits > 0) {
    scopeBlockers.push({ kind: "unattributable_session", count: unattributableAudits });
  }

  const aggregates = new Map<string, IdentityAggregate>();

  const roundLabels = input.roundMarketLabels ?? new Map<string, string>();
  const incompleteRounds = input.incompleteReturnRounds ?? new Set<string>();
  const persistedReturnRounds = input.persistedReturnRounds ?? new Set<string>();

  for (const row of input.rows) {
    const round = row.accountabilityRoundId?.trim() || null;
    // The round's own label is authoritative for display; the row's label is
    // the fallback for legacy rows and for a round the lookup did not return.
    const label = (round ? roundLabels.get(round)?.trim() : "") || identityLabel(row.marketName);
    const marketResolved = isMarketResolved(row);
    const marketKey = rowMarketKey(row);

    const rawProduct = row.productName?.normalize("NFC").trim() ?? "";
    const rawUnit = row.unit?.normalize("NFC").trim() ?? "";
    const bucket = baseTransactionType(row.transactionType);

    // Identity fields must be usable before anything can be grouped. A row with
    // no product or no unit is reported under whatever it does have rather than
    // being silently dropped, and its identity is blocked.
    const productName = rawProduct ? canonicalProduct(rawProduct, knownNames) : "(ไม่ระบุสินค้า)";
    const milliQuantity = row.quantity === null ? null : toMilliQuantity(row.quantity);
    const conversion = rawUnit && milliQuantity !== null
      ? resolveUnitQuantity(fromMilliQuantity(milliQuantity), rawUnit)
      : null;
    const unit = conversion ? conversion.unit : rawUnit || "(ไม่ระบุหน่วย)";

    const key = `${marketKey}${MARKET_KEY_SEPARATOR}${productName}${MARKET_KEY_SEPARATOR}${unit}`;
    let aggregate = aggregates.get(key);
    if (!aggregate) {
      aggregate = {
        marketKey,
        marketLabel: marketResolved ? label : "",
        sourceId: marketResolved ? (row.sourceId as string) : null,
        accountabilityRoundId: round,
        productName,
        unit,
        withdrawn: BigInt(0),
        goodReturn: BigInt(0),
        damaged: BigInt(0),
        hasWithdrawal: false,
        hasGoodReturn: false,
        hasDamaged: false,
        enteredWithdrawalValueNumerator: BigInt(0),
        hasUsableEnteredPrice: false,
        hasUnpricedWithdrawal: false,
        reasons: new Set<SalesBlockReason>(),
      };
      aggregates.set(key, aggregate);
    }

    for (const issue of marketIssues.get(marketKey) ?? []) addReason(aggregate.reasons, issue);
    if (!marketResolved) addReason(aggregate.reasons, "market_unresolved");
    if (duplicateMarkets.has(marketKey)) addReason(aggregate.reasons, "duplicate_main_session");
    if (!rawProduct || !rawUnit) addReason(aggregate.reasons, "invalid_identity");
    if (!bucket) addReason(aggregate.reasons, "unknown_transaction_type");
    if (milliQuantity === null) addReason(aggregate.reasons, "invalid_quantity");

    if (!bucket || milliQuantity === null || !conversion) continue;

    // The converted quantity is re-scaled to milli-units: a conversion (ขีด → โล)
    // may introduce a fourth decimal, and 3 dp is the canonical precision.
    const converted = toMilliQuantity(conversion.quantity);
    if (converted === null) {
      addReason(aggregate.reasons, "invalid_quantity");
      continue;
    }

    if (bucket === "เบิก") {
      aggregate.withdrawn += converted;
      aggregate.hasWithdrawal = true;
      const enteredPrice = row.enteredPriceSatang;
      if (
        typeof enteredPrice === "number"
        && Number.isSafeInteger(enteredPrice)
        && enteredPrice >= 0
      ) {
        aggregate.enteredWithdrawalValueNumerator += converted * BigInt(enteredPrice);
        aggregate.hasUsableEnteredPrice = true;
      } else {
        aggregate.hasUnpricedWithdrawal = true;
      }
    } else if (bucket === "คืน") {
      aggregate.goodReturn += converted;
      aggregate.hasGoodReturn = true;
    } else {
      aggregate.damaged += converted;
      aggregate.hasDamaged = true;
    }
  }

  const aggregateList = [...aggregates.values()];
  resolveDisplayLabels(aggregateList);

  const identityRows: SalesIdentityRow[] = aggregateList.map((aggregate) => {
    const reasons = new Set(aggregate.reasons);

    // Quantity evidence rules. A whole round with no return document at all
    // is sold-out by design. A round that DID persist a return, but left this
    // withdrawn product/unit out of every return row, is omitted evidence —
    // presence of a return row (including an explicit zero) is the coverage
    // signal, never the aggregate quantity being zero.
    if (!aggregate.hasWithdrawal && (aggregate.hasGoodReturn || aggregate.hasDamaged)) {
      addReason(reasons, "return_without_withdrawal");
    }
    if (aggregate.goodReturn + aggregate.damaged > aggregate.withdrawn) {
      addReason(reasons, "returns_exceed_withdrawal");
    }
    if (
      aggregate.accountabilityRoundId !== null
      && persistedReturnRounds.has(aggregate.accountabilityRoundId)
      && aggregate.hasWithdrawal
      && !aggregate.hasGoodReturn
      && !aggregate.hasDamaged
    ) {
      addReason(reasons, "product_return_absent");
    }

    const returnEvidenceIncomplete =
      aggregate.accountabilityRoundId !== null
      && incompleteRounds.has(aggregate.accountabilityRoundId);
    const returnQuantityPending = reasons.has("product_return_absent") || returnEvidenceIncomplete;
    const hardQuantityBlocked = [...reasons].some((reason) => reason !== "product_return_absent");
    const quantityBlocked = hardQuantityBlocked || returnQuantityPending;
    const priceKey = centralPriceMapKey(aggregate.productName, aggregate.unit);
    const sold = aggregate.withdrawn - aggregate.goodReturn - aggregate.damaged;
    const priceConflicted = priceConflicts.has(priceKey);
    const enteredPriceUsable =
      aggregate.hasWithdrawal
      && aggregate.hasUsableEnteredPrice
      && !aggregate.hasUnpricedWithdrawal;
    const enteredPriceSatang = enteredPriceUsable && aggregate.withdrawn > 0
      ? Number(roundHalfUp(aggregate.enteredWithdrawalValueNumerator, aggregate.withdrawn))
      : null;

    let centralPriceSatang: number | null = null;
    let expectedSalesSatang: number | null = null;
    let pendingReviewSalesSatang: number | null = null;
    let adjustmentSatang = 0;
    let valueStatus: SalesValueStatus = "UNAVAILABLE";
    let status: SalesRowStatus = "TRUSTED";

    const valueQuantity = reasons.has("product_return_absent") ? aggregate.withdrawn : sold;
    const enteredValueSatang = !enteredPriceUsable
      ? null
      : aggregate.withdrawn === BigInt(0)
        ? (valueQuantity === BigInt(0) ? 0 : null)
        : Number(roundHalfUp(
            valueQuantity * aggregate.enteredWithdrawalValueNumerator,
            aggregate.withdrawn * QUANTITY_SCALE_PER_UNIT,
          ));
    const centralPrice = centralPrices.get(priceKey);
    const centralValueSatang = centralPrice === undefined
      ? null
      : Number(roundHalfUp(valueQuantity * BigInt(centralPrice), QUANTITY_SCALE_PER_UNIT));

    if (hardQuantityBlocked) {
      status = "QUANTITY_BLOCKED";
      if (priceConflicted) addReason(reasons, "central_price_conflict");
    } else if (returnQuantityPending) {
      status = "QUANTITY_BLOCKED";
      if (priceConflicted) addReason(reasons, "central_price_conflict");
      if (!priceConflicted && centralPrice !== undefined && centralValueSatang !== null) {
        centralPriceSatang = centralPrice;
        pendingReviewSalesSatang = centralValueSatang;
        valueStatus = "PENDING_REVIEW";
        if (enteredValueSatang !== null) {
          adjustmentSatang = centralValueSatang - enteredValueSatang;
        }
      } else {
        if (centralPrice === undefined) addReason(reasons, "missing_central_price");
        if (enteredValueSatang !== null) {
          pendingReviewSalesSatang = enteredValueSatang;
          valueStatus = "PENDING_REVIEW";
        }
      }
    } else if (priceConflicted) {
      addReason(reasons, "central_price_conflict");
      status = "VALUE_BLOCKED";
      if (enteredValueSatang !== null) {
        pendingReviewSalesSatang = enteredValueSatang;
        valueStatus = "PENDING_REVIEW";
      }
    } else {
      if (centralPrice === undefined) {
        addReason(reasons, "missing_central_price");
        status = "VALUE_BLOCKED";
        if (enteredValueSatang !== null) {
          pendingReviewSalesSatang = enteredValueSatang;
          valueStatus = "PENDING_REVIEW";
        }
      } else {
        centralPriceSatang = centralPrice;
        expectedSalesSatang = Number(
          roundHalfUp(valueQuantity * BigInt(centralPrice), QUANTITY_SCALE_PER_UNIT),
        );
        valueStatus = "CONFIRMED";
        if (enteredValueSatang !== null) {
          adjustmentSatang = expectedSalesSatang - enteredValueSatang;
        }
      }
    }

    return {
      marketKey: aggregate.marketKey,
      marketLabel: aggregate.marketLabel,
      sourceId: aggregate.sourceId,
      businessDate,
      productName: aggregate.productName,
      unit: aggregate.unit,
      withdrawnQuantity: fromMilliQuantity(aggregate.withdrawn),
      goodReturnQuantity: fromMilliQuantity(aggregate.goodReturn),
      damagedReturnQuantity: fromMilliQuantity(aggregate.damaged),
      soldQuantity: quantityBlocked ? null : fromMilliQuantity(sold),
      enteredPriceSatang,
      centralPriceSatang,
      expectedSalesSatang,
      pendingReviewSalesSatang,
      adjustmentSatang,
      valueStatus,
      status,
      reasons: [...reasons],
      returnEvidenceIncomplete,
    };
  });

  // A market whose only evidence is a broken session has no identity to carry
  // the block, so it gets one — a placeholder that reports the session, not a
  // product. Without it the market would simply not appear, which reads as "no
  // sales here" and is exactly the silence this report must never produce.
  const marketsWithIdentities = new Set(identityRows.map((row) => row.marketKey));
  const placeholders = new Map<string, SalesIdentityRow>();
  for (const { audit, marketKey } of attributableAudits) {
    // Several broken sessions can share a market. The first one creates the
    // placeholder; the rest add their reasons to it, so no finding is lost to
    // a market that already has a row.
    const existing = placeholders.get(marketKey);
    if (existing) {
      for (const reason of audit.reasons) {
        if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      }
      continue;
    }
    if (marketsWithIdentities.has(marketKey)) continue;
    marketsWithIdentities.add(marketKey);
    const placeholder: SalesIdentityRow = {
      marketKey,
      marketLabel: identityLabel(audit.marketName),
      sourceId: audit.sourceId,
      businessDate,
      productName: SESSION_PLACEHOLDER_PRODUCT,
      unit: SESSION_PLACEHOLDER_UNIT,
      withdrawnQuantity: 0,
      goodReturnQuantity: 0,
      damagedReturnQuantity: 0,
      soldQuantity: null,
      enteredPriceSatang: null,
      centralPriceSatang: null,
      expectedSalesSatang: null,
      pendingReviewSalesSatang: null,
      adjustmentSatang: 0,
      valueStatus: "UNAVAILABLE",
      status: "QUANTITY_BLOCKED",
      reasons: [...audit.reasons],
      isSessionPlaceholder: true,
    };
    placeholders.set(marketKey, placeholder);
    identityRows.push(placeholder);
  }

  // An integrity problem that cannot be attributed to one market (an unresolved
  // pending session, a crashed parse) means data may be missing from ANY market,
  // so it demotes every total in the scope rather than only the all-market one.
  const scopeTrusted = scopeBlockers.length === 0;

  const marketMap = new Map<string, SalesMarketSummary>();
  const productMap = new Map<string, SalesProductSummary>();
  const allMarkets = emptyTotal();

  for (const row of identityRows) {
    let market = marketMap.get(row.marketKey);
    if (!market) {
      market = {
        marketKey: row.marketKey,
        marketLabel: row.marketLabel,
        rows: [],
        total: emptyTotal(),
      };
      marketMap.set(row.marketKey, market);
    }
    market.rows.push(row);
    accumulate(market.total, row);
    accumulate(allMarkets, row);

    // A placeholder reports a session, not a product — it blocks its market and
    // appears in the blocked list, but it has no product line to belong to.
    if (row.isSessionPlaceholder) continue;

    const productKey = `${row.productName}${MARKET_KEY_SEPARATOR}${row.unit}`;
    let product = productMap.get(productKey);
    if (!product) {
      product = {
        productName: row.productName,
        unit: row.unit,
        soldQuantity: 0,
        markets: [],
        total: emptyTotal(),
      };
      productMap.set(productKey, product);
    }
    accumulate(product.total, row);
    // Quantity roll-up takes every identity whose quantity is trusted, which
    // includes VALUE_BLOCKED ones: a missing or disputed central price must not
    // erase a sold quantity that was already proven. Confirmed money remains a
    // TRUSTED-only sum; a usable entered-price value is kept separately as
    // pending review, while a row with no usable price contributes no money.
    if (row.status !== "QUANTITY_BLOCKED") {
      product.soldQuantity += row.soldQuantity ?? 0;
      product.markets.push({
        marketKey: row.marketKey,
        marketLabel: row.marketLabel,
        soldQuantity: row.soldQuantity ?? 0,
        expectedSalesSatang: row.expectedSalesSatang,
      });
    }
  }

  // A scope blocker means evidence may be missing outright, so it demotes both
  // kinds of trust: neither the quantity nor the value can be called complete.
  if (!scopeTrusted) {
    for (const total of [allMarkets, ...[...marketMap.values()].map((m) => m.total),
      ...[...productMap.values()].map((p) => p.total)]) {
      total.quantityAuthoritative = false;
      total.valueAuthoritative = false;
    }
  }

  const markets = [...marketMap.values()]
    .map((market) => ({ ...market, rows: market.rows.sort(compareIdentityRows) }))
    .sort((a, b) => a.marketLabel.localeCompare(b.marketLabel, "th") || a.marketKey.localeCompare(b.marketKey));

  const products = [...productMap.values()]
    .map((product) => ({
      ...product,
      soldQuantity: Math.round(product.soldQuantity * 1000) / 1000,
      markets: product.markets.sort((a, b) => a.marketLabel.localeCompare(b.marketLabel, "th")),
    }))
    .sort(
      (a, b) =>
        a.productName.localeCompare(b.productName, "th") || a.unit.localeCompare(b.unit, "th"),
    );

  return {
    businessDate,
    markets,
    products,
    allMarkets,
    blocked: identityRows.filter((row) => row.status !== "TRUSTED").sort(compareIdentityRows),
    scopeBlockers,
  };
}

function compareIdentityRows(a: SalesIdentityRow, b: SalesIdentityRow): number {
  return (
    a.marketLabel.localeCompare(b.marketLabel, "th") ||
    a.productName.localeCompare(b.productName, "th") ||
    a.unit.localeCompare(b.unit, "th")
  );
}
