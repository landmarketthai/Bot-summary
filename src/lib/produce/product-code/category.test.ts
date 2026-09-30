import { describe, expect, test } from "bun:test";
import { PRODUCT_CODE_ENTRIES } from "./dictionary";
import {
  UNCATEGORIZED_CATEGORY_ID,
  dictionaryCategoryFor,
  dictionaryEntryFor,
  reportCategoryHeading,
} from "./category";
import { normalizeProductName } from "@/lib/summary/remaining-fruit";
import { stockCategoryFor } from "@/lib/summary/stock-categories";

describe("dictionaryCategoryFor", () => {
  test("1. dictionary fruit resolves to ผลไม้", () => {
    expect(dictionaryCategoryFor("มะม่วงเขียวมรกต")).toBe("ม");
    expect(dictionaryCategoryFor("พุทราไทย")).toBe("ม");
    expect(dictionaryCategoryFor("สับปะรด")).toBe("ม");
    expect(reportCategoryHeading("ม")).toBe("🍉 ผลไม้");
  });

  test("2. dictionary vegetable resolves to ผัก", () => {
    expect(dictionaryCategoryFor("กวางตุ้งไทย")).toBe("ผ");
    expect(dictionaryCategoryFor("กระเทียมกลีบ")).toBe("ผ");
    expect(reportCategoryHeading("ผ")).toBe("🥬 ผัก");
  });

  test("3. dictionary dry/fish product resolves to ของแห้ง category", () => {
    expect(dictionaryCategoryFor("กะปิ")).toBe("ป");
    expect(dictionaryCategoryFor("ปลาซิว")).toBe("ป");
    expect(reportCategoryHeading("ป")).toBe("🐟 ปลา / อาหารแห้ง / ของแห้ง");
  });

  test("4. dictionary durian resolves to ทุเรียน", () => {
    expect(dictionaryCategoryFor("หมอนทอง")).toBe("ท");
    expect(dictionaryCategoryFor("หมอนทองเก่า")).toBe("ท");
    expect(reportCategoryHeading("ท")).toBe("🥭 ทุเรียน");
  });

  test("5. dictionary mushroom resolves to เห็ด", () => {
    expect(dictionaryCategoryFor("เห็ดแพ็ครวม")).toBe("ห");
    expect(dictionaryCategoryFor("เห็ดนางฟ้า")).toBe("ห");
    expect(reportCategoryHeading("ห")).toBe("🍄 เห็ด");
  });

  test("6. dictionary special item resolves to รายการพิเศษ", () => {
    expect(dictionaryCategoryFor("ผลไม้กล่อง")).toBe("พ");
    expect(dictionaryCategoryFor("มะระถุง")).toBe("พ");
    expect(reportCategoryHeading("พ")).toBe("📦 รายการพิเศษ");
  });

  test("7. reviewed alias resolves through canonical dictionary identity", () => {
    expect(normalizeProductName("อะโวคาโด้")).toBe("อะโวคาโด");
    expect(dictionaryCategoryFor(normalizeProductName("อะโวคาโด้"))).toBe("ม");
    expect(normalizeProductName("สัปรด")).toBe("สับปะรด");
    expect(dictionaryCategoryFor(normalizeProductName("สัปรด"))).toBe("ม");
    expect(normalizeProductName("หมอน")).toBe("หมอนทอง");
    expect(dictionaryCategoryFor(normalizeProductName("หมอน"))).toBe("ท");
    // ม54's dictionary-corrected spelling (20260818100000). The legacy
    // misspelling ไชมัส resolves through the reviewed alias to the corrected
    // canonical name, exactly like อะโวคาโด้ above.
    expect(normalizeProductName("ไชมัส")).toBe("ไซมัส");
    expect(dictionaryCategoryFor(normalizeProductName("ไชมัส"))).toBe("ม");
  });

  test("7b. ไซมัส is now itself a dictionary canonical name (ม54, corrected 20260818100000)", () => {
    expect(dictionaryCategoryFor("ไซมัส")).toBe("ม");
    expect(dictionaryEntryFor("ไซมัส")?.code).toBe("ม54");
  });

  test("8. unknown product stays ไม่จัดหมวด", () => {
    expect(dictionaryCategoryFor("สินค้าABC")).toBe(UNCATEGORIZED_CATEGORY_ID);
    expect(dictionaryCategoryFor("ของแปลกใหม่ไม่เคยเจอ")).toBe(UNCATEGORIZED_CATEGORY_ID);
    expect(dictionaryCategoryFor("")).toBe(UNCATEGORIZED_CATEGORY_ID);
    expect(dictionaryCategoryFor("   ")).toBe(UNCATEGORIZED_CATEGORY_ID);
    expect(reportCategoryHeading(UNCATEGORIZED_CATEGORY_ID)).toBe("❓ ไม่จัดหมวด");
  });

  test("9. no fuzzy category guessing", () => {
    expect(dictionaryCategoryFor("แตงโมมม")).toBe(UNCATEGORIZED_CATEGORY_ID);
    expect(dictionaryCategoryFor("กระชายย")).toBe(UNCATEGORIZED_CATEGORY_ID);
    expect(dictionaryCategoryFor("ทุเรียนXYZ")).toBe(UNCATEGORIZED_CATEGORY_ID);
    expect(dictionaryCategoryFor("ปลากระป๋องXYZ")).toBe(UNCATEGORIZED_CATEGORY_ID);
    expect(dictionaryCategoryFor("มะม่วง")).toBe(UNCATEGORIZED_CATEGORY_ID);
    // Production spelling variants with no reviewed alias stay uncategorized.
    // ไซมัส itself moved out of this list in 20260818100000 — it is now ม54's
    // own canonical spelling, not a fuzzy near-miss (see test 7b). ไซมัสส
    // (one extra ส, still genuinely absent from the dictionary and with no
    // reviewed alias) replaces it as the still-uncategorized example.
    expect(dictionaryCategoryFor("เห็ดแพครวม")).toBe(UNCATEGORIZED_CATEGORY_ID);
    expect(dictionaryCategoryFor("ไซมัสส")).toBe(UNCATEGORIZED_CATEGORY_ID);
    expect(dictionaryCategoryFor("ใบมะกรุด")).toBe(UNCATEGORIZED_CATEGORY_ID);
    expect(dictionaryCategoryFor("คน้าใหญ่")).toBe(UNCATEGORIZED_CATEGORY_ID);
    expect(dictionaryCategoryFor(normalizeProductName("สินค้าABC"))).toBe(UNCATEGORIZED_CATEGORY_ID);
  });

  test("a reviewed alias is required before lookup — the alias itself is not in the dictionary", () => {
    expect(dictionaryCategoryFor("อะโวคาโด้")).toBe(UNCATEGORIZED_CATEGORY_ID);
    expect(dictionaryCategoryFor("สัปรด")).toBe(UNCATEGORIZED_CATEGORY_ID);
  });

  test("every enabled dictionary category code is one of the six approved namespaces", () => {
    for (const entry of PRODUCT_CODE_ENTRIES) {
      expect(["ท", "ม", "ผ", "ป", "ห", "พ"]).toContain(entry.categoryCode);
      expect(dictionaryCategoryFor(entry.canonicalName)).toBe(entry.categoryCode as "ท" | "ม" | "ผ" | "ป" | "ห" | "พ");
    }
  });

  test("enabled canonical names do not collide across categories", () => {
    const seen = new Map<string, string>();
    for (const entry of PRODUCT_CODE_ENTRIES) {
      if (!entry.enabled) continue;
      const key = entry.canonicalName.normalize("NFC");
      const previous = seen.get(key);
      if (previous) expect(previous).toBe(entry.categoryCode);
      else seen.set(key, entry.categoryCode);
    }
  });
});

describe("2026-08-14 production products no longer fall into ไม่จัดหมวด", () => {
  const classified: Array<[string, ReportCategoryExpectation]> = [
    ["มะม่วงเขียวมรกต", "ม"],
    ["พุทราไทย", "ม"],
    ["หมอนทองเก่า", "ท"],
    ["ปลาลิ้นหมา", "ป"],
    ["ปลาซิว", "ป"],
    ["ปลาผีเสื้อ", "ป"],
    ["ปลาหมึกกะตอย", "ป"],
    ["ปลาหวานแดง", "ป"],
    ["ปลาหวานไม่งา", "ป"],
    ["กะปิ", "ป"],
    ["ปลาทูหอม", "ป"],
    ["ปลาหมึกแผ่น", "ป"],
    ["ปลากิมสั่ว", "ป"],
    ["ปลาทาโร่", "ป"],
    ["ปลาหวานงา", "ป"],
    ["ปลาจวด", "ป"],
  ];

  test.each(classified)("%s → dictionary %s (was uncategorized on the stock-category list)", (name, id) => {
    expect(stockCategoryFor(name)).toBe("ไม่จัดหมวด");
    expect(dictionaryCategoryFor(name)).toBe(id);
    expect(dictionaryEntryFor(name)?.canonicalName).toBe(name);
  });

  test("reviewed aliases from that day classify through the canonical dictionary row", () => {
    expect(dictionaryCategoryFor(normalizeProductName("อะโวคาโด้"))).toBe("ม");
    expect(dictionaryCategoryFor(normalizeProductName("สัปรด"))).toBe("ม");
    // ไชมัส is ม54's own pre-correction spelling (20260818100000), same shape
    // as อะโวคาโด้ / สัปรด above.
    expect(dictionaryCategoryFor(normalizeProductName("ไชมัส"))).toBe("ม");
  });

  test("unreviewed production spellings stay ไม่จัดหมวด rather than being invented", () => {
    // ไซมัส moved out of this list in 20260818100000: it is now ม54's own
    // canonical spelling, not an unreviewed production spelling (see the
    // "7b." test in category.test.ts's dictionaryCategoryFor describe block).
    // ไซมัสส (one extra ส) stands in as a name genuinely absent from the
    // dictionary with no reviewed alias.
    for (const name of ["ไซมัสส", "ใบมะกรุด", "คน้าใหญ่", "เห็ดแพครวม", "หอยเชล", "กล่ำปี", "นำเต้า", "สับปรด", "อินทผรัม"]) {
      expect(dictionaryCategoryFor(name)).toBe(UNCATEGORIZED_CATEGORY_ID);
      expect(normalizeProductName(name)).toBe(name);
    }
  });
});

describe("20260818100000 dictionary cleanup — ม54 correction and ม63–ม68", () => {
  const NEW_NAMES = [
    "ไซมัส",
    "มะม่วงจิ้ว",
    "ลูกพีชเล็ก",
    "ลูกพีชใหญ่",
    "ลูกไหนเขียว",
    "ลูกไหนดำ",
    "องุ่นคิมสัน",
  ] as const;

  test.each(NEW_NAMES.map((name) => [name] as const))(
    "%s classifies to ม (ผลไม้)",
    (name) => {
      expect(dictionaryCategoryFor(name)).toBe("ม");
    },
  );

  describe("independence — the pre-existing ม42/ม43/ม44 rows were not merged into the new rows", () => {
    test("ลูกพีช / ลูกไหน / ลูกไหนแดง still classify to ม on their own dictionary entry", () => {
      expect(dictionaryCategoryFor("ลูกพีช")).toBe("ม");
      expect(dictionaryCategoryFor("ลูกไหน")).toBe("ม");
      expect(dictionaryCategoryFor("ลูกไหนแดง")).toBe("ม");
    });

    test("none of the base or new variant names is swallowed by normalizeProductName", () => {
      for (const name of [
        "ลูกพีช", "ลูกไหน", "ลูกไหนแดง",
        "ลูกพีชเล็ก", "ลูกพีชใหญ่", "ลูกไหนเขียว", "ลูกไหนดำ",
      ]) {
        expect(normalizeProductName(name)).toBe(name);
      }
      // Explicit distinctness: the new size/color variants are separate dictionary
      // entries with different codes, never folded into their base product.
      expect("ลูกพีชเล็ก").not.toBe("ลูกพีช");
      expect("ลูกไหนเขียว").not.toBe("ลูกไหน");
    });
  });

  test("no fuzzy folding — near-miss ไชมัส/ไซมัส spellings stay uncategorized and unchanged", () => {
    for (const name of [
      "ไชมัสเก่า",
      "ไชมัสใหม่",
      "ไซมัสเก่า",
      "ไซมัสใหม่",
      "ไซมัสคัส",
      "องุ่นไชมัส",
      "องุ่นไซมัส",
    ]) {
      expect(normalizeProductName(name)).toBe(name);
      expect(dictionaryCategoryFor(name)).toBe(UNCATEGORIZED_CATEGORY_ID);
    }
  });
});

describe("dictionary cleanup extension — ม69–ม71 and the เขียวมรกต alias", () => {
  const NEW_NAMES = ["ส้มแมนดาริน", "องุ่นเคียวโฮ", "ลิ้นจี่"] as const;

  test.each(NEW_NAMES.map((name) => [name] as const))(
    "%s classifies to ม (ผลไม้)",
    (name) => {
      expect(dictionaryCategoryFor(name)).toBe("ม");
    },
  );

  test("เขียวมรกต resolves through the reviewed alias to ม31's canonical name", () => {
    expect(normalizeProductName("เขียวมรกต")).toBe("มะม่วงเขียวมรกต");
    expect(dictionaryCategoryFor(normalizeProductName("เขียวมรกต"))).toBe("ม");
  });

  test("EXACTNESS — near-miss เขียวมรกต spellings stay uncategorized and unchanged", () => {
    // เขียวมรกตเก่า (7 uses), เขียวมรกตใหม่ (1 use) and มรกต (5 uses) are REAL,
    // distinct operational names attested in Production — not typos of
    // เขียวมรกต — and must never fold into it. มะม่วงมรกต does not occur in
    // Production at all; it is included here as the adversarial near-miss of
    // the full canonical name itself.
    for (const name of ["เขียวมรกตเก่า", "เขียวมรกตใหม่", "มรกต", "มะม่วงมรกต"]) {
      expect(normalizeProductName(name)).toBe(name);
      expect(dictionaryCategoryFor(name)).toBe(UNCATEGORIZED_CATEGORY_ID);
    }
  });

  describe("identity distinctness — new codes never alias into a pre-existing product", () => {
    test("ส้มแมนดาริน is distinct from ส้มไต้หวัน (ม46) and ส้มเขียวหวาน (ม45)", () => {
      expect(dictionaryEntryFor("ส้มแมนดาริน")?.code).toBe("ม69");
      expect(dictionaryEntryFor("ส้มไต้หวัน")?.code).toBe("ม46");
      expect(dictionaryEntryFor("ส้มเขียวหวาน")?.code).toBe("ม45");
      const codes = new Set([
        dictionaryEntryFor("ส้มแมนดาริน")?.code,
        dictionaryEntryFor("ส้มไต้หวัน")?.code,
        dictionaryEntryFor("ส้มเขียวหวาน")?.code,
      ]);
      expect(codes.size).toBe(3);
      expect(normalizeProductName("ส้มแมนดาริน")).toBe("ส้มแมนดาริน");
    });

    test("องุ่นเคียวโฮ is distinct from องุ่นคิมสัน (ม68), องุ่นเขียว (ม52) and ไซมัส (ม54)", () => {
      expect(dictionaryEntryFor("องุ่นเคียวโฮ")?.code).toBe("ม70");
      expect(dictionaryEntryFor("องุ่นคิมสัน")?.code).toBe("ม68");
      expect(dictionaryEntryFor("องุ่นเขียว")?.code).toBe("ม52");
      expect(dictionaryEntryFor("ไซมัส")?.code).toBe("ม54");
      const codes = new Set([
        dictionaryEntryFor("องุ่นเคียวโฮ")?.code,
        dictionaryEntryFor("องุ่นคิมสัน")?.code,
        dictionaryEntryFor("องุ่นเขียว")?.code,
        dictionaryEntryFor("ไซมัส")?.code,
      ]);
      expect(codes.size).toBe(4);
      expect(normalizeProductName("องุ่นเคียวโฮ")).toBe("องุ่นเคียวโฮ");
    });
  });
});

describe("2026-09-30 vegetable market products classify as ผัก", () => {
  // Already dictionary rows (ผ05–ผ82); this pins them so no alias or dictionary
  // edit silently moves them, and proves no duplicate row is needed.
  const vegetables = [
    "แครอท", "มันฝรั่ง", "แตงร้าน", "แตงกวา", "กระเทียมหัว",
    "กระเทียมกลีบเล็ก", "กระเทียมกลีบใหญ่", "ขมิ้น", "กระชายซอย", "ขิงซอย",
  ];

  test("each resolves to exactly one enabled ผ dictionary row, unchanged by aliases", () => {
    for (const name of vegetables) {
      expect(normalizeProductName(name)).toBe(name);
      expect(dictionaryCategoryFor(name)).toBe("ผ");
      expect(PRODUCT_CODE_ENTRIES.filter((entry) => entry.enabled && entry.canonicalName === name))
        .toHaveLength(1);
    }
  });

  test("ambiguous names are not guessed into any category", () => {
    for (const name of ["ลูกพลุน", "องุ่นมีเม็ด", "ลูกไหนดำแดง"]) {
      expect(normalizeProductName(name)).toBe(name);
      expect(dictionaryCategoryFor(name)).toBe(UNCATEGORIZED_CATEGORY_ID);
    }
  });
});

type ReportCategoryExpectation = "ท" | "ม" | "ผ" | "ป" | "ห" | "พ";
