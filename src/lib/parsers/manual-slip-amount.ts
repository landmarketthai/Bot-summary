// Parses amount lines from manual slip session messages.
// Supported formats:
//   "1. 100 บาท"   "1) 300"   "100 บาท"   "1,200 บาท"
//   "1.90"         "2.160 บาท"  (compact indexed: sequence 1-99, no space before amount)
//
// COMPACT: "1.90" → seq 1, amount 90 (seq must be 1-99 to avoid "100.50" being misread)
// PREFIXED: numbered prefix (บาท optional)  e.g. "1. 100" "2) 300 บาท"
// SUFFIXED: amount + บาท (no prefix)         e.g. "100 บาท" "1,200 บาท"

// ponytail: COMPACT_INDEXED checked first; 3-digit prefix fails \d{1,2} so "100.50 บาท" falls through to SUFFIXED
const COMPACT_INDEXED_RE = /^(\d{1,2})\.(\d+(?:\.\d+)?)\s*(?:บาท)?\s*$/;
const PREFIXED_RE = /^\d+[.)]\s*([\d,]+(?:\.\d+)?)\s*(?:บาท)?\s*$/;
const SUFFIXED_RE = /^([\d,]+(?:\.\d+)?)\s*บาท\s*$/;
const LABELED_RE = /^\u0e22\u0e2d\u0e14\s*([\d,]+(?:\.\d+)?)\s*(?:บาท)?\s*$/u;

export function parseManualSlipAmounts(text: string): Array<{ rawLine: string; amount: number }> {
  return text.split("\n").flatMap(raw => {
    const line = raw.trim();
    if (!line) return [];
    const compact = COMPACT_INDEXED_RE.exec(line);
    if (compact) {
      const amount = parseFloat(compact[2]);
      return amount > 0 ? [{ rawLine: line, amount }] : [];
    }
    const m = SUFFIXED_RE.exec(line) ?? PREFIXED_RE.exec(line) ?? LABELED_RE.exec(line);
    if (!m) return [];
    const amount = parseFloat(m[1].replace(/,/g, ""));
    return amount > 0 ? [{ rawLine: line, amount }] : [];
  });
}
