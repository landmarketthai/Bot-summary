// Parses amount lines from manual slip session messages.
// Supported formats:
//   "1. 100 บาท"   "1) 300"   "100 บาท"   "1,200.50 บาท"
//   "1.90"         "2.160 บาท"  (compact indexed: sequence 1-99, no space before amount)
//
// Ambiguity rule: a plain value carrying "บาท" and <=2 decimal places is money,
// so "10.50 บาท" means 10.50. Compact indexed input keeps the legacy no-space
// form ("1.90" => seq 1, amount 90); with บาท it is used only when the suffix
// cannot be a valid 2-decimal monetary amount ("2.160 บาท" => amount 160).
const COMPACT_INDEXED_RE = /^(\d{1,2})\.(\d+(?:\.\d+)?)\s*(?:บาท)?\s*$/;
const PREFIXED_RE = /^\d+[.)]\s*([\d,]+(?:\.\d{1,2})?)\s*(?:บาท)?\s*$/;
const MONEY_WITH_BAHT_RE = /^([\d,]+(?:\.\d{1,2})?)\s*บาท\s*$/;

export function parseManualSlipAmounts(text: string): Array<{ rawLine: string; amount: number }> {
  return text.split("\n").flatMap(raw => {
    const line = raw.trim();
    if (!line) return [];

    // Explicit currency wins over compact-index interpretation when it is a
    // valid monetary decimal. This is what keeps 10.50 บาท / 99.99 บาท exact.
    const money = MONEY_WITH_BAHT_RE.exec(line);
    if (money) {
      const token = money[1];
      const normalized = token.replace(/,/g, "");
      const [whole, fraction] = normalized.split(".");
      const unambiguouslyMoney = fraction === undefined || token.includes(",") || whole.length >= 2;
      if (unambiguouslyMoney) {
        const amount = parseFloat(normalized);
        return amount > 0 ? [{ rawLine: line, amount }] : [];
      }
    }

    const compact = COMPACT_INDEXED_RE.exec(line);
    if (compact) {
      const amount = parseFloat(compact[2]);
      return amount > 0 ? [{ rawLine: line, amount }] : [];
    }
    const prefixed = PREFIXED_RE.exec(line);
    if (!prefixed) return [];
    const amount = parseFloat(prefixed[1].replace(/,/g, ""));
    return amount > 0 ? [{ rawLine: line, amount }] : [];
  });
}
