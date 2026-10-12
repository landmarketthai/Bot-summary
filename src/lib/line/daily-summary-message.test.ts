import { describe, expect, it } from "bun:test";
import type { CategoryLedgerEntry } from "@/lib/summary/produce-category-totals";
import { LINE_MESSAGE_MAX_CODE_POINTS } from "@/lib/summary/line-chunking";
import {
  buildDailySummaryMessage,
  dailySummaryCategoryLedgerKey,
  type DailySummaryMessageRow,
} from "./daily-summary-message";

describe("buildDailySummaryMessage", () => {
  it("builds end-of-day summary with net sales", () => {
    const result = buildDailySummaryMessage("2026-06-01", [
      {
        summary_date: "2026-06-01",
        staff_name: "กี้",
        market_name: "กี้-ตลาด72 เบิก 1/6/2569",
        borrow_total: 14446.2,
        return_total: 2300,
        bad_return_total: 500,
        net_sales: 11646.2,
        transaction_count: 19,
      },
    ]);

    expect(result).toContain("สรุปยอดประจำวันที่ 1 มิถุนายน 2569");
    expect(result).toContain("กี้ — ตลาด72");
    expect(result).toContain("เบิกรวม: 14,446.20 บาท");
    expect(result).toContain("คืนรวม: 2,300.00 บาท");
    expect(result).toContain("คืนเสียรวม: 500.00 บาท");
    expect(result).toContain("ยอดส่ง: 11,646.20 บาท");
  });

  it("supports multiple staff/market rows", () => {
    const result = buildDailySummaryMessage("2026-06-01", [
      {
        summary_date: "2026-06-01",
        staff_name: "กี้",
        market_name: "ตลาด72",
        borrow_total: 1000,
        return_total: 100,
        bad_return_total: 50,
        net_sales: 850,
        transaction_count: 3,
      },
      {
        summary_date: "2026-06-01",
        staff_name: "พี่ดำ",
        market_name: "ตลาด80",
        borrow_total: 2000,
        return_total: 0,
        bad_return_total: 0,
        net_sales: 2000,
        transaction_count: 4,
      },
    ]);

    expect(result).toContain("กี้ — ตลาด72");
    expect(result).toContain("ยอดส่ง: 850.00 บาท");
    expect(result).toContain("พี่ดำ — ตลาด80");
    expect(result).toContain("ยอดส่ง: 2,000.00 บาท");
  });

  describe("with category ledgers", () => {
    const row: DailySummaryMessageRow = {
      summary_date: "2026-08-17",
      staff_name: "มิ้น",
      market_name: "ทรัพย์พัน",
      borrow_total: 14000,
      return_total: 3400,
      bad_return_total: 600,
      net_sales: 10000,
      transaction_count: 5,
    };

    const durianEntry: CategoryLedgerEntry = {
      id: "ท",
      label: "ทุเรียน",
      heading: "🥭 ทุเรียน",
      withdrawnSatang: 500_000,
      goodReturnSatang: 120_000,
      badReturnSatang: 30_000,
      netSatang: 350_000,
    };

    function ledgers(entries: CategoryLedgerEntry[]): Map<string, CategoryLedgerEntry[]> {
      return new Map([[dailySummaryCategoryLedgerKey(row.staff_name, row.market_name), entries]]);
    }

    it("renders category headings, per-category money, and the grand-total section", () => {
      const result = buildDailySummaryMessage("2026-08-17", [row], ledgers([durianEntry]));

      expect(result).toContain("📊 สรุปยอด มิ้น — ทรัพย์พัน");
      expect(result).toContain("17/8/2569");
      expect(result).toContain("🥭 ทุเรียน");
      expect(result).toContain("เบิก 5,000.00 บาท");
      expect(result).toContain("ชั่งคืน 1,200.00 บาท");
      expect(result).toContain("คืนเสีย 300.00 บาท");
      expect(result).toContain("ขาย 3,500.00 บาท");
      expect(result).toContain("💰 รวมทั้งหมด");
      expect(result).toContain("เบิก 14,000.00 บาท");
      expect(result).toContain("ชั่งคืน 3,400.00 บาท");
      expect(result).toContain("คืนเสีย 600.00 บาท");
      expect(result).toContain("✅ ยอดขายสุทธิ 10,000.00 บาท");
    });

    it("uses REPORT_CATEGORY_LABEL/reportCategoryHeading verbatim (never a second label)", () => {
      const result = buildDailySummaryMessage("2026-08-17", [row], ledgers([durianEntry]));
      expect(result).toContain(durianEntry.heading);
    });

    it("a row with no matching ledger entry still renders (category section empty, grand total intact)", () => {
      const result = buildDailySummaryMessage("2026-08-17", [row], new Map());
      expect(result).toContain("📊 สรุปยอด มิ้น — ทรัพย์พัน");
      expect(result).toContain("✅ ยอดขายสุทธิ 10,000.00 บาท");
      expect(result).not.toContain("🥭 ทุเรียน");
    });

    it("omitting categoryLedgers entirely reproduces the exact flat message", () => {
      const withUndefined = buildDailySummaryMessage("2026-08-17", [row]);
      expect(withUndefined).not.toContain("📊 สรุปยอด");
      expect(withUndefined).toContain("สรุปยอดประจำวันที่");
      expect(withUndefined).toContain("เบิกรวม: 14,000.00 บาท");
    });

    it("falls back to the exact current grand-total-only output when the detailed message is oversized", () => {
      // A single category name/heading repeated across many synthetic
      // categories is enough to blow past LINE_MESSAGE_MAX_CODE_POINTS
      // without needing an unrealistic number of rows.
      const bloated: CategoryLedgerEntry = {
        ...durianEntry,
        heading: "🥭 " + "ทุเรียนสายพันธุ์พิเศษที่มีชื่อยาวมากสำหรับทดสอบ".repeat(6),
      };
      const manyRows: DailySummaryMessageRow[] = Array.from({ length: 40 }, (_, i) => ({
        ...row,
        staff_name: `พนักงาน${i}`,
        market_name: `ตลาด${i}`,
      }));
      const manyLedgers = new Map(
        manyRows.map((r) => [dailySummaryCategoryLedgerKey(r.staff_name, r.market_name), [bloated]]),
      );

      const detailed = buildDailySummaryMessage("2026-08-17", manyRows, manyLedgers);
      const flatOnly = buildDailySummaryMessage("2026-08-17", manyRows);

      // Sanity check that this fixture actually exercises the fallback path;
      // if it stops doing so, the test below would trivially pass for the
      // wrong reason.
      const withoutFallback = manyRows
        .map((r) => `${r.staff_name}-${r.market_name}-${bloated.heading}`)
        .join("");
      expect(withoutFallback.length).toBeGreaterThan(LINE_MESSAGE_MAX_CODE_POINTS);

      expect(detailed).toBe(flatOnly);
      expect(detailed).not.toContain("📊 สรุปยอด");
      expect(detailed).toContain("สรุปยอดประจำวันที่");
    });
  });
});

describe("P0: an uncertified ชั่งคืน never pushes a confident ยอดส่ง", () => {
  const row: DailySummaryMessageRow = {
    summary_date: "2026-10-07",
    staff_name: "น้อย",
    market_name: "ราชพฤกษ์",
    borrow_total: 13992.17,
    return_total: 0,
    bad_return_total: 0,
    net_sales: 13992.17,
    transaction_count: 24,
  };

  it("a blocked verdict shows the net as pending, keeping the observed withdrawal", () => {
    const flat = buildDailySummaryMessage("2026-10-07", [{ ...row, produce_value_status: "blocked" }]);
    expect(flat).toContain("เบิกรวม: 13,992.17 บาท");
    expect(flat).toContain("ยอดส่ง: รอตรวจสอบ");
    expect(flat).not.toContain("ยอดส่ง: 13,992.17");

    const detailed = buildDailySummaryMessage(
      "2026-10-07",
      [{ ...row, produce_value_status: "blocked" }],
      new Map([[dailySummaryCategoryLedgerKey("น้อย", "ราชพฤกษ์"), [{
        heading: "🍎 ผลไม้", withdrawnSatang: 1_399_217, goodReturnSatang: 0,
        badReturnSatang: 0, netSatang: 1_399_217,
      } as unknown as CategoryLedgerEntry]]]),
    );
    expect(detailed).not.toContain("✅ ยอดขายสุทธิ");
    expect(detailed).not.toContain("ขาย 13,992.17");
    expect(detailed).toContain("⚠️ ยอดขายสุทธิ: รอตรวจสอบ");
  });

  it("a complete verdict is byte-identical to the legacy message", () => {
    expect(buildDailySummaryMessage("2026-10-07", [{ ...row, produce_value_status: "complete" }]))
      .toBe(buildDailySummaryMessage("2026-10-07", [row]));
  });
});
