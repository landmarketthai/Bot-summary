export type WhiteSheetPreview = {
  documentType: "white_sheet" | "unknown";
  market: string | null;
  dateRaw: string | null;
  dateIso: string | null;
  sellerNames: string[];
  salesAmountBaht: number | null;
  transferAmountBaht: number | null;
  cashSentAmountBaht: number | null;
  laborAmountBaht: number | null;
  remainingCashAmountBaht: number | null;
  expenses: { labelRaw: string | null; amountBaht: number | null; confidence: number }[];
  lowConfidenceFields: string[];
  overallConfidence: number;
  notes: string[];
};

export const FIELD_LABELS = {
  market: "ตลาด", dateRaw: "วันที่", dateIso: "วันที่", sellerNames: "คนขาย",
  salesAmountBaht: "ยอดขาย", transferAmountBaht: "เงินโอน",
  cashSentAmountBaht: "ส่งเงินสด", laborAmountBaht: "ค่าแรง",
  remainingCashAmountBaht: "เหลือเงินสด",
} as const;
export const MONEY_FIELDS = [
  "salesAmountBaht", "transferAmountBaht", "cashSentAmountBaht",
  "laborAmountBaht", "remainingCashAmountBaht",
] as const;
export const READ_CONFIDENCE = 0.8;
export const MAX_EXPENSES = 20;
const uncertainPaths = [
  ...Object.keys(FIELD_LABELS), "expenses",
  ...Array.from({ length: MAX_EXPENSES }, (_, i) =>
    [`expenses[${i}].labelRaw`, `expenses[${i}].amountBaht`]).flat(),
];
const nullableText = { type: ["string", "null"], minLength: 1, maxLength: 80 };
// Negative readings are refused in this MVP: there is no field for validating
// their visible sign/meaning. A user must check them manually.
const money = { type: ["number", "null"], minimum: 0, maximum: Number.MAX_SAFE_INTEGER / 100 };
const confidence = { type: "number", minimum: 0, maximum: 1 };
const properties = {
  documentType: { type: "string", enum: ["white_sheet", "unknown"] },
  market: nullableText,
  dateRaw: nullableText,
  dateIso: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
  sellerNames: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 80 } },
  ...Object.fromEntries(MONEY_FIELDS.map((field) => [field, money])),
  expenses: {
    type: "array", maxItems: MAX_EXPENSES,
    items: {
      type: "object", additionalProperties: false,
      properties: { labelRaw: nullableText, amountBaht: money, confidence },
      required: ["labelRaw", "amountBaht", "confidence"],
    },
  },
  lowConfidenceFields: { type: "array", maxItems: uncertainPaths.length, items: { type: "string", enum: uncertainPaths } },
  overallConfidence: confidence,
  notes: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 160 } },
};
export const WHITE_SHEET_PREVIEW_JSON_SCHEMA = {
  type: "object", additionalProperties: false, properties, required: Object.keys(properties),
};

type Schema = {
  type: string | string[]; properties?: Record<string, Schema>; required?: string[];
  additionalProperties?: boolean; items?: Schema; enum?: string[];
  minimum?: number; maximum?: number; minLength?: number; maxLength?: number;
  maxItems?: number; pattern?: string;
};

// Validate the same bounded schema sent to OpenAI; no permissive coercions.
function validate(value: unknown, schema: Schema): void {
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (![schema.type].flat().includes(type)) throw new Error("Invalid preview field type");
  if (value === null) return;
  if (typeof value === "number" && (!Number.isFinite(value)
    || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) {
    throw new Error("Invalid preview number");
  }
  if (typeof value === "string" && (
    !value.trim() || value.length < (schema.minLength ?? 0)
    || value.length > (schema.maxLength ?? Infinity)
    || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
    || (schema.enum && !schema.enum.includes(value))
    || (schema.pattern && !new RegExp(schema.pattern).test(value))
  )) throw new Error("Invalid preview text");
  if (Array.isArray(value)) {
    if (value.length > (schema.maxItems ?? Infinity)) throw new Error("Preview array too long");
    for (const item of value) validate(item, schema.items!);
  } else if (type === "object") {
    const record = value as Record<string, unknown>;
    if (schema.required!.some((key) => !Object.hasOwn(record, key))
      || Object.keys(record).some((key) => !Object.hasOwn(schema.properties!, key))) {
      throw new Error("Invalid preview keys");
    }
    for (const [key, field] of Object.entries(schema.properties!)) validate(record[key], field);
  }
}

export function parseWhiteSheetPreview(value: unknown): WhiteSheetPreview {
  validate(value, WHITE_SHEET_PREVIEW_JSON_SCHEMA as Schema);
  const result = structuredClone(value) as WhiteSheetPreview;
  if (result.dateIso !== null) {
    const date = new Date(`${result.dateIso}T00:00:00Z`);
    if (!result.dateRaw || !Number.isFinite(date.getTime())
      || date.toISOString().slice(0, 10) !== result.dateIso
      || date.getUTCFullYear() < 1900 || date.getUTCFullYear() > 2200) {
      throw new Error("Invalid preview calendar date");
    }
  }
  result.sellerNames = [...new Set(result.sellerNames.map((name) => name.trim()))];
  const uncertain = new Set(result.lowConfidenceFields);
  for (const field of Object.keys(FIELD_LABELS) as (keyof typeof FIELD_LABELS)[]) {
    if (uncertain.has(field)) {
      if (field === "sellerNames") result.sellerNames = [];
      else result[field] = null;
    }
  }
  if (uncertain.has("dateRaw") || uncertain.has("dateIso")) result.dateIso = null;
  result.expenses.forEach((expense, i) => {
    const labelPath = `expenses[${i}].labelRaw`;
    const amountPath = `expenses[${i}].amountBaht`;
    if (uncertain.has("expenses") || (expense.confidence < READ_CONFIDENCE
      && !uncertain.has(labelPath) && !uncertain.has(amountPath))) {
      uncertain.add(labelPath);
      uncertain.add(amountPath);
    }
    // A visible row with an unreadable cell is uncertain, never "absent".
    if (expense.labelRaw === null) uncertain.add(labelPath);
    if (expense.amountBaht === null) uncertain.add(amountPath);
    if (uncertain.has(labelPath)) expense.labelRaw = null;
    if (uncertain.has(amountPath)) expense.amountBaht = null;
  });
  for (const path of uncertain) {
    const match = /^expenses\[(\d+)\]/u.exec(path);
    if (match && Number(match[1]) >= result.expenses.length) throw new Error("Invalid expense review path");
  }
  result.lowConfidenceFields = [...uncertain];
  return result;
}
