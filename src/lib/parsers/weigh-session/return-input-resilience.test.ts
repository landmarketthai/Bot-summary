import { describe, expect, it } from "bun:test";
import { validateProduceEntry } from "@/lib/produce/entry-validation";
import {
  buildPartialCaptureReviewReply,
  buildPartialCaptureSavedReply,
  buildProducePartialCapture,
} from "@/lib/produce/partial-capture";
import { getWeighSessionFinalizationErrors, parseWeighSession } from "./parser";
import {
  buildDraftItemActionReply,
  latestDraftItemAction,
  parseDraftItemCommandLine,
} from "./draft-item-command";

function returnDocument(...lines: string[]): string {
  return ["กี้-ตลาดทดสอบ ชั่งคืน 1/10/2569", ...lines, "จบรายการชั่งคืน"].join("\n");
}

function capture(text: string) {
  const parsed = parseWeighSession(text);
  const validation = validateProduceEntry({ parsed, roundRows: [], roundBound: false });
  return {
    parsed,
    capture: buildProducePartialCapture(parsed, validation, getWeighSessionFinalizationErrors(parsed)),
  };
}

describe("bundled-price shorthand without trailing บาท", () => {
  it("reads 96.หัวปลีเก่า3ลูก20 + 3ลูก as 3 ลูก / 20 บาท", () => {
    const parsed = parseWeighSession(returnDocument("96.หัวปลีเก่า3ลูก20", "3ลูก"));
    expect(parsed.parse_errors).toEqual([]);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toMatchObject({
      item_number: 96,
      product_name: "หัวปลีเก่า",
      pricing_mode: "basis",
      basis_quantity: 3,
      basis_unit: "ลูก",
      basis_price: 20,
      quantity: 3,
      unit: "ลูก",
    });
  });

  it("reads 98.กวางตุ้งญี่ปุ่น3หัว20 + 64หัว as 3 หัว / 20 บาท", () => {
    const parsed = parseWeighSession(returnDocument("98.กวางตุ้งญี่ปุ่น3หัว20", "64หัว"));
    expect(parsed.parse_errors).toEqual([]);
    expect(parsed.items[0]).toMatchObject({
      item_number: 98,
      product_name: "กวางตุ้งญี่ปุ่น",
      basis_quantity: 3,
      basis_unit: "หัว",
      basis_price: 20,
      quantity: 64,
      unit: "หัว",
    });
  });

  it("stays fail-closed for an unknown unit, zero price, or mismatched quantity unit", () => {
    expect(parseWeighSession(returnDocument("96.หัวปลีเก่า3ลูกๆ20", "3ลูก")).items).toEqual([]);
    expect(parseWeighSession(returnDocument("96.หัวปลีเก่า3ลูก0", "3ลูก")).items).toEqual([]);
    const mismatch = parseWeighSession(returnDocument("96.หัวปลีเก่า3ลูก20", "3โล"));
    expect(mismatch.parse_errors.some((error) => error.includes("basis unit mismatch"))).toBe(true);
  });
});

describe("price typed where the quantity belongs", () => {
  it("attributes 89.ใบชะพูล10บาท + 16บาท to item 89 only, never a phantom #16", () => {
    const { parsed, capture: staged } = capture(returnDocument(
      "88.ผักชี20บาท", "2กำ",
      "89.ใบชะพูล10บาท", "16บาท",
      "90.ผักบุ้ง10บาท", "3กำ",
    ));

    expect(parsed.items.map((row) => row.item_number)).toEqual([88, 90]);
    expect(parsed.parse_errors).toEqual([
      'item #89 ใบชะพูล quantity/unit unclear: "89.ใบชะพูล10บาท 16บาท"',
    ]);
    expect(staged.issues).toHaveLength(1);
    expect(staged.issues[0]).toMatchObject({ kind: "parse_error", itemNumber: 89 });
    expect(staged.issues.some((issue) => issue.itemNumber === 16)).toBe(false);
    expect(buildPartialCaptureReviewReply(staged)).toContain("89.ใบชะพูล10บาท 16บาท");
  });

  it("lets แก้ข้อ 89 supply the missing row without resending good rows", () => {
    const parsed = parseWeighSession(returnDocument(
      "88.ผักชี20บาท", "2กำ",
      "89.ใบชะพูล10บาท", "16บาท",
      "แก้ข้อ 89", "89.ใบชะพูล10บาท", "16กำ",
    ));
    expect(parsed.parse_errors).toEqual([]);
    expect(parsed.items.find((row) => row.item_number === 89)).toMatchObject({ quantity: 16, unit: "กำ" });
  });
});

describe("normalized duplicate item addressing", () => {
  const duplicate = [
    "51.ผักชี20บาท", "2กำ",
    "52.ผักบุ้ง10บาท", "3กำ",
    "52.คะน้า15บาท", "4กำ",
    "53.ต้นหอม20บาท", "1กำ",
  ];

  it("plain แก้ข้อ addresses the normalized item without ambiguity", () => {
    expect(parseDraftItemCommandLine("แก้ข้อ 52")).toEqual({ kind: "correct", itemNumber: 52 });
    const parsed = parseWeighSession(returnDocument(...duplicate, "แก้ข้อ 52", "52.ผักบุ้ง10บาท", "5กำ"));
    expect(latestDraftItemAction(parsed)?.status).toBe("applied");
    expect(parsed.items.map((row) => [row.item_number, row.product_name, row.quantity])).toEqual([
      [51, "ผักชี", 2], [52, "ผักบุ้ง", 5], [53, "คะน้า", 4], [54, "ต้นหอม", 1],
    ]);
    expect(buildDraftItemActionReply(latestDraftItemAction(parsed)!)).not.toMatch(/52[A-Z]/);
  });

  it("combined correction and deletion use the shown numbers", () => {
    const parsed = parseWeighSession(returnDocument(
      ...duplicate, "ลบข้อ 53", "แก้ข้อ 52", "52.ผักบุ้ง10บาท", "5กำ",
    ));
    expect(parsed.parse_errors).toEqual([]);
    expect(parsed.draft_item_actions?.map((action) => [action.kind, action.item_number, action.status]))
      .toEqual([["remove", 53, "applied"], ["correct", 52, "applied"]]);
    expect(parsed.items.map((row) => [row.item_number, row.product_name, row.quantity])).toEqual([
      [51, "ผักชี", 2], [52, "ผักบุ้ง", 5], [53, "ต้นหอม", 1],
    ]);
  });

  it("an unknown normalized or original number fails closed", () => {
    const parsed = parseWeighSession(returnDocument(...duplicate, "ลบข้อ 99"));
    expect(latestDraftItemAction(parsed)?.status).toBe("target_not_found");
    expect(parsed.items).toHaveLength(4);
  });

  it("duplicate numbering alone has no review or correction requirement", () => {
    const { parsed, capture: staged } = capture(returnDocument(...duplicate));
    expect(parsed.items.map((row) => row.item_number)).toEqual([51, 52, 53, 54]);
    expect(staged.issues).toEqual([]);
    expect(staged.items.every((entry) => entry.status === "accepted")).toBe(true);
    expect(buildPartialCaptureSavedReply(staged)).not.toMatch(/52[A-Z]|แก้ข้อ/);
  });

  it("an unreadable first duplicate keeps its slot while the second stays accepted", () => {
    const source = ["52.ผักบุ้ง10บาท", "16บาท", "52.คะน้า15บาท", "4กำ"];
    const { parsed, capture: staged } = capture(returnDocument(...source));
    expect(parsed.items).toContainEqual(expect.objectContaining({
      item_number: 53, original_item_number: 52, product_name: "คะน้า", quantity: 4, unit: "กำ",
    }));
    const reply = buildPartialCaptureReviewReply(staged);
    expect(buildPartialCaptureSavedReply(staged)).toContain("53. คะน้า");
    expect(reply).toContain("แก้ข้อ 52");
    expect(reply).not.toMatch(/52[A-Z]/);
    expect(staged.items[0]?.status).toBe("accepted");
    const corrected = parseWeighSession(returnDocument(...source,
      "แก้ข้อ 52", "52.ผักบุ้ง10บาท", "3กำ"));
    expect(corrected.parse_errors).toEqual([]);
    expect(corrected.items.map((item) => [item.item_number, item.product_name, item.quantity]))
      .toEqual([[52, "ผักบุ้ง", 3], [53, "คะน้า", 4]]);
  });
});
