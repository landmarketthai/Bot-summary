import { describe, it, expect } from "bun:test";
import type { WeighSession, WeighSessionItem } from "@/lib/parsers/weigh-session/types";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import {
  validateProduceEntry,
  computeValidationDigest,
  type ProduceValidationException,
  type RoundMasterRow,
} from "./entry-validation";
import {
  buildBlockingValidationReply,
  buildPriceAdvisoryNotification,
  buildPriceAdvisoryWarning,
} from "./entry-validation-message";
import {
  countCodePoints,
  LINE_TEXT_MESSAGE_HARD_MAX_CODE_POINTS,
} from "@/lib/summary/line-chunking";

// ── Fixtures ──────────────────────────────────────────────────────────────────
//
// Every case below is a real Production failure pattern (P4A §18), anonymized
// only where the market/seller name is irrelevant to the behaviour.

function item(overrides: Partial<WeighSessionItem> & { product_name: string }): WeighSessionItem {
  return {
    item_number: 1,
    price_per_unit: 100,
    quantity: 1,
    unit: "โล",
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
    date: "2026-08-09",
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

function master(rows: Array<Partial<RoundMasterRow> & { product_name: string }>): RoundMasterRow[] {
  return rows.map((row) => ({
    unit: "โล",
    quantity: 1,
    price_per_unit: 100,
    transaction_type: "เบิก",
    ...row,
  }));
}

function bound(parsed: WeighSession, roundRows: RoundMasterRow[] = []) {
  return validateProduceEntry({ parsed, roundRows, roundBound: true });
}

function kinds(exceptions: ProduceValidationException[]): string[] {
  return exceptions.map((exception) => exception.kind);
}

// ── CASE A — unknown unit ─────────────────────────────────────────────────────

describe("unknown unit", () => {
  it("blocks a good return booked in โลก against a โล withdrawal", () => {
    const result = bound(
      session([
        item({ product_name: "มังคุด", quantity: 15.4, unit: "โลก", price_per_unit: 45, transaction_type: "คืน" }),
      ]),
      master([{ product_name: "มังคุด", quantity: 15.9, price_per_unit: 45 }]),
    );

    expect(result.status).toBe("blocked");
    expect(kinds(result.blocking)).toEqual(["unknown_unit"]);
    const [exception] = result.blocking;
    expect(exception.kind === "unknown_unit" && exception.suggestion).toBe("โล");
  });

  it("blocks the same unit typed on a withdrawal line too", () => {
    const result = bound(session([item({ product_name: "มังคุด", unit: "โลก" })]));
    expect(kinds(result.blocking)).toEqual(["unknown_unit"]);
  });

  it("blocks even when the session carries no round binding at all", () => {
    const result = validateProduceEntry({
      parsed: session([item({ product_name: "มังคุด", unit: "โลก" })]),
      roundRows: [],
      roundBound: false,
    });
    expect(result.status).toBe("blocked");
  });

  it("reaches the gate from real operator text", () => {
    const parsed = parseWeighSession(
      ["18:53 ดำ-ราชพฤกษ์ ชั่งคืน", "18:53 ดำ 1.มังคุด45บาท", "", "15.4โลก"].join("\n"),
      "2026-08-09",
    );
    const returned = parsed.items.find((entry) => entry.product_name.includes("มังคุด"));
    expect(returned?.unit).toBe("โลก");
    expect(bound(parsed, master([{ product_name: "มังคุด", quantity: 15.9, price_per_unit: 45 }])).status)
      .toBe("blocked");
  });

  it("never invents a unit for something genuinely unrecognizable", () => {
    const result = bound(session([item({ product_name: "มังคุด", unit: "xyzzy" })]));
    const [exception] = result.blocking;
    expect(exception.kind === "unknown_unit" && exception.suggestion).toBeNull();
  });
});

describe("risky subunit confirmation", () => {
  it("preserves raw evidence and requires one review per current item", () => {
    const parsed = parseWeighSession(
      "กี้-ตลาด เบิก 29/8/69\n1.องุ่น100บาท\n.3ขีด\n2.มะม่วง100บาท\n500กรัม",
      "2026-08-29",
    );
    expect(parsed.items.map((entry) => [entry.entered_quantity, entry.entered_unit,
      entry.quantity, entry.unit])).toEqual([[0.3, "ขีด", 0.03, "โล"], [500, "กรัม", 0.5, "โล"]]);
    const result = bound(parsed);
    expect(result.status).toBe("review_required");
    expect(result.reviews.filter((entry) => entry.kind === "subunit_confirmation")).toHaveLength(2);
    expect(JSON.stringify(result.reviews)).toContain("0.03");
    expect(JSON.stringify(result.reviews)).toContain("0.5");
  });

  it("reports the risky conversion itself when it is a price-basis expression", () => {
    const parsed = parseWeighSession(
      "กี้-ตลาด เบิก 29/8/69\n1.เงาะ30ขีด100บาท\n15.4โล",
      "2026-08-29",
    );
    const review = bound(parsed).reviews.find((entry) => entry.kind === "subunit_confirmation");
    expect(review).toMatchObject({
      enteredQuantity: 30,
      enteredUnit: "ขีด",
      canonicalQuantity: 3,
      canonicalUnit: "โล",
    });
  });

  it("binds the digest to generation and accountability round", () => {
    const parsed = session([item({ product_name: "องุ่น", entered_quantity: 500, entered_unit: "กรัม" })]);
    const a = validateProduceEntry({ parsed, roundRows: [], roundBound: true,
      validationIdentity: { sessionKey: "s", sessionGeneration: "g1", accountabilityRoundId: "r1" } });
    const b = validateProduceEntry({ parsed, roundRows: [], roundBound: true,
      validationIdentity: { sessionKey: "s", sessionGeneration: "g2", accountabilityRoundId: "r1" } });
    expect(a.digest).not.toBe(b.digest);
  });
});

// ── CASES B/C — product typo ──────────────────────────────────────────────────

describe("product identity", () => {
  const pomegranate = master([
    { product_name: "ทับทิม", unit: "ลูก", quantity: 15, price_per_unit: 15 },
  ]);

  it("blocks ทับทิบ and suggests ทับทิม instead of merging them", () => {
    const result = bound(
      session([
        item({ product_name: "ทับทิบ", unit: "ลูก", quantity: 9, price_per_unit: 15, transaction_type: "คืน" }),
      ]),
      pomegranate,
    );

    expect(result.status).toBe("blocked");
    const [exception] = result.blocking;
    expect(exception.kind).toBe("product_not_withdrawn");
    expect(exception.kind === "product_not_withdrawn" && exception.suggestions).toEqual(["ทับทิม"]);
  });

  it("blocks the same typo in a second market's round independently", () => {
    const result = bound(
      session([
        item({ product_name: "ทับทิบ", unit: "ลูก", quantity: 9, price_per_unit: 15, transaction_type: "คืน" }),
        item({ product_name: "ทับทิม", unit: "ลูก", quantity: 1, price_per_unit: 15, transaction_type: "คืนเสีย" }),
      ]),
      master([{ product_name: "ทับทิม", unit: "ลูก", quantity: 23, price_per_unit: 15 }]),
    );
    expect(kinds(result.blocking)).toEqual(["product_not_withdrawn"]);
  });

  it("keeps an approved alias working — หมอน withdrawn, หมอนทอง returned", () => {
    const result = bound(
      session([
        item({ product_name: "หมอนทอง", quantity: 7.5, price_per_unit: 119, transaction_type: "คืน" }),
      ]),
      master([
        { product_name: "หมอน", quantity: 10.6, price_per_unit: 119 },
        { product_name: "หมอน", quantity: 43.9, price_per_unit: 100 },
      ]),
    );
    expect(result.status).toBe("clean");
  });

  it("never auto-merges เขียวมรกต with เขียวมรกตเก่า", () => {
    const result = bound(
      session([
        item({ product_name: "เขียวมรกตเก่า", quantity: 2, price_per_unit: 80, transaction_type: "คืน" }),
      ]),
      master([{ product_name: "เขียวมรกต", quantity: 10, price_per_unit: 80 }]),
    );
    expect(result.status).toBe("blocked");
    expect(kinds(result.blocking)).toEqual(["product_not_withdrawn"]);
  });

  it("blocks a known product returned in a unit it was never withdrawn in", () => {
    const result = bound(
      session([
        item({ product_name: "ทับทิม", unit: "กล่อง", quantity: 2, price_per_unit: 15, transaction_type: "คืน" }),
      ]),
      pomegranate,
    );
    const [exception] = result.blocking;
    expect(exception.kind).toBe("unit_not_withdrawn");
    expect(exception.kind === "unit_not_withdrawn" && exception.withdrawnUnits).toEqual(["ลูก"]);
  });

  it("blocks a return with no withdrawal anywhere in a bound round", () => {
    const result = bound(
      session([item({ product_name: "ลำไย", quantity: 3, transaction_type: "คืน" })]),
      [],
    );
    expect(kinds(result.blocking)).toEqual(["product_not_withdrawn"]);
  });

  it("leaves an unbound legacy session alone rather than guessing its round", () => {
    const result = validateProduceEntry({
      parsed: session([item({ product_name: "ลำไย", quantity: 3, transaction_type: "คืน" })]),
      roundRows: [],
      roundBound: false,
    });
    expect(result.status).toBe("clean");
  });
});

// ── CASE D — several legitimate price buckets ─────────────────────────────────

describe("price buckets", () => {
  const durian = master([
    { product_name: "หมอน", quantity: 10.6, price_per_unit: 119 },
    { product_name: "หมอน", quantity: 4.4, price_per_unit: 100 },
    { product_name: "หมอน", quantity: 43.9, price_per_unit: 100 },
    { product_name: "หมอน", quantity: 25.5, price_per_unit: 100 },
  ]);

  it("accepts both 100 and 119 on the same product without a warning", () => {
    const result = bound(
      session([
        item({ product_name: "หมอนทอง", quantity: 7.5, price_per_unit: 119, transaction_type: "คืน" }),
        item({ product_name: "หมอนทอง", quantity: 27.8, price_per_unit: 100, transaction_type: "คืน" }),
        item({ product_name: "หมอนทอง", quantity: 3.4, price_per_unit: 100, transaction_type: "คืนเสีย" }),
      ]),
      durian,
    );
    expect(result.status).toBe("clean");
  });

  it("warns on a price that is in neither bucket without blocking", () => {
    const result = bound(
      session([
        item({ product_name: "หมอนทอง", quantity: 8, price_per_unit: 109, transaction_type: "คืน" }),
      ]),
      durian,
    );
    expect(result.status).toBe("clean");
    const [exception] = result.advisories;
    expect(exception.kind === "price_not_withdrawn" && exception.withdrawnPrices).toEqual([100, 119]);
    expect(exception.kind === "price_not_withdrawn" && exception.enteredPrice).toBe(109);
  });
});

// ── CASE E — a price change is allowed, never coerced ─────────────────────────

describe("price change", () => {
  it("advises on 120 against a withdrawal of 100 and keeps the entered price", () => {
    const parsed = session([
      item({ product_name: "อะโวคาโด", quantity: 4, price_per_unit: 120, transaction_type: "คืน" }),
    ]);
    const result = bound(parsed, master([{ product_name: "อะโวคาโด", quantity: 10, price_per_unit: 100 }]));

    expect(result.status).toBe("clean");
    expect(result.blocking).toEqual([]);
    expect(result.reviews).toEqual([]);
    expect(result.advisories).toEqual([expect.objectContaining({
      kind: "price_not_withdrawn",
      severity: "advisory",
      quantity: 4,
      enteredPrice: 120,
      withdrawnPrices: [100],
    })]);
    // Nothing was rewritten: the item still carries what the operator typed.
    expect(parsed.items[0].price_per_unit).toBe(120);
  });

  it("does not review a return whose product has no withdrawal price at all", () => {
    const result = bound(
      session([item({ product_name: "ส้ม", quantity: 1, price_per_unit: 55, transaction_type: "คืน" })]),
      master([{ product_name: "ส้ม", quantity: 5, price_per_unit: null }]),
    );
    expect(result.status).toBe("clean");
    expect(result.advisories).toEqual([]);
  });

  it("reports both Production price differences as advisories", () => {
    const result = bound(
      session([
        item({ product_name: "แตงไทย", unit: "ลูก", quantity: 22, price_per_unit: 25, transaction_type: "คืน" }),
        item({ product_name: "ทับทิม", unit: "ลูก", quantity: 6, price_per_unit: 35, transaction_type: "คืน" }),
      ]),
      master([
        { product_name: "แตงไทย", unit: "ลูก", quantity: 28, price_per_unit: 20 },
        { product_name: "ทับทิม", unit: "ลูก", quantity: 15, price_per_unit: 20 },
      ]),
    );

    expect(result.status).toBe("clean");
    expect(result.advisories).toMatchObject([
      { productName: "แตงไทย", unit: "ลูก", quantity: 22, enteredPrice: 25, withdrawnPrices: [20] },
      { productName: "ทับทิม", unit: "ลูก", quantity: 6, enteredPrice: 35, withdrawnPrices: [20] },
    ]);
  });
});

// ── CASE J — the inventory invariant ──────────────────────────────────────────

describe("quantity invariant", () => {
  it("blocks when good + damaged returns exceed the withdrawal", () => {
    const result = bound(
      session([
        item({ product_name: "ทุเรียน", quantity: 9, transaction_type: "คืน" }),
        item({ product_name: "ทุเรียน", quantity: 3, transaction_type: "คืนเสีย" }),
      ]),
      master([{ product_name: "ทุเรียน", quantity: 10 }]),
    );

    expect(result.status).toBe("blocked");
    const [exception] = result.blocking;
    expect(exception.kind).toBe("return_exceeds_withdrawal");
    expect(exception.kind === "return_exceeds_withdrawal" && exception.excessQuantity).toBe(2);
  });

  it("keeps a price advisory alongside a real quantity block", () => {
    const result = bound(
      session([
        item({ product_name: "มังคุด", quantity: 35.2, price_per_unit: 50, transaction_type: "คืน" }),
      ]),
      master([{ product_name: "มังคุด", quantity: 28.8, price_per_unit: 45 }]),
    );

    expect(result.status).toBe("blocked");
    expect(kinds(result.blocking)).toContain("return_exceeds_withdrawal");
    expect(kinds(result.advisories)).toContain("price_not_withdrawn");
  });

  it("aggregates across every price bucket instead of per bucket", () => {
    const result = bound(
      session([item({ product_name: "หมอนทอง", quantity: 14, price_per_unit: 100, transaction_type: "คืน" })]),
      master([
        { product_name: "หมอน", quantity: 10, price_per_unit: 100 },
        { product_name: "หมอน", quantity: 5, price_per_unit: 119 },
      ]),
    );
    expect(result.status).toBe("clean");
  });

  it("counts returns already finalized elsewhere in the round", () => {
    const result = bound(
      session([item({ product_name: "ทุเรียน", quantity: 4, transaction_type: "คืน" })]),
      master([
        { product_name: "ทุเรียน", quantity: 10 },
        { product_name: "ทุเรียน", quantity: 7, transaction_type: "คืน" },
      ]),
    );
    expect(kinds(result.blocking)).toEqual(["return_exceeds_withdrawal"]);
  });

  it("counts an additional withdrawal batch towards the master", () => {
    const result = bound(
      session([item({ product_name: "ทุเรียน", quantity: 14, transaction_type: "คืน" })]),
      master([
        { product_name: "ทุเรียน", quantity: 10 },
        { product_name: "ทุเรียน", quantity: 5, transaction_type: "เบิกเพิ่ม" },
      ]),
    );
    expect(result.status).toBe("clean");
  });

  it("passes a return that exactly matches the withdrawal", () => {
    const result = bound(
      session([item({ product_name: "ทุเรียน", quantity: 10, transaction_type: "คืน" })]),
      master([{ product_name: "ทุเรียน", quantity: 10 }]),
    );
    expect(result.status).toBe("clean");
  });
});

describe("duplicate printed item numbers", () => {
  it("blocks an otherwise valid draft and never offers an ambiguous correction command", () => {
    const parsed = session([
      item({ product_name: "องุ่นแดง", quantity: 1.8, transaction_type: "คืน" }),
      item({ product_name: "องุ่นไข่ปลา", quantity: 0.5, transaction_type: "คืน" }),
    ]);
    parsed.items[0]!.item_number = 16;
    parsed.items[1]!.item_number = 16;

    const result = bound(parsed, master([
      { product_name: "องุ่นแดง", quantity: 2 },
      { product_name: "องุ่นไข่ปลา", quantity: 1 },
    ]));
    const reply = buildBlockingValidationReply(result);

    expect(result.blocking).toEqual([{
      kind: "duplicate_item_number",
      severity: "blocking",
      itemNumber: 16,
      matchCount: 2,
    }]);
    expect(reply).toContain("พบเลขข้อ 16 ซ้ำ 2 รายการ");
    expect(reply).toContain("กรุณาแก้เลขข้อให้ไม่ซ้ำก่อน");
    expect(reply).not.toContain("แก้ข้อ 16");
  });

  it("reports duplicate, absent-product, and excess-return blockers together", () => {
    const parsed = session([
      item({ product_name: "ลูกไหนแดง", quantity: 1, transaction_type: "คืน" }),
      item({ product_name: "อะโวคาโด", quantity: 1, transaction_type: "คืน" }),
      item({ product_name: "มะม่วงแก้วขมิ้น", quantity: 0.9, transaction_type: "คืน" }),
      item({ product_name: "ไซมัส", quantity: 15.1, transaction_type: "คืน" }),
    ]);
    parsed.items[0]!.item_number = 16;
    parsed.items[1]!.item_number = 16;

    const result = bound(parsed, master([
      { product_name: "มะม่วงแก้วขมิ้น", quantity: 0.09 },
      { product_name: "ไซมัส", quantity: 9 },
    ]));
    const reply = buildBlockingValidationReply(result);

    expect(result.blocking).toHaveLength(5);
    expect(kinds(result.blocking)).toEqual([
      "duplicate_item_number",
      "product_not_withdrawn",
      "product_not_withdrawn",
      "return_exceeds_withdrawal",
      "return_exceeds_withdrawal",
    ]);
    expect(reply).toContain("พบเลขข้อ 16 ซ้ำ 2 รายการ");
    expect(reply).toContain("ลูกไหนแดง");
    expect(reply).toContain("อะโวคาโด");
    expect(reply).toContain("มะม่วงแก้วขมิ้น");
    expect(reply).toContain("ไซมัส");
    expect(reply).not.toContain("แก้ข้อ 16");
  });
});

// ── The clean path stays clean ────────────────────────────────────────────────

describe("clean sessions", () => {
  it("raises nothing for a plain withdrawal-only session", () => {
    const result = bound(
      session([
        item({ product_name: "หมอนทอง", quantity: 38, price_per_unit: 119 }),
        item({ product_name: "กระดุม", quantity: 30.3, price_per_unit: 100 }),
      ]),
    );
    expect(result).toMatchObject({ status: "clean", blocking: [], reviews: [] });
  });

  it("validates a single document that carries both its withdrawal and its return", () => {
    const result = bound(
      session([
        item({ product_name: "มังคุด", quantity: 15.9, price_per_unit: 45 }),
        item({ product_name: "มังคุด", quantity: 15.4, price_per_unit: 45, transaction_type: "คืน" }),
      ]),
    );
    expect(result.status).toBe("clean");
  });
});

// ── Digest ────────────────────────────────────────────────────────────────────

describe("validation digest", () => {
  const roundRows = master([{ product_name: "อะโวคาโด", quantity: 10, price_per_unit: 100 }]);
  const priced = (price: number) =>
    session([item({ product_name: "อะโวคาโด", quantity: 4, price_per_unit: price, transaction_type: "คืน" })]);

  it("is stable for identical content", () => {
    expect(bound(priced(120), roundRows).digest).toBe(bound(priced(120), roundRows).digest);
  });

  it("changes when the session content changes", () => {
    expect(bound(priced(120), roundRows).digest).not.toBe(bound(priced(130), roundRows).digest);
  });

  it("changes when an unrelated line is added after the preview", () => {
    const before = bound(priced(120), roundRows);
    const after = bound(
      session([
        item({ product_name: "อะโวคาโด", quantity: 4, price_per_unit: 120, transaction_type: "คืน" }),
        item({ product_name: "อะโวคาโด", quantity: 1, price_per_unit: 100, transaction_type: "คืนเสีย" }),
      ]),
      roundRows,
    );
    expect(after.digest).not.toBe(before.digest);
  });

  it("does not depend on exception ordering", () => {
    const parsed = priced(120);
    const forward = computeValidationDigest(parsed, [], [
      { kind: "unknown_product_vocabulary", severity: "review_required", itemNumber: 1, productName: "a", suggestions: [] },
      { kind: "unknown_product_vocabulary", severity: "review_required", itemNumber: 2, productName: "b", suggestions: [] },
    ]);
    const reversed = computeValidationDigest(parsed, [], [
      { kind: "unknown_product_vocabulary", severity: "review_required", itemNumber: 2, productName: "b", suggestions: [] },
      { kind: "unknown_product_vocabulary", severity: "review_required", itemNumber: 1, productName: "a", suggestions: [] },
    ]);
    expect(forward).toBe(reversed);
  });
});

// ── Operator-facing text ──────────────────────────────────────────────────────

describe("replies", () => {
  it("reports the real printed item number and gives an explicit correction command", () => {
    const parsed = session([
      item({ product_name: "มังคุด", quantity: 15.4, unit: "โลก", price_per_unit: 45, transaction_type: "คืน" }),
    ]);
    parsed.items[0]!.item_number = 17;
    const result = bound(parsed, master([
      { product_name: "มังคุด", quantity: 15.9, price_per_unit: 45 },
    ]));
    const reply = buildBlockingValidationReply(result);
    expect(reply).toContain("มังคุด");
    expect(reply).toContain("โลก");
    expect(reply).toContain("น่าจะเป็น: โล");
    expect(reply).toContain("ข้อ 17");
    expect(reply).toContain("แก้ข้อ 17");
    expect(reply).toContain("รายการอื่นยังอยู่ครบ");
    expect(reply).not.toContain("ระบบยังไม่ได้บันทึกอะไร");
  });

  it("shows both withdrawal prices next to the entered one", () => {
    const result = bound(
      session([item({ product_name: "หมอนทอง", quantity: 8, price_per_unit: 109, transaction_type: "คืน" })]),
      master([
        { product_name: "หมอน", quantity: 10, price_per_unit: 100 },
        { product_name: "หมอน", quantity: 5, price_per_unit: 119 },
      ]),
    );
    const reply = buildPriceAdvisoryWarning(result.advisories);
    expect(reply).toContain("109");
    expect(reply).toContain("100, 119");
    expect(reply).toContain("ระบบบันทึกตามราคาที่กรอกไว้แล้ว");
    expect(reply).not.toContain("ยืนยัน");
  });

  it("keeps small success advisories byte-for-byte unchanged", () => {
    const advisories = bound(
      session([item({ product_name: "มังคุด", quantity: 2, price_per_unit: 50, transaction_type: "คืน" })]),
      master([{ product_name: "มังคุด", quantity: 5, price_per_unit: 45 }]),
    ).advisories;
    const summary = "บันทึกแล้ว ✅";
    expect(buildPriceAdvisoryNotification(summary, advisories)).toBe(
      `${summary}\n\n${buildPriceAdvisoryWarning(advisories)}`,
    );
  });

  it("keeps a small success summary with no advisories byte-for-byte unchanged", () => {
    const summary = "บันทึกแล้ว ✅\n\nขวัญ — 20/8/2569";
    expect(buildPriceAdvisoryNotification(summary, [])).toBe(summary);
  });

  it("caps an oversized advisory-free summary at a complete line with a generic notice", () => {
    const summaryLines = [
      "บันทึกแล้ว ✅",
      ...Array.from(
        { length: 150 },
        (_, index) => `${index + 1}. แตงโม ${"ก".repeat(40)} 1 ลูก × 25 = 25 บาท`,
      ),
    ];
    const summary = summaryLines.join("\n");
    const notification = buildPriceAdvisoryNotification(summary, []);
    const outputLines = notification.split("\n");
    const genericNotice = "…สรุปรายการถูกย่อเนื่องจากข้อความยาวเกินกำหนด";

    expect(countCodePoints(summary)).toBeGreaterThan(
      LINE_TEXT_MESSAGE_HARD_MAX_CODE_POINTS,
    );
    expect(countCodePoints(notification)).toBeLessThanOrEqual(
      LINE_TEXT_MESSAGE_HARD_MAX_CODE_POINTS,
    );
    expect(outputLines.at(-1)).toBe(genericNotice);
    expect(notification).not.toContain("…สรุปรายการถูกย่อเพื่อแสดงคำเตือนราคา");
    for (const line of outputLines.slice(0, -1)) {
      expect(summaryLines).toContain(line);
    }
  });

  it("keeps an advisory-free summary unchanged at the hard limit", () => {
    const summary = "ก".repeat(LINE_TEXT_MESSAGE_HARD_MAX_CODE_POINTS);
    const notification = buildPriceAdvisoryNotification(summary, []);

    expect(countCodePoints(notification)).toBe(
      LINE_TEXT_MESSAGE_HARD_MAX_CODE_POINTS,
    );
    expect(notification).toBe(summary);
  });

  it("budgets complete advisory rows against a near-limit success summary", () => {
    const advisories = Array.from({ length: 10 }, (_, index) => ({
      kind: "price_not_withdrawn" as const,
      severity: "advisory" as const,
      itemNumber: index + 1,
      productName: `สินค้า${index + 1}`,
      unit: "โล",
      quantity: 1,
      enteredPrice: 50,
      withdrawnPrices: [45],
    }));
    const summary = `บันทึกแล้ว ✅\n${"ก".repeat(4475)}`;
    const notification = buildPriceAdvisoryNotification(summary, advisories);
    const lines = notification.split("\n");
    const warningRows = lines.filter((line) => line.startsWith("• "));
    const omittedLine = lines.find((line) => line.startsWith("…และอีก "));
    const omitted = Number(omittedLine?.match(/…และอีก (\d+) รายการ/)?.[1]);

    expect(countCodePoints(notification)).toBeLessThanOrEqual(
      LINE_TEXT_MESSAGE_HARD_MAX_CODE_POINTS,
    );
    expect(warningRows.length).toBeGreaterThan(0);
    expect(warningRows.length + omitted).toBe(advisories.length);
    expect(omittedLine).toBe(`…และอีก ${omitted} รายการที่ราคาแตกต่าง`);
    warningRows.forEach((line, index) => {
      expect(line).toBe(
        `• สินค้า${index + 1} — เบิก 45 บาท/โล → ชั่งคืน 50 บาท/โล`,
      );
    });
  });

  it("summarizes instead of listing when a session is pathological", () => {
    const items = Array.from({ length: 25 }, (_, index) =>
      item({ product_name: `ของ${index}`, unit: "โลก", quantity: 1 }),
    );
    const reply = buildBlockingValidationReply(bound(session(items)));
    expect(reply).toContain("และอีก 15 รายการ");
    expect([...reply].length).toBeLessThan(2000);
  });

  it("keeps a pathological blocker reply within the LINE hard limit", () => {
    const longName = "สินค้า" + "ก".repeat(500);
    const items = Array.from({ length: 40 }, (_, index) =>
      item({ product_name: `${longName}${index}`, unit: "โลก", quantity: 1 }),
    );
    const reply = buildBlockingValidationReply(bound(session(items)));

    expect(countCodePoints(reply)).toBeLessThanOrEqual(
      LINE_TEXT_MESSAGE_HARD_MAX_CODE_POINTS,
    );
    expect(reply).toMatch(/และอีก 3\d รายการ/);
  });
});

// ── Operational UX hardening (PR A) ───────────────────────────────────────────
//
// The reviewed unit alias is accepted; product spelling variants are NOT
// aliased, they are refused with the withdrawal's own spelling attached.

describe("reviewed unit alias ปุก", () => {
  it("accepts a 3 ปุก return against a กระปุก withdrawal", () => {
    const result = bound(
      session([
        item({ product_name: "น้ำพริก", unit: "ปุก", quantity: 3, price_per_unit: 50, transaction_type: "คืน" }),
      ]),
      master([{ product_name: "น้ำพริก", unit: "กระปุก", quantity: 10, price_per_unit: 50 }]),
    );
    expect(result.status).toBe("clean");
    expect(result.blocking).toEqual([]);
  });

  it("still blocks an unreviewed shorthand", () => {
    const result = bound(
      session([
        item({ product_name: "น้ำพริก", unit: "ปุ๊ก", quantity: 3, price_per_unit: 50, transaction_type: "คืน" }),
      ]),
      master([{ product_name: "น้ำพริก", unit: "กระปุก", quantity: 10, price_per_unit: 50 }]),
    );
    expect(result.status).toBe("blocked");
    expect(kinds(result.blocking)).toEqual(["unknown_unit"]);
  });
});

describe("product spelling variants are refused, never merged", () => {
  // The three real Production pairs behind this phase. PR A deliberately does
  // NOT alias them: only the operator knows whether a variant is a typo or a
  // different good, so the reply hands them the withdrawal's exact spelling.
  const pairs: Array<[sent: string, withdrawn: string]> = [
    ["หัวไชเท้า", "หัวไชยเท้า"],
    ["ฟักอ่อน", "ฟักออ่น"],
  ];

  for (const [sent, withdrawn] of pairs) {
    it(`blocks ${sent} and surfaces ${withdrawn} to copy`, () => {
      const result = bound(
        session([
          item({ product_name: sent, unit: "โล", quantity: 2, price_per_unit: 30, transaction_type: "คืน" }),
        ]),
        master([{ product_name: withdrawn, unit: "โล", quantity: 10, price_per_unit: 30 }]),
      );

      expect(result.status).toBe("blocked");
      const [exception] = result.blocking;
      expect(exception.kind).toBe("product_not_withdrawn");
      expect(exception.kind === "product_not_withdrawn" && exception.suggestions)
        .toContain(withdrawn);
      expect(buildBlockingValidationReply(result)).toContain(withdrawn);
    });
  }
});
