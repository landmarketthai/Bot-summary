import { describe, expect, it } from "bun:test";
import { normalizeProductName, PRODUCT_ALIASES } from "@/lib/summary/remaining-fruit";
import {
  approvedProductCode,
  canonicalProduceProductIdentity,
  isApprovedProductName,
} from "./product-vocabulary";
import { PRODUCT_CODE_ENTRIES } from "./product-code/dictionary";

// 2026-10-05 Production alias audit. canonicalProduceProductIdentity is the
// ingestion path: the weigh-session parser persists its result as
// produce_items.product_name.
const ingest = (name: string) => canonicalProduceProductIdentity(name, null);

describe("2026-10-05 alias audit — typos fold into their canonical identity at ingestion", () => {
  const CASES: Array<[string, string]> = [
    ["สัปปรถ", "สับปะรด"],
    ["สัปรด", "สับปะรด"],
    ["สัปปะรด", "สับปะรด"],
    ["สัปแรถ", "สับปะรด"],
    ["ส้ปรด", "สับปะรด"],
    ["อโวคาโด้", "อะโวคาโด"],
    ["อะโวคาโด้", "อะโวคาโด"],
    ["อะโวอาโด้", "อะโวคาโด"],
    ["อโวคาโด", "อะโวคาโด"],
    ["อาโวคาโด", "อะโวคาโด"],
    ["อาโวคาโด้", "อะโวคาโด"],
    ["อินทผารัม", "อินทผาลัม"],
    ["อินมผารัม", "อินทผาลัม"],
    ["อินทผาลัท", "อินทผาลัม"],
    ["อนทผารัม", "อินทผาลัม"],
    ["ไชมัส", "ไซมัส"],
    ["องุ่นคินสัน", "องุ่นคิมสัน"],
    ["หอมหัวใหย่", "หอมหัวใหญ่"],
    ["หอมหัวไหย่", "หอมหัวใหญ่"],
    ["หอมใหย่", "หอมหัวใหญ่"],
    ["หอมไหย่", "หอมหัวใหญ่"],
    ["หอมใหญ่", "หอมหัวใหญ่"],
    ["กระเทียมกลีบใหย่", "กระเทียมกลีบใหญ่"],
    ["กระเทียมกลีบไหย่", "กระเทียมกลีบใหญ่"],
    ["กระเทียมกลีบเลก", "กระเทียมกลีบเล็ก"],
    ["กวางตุ้งยี่ปุ่น", "กวางตุ้งญี่ปุ่น"],
    ["กวางตุ้งยึ่ปุ่น", "กวางตุ้งญี่ปุ่น"],
    ["กวางตุ้งญี่ปุ่นปุ่น", "กวางตุ้งญี่ปุ่น"],
    ["มะเขือเทสเล็ก", "มะเขือเทศเล็ก"],
    ["มะเขือเทสเล๋ก", "มะเขือเทศเล็ก"],
    ["มะเขือเทสใหญ่", "มะเขือเทศใหญ่"],
    ["มะเขือเทสไหย่", "มะเขือเทศใหญ่"],
    ["ถั่วพลู", "ถั่วพู"],
    ["ถั่วพํ", "ถั่วพู"],
    ["ผักบุ่งจีน", "ผักบุ้งจีน"],
    ["ผักกาดลู้ย", "ผักกาดลุ้ย"],
    ["ผักปรัง", "ผักปลัง"],
    ["ใบกระเพรา", "ใบกะเพรา"],
    ["ใบกระเพราขาว", "ใบกะเพราขาว"],
    ["กระเพราขาว", "ใบกะเพราขาว"],
    ["ใบกระเพราแดง", "ใบกะเพราแดง"],
    ["ผักสลัดคอตใบแข็ง", "สลัดคอตใบแข็ง"],
    ["ลูกมะอึ", "ลูกมะอึก"],
    ["มะอึก", "ลูกมะอึก"],
  ];

  it.each(CASES)("%s → %s", (raw, canonical) => {
    expect(ingest(raw)).toBe(canonical);
  });

  it.each(CASES.filter(([, canonical]) => canonical !== "อินทผาลัม"))(
    "%s resolves to the dictionary code of %s, so it needs no vocabulary review",
    (raw, canonical) => {
      // entry-validation checks isApprovedProductName(canonicalProduceProductIdentity(...)).
      expect(approvedProductCode(ingest(raw))).not.toBeNull();
      expect(approvedProductCode(ingest(raw))).toBe(approvedProductCode(canonical));
    },
  );

  it("the เพิ่ม prefix composes with the new aliases", () => {
    expect(normalizeProductName("เพิ่มหอมหัวใหย่")).toBe("หอมหัวใหญ่");
    expect(normalizeProductName("เพิ่มมะเขือเทสไหย่")).toBe("มะเขือเทศใหญ่");
  });
});

describe("2026-10-05 alias audit — uncertain names stay as typed", () => {
  it("กระเทียมใหญ่ / ไหย่ / เล็ก / เลก are not folded into a กลีบ product", () => {
    for (const name of ["กระเทียมใหญ่", "กระเทียมไหย่", "กระเทียมเล็ก", "กระเทียมเลก"]) {
      expect(ingest(name)).toBe(name);
      expect(normalizeProductName(name)).toBe(name);
    }
  });

  it("องุ่นไซมัส / องุ่นไชมัส / ไซมัสคัส are not merged with ไซมัส without a mapping", () => {
    for (const name of ["องุ่นไซมัส", "องุ่นไชมัส", "ไซมัสคัส"]) {
      expect(ingest(name)).toBe(name);
      expect(normalizeProductName(name)).not.toBe("ไซมัส");
    }
  });

  it("ผักกาดหอมสลัด is not folded into ผักกาดสลัด until confirmed", () => {
    expect(ingest("ผักกาดหอมสลัด")).toBe("ผักกาดหอมสลัด");
  });
});

describe("2026-10-05 alias audit — distinct products keep distinct identities", () => {
  const DISTINCT: Array<[string, string]> = [
    ["มะเขือยาวเขียว", "ผ124"],
    ["มะเขือยาวม่วง", "ผ76"],
    ["มะเขือยาว", "ผ75"],
    ["หน่อไม้ต้มเหลืองกลม", "ผ146"],
    ["หน่อไม้ต้มเหลืองซอย", "ผ147"],
    ["หน่อไม้ต้มกลม", "ผ120"],
    ["หน่อไม้ต้มซอย", "ผ121"],
    ["หน่อไม้ต้มเปลือก", "ผ141"],
    ["หน่อไม้ต้ม", "ผ86"],
    ["ใบกะเพรา", "ผ96"],
    ["ใบกะเพราขาว", "ผ127"],
    ["ใบกะเพราแดง", "ผ148"],
    ["สลัดคอต", "ผ66"],
    ["สลัดคอตนิ่ม", "ผ128"],
    ["สลัดคอตใบแข็ง", "ผ144"],
    ["ผักโป้ยเล่ง", "ผ143"],
    ["ลูกมะอึก", "ผ145"],
    ["เห็ดเข็มทอง", "ห06"],
    ["ผักแขยง", "ผ56"],
    ["ผักแพว", "ผ126"],
    ["พริกกะเหรี่ยง", "ผ107"],
  ];

  it.each(DISTINCT)("%s is its own canonical identity (%s)", (name, code) => {
    expect(ingest(name)).toBe(name);
    expect(normalizeProductName(name)).toBe(name);
    expect(approvedProductCode(name)).toBe(code);
    expect(isApprovedProductName(name)).toBe(true);
  });

  it("no two of them share a code", () => {
    const codes = DISTINCT.map(([name]) => approvedProductCode(name));
    expect(new Set(codes).size).toBe(DISTINCT.length);
  });
});

describe("PRODUCT_ALIASES invariants", () => {
  const names = [...new Set([...Object.keys(PRODUCT_ALIASES), ...Object.values(PRODUCT_ALIASES)])];

  it("normalization is idempotent for every alias key and target", () => {
    for (const name of names) {
      const once = normalizeProductName(name);
      expect(normalizeProductName(once)).toBe(once);
      const ingested = ingest(name);
      expect(ingest(ingested)).toBe(ingested);
    }
  });

  it("no alias rewrites another product's dictionary canonical name", () => {
    // Legacy entries predating this rule; each is a reviewed same-product fold.
    const LEGACY = new Set(["หมอน", "อินทผลัม"]);
    const canonical = new Set(PRODUCT_CODE_ENTRIES.filter((e) => e.enabled).map((e) => e.canonicalName));
    const offenders = Object.entries(PRODUCT_ALIASES)
      .filter(([from, to]) => from !== to && canonical.has(from) && !LEGACY.has(from))
      .map(([from]) => from);
    expect(offenders).toEqual([]);
  });
});
