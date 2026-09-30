import { describe, expect, test } from "bun:test";
import {
  REVIEWED_MARKET_ALIASES,
  canonicalMarketLabel,
  cleanMarketName,
  isIdentifiedMarket,
  normalizedMarketLabel,
} from "./market";

describe("cleanMarketName", () => {
  test("extracts ตลาดกี้ from staff-prefixed session header", () => {
    expect(cleanMarketName("\u0E01\u0E35\u0E49 \u0E15\u0E25\u0E32\u0E14\u0E01\u0E35\u0E49 \u0E0A\u0E31\u0E48\u0E07\u0E04\u0E37\u0E19 23/06/2569")).toBe(
      "\u0E15\u0E25\u0E32\u0E14\u0E01\u0E35\u0E49",
    );
  });

  test("extracts ตลาด72 from dash and post-tx headers", () => {
    expect(cleanMarketName("\u0E01\u0E35\u0E49-\u0E15\u0E25\u0E32\u0E1472 \u0E40\u0E1A\u0E34\u0E01 1/6/2569")).toBe(
      "\u0E15\u0E25\u0E32\u0E1472",
    );
    expect(cleanMarketName("\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23\u0E0A\u0E31\u0E48\u0E07\u0E40\u0E1A\u0E34\u0E01\u0E44\u0E1B\u0E15\u0E25\u0E32\u0E1472")).toBe(
      "\u0E15\u0E25\u0E32\u0E1472",
    );
  });

  test("keeps named markets without ตลาด prefix", () => {
    expect(cleanMarketName("\u0E15\u0E49\u0E2D\u0E21-\u0E1E\u0E32\u0E0B\u0E34\u0E42\u0E2D\u0E49\u0E1C\u0E31\u0E01 \u0E0A\u0E31\u0E48\u0E07\u0E04\u0E37\u0E19 30/06/2569")).toBe(
      "\u0E1E\u0E32\u0E0B\u0E34\u0E42\u0E2D\u0E49\u0E1C\u0E31\u0E01",
    );
    expect(cleanMarketName("\u0E15\u0E25\u0E32\u0E1480")).toBe("\u0E15\u0E25\u0E32\u0E1480");
  });

  test("returns null for transaction-only session titles", () => {
    expect(cleanMarketName("\u0E0A\u0E31\u0E48\u0E07\u0E04\u0E37\u0E19")).toBeNull();
    expect(cleanMarketName("\u0E0A\u0E48\u0E32\u0E07\u0E04\u0E37\u0E19\u0E27\u0E31\u0E19\u0E17\u0E35\u0E48 23 \u0E21\u0E34\u0E16\u0E38\u0E19\u0E32 2569")).toBeNull();
    expect(cleanMarketName("\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23\u0E0A\u0E31\u0E48\u0E07\u0E40\u0E1A\u0E34\u0E01")).toBeNull();
    expect(cleanMarketName("\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23\u0E40\u0E1A\u0E34\u0E01\u0E1C\u0E31\u0E01")).toBeNull();
    expect(cleanMarketName("\u0E40\u0E1A\u0E34\u0E01")).toBeNull();
    expect(cleanMarketName("\u0E04\u0E37\u0E1923/6/69")).toBeNull();
    expect(cleanMarketName("\u0E04\u0E37\u0E19\u0E1C\u0E31\u0E01")).toBeNull();
    expect(cleanMarketName("\u0E04\u0E37\u0E19\u0E1C\u0E31\u0E0123/6/69")).toBeNull();
  });
});

describe("isIdentifiedMarket", () => {
  test("matches cleanMarketName nullability", () => {
    expect(isIdentifiedMarket("\u0E01\u0E35\u0E49 \u0E15\u0E25\u0E32\u0E14\u0E01\u0E35\u0E49 \u0E0A\u0E31\u0E48\u0E07\u0E04\u0E37\u0E19 23/06/2569")).toBe(true);
    expect(isIdentifiedMarket("\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23\u0E0A\u0E31\u0E48\u0E07\u0E40\u0E1A\u0E34\u0E01")).toBe(false);
  });
});

describe("normalizedMarketLabel", () => {
  test("trims and NFC-folds without inventing ตลาด prefix", () => {
    expect(normalizedMarketLabel("  ตลาดกี้  ")).toBe("ตลาดกี้");
    expect(normalizedMarketLabel("กี้")).toBe("กี้");
    expect(normalizedMarketLabel("กี้")).not.toBe(normalizedMarketLabel("ตลาดกี้"));
  });
});

describe("canonicalMarketLabel", () => {
  // CASE B — a canonical market is its own identity and stays untouched.
  test("canonical market labels pass through unchanged", () => {
    for (const label of ["พาซิโอ้", "วัดทุ่งลานนา", "พาซิโอ้ผัก", "ราชพฤกษ์"]) {
      expect(canonicalMarketLabel(label)).toBe(label);
    }
  });

  // CASE A — the reviewed aliases behind the 2026-08-14 ต้อม incident.
  test("reviewed aliases resolve to the canonical market", () => {
    expect(canonicalMarketLabel("พาซีโอ้")).toBe("พาซิโอ้");
    expect(canonicalMarketLabel("พาสิโอ้")).toBe("พาซิโอ้");
  });

  test("the existing 0055 aliases keep resolving", () => {
    expect(canonicalMarketLabel("ทุ่งลานนา")).toBe("วัดทุ่งลานนา");
    expect(canonicalMarketLabel("ราชพฤก")).toBe("ราชพฤกษ์");
    expect(canonicalMarketLabel("ตลาด72")).toBe("เฉลิมฯ72");
  });

  test("whitespace and NFC differences normalize before the alias lookup", () => {
    expect(canonicalMarketLabel("  พาซีโอ้  ")).toBe("พาซิโอ้");
    expect(canonicalMarketLabel("พาซีโอ้".normalize("NFD"))).toBe("พาซิโอ้");
    expect(canonicalMarketLabel("ทุ่ง  ลานนา")).not.toBe("วัดทุ่งลานนา");
  });

  // CASE C — the guard against silent merging. An unreviewed label keeps its own
  // identity no matter how close it looks; only a human may promote it.
  test("unrelated and unreviewed market names never collapse", () => {
    expect(canonicalMarketLabel("พาซีโX")).toBe("พาซีโX");
    expect(canonicalMarketLabel("พาซีโX")).not.toBe(canonicalMarketLabel("พาซิโอ้"));
    expect(canonicalMarketLabel("พาซิโอ้ผัก")).not.toBe(canonicalMarketLabel("พาซิโอ้ผลไม้"));
    expect(canonicalMarketLabel("พาซิโอ้")).not.toBe(canonicalMarketLabel("พาซิโอ้ผัก"));
    expect(canonicalMarketLabel("วิหาร")).not.toBe(canonicalMarketLabel("รถเร่"));
  });

  test("20260930 — contiguous vegetable-market spellings resolve to พาซิโอ้ผัก", () => {
    expect(canonicalMarketLabel("พาซีโอ้ผัก")).toBe("พาซิโอ้ผัก");
    expect(canonicalMarketLabel("พาสิโอ้ผัก")).toBe("พาซิโอ้ผัก");
    expect(canonicalMarketLabel("ตลาดพาซิโอ้ผัก")).toBe("พาซิโอ้ผัก");
    expect(canonicalMarketLabel("เบิก พาซีโอ้ผัก 30/9/69")).toBe("พาซิโอ้ผัก");
    // Context-unsafe: "พาซิโอ้ เบิกผัก" is a general พาซิโอ้ withdrawal title.
    expect(canonicalMarketLabel("พาซิโอ้ เบิกผัก")).not.toBe("พาซิโอ้ผัก");
    expect(canonicalMarketLabel("พาซิโอ้ ผัก")).not.toBe("พาซิโอ้ผัก");
    expect(canonicalMarketLabel("พาซีโอ้")).toBe("พาซิโอ้");
  });

  test("an unidentifiable title has no market identity", () => {
    expect(canonicalMarketLabel("ชั่งคืน")).toBe("");
    expect(canonicalMarketLabel(null)).toBe("");
  });

  test("every alias points at a market and never at another alias", () => {
    for (const [alias, canonical] of Object.entries(REVIEWED_MARKET_ALIASES)) {
      expect(REVIEWED_MARKET_ALIASES[canonical]).toBeUndefined();
      expect(alias).not.toBe(canonical);
    }
  });
});
