/**
 * Internal item-number gaps.
 *
 * PRODUCTION INCIDENT: a corrected withdrawal list was resent with item #5
 * accidentally omitted — "...4, 6, 7..." — and Produce accepted the sequence
 * without a word. The dropped line was a real priced row (แอปเปิ้ล 10 บาท,
 * 84 ลูก), so an entire financial line disappeared silently.
 *
 * The rule is deliberately narrow: only numbers the operator actually WROTE
 * define the range, because the parser synthesizes sequential numbers for
 * unnumbered lines and a free-form draft has no numbering to be missing from.
 */
import { describe, it, expect } from "bun:test";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import type { WeighSession, WeighSessionItem } from "@/lib/parsers/weigh-session/types";
import { validateProduceEntry, type ProduceValidationResult } from "./entry-validation";
import { buildBlockingValidationReply } from "./entry-validation-message";

const DATE = "2026-09-02";

function validate(parsed: WeighSession): ProduceValidationResult {
  return validateProduceEntry({ parsed, roundRows: [], roundBound: true });
}

/** A withdrawal document whose lines carry exactly the given printed numbers. */
function numbered(numbers: number[]): WeighSession {
  const products = ["องุ่น", "มะม่วง", "ส้ม", "ทุเรียน", "กล้วย", "มะละกอ", "เงาะ", "ลำไย"];
  const lines = ["ดำ-ตลาด เบิก 2/9/69"];
  numbers.forEach((number, index) => {
    lines.push(`${number}.${products[index % products.length]}${(index + 1) * 10}บาท`, "2โล");
  });
  return parseWeighSession(lines.join("\n"), DATE);
}

function gapOf(parsed: WeighSession): number[] | null {
  const gap = validate(parsed).blocking.find((entry) => entry.kind === "item_number_gap");
  return gap && gap.kind === "item_number_gap" ? gap.missingItemNumbers : null;
}

// ── 1. THE EXACT INCIDENT ─────────────────────────────────────────────────────

describe("the 2 SEP incident — item #5 dropped from a resent list", () => {
  const INCIDENT = [
    "ดำ-ตลาด เบิก 2/9/69",
    "1.องุ่น100บาท", "10โล",
    "2.มะม่วง50บาท", "5โล",
    "3.ส้ม20บาท", "4โล",
    "4.ทุเรียน300บาท", "2โล",
    "6.กล้วย15บาท", "6โล",
    "7.มะละกอ25บาท", "3โล",
  ].join("\n");

  it("blocks the sequence that used to be accepted silently", () => {
    const parsed = parseWeighSession(INCIDENT, DATE);
    expect(parsed.items.map((entry) => entry.item_number)).toEqual([1, 2, 3, 4, 6, 7]);

    const result = validate(parsed);
    expect(result.status).toBe("blocked");
    expect(result.blocking).toContainEqual({
      kind: "item_number_gap",
      severity: "blocking",
      missingItemNumbers: [5],
    });
  });

  it("names the missing number in the operator's reply", () => {
    const reply = buildBlockingValidationReply(validate(parseWeighSession(INCIDENT, DATE)));
    expect(reply).toContain("พบเลขข้อขาดในรายการ");
    expect(reply).toContain("ขาดข้อ 5");
  });

  // ── 8. EDIT/FIX ─────────────────────────────────────────────────────────────
  it("clears once the missing line — the real แอปเปิ้ล row — is supplied", () => {
    const repaired = INCIDENT.replace(
      "6.กล้วย15บาท",
      ["5.แอปเปิ้ล10บาท", "84ลูก", "6.กล้วย15บาท"].join("\n"),
    );
    const parsed = parseWeighSession(repaired, DATE);
    expect(parsed.items.map((entry) => entry.item_number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(gapOf(parsed)).toBeNull();
  });
});

// ── 2-4. THE RANGE RULE ───────────────────────────────────────────────────────

describe("the gap range", () => {
  it("reports every hole, ascending, in one blocker", () => {
    expect(gapOf(numbered([1, 3, 5]))).toEqual([2, 4]);
  });

  it("does not require numbering to start at 1 — a continuation document is fine", () => {
    expect(gapOf(numbered([10, 11, 12]))).toBeNull();
  });

  it("still catches a hole inside a continuation document", () => {
    expect(gapOf(numbered([10, 12]))).toEqual([11]);
  });

  it("ignores anything outside the operator's own range", () => {
    // Nothing before 10 or after 12 is "missing" — only the operator knows
    // where their document starts and ends.
    expect(gapOf(numbered([10, 11, 12]))).toBeNull();
    expect(gapOf(numbered([4]))).toBeNull();
  });

  it("is deterministic across repeated evaluation", () => {
    const parsed = numbered([2, 6]);
    expect(gapOf(parsed)).toEqual([3, 4, 5]);
    expect(gapOf(parsed)).toEqual([3, 4, 5]);
  });

  it("does not auto-renumber, invent rows, or disturb source order", () => {
    const parsed = numbered([1, 2, 4]);
    const before = parsed.items.map((entry) => [entry.item_number, entry.product_name]);
    validate(parsed);
    expect(parsed.items).toHaveLength(3);
    expect(parsed.items.map((entry) => [entry.item_number, entry.product_name])).toEqual(before);
  });
});

// ── 2026-09-19 incident — forwarded session, false-missing on arrival order ────
//
// PRODUCTION INCIDENT: a forwarded session's accumulated_text carried item
// numbers 1-25 in full, but LINE delivered them out of order — 1..15 in
// order, then 24,16,25,17,20,18,19,21,23,22. The close gate replied "missing
// 16-23" and refused with entry_gate_refusal. The gap check reads the
// operator's printed numbers into a Set (never a sequence keyed to arrival
// position), so completeness must not depend on the order the lines were
// typed, forwarded, or replayed in — only on which numbers the final,
// assembled document actually carries.

describe("arrival order never fabricates a gap in a complete document", () => {
  it("clears for the exact production sequence (1..15, then 24,16,25,17,20,18,19,21,23,22)", () => {
    const parsed = numbered(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 24, 16, 25, 17, 20, 18, 19, 21, 23, 22],
    );
    expect(parsed.items.map((entry) => entry.item_number).sort((a, b) => a - b))
      .toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(gapOf(parsed)).toBeNull();
    expect(validate(parsed).status).not.toBe("blocked");
  });

  it("clears for another arbitrary out-of-order complete set", () => {
    const parsed = numbered([5, 1, 4, 2, 3, 9, 6, 8, 7, 10]);
    expect(gapOf(parsed)).toBeNull();
    expect(validate(parsed).status).not.toBe("blocked");
  });

  it("still catches a genuine hole no matter how the surrounding numbers arrive", () => {
    // Same shape as the production sequence, but 20 is truly never sent.
    const parsed = numbered(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 24, 16, 25, 17, 18, 19, 21, 23, 22],
    );
    expect(gapOf(parsed)).toEqual([20]);
    expect(validate(parsed).status).toBe("blocked");
  });
});

// ── 9. UNNUMBERED / SYNTHETIC NUMBERING ───────────────────────────────────────

describe("numbering the operator never wrote", () => {
  it("leaves an entirely unnumbered draft alone", () => {
    const parsed = parseWeighSession(
      ["ดำ-ตลาด เบิก 2/9/69", "องุ่น100บาท", "10โล", "มะม่วง50บาท", "5โล"].join("\n"),
      DATE,
    );
    // The parser synthesized 1 and 2; neither is operator evidence.
    expect(parsed.items.map((entry) => entry.item_number_explicit)).toEqual([undefined, undefined]);
    expect(gapOf(parsed)).toBeNull();
  });

  it("counts a synthesized number as occupying its slot, not as a hole", () => {
    // "2" is never written, but the unnumbered line lands there, so the
    // document is whole and must not be blocked.
    const parsed = parseWeighSession(
      [
        "ดำ-ตลาด เบิก 2/9/69",
        "1.องุ่น100บาท", "10โล",
        "มะม่วง50บาท", "5โล",
        "3.ส้ม20บาท", "4โล",
      ].join("\n"),
      DATE,
    );
    expect(parsed.items.map((entry) => entry.item_number)).toEqual([1, 2, 3]);
    expect(parsed.items[1].item_number_explicit).toBeUndefined();
    expect(gapOf(parsed)).toBeNull();
  });

  it("treats a deliberate ลบข้อ removal as accounted for, not missing", () => {
    // Otherwise the removal grammar would become unusable on a numbered list:
    // every ลบข้อ leaves a hole by design.
    const parsed = parseWeighSession(
      [
        "ดำ-ตลาด เบิก 2/9/69",
        "1.องุ่น100บาท", "10โล",
        "2.มะม่วง50บาท", "5โล",
        "3.ส้ม20บาท", "4โล",
        "ลบข้อ 2",
      ].join("\n"),
      DATE,
    );
    expect(parsed.items.map((entry) => entry.item_number)).toEqual([1, 3]);
    expect(parsed.draft_item_actions?.at(-1)).toMatchObject({ kind: "remove", status: "applied" });
    expect(gapOf(parsed)).toBeNull();
  });
});

// ── 5. DUPLICATE BEHAVIOUR PRESERVED ──────────────────────────────────────────

describe("duplicate_item_number is unchanged", () => {
  it("still blocks a repeated printed number", () => {
    const parsed = parseWeighSession(
      [
        "ดำ-ตลาด เบิก 2/9/69",
        "1.องุ่น100บาท", "10โล",
        "1.มะม่วง50บาท", "5โล",
      ].join("\n"),
      DATE,
    );
    const result = validate(parsed);
    expect(result.status).toBe("blocked");
    expect(result.blocking).toContainEqual({
      kind: "duplicate_item_number",
      severity: "blocking",
      itemNumber: 1,
      matchCount: 2,
    });
    // A duplicate is not a gap, and must not be reported as one.
    expect(gapOf(parsed)).toBeNull();
  });

  it("reports both when a list both repeats a number and skips one", () => {
    const parsed = parseWeighSession(
      [
        "ดำ-ตลาด เบิก 2/9/69",
        "1.องุ่น100บาท", "10โล",
        "1.มะม่วง50บาท", "5โล",
        "4.ส้ม20บาท", "4โล",
      ].join("\n"),
      DATE,
    );
    const result = validate(parsed);
    expect(result.blocking.map((entry) => entry.kind).sort())
      .toEqual(["duplicate_item_number", "item_number_gap"]);
    expect(gapOf(parsed)).toEqual([2, 3]);
  });
});

// ── 6. NOT HUMAN-REVIEW-CONFIRMABLE ───────────────────────────────────────────

describe("a gap can never be confirmed away", () => {
  it("is blocking, so it never enters the review set", () => {
    const parsed = numbered([1, 2, 4]);
    const result = validate(parsed);
    expect(result.status).toBe("blocked");
    expect(result.reviews.map((entry) => entry.kind)).not.toContain("item_number_gap");
    expect(result.advisories.map((entry) => entry.kind)).not.toContain("item_number_gap");
  });

  it("keeps the session blocked even when a confirmable review is also present", () => {
    // A subunit review would normally be confirmable with "ยืนยันข้อ N".
    // The gap outranks it: status stays "blocked", so no confirm path runs.
    const parsed = parseWeighSession(
      [
        "กี้-ตลาด เบิก 2/9/69",
        "1.องุ่น100บาท", ".3ขีด",
        "3.มะม่วง50บาท", "5โล",
      ].join("\n"),
      DATE,
    );
    const result = validate(parsed);
    expect(result.reviews.some((entry) => entry.kind === "subunit_confirmation")).toBe(true);
    expect(result.status).toBe("blocked");
    expect(gapOf(parsed)).toEqual([2]);
  });
});

// ── Message safety ────────────────────────────────────────────────────────────

describe("the blocked reply stays sane", () => {
  it("summarizes a pathological gap instead of listing every number", () => {
    const parsed = numbered([1, 400]);
    const missing = gapOf(parsed) ?? [];
    // Enumeration is capped; the block still stands.
    expect(missing.length).toBeLessThanOrEqual(50);
    expect(missing[0]).toBe(2);

    const reply = buildBlockingValidationReply(validate(parsed));
    expect(reply).toContain("ขาดข้อ 2");
    expect(reply).toContain("และอีก");
    expect([...reply].length).toBeLessThan(1000);
  });

  it("tells the operator to send the missing line, not to fix an over-total", () => {
    const reply = buildBlockingValidationReply(validate(numbered([1, 3])));
    expect(reply).toContain("ส่งรายการข้อ 2");
    expect(reply).not.toContain("ยอดเกิน");
  });
});

// ── Guard on the evidence field itself ────────────────────────────────────────

describe("item_number_explicit", () => {
  it("survives the multiline product-name-on-its-own-line form", () => {
    const parsed = parseWeighSession(
      ["ดำ-ตลาด เบิก 2/9/69", "1.แอปเปิ้ล", "10บาท", "84ลูก"].join("\n"),
      DATE,
    );
    expect(parsed.items[0]?.item_number_explicit).toBe(true);
  });

  it("survives a basis-priced header", () => {
    const parsed = parseWeighSession(
      ["ดำ-ตลาด เบิก 2/9/69", "2.เงาะ3โล100บาท", "15โล"].join("\n"),
      DATE,
    );
    expect(parsed.items[0]?.item_number_explicit).toBe(true);
  });

  it("is absent — never false-positive true — on a synthesized number", () => {
    const parsed = parseWeighSession(
      ["ดำ-ตลาด เบิก 2/9/69", "องุ่น100บาท", "10โล"].join("\n"),
      DATE,
    );
    const [only] = parsed.items as WeighSessionItem[];
    expect(only.item_number).toBe(1);
    expect(only.item_number_explicit).toBeUndefined();
  });
});
