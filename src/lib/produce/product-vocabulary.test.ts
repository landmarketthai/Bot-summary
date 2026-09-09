/**
 * Product vocabulary guard — suggestion ranking and the withdrawal-intake gate.
 *
 * Every fixture named "Production" is a finalized withdrawal from the
 * 2026-08-15 read-only audit: nine distinct product names on that day did not
 * match any approved dictionary spelling, and all but three were misspellings
 * of a product that already has a code.
 */
import { describe, expect, it } from "bun:test";
import type { WeighSession, WeighSessionItem } from "@/lib/parsers/weigh-session/types";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import { PRODUCT_CODE_ENTRIES } from "./product-code/dictionary";
import {
  approvedProductCode,
  canonicalProduceProductIdentity,
  isApprovedProductName,
  resolveApprovedProductName,
  resolveSafeAutoCorrectProductName,
  suggestDictionaryProducts,
} from "./product-vocabulary";
import {
  validateProduceEntry,
  type ProduceValidationException,
  type ProduceValidationResult,
} from "./entry-validation";
import { buildReviewValidationReply } from "./entry-validation-message";

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
    date: "2026-08-15",
    staff_name: "แทน",
    sender_name: null,
    transaction_time: "06:00",
    session_title: "ราชพฤก",
    session_kind: "main",
    declared_transaction_type: "เบิก",
    items: items.map((entry, index) => ({ ...entry, item_number: index + 1 })),
    parse_errors: [],
  };
}

function withdraw(...names: string[]): ProduceValidationResult {
  return validateProduceEntry({
    parsed: session(names.map((product_name) => item({ product_name }))),
    roundRows: [],
    roundBound: true,
  });
}

type VocabularyException = Extract<
  ProduceValidationException,
  { kind: "unknown_product_vocabulary" }
>;

function vocabulary(result: ProduceValidationResult): VocabularyException[] {
  return result.reviews.filter(
    (exception): exception is VocabularyException =>
      exception.kind === "unknown_product_vocabulary",
  );
}

/** The canonical names suggested for a single-item withdrawal, in rank order. */
function suggestedNames(name: string): string[] {
  return suggestDictionaryProducts(name).map((candidate) => candidate.canonicalName);
}

// ── The dictionary as reference vocabulary ───────────────────────────────────

describe("approved vocabulary", () => {
  it("recognises every enabled canonical name and reports its code", () => {
    for (const entry of PRODUCT_CODE_ENTRIES) {
      if (!entry.enabled) continue;
      expect(isApprovedProductName(entry.canonicalName)).toBe(true);
      expect(approvedProductCode(entry.canonicalName)).toBe(entry.code);
    }
  });

  it("normalizes basic text and reviewed deterministic aliases", () => {
    expect(isApprovedProductName("  มะม่วงเขียวมรกต  ")).toBe(true);
    expect(isApprovedProductName("เครื่องต้มยำ")).toBe(true);
    expect(isApprovedProductName("เครื่อง   ต้มยำ")).toBe(false);
    expect(isApprovedProductName("ปลาหมึก แผ่น")).toBe(false);
    expect(resolveApprovedProductName("อะโวคาโด้")).toEqual({
      productCode: "ม59",
      canonicalName: "อะโวคาโด",
    });
  });

  it("suggests nothing for a product that is already approved", () => {
    expect(suggestDictionaryProducts("มะม่วงเขียวมรกต")).not.toContainEqual(
      expect.objectContaining({ canonicalName: "มะม่วงเขียวมรกต" }),
    );
  });
});

// ── Production fixtures, 2026-08-15 ──────────────────────────────────────────

describe("Production 2026-08-15 withdrawal spellings", () => {
  it("CASE A — มะม่วงเขียวรกต (แทน / ราชพฤก) reviews and suggests ม31", () => {
    const result = withdraw("มะม่วงเขียวรกต");
    expect(result.status).toBe("review_required");
    const [exception] = vocabulary(result);
    expect(exception).toMatchObject({
      kind: "unknown_product_vocabulary",
      severity: "review_required",
      itemNumber: 1,
      productName: "มะม่วงเขียวรกต",
    });
    expect(exception).toHaveProperty("suggestions");
    expect(suggestDictionaryProducts("มะม่วงเขียวรกต")[0]).toEqual({
      productCode: "ม31",
      canonicalName: "มะม่วงเขียวมรกต",
    });
  });

  it("CASE B — เขียวมรกต (ดำ / วัดตะกล่ำ) resolves through its reviewed alias", () => {
    expect(suggestedNames("เขียวมรกต")).toContain("มะม่วงเขียวมรกต");
    expect(resolveApprovedProductName("เขียวมรกต")).toEqual({
      productCode: "ม31",
      canonicalName: "มะม่วงเขียวมรกต",
    });
    expect(withdraw("เขียวมรกต").status).toBe("clean");
  });

  it("CASE C — สับปรด suggests สับปะรด but stays unresolved without a canonical target", () => {
    expect(suggestedNames("สับปรด")[0]).toBe("สับปะรด");
    expect(withdraw("สับปรด").status).toBe("review_required");
  });

  it("CASE D — ไชมัส resolves to ไซมัส (reviewed alias, after 20260818100000)", () => {
    expect(suggestedNames("ไชมัส")[0]).toBe("ไซมัส");
    expect(resolveApprovedProductName("ไชมัส")).toEqual({
      productCode: "ม54",
      canonicalName: "ไซมัส",
    });
    expect(withdraw("ไชมัส").status).toBe("clean");
  });

  it("CASE D2 — องุ่นคินสัน resolves to ม68 องุ่นคิมสัน (reviewed one-char typo)", () => {
    // A single-character typo (น for ม) of the existing canonical name, folded
    // as a reviewed alias — NOT a new identity and NOT one of the ม75–ม80 codes.
    expect(resolveApprovedProductName("องุ่นคินสัน")).toEqual({
      productCode: "ม68",
      canonicalName: "องุ่นคิมสัน",
    });
    expect(withdraw("องุ่นคินสัน").status).toBe("clean");
  });

  it("CASE E — อินทผรัม suggests อินทผลัม", () => {
    expect(suggestedNames("อินทผรัม")[0]).toBe("อินทผลัม");
  });

  it("CASE F — อินมผรัม, two characters out, still reaches อินทผลัม", () => {
    expect(suggestedNames("อินมผรัม")).toContain("อินทผลัม");
  });

  it("CASE G — the approved spelling มะม่วงเขียวมรกต is clean", () => {
    expect(withdraw("มะม่วงเขียวมรกต").status).toBe("clean");
  });

  it("CASE H — the code ม31 resolves to the canonical name and is clean", () => {
    const parsed = parseWeighSession(
      ["แทน-ราชพฤก เบิก 15/8/2569", "ม31 30 บาท", "8 โล", "จบรายการเบิก"].join("\n"),
    );
    expect(parsed.items[0].product_name).toBe("มะม่วงเขียวมรกต");
    expect(
      validateProduceEntry({ parsed, roundRows: [], roundBound: true }).status,
    ).toBe("clean");
  });

  it("CASE I — a genuinely new product reviews with no forced suggestion", () => {
    const result = withdraw("สินค้าใหม่ABC");
    expect(result.status).toBe("review_required");
    expect(vocabulary(result)[0]).toMatchObject({
      productName: "สินค้าใหม่ABC",
      suggestions: [],
    });
  });

  it("CASE I — the same, through the real parser, on a name the parser accepts", () => {
    // A Latin-bearing product name never reaches validation: the parser already
    // refuses "สินค้าXYZ 50 บาท" as an unrecognized line, which is its own
    // fail-closed path and is unchanged here.
    const parsed = parseWeighSession(
      [
        "แทน-ราชพฤก เบิก 15/8/2569",
        "ฝรั่งสายพันธุ์ใหม่ 60 บาท",
        "5 โล",
        "จบรายการเบิก",
      ].join("\n"),
    );
    expect(parsed.parse_errors).toEqual([]);
    const result = validateProduceEntry({ parsed, roundRows: [], roundBound: true });
    expect(result.status).toBe("review_required");
    expect(vocabulary(result)[0]).toMatchObject({
      productName: "ฝรั่งสายพันธุ์ใหม่",
      suggestions: [],
    });
  });

  it("CASE J — ปลาอินทรีย์ is now an explicitly reviewed auto-correction to ปลาอินทรี", () => {
    expect(resolveSafeAutoCorrectProductName("ปลาอินทรีย์")).toEqual({
      productCode: "ป35",
      canonicalName: "ปลาอินทรี",
      reason: "reviewed_typo",
    });
    expect(withdraw("ปลาอินทรีย์").status).toBe("clean");
  });

  it("CASE K — หมึกกระตอย reaches ปลาหมึกกะตอย through the shared run, not a merge", () => {
    expect(suggestedNames("หมึกกระตอย")).toContain("ปลาหมึกกะตอย");
    expect(vocabulary(withdraw("หมึกกระตอย"))[0]).toMatchObject({
      productName: "หมึกกระตอย",
    });
  });

  it("อะโวคาโด้ — the reviewed alias resolves without a vocabulary review", () => {
    expect(suggestDictionaryProducts("อะโวคาโด้")[0]).toEqual({
      productCode: "ม59",
      canonicalName: "อะโวคาโด",
    });
    expect(resolveApprovedProductName("อะโวคาโด้")).toEqual({
      productCode: "ม59",
      canonicalName: "อะโวคาโด",
    });
    expect(withdraw("อะโวคาโด้").status).toBe("clean");
  });
});

// ── Suggestion safety ────────────────────────────────────────────────────────

describe("suggestions are never identity", () => {
  it("returns at most three candidates", () => {
    for (const name of ["ปลาทู", "หมอนทองx", "กะหล่ำปี", "เขียวมรกต"]) {
      expect(suggestDictionaryProducts(name).length).toBeLessThanOrEqual(3);
    }
  });

  it("is deterministic across repeated calls", () => {
    const once = suggestDictionaryProducts("อินมผรัม");
    expect(suggestDictionaryProducts("อินมผรัม")).toEqual(once);
  });

  it("does not force a candidate onto an unrelated name", () => {
    expect(suggestDictionaryProducts("ฝรั่งสายพันธุ์ใหม่ของสวนลุงมี")).toEqual([]);
  });

  it("never rewrites the entered product name", () => {
    const parsed = session([item({ product_name: "อินทผรัม" })]);
    validateProduceEntry({ parsed, roundRows: [], roundBound: true });
    expect(parsed.items[0].product_name).toBe("อินทผรัม");
  });

  it("does not mutate the dictionary", () => {
    const before = PRODUCT_CODE_ENTRIES.length;
    withdraw("สินค้าใหม่ABC", "อินทผรัม", "เขียวมรกต");
    expect(PRODUCT_CODE_ENTRIES).toHaveLength(before);
    expect(isApprovedProductName("สินค้าใหม่ABC")).toBe(false);
  });
});

// ── Scope ────────────────────────────────────────────────────────────────────

describe("guard scope", () => {
  it("applies to เบิกเพิ่ม, the additional withdrawal batch", () => {
    const parsed = session([
      item({ product_name: "อินมผรัม", transaction_type: "เบิกเพิ่ม" }),
    ]);
    const result = validateProduceEntry({ parsed, roundRows: [], roundBound: true });
    expect(vocabulary(result)).toHaveLength(1);
  });

  it("does not apply to คืน or คืนเสีย — a return is judged against the master", () => {
    const parsed = session([
      item({ product_name: "อินทผลัม", transaction_type: "เบิก", quantity: 5 }),
      item({ product_name: "อินมผรัม", transaction_type: "คืน", quantity: 1 }),
    ]);
    const result = validateProduceEntry({ parsed, roundRows: [], roundBound: true });
    expect(vocabulary(result)).toHaveLength(0);
    // The return is unmatched for its own, separate reason.
    expect(result.blocking.map((exception) => exception.kind)).toEqual([
      "product_not_withdrawn",
    ]);
  });

  it("keeps unknown_product_vocabulary and product_not_withdrawn separate", () => {
    const parsed = session([
      item({ product_name: "อินมผรัม", transaction_type: "เบิก", quantity: 5 }),
      item({ product_name: "องุ่นดำ", transaction_type: "คืน", quantity: 1 }),
    ]);
    const result = validateProduceEntry({ parsed, roundRows: [], roundBound: true });
    expect(vocabulary(result)).toHaveLength(1);
    expect(result.blocking.map((exception) => exception.kind)).toEqual([
      "product_not_withdrawn",
    ]);
    // Blocking wins: an unresolvable return is not downgraded by a review.
    expect(result.status).toBe("blocked");
  });

  it("reports one exception per distinct spelling, at its first item number", () => {
    const result = withdraw("อินมผรัม", "มะม่วงเขียวมรกต", "อินมผรัม", "สับปรด");
    const exceptions = vocabulary(result);
    expect(exceptions.map((exception) => exception.itemNumber)).toEqual([1, 4]);
  });

  it("lists every suspicious name in one reply, ordered by item number", () => {
    // ไซมัส is ม54's approved spelling as of 20260818100000 and no longer
    // exercises the review path (CASE D above). "ฝรั่งสายพันธุ์ใหม่ของสวนลุงมี"
    // replaces it — a name proven genuinely absent from the dictionary with no
    // near match (see "does not force a candidate onto an unrelated name").
    const result = withdraw(
      "มะม่วงเขียวรกต", "มะม่วงเขียวมรกต", "ฝรั่งสายพันธุ์ใหม่ของสวนลุงมี", "สินค้าXYZ",
    );
    expect(vocabulary(result)).toHaveLength(3);
    const reply = buildReviewValidationReply(result);
    expect(reply).toContain("⚠️ พบ 3 ชื่อสินค้าที่ต้องตรวจสอบ");
    expect(reply.indexOf("มะม่วงเขียวรกต")).toBeLessThan(
      reply.indexOf("ฝรั่งสายพันธุ์ใหม่ของสวนลุงมี"),
    );
    expect(reply).toContain("ม31 — มะม่วงเขียวมรกต");
    expect(reply).toContain("ไม่พบชื่อใกล้เคียงในรายการมาตรฐาน");
    expect(reply).toContain("✅ ถ้าชื่อเหล่านี้ถูกต้องและต้องการบันทึกตามที่พิมพ์");
    expect(reply).toContain("✏️ ถ้าต้องการแก้ชื่อ");
  });
});

// ── Confirmation binding ─────────────────────────────────────────────────────

// ── 20260818100000 dictionary cleanup ───────────────────────────────────────

describe("20260818100000 dictionary cleanup — ม54 correction and ม63–ม68", () => {
  it("accepts every new exact canonical name — ไซมัส plus the six new ม products", () => {
    for (const name of [
      "ไซมัส",
      "มะม่วงจิ้ว",
      "ลูกพีชเล็ก",
      "ลูกพีชใหญ่",
      "ลูกไหนเขียว",
      "ลูกไหนดำ",
      "องุ่นคิมสัน",
    ]) {
      expect(isApprovedProductName(name)).toBe(true);
    }
  });

  it("still fails closed for a genuinely unknown product — review_required, not blocking", () => {
    const invented = "ผลไม้ที่ไม่มีจริงเลย";
    expect(isApprovedProductName(invented)).toBe(false);
    const result = withdraw(invented);
    expect(result.status).toBe("review_required");
    expect(vocabulary(result)[0]).toMatchObject({
      kind: "unknown_product_vocabulary",
      severity: "review_required",
      productName: invented,
    });
  });

  it("the legacy alias spelling ไชมัส resolves to corrected ม54", () => {
    expect(isApprovedProductName("ไชมัส")).toBe(true);
    expect(approvedProductCode("ไชมัส")).toBe("ม54");
  });
});

describe("dictionary cleanup extension — ม69–ม71 and the เขียวมรกต alias", () => {
  it("accepts every new exact canonical name — ส้มแมนดาริน, องุ่นเคียวโฮ, ลิ้นจี่", () => {
    for (const name of ["ส้มแมนดาริน", "องุ่นเคียวโฮ", "ลิ้นจี่"]) {
      expect(isApprovedProductName(name)).toBe(true);
    }
  });

  it("เขียวมรกต resolves to canonical ม31", () => {
    expect(isApprovedProductName("เขียวมรกต")).toBe(true);
    expect(approvedProductCode("เขียวมรกต")).toBe("ม31");
  });
});

describe("safe auto-correction from reviewed Production typos", () => {
  it.each([
    ["กระปิ", "กะปิ", "ป01"],
    ["ขิงออ่น", "ขิงอ่อน", "ผ22"],
    ["ฝักกระเจียบ", "ฝักกระเจี๊ยบ", "ผ01"],
    ["ใบกระเจียบ", "ใบกระเจี๊ยบ", "ผ95"],
    ["กวางตุ้งยี่ปุ่น", "กวางตุ้งญี่ปุ่น", "ผ14"],
    ["ใบต้งโอ้", "ใบตั้งโอ๋", "ผ99"],
    ["คะน้าฮ้องกง", "คะน้าฮ่องกง", "ผ26"],
    ["เห็ดแพครวม", "เห็ดแพ็ครวม", "ห02"],
    ["หอยเชลย์", "หอยเชลล์", "ป36"],
    ["แก้งมังกร", "แก้วมังกร", "ม05"],
    ["สับรด", "สับปะรด", "ม49"],
    ["คน้าใหญ่", "คะน้าใหญ่", "ผ25"],
    ["แอปเปิ่ล", "แอปเปิ้ล", "ม62"],
    ["น่อยหน่า", "น้อยหน่า", "ม16"],
    ["หัวไซเท้า", "หัวไชเท้า", "ผ93"],
    ["ทับมิม", "ทับทิม", "ม15"],
    ["ทับทิบ", "ทับทิม", "ม15"],
    ["อินทผรัม", "อินทผลัม", "ม60"],
    ["ฟักออ่น", "ฟักอ่อน", "ผ68"],
    ["สลัดคอส", "สลัดคอต", "ผ66"],
    ["ไชเท้า", "หัวไชเท้า", "ผ93"],
    ["ดอกกะหล่ำ", "กะหล่ำดอก", "ผ12"],
    ["ดอกกระหล่ำ", "กะหล่ำดอก", "ผ12"],
    ["บรอกโคลี่", "บรอกโคลี", "ผ49"],
    ["ผักชีไทบ", "ผักชีไทย", "ผ59"],
    ["ปลานหวานไม่งา", "ปลาหวานไม่งา", "ป33"],
    ["ผักกะเฉด", "ผักกระเฉด", "ผ50"],
    ["ปลาหมึกกระตอย", "ปลาหมึกกะตอย", "ป27"],
    ["กวางตุ้งญี่ปุ่นปุ่น", "กวางตุ้งญี่ปุ่น", "ผ14"],
    ["ใบต๊งโอ๋", "ใบตั้งโอ๋", "ผ99"],
    ["ใบต๊งโอ้", "ใบตั้งโอ๋", "ผ99"],
    ["น้อนหน่ย", "น้อยหน่า", "ม16"],
    ["แก้วมังแดง", "แก้วมังกรแดง", "ม07"],
    ["ปลาอินทรีย์", "ปลาอินทรี", "ป35"],
    ["ผักแพรว", "ผักแพว", "ผ126"],
    ["ใบกระเพราขาว", "ใบกะเพราขาว", "ผ127"],
  ])("%s auto-corrects exactly to %s / %s", (entered, canonicalName, productCode) => {
    expect(resolveSafeAutoCorrectProductName(entered)).toEqual({ productCode, canonicalName, reason: "reviewed_typo" });
    expect(canonicalProduceProductIdentity(entered, "โล")).toBe(canonicalName);
    expect(withdraw(entered).status).toBe("clean");
  });

  it("keeps fuzzy or potentially distinct shop names under human review", () => {
    for (const name of ["มะระลูก", "ใบกระเพราขา"]) {
      expect(resolveSafeAutoCorrectProductName(name)).toBeNull();
    }
  });
});

describe("deterministic product-name aliases", () => {
  it.each([
    ["อะโวคาโด้", "อะโวคาโด", "ม59"],
    ["ไชมัส", "ไซมัส", "ม54"],
    ["สาลี", "สาลี่", "ม50"],
    ["องุ่นคินสัน", "องุ่นคิมสัน", "ม68"],
  ])("%s resolves to canonical %s / %s without review", (alias, canonicalName, productCode) => {
    expect(resolveApprovedProductName(alias)).toEqual({ productCode, canonicalName });
    expect(approvedProductCode(alias)).toBe(approvedProductCode(canonicalName));
    expect(withdraw(alias).status).toBe("clean");
  });

  it("keeps canonical spelling unchanged", () => {
    expect(resolveApprovedProductName("อะโวคาโด")).toEqual({
      productCode: "ม59",
      canonicalName: "อะโวคาโด",
    });
  });

  it("keeps ambiguous, unknown, and distinct mango products safe", () => {
    expect(resolveApprovedProductName("มะม่วง")).toBeNull();
    expect(withdraw("มะม่วง").status).toBe("review_required");
    expect(withdraw("สินค้าXYZ").status).toBe("review_required");
    expect(resolveApprovedProductName("มะม่วงจิ้ว")).toEqual({
      productCode: "ม63",
      canonicalName: "มะม่วงจิ้ว",
    });
    expect(resolveApprovedProductName("มะม่วงแก้วขมิ้น")).toEqual({
      productCode: "ม72",
      canonicalName: "มะม่วงแก้วขมิ้น",
    });
    expect(resolveApprovedProductName("มะม่วงฟ้าลั่น")).toEqual({
      productCode: "ม73",
      canonicalName: "มะม่วงฟ้าลั่น",
    });
    expect(approvedProductCode("มะม่วงจิ้ว")).not.toBe(approvedProductCode("มะม่วงแก้วขมิ้น"));
    expect(approvedProductCode("มะม่วงฟ้าลั่น")).not.toBe(approvedProductCode("มะม่วงแก้วขมิ้น"));
    expect(approvedProductCode("มะม่วงฟ้าลั่น")).not.toBe(approvedProductCode("มะม่วงจิ้ว"));
  });

  it("preserves full multiline session data and reviews only unresolved names", () => {
    const parsed = parseWeighSession([
      "ดำ-วัดตะกล่ำ เบิก 24/8/2569",
      "1.อะโวคาโด้70บาท", "3โล",
      "2.อะโวคาโด80บาท", "2โล",
      "3.ไชมัส60บาท", "1โล",
      "4.สาลี10บาท", "6ลูก",
      "5.มะม่วงจิ้ว35บาท", "2โล",
      "6.มะม่วงแก้วขมิ้น40บาท", "1โล",
      "7.ผลไม้ต่างดาว99บาท", "1โล",
      "8.มะม่วง20บาท", "1โล",
      "9.อะโวคาโด้80บาท", "4โล",
      "จบรายการเบิก",
    ].join("\n"));

    expect(parsed.items.map((entry) => entry.item_number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(parsed.items[0]).toMatchObject({
      product_name: "อะโวคาโด้",
      price_per_unit: 70,
      quantity: 3,
      unit: "โล",
    });
    expect(parsed.items[8]).toMatchObject({
      product_name: "อะโวคาโด้",
      price_per_unit: 80,
      quantity: 4,
      unit: "โล",
    });

    const result = validateProduceEntry({ parsed, roundRows: [], roundBound: true });
    expect(result.status).toBe("review_required");
    expect(vocabulary(result).map((exception) => exception.productName)).toEqual([
      "ผลไม้ต่างดาว",
      "มะม่วง",
    ]);
  });
});

describe("dictionary extension 20260827090000 — ม73 (มะม่วงฟ้าลั่น)", () => {
  it("looks up the exact canonical name and does not mark it unknown", () => {
    expect(isApprovedProductName("มะม่วงฟ้าลั่น")).toBe(true);
    expect(resolveApprovedProductName("มะม่วงฟ้าลั่น")).toEqual({
      productCode: "ม73",
      canonicalName: "มะม่วงฟ้าลั่น",
    });
    expect(withdraw("มะม่วงฟ้าลั่น").status).toBe("clean");
    expect(vocabulary(withdraw("มะม่วงฟ้าลั่น"))).toEqual([]);
  });

  it("does not alias ฟ้าลั่น or มะม่วง into ม73", () => {
    expect(resolveApprovedProductName("ฟ้าลั่น")).toBeNull();
    expect(resolveApprovedProductName("มะม่วง")).toBeNull();
    expect(withdraw("ฟ้าลั่น").status).toBe("review_required");
    expect(withdraw("มะม่วง").status).toBe("review_required");
  });

  it("parses the compact scale form มะม่วงฟ้าลั่น50บาท / 5โล", () => {
    const parsed = parseWeighSession([
      "กี้-วัดทุ่งลานนา เบิก 27/8/2569",
      "มะม่วงฟ้าลั่น50บาท",
      "5โล",
      "จบรายการเบิก",
    ].join("\n"));

    expect(parsed.parse_errors).toEqual([]);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toMatchObject({
      product_name: "มะม่วงฟ้าลั่น",
      price_per_unit: 50,
      quantity: 5,
      unit: "โล",
      transaction_type: "เบิก",
    });
    expect(validateProduceEntry({ parsed, roundRows: [], roundBound: true }).status).toBe("clean");
  });
});

describe("review digest", () => {
  it("changes when a suspicious spelling is corrected", () => {
    const before = withdraw("มะม่วงเขียวรกต").digest;
    const after = withdraw("มะม่วงเขียวมรกต").digest;
    expect(after).not.toBe(before);
  });

  it("changes when an unrelated item is added after the review was shown", () => {
    const before = withdraw("สินค้าใหม่ABC").digest;
    const after = withdraw("สินค้าใหม่ABC", "องุ่นดำ").digest;
    expect(after).not.toBe(before);
  });

  it("is stable for the same document", () => {
    expect(withdraw("สินค้าใหม่ABC").digest).toBe(withdraw("สินค้าใหม่ABC").digest);
  });
});

describe("พุทราจีน (ม74) is its own vocabulary identity", () => {
  it("is an approved name that resolves to its own code", () => {
    expect(isApprovedProductName("พุทราจีน")).toBe(true);
    expect(approvedProductCode("พุทราจีน")).toBe("ม74");
  });

  it("does not collapse into any existing jujube", () => {
    // PRODUCT_ALIASES folds business identity, not just report labels. If any
    // of these ever resolved to the same code, this product's stock and money
    // would silently merge with a different one.
    expect(approvedProductCode("พุทรา")).toBe("ม25");
    expect(approvedProductCode("พุทราไทย")).toBe("ม26");
    expect(approvedProductCode("พุทรานม")).toBe("ม27");
    expect(approvedProductCode("พุทรานมสด")).toBe("ม28");

    const codes = ["พุทราจีน", "พุทรา", "พุทราไทย", "พุทรานม", "พุทรานมสด"]
      .map((name) => approvedProductCode(name));
    expect(new Set(codes).size).toBe(5);
  });

  it("no alias was introduced that reaches พุทราจีน from a shorter form", () => {
    // A bare พุทรา must keep meaning ม25, never the new product.
    expect(resolveApprovedProductName("พุทรา")).not.toBeNull();
    expect(approvedProductCode("พุทรา")).toBe("ม25");
    expect(resolveApprovedProductName("พุทราจีน")).not.toBeNull();
    expect(approvedProductCode("พุทราจีน")).toBe("ม74");
  });

  it("parses as an ordinary withdrawal item line", () => {
    const parsed = parseWeighSession(
      ["ทดสอบ-ตลาดทดสอบ เบิก 15/8/2569", "พุทราจีน 100 บาท", "5 โล", "จบรายการเบิก"].join("\n"),
    );
    expect(parsed.parse_errors).toEqual([]);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].product_name).toBe("พุทราจีน");
    expect(approvedProductCode(parsed.items[0].product_name)).toBe("ม74");
  });

  it("resolves through its own product code on an item line", () => {
    const parsed = parseWeighSession(
      ["ทดสอบ-ตลาดทดสอบ เบิก 15/8/2569", "ม74 100 บาท", "5 โล", "จบรายการเบิก"].join("\n"),
    );
    expect(parsed.parse_errors).toEqual([]);
    expect(parsed.items[0].product_name).toBe("พุทราจีน");
  });

  it("is reachable in the dictionary exactly once", () => {
    const matches = PRODUCT_CODE_ENTRIES.filter((e) => e.canonicalName === "พุทราจีน");
    expect(matches).toHaveLength(1);
    expect(matches[0].code).toBe("ม74");
    expect(matches[0].enabled).toBe(true);
    expect(matches[0].categoryCode).toBe("ม");
  });
});

describe("dictionary extension 20260908090000 — ม75–ม80 vocabulary identities", () => {
  const NEW: Array<[string, string]> = [
    ["มันแกว", "ม75"],
    ["องุ่นไร้ออส", "ม76"],
    ["แอปเปิ้ลแคระ", "ม77"],
    ["เมล่อนกล่อง", "ม78"],
    ["องุ่นลิ้นจี่", "ม79"],
    ["องุ่นจักรพรรดิ์", "ม80"],
  ];

  it.each(NEW)("%s is an approved name resolving to its own code %s", (name, code) => {
    expect(isApprovedProductName(name)).toBe(true);
    expect(approvedProductCode(name)).toBe(code);
    expect(resolveApprovedProductName(name)).toEqual({ productCode: code, canonicalName: name });
    expect(withdraw(name).status).toBe("clean");
  });

  it("no lookalike is folded into one of the new products", () => {
    // PRODUCT_ALIASES folds business identity, not just report labels, so a
    // wrong fold here would merge a product's stock and money with a different
    // one. Each near-neighbour must keep its own distinct code.
    expect(approvedProductCode("แอปเปิ้ล")).toBe("ม62");
    expect(approvedProductCode("องุ่นไร้เม็ด")).toBe("ม58");
    expect(approvedProductCode("ลิ้นจี่")).toBe("ม71");

    expect(approvedProductCode("แอปเปิ้ลแคระ")).not.toBe(approvedProductCode("แอปเปิ้ล"));
    expect(approvedProductCode("องุ่นไร้ออส")).not.toBe(approvedProductCode("องุ่นไร้เม็ด"));
    expect(approvedProductCode("องุ่นลิ้นจี่")).not.toBe(approvedProductCode("ลิ้นจี่"));

    const codes = [
      "มันแกว", "องุ่นไร้ออส", "แอปเปิ้ลแคระ", "เมล่อนกล่อง", "องุ่นลิ้นจี่", "องุ่นจักรพรรดิ์",
      "แอปเปิ้ล", "องุ่นไร้เม็ด", "ลิ้นจี่",
    ].map((name) => approvedProductCode(name));
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("no shorter form reaches the new products through an alias", () => {
    // A bare แอปเปิ้ล must keep meaning ม62, องุ่น must never resolve at all.
    expect(approvedProductCode("แอปเปิ้ล")).toBe("ม62");
    expect(resolveApprovedProductName("แคระ")).toBeNull();
    expect(resolveApprovedProductName("องุ่น")).toBeNull();
    expect(resolveApprovedProductName("เมล่อน")).toBeNull();
  });

  it("องุ่นคินสัน is a confirmed typo of ม68 องุ่นคิมสัน, not a new identity", () => {
    expect(resolveApprovedProductName("องุ่นคินสัน")).toEqual({
      productCode: "ม68",
      canonicalName: "องุ่นคิมสัน",
    });
    expect(approvedProductCode("องุ่นคินสัน")).toBe("ม68");
    expect(withdraw("องุ่นคินสัน").status).toBe("clean");
    // It resolves to an existing code, never mints a new one.
    expect(PRODUCT_CODE_ENTRIES.filter((e) => e.canonicalName === "องุ่นคินสัน")).toHaveLength(0);
  });
});
