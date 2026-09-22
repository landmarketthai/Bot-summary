export const SETTLEMENT_SHEET_DOCUMENT_TYPES = ["SETTLEMENT_SHEET", "OTHER"] as const;
export type SettlementSheetDocumentType = (typeof SETTLEMENT_SHEET_DOCUMENT_TYPES)[number];

/** One handwritten money figure, with the model's own confidence in reading it. */
export interface MoneyField {
  value: number | null;
  confidence: number;
}

/** One handwritten line under ค่าใช้จ่าย or ค่าแรง — the sheet allows several. */
export interface SettlementLineItem {
  label: string | null;
  amount: number;
}

/**
 * Raw, per-field extraction from one settlement-sheet photo. Nothing here is
 * a business decision — see draft-service.ts's review gate and the arithmetic
 * check for those. Market/date/staff are transcribed for the
 * cross-check against the already-open guided round only; they are never
 * the identity used to write settlement_entries (see gate.ts / draft-service.ts).
 */
export interface SettlementSheetExtraction {
  documentType: SettlementSheetDocumentType;
  documentTypeConfidence: number;
  marketText: string | null;
  dateText: string | null;
  staffText: string | null;
  salesTotal: MoneyField;
  transferAmount: MoneyField;
  cashSubmitted: MoneyField;
  expensesTotal: MoneyField;
  expenseItems: SettlementLineItem[];
  laborTotal: MoneyField;
  laborItems: SettlementLineItem[];
  cashRemaining: MoneyField;
  /**
   * Provenance of this reading, set by extractor.ts / cascade-extractor.ts
   * AFTER parsing — never present in the raw model JSON, so optional here
   * and absent from hand-built test fixtures.
   */
  extractionProvider?: string;
  extractionModel?: string;
  extractionPass?: "primary" | "fallback";
}

export interface SettlementSheetExtractionInput {
  bytes: Uint8Array;
  mimeType: string;
}

export interface SettlementSheetExtractor {
  extract(input: SettlementSheetExtractionInput): Promise<SettlementSheetExtraction>;
}
