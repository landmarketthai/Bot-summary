import { describe, expect, test } from "bun:test";
import {
  acceptedPhysicalInventoryItems,
  classifyPhysicalInventoryStandaloneIntent,
  isExplicitEmptyHouseStockDeclaration,
  isRecognizedPhysicalInventoryItemBlock,
  isPhysicalInventorySessionClose,
  matchesPhysicalInventoryCloseLine,
  parsePhysicalInventoryDocument,
  PHYSICAL_INVENTORY_PARSER_VERSION,
  PHYSICAL_INVENTORY_WAREHOUSE_MAIN,
} from "./index";

const FIXTURE_A = `สตอกผลไม้คงเหลือ
26/7/69

1พุทรา3ตะกร้า
2แก้วมังกร
15โล
3มะละกอ
90.ลูก
4แตงโม
80.ลูก
5สาลี
432.ลูก
6แอปเปิ้ล
440.ลูก
7องุ่นเขียวเลก
16.ตะกร้า
8โชคอนัน
1ตะกร้า
9องุ่นไชมัสตะกร้าขาว
12.ตะกร้า
10องุ่นไชมัสตะกร้าดำ
6ตะกร้า
11องุ่นไชมัสตะกร้าดำยังไม่แต่ง
13.ตะกร้า
จบ`;

const FIXTURE_B = `สตอกผลไม้คงเหลือวันนี้
27/7/69

1แตงโม
45.ลูก
2มะละกอ
15ลูก
3พุทรานม
2ตะกร้า
4มะม่วงโชคอนัน
15.โล
5แอปเปิ้ล
314.ลูก
6สาลี่น้ำผึ้ง
236.ลูก
7องุ่นเขียวตะกร้าแดง
12.ตะกร้า
8องุ่นไชมัสแต่งตะกร้าดำ
10.ตะกร้า
จบรายการผลไม้ที่เหลือในบ้าน`;

describe("parsePhysicalInventoryDocument — Fixture A (26/7/69)", () => {
  const session = parsePhysicalInventoryDocument(FIXTURE_A);
  const accepted = acceptedPhysicalInventoryItems(session);

  test("business date, warehouse, parser version", () => {
    expect(session.businessDate).toBe("2026-07-26");
    expect(session.warehouseCode).toBe(PHYSICAL_INVENTORY_WAREHOUSE_MAIN);
    expect(session.parserVersion).toBe(PHYSICAL_INVENTORY_PARSER_VERSION);
    expect(session.headerText).toBe("สตอกผลไม้คงเหลือ");
    expect(session.closeText).toBe("จบ");
  });

  test("11 accepted observations, sequences 1..11, no merge", () => {
    expect(accepted).toHaveLength(11);
    expect(accepted.map((i) => i.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  test("grape variants remain distinct; ตะกร้า preserved; no kg conversion", () => {
    const bySeq = Object.fromEntries(accepted.map((i) => [i.sequence!, i]));
    expect(bySeq[1]!.rawProductDescription).toBe("พุทรา");
    expect(bySeq[1]!.quantity).toBe(3);
    expect(bySeq[1]!.rawUnit).toBe("ตะกร้า");
    expect(bySeq[1]!.normalizedUnit).toBe("ตะกร้า");
    expect(bySeq[1]!.resolutionStatus).toBe("ACCEPTED_NORMALIZED");

    expect(bySeq[2]!.rawProductDescription).toBe("แก้วมังกร");
    expect(bySeq[2]!.quantity).toBe(15);
    expect(bySeq[2]!.rawUnit).toBe("โล");
    expect(bySeq[2]!.normalizedUnit).toBe("โล");
    expect(bySeq[2]!.resolutionStatus).toBe("ACCEPTED_NORMALIZED");

    expect(bySeq[7]!.rawProductDescription).toBe("องุ่นเขียวเลก");
    expect(bySeq[7]!.rawUnit).toBe("ตะกร้า");
    expect(bySeq[9]!.rawProductDescription).toBe("องุ่นไชมัสตะกร้าขาว");
    expect(bySeq[10]!.rawProductDescription).toBe("องุ่นไชมัสตะกร้าดำ");
    expect(bySeq[11]!.rawProductDescription).toBe("องุ่นไชมัสตะกร้าดำยังไม่แต่ง");
    expect(new Set([9, 10, 11].map((s) => bySeq[s]!.rawProductDescription)).size).toBe(3);

    expect(bySeq[8]!.rawProductDescription).toBe("โชคอนัน");
    // Must NOT apply P0 alias โชคอนัน→โชคอนันต์
    expect(bySeq[8]!.normalizedProduct).toBe("โชคอนัน");
  });
});

describe("parsePhysicalInventoryDocument — Fixture B (27/7/69)", () => {
  const session = parsePhysicalInventoryDocument(FIXTURE_B);
  const accepted = acceptedPhysicalInventoryItems(session);

  test("business date and 8 accepted observations", () => {
    expect(session.businessDate).toBe("2026-07-27");
    expect(session.headerText).toBe("สตอกผลไม้คงเหลือวันนี้");
    expect(session.closeText).toBe("จบรายการผลไม้ที่เหลือในบ้าน");
    expect(accepted).toHaveLength(8);
    expect(accepted.map((i) => i.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("no silent product merging across similar names", () => {
    const names = accepted.map((i) => i.rawProductDescription);
    expect(names).toContain("พุทรานม");
    expect(names).toContain("มะม่วงโชคอนัน");
    expect(names).toContain("สาลี่น้ำผึ้ง");
    expect(names).toContain("องุ่นเขียวตะกร้าแดง");
    expect(names).toContain("องุ่นไชมัสแต่งตะกร้าดำ");
    expect(new Set(names).size).toBe(8);
  });
});

describe("resolution and rejection cases", () => {
  test("quantity missing", () => {
    const session = parsePhysicalInventoryDocument(`สตอกผลไม้คงเหลือ
26/7/69
1มะม่วง
จบ`);
    expect(session.items[0]!.resolutionStatus).toBe("REJECTED");
    expect(session.items[0]!.reason).toBe("missing_quantity");
  });

  test("unit missing", () => {
    const session = parsePhysicalInventoryDocument(`สตอกผลไม้คงเหลือ
26/7/69
1มะม่วง
15
จบ`);
    const item = session.items.find((i) => i.sequence === 1);
    expect(item?.resolutionStatus).toBe("REJECTED");
    expect(item?.reason).toBe("missing_quantity");
  });

  test("zero quantity", () => {
    const session = parsePhysicalInventoryDocument(`สตอกผลไม้คงเหลือ
26/7/69
1มะม่วง0โล
จบ`);
    expect(session.items[0]!.resolutionStatus).toBe("REJECTED");
    expect(session.items[0]!.reason).toBe("zero_quantity");
  });

  test("negative quantity", () => {
    const session = parsePhysicalInventoryDocument(`สตอกผลไม้คงเหลือ
26/7/69
1มะม่วง
-3โล
จบ`);
    expect(session.items[0]!.resolutionStatus).toBe("REJECTED");
    expect(session.items[0]!.reason).toBe("negative_quantity");
    expect(session.items[0]!.quantity).toBe(-3);
  });

  test("positive one-line item still works", () => {
    const session = parsePhysicalInventoryDocument(`สตอกผลไม้คงเหลือ
26/7/69
1มะม่วง3โล
จบ`);
    expect(session.items[0]!.resolutionStatus).toBe("ACCEPTED_NORMALIZED");
  });

  test("duplicate sequence numbers preserve both observations", () => {
    const session = parsePhysicalInventoryDocument(`สตอกผลไม้คงเหลือ
26/7/69
7แตงโม
45ลูก
7มะละกอ
15ลูก
จบ`);
    expect(session.warnings.some((w) => w.code === "DUPLICATE_SEQUENCE")).toBe(true);
    const accepted = acceptedPhysicalInventoryItems(session);
    expect(accepted).toHaveLength(2);
    expect(accepted.map((i) => i.sequence)).toEqual([7, 7]);
    expect(accepted[0]!.rawProductDescription).toBe("แตงโม");
    expect(accepted[0]!.quantity).toBe(45);
    expect(accepted[0]!.rawUnit).toBe("ลูก");
    expect(accepted[1]!.rawProductDescription).toBe("มะละกอ");
    expect(accepted[1]!.quantity).toBe(15);
    expect(accepted[1]!.rawUnit).toBe("ลูก");
    expect(accepted.every((i) => i.resolutionStatus !== "REJECTED")).toBe(true);
  });

  test("missing sequence in the middle", () => {
    const session = parsePhysicalInventoryDocument(`สตอกผลไม้คงเหลือ
26/7/69
1มะม่วง
3โล
3ทุเรียน
2โล
จบ`);
    expect(session.warnings.some((w) => w.code === "sequence_gap")).toBe(true);
    const accepted = acceptedPhysicalInventoryItems(session);
    expect(accepted.map((i) => i.sequence)).toEqual([1, 3]);
  });

  test("unknown unit → ACCEPTED_RAW", () => {
    const session = parsePhysicalInventoryDocument(`สตอกผลไม้คงเหลือ
26/7/69
1พุทรา3กระติ๊บ
จบ`);
    expect(session.items[0]!.resolutionStatus).toBe("ACCEPTED_RAW");
    expect(session.items[0]!.rawUnit).toBe("กระติ๊บ");
    expect(session.items[0]!.normalizedUnit).toBeNull();
  });

  test("unknown product stays distinct ACCEPTED_NORMALIZED when unit known", () => {
    const session = parsePhysicalInventoryDocument(`สตอกผลไม้คงเหลือ
26/7/69
1ผลไม้ไม่มีในระบบ
2โล
จบ`);
    expect(session.items[0]!.resolutionStatus).toBe("ACCEPTED_NORMALIZED");
    expect(session.items[0]!.rawProductDescription).toBe("ผลไม้ไม่มีในระบบ");
    // Capture normalize ≠ canonical inventory identity
    expect(session.items[0]!.normalizedProduct).toBe("ผลไม้ไม่มีในระบบ");
  });

  test("repeated product lines preserved independently", () => {
    const session = parsePhysicalInventoryDocument(`สตอกผลไม้คงเหลือ
26/7/69
1มะม่วง
3โล
2มะม่วง
5โล
จบ`);
    const accepted = acceptedPhysicalInventoryItems(session);
    expect(accepted).toHaveLength(2);
    expect(accepted[0]!.quantity).toBe(3);
    expect(accepted[1]!.quantity).toBe(5);
  });

  test("typo close string", () => {
    const session = parsePhysicalInventoryDocument(`สตอกผลไม้คงเหลือ
26/7/69
1มะม่วง
3โล
จบรายการปลไม้ที่เหลือในบ้าน`);
    expect(session.closeText).toBe("จบรายการปลไม้ที่เหลือในบ้าน");
    expect(acceptedPhysicalInventoryItems(session)).toHaveLength(1);
  });

  test("date missing", () => {
    const session = parsePhysicalInventoryDocument(`สตอกผลไม้คงเหลือ
1มะม่วง
3โล
จบ`);
    expect(session.businessDate).toBeNull();
    expect(session.errors.some((e) => e.code === "missing_or_invalid_date")).toBe(true);
  });

  test("invalid Buddhist date", () => {
    const session = parsePhysicalInventoryDocument(`สตอกผลไม้คงเหลือ
32/13/69
1มะม่วง
3โล
จบ`);
    expect(session.businessDate).toBeNull();
    expect(session.errors.some((e) => e.code === "missing_or_invalid_date")).toBe(true);
  });

  test("header-like text inside body is not a second session", () => {
    const session = parsePhysicalInventoryDocument(`สตอกผลไม้คงเหลือ
26/7/69
1มะม่วง
3โล
สตอกผลไม้คงเหลือ
2ทุเรียน
1โล
จบ`);
    expect(session.warnings.some((w) => w.code === "header_like_in_body")).toBe(true);
    expect(acceptedPhysicalInventoryItems(session)).toHaveLength(2);
    expect(session.headerText).toBe("สตอกผลไม้คงเหลือ");
  });
});

describe("close is not a global command", () => {
  test("standalone close phrases classify as none", () => {
    expect(classifyPhysicalInventoryStandaloneIntent("จบ")).toBe("none");
    expect(
      classifyPhysicalInventoryStandaloneIntent("จบรายการผลไม้ที่เหลือในบ้าน"),
    ).toBe("none");
    expect(
      classifyPhysicalInventoryStandaloneIntent("จบรายการปลไม้ที่เหลือในบ้าน"),
    ).toBe("none");
    expect(classifyPhysicalInventoryStandaloneIntent("จบรายการ")).toBe("none");
  });

  test("session-gated close requires open session", () => {
    expect(isPhysicalInventorySessionClose("จบ", { sessionOpen: false })).toBe(false);
    expect(isPhysicalInventorySessionClose("จบ", { sessionOpen: true })).toBe(true);
    expect(
      isPhysicalInventorySessionClose("จบรายการผลไม้ที่เหลือในบ้าน", {
        sessionOpen: true,
      }),
    ).toBe(true);
    expect(matchesPhysicalInventoryCloseLine("จบ")).toBe(true);
  });

  test("header standalone intent", () => {
    expect(
      classifyPhysicalInventoryStandaloneIntent("สตอกผลไม้คงเหลือ\n26/7/69"),
    ).toBe("header");
  });
});

describe("known unit alias spelling only (no conversion)", () => {
  test("กก aliases to โล without changing quantity", () => {
    const session = parsePhysicalInventoryDocument(`สตอกผลไม้คงเหลือ
26/7/69
1มะม่วง10กก
จบ`);
    const item = session.items[0]!;
    expect(item.quantity).toBe(10);
    expect(item.rawUnit).toBe("กก");
    expect(item.normalizedUnit).toBe("โล");
    expect(item.resolutionStatus).toBe("ACCEPTED_NORMALIZED");
  });

  test("ขีด is known but not rescaled to โล", () => {
    const session = parsePhysicalInventoryDocument(`สตอกผลไม้คงเหลือ
26/7/69
1มะม่วง10ขีด
จบ`);
    const item = session.items[0]!;
    expect(item.quantity).toBe(10);
    expect(item.rawUnit).toBe("ขีด");
    expect(item.normalizedUnit).toBe("ขีด");
    expect(item.resolutionStatus).toBe("ACCEPTED_NORMALIZED");
  });
});

describe("session-gated Physical Inventory item routing", () => {
  test("accepts a parser-recognized stock observation", () => {
    expect(
      isRecognizedPhysicalInventoryItemBlock("1แตงโม\n45.ลูก"),
    ).toBe(true);
  });

  test("rejects Produce selling-price text even when the parser can tokenize it", () => {
    expect(
      isRecognizedPhysicalInventoryItemBlock("1.มังคุด80บาท\n3.9.โล"),
    ).toBe(false);
  });

  test("rejects a compact manual-slip amount and ordinary numeric chat", () => {
    expect(isRecognizedPhysicalInventoryItemBlock("1.90")).toBe(false);
    expect(isRecognizedPhysicalInventoryItemBlock("123")).toBe(false);
  });
});

describe("priced House Stock explicit empty declaration", () => {
  const priced = { requireUnitPrice: true } as const;

  test("exact declaration and numbered operator forms", () => {
    const forms = [
      "ไม่มีผลไม้เหลือ",
      "ไม่มีของเหลือ",
      "1ไม่มีผลไม้เหลือ",
      "1.ไม่มีผลไม้เหลือ",
      "1 ไม่มีผลไม้เหลือ",
      "1 ไม่มีของเหลือ",
    ];
    for (const form of forms) {
      const parsed = parsePhysicalInventoryDocument(
        `ผลไม้คงเหลือในบ้าน\n26/8/69\n${form}\nจบ`,
        priced,
      );
      expect(parsed.explicitEmpty).toBe(true);
      expect(parsed.items).toHaveLength(0);
      expect(parsed.businessDate).toBe("2026-08-26");
      expect(parsed.closeText).toBe("จบ");
      expect(parsed.errors).toHaveLength(0);
      expect(
        parsed.items.some((item) => item.rawProductDescription === form),
      ).toBe(false);
      expect(isRecognizedPhysicalInventoryItemBlock(form, priced)).toBe(true);
    }
  });

  test("does not fuzzy-match dangerous aliases", () => {
    for (const form of ["ไม่มี", "หมด", "0", "ศูนย์", "ไม่มีผลไม้"]) {
      expect(isExplicitEmptyHouseStockDeclaration(form)).toBe(false);
      const parsed = parsePhysicalInventoryDocument(
        `ผลไม้คงเหลือในบ้าน\n26/8/69\n${form}\nจบ`,
        priced,
      );
      expect(parsed.explicitEmpty).toBe(false);
    }
  });

  test("unpriced Physical Inventory does not treat the phrase as empty stock", () => {
    const parsed = parsePhysicalInventoryDocument(
      `สตอกผลไม้คงเหลือ\n26/8/69\nไม่มีผลไม้เหลือ\nจบ`,
    );
    expect(parsed.explicitEmpty).toBe(false);
    expect(isRecognizedPhysicalInventoryItemBlock("ไม่มีผลไม้เหลือ")).toBe(false);
  });

  test("unpriced header stays non-empty even if the priced parser flag is on", () => {
    const parsed = parsePhysicalInventoryDocument(
      `สตอกผลไม้คงเหลือ\n26/8/69\nไม่มีผลไม้เหลือ\nจบ`,
      priced,
    );
    expect(parsed.headerText).toBe("สตอกผลไม้คงเหลือ");
    expect(parsed.explicitEmpty).toBe(false);
  });

  test("product then empty is a contradiction", () => {
    const parsed = parsePhysicalInventoryDocument(
      "ผลไม้คงเหลือในบ้าน\n26/8/69\n1สาลี่10บาท\n20ลูก\nไม่มีผลไม้เหลือ\nจบ",
      priced,
    );
    expect(parsed.errors.some((error) => error.code === "explicit_empty_conflict")).toBe(true);
    expect(parsed.items.length).toBeGreaterThan(0);
  });

  test("empty then product is a contradiction", () => {
    const parsed = parsePhysicalInventoryDocument(
      "ผลไม้คงเหลือในบ้าน\n26/8/69\nไม่มีผลไม้เหลือ\n1สาลี่10บาท\n20ลูก\nจบ",
      priced,
    );
    expect(parsed.explicitEmpty).toBe(true);
    expect(parsed.errors.some((error) => error.code === "explicit_empty_conflict")).toBe(true);
    expect(parsed.items.some((item) => item.resolutionStatus !== "REJECTED")).toBe(false);
  });

  test("header-only close is not an explicit empty snapshot", () => {
    const parsed = parsePhysicalInventoryDocument(
      "ผลไม้คงเหลือในบ้าน\n26/8/69\nจบ",
      priced,
    );
    expect(parsed.explicitEmpty).toBe(false);
    expect(parsed.items).toHaveLength(0);
  });
});

describe("priced house stock — exact decimal money, no floating multiplication", () => {
  const priced = (price: string) => parsePhysicalInventoryDocument(
    `ผลไม้คงเหลือในบ้าน\n26/8/69\n1สาลี่${price}บาท\n16.โล\nจบ`,
    { requireUnitPrice: true },
  ).items.find((i) => i.sequence === 1);

  // Every one of these was REJECTED as invalid_unit_price before the fix:
  // Number("2.01") * 100 is 200.99999999999997, which is not a safe integer.
  test.each([
    ["2.01", 201],
    ["10.05", 1005],
    ["1.10", 110],
    ["8.29", 829],
    ["1.15", 115],
    ["0.1", 10],
    ["0.2", 20],
    ["0.3", 30],
    ["100", 10000],
    ["0.01", 1],
  ])("%s บาท is accepted as %i satang", (price, satang) => {
    const item = priced(price as string);
    expect(item?.reason).toBeNull();
    expect(item?.unitPriceSatang).toBe(satang as number);
  });

  test("more than two decimal places still fails closed", () => {
    const item = priced("1.234");
    expect(item?.unitPriceSatang ?? null).toBeNull();
  });

  test("zero is not a price", () => {
    const item = priced("0");
    expect(item?.unitPriceSatang ?? null).toBeNull();
  });

  test("an oversized amount fails closed rather than losing precision", () => {
    // Past numeric(10,2) / the document money digit limit.
    const item = priced("99999999999999999.99");
    expect(item?.unitPriceSatang ?? null).toBeNull();
  });
});
