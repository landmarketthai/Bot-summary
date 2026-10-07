import { describe, expect, it } from "bun:test";
import {
  parseWeighSession,
  getWeighSessionFinalizationErrors,
  ADDITIONAL_TYPE_MAP,
} from "./parser";
import { RE } from "./regex";
import { computeSessionHash } from "@/lib/line/session-dedup-service";

const ITEM_BLOCK = ["1.ทุเรียน100บาท", "2โล"];

function block(header: string, closer: string, items: string[] = ITEM_BLOCK): string {
  return [header, ...items, closer].join("\n");
}

describe("additional-batch command grammar", () => {
  it.each([
    ["เบิกเพิ่ม", "เบิก"],
    ["ชั่งคืนเพิ่ม", "คืน"],
    ["คืนเสียเพิ่ม", "คืนเสีย"],
  ])("opener %s maps items to base type %s", (opener, base) => {
    const parsed = parseWeighSession(
      block(`กี้-คลองเตย ${opener} 12/7/2569`, `จบรายการ${opener}`),
    );

    expect(parsed.session_kind).toBe("additional");
    expect(parsed.declared_transaction_type).toBe(base as never);
    expect(parsed.staff_name).toBe("กี้");
    expect(parsed.session_title).toBe("คลองเตย");
    expect(parsed.date).toBe("2026-07-12");
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].transaction_type).toBe(base as never);
    expect(parsed.parse_errors).toHaveLength(0);
    expect(getWeighSessionFinalizationErrors(parsed)).toHaveLength(0);
  });

  it("accepts the expected-count closer variant", () => {
    const parsed = parseWeighSession(
      block("กี้-คลองเตย เบิกเพิ่ม 12/7/2569", "จบรายการเบิกเพิ่ม 1 รายการ"),
    );
    expect(parsed.parse_errors).toHaveLength(0);
    expect(RE.ADDITIONAL_END.exec("จบรายการชั่งคืนเพิ่ม 5 รายการ")?.[2]).toBe("5");
    expect(RE.ADDITIONAL_END.exec("จบรายการคืนเสียเพิ่ม 12 รายการ")?.[2]).toBe("12");
  });

  it("requires full anchored matching for openers", () => {
    // Trailing junk after the date: not an additional opener. Falls back to
    // the legacy SELLER_MARKET path → main session with เบิกเพิ่ม items.
    const trailing = parseWeighSession(
      block("กี้-คลองเตย เบิกเพิ่ม 12/7/2569 ขอบคุณ", "จบรายการ"),
    );
    expect(trailing.session_kind).toBe("main");
    expect(trailing.items[0].transaction_type).toBe("เบิกเพิ่ม");

    // Missing date: legacy behavior preserved, not an additional session.
    const noDate = parseWeighSession(
      block("กี้-คลองเตย เบิกเพิ่ม", "จบรายการ"), "2026-07-12",
    );
    expect(noDate.session_kind).toBe("main");
    expect(noDate.items[0].transaction_type).toBe("เบิกเพิ่ม");
  });

  it("rejects a wrong closer type", () => {
    const parsed = parseWeighSession(
      block("กี้-คลองเตย เบิกเพิ่ม 12/7/2569", "จบรายการชั่งคืนเพิ่ม"),
    );
    expect(parsed.parse_errors.some((e) => e.includes("wrong closer"))).toBe(true);
  });

  it("rejects a plain จบรายการ closer for an additional session", () => {
    const parsed = parseWeighSession(
      block("กี้-คลองเตย เบิกเพิ่ม 12/7/2569", "จบรายการ"),
    );
    expect(parsed.parse_errors.some((e) => e.includes("wrong closer"))).toBe(true);
  });

  it("rejects an unanchored closer with trailing text", () => {
    const parsed = parseWeighSession(
      block("กี้-คลองเตย เบิกเพิ่ม 12/7/2569", "จบรายการเบิกเพิ่มนะ"),
    );
    expect(parsed.parse_errors.some((e) => e.includes("wrong closer"))).toBe(true);
  });

  it("rejects an additional closer on a main session", () => {
    const parsed = parseWeighSession(
      block("กี้-คลองเตย เบิก 12/7/2569", "จบรายการเบิกเพิ่ม"),
    );
    expect(parsed.session_kind).toBe("main");
    expect(parsed.parse_errors.some((e) =>
      e.includes("additional closer without an additional header"))).toBe(true);
  });

  it("rejects mixed section changes inside an additional session", () => {
    const parsed = parseWeighSession([
      "กี้-คลองเตย เบิกเพิ่ม 12/7/2569",
      "1.ทุเรียน100บาท",
      "2โล",
      "คืนเสีย",
      "2.มังคุด50บาท",
      "1โล",
      "จบรายการเบิกเพิ่ม",
    ].join("\n"));
    expect(parsed.parse_errors.some((e) =>
      e.includes("section change not allowed"))).toBe(true);
  });

  it("renumbers duplicate item numbers in an additional session instead of refusing it", () => {
    const parsed = parseWeighSession([
      "กี้-คลองเตย เบิกเพิ่ม 12/7/2569",
      "1.ทุเรียน100บาท",
      "2โล",
      "1.มังคุด50บาท",
      "1โล",
      "จบรายการเบิกเพิ่ม",
    ].join("\n"));
    expect(getWeighSessionFinalizationErrors(parsed)).toEqual([]);
    expect(parsed.items.map((i) => [i.item_number, i.original_item_number])).toEqual([[1, undefined], [2, 1]]);
  });

  it("never falls back to the event business date for an additional session", () => {
    // Header date always wins; there is no fallback path because the opener
    // regex requires an explicit date to classify as additional at all.
    const parsed = parseWeighSession(
      block("กี้-คลองเตย เบิกเพิ่ม 12/7/2569", "จบรายการเบิกเพิ่ม"),
      "2026-01-01",
    );
    expect(parsed.date).toBe("2026-07-12");
  });

  it("supports basis pricing and universal units in additions", () => {
    const parsed = parseWeighSession([
      "กี้-คลองเตย เบิกเพิ่ม 12/7/2569",
      "1.ผักกาดขาว3หัว20บาท",
      "9หัว",
      "2.กล้วย50บาท",
      "1เครือ",
      "จบรายการเบิกเพิ่ม",
    ].join("\n"));

    expect(parsed.parse_errors).toHaveLength(0);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0].pricing_mode).toBe("basis");
    expect(parsed.items[0].basis_quantity).toBe(3);
    expect(parsed.items[0].basis_price).toBe(20);
    expect(parsed.items[0].transaction_type).toBe("เบิก");
    expect(parsed.items[1].unit).toBe("เครือ");
    expect(parsed.items[1].transaction_type).toBe("เบิก");
  });

  it("keeps legacy main sessions unchanged (in-session เบิกเพิ่ม marker rows)", () => {
    const parsed = parseWeighSession([
      "กี้-คลองเตย เบิก 12/7/2569",
      "1.ทุเรียน100บาท",
      "2โล",
      "เบิกเพิ่ม",
      "2.มังคุด50บาท",
      "1โล",
      "จบรายการเบิก",
    ].join("\n"));

    expect(parsed.session_kind).toBe("main");
    expect(parsed.declared_transaction_type).toBeNull();
    expect(parsed.items.map((i) => i.transaction_type)).toEqual(["เบิก", "เบิกเพิ่ม"]);
    expect(parsed.parse_errors).toHaveLength(0);
  });

  it("keeps the content hash identical for identical additional content", () => {
    // The content hash stays a pure audit fingerprint — idempotency comes from
    // the generation identity, so identical intentional batches hash the same.
    const text = block("กี้-คลองเตย เบิกเพิ่ม 12/7/2569", "จบรายการเบิกเพิ่ม");
    expect(computeSessionHash(parseWeighSession(text)))
      .toBe(computeSessionHash(parseWeighSession(text)));
  });

  it("exposes the full opener → base type map", () => {
    expect(ADDITIONAL_TYPE_MAP).toEqual({
      "เบิกเพิ่ม": "เบิก",
      "ชั่งคืนเพิ่ม": "คืน",
      "คืนเสียเพิ่ม": "คืนเสีย",
    });
  });
});
