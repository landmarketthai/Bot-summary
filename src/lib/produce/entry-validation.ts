/**
 * P4A — produce entry validation gate (pure domain).
 *
 * The bot is the second checker. A human prepares the withdrawal/return sheet,
 * a second human transcribes it into LINE, and nobody compares the two line by
 * line. This module compares them: every return line is checked against the
 * withdrawal master of its own accountability round before the session is
 * allowed to finalize, so a transcription slip is caught while the operator is
 * still in front of the round instead of surfacing in the 08:00 report.
 *
 * Three things it deliberately does NOT do:
 *
 *  - it never rewrites the operator's text. Reviewed deterministic product
 *    aliases resolve as canonical identity before dictionary validation (see
 *    product-vocabulary.ts); an unknown unit is reported, never converted;
 *  - it never merges two products because their names look alike. Fuzzy
 *    distance produces a SUGGESTION for a human, never a match — เขียวมรกต and
 *    เขียวมรกตเก่า are one character apart and are different goods;
 *  - it never coerces a price. A return price may differ from the withdrawal
 *    price; the difference is reported as an advisory while the entered price
 *    remains authoritative for the transaction.
 */

import { createHash } from "node:crypto";
import type { WeighSession, WeighSessionItem } from "@/lib/parsers/weigh-session/types";
import {
  boundedEditDistance,
  isKnownUnit,
  nearestKnownUnit,
  normalizeUnitAlias,
  resolveUnitQuantity,
} from "@/lib/parsers/weigh-session/units";
import { normalizeProductName } from "@/lib/summary/remaining-fruit";
import { baseTransactionType } from "@/lib/summary/transactions";
import {
  canonicalProduceProductIdentity,
  isApprovedProductName,
  suggestDictionaryProducts,
  type ProductVocabularySuggestion,
} from "./product-vocabulary";

/** Quantities are numeric(10,3); prices numeric(10,2). Compare inside that grid. */
const QUANTITY_EPSILON = 0.0005;

export type ProduceValidationSeverity = "blocking" | "review_required" | "advisory";

export type ProduceValidationException =
  | {
      kind: "subunit_confirmation";
      severity: "review_required";
      itemNumber: number;
      productName: string;
      enteredQuantity: number;
      enteredUnit: "ขีด" | "กรัม";
      canonicalQuantity: number;
      canonicalUnit: string;
    }
  /** The unit is not part of the shop vocabulary at all ("โลก"). */
  | {
      kind: "unknown_unit";
      severity: "blocking";
      itemNumber: number;
      productName: string;
      unit: string;
      suggestion: string | null;
    }
  /** An intentional price change is allowed and shown after a successful save. */
  | {
      kind: "price_not_withdrawn";
      severity: "advisory";
      itemNumber: number;
      productName: string;
      unit: string;
      quantity: number;
      enteredPrice: number;
      withdrawnPrices: number[];
    };

export type ProduceValidationBlocking = Extract<
  ProduceValidationException,
  { severity: "blocking" }
>;
export type ProduceValidationReview = Extract<
  ProduceValidationException,
  { severity: "review_required" }
>;
export type ProduceValidationAdvisory = Extract<
  ProduceValidationException,
  { severity: "advisory" }
>;

/**
 * Non-financial mismatches that never block, never ask the operator anything
 * and are never shown in LINE. The amount is still quantity × entered price;
 * these only tell reconciliation where the paperwork and the round disagree.
 */
export type ProduceValidationReconciliation =
  /** A known unit, but not one this product was withdrawn in (แพค → ถุง). */
  | {
      kind: "unit_not_withdrawn";
      itemNumber: number;
      productName: string;
      unit: string;
      withdrawnUnits: string[];
    }
  /** Nothing by this name was withdrawn in this round. */
  | {
      kind: "product_not_withdrawn";
      itemNumber: number;
      productName: string;
      unit: string;
      suggestions: string[];
    }
  /** A withdrawal under a name that is not an approved dictionary spelling. */
  | {
      kind: "unknown_product_vocabulary";
      itemNumber: number;
      productName: string;
      suggestions: ProductVocabularySuggestion[];
    }
  /**
   * Good + damaged returns exceed the recorded withdrawal. Withdrawal data can
   * be incomplete ("calculate first, reconcile later"), so the submitted
   * return amounts stand and the excess is only recorded.
   */
  | {
      kind: "return_exceeds_withdrawal";
      productName: string;
      unit: string;
      withdrawnQuantity: number;
      goodReturnQuantity: number;
      damagedQuantity: number;
      excessQuantity: number;
    };

export interface ProduceValidationResult {
  status: "clean" | "review_required" | "blocked";
  blocking: ProduceValidationBlocking[];
  reviews: ProduceValidationReview[];
  advisories: ProduceValidationAdvisory[];
  reconciliation: ProduceValidationReconciliation[];
  /**
   * Immutable fingerprint of (session content + the exception set shown). A
   * confirmation is stored against it, so it can only ever approve the exact
   * data a human looked at.
   */
  digest: string;
}

/** One (canonical product, canonical unit) cell of a round's withdrawal master. */
export interface WithdrawalMasterCell {
  productName: string;
  unit: string;
  withdrawnQuantity: number;
  goodReturnQuantity: number;
  damagedQuantity: number;
  prices: number[];
}

export interface WithdrawalMaster {
  /** Keyed by `${canonical product}|${canonical unit}`. */
  cells: Map<string, WithdrawalMasterCell>;
  /** Canonical product name → the canonical units it was withdrawn in. */
  unitsByProduct: Map<string, Set<string>>;
}

/** A finalized produce row of the round, as exposed by `produce_transactions`. */
export interface RoundMasterRow {
  product_name: string;
  unit: string | null;
  quantity: number | null;
  price_per_unit: number | null;
  transaction_type: string;
}

export function masterCellKey(productName: string, unit: string): string {
  return `${canonicalProductIdentity(productName, unit)}|${normalizeUnitAlias(unit)}`;
}

/**
 * The single comparison identity for a produce line: guarded packaging-suffix
 * canonicalization, then the ordinary alias/report canonicalization.
 *
 * Every site that decides "are these the same product" goes through this —
 * the withdrawal master, return and damaged-return matching, and the
 * withdrawal vocabulary check — so a box-suffixed spelling can never be
 * approved on one axis and unknown on another. Both layers are exact-match;
 * neither invents a product.
 */
function canonicalProductIdentity(productName: string, unit: string | null | undefined): string {
  return normalizeProductName(canonicalProduceProductIdentity(productName, unit));
}

export function emptyWithdrawalMaster(): WithdrawalMaster {
  return { cells: new Map(), unitsByProduct: new Map() };
}

/**
 * Fold finalized round rows and the session being closed into one master.
 *
 * Both sources matter. The withdrawal may live in an earlier session of the
 * same round (the ordinary เปิดรอบ → ชั่งคืน flow), in an additional
 * withdrawal batch, or in the very document being validated when one session
 * carries both sections.
 */
export function buildWithdrawalMaster(rows: Iterable<RoundMasterRow>): WithdrawalMaster {
  const master = emptyWithdrawalMaster();
  for (const row of rows) {
    const unitRaw = row.unit?.trim();
    if (!unitRaw || row.quantity === null || !Number.isFinite(row.quantity)) continue;
    const base = baseTransactionType(row.transaction_type);
    if (!base) continue;

    const product = canonicalProductIdentity(row.product_name, unitRaw);
    const unit = normalizeUnitAlias(unitRaw);
    const key = `${product}|${unit}`;
    let cell = master.cells.get(key);
    if (!cell) {
      cell = {
        productName: product,
        unit,
        withdrawnQuantity: 0,
        goodReturnQuantity: 0,
        damagedQuantity: 0,
        prices: [],
      };
      master.cells.set(key, cell);
    }

    if (base === "เบิก") {
      cell.withdrawnQuantity += row.quantity;
      // Every withdrawal price is a legitimate price for this cell. One product
      // routinely carries several buckets (100 and 119 on the same durian) and
      // neither of them is an entry error.
      const price = roundPrice(row.price_per_unit);
      if (price !== null && !cell.prices.includes(price)) cell.prices.push(price);

      let units = master.unitsByProduct.get(product);
      if (!units) {
        units = new Set();
        master.unitsByProduct.set(product, units);
      }
      units.add(unit);
    } else if (base === "คืน") {
      cell.goodReturnQuantity += row.quantity;
    } else {
      cell.damagedQuantity += row.quantity;
    }
  }
  for (const cell of master.cells.values()) cell.prices.sort((a, b) => a - b);
  return master;
}

/** The session's own items, in the same shape as a finalized round row. */
export function masterRowsFromSession(parsed: WeighSession): RoundMasterRow[] {
  return parsed.items
    .filter((item) => item.unit !== null && item.quantity !== null)
    .map((item) => ({
      product_name: item.product_name,
      unit: item.unit,
      quantity: item.quantity,
      price_per_unit: item.price_per_unit,
      transaction_type: item.transaction_type,
    }));
}

export interface ProduceValidationInput {
  parsed: WeighSession;
  /** Finalized rows of this session's round. Empty for an unbound session. */
  roundRows: RoundMasterRow[];
  /**
   * True when the session carries an explicit accountability round. Only then
   * is the master complete enough to say "this was never withdrawn": an
   * unbound legacy session has no knowable round, and blocking it would be
   * guessing, not fail-closed. Unit vocabulary is checked either way.
   */
  roundBound: boolean;
  validationIdentity?: {
    sessionKey: string;
    sessionGeneration: string;
    accountabilityRoundId: string | null;
  };
}

export function validateProduceEntry(input: ProduceValidationInput): ProduceValidationResult {
  const { parsed, roundRows, roundBound } = input;
  const sessionRows = masterRowsFromSession(parsed);
  const master = buildWithdrawalMaster([...roundRows, ...sessionRows]);

  const blocking: ProduceValidationBlocking[] = [];
  const reviews: ProduceValidationReview[] = [];
  const advisories: ProduceValidationAdvisory[] = [];
  const reconciliation: ProduceValidationReconciliation[] = [];

  // Item numbering is not checked here: the parser renumbers duplicate,
  // missing and out-of-order numbers (see renumberItems), so every item
  // already has a unique, sequential number by the time it reaches the gate.

  // ── 1. Unit vocabulary. Applies to every item, withdrawal included: a
  // withdrawal booked in "โลก" poisons its own master cell.
  for (const item of parsed.items) {
    const unit = item.unit?.trim();
    if (!unit || isKnownUnit(unit)) continue;
    blocking.push({
      kind: "unknown_unit",
      severity: "blocking",
      itemNumber: item.item_number,
      productName: item.product_name,
      unit,
      suggestion: nearestKnownUnit(unit),
    });
  }

  const unknownUnitItems = new Set(
    blocking
      .filter((exception) => exception.kind === "unknown_unit")
      .map((exception) => exception.itemNumber),
  );

  // ── 1b. Product vocabulary, on withdrawals only. Recorded for
  // reconciliation, never blocking: an unknown name with a complete quantity,
  // unit and price is still a calculable line. Reviewed aliases have already
  // normalized the confident cases (product-vocabulary.ts).
  reconciliation.push(...vocabularyExceptions(parsed));
  reviews.push(...subunitExceptions(parsed));

  // ── 2. Identity and price of every return line, against the master.
  // An unbound legacy session has no knowable round, so the only master it can
  // have is whatever its own document declares. With no withdrawal anywhere,
  // "this was never withdrawn" would be a guess, not a fail-closed verdict.
  const canValidateAgainstMaster = roundBound || master.unitsByProduct.size > 0;
  if (canValidateAgainstMaster) {
    for (const item of parsed.items) {
      const base = baseTransactionType(item.transaction_type);
      if (base !== "คืน" && base !== "คืนเสีย") continue;
      const unitRaw = item.unit?.trim();
      if (!unitRaw || item.quantity === null) continue;
      // An unknown unit already blocks; matching it against the master would
      // only add a second, confusing exception for the same line.
      if (unknownUnitItems.has(item.item_number)) continue;

      const product = canonicalProductIdentity(item.product_name, unitRaw);
      const unit = normalizeUnitAlias(unitRaw);
      const withdrawnUnits = master.unitsByProduct.get(product);

      if (!withdrawnUnits) {
        reconciliation.push({
          kind: "product_not_withdrawn",
          itemNumber: item.item_number,
          productName: item.product_name,
          unit,
          suggestions: suggestProducts(product, master),
        });
        continue;
      }
      if (!withdrawnUnits.has(unit)) {
        reconciliation.push({
          kind: "unit_not_withdrawn",
          itemNumber: item.item_number,
          productName: item.product_name,
          unit,
          withdrawnUnits: [...withdrawnUnits].sort(),
        });
        continue;
      }

      // Price is validated on its own axis. Product identity is (product, unit)
      // — never the price — so several withdrawal buckets are all valid.
      const cell = master.cells.get(`${product}|${unit}`);
      const entered = roundPrice(item.price_per_unit);
      if (cell && entered !== null && cell.prices.length > 0 && !cell.prices.includes(entered)) {
        advisories.push({
          kind: "price_not_withdrawn",
          severity: "advisory",
          itemNumber: item.item_number,
          productName: item.product_name,
          unit,
          quantity: item.quantity,
          enteredPrice: entered,
          withdrawnPrices: [...cell.prices],
        });
      }
    }

    // ── 3. The inventory invariant, per cell and across every price bucket.
    // Recorded, never blocking: the recorded withdrawal may be incomplete.
    for (const cell of master.cells.values()) {
      const returned = cell.goodReturnQuantity + cell.damagedQuantity;
      if (returned <= cell.withdrawnQuantity + QUANTITY_EPSILON) continue;
      // A cell with no withdrawal at all is already reported as an unmatched
      // product; adding "returned more than the zero you withdrew" on top of
      // that would be two exceptions for one mistake.
      if (!master.unitsByProduct.get(cell.productName)?.has(cell.unit)) continue;
      reconciliation.push({
        kind: "return_exceeds_withdrawal",
        productName: cell.productName,
        unit: cell.unit,
        withdrawnQuantity: round3(cell.withdrawnQuantity),
        goodReturnQuantity: round3(cell.goodReturnQuantity),
        damagedQuantity: round3(cell.damagedQuantity),
        excessQuantity: round3(returned - cell.withdrawnQuantity),
      });
    }
  }

  const digest = computeValidationDigest(parsed, blocking, reviews, input.validationIdentity);
  const status = blocking.length > 0
    ? "blocked"
    : reviews.length > 0
      ? "review_required"
      : "clean";
  return { status, blocking, reviews, advisories, reconciliation, digest };
}

function subunitExceptions(parsed: WeighSession): ProduceValidationReview[] {
  return [...parsed.items]
    .filter((item) => item.pricing_mode === "basis"
      && item.entered_quantity !== undefined
      && (item.entered_unit === "ขีด" || item.entered_unit === "กรัม")
      && item.quantity !== null && item.unit !== null)
    .sort((a, b) => a.item_number - b.item_number)
    .map((item) => {
      // A risky unit can appear in a price-basis header while the final
      // quantity arrives on a separate line. Show the conversion of the
      // risky expression itself, not that later final quantity.
      const canonical = resolveUnitQuantity(item.entered_quantity!, item.entered_unit!);
      return {
        kind: "subunit_confirmation" as const,
        severity: "review_required" as const,
        itemNumber: item.item_number,
        productName: item.product_name,
        enteredQuantity: item.entered_quantity!,
        enteredUnit: item.entered_unit as "ขีด" | "กรัม",
        canonicalQuantity: canonical.quantity,
        canonicalUnit: canonical.unit,
      };
    });
}

/**
 * Withdrawal lines whose product name is not an approved dictionary spelling.
 *
 * One exception per distinct name, at its first item number: the operator has
 * one spelling to fix, not one per line that carries it. Ordered by item
 * number so the reply is deterministic.
 */
function vocabularyExceptions(parsed: WeighSession): ProduceValidationReconciliation[] {
  const seen = new Set<string>();
  const exceptions: ProduceValidationReconciliation[] = [];
  for (const item of [...parsed.items].sort((a, b) => a.item_number - b.item_number)) {
    if (baseTransactionType(item.transaction_type) !== "เบิก") continue;
    const name = item.product_name.normalize("NFC").replace(/\s+/g, " ").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    // A box-suffixed spelling is judged on the identity the master will use,
    // so the operator is not asked to vouch for a name the round already
    // treats as แอปเปิ้ล. The suggestion list still describes what they typed.
    if (isApprovedProductName(canonicalProduceProductIdentity(name, item.unit))) continue;
    exceptions.push({
      kind: "unknown_product_vocabulary",
      itemNumber: item.item_number,
      productName: item.product_name,
      suggestions: suggestDictionaryProducts(name),
    });
  }
  return exceptions;
}

/**
 * Candidate spellings for a product the round never withdrew.
 *
 * Suggestions only, and only from this round's own master — a name that is one
 * or two characters away from something actually withdrawn today is worth
 * showing a human. Nothing here decides anything.
 */
function suggestProducts(product: string, master: WithdrawalMaster): string[] {
  if (product.length < 3) return [];
  const scored: Array<{ name: string; distance: number }> = [];
  for (const candidate of master.unitsByProduct.keys()) {
    if (candidate === product) continue;
    const distance = boundedEditDistance(product, candidate, 2);
    if (distance === null) continue;
    scored.push({ name: candidate, distance });
  }
  scored.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
  return scored.slice(0, 3).map((entry) => entry.name);
}

function roundPrice(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Bind a confirmation to what was actually on screen.
 *
 * The digest covers the session content AND the exception set. A straggler
 * arriving after the preview changes the content, so the digest changes, so
 * the earlier confirmation no longer matches and the operator is asked again
 * instead of silently approving text nobody read.
 */
export function computeValidationDigest(
  parsed: WeighSession,
  blocking: ProduceValidationBlocking[],
  reviews: ProduceValidationReview[],
  identity?: ProduceValidationInput["validationIdentity"],
): string {
  // Legacy unbound finalizers already have review rows whose digest predates
  // session identity. The review table's session_key + generation columns
  // still bind those rows exactly; keep their digest stable. Bound rounds hash
  // the full identity because the confirm RPC does not receive round id.
  const identityFields = identity?.accountabilityRoundId
    ? [identity.sessionKey, identity.sessionGeneration, identity.accountabilityRoundId]
    : ["", "", ""];
  const canonicalItems = [...parsed.items]
    .sort((a, b) => a.item_number - b.item_number)
    .map((item: WeighSessionItem) =>
      [
        item.item_number,
        item.product_name,
        item.quantity ?? "",
        item.unit ?? "",
        item.price_per_unit,
        item.transaction_type,
      ].join("|"),
    );
  const canonicalExceptions = [...blocking, ...reviews]
    .map((exception) => JSON.stringify(exception, Object.keys(exception).sort()))
    .sort();
  return createHash("sha256")
    .update(
      [
        parsed.date ?? "",
        parsed.staff_name,
        parsed.session_title ?? "",
        ...identityFields,
        ...canonicalItems,
        "--",
        ...canonicalExceptions,
      ].join("\n"),
    )
    .digest("hex");
}
