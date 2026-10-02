import { describe, expect, it } from "bun:test";
import { validateProduceEntry } from "@/lib/produce/entry-validation";
import {
  buildPartialCaptureReviewReply,
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

describe("duplicate item number occurrence selectors", () => {
  const duplicate = [
    "51.ผักชี20บาท", "2กำ",
    "52.ผักบุ้ง10บาท", "3กำ",
    "52.คะน้า15บาท", "4กำ",
    "53.ต้นหอม20บาท", "1กำ",
  ];

  it("parses 52A/52B selectors, case-insensitive", () => {
    expect(parseDraftItemCommandLine("แก้ข้อ 52A")).toEqual({ kind: "correct", itemNumber: 52, occurrence: 1 });
    expect(parseDraftItemCommandLine("ลบข้อ52b")).toEqual({ kind: "remove", itemNumber: 52, occurrence: 2 });
    expect(parseDraftItemCommandLine("แก้ข้อ 52")).toEqual({ kind: "correct", itemNumber: 52 });
  });

  it("keeps plain แก้ข้อ 52 fail-closed and names the selectors", () => {
    const parsed = parseWeighSession(returnDocument(...duplicate, "แก้ข้อ 52"));
    const action = latestDraftItemAction(parsed)!;
    expect(action.status).toBe("ambiguous_target");
    expect(action.selectors).toEqual(["52A", "52B"]);
    expect(parsed.items).toHaveLength(4);
    expect(buildDraftItemActionReply(action)).toContain("52A, 52B");
  });

  it("แก้ข้อ 52A replaces only the first 52, typed number preserved", () => {
    const parsed = parseWeighSession(returnDocument(
      ...duplicate, "แก้ข้อ 52A", "52.ผักบุ้ง10บาท", "5กำ",
    ));
    expect(latestDraftItemAction(parsed)).toMatchObject({ status: "applied", occurrence: "A" });
    expect(parsed.items.map((row) => [row.item_number, row.product_name, row.quantity])).toEqual([
      [51, "ผักชี", 2], [52, "ผักบุ้ง", 5], [52, "คะน้า", 4], [53, "ต้นหอม", 1],
    ]);
  });

  it("combined แก้ข้อ 52A + ลบข้อ 52B resolves the duplicate, good rows untouched", () => {
    const before = parseWeighSession(returnDocument(...duplicate));
    const parsed = parseWeighSession(returnDocument(
      ...duplicate, "ลบข้อ 52B", "แก้ข้อ 52A", "52.ผักบุ้ง10บาท", "5กำ",
    ));
    expect(parsed.parse_errors).toEqual([]);
    expect(parsed.draft_item_actions?.map((action) => [action.kind, action.occurrence, action.status]))
      .toEqual([["remove", "B", "applied"], ["correct", "A", "applied"]]);
    expect(parsed.items.map((row) => [row.item_number, row.product_name, row.quantity])).toEqual([
      [51, "ผักชี", 2], [52, "ผักบุ้ง", 5], [53, "ต้นหอม", 1],
    ]);
    expect(parsed.items.filter((row) => row.item_number !== 52))
      .toEqual(before.items.filter((row) => row.item_number !== 52));
    const validation = validateProduceEntry({ parsed, roundRows: [], roundBound: false });
    expect(validation.blocking.some((exception) => exception.kind === "duplicate_item_number")).toBe(false);
  });

  it("selectors stay stable after an earlier removal (ลบข้อ 52A then แก้ข้อ 52B)", () => {
    const parsed = parseWeighSession(returnDocument(
      ...duplicate, "ลบข้อ 52A", "แก้ข้อ 52B", "52.คะน้า15บาท", "6กำ",
    ));
    expect(parsed.items.map((row) => [row.item_number, row.product_name, row.quantity])).toEqual([
      [51, "ผักชี", 2], [52, "คะน้า", 6], [53, "ต้นหอม", 1],
    ]);
  });

  it("an unknown selector fails closed", () => {
    const parsed = parseWeighSession(returnDocument(...duplicate, "ลบข้อ 52C"));
    expect(latestDraftItemAction(parsed)?.status).toBe("target_not_found");
    expect(parsed.items).toHaveLength(4);
  });

  it("review reply addresses each duplicate row as 52A/52B", () => {
    const { capture: staged } = capture(returnDocument(...duplicate));
    const reply = buildPartialCaptureReviewReply(staged);
    expect(reply).toContain("ข้อ 52A\nผักบุ้ง");
    expect(reply).toContain("ข้อ 52B\nคะน้า");
    expect(reply).toContain("แก้ข้อ 52A");
    expect(reply).toContain("52.หอมแดง20บาท");
    expect(staged.items.filter((entry) => entry.item.item_number !== 52).every((entry) => entry.status === "accepted"))
      .toBe(true);
  });
});
