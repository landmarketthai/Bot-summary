import { describe, expect, it } from "bun:test";
import { validateProduceEntry } from "@/lib/produce/entry-validation";
import {
  getWeighSessionFinalizationErrors,
  parseWeighSession,
} from "./parser";
import {
  buildDraftItemActionReply,
  latestDraftItemAction,
} from "./draft-item-command";

const HEADER = "กี้-ตลาดทดสอบ เบิก 24/8/2569";
const CLOSE = "จบรายการเบิก";

function document(...lines: string[]): string {
  return [HEADER, ...lines, CLOSE].join("\n");
}

function returnDocument(...lines: string[]): string {
  return ["กี้-ตลาดทดสอบ ชั่งคืน 24/8/2569", ...lines, "จบรายการชั่งคืน"].join("\n");
}

function item(number: number, product = "สินค้า", price = 80, quantity = number): string[] {
  return [`${number}. ${product} ${price} บาท`, `${quantity} โล`];
}

describe("explicit same-draft item correction", () => {
  it("keeps 30 effective items when only item 17 quantity is corrected", () => {
    const original = Array.from({ length: 30 }, (_, index) => item(index + 1)).flat();
    const parsed = parseWeighSession(document(
      ...original,
      "แก้ข้อ 17",
      ...item(17, "สินค้า", 80, 16),
    ));

    expect(parsed.parse_errors).toEqual([]);
    expect(parsed.items).toHaveLength(30);
    expect(parsed.items.find((row) => row.item_number === 17)?.quantity).toBe(16);
    expect(parsed.items.filter((row) => row.item_number !== 17).map((row) => row.quantity))
      .toEqual(Array.from({ length: 30 }, (_, index) => index + 1).filter((value) => value !== 17));
  });

  it("replaces a misspelled product instead of retaining both versions", () => {
    const parsed = parseWeighSession(document(
      ...item(17, "อะโวคาโด้", 80, 15),
      "แก้ข้อ 17",
      ...item(17, "อะโวคาโด", 80, 16),
    ));

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toMatchObject({
      item_number: 17,
      product_name: "อะโวคาโด",
      price_per_unit: 80,
      quantity: 16,
      unit: "โล",
    });
    expect(parsed.items.some((row) => row.product_name === "อะโวคาโด้")).toBe(false);
  });

  it("replaces a price instead of preserving both price buckets", () => {
    const parsed = parseWeighSession(document(
      ...item(17, "มังคุด", 45, 10),
      "แก้ข้อ 17",
      ...item(17, "มังคุด", 40, 10),
    ));

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.price_per_unit).toBe(40);
  });

  it("replaces quantity and unit exactly once", () => {
    const parsed = parseWeighSession(document(
      ...item(17, "มังคุด", 45, 10),
      "แก้ข้อ 17",
      "17. มังคุด 45 บาท",
      "12 ถุง",
    ));

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toMatchObject({ quantity: 12, unit: "ถุง" });
  });

  it("replaces only the unit without duplicating the item", () => {
    const parsed = parseWeighSession(document(
      ...item(17, "มังคุด", 45, 10),
      "แก้ข้อ 17",
      "17. มังคุด 45 บาท",
      "10 ถุง",
    ));

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toMatchObject({ quantity: 10, unit: "ถุง" });
  });

  it("removes exactly one item from the effective draft", () => {
    const parsed = parseWeighSession(document(
      ...item(16, "มังคุด"),
      ...item(17, "อะโวคาโด"),
      ...item(18, "ส้ม"),
      "ลบข้อ 17",
    ));

    expect(parsed.parse_errors).toEqual([]);
    expect(parsed.items.map((row) => row.item_number)).toEqual([16, 18]);
    expect(latestDraftItemAction(parsed)).toMatchObject({
      kind: "remove",
      item_number: 17,
      status: "applied",
    });
  });

  it("preserves a multiline draft and supports a correction split across LINE messages", () => {
    const messages = [
      [HEADER, ...item(1, "มังคุด", 45, 10), ...item(17, "อะโวคาโด้", 80, 15)].join("\n"),
      "แก้ข้อ 17",
      "17. อะโวคาโด 80 บาท",
      "16 โล",
      CLOSE,
    ];
    const parsed = parseWeighSession(messages.join("\n"));

    expect(parsed.parse_errors).toEqual([]);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[1]).toMatchObject({ product_name: "อะโวคาโด", quantity: 16 });
  });

  it("does not replace another item with an identical product", () => {
    const parsed = parseWeighSession(document(
      ...item(1, "มังคุด", 45, 2),
      ...item(2, "มังคุด", 45, 3),
      "แก้ข้อ 2",
      ...item(2, "มังคุด", 45, 4),
    ));

    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map((row) => row.quantity)).toEqual([2, 4]);
  });

  it("refuses an ambiguous duplicate number and leaves both original items unchanged", () => {
    const parsed = parseWeighSession(document(
      ...item(17, "มังคุด", 45, 2),
      ...item(17, "ส้ม", 30, 3),
      "แก้ข้อ 17",
      ...item(17, "อะโวคาโด", 80, 4),
    ));

    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map((row) => row.product_name)).toEqual(["มังคุด", "ส้ม"]);
    expect(parsed.parse_errors.join("\n")).toContain("เลขข้อ 17 ซ้ำ");
    const action = latestDraftItemAction(parsed);
    expect(action?.status).toBe("ambiguous_target");
    expect(buildDraftItemActionReply(action!)).toBe([
      "⚠️ พบเลขข้อ 17 ซ้ำ 2 รายการ",
      "กรุณาแก้เลขข้อให้ไม่ซ้ำก่อน",
      "รายการอื่นยังอยู่ครบ ไม่ต้องยกเลิก",
    ].join("\n"));
  });

  it("refuses an unknown target and leaves the draft unchanged", () => {
    const parsed = parseWeighSession(document(
      ...item(1, "มังคุด", 45, 2),
      "แก้ข้อ 17",
      ...item(17, "อะโวคาโด", 80, 4),
    ));

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.product_name).toBe("มังคุด");
    expect(parsed.parse_errors.join("\n")).toContain("ไม่พบข้อ 17");
    expect(latestDraftItemAction(parsed)?.status).toBe("target_not_found");
  });

  it("repairs a numbered raw line that failed to parse without resending good rows", () => {
    const parsed = parseWeighSession(returnDocument(
      "1. มะนาว 20 บาท",
      "3 แพค",
      "2.มะเขือยาว 36..1 โล 30 บาท",
      "3. หอมแดง 20 บาท",
      "5 แพค",
      "แก้ข้อ 2",
      "2. มะเขือยาว 30 บาท",
      "36.1 โล",
    ));

    expect(parsed.parse_errors).toEqual([]);
    expect(parsed.items).toHaveLength(3);
    expect(parsed.items.find((row) => row.item_number === 2)).toMatchObject({
      product_name: "มะเขือยาว",
      price_per_unit: 30,
      quantity: 36.1,
      unit: "โล",
      transaction_type: "คืน",
    });
    expect(latestDraftItemAction(parsed)?.status).toBe("applied");
  });

  it("can remove one numbered raw line that failed to parse", () => {
    const parsed = parseWeighSession(returnDocument(
      "1. มะนาว 20 บาท",
      "3 แพค",
      "2.มะเขือยาว 36..1 โล 30 บาท",
      "3. หอมแดง 20 บาท",
      "5 แพค",
      "ลบข้อ 2",
    ));

    expect(parsed.parse_errors).toEqual([]);
    expect(parsed.items.map((row) => row.item_number)).toEqual([1, 3]);
    expect(latestDraftItemAction(parsed)).toMatchObject({
      kind: "remove",
      item_number: 2,
      status: "applied",
    });
  });

  it("keeps the old item when the replacement uses the wrong item number", () => {
    const parsed = parseWeighSession(document(
      ...item(17, "มังคุด", 45, 2),
      "แก้ข้อ 17",
      ...item(18, "อะโวคาโด", 80, 4),
    ));

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toMatchObject({ item_number: 17, product_name: "มังคุด" });
    expect(latestDraftItemAction(parsed)?.status).toBe("invalid_replacement");
  });

  it("keeps the old item while a cross-message correction is incomplete", () => {
    const parsed = parseWeighSession([
      HEADER,
      ...item(17, "มังคุด", 45, 2),
      "แก้ข้อ 17",
      "17. อะโวคาโด 80 บาท",
    ].join("\n"));

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.product_name).toBe("มังคุด");
    expect(latestDraftItemAction(parsed)?.status).toBe("awaiting_replacement");
  });

  it("keeps the old item when the replacement is malformed", () => {
    const parsed = parseWeighSession(document(
      ...item(17, "มังคุด", 45, 2),
      "แก้ข้อ 17",
      "รายการนี้อ่านไม่ได้",
    ));

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toMatchObject({ item_number: 17, quantity: 2, unit: "โล" });
    expect(latestDraftItemAction(parsed)?.status).toBe("invalid_replacement");
  });

  it("keeps ordinary repeated-number behavior unchanged without an explicit command", () => {
    const parsed = parseWeighSession(document(
      ...item(17, "มังคุด", 45, 2),
      ...item(17, "ส้ม", 30, 3),
    ));

    expect(parsed.parse_errors).toEqual([]);
    expect(parsed.items).toHaveLength(2);
  });

  it("allows an explicitly removed item to be added again as ordinary input", () => {
    const parsed = parseWeighSession(document(
      ...item(17, "มังคุด", 45, 2),
      "ลบข้อ 17",
      ...item(17, "อะโวคาโด", 80, 4),
    ));

    expect(parsed.parse_errors).toEqual([]);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.product_name).toBe("อะโวคาโด");
  });

  it("keeps the previous effective item when the correction has an unknown unit", () => {
    const parsed = parseWeighSession(document(
      ...item(17, "มังคุด", 45, 2),
      "แก้ข้อ 17",
      "17. มังคุด 45 บาท",
      "4 โลก",
    ));
    const validation = validateProduceEntry({ parsed, roundRows: [], roundBound: false });

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toMatchObject({ item_number: 17, quantity: 2, unit: "โล" });
    expect(parsed.parse_errors.join("\n")).toContain("หน่วย “โลก” ไม่ถูกต้อง");
    expect(latestDraftItemAction(parsed)?.status).toBe("invalid_replacement");
    expect(validation.status).toBe("clean");
    expect(getWeighSessionFinalizationErrors(parsed)).not.toEqual([]);
  });

  it("recalculates the return invariant from only the corrected effective item", () => {
    const parsed = parseWeighSession([
      HEADER,
      ...item(1, "มังคุด", 45, 10),
      "รายการชั่งคืน",
      ...item(2, "มังคุด", 45, 12),
      "แก้ข้อ 2",
      ...item(2, "มังคุด", 45, 8),
      "จบรายการชั่งคืน",
    ].join("\n"));
    const validation = validateProduceEntry({ parsed, roundRows: [], roundBound: false });

    expect(validation.blocking).toEqual([]);
    expect(parsed.items.find((row) => row.item_number === 2)?.quantity).toBe(8);
  });

  it("retains corrected draft data when the operator sends a wrong closer", () => {
    const parsed = parseWeighSession([
      HEADER,
      ...item(17, "มังคุด", 45, 2),
      "แก้ข้อ 17",
      ...item(17, "มังคุด", 40, 4),
      "จบรายการชั่งคืน",
    ].join("\n"));

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toMatchObject({ price_per_unit: 40, quantity: 4 });
    expect(getWeighSessionFinalizationErrors(parsed).join("\n")).toContain("wrong closer");
  });

  it("finalizes cleanly once the corrected draft receives the right closer", () => {
    const parsed = parseWeighSession(document(
      ...item(17, "มังคุด", 45, 2),
      "แก้ข้อ 17",
      ...item(17, "มังคุด", 40, 4),
    ));

    expect(getWeighSessionFinalizationErrors(parsed)).toEqual([]);
    expect(parsed.items).toHaveLength(1);
  });

  it("replays the audited 26-item return repair from 3.3 to 3.0 without re-entry", () => {
    const original = Array.from({ length: 26 }, (_, index) => item(index + 1)).flat();
    original[(17 - 1) * 2 + 1] = "3.3 โล";
    const parsed = parseWeighSession(returnDocument(
      ...original,
      "แก้ข้อ 17",
      ...item(17, "สินค้า", 80, 3),
    ));

    expect(parsed.items).toHaveLength(26);
    expect(parsed.items.find((row) => row.item_number === 17)?.quantity).toBe(3);
  });

  it("replays the audited 21-item return repair from 21 to 14 without re-entry", () => {
    const original = Array.from({ length: 21 }, (_, index) => item(index + 1)).flat();
    const parsed = parseWeighSession(returnDocument(
      ...original,
      "แก้ข้อ 21",
      ...item(21, "สินค้า", 80, 14),
    ));

    expect(parsed.items).toHaveLength(21);
    expect(parsed.items.find((row) => row.item_number === 21)?.quantity).toBe(14);
  });

  it("replays multiple audited damaged-return quantity repairs in one draft", () => {
    const parsed = parseWeighSession(returnDocument(
      ...item(1, "มังคุด", 45, 0.5),
      ...item(2, "ส้ม", 30, 7),
      ...item(3, "อะโวคาโด", 80, 0.2),
      "แก้ข้อ 1",
      ...item(1, "มังคุด", 45, 0.1),
      "แก้ข้อ 2",
      ...item(2, "ส้ม", 30, 2),
      "แก้ข้อ 3",
      ...item(3, "อะโวคาโด", 80, 0.07),
    ));

    expect(parsed.items).toHaveLength(3);
    expect(parsed.items.map((row) => row.quantity)).toEqual([0.1, 2, 0.07]);
  });

  it("accepts several แก้ข้อ commands plus ลบข้อ in one message", () => {
    const parsed = parseWeighSession(returnDocument(
      ...item(2, "พักผ่อน", 20, 4),
      ...item(5, "มะนาว", 20, 8),
      ...item(8, "หอมแดง", 20, 1),
      "แก้ข้อ 2",
      ...item(2, "หอมแดง", 20, 4),
      "แก้ข้อ 5",
      ...item(5, "มะนาว", 20, 3),
      "ลบข้อ 8",
    ));

    expect(parsed.parse_errors).toEqual([]);
    expect(parsed.items.map((row) => [row.item_number, row.product_name, row.quantity])).toEqual([
      [2, "หอมแดง", 4],
      [5, "มะนาว", 3],
    ]);
    expect(parsed.draft_item_actions?.map((action) => [action.kind, action.item_number, action.status])).toEqual([
      ["correct", 2, "applied"],
      ["correct", 5, "applied"],
      ["remove", 8, "applied"],
    ]);
  });

  it("replays the audited มะม่วงจิ๋ว spelling repair without a full-list retry", () => {
    const parsed = parseWeighSession(document(
      ...item(17, "มะม่วงจิ๋ว", 50, 10),
      "แก้ข้อ 17",
      ...item(17, "มะม่วงจิ้ว", 50, 10),
    ));

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.product_name).toBe("มะม่วงจิ้ว");
  });
});
