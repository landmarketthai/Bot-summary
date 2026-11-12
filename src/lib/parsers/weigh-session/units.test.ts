/**
 * Unit vocabulary — reviewed aliases only, and everything else fails closed.
 */
import { describe, expect, test } from "bun:test";
import { parseWeighSession } from "./parser";
import { isKnownUnit, normalizeUnitAlias, resolveUnitQuantity } from "./units";

describe("reviewed unit aliases", () => {
  // The shop's confirmed shorthand. Spelling only — factor 1.
  test("ปุก resolves to กระปุก without touching the quantity", () => {
    expect(isKnownUnit("ปุก")).toBe(true);
    expect(normalizeUnitAlias("ปุก")).toBe("กระปุก");
    expect(resolveUnitQuantity(3, "ปุก")).toEqual({ quantity: 3, unit: "กระปุก" });
  });

  test("จาน is accepted but โลโล remains invalid", () => {
    expect(isKnownUnit("จาน")).toBe(true);
    expect(resolveUnitQuantity(9, "จาน")).toEqual({ quantity: 9, unit: "จาน" });
    expect(isKnownUnit("โลโล")).toBe(false);
    expect(resolveUnitQuantity(14.3, "โลโล")).toEqual({ quantity: 14.3, unit: "โลโล" });
    const parsed = parseWeighSession("นาง-ตลาดทรัพยพัน2 เบิก 11/11/2569\n11กล้วยหอมจาน20บาท\n9จาน\nจบรายการเบิก", "2026-11-11");
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].product_name).toBe("กล้วยหอมจาน");
    expect(parsed.items[0].unit).toBe("จาน");
    expect(parsed.items[0].quantity).toBe(9);
  });

  test("the canonical spelling stays canonical", () => {
    expect(resolveUnitQuantity(3, "กระปุก")).toEqual({ quantity: 3, unit: "กระปุก" });
  });

  test("a parsed 3ปุก line lands as 3 กระปุก", () => {
    const parsed = parseWeighSession(
      [
        "ต้อม-พาซิโอ้ เบิก 14/8/2569",
        "1.น้ำพริก50บาท",
        "3ปุก",
        "จบรายการเบิก",
      ].join("\n"),
      "2026-08-14",
    );
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].quantity).toBe(3);
    expect(parsed.items[0].unit).toBe("กระปุก");
  });
});

describe("unknown units still fail closed", () => {
  test("an unreviewed unit is not known and is never rewritten", () => {
    expect(isKnownUnit("ปุ๊ก")).toBe(false);
    expect(isKnownUnit("กระปุ")).toBe(false);
    expect(normalizeUnitAlias("ปุ๊ก")).toBe("ปุ๊ก");
    expect(resolveUnitQuantity(3, "ปุ๊ก")).toEqual({ quantity: 3, unit: "ปุ๊ก" });
  });
});
