/**
 * Extra food and produce units accepted as distinct units, not quantity conversions.
 * Each unit must work with typed LINE เบิก/คืน/คืนเสีย sessions.
 */
import { describe, expect, test } from "bun:test";
import { parseWeighSession } from "./parser";
import { isKnownUnit, normalizeUnitAlias, resolveUnitQuantity, conversionFactor } from "./units";

const NEW_FOOD_UNITS = [
  // P0 — requested or already observed in production data
  ["แผ่น", "เต้าหู้แผ่น"], ["หลอด", "ซอสพริก"], ["ต้น", "ผักกาดหอม"],
  ["ถัง", "ผักกาดดอง"], ["หน่อ", "หน่อไม้สด"],
  // P1 — packaging, bunches and cut fruit
  ["ตะกร้า", "พุทรา"], ["ซอง", "น้ำจิ้ม"], ["ห่อ", "ขนมจีน"],
  ["กระป๋อง", "ปลากระป๋อง"], ["ก้อน", "เต้าหู้"], ["กอ", "ผักชี"], ["พู", "ทุเรียน"],
  // P2 — future food/produce unit vocabulary
  ["อัน", "ลิ้นฟ้า"], ["ก้าน", "คะน้า"], ["ท่อน", "อ้อย"], ["ซีก", "ฟักทอง"],
  ["กลีบ", "กระเทียม"], ["เม็ด", "ลูกอม"], ["เมล็ด", "ถั่ว"],
  ["ไม้", "ลูกชิ้น"], ["แก้ว", "น้ำส้ม"], ["ถ้วย", "ขนม"],
  ["ปี๊บ", "ปลาแห้ง"], ["แกลลอน", "น้ำมัน"],
] as const;

describe("food and produce unit vocabulary (P0/P1/P2)", () => {
  test("registers all 24 separate canonical units without inventing conversion factors", () => {
    expect(NEW_FOOD_UNITS).toHaveLength(24);
    for (const [unit] of NEW_FOOD_UNITS) {
      expect(isKnownUnit(unit)).toBe(true);
      expect(normalizeUnitAlias(unit)).toBe(unit);
      expect(resolveUnitQuantity(3, unit)).toEqual({ quantity: 3, unit });
      expect(conversionFactor(unit)).toBe(1);
    }
  });

  test.each(NEW_FOOD_UNITS)("%s: parses a real-looking เบิก item without changing the count or unit", (unit, product) => {
    const parsed = parseWeighSession([
      "กี้-วัดตะกล่ำ เบิก 12/10/2569",
      `1.${product}20บาท`,
      `3${unit}`,
      "จบรายการเบิก",
    ].join("\n"), "2026-10-12");
    expect(parsed.parse_errors).toEqual([]);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toMatchObject({ item_number: 1, quantity: 3, unit });
  });

  test("one unit must never be silently substituted for another", () => {
    expect(resolveUnitQuantity(4, "แผ่น")).not.toEqual(resolveUnitQuantity(4, "แผง"));
    expect(resolveUnitQuantity(4, "ต้น")).not.toEqual(resolveUnitQuantity(4, "มัด"));
    expect(resolveUnitQuantity(4, "ถัง")).not.toEqual(resolveUnitQuantity(4, "โล"));
  });

  test("unverified misspellings remain unknown rather than becoming new aliases", () => {
    for (const unit of ["ถีง", "หีว", "ลูุก", "ปุ้ก", "แดค"]) {
      expect(isKnownUnit(unit)).toBe(false);
      expect(resolveUnitQuantity(2, unit)).toEqual({ quantity: 2, unit });
    }
  });

  test("returns and damaged returns retain the exact new selling unit", () => {
    for (const [transaction, unit, product] of [
      ["คืน", "แผ่น", "เต้าหู้แผ่น"],
      ["คืนเสีย", "ต้น", "ผักกาดหอม"],
      ["คืน", "หน่อ", "หน่อไม้สด"],
      ["คืนเสีย", "พู", "ทุเรียน"],
      ["คืน", "แกลลอน", "น้ำมัน"],
    ] as const) {
      const parsed = parseWeighSession([
        `กี้-วัดตะกล่ำ ${transaction} 12/10/2569`,
        `1.${product}20บาท`,
        `2${unit}`,
        `จบรายการ${transaction}`,
      ].join("\n"), "2026-10-12");
      expect(parsed.parse_errors).toEqual([]);
      expect(parsed.items).toHaveLength(1);
      expect(parsed.items[0]).toMatchObject({ quantity: 2, unit });
    }
  });
});
