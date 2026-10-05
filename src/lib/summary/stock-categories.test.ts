import { describe, expect, test } from "bun:test";
import { stockCategoryFor, stockCategoryEntries } from "./stock-categories";
import { normalizeProductName } from "./remaining-fruit";

describe("stockCategoryFor", () => {
  test("maps durian varieties", () => {
    for (const name of ["หมอนทอง", "ก้านยาว", "ชะนี", "พวงมณี", "กระดุม", "หลงลับแล", "มูซังคิง"]) {
      expect(stockCategoryFor(name)).toBe("ทุเรียน");
    }
  });

  test("maps compound durian forms through the ทุเรียน marker", () => {
    for (const name of ["ทุเรียน", "ทุเรียนกล่อง", "ทุเรียนแกะ", "ทุเรียนหมอนทอง"]) {
      expect(stockCategoryFor(name)).toBe("ทุเรียน");
    }
  });

  test("ทุเรียนเทศ is soursop, not durian", () => {
    expect(stockCategoryFor("ทุเรียนเทศ")).toBe("ผลไม้");
  });

  test("maps fruit", () => {
    for (const name of ["มหาชนก", "กระท้อน", "แตงโม", "ลูกพลับ", "แก้วมังกร", "สับปะรด", "อะโวคาโด"]) {
      expect(stockCategoryFor(name)).toBe("ผลไม้");
    }
  });

  test("maps vegetables", () => {
    for (const name of ["กระชาย", "กะเพรา", "ผักชี", "ต้นหอม", "ถั่วพู", "กะหล่ำปี", "ใบมังลัก"]) {
      expect(stockCategoryFor(name)).toBe("ผัก");
    }
  });

  test("maps องุ่น varietals seen in production", () => {
    for (const name of [
      "องุ่นเขียว", "องุ่นแดง", "องุ่นดำ", "องุ่นไข่ปลา",
      "องุ่นไซมัส", "องุ่นไชมัส", "องุ่นรวม", "องุ่นรวมแดงดำ",
      "องุ่นแม่มด", "เขียวมรกต",
    ]) {
      expect(stockCategoryFor(name)).toBe("ผลไม้");
    }
  });

  test("maps pear, orange and avocado forms seen in production", () => {
    for (const name of ["สาลี่", "สาลี่หอม", "สาลีหอม", "ส้มไต้หวัน", "อะโว"]) {
      expect(stockCategoryFor(name)).toBe("ผลไม้");
    }
  });

  test("หมอนแตก is a durian grade", () => {
    expect(stockCategoryFor("หมอนแตก")).toBe("ทุเรียน");
  });

  test("classification never implies canonical merging", () => {
    // Both spellings are fruit, but they must remain DISTINCT products until a
    // human approves an alias. Categorizing must not be mistaken for merging.
    const pairs: Array<[string, string]> = [
      ["องุ่นไชมัส", "องุ่นไซมัส"],
      ["สาลีหอม", "สาลี่หอม"],
      ["อะโว", "อะโวคาโด"],
      ["องุ่นรวม", "องุ่นรวมแดงดำ"],
      ["หมอนแตก", "หมอนทอง"],
    ];
    for (const [a, b] of pairs) {
      expect(stockCategoryFor(a)).toBe(stockCategoryFor(b));
      expect(normalizeProductName(a)).not.toBe(normalizeProductName(b));
    }
  });

  test("maps vegetable forms observed in production", () => {
    for (const name of [
      "กวางตุ้งจิ้ว", "กวางตุ้งยี่ปุ่น", "กวางตุ้งดอกเหลือง", "กวางตุ้งไทย",
      "บอคโครี่", "ดอกกะหล่ำ", "กะกล่ำปี",
      "ผักบุ้งจีน", "ผักบุ้งไทย", "ผักชีไทย", "ผักชีใบเลื่อย",
      "ผักกาดลุ้ย", "ผักกาดลู้ย", "ผักกาดดอง", "สลัดคอตนิ่ม",
      "คน้าเลก", "คน้าเล็ก", "คน้าไหย่", "คน้าฮ้องกง",
      "กระเพา", "กระเพาแดง", "ใบโหระพา", "ใบตั้งโอ้", "สาระแหน",
      "ใบกระเจียบ", "ฝักกระเจียบ",
      "กระเทียมหัว", "กระเทียมกลีบใหย่",
      "หอมแขกเลก", "หอมแขกเล็ก", "หอมแขกใหย่", "หอมหัวใหย่",
      "ขิงแก่", "ขิงออ่น", "พริกสด", "พริกแห้ง", "พริกป่น",
      "มะเขือเทสเลก", "มะเขือเทสเล็ก", "มะเขือเทสใหย่", "มะเขือเปาะ", "มะเขือเหลือง",
      "มะระขี้นก", "มะระลูก", "แตงกวาเล็ก", "ฟักออ่น", "บวบเหลี่ยม",
      "นำเต้า", "ถั่วแขก", "ข้าวโพดออ่น", "ไชยท้าว",
      "หน่อไม้ดอง", "หน่อไม้ต้ม",
      "เหดแพค", "เห็ดแพครวม", "เหดออริจิ",
    ]) {
      expect(stockCategoryFor(name)).toBe("ผัก");
    }
  });

  test("vegetable size and spelling variants stay separate canonical products", () => {
    // All four are ผัก, but คะน้า grades are distinct products and must not merge.
    const variants = ["คน้าเลก", "คน้าเล็ก", "คน้าไหย่", "คน้าฮ้องกง"];
    for (const name of variants) expect(stockCategoryFor(name)).toBe("ผัก");
    expect(new Set(variants.map((n) => normalizeProductName(n))).size).toBe(variants.length);

    for (const [a, b] of [
      ["มะเขือเทสเลก", "มะเขือเทสเล็ก"],
      ["หอมแขกเลก", "หอมแขกเล็ก"],
      ["กระเพา", "กระเพาแดง"],
    ] as Array<[string, string]>) {
      expect(stockCategoryFor(a)).toBe(stockCategoryFor(b));
      expect(normalizeProductName(a)).not.toBe(normalizeProductName(b));
    }
    // 2026-10-05: ผักกาดลู้ย is a confirmed exact typo (same unit หัว, same price).
    expect(normalizeProductName("ผักกาดลู้ย")).toBe("ผักกาดลุ้ย");
  });

  test("non-produce items are left uncategorized rather than forced into ผัก", () => {
    for (const name of [
      "ปลาทูนึ่ง", "ขนมจีน", "ข้าวคั่ว", "เครื่องต้มยำ", "เครื่องผัดฉ่า", "มะขามเปียก",
    ]) {
      expect(stockCategoryFor(name)).toBe("ไม่จัดหมวด");
    }
  });

  test("fruit shorthand is untouched by the vegetable pass", () => {
    for (const name of ["ไข่ปลา", "แม่มด", "ไซมัส"]) {
      expect(stockCategoryFor(name)).toBe("ไม่จัดหมวด");
    }
  });

  test("unknown products stay visible as ไม่จัดหมวด", () => {
    expect(stockCategoryFor("ของแปลกใหม่ไม่เคยเจอ")).toBe("ไม่จัดหมวด");
    expect(stockCategoryFor("")).toBe("ไม่จัดหมวด");
    expect(stockCategoryFor("   ")).toBe("ไม่จัดหมวด");
  });

  test("similar-looking names are not guessed into a category", () => {
    // Only exact canonical names (plus the durian marker) are mapped. A
    // misspelling that has no alias must surface as uncategorized rather than
    // being silently filed under a category it merely resembles.
    expect(stockCategoryFor("แตงโมมม")).toBe("ไม่จัดหมวด");
    expect(stockCategoryFor("กระชายย")).toBe("ไม่จัดหมวด");
  });

  test("mapping is normalized and free of duplicate keys", () => {
    const entries = stockCategoryEntries();
    const keys = entries.map(([name]) => name);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(key).toBe(key.normalize("NFC").trim());
      expect(key.length).toBeGreaterThan(0);
    }
  });
});
