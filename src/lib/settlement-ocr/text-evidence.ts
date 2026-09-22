/**
 * Parses a bare number or a "ยอด <number>" line as SECONDARY, non-
 * authoritative evidence for a nearby slip/settlement-sheet image — see
 * reconcileTypedAmount. This module is deliberately standalone: it does NOT
 * decide which image a typed amount belongs to. Associating a text message
 * with a specific image is intentionally outside this generic helper; the
 * production quoted-image path lives in quoted-amount-correction.ts and
 * requires LINE's explicit quotedMessageId.
 */
const TYPED_AMOUNT_PATTERN = /^(?:ยอด\s*)?([0-9][0-9,]*(?:\.[0-9]{1,2})?)$/;

export function parseTypedAmountText(text: string): number | null {
  const match = TYPED_AMOUNT_PATTERN.exec(text.trim());
  if (!match) return null;
  const amount = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

export type TypedAmountReconciliation =
  | { kind: "no_typed_amount" }
  | { kind: "match"; amount: number }
  | { kind: "ocr_null_candidate"; typedAmount: number }
  | { kind: "mismatch"; typedAmount: number; extractedAmount: number };

/**
 * Compares a typed amount against the OCR-extracted amount for the SAME
 * field. Never authoritative on its own:
 *   match              -> strengthens review context only
 *   OCR null + typed    -> a candidate that still requires human confirmation
 *   mismatch            -> forces review/fallback, never silently resolved
 */
export function reconcileTypedAmount(
  typedAmount: number | null,
  extractedAmount: number | null,
  toleranceBaht = 0,
): TypedAmountReconciliation {
  if (typedAmount === null) return { kind: "no_typed_amount" };
  if (extractedAmount === null) return { kind: "ocr_null_candidate", typedAmount };

  const diffCents = Math.round(typedAmount * 100) - Math.round(extractedAmount * 100);
  if (Math.abs(diffCents) <= Math.round(toleranceBaht * 100)) {
    return { kind: "match", amount: extractedAmount };
  }
  return { kind: "mismatch", typedAmount, extractedAmount };
}

/**
 * This module remains parser/reconciliation logic only. The webhook's
 * production correction path uses explicit LINE reply linkage rather than
 * timestamp adjacency; see quoted-amount-correction.ts.
 */
