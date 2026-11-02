import type { Json } from "@/types/database";

export const SLIP_CHECK_STATUSES = [
  "PROCESSING",
  "EXTRACTED",
  "PARTIAL_EXTRACTED",
  "NEED_REVIEW",
  "FAILED",
] as const;

export const SLIP_TYPES = [
  "BANK_SLIP_QR",
  "BANK_SLIP_NO_QR",
  "THAI_HELP_THAI",
  "GWALLET",
  "NUMBERS_ONLY",
  "WHITE_PAPER",
  "UNKNOWN",
] as const;

export type SlipCheckStatus = (typeof SLIP_CHECK_STATUSES)[number];
export type SlipType = (typeof SLIP_TYPES)[number];

export interface SlipExtraction {
  slipType: SlipType;
  grossAmount: number | null;
  discountAmount: number | null;
  paidAmount: number | null;
  transferAmount: number | null;
  referenceId: string | null;
  transactionTime: string | null;
  senderName: string | null;
  receiverName: string | null;
  receiverAccountTail: string | null;
  // Raw transcription signals kept for forensics, not business semantics. They are
  // what the canonicalization above actually decided on, so persisting them is the
  // difference between "why was this slip classified GWALLET?" being answerable
  // from the record and needing a fresh, non-deterministic re-extraction.
  paymentChannelText: string | null;
  headlineTotalAmount: number | null;
  confidence: number;
}

export const SLIP_EXTRACTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    slip_type: { type: "string", enum: SLIP_TYPES },
    gross_amount: { type: ["number", "null"], minimum: 0 },
    discount_amount: { type: ["number", "null"], minimum: 0 },
    paid_amount: { type: ["number", "null"], minimum: 0 },
    project_right_amount: {
      type: ["number", "null"],
      minimum: 0,
      description:
        "Visible number beside สิทธิโครงการฯ, สิทธิรัฐบาล, or เงินสนับสนุนจากรัฐ. Not G-Wallet.",
    },
    gwallet_amount: {
      type: ["number", "null"],
      minimum: 0,
      description: "Visible number beside G-Wallet or ยอด G-Wallet. Not สิทธิโครงการฯ.",
    },
    headline_total_amount: {
      type: ["number", "null"],
      minimum: 0,
      description:
        "Visible top-level successful-receipt / goods-and-services total, e.g. beside " +
        "รับเงินสำเร็จ, ยอดรับรวม, or ยอดรวมการรับเงิน. Transcribe only; never a computed sum.",
    },
    transfer_amount: { type: ["number", "null"], minimum: 0 },
    reference_id: { type: ["string", "null"] },
    transaction_time: {
      type: ["string", "null"],
      description:
        "Visibly written transaction date/time text, without Buddhist-to-Gregorian conversion. Preserve short years such as 69.",
    },
    sender_name: { type: ["string", "null"] },
    receiver_name: { type: ["string", "null"] },
    receiver_account_tail: {
      type: ["string", "null"],
      description:
        "Last four digits of the receiver/payee/merchant account only. Null when only sender/payer digits are visible.",
    },
    payment_channel_text: {
      type: ["string", "null"],
      description:
        "Visible payment-channel or programme line, transcribed verbatim (e.g. " +
        "\"ไทยช่วยไทย พลัส (60/40)\"). Copy only what is printed; do not interpret it.",
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: [
    "slip_type",
    "gross_amount",
    "discount_amount",
    "paid_amount",
    "project_right_amount",
    "gwallet_amount",
    "headline_total_amount",
    "transfer_amount",
    "reference_id",
    "transaction_time",
    "sender_name",
    "receiver_name",
    "receiver_account_tail",
    "payment_channel_text",
    "confidence",
  ],
} as const;

// Exact substring the model must transcribe verbatim on the payment-channel line
// for a raw GWALLET reading to be canonicalized to THAI_HELP_THAI. Substring match
// only, after whitespace normalization — no fuzzy/semantic matching.
const THAI_HELP_THAI_MARKER = "ไทยช่วยไทย";

// Raw slip types the ไทยช่วยไทย marker is allowed to upgrade to THAI_HELP_THAI.
// THAI_HELP_THAI and GWALLET are the same underlying receipt layout — a labeled
// wallet slip with an optional government-subsidy line — so a raw GWALLET reading
// that also carries a visible ไทยช่วยไทย programme line is the sibling-type
// misclassification actually seen in production (this is exactly defect #1).
// Every other raw type is deliberately excluded:
//   - BANK_SLIP_QR / BANK_SLIP_NO_QR are a structurally different receipt (real
//     transfer_amount, real merchant account tail); a stray marker on one of these
//     must not silently rewrite it into a labeled-wallet slip.
//   - NUMBERS_ONLY / WHITE_PAPER / UNKNOWN are already low-confidence fallback
//     classifications; upgrading them on a text match would manufacture a specific
//     business type out of an extraction the model itself couldn't classify.
const MARKER_UPGRADEABLE_RAW_TYPES: ReadonlySet<SlipType> = new Set(["GWALLET"]);

export function parseSlipExtraction(value: unknown): SlipExtraction {
  if (!isRecord(value)) throw new Error("Extractor returned a non-object result");

  const rawSlipType = parseSlipType(value.slip_type);
  const paymentChannelText = parseChannelText(value.payment_channel_text);
  const hasThaiHelpThaiMarker = paymentChannelText !== null
    && paymentChannelText.includes(THAI_HELP_THAI_MARKER);

  // Canonicalization runs first — every downstream business-semantics decision
  // (labeled-amount mapping, receiver-tail fail-closed rule) reads the canonical
  // slipType below, never value.slip_type directly.
  const slipType: SlipType = hasThaiHelpThaiMarker && MARKER_UPGRADEABLE_RAW_TYPES.has(rawSlipType)
    ? "THAI_HELP_THAI"
    : rawSlipType;

  const labeledWalletSlip = slipType === "THAI_HELP_THAI" || slipType === "GWALLET";
  const projectRightAmount = parseNullableAmount(value.project_right_amount);
  const gwalletAmount = parseNullableAmount(value.gwallet_amount);
  const headlineTotalAmount = parseNullableAmount(value.headline_total_amount);
  const genericGrossAmount = parseNullableAmount(value.gross_amount);

  return {
    slipType,
    // headline_total_amount names the exact visible receipt line (รับเงินสำเร็จ,
    // ยอดรับรวม, ยอดรวมการรับเงิน); gross_amount is a looser catch-all the model can
    // fill from a different, less certain number. The explicit label wins over a
    // contradictory generic gross_amount reading. Never derived arithmetically —
    // if both are null, grossAmount stays null even when discount + paid are known.
    grossAmount: labeledWalletSlip
      ? headlineTotalAmount ?? genericGrossAmount
      : genericGrossAmount,
    discountAmount: labeledWalletSlip
      ? projectRightAmount ?? parseNullableAmount(value.discount_amount)
      : parseNullableAmount(value.discount_amount),
    paidAmount: labeledWalletSlip
      ? gwalletAmount ?? parseNullableAmount(value.paid_amount)
      : parseNullableAmount(value.paid_amount),
    transferAmount: parseNullableAmount(value.transfer_amount),
    referenceId: parseReferenceId(value.reference_id),
    transactionTime: parseNullableTimestamp(value.transaction_time),
    senderName: parseNullableText(value.sender_name),
    receiverName: parseNullableText(value.receiver_name),
    // ponytail: Thai Help Thai AND G-Wallet receipts show the payer's **NNNN under
    // รับเงินจาก, not a merchant tail — fail closed for both canonical labeled-wallet
    // types. Gated on the canonical slipType computed above, not raw value.slip_type,
    // so a raw GWALLET that gets upgraded to THAI_HELP_THAI is still nulled here, and
    // a raw GWALLET that stays GWALLET is now nulled too (closing the tail leak from
    // the production defect, where the null-guard only fired on raw THAI_HELP_THAI).
    receiverAccountTail: labeledWalletSlip
      ? null
      : parseAccountTail(value.receiver_account_tail),
    paymentChannelText,
    headlineTotalAmount,
    confidence: parseConfidence(value.confidence),
  };
}

export function determineSlipCheckStatus(extraction: SlipExtraction): SlipCheckStatus {
  const hasTime = extraction.transactionTime !== null;
  const hasReference = extraction.referenceId !== null;
  const hasReceiver = extraction.receiverName !== null;

  if (extraction.slipType === "BANK_SLIP_QR" || extraction.slipType === "BANK_SLIP_NO_QR") {
    if (extraction.transferAmount !== null && hasTime && hasReference) return "EXTRACTED";
    if (
      extraction.transferAmount !== null
      && (hasTime || hasReference || hasReceiver)
    ) return "PARTIAL_EXTRACTED";
    return "NEED_REVIEW";
  }

  if (extraction.slipType === "THAI_HELP_THAI" || extraction.slipType === "GWALLET") {
    if (
      extraction.grossAmount !== null
      && extraction.discountAmount !== null
      && extraction.paidAmount !== null
      && hasTime
      && hasReference
    ) return "EXTRACTED";
    if (
      extraction.paidAmount !== null
      && (hasTime || hasReference || hasReceiver)
    ) return "PARTIAL_EXTRACTED";
    return "NEED_REVIEW";
  }

  return "NEED_REVIEW";
}

export function extractionToJson(extraction: SlipExtraction): Json {
  return {
    slip_type: extraction.slipType,
    gross_amount: extraction.grossAmount,
    discount_amount: extraction.discountAmount,
    paid_amount: extraction.paidAmount,
    transfer_amount: extraction.transferAmount,
    reference_id: extraction.referenceId,
    transaction_time: extraction.transactionTime,
    sender_name: extraction.senderName,
    receiver_name: extraction.receiverName,
    receiver_account_tail: extraction.receiverAccountTail,
    payment_channel_text: extraction.paymentChannelText,
    headline_total_amount: extraction.headlineTotalAmount,
    confidence: extraction.confidence,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSlipType(value: unknown): SlipType {
  return typeof value === "string" && SLIP_TYPES.includes(value as SlipType)
    ? value as SlipType
    : "UNKNOWN";
}

function parseNullableAmount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function parseNullableText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

// Free text the model transcribes off the receipt, so it is treated as untrusted
// before it is matched against or persisted. The receiver tail is deliberately
// nulled for wallet slips; a run of four or more digits swept in from a
// neighbouring line would defeat that guarantee from the next column over, so it
// is redacted here. Short runs such as the "(60/40)" split ratio are part of the
// programme label itself and are kept.
const CHANNEL_TEXT_MAX_LENGTH = 120;

function parseChannelText(value: unknown): string | null {
  const text = parseNullableText(value);
  if (!text) return null;
  const redacted = normalizeWhitespace(text).replace(/\d{4,}/g, "[redacted]");
  return redacted.length > 0 ? redacted.slice(0, CHANNEL_TEXT_MAX_LENGTH) : null;
}

function parseReferenceId(value: unknown): string | null {
  const text = parseNullableText(value);
  if (!text) return null;
  const compact = text.replace(/\s+/g, "");
  return compact.length > 0 ? compact : null;
}

function parseNullableTimestamp(value: unknown): string | null {
  const text = parseNullableText(value);
  if (!text) return null;

  const normalized = normalizeVisibleThaiTimestamp(text);
  if (!normalized) return null;
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

const THAI_MONTHS: Record<string, number> = {
  "ม.ค.": 1,
  "มกราคม": 1,
  "ก.พ.": 2,
  "กุมภาพันธ์": 2,
  "มี.ค.": 3,
  "มีนาคม": 3,
  "เม.ย.": 4,
  "เมษายน": 4,
  "พ.ค.": 5,
  "พฤษภาคม": 5,
  "มิ.ย.": 6,
  "มิถุนายน": 6,
  "ก.ค.": 7,
  "กรกฎาคม": 7,
  "ส.ค.": 8,
  "สิงหาคม": 8,
  "ก.ย.": 9,
  "กันยายน": 9,
  "ต.ค.": 10,
  "ตุลาคม": 10,
  "พ.ย.": 11,
  "พฤศจิกายน": 11,
  "ธ.ค.": 12,
  "ธันวาคม": 12,
};

function normalizeVisibleThaiTimestamp(text: string): string | null {
  const trimmed = text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[–—]/g, "-")
    // Printed labels and separators only; the date and time digits themselves
    // must all be present — nothing here supplies a missing part.
    .replace(/^วันที่(?:ทำรายการ)?\s*:?\s*/u, "")
    .replace(/\s*,?\s*เวลา\s*:?\s*/u, " ")
    .replace(/\s*,\s*/u, " ")
    .replace(/\s*น\.?\s*$/u, "")
    .trim();

  return (
    parseThaiMonthTimestamp(trimmed) ??
    parseNumericDateTimestamp(trimmed) ??
    parseCompactIsoTimestamp(trimmed) ??
    parseIsoTimestamp(trimmed)
  );
}

function parseThaiMonthTimestamp(text: string): string | null {
  const match = /^(\d{1,2})\s*([\u0E00-\u0E7F.]+?)\s*(\d{4}|\d{2})(?:\s*-?\s*(.+))?$/.exec(text);
  if (!match) return null;
  // "\u0E15.\u0E04" printed without its final dot is still an exact table spelling.
  const month = THAI_MONTHS[match[2]] ?? THAI_MONTHS[`${match[2]}.`];
  if (!month) return null;
  // A printed date without a printed time is incomplete: never invent 00:00.
  const clock = match[4] ? parseClock(match[4]) : null;
  if (!clock) return null;
  return formatOffsetDate(
    normalizeThaiYear(parseInt(match[3], 10)),
    month,
    parseInt(match[1], 10),
    clock,
    "+07:00",
  );
}

function parseNumericDateTimestamp(text: string): string | null {
  const match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?:\s*-?\s*(.+))?$/.exec(text);
  if (!match) return null;
  const clock = match[4] ? parseClock(match[4]) : null;
  if (!clock) return null;
  return formatOffsetDate(
    normalizeThaiYear(parseInt(match[3], 10)),
    parseInt(match[2], 10),
    parseInt(match[1], 10),
    clock,
    "+07:00",
  );
}

function parseCompactIsoTimestamp(text: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})(Z|[+-]\d{2}:?\d{2})$/.exec(text);
  if (!match) return null;
  return formatOffsetDate(
    normalizeThaiYear(parseInt(match[1], 10)),
    parseInt(match[2], 10),
    parseInt(match[3], 10),
    { hour: parseInt(match[4], 10), minute: parseInt(match[5], 10), second: parseInt(match[6], 10) },
    normalizeOffset(match[7]),
  );
}

function parseIsoTimestamp(text: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.exec(text);
  if (!match) return null;
  return formatOffsetDate(
    normalizeThaiYear(parseInt(match[1], 10)),
    parseInt(match[2], 10),
    parseInt(match[3], 10),
    {
      hour: parseInt(match[4], 10),
      minute: parseInt(match[5], 10),
      second: parseInt(match[6] ?? "0", 10),
    },
    normalizeOffset(match[7]),
  );
}

function parseClock(text: string): { hour: number; minute: number; second: number } | null {
  const t = text.trim().replace(/^-\s*/, "");
  // Thai receipts print the clock as 17:49 or 17.49.
  const colon = /^(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?$/.exec(t);
  if (colon) {
    return {
      hour: parseInt(colon[1], 10),
      minute: parseInt(colon[2], 10),
      second: parseInt(colon[3] ?? "0", 10),
    };
  }
  const compact = /^(\d{2})(\d{2})(\d{2})?$/.exec(t);
  if (compact) {
    return {
      hour: parseInt(compact[1], 10),
      minute: parseInt(compact[2], 10),
      second: parseInt(compact[3] ?? "0", 10),
    };
  }
  return null;
}

function formatOffsetDate(
  year: number,
  month: number,
  day: number,
  clock: { hour: number; minute: number; second: number },
  offset: string,
): string | null {
  if (!isValidDateTimeParts(year, month, day, clock.hour, clock.minute, clock.second)) return null;
  return `${year}-${pad2(month)}-${pad2(day)}T${pad2(clock.hour)}:${pad2(clock.minute)}:${pad2(clock.second)}${offset}`;
}

function normalizeThaiYear(year: number): number {
  const fullYear = year < 100 ? year + 2500 : year;
  return fullYear > 2400 ? fullYear - 543 : fullYear;
}

function isValidDateTimeParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): boolean {
  if (year < 1900 || year > 2200) return false;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return false;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  );
}

function normalizeOffset(offset: string): string {
  if (offset === "Z") return "Z";
  return offset.includes(":") ? offset : `${offset.slice(0, 3)}:${offset.slice(3)}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function parseAccountTail(value: unknown): string | null {
  const text = parseNullableText(value);
  if (!text) return null;
  if (/^\*+\d+$/.test(text.replace(/\s+/g, ""))) return null;
  const digits = text.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function parseConfidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0;
}
