/**
 * Guarded packaging-suffix canonicalization for produce product identity.
 *
 * PRODUCTION INCIDENT: the operator entered
 *
 *   1แอปเปิ้ลกล่อง50บาท / 3กล่อง
 *   8.พุทราจีนกล่อง80บาท / 1กล่อง
 *
 * The parser reads those correctly — product "แอปเปิ้ลกล่อง" in unit "กล่อง" —
 * but the dictionary holds แอปเปิ้ล and พุทราจีน. That costs a needless
 * vocabulary review and, worse, mints a second product identity, so the return
 * typed as plain แอปเปิ้ล reads as product_not_withdrawn against a master that
 * never knew it.
 *
 * The dangerous shortcut here is `name.endsWith("กล่อง") => strip`. The
 * dictionary contains FOUR products whose identity includes the word —
 * ผลไม้กล่อง, ทุเรียนกล่อง, หมอนทองกล่อง, ก้านยาวกล่อง — and folding any of
 * them into its bare form would be a worse bug than the one being fixed. Those
 * are pinned below.
 */
import { describe, it, expect } from "bun:test";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import type { WeighSession, WeighSessionItem } from "@/lib/parsers/weigh-session/types";
import {
  validateProduceEntry,
  masterCellKey,
  type ProduceValidationResult,
  type RoundMasterRow,
} from "./entry-validation";
import { canonicalProduceProductName, isApprovedProductName } from "./product-vocabulary";

const BOX = "กล่อง";

function item(overrides: Partial<WeighSessionItem> & { product_name: string }): WeighSessionItem {
  return {
    item_number: 1,
    price_per_unit: 50,
    quantity: 1,
    unit: BOX,
    section: "main",
    transaction_type: "เบิก",
    pricing_mode: "unit",
    basis_quantity: null,
    basis_unit: null,
    basis_price: null,
    ...overrides,
  };
}

function session(items: WeighSessionItem[]): WeighSession {
  return {
    date: "2026-09-02",
    staff_name: "ดำ",
    sender_name: null,
    transaction_time: "18:00",
    session_title: "ราชพฤกษ์",
    session_kind: "main",
    declared_transaction_type: null,
    items: items.map((entry, index) => ({ ...entry, item_number: index + 1 })),
    parse_errors: [],
  };
}

function validate(parsed: WeighSession, roundRows: RoundMasterRow[] = []): ProduceValidationResult {
  return validateProduceEntry({ parsed, roundRows, roundBound: true });
}

function withdrawal(productName: string, unit = BOX, quantity = 3): RoundMasterRow {
  return { product_name: productName, unit, quantity, price_per_unit: 50, transaction_type: "เบิก" };
}

function vocabularyNames(result: ProduceValidationResult): string[] {
  return result.reviews
    .filter((entry) => entry.kind === "unknown_product_vocabulary")
    .map((entry) => entry.productName);
}

// ── 1-2. THE INCIDENT ─────────────────────────────────────────────────────────

describe("the box-suffixed withdrawal that triggered a needless review", () => {
  it("resolves แอปเปิ้ลกล่อง sold by กล่อง to canonical แอปเปิ้ล", () => {
    expect(canonicalProduceProductName("แอปเปิ้ลกล่อง", BOX)).toBe("แอปเปิ้ล");
    expect(vocabularyNames(validate(session([item({ product_name: "แอปเปิ้ลกล่อง" })]))))
      .toEqual([]);
  });

  it("resolves พุทราจีนกล่อง to canonical พุทราจีน (ม74)", () => {
    expect(canonicalProduceProductName("พุทราจีนกล่อง", BOX)).toBe("พุทราจีน");
    expect(vocabularyNames(validate(session([item({ product_name: "พุทราจีนกล่อง" })]))))
      .toEqual([]);
  });

  it("reaches the gate from the real operator text", () => {
    const parsed = parseWeighSession(
      [
        "ดำ-ราชพฤกษ์ เบิก 2/9/69",
        "1แอปเปิ้ลกล่อง50บาท", "3กล่อง",
        "8.พุทราจีนกล่อง80บาท", "1กล่อง",
      ].join("\n"),
      "2026-09-02",
    );
    // Raw evidence is exactly what the operator typed; the parser is correct.
    expect(parsed.items.map((entry) => [entry.product_name, entry.unit]))
      .toEqual([["แอปเปิ้ล" + BOX, BOX], ["พุทราจีน" + BOX, BOX]]);

    const result = validate(parsed);
    expect(vocabularyNames(result)).toEqual([]);
    // #114 lives here too: 1 and 8 are both written, so the gap still blocks.
    expect(result.blocking.some((entry) => entry.kind === "item_number_gap")).toBe(true);
  });
});

// ── 3. CANONICAL FULL NAME ALWAYS WINS ────────────────────────────────────────

describe("registered products whose identity includes the word", () => {
  // If this ever fails, an endsWith-strip has been introduced and four real
  // products have silently merged into other products.
  const REGISTERED = ["ผลไม้กล่อง", "ทุเรียนกล่อง", "หมอนทองกล่อง", "ก้านยาวกล่อง"];

  for (const name of REGISTERED) {
    it(`keeps ${name} intact`, () => {
      expect(isApprovedProductName(name)).toBe(true);
      expect(canonicalProduceProductName(name, BOX)).toBe(name);
    });
  }

  it("keeps ผลไม้กล่อง out of ผลไม้'s master cell", () => {
    expect(masterCellKey("ผลไม้กล่อง", BOX)).not.toBe(masterCellKey("ผลไม้", BOX));
  });

  it("does not let a box product be returned against a different withdrawal", () => {
    const result = validate(
      session([item({ product_name: "ผลไม้กล่อง", transaction_type: "คืน", quantity: 1 })]),
      [withdrawal("ทุเรียนกล่อง")],
    );
    expect(result.advisories.map((entry) => entry.kind)).toContain("product_not_withdrawn");
  });
});

// ── 4-5. THE OTHER GUARDS ─────────────────────────────────────────────────────

describe("the guards that keep stripping honest", () => {
  it("does not strip when the unit is not กล่อง", () => {
    expect(canonicalProduceProductName("แอปเปิ้ลกล่อง", "ลูก")).toBe("แอปเปิ้ลกล่อง");
    expect(vocabularyNames(validate(session([item({ product_name: "แอปเปิ้ลกล่อง", unit: "ลูก" })]))))
      .toEqual(["แอปเปิ้ลกล่อง"]);
  });

  it("does not strip when the remainder is not an approved product", () => {
    expect(canonicalProduceProductName("สินค้าใหม่กล่อง", BOX)).toBe("สินค้าใหม่กล่อง");
    expect(vocabularyNames(validate(session([item({ product_name: "สินค้าใหม่กล่อง" })]))))
      .toEqual(["สินค้าใหม่กล่อง"]);
  });

  it("does not strip a bare กล่อง down to nothing", () => {
    expect(canonicalProduceProductName(BOX, BOX)).toBe(BOX);
  });

  it("never fuzzy-matches the remainder", () => {
    // แอปเปิ้ล is one character away, and that is not good enough.
    expect(canonicalProduceProductName("แอปเปิ้ลลกล่อง", BOX)).toBe("แอปเปิ้ลลกล่อง");
  });

  it("leaves a name that merely contains the word alone", () => {
    expect(canonicalProduceProductName("กล่องแอปเปิ้ล", BOX)).toBe("กล่องแอปเปิ้ล");
  });
});

// ── 6-8. WITHDRAWAL ↔ RETURN IDENTITY ─────────────────────────────────────────

describe("withdrawal and return meet on one identity", () => {
  it("matches a plain return against a box-suffixed withdrawal", () => {
    const result = validate(
      session([item({ product_name: "แอปเปิ้ล", transaction_type: "คืน", quantity: 1 })]),
      [withdrawal("แอปเปิ้ลกล่อง")],
    );
    expect(result.advisories.map((entry) => entry.kind)).not.toContain("product_not_withdrawn");
    expect(result.blocking.map((entry) => entry.kind)).not.toContain("unit_not_withdrawn");
  });

  it("matches a box-suffixed return against a plain withdrawal", () => {
    const result = validate(
      session([item({ product_name: "แอปเปิ้ลกล่อง", transaction_type: "คืน", quantity: 1 })]),
      [withdrawal("แอปเปิ้ล")],
    );
    expect(result.advisories.map((entry) => entry.kind)).not.toContain("product_not_withdrawn");
  });

  it("matches a damaged return the same way, in both directions", () => {
    const damagedPlain = validate(
      session([item({ product_name: "แอปเปิ้ล", transaction_type: "คืนเสีย", quantity: 1 })]),
      [withdrawal("แอปเปิ้ลกล่อง")],
    );
    expect(damagedPlain.advisories.map((entry) => entry.kind)).not.toContain("product_not_withdrawn");

    const damagedBoxed = validate(
      session([item({ product_name: "แอปเปิ้ลกล่อง", transaction_type: "คืนเสีย", quantity: 1 })]),
      [withdrawal("แอปเปิ้ล")],
    );
    expect(damagedBoxed.advisories.map((entry) => entry.kind)).not.toContain("product_not_withdrawn");
  });

  it("still enforces the inventory invariant across the two spellings", () => {
    // 3 withdrawn as แอปเปิ้ลกล่อง, 4 returned as แอปเปิ้ล — one identity, so
    // the excess is visible instead of hiding behind a second product.
    const result = validate(
      session([item({ product_name: "แอปเปิ้ล", transaction_type: "คืน", quantity: 4 })]),
      [withdrawal("แอปเปิ้ลกล่อง", BOX, 3)],
    );
    expect(result.advisories.map((entry) => entry.kind)).toContain("return_exceeds_withdrawal");
  });

  it("keeps a unit mismatch visible rather than folding it away", () => {
    // Withdrawn by กล่อง, returned by ลูก: the return name does not strip
    // (wrong unit), so this must not quietly match.
    const result = validate(
      session([item({ product_name: "แอปเปิ้ลกล่อง", transaction_type: "คืน", unit: "ลูก", quantity: 1 })]),
      [withdrawal("แอปเปิ้ล")],
    );
    expect(result.advisories.map((entry) => entry.kind)).toContain("product_not_withdrawn");
  });
});

// ── 9. RAW EVIDENCE ───────────────────────────────────────────────────────────

describe("raw operator evidence is never rewritten", () => {
  it("leaves the parsed item and the exception text as typed", () => {
    const parsed = parseWeighSession(
      ["ดำ-ราชพฤกษ์ เบิก 2/9/69", "1แอปเปิ้ลกล่อง50บาท", "3กล่อง"].join("\n"),
      "2026-09-02",
    );
    const before = JSON.parse(JSON.stringify(parsed.items));
    const result = validate(parsed);

    // Validation is pure: the session it was handed is untouched.
    expect(parsed.items).toEqual(before);
    expect(parsed.items[0].product_name).toBe("แอปเปิ้ล" + BOX);
    expect(result.status).not.toBe("blocked");
  });

  it("reports the operator's own spelling when a box name IS unknown", () => {
    const result = validate(session([item({ product_name: "สินค้าใหม่กล่อง" })]));
    const review = result.reviews.find((entry) => entry.kind === "unknown_product_vocabulary");
    expect(review && review.kind === "unknown_product_vocabulary" && review.productName)
      .toBe("สินค้าใหม่กล่อง");
  });
});

// ── 10. EVERYTHING ELSE IS UNAFFECTED ─────────────────────────────────────────

describe("products without the suffix are untouched", () => {
  it("leaves ordinary names and reviewed aliases alone", () => {
    for (const [name, unit] of [
      ["มะม่วงเขียวมรกต", "โล"],
      ["แอปเปิ้ล", BOX],
      ["พุทราจีน", "โล"],
      ["ทุเรียน", "โล"],
    ] as const) {
      expect(canonicalProduceProductName(name, unit)).toBe(name);
    }
  });

  it("still reviews a suspicious near-miss spelling", () => {
    const result = validate(session([item({ product_name: "มะม่วงเขียวรกต", unit: "โล" })]));
    expect(vocabularyNames(result)).toEqual(["มะม่วงเขียวรกต"]);
  });

  it("does not change the identity of a non-box unit line", () => {
    expect(masterCellKey("แอปเปิ้ล", "โล")).toBe(masterCellKey("แอปเปิ้ล", "โล"));
    expect(masterCellKey("แอปเปิ้ลกล่อง", "โล")).not.toBe(masterCellKey("แอปเปิ้ล", "โล"));
  });
});
