import type { Json } from "@/types/database";
import { parseBusinessDate } from "@/lib/line/white-sheet-close-command";
import {
  SETTLEMENT_SHEET_DOCUMENT_TYPES,
  type MoneyField,
  type SettlementLineItem,
  type SettlementSheetExtraction,
} from "@/lib/settlement-ocr/types";

/**
 * Below this, a field the model DID answer is still treated as "could not
 * read reliably" — the number is kept (never discarded) but the field is
 * still listed as needing human confirmation. See requirement: unknown/
 * low-confidence money fields must require human confirmation.
 */
export const FIELD_CONFIDENCE_THRESHOLD = 0.6;
/** Below this, the photo itself is not treated as a settlement sheet at all. */
export const DOCUMENT_TYPE_CONFIDENCE_THRESHOLD = 0.6;

const moneyFieldSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    value: { type: ["number", "null"], minimum: 0 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["value", "confidence"],
} as const;

const lineItemSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    label: { type: ["string", "null"] },
    amount: { type: "number", minimum: 0 },
  },
  required: ["label", "amount"],
} as const;

export const SETTLEMENT_SHEET_EXTRACTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    document_type: { type: "string", enum: SETTLEMENT_SHEET_DOCUMENT_TYPES },
    document_type_confidence: { type: "number", minimum: 0, maximum: 1 },
    market_text: { type: ["string", "null"] },
    date_text: {
      type: ["string", "null"],
      description:
        "Visibly written date, transcribed exactly (e.g. \"21/9/69\"). Never convert " +
        "Buddhist Era to Gregorian here — application code does that.",
    },
    staff_text: { type: ["string", "null"] },
    sales_total: moneyFieldSchema,
    transfer_amount: moneyFieldSchema,
    cash_submitted: moneyFieldSchema,
    expenses_total: moneyFieldSchema,
    expense_items: { type: "array", items: lineItemSchema },
    labor_total: moneyFieldSchema,
    labor_items: { type: "array", items: lineItemSchema },
    cash_remaining: moneyFieldSchema,
  },
  required: [
    "document_type",
    "document_type_confidence",
    "market_text",
    "date_text",
    "staff_text",
    "sales_total",
    "transfer_amount",
    "cash_submitted",
    "expenses_total",
    "expense_items",
    "labor_total",
    "labor_items",
    "cash_remaining",
  ],
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConfidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0;
}

function parseMoneyField(value: unknown): MoneyField {
  if (!isRecord(value)) return { value: null, confidence: 0 };
  const raw = value.value;
  const amount = typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : null;
  return { value: amount, confidence: parseConfidence(value.confidence) };
}

function parseNullableText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseLineItems(value: unknown): SettlementLineItem[] {
  if (!Array.isArray(value)) return [];
  const items: SettlementLineItem[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const amount = entry.amount;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) continue;
    items.push({ label: parseNullableText(entry.label), amount });
  }
  return items;
}

export function parseSettlementSheetExtraction(value: unknown): SettlementSheetExtraction {
  if (!isRecord(value)) throw new Error("Extractor returned a non-object result");

  const documentType =
    typeof value.document_type === "string"
      && (SETTLEMENT_SHEET_DOCUMENT_TYPES as readonly string[]).includes(value.document_type)
      ? (value.document_type as SettlementSheetExtraction["documentType"])
      : "OTHER";

  return {
    documentType,
    documentTypeConfidence: parseConfidence(value.document_type_confidence),
    marketText: parseNullableText(value.market_text),
    dateText: parseNullableText(value.date_text),
    staffText: parseNullableText(value.staff_text),
    salesTotal: parseMoneyField(value.sales_total),
    transferAmount: parseMoneyField(value.transfer_amount),
    cashSubmitted: parseMoneyField(value.cash_submitted),
    expensesTotal: parseMoneyField(value.expenses_total),
    expenseItems: parseLineItems(value.expense_items),
    laborTotal: parseMoneyField(value.labor_total),
    laborItems: parseLineItems(value.labor_items),
    cashRemaining: parseMoneyField(value.cash_remaining),
  };
}

export function extractionToJson(extraction: SettlementSheetExtraction): Json {
  return JSON.parse(JSON.stringify(extraction)) as Json;
}

/**
 * B.E. date parsing, shared verbatim with the guided White Sheet close and
 * settlement commands (src/lib/line/white-sheet-close-command.ts) — one
 * Buddhist-date contract only. Conservative: only a clean dd/mm/yy(69) or
 * dd/mm/2569 numeric pattern parses; anything else (Thai month names, typos,
 * crossed-out digits) returns null and the field must be confirmed by hand.
 */
export function parseSettlementSheetDate(dateText: string | null): string | null {
  if (!dateText) return null;
  return parseBusinessDate(dateText.replace(/\s+/g, ""));
}

function toCents(value: number): number {
  return Math.round(value * 100);
}

export interface ArithmeticCheck {
  /**
   * transfer_amount + cash_remaining + expenses_total + labor_total — the
   * EXISTING settlement_entries formula (migrations 0014/0015, SettlementForm.tsx:
   * ยอดขาย = money_transfer + money_cash + expenses + labor), where money_cash
   * is cash_remaining ("เหลือเงินสด"), NOT cash_submitted ("ส่งเงินสด"). See
   * template.ts / draft-service.ts for the same mapping applied to the
   * confirm template.
   */
  expectedSales: number | null;
  /** null whenever expectedSales or the extracted sales_total is unknown. */
  difference: number | null;
  /**
   * true only when every equation below that COULD be checked (all its
   * inputs present) held; false if any of them failed; null when nothing
   * could be checked at all. Never invents a missing figure.
   */
  ok: boolean | null;
  /** The sheet's own ledger line: sales_total = transfer_amount + cash_submitted + expenses_total. */
  ledgerOk: boolean | null;
  /** The sheet's own cash-handout line: cash_submitted = cash_remaining + labor_total. */
  cashOk: boolean | null;
}

/**
 * The ONE place this equation is evaluated for OCR drafts. cash_submitted
 * ("ส่งเงินสด") is evidence/cross-check only — it is what the sheet says was
 * handed over gross, BEFORE labor was paid out of it. cash_remaining
 * ("เหลือเงินสด") is what actually maps to money_cash in the existing
 * settlement_entries formula. Both sheet-internal equations are validated
 * independently (each only when all of ITS inputs are present); neither
 * invents a missing figure as zero.
 */
export function checkSettlementArithmetic(fields: {
  salesTotal: number | null;
  transferAmount: number | null;
  cashSubmitted: number | null;
  expensesTotal: number | null;
  laborTotal: number | null;
  cashRemaining: number | null;
}): ArithmeticCheck {
  const { salesTotal, transferAmount, cashSubmitted, expensesTotal, laborTotal, cashRemaining } = fields;

  let ledgerOk: boolean | null = null;
  if (salesTotal !== null && transferAmount !== null && cashSubmitted !== null && expensesTotal !== null) {
    ledgerOk = toCents(salesTotal) === toCents(transferAmount) + toCents(cashSubmitted) + toCents(expensesTotal);
  }

  let cashOk: boolean | null = null;
  if (cashSubmitted !== null && cashRemaining !== null && laborTotal !== null) {
    cashOk = toCents(cashSubmitted) === toCents(cashRemaining) + toCents(laborTotal);
  }

  let expectedSales: number | null = null;
  if (transferAmount !== null && cashRemaining !== null && expensesTotal !== null && laborTotal !== null) {
    expectedSales =
      (toCents(transferAmount) + toCents(cashRemaining) + toCents(expensesTotal) + toCents(laborTotal)) / 100;
  }

  let difference: number | null = null;
  let salesOk: boolean | null = null;
  if (expectedSales !== null && salesTotal !== null) {
    const differenceCents = toCents(salesTotal) - toCents(expectedSales);
    difference = differenceCents / 100;
    salesOk = differenceCents === 0;
  }

  const ran = [ledgerOk, cashOk, salesOk].filter((v): v is boolean => v !== null);
  const ok = ran.length === 0 ? null : ran.every(Boolean);

  return { expectedSales, difference, ok, ledgerOk, cashOk };
}

export function isFieldConfident(field: MoneyField): boolean {
  return field.value !== null && field.confidence >= FIELD_CONFIDENCE_THRESHOLD;
}

export function isLikelySettlementSheet(extraction: SettlementSheetExtraction): boolean {
  return (
    extraction.documentType === "SETTLEMENT_SHEET"
    && extraction.documentTypeConfidence >= DOCUMENT_TYPE_CONFIDENCE_THRESHOLD
  );
}
