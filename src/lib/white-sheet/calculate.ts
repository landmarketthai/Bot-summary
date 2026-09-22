import { conversionFactor, resolveUnitQuantity } from "@/lib/parsers/weigh-session/units";
import { normalizeProductName } from "@/lib/summary/remaining-fruit";
import { baseTransactionType } from "@/lib/summary/transactions";
import { classifyProduct } from "./category";
import { centralPriceMapKey } from "./pricing";
import { centralPriceConflictWarning } from "./warnings";
import type {
  DigitalWhiteSheetCalculation,
  DigitalWhiteSheetInput,
  WhiteSheetExpenses,
  WhiteSheetItemCalculation,
  WhiteSheetTransactionRow,
  WhiteSheetValidationCode,
  WhiteSheetValidationIssue,
} from "./types";

const QUANTITY_SCALE = 3;
const MONEY_SCALE = 2;
const MILLIQUANTITY_PER_UNIT = BigInt(1_000);

interface ItemAggregate {
  marketKey: string;
  accountabilityRoundId: string | null;
  marketName: string | null;
  businessDate: string;
  normalizedProduct: string;
  normalizedUnit: string;
  withdrawn: bigint;
  goodReturn: bigint;
  damagedReturn: bigint;
  /** Entered withdrawal prices are the round's sale-price evidence. */
  withdrawalUnitPrices: bigint[];
  /** Sum of withdrawal milli-quantity × its own entered satang price. */
  withdrawalValueNumerator: bigint;
  /** At least one legacy withdrawal row has no usable entered price. */
  hasUnpricedWithdrawal: boolean;
}

interface ItemCalculationParts {
  items: WhiteSheetItemCalculation[];
  expectedSales: bigint;
  warnings: string[];
}

export class WhiteSheetValidationError extends Error {
  readonly issues: readonly WhiteSheetValidationIssue[];

  constructor(issues: readonly WhiteSheetValidationIssue[]) {
    super(issues.map((issue) => issue.message).join("; "));
    this.name = "WhiteSheetValidationError";
    this.issues = [...issues];
  }
}

function fail(
  code: WhiteSheetValidationCode,
  message: string,
  context: Pick<WhiteSheetValidationIssue, "rowIndex" | "groupKey"> = {},
): never {
  throw new WhiteSheetValidationError([{ code, message, ...context }]);
}

function powerOfTen(exponent: number): bigint {
  return BigInt(10) ** BigInt(exponent);
}

function roundDivide(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor;
  const remainder = value % divisor;
  return remainder * BigInt(2) >= divisor ? quotient + BigInt(1) : quotient;
}

/** Convert a finite non-negative decimal to an integer scale without float arithmetic. */
function toScaledInteger(
  value: number,
  scale: number,
  field: string,
  code: "invalid_quantity" | "invalid_money",
  rowIndex?: number,
): bigint {
  if (!Number.isFinite(value) || value < 0) {
    fail(code, `${field} must be a finite non-negative number`, { rowIndex });
  }

  const [coefficient, exponentText] = value.toString().toLowerCase().split("e");
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const [whole, fraction = ""] = coefficient.split(".");
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
  const unscaled = BigInt(digits);
  const decimalPlaces = fraction.length - exponent;
  const shift = scale - decimalPlaces;

  if (shift >= 0) return unscaled * powerOfTen(shift);
  return roundDivide(unscaled, powerOfTen(-shift));
}

function fromScaledInteger(value: bigint, scale: number): number {
  const absolute = value < BigInt(0) ? -value : value;
  if (absolute > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("invalid_money", "calculated value exceeds the safe integration range");
  }
  return Number(value) / 10 ** scale;
}

function requireIdentity(value: string, field: string, rowIndex?: number): string {
  const normalized = value.normalize("NFC").trim();
  if (!normalized) {
    fail("invalid_identity", `${field} must not be empty`, { rowIndex });
  }
  return normalized;
}

function groupKeyOf(
  marketKey: string,
  accountabilityRoundId: string | null,
  businessDate: string,
  product: string,
  unit: string,
): string {
  return JSON.stringify([marketKey, accountabilityRoundId, businessDate, product, unit]);
}

function groupLabel(group: ItemAggregate): string {
  return `${group.marketKey}/${group.businessDate}/${group.normalizedProduct}/${group.normalizedUnit}`;
}

function moneyLabel(value: bigint): string {
  return fromScaledInteger(value, MONEY_SCALE).toFixed(MONEY_SCALE);
}

/**
 * A withdrawal row's own effective unit price, in baht — rescaled by the
 * unit's conversion factor for legacy (non-basis) rows exactly as the group
 * loop below does, so write-path seeding and the read-only White Sheet
 * conflict scan derive the SAME candidate price this function would use
 * for informational display. One authoritative derivation, never a second
 * parallel pricing algorithm.
 */
export function resolveWithdrawalUnitPriceBaht(row: {
  unit: string;
  unitPrice: number;
  basisQuantity: number | null;
}): number {
  const hasBasisQuantity = row.basisQuantity !== null && row.basisQuantity !== undefined;
  const rowConversionFactor = conversionFactor(row.unit);
  return !hasBasisQuantity && rowConversionFactor !== 1
    ? row.unitPrice / rowConversionFactor
    : row.unitPrice;
}

function distinctPrices(prices: readonly bigint[]): bigint[] {
  const seen = new Set<string>();
  const distinct: bigint[] = [];

  for (const price of prices) {
    const key = price.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(price);
  }

  return distinct;
}

function buildItemCalculationParts(
  rows: readonly WhiteSheetTransactionRow[],
  centralPrices: ReadonlyMap<string, number>,
  priceConflicts: ReadonlySet<string> = new Set(),
): ItemCalculationParts {
  const groups = new Map<string, ItemAggregate>();

  rows.forEach((row, rowIndex) => {
    const marketKey = requireIdentity(row.marketKey, "marketKey", rowIndex);
    const businessDate = requireIdentity(row.businessDate, "businessDate", rowIndex);
    const normalizedProduct = normalizeProductName(
      requireIdentity(row.productName, "productName", rowIndex),
    );
    const rawUnit = requireIdentity(row.unit, "unit", rowIndex);
    // Reuse the same trusted conversion table the ingestion parser uses
    // (src/lib/parsers/weigh-session/units.ts) so compatible weight units
    // (e.g. withdrawal in โล, return in ขีด) land in one canonical group
    // instead of being silently split into two — which could otherwise
    // manufacture a phantom negative-sold-quantity group and fail the whole
    // sheet. Units with no known conversion (kg vs pieces, pack vs pieces,
    // etc.) pass through unchanged — no conversion is ever guessed here.
    const unitConversion = resolveUnitQuantity(row.quantity, rawUnit);
    const normalizedUnit = unitConversion.unit;
    const transactionType = baseTransactionType(row.transactionType);

    if (!transactionType) {
      fail(
        "unknown_transaction_type",
        `unsupported transaction type at row ${rowIndex}: ${row.transactionType}`,
        { rowIndex },
      );
    }

    const quantity = toScaledInteger(
      unitConversion.quantity,
      QUANTITY_SCALE,
      `quantity at row ${rowIndex}`,
      "invalid_quantity",
      rowIndex,
    );
    const accountabilityRoundId = row.accountabilityRoundId?.trim() || null;
    const key = groupKeyOf(
      marketKey,
      accountabilityRoundId,
      businessDate,
      normalizedProduct,
      normalizedUnit,
    );
    const group = groups.get(key) ?? {
      marketKey,
      accountabilityRoundId,
      marketName: row.marketName ?? null,
      businessDate,
      normalizedProduct,
      normalizedUnit,
      withdrawn: BigInt(0),
      goodReturn: BigInt(0),
      damagedReturn: BigInt(0),
      withdrawalUnitPrices: [],
      withdrawalValueNumerator: BigInt(0),
      hasUnpricedWithdrawal: false,
    };

    if (transactionType === "เบิก") {
      if (row.unitPrice === null) {
        group.withdrawn += quantity;
        group.hasUnpricedWithdrawal = true;
        groups.set(key, group);
        return;
      }
      const hasBasisQuantity = row.basisQuantity !== null && row.basisQuantity !== undefined;
      const hasBasisPrice = row.basisPrice !== null && row.basisPrice !== undefined;
      if (hasBasisQuantity !== hasBasisPrice) {
        fail(
          "invalid_money",
          `basisQuantity and basisPrice must be supplied together at row ${rowIndex}`,
          { rowIndex, groupKey: key },
        );
      }
      // Legacy (non-basis) unitPrice is quoted per the raw unit — rescale it
      // by the same factor as the quantity so unitPrice × quantity stays
      // unchanged after conversion (mirrors applyQuantity in the ingestion
      // parser). Kept for the informational withdrawalUnitPrices display only
      // — BR-01: central daily price, never withdrawal-lot price, prices
      // expected sales.
      const adjustedUnitPrice = resolveWithdrawalUnitPriceBaht({
        unit: rawUnit,
        unitPrice: row.unitPrice,
        basisQuantity: hasBasisQuantity ? (row.basisQuantity as number) : null,
      });
      const unitPrice = toScaledInteger(
        adjustedUnitPrice,
        MONEY_SCALE,
        `unitPrice at row ${rowIndex}`,
        "invalid_money",
        rowIndex,
      );
      // basisQuantity/basisPrice are still structurally validated (a
      // persisted basis row must be internally consistent) even though
      // expected-sales pricing remains tied to the persisted round evidence.
      const basisQuantity = hasBasisQuantity
        ? toScaledInteger(
            // basisQuantity is denominated in the same raw unit as the row
            // (see the parser's basis-unit-mismatch check), so it converts
            // with the identical resolveUnitQuantity call as the quantity.
            resolveUnitQuantity(row.basisQuantity as number, rawUnit).quantity,
            QUANTITY_SCALE,
            `basisQuantity at row ${rowIndex}`,
            "invalid_quantity",
            rowIndex,
          )
        : null;
      if (basisQuantity === BigInt(0)) {
        fail(
          "invalid_quantity",
          `basisQuantity must be greater than zero at row ${rowIndex}`,
          { rowIndex, groupKey: key },
        );
      }
      if (hasBasisPrice) {
        toScaledInteger(
          row.basisPrice as number,
          MONEY_SCALE,
          `basisPrice at row ${rowIndex}`,
          "invalid_money",
          rowIndex,
        );
      }
      group.withdrawn += quantity;
      group.withdrawalValueNumerator += quantity * unitPrice;
      group.withdrawalUnitPrices.push(unitPrice);
    } else if (transactionType === "คืน") {
      group.goodReturn += quantity;
    } else {
      group.damagedReturn += quantity;
    }

    groups.set(key, group);
  });

  const items: WhiteSheetItemCalculation[] = [];
  const warnings: string[] = [];
  let expectedSalesSatang = BigInt(0);

  for (const [key, group] of groups) {
    const sold = group.withdrawn - group.goodReturn - group.damagedReturn;
    if (sold < BigInt(0)) {
      fail(
        "negative_sold_quantity",
        `returns exceed withdrawals for ${groupLabel(group)}`,
        { groupKey: key },
      );
    }

    const category = classifyProduct(group.normalizedProduct);
    const distinctUnitPrices = distinctPrices(group.withdrawalUnitPrices);

    // Value the sold quantity from this round's persisted entered-price
    // evidence. When withdrawal lines vary, retain every line by using their
    // quantity-weighted value numerator; no latest/majority/min/max price is
    // invented. Returns are not lot-attributed, so they reduce that round's
    // entered withdrawal value proportionally.
    let expectedSales: bigint;
    if (group.withdrawn === BigInt(0)) {
      expectedSales = BigInt(0);
    } else if (!group.hasUnpricedWithdrawal) {
      expectedSales = roundDivide(
        sold * group.withdrawalValueNumerator,
        group.withdrawn * MILLIQUANTITY_PER_UNIT,
      );
    } else {
      const priceKey = centralPriceMapKey(group.normalizedProduct, group.normalizedUnit);
      const fallbackPriceSatang = centralPrices.get(priceKey);
      if (fallbackPriceSatang === undefined || priceConflicts.has(priceKey)) {
        fail(
          "missing_withdrawal_price",
          `legacy withdrawal price is missing and no safe central fallback exists for ${groupLabel(group)}`,
          { groupKey: key },
        );
      }
      expectedSales = roundDivide(sold * BigInt(fallbackPriceSatang), MILLIQUANTITY_PER_UNIT);
    }
    expectedSalesSatang += expectedSales;

    if (category === "uncategorized") {
      warnings.push(
        `Uncategorized product: ${group.normalizedProduct} (${group.normalizedUnit})`,
      );
    }
    if (distinctUnitPrices.length > 1) {
      warnings.push(
        centralPriceConflictWarning(
          group.normalizedProduct,
          group.normalizedUnit,
          group.businessDate,
        ) + `: ${distinctUnitPrices.map(moneyLabel).join(", ")}`,
      );
    }

    items.push({
      marketKey: group.marketKey,
      businessDate: group.businessDate,
      normalizedProduct: group.normalizedProduct,
      normalizedUnit: group.normalizedUnit,
      category,
      withdrawnQuantity: fromScaledInteger(group.withdrawn, QUANTITY_SCALE),
      goodReturnQuantity: fromScaledInteger(group.goodReturn, QUANTITY_SCALE),
      damagedReturnQuantity: fromScaledInteger(group.damagedReturn, QUANTITY_SCALE),
      soldQuantity: fromScaledInteger(sold, QUANTITY_SCALE),
      withdrawalUnitPrices: distinctUnitPrices.map((price) =>
        fromScaledInteger(price, MONEY_SCALE),
      ),
      expectedSales: fromScaledInteger(expectedSales, MONEY_SCALE),
    });
  }

  return {
    items,
    expectedSales: expectedSalesSatang,
    warnings,
  };
}

export function calculateWhiteSheetItems(
  rows: readonly WhiteSheetTransactionRow[],
  centralPrices: ReadonlyMap<string, number> = new Map(),
  priceConflicts: ReadonlySet<string> = new Set(),
): WhiteSheetItemCalculation[] {
  return buildItemCalculationParts(rows, centralPrices, priceConflicts).items;
}

function moneyInput(value: number, field: string): bigint {
  return toScaledInteger(value, MONEY_SCALE, field, "invalid_money");
}

function normalizedExpenses(expenses: Readonly<WhiteSheetExpenses>): {
  expenses: WhiteSheetExpenses;
  total: bigint;
} {
  const labor = moneyInput(expenses.labor, "expenses.labor");
  const locationFee = moneyInput(expenses.locationFee, "expenses.locationFee");
  const bag = moneyInput(expenses.bag, "expenses.bag");
  const snack = moneyInput(expenses.snack, "expenses.snack");
  const other = moneyInput(expenses.other, "expenses.other");

  return {
    expenses: {
      labor: fromScaledInteger(labor, MONEY_SCALE),
      locationFee: fromScaledInteger(locationFee, MONEY_SCALE),
      bag: fromScaledInteger(bag, MONEY_SCALE),
      snack: fromScaledInteger(snack, MONEY_SCALE),
      other: fromScaledInteger(other, MONEY_SCALE),
      ...(expenses.otherNote === undefined ? {} : { otherNote: expenses.otherNote }),
    },
    total: labor + locationFee + bag + snack + other,
  };
}

export function calculateDigitalWhiteSheet(
  input: Readonly<DigitalWhiteSheetInput>,
): DigitalWhiteSheetCalculation {
  const marketKey = requireIdentity(input.marketKey, "marketKey");
  const marketLabel = requireIdentity(input.marketLabel, "marketLabel");
  const businessDate = requireIdentity(input.businessDate, "businessDate");

  input.transactions.forEach((row, rowIndex) => {
    if (row.marketKey.trim() !== marketKey || row.businessDate.trim() !== businessDate) {
      fail(
        "summary_scope_mismatch",
        `transaction row ${rowIndex} does not belong to ${marketKey}/${businessDate}`,
        { rowIndex },
      );
    }
  });

  const itemParts = buildItemCalculationParts(
    input.transactions,
    input.centralPrices ?? new Map(),
    input.priceConflicts ?? new Set(),
  );
  const verifiedTransfers = moneyInput(input.verifiedTransfers, "verifiedTransfers");
  const actualCashSubmitted = moneyInput(input.actualCashSubmitted, "actualCashSubmitted");
  const expenseParts = normalizedExpenses(input.expenses);
  const expectedCash = itemParts.expectedSales - verifiedTransfers - expenseParts.total;
  const difference = actualCashSubmitted - expectedCash;
  const status = difference < BigInt(0)
    ? "shortage"
    : difference > BigInt(0)
      ? "overage"
      : "matched";

  return {
    marketKey,
    marketLabel,
    businessDate,
    expectedSales: fromScaledInteger(itemParts.expectedSales, MONEY_SCALE),
    verifiedTransfers: fromScaledInteger(verifiedTransfers, MONEY_SCALE),
    expenses: expenseParts.expenses,
    expenseTotal: fromScaledInteger(expenseParts.total, MONEY_SCALE),
    expectedCash: fromScaledInteger(expectedCash, MONEY_SCALE),
    actualCashSubmitted: fromScaledInteger(actualCashSubmitted, MONEY_SCALE),
    difference: fromScaledInteger(difference, MONEY_SCALE),
    status,
    warnings: itemParts.warnings,
    items: itemParts.items,
  };
}
