import { describe, expect, it } from "bun:test";
import {
  ALL_DATA_QUALITY_CATEGORIES,
  severityForCategory,
  type DataQualitySeverity,
} from "./severity";

const VALID_SEVERITIES: DataQualitySeverity[] = ["CRITICAL", "ACTION_REQUIRED", "ADVISORY", "NORMAL"];

describe("severityForCategory", () => {
  it("is total: every category maps to exactly one valid severity", () => {
    for (const category of ALL_DATA_QUALITY_CATEGORIES) {
      const severity = severityForCategory(category);
      expect(VALID_SEVERITIES).toContain(severity);
    }
  });

  it("is deterministic: repeated calls never disagree", () => {
    for (const category of ALL_DATA_QUALITY_CATEGORIES) {
      const first = severityForCategory(category);
      const second = severityForCategory(category);
      expect(second).toBe(first);
    }
  });

  it("a price conflict is always ADVISORY and never escalates", () => {
    expect(severityForCategory("produce_price_conflict")).toBe("ADVISORY");
  });

  it("financial mismatches are CRITICAL", () => {
    expect(severityForCategory("financial_reconciliation_mismatch")).toBe("CRITICAL");
    expect(severityForCategory("financial_settlement_mismatch")).toBe("CRITICAL");
  });

  it("real duplicate persistence is CRITICAL", () => {
    expect(severityForCategory("produce_duplicate_persistence")).toBe("CRITICAL");
  });

  it("no return recorded is ACTION_REQUIRED", () => {
    expect(severityForCategory("produce_no_return")).toBe("ACTION_REQUIRED");
  });

  it("the full mapping matches the documented contract exactly", () => {
    const snapshot = Object.fromEntries(
      ALL_DATA_QUALITY_CATEGORIES.map((c) => [c, severityForCategory(c)]),
    );
    expect(snapshot).toEqual({
      produce_no_return:                  "ACTION_REQUIRED",
      produce_stale_failed_session:       "ACTION_REQUIRED",
      produce_price_conflict:             "ADVISORY",
      produce_duplicate_round_review:     "ACTION_REQUIRED",
      produce_duplicate_round_ambiguous:  "CRITICAL",
      produce_unattributable:             "ACTION_REQUIRED",
      produce_possible_duplicate:         "ACTION_REQUIRED",
      produce_duplicate_persistence:      "CRITICAL",
      produce_lifecycle_ambiguity:        "CRITICAL",
      financial_reconciliation_mismatch:  "CRITICAL",
      financial_evidence_incomplete:      "ACTION_REQUIRED",
      financial_settlement_mismatch:      "CRITICAL",
      house_stock_unsend_close_after_finalize: "ACTION_REQUIRED",
    });
  });
});
