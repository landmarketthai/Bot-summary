/**
 * Product Codes at the parser boundary.
 *
 * A code is an optional way of *writing* a product, so the only thing these
 * tests really assert is that a coded document and the same document typed in
 * words produce the identical parse — same product identity, same price, same
 * unit, same item numbering. Everything downstream (P4A, dedup, reporting)
 * compares parsed items, so parity here is what makes a code safe everywhere
 * else.
 *
 * The two things a code must never do: block a product for being uncoded, and
 * quietly become a literal product named "ม999".
 */
import { describe, expect, it } from "bun:test";
import { buildWeighSessionValidationReply, parseWeighSession } from "./parser";
import type { WeighSessionItem } from "./types";

const doc = (...lines: string[]) => lines.join("\n");
const HEADER = "กี้-วัดทุ่งลานนา เบิก 13/8/2569";
const CLOSER = "จบรายการเบิก";

function identity(item: WeighSessionItem) {
  return {
    item_number: item.item_number,
    product_name: item.product_name,
    price_per_unit: item.price_per_unit,
    quantity: item.quantity,
    unit: item.unit,
    transaction_type: item.transaction_type,
  };
}

// ── CASE A — a coded withdrawal parses as its canonical product ──────────────

describe("CASE A — coded withdrawal", () => {
  it.each([
    ["ม99", "ส้มจีน"], ["ม100", "ส้มสายน้ำผึ้ง"],
    ["ม101", "กล้วยเล็บมือนาง"], ["ม102", "มะขามป้อม"],
  ])("Production fruit %s parses identically to %s with price and quantity intact", (code, name) => {
    const coded = parseWeighSession(doc(HEADER, `${code} 35 บาท`, "5 โล", CLOSER));
    const words = parseWeighSession(doc(HEADER, `${name} 35 บาท`, "5 โล", CLOSER));
    expect(coded.parse_errors).toEqual([]);
    expect(coded.items.map(identity)).toEqual(words.items.map(identity));
    expect(identity(coded.items[0])).toMatchObject({ product_name: name, price_per_unit: 35, quantity: 5, unit: "โล" });
  });

  it("resolves each code to the approved canonical product name", () => {
    const parsed = parseWeighSession(doc(
      HEADER,
      "ผ01 50 บาท",
      "2.7 โล",
      "ผ02 20 บาท",
      "9.6 โล",
      "ผ04 65 บาท",
      "3 โล",
      CLOSER,
    ));

    expect(parsed.parse_errors).toEqual([]);
    expect(parsed.items.map(identity)).toEqual([
      { item_number: 1, product_name: "ฝักกระเจี๊ยบ", price_per_unit: 50, quantity: 2.7, unit: "โล", transaction_type: "เบิก" },
      { item_number: 2, product_name: "กระชาย",      price_per_unit: 20, quantity: 9.6, unit: "โล", transaction_type: "เบิก" },
      { item_number: 3, product_name: "กระเทียมกลีบ", price_per_unit: 65, quantity: 3,   unit: "โล", transaction_type: "เบิก" },
    ]);
    // The seller, market and date came through the header untouched.
    expect(parsed.staff_name).toBe("กี้");
    expect(parsed.session_title).toBe("วัดทุ่งลานนา");
    expect(parsed.date).toBe("2026-08-13");
  });

  it("parses identically to the same document typed in words", () => {
    const coded = parseWeighSession(doc(HEADER, "ม02 35 บาท", "5 โล", CLOSER));
    const words = parseWeighSession(doc(HEADER, "กล้วยน้ำว้า 35 บาท", "5 โล", CLOSER));

    expect(coded.items.map(identity)).toEqual(words.items.map(identity));
  });

  it("carries a code through the scale's item-numbered form", () => {
    const parsed = parseWeighSession(doc(HEADER, "1.ม01 50 บาท", "2 โล", CLOSER));

    expect(parsed.parse_errors).toEqual([]);
    expect(identity(parsed.items[0])).toEqual({
      item_number: 1, product_name: "กล้วยไข่", price_per_unit: 50,
      quantity: 2, unit: "โล", transaction_type: "เบิก",
    });
  });
});

// ── CASE I / J — uncoded products keep working ──────────────────────────────

describe("CASE I — a brand-new uncoded product is still accepted", () => {
  it("accepts เสาวรส, which has no code at all", () => {
    const parsed = parseWeighSession(doc(HEADER, "เสาวรส 50 บาท", "10 โล", CLOSER));

    expect(parsed.parse_errors).toEqual([]);
    expect(identity(parsed.items[0])).toMatchObject({
      product_name: "เสาวรส", price_per_unit: 50, quantity: 10, unit: "โล",
    });
  });
});

describe("CASE J — a product deliberately excluded from the dictionary", () => {
  it("accepts เขียวมรกตเก่า typed as ordinary text", () => {
    // Excluded from codes is not the same as invalid. This is a real good the
    // shop trades; it simply did not get a code in the first dictionary.
    const parsed = parseWeighSession(doc(HEADER, "เขียวมรกตเก่า 80 บาท", "2 โล", CLOSER));

    expect(parsed.parse_errors).toEqual([]);
    expect(identity(parsed.items[0])).toMatchObject({
      product_name: "เขียวมรกตเก่า", price_per_unit: 80, quantity: 2,
    });
  });
});

// ── CASE K — an unregistered code fails closed ──────────────────────────────

describe("CASE K — unknown code", () => {
  it("refuses ม999 and never invents a product called ม999", () => {
    const parsed = parseWeighSession(doc(HEADER, "ม999 50 บาท", "3 โล", CLOSER));

    expect(parsed.items).toEqual([]);
    expect(parsed.parse_errors[0]).toBe('unknown product code ม999 in line: "ม999 50 บาท"');
    expect(JSON.stringify(parsed.items)).not.toContain("ม999");
  });

  it("names the unregistered code in the operator's reply", () => {
    const parsed = parseWeighSession(doc(HEADER, "ม999 50 บาท", "3 โล", CLOSER));
    const reply = buildWeighSessionValidationReply(parsed);

    expect(reply).toContain("ไม่พบรหัสสินค้า ม999");
    // And it says, in the existing wording, that nothing was saved.
    expect(reply).toContain("จึงยังไม่บันทึก");
  });

  it("refuses an unregistered code in every namespace", () => {
    for (const code of ["ม999", "ผ999", "ป99", "ท99", "ห99", "พ99"]) {
      const parsed = parseWeighSession(doc(HEADER, `${code} 50 บาท`, "3 โล", CLOSER));
      expect(parsed.items).toEqual([]);
      expect(parsed.parse_errors.some((e) => e.includes(`unknown product code ${code}`))).toBe(true);
    }
  });

  it("does not persist the valid items of a document that carries a bad code", () => {
    // Fail-closed is per document: the session cannot finalize at all, so the
    // good line never lands on its own.
    const parsed = parseWeighSession(doc(
      HEADER, "ม01 50 บาท", "2 โล", "ม999 50 บาท", "3 โล", CLOSER,
    ));

    expect(parsed.parse_errors.length).toBeGreaterThan(0);
  });
});

// ── CASE L — mixed document ─────────────────────────────────────────────────

describe("CASE L — codes, known words and a new product in one session", () => {
  it("parses all four line kinds together", () => {
    const parsed = parseWeighSession(doc(
      HEADER,
      "ม02 35 บาท",
      "5 โล",
      "กระท้อน 40 บาท",
      "3.2 โล",
      "ผ07 50 บาท",
      "2 โล",
      "เสาวรส 50 บาท",
      "10 โล",
      CLOSER,
    ));

    expect(parsed.parse_errors).toEqual([]);
    expect(parsed.items.map((i) => i.product_name)).toEqual([
      "กล้วยน้ำว้า", "กระท้อน", "กระเทียมหัว", "เสาวรส",
    ]);
  });

  it("reads ม02 and กล้วยน้ำว้า in one document as the same product", () => {
    const mixed = parseWeighSession(doc(
      HEADER, "ม02 35 บาท", "5 โล", "กล้วยน้ำว้า 35 บาท", "3 โล", CLOSER,
    ));
    const words = parseWeighSession(doc(
      HEADER, "กล้วยน้ำว้า 35 บาท", "5 โล", "กล้วยน้ำว้า 35 บาท", "3 โล", CLOSER,
    ));

    expect(mixed.parse_errors).toEqual([]);
    expect(mixed.items.map((i) => i.product_name)).toEqual(["กล้วยน้ำว้า", "กล้วยน้ำว้า"]);
    // Two weighings of one product stay two rows — a code changes how the line
    // is written, never how many rows it makes.
    expect(mixed.items.map(identity)).toEqual(words.items.map(identity));
  });
});

// ── CASE M — multi-message ──────────────────────────────────────────────────

describe("CASE M — coded items across separate LINE messages", () => {
  it("parses the accumulated document the same as a single message", () => {
    // The finalizer joins the pending session's messages with newlines and
    // parses the result, which is what this reproduces.
    const accumulated = [
      HEADER,
      "ม01 50 บาท\n2 โล",
      "ม02 35 บาท\n3 โล",
      CLOSER,
    ].join("\n");

    const parsed = parseWeighSession(accumulated);

    expect(parsed.parse_errors).toEqual([]);
    expect(parsed.items.map((i) => [i.product_name, i.quantity])).toEqual([
      ["กล้วยไข่", 2], ["กล้วยน้ำว้า", 3],
    ]);
  });
});

// ── CASE P / Q — codes in the other document kinds ──────────────────────────

describe("CASE P — เบิกเพิ่ม", () => {
  it("accepts codes in an additional withdrawal batch", () => {
    const parsed = parseWeighSession(doc(
      "กี้-วัดทุ่งลานนา เบิกเพิ่ม 13/8/2569",
      "1.ม02 35 บาท",
      "2 โล",
      "จบรายการเบิกเพิ่ม",
    ));

    expect(parsed.parse_errors).toEqual([]);
    expect(parsed.session_kind).toBe("additional");
    expect(parsed.declared_transaction_type).toBe("เบิก");
    // An additional batch stores its declared base type, as it always has.
    expect(identity(parsed.items[0])).toMatchObject({
      product_name: "กล้วยน้ำว้า", transaction_type: "เบิก",
    });

    const words = parseWeighSession(doc(
      "กี้-วัดทุ่งลานนา เบิกเพิ่ม 13/8/2569",
      "1.กล้วยน้ำว้า 35 บาท",
      "2 โล",
      "จบรายการเบิกเพิ่ม",
    ));
    expect(parsed.items.map(identity)).toEqual(words.items.map(identity));
  });
});

describe("CASE Q — คืนเสีย", () => {
  it("accepts codes in a damaged return", () => {
    const parsed = parseWeighSession(doc(
      "กี้-วัดทุ่งลานนา คืนเสีย 13/8/2569",
      "ม02 35 บาท",
      "2 โล",
      "จบรายการคืนเสีย",
    ));

    expect(parsed.parse_errors).toEqual([]);
    expect(identity(parsed.items[0])).toMatchObject({
      product_name: "กล้วยน้ำว้า", transaction_type: "คืนเสีย",
    });
  });

  it("accepts codes in a ชั่งคืน good return", () => {
    const parsed = parseWeighSession(doc(
      "กี้-วัดทุ่งลานนา ชั่งคืน 13/8/2569",
      "ม02 35 บาท",
      "2 โล",
      "จบรายการชั่งคืน",
    ));

    expect(parsed.parse_errors).toEqual([]);
    expect(identity(parsed.items[0])).toMatchObject({
      product_name: "กล้วยน้ำว้า", transaction_type: "คืน",
    });
  });
});

// ── Resolution stays inside the product token ───────────────────────────────

describe("resolution never escapes the product-name position", () => {
  it("leaves a seller or market that starts with a namespace character alone", () => {
    const parsed = parseWeighSession(doc(
      "ผ่องศรี-ปากคลอง เบิก 13/8/2569", "ม02 35 บาท", "5 โล", CLOSER,
    ));

    expect(parsed.staff_name).toBe("ผ่องศรี");
    expect(parsed.session_title).toBe("ปากคลอง");
    expect(parsed.items[0].product_name).toBe("กล้วยน้ำว้า");
  });

  it("leaves quantity and price lines alone", () => {
    const parsed = parseWeighSession(doc(HEADER, "ม02 35 บาท", "5 โล", CLOSER));

    expect(parsed.items[0].quantity).toBe(5);
    expect(parsed.items[0].unit).toBe("โล");
    expect(parsed.items[0].price_per_unit).toBe(35);
  });

  it("keeps the compact scale form reading exactly as it did before codes", () => {
    // No separator between token and price — genuinely ambiguous, so it is left
    // to the pre-existing patterns rather than guessed at.
    const withCode = parseWeighSession(doc(HEADER, "ม0150บาท", "2 โล", CLOSER));
    expect(withCode.items[0].product_name).toBe("ม");
    expect(withCode.items[0].price_per_unit).toBe(150);
  });

  it("does not disturb a real compact Production line", () => {
    const parsed = parseWeighSession(doc(
      "มิ้น-ทรัพย์พันธ์2 เบิก 11/8/2569", "1.ปลาหวานแดง100บาท", "4แพค", "จบรายการเบิก",
    ));

    expect(parsed.parse_errors).toEqual([]);
    expect(identity(parsed.items[0])).toMatchObject({
      product_name: "ปลาหวานแดง", price_per_unit: 100, quantity: 4, unit: "แพค",
    });
  });
});

describe("dictionary extension 20260827090000 — ม73 มะม่วงฟ้าลั่น compact form", () => {
  it("parses มะม่วงฟ้าลั่น50บาท / 5โล as a เบิก", () => {
    const parsed = parseWeighSession(doc(
      "กี้-วัดทุ่งลานนา เบิก 27/8/2569",
      "มะม่วงฟ้าลั่น50บาท",
      "5โล",
      "จบรายการเบิก",
    ));

    expect(parsed.parse_errors).toEqual([]);
    expect(identity(parsed.items[0])).toEqual({
      item_number: 1, product_name: "มะม่วงฟ้าลั่น", price_per_unit: 50,
      quantity: 5, unit: "โล", transaction_type: "เบิก",
    });
  });

  it("parses the same compact form as a ชั่งคืน", () => {
    const parsed = parseWeighSession(doc(
      "กี้-วัดทุ่งลานนา ชั่งคืน 27/8/2569",
      "มะม่วงฟ้าลั่น50บาท",
      "5โล",
      "จบรายการชั่งคืน",
    ));

    expect(parsed.parse_errors).toEqual([]);
    expect(identity(parsed.items[0])).toMatchObject({
      product_name: "มะม่วงฟ้าลั่น", price_per_unit: 50,
      quantity: 5, unit: "โล", transaction_type: "คืน",
    });
  });

  it("parses the same compact form as a คืนเสีย", () => {
    const parsed = parseWeighSession(doc(
      "กี้-วัดทุ่งลานนา คืนเสีย 27/8/2569",
      "มะม่วงฟ้าลั่น50บาท",
      "5โล",
      "จบรายการคืนเสีย",
    ));

    expect(parsed.parse_errors).toEqual([]);
    expect(identity(parsed.items[0])).toMatchObject({
      product_name: "มะม่วงฟ้าลั่น", price_per_unit: 50,
      quantity: 5, unit: "โล", transaction_type: "คืนเสีย",
    });
  });

  it("resolves code ม73 to the same identity as the canonical spelling", () => {
    const coded = parseWeighSession(doc(
      HEADER, "ม73 50 บาท", "5 โล", CLOSER,
    ));
    const words = parseWeighSession(doc(
      HEADER, "มะม่วงฟ้าลั่น50บาท", "5โล", CLOSER,
    ));

    expect(coded.parse_errors).toEqual([]);
    expect(coded.items.map(identity)).toEqual(words.items.map(identity));
  });
});
