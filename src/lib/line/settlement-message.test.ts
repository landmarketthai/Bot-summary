import { describe, expect, it } from "bun:test";
import { buildSettlementLineMessage } from "./settlement-message";
import type { ProduceBucketPresence } from "@/lib/summary/transactions";
import type { SettlementLineMessageInput } from "./settlement-message";

const ALL_PRESENT: ProduceBucketPresence = { เบิก: true, คืน: true, คืนเสีย: true };
const MONEY = {
  ยอดโอน: 2680,
  เงินสด: 3145,
  ค่าใช้จ่าย: 107,
  ค่าแรง: 1200,
  ยอดขาย: 7132,
  เงินสดต้องส่งเจ๊: 3444.5,
  ขาดเกิน: -299.5,
} as const;

function message(
  extra: Pick<
    SettlementLineMessageInput,
    "transactions" | "produceValueStatus" | "producePresence"
  > & Partial<Pick<SettlementLineMessageInput, "settlement">>,
): string {
  return buildSettlementLineMessage({
    date: "2026-08-25",
    staffName: "จ้า",
    marketName: "ทรัพพันย์",
    settlement: extra.settlement ?? MONEY,
    ...extra,
  });
}

function expectMoneySideUnchanged(result: string, settlement = MONEY): void {
  expect(result).toContain(`เงินโอน: ${settlement.ยอดโอน.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บาท`);
  expect(result).toContain("เงินสด:");
  expect(result).toContain("ค่าใช้จ่าย:");
  expect(result).toContain("ค่าแรง:");
  expect(result).toContain("ยอดขายจากรายการส่งเงิน:");
  expect(result).toContain("ผลตรวจ:");
  expect(result).toContain("เงินสดที่ควรเหลือส่งเจ๊:");
}

describe("buildSettlementLineMessage", () => {
  it("PR #94 COMPLETE snapshot: authoritative numbers, original labels, no warning", () => {
    const result = buildSettlementLineMessage({
      date: "2026-06-01",
      staffName: "มีน",
      marketName: "วัดทุ่งลานนา",
      transactions: {
        เบิก: 9000,
        คืน: 1000,
        คืนเสีย: 568.5,
        ยอดส่ง: 7431.5,
      },
      produceValueStatus: "complete",
      producePresence: ALL_PRESENT,
      settlement: MONEY,
    });

    expect(result).toContain("รายการส่งเงิน ✅");
    expect(result).toContain("มีน — วัดทุ่งลานนา — 1 มิถุนายน 2569");
    expect(result).toContain("ยอดขายสุทธิที่คำนวณได้: 7,431.50 บาท");
    expect(result).toContain("ยอดเบิก: 9,000.00 บาท");
    expect(result).toContain("ยอดชั่งคืน: 1,000.00 บาท");
    expect(result).toContain("ยอดคืนเสีย: 568.50 บาท");
    expect(result).toContain("เงินโอน: 2,680.00 บาท");
    expect(result).toContain("เงินสด: 3,145.00 บาท");
    expect(result).toContain("ค่าใช้จ่าย: 107.00 บาท");
    expect(result).toContain("ค่าแรง: 1,200.00 บาท");
    expect(result).toContain("ยอดขายจากรายการส่งเงิน: 7,132.00 บาท");
    expect(result).toContain("ผลตรวจ: ขาด 299.50 บาท");
    expect(result).toContain("เงินสดที่ควรเหลือส่งเจ๊: 3,444.50 บาท");
    expect(result).not.toContain("ยังไม่ยืนยัน");
    expect(result).not.toContain("ยังยืนยันไม่ได้");
    expect(result).not.toContain("ยังมีข้อมูลที่ต้องตรวจสอบ");
  });

  it("COMPLETE: shows authoritative Produce numbers with no unconfirmed warning", () => {
    const result = message({
      transactions: { เบิก: 9000, คืน: 1000, คืนเสีย: 568.5, ยอดส่ง: 7431.5 },
      produceValueStatus: "complete",
      producePresence: ALL_PRESENT,
      settlement: MONEY,
    });

    expect(result).toContain("รายการส่งเงิน ✅");
    expect(result).toContain("ยอดเบิก: 9,000.00 บาท");
    expect(result).toContain("ยอดชั่งคืน: 1,000.00 บาท");
    expect(result).toContain("ยอดคืนเสีย: 568.50 บาท");
    expect(result).toContain("ยอดขายสุทธิที่คำนวณได้: 7,431.50 บาท");
    expect(result).not.toContain("ยังไม่ยืนยัน");
    expect(result).not.toContain("ยังยืนยันไม่ได้");
    expect(result).not.toContain("ยังมีข้อมูลที่ต้องตรวจสอบ");
    expectMoneySideUnchanged(result);
  });

  it("2026-09-21 กี้ regression: complete Produce totals render without an unconfirmed warning", () => {
    const result = buildSettlementLineMessage({
      date: "2026-09-21",
      staffName: "กี้",
      marketName: "วัดทุ่งลานนา",
      transactions: {
        เบิก: 8917,
        คืน: 6359.33,
        คืนเสีย: 999,
        ยอดส่ง: 1558.67,
      },
      produceValueStatus: "complete",
      producePresence: ALL_PRESENT,
      settlement: MONEY,
    });

    expect(result).toContain("กี้ — วัดทุ่งลานนา — 21 กันยายน 2569");
    expect(result).toContain("ยอดเบิก: 8,917.00 บาท");
    expect(result).toContain("ยอดชั่งคืน: 6,359.33 บาท");
    expect(result).toContain("ยอดคืนเสีย: 999.00 บาท");
    expect(result).toContain("ยอดขายสุทธิที่คำนวณได้: 1,558.67 บาท");
    expect(result).not.toContain("ยังไม่ยืนยัน");
    expect(result).not.toContain("ยังยืนยันไม่ได้");
  });

  it("PARTIAL with all numeric components: show numbers as unconfirmed, including net", () => {
    const result = message({
      transactions: { เบิก: 13929.7, คืน: 10522.2, คืนเสีย: 213, ยอดส่ง: 3194.5 },
      produceValueStatus: "partial",
      producePresence: ALL_PRESENT,
    });

    expect(result).toContain("ยอดเบิก: 13,929.70 บาท ⚠️ ยังไม่ยืนยัน");
    expect(result).toContain("ยอดชั่งคืน: 10,522.20 บาท ⚠️ ยังไม่ยืนยัน");
    expect(result).toContain("ยอดคืนเสีย: 213.00 บาท ⚠️ ยังไม่ยืนยัน");
    expect(result).toContain("ยอดขายสุทธิที่คำนวณได้: 3,194.50 บาท ⚠️ ยังไม่ยืนยัน");
    expect(result).toContain("⚠️ ยอดจากรายการเบิก/คืนยังมีข้อมูลที่ต้องตรวจสอบ");
    expect(result.indexOf("⚠️ ยอดจากรายการเบิก/คืนยังมีข้อมูลที่ต้องตรวจสอบ"))
      .toBeLessThan(result.indexOf("เงินโอน:"));
    expect(result).not.toContain("ยอดเบิก: ⚠️ ยังยืนยันไม่ได้");
    expectMoneySideUnchanged(result);
  });

  it("BLOCKED with all numeric components: still shows numbers as unconfirmed", () => {
    const result = message({
      transactions: { เบิก: 13929.7, คืน: 10522.2, คืนเสีย: 213, ยอดส่ง: 3194.5 },
      produceValueStatus: "blocked",
      producePresence: ALL_PRESENT,
    });

    expect(result).toContain("ยอดเบิก: 13,929.70 บาท ⚠️ ยังไม่ยืนยัน");
    expect(result).toContain("ยอดชั่งคืน: 10,522.20 บาท ⚠️ ยังไม่ยืนยัน");
    expect(result).toContain("ยอดคืนเสีย: 213.00 บาท ⚠️ ยังไม่ยืนยัน");
    expect(result).toContain("ยอดขายสุทธิที่คำนวณได้: 3,194.50 บาท ⚠️ ยังไม่ยืนยัน");
    expect(result).toContain("⚠️ ยอดจากรายการเบิก/คืนยังมีข้อมูลที่ต้องตรวจสอบ");
    expectMoneySideUnchanged(result);
  });

  it("does not convert unknown damaged return into 0.00 or a provisional net", () => {
    const result = message({
      transactions: { เบิก: 9000, คืน: 1000, คืนเสีย: 0, ยอดส่ง: 8000 },
      produceValueStatus: "partial",
      producePresence: { เบิก: true, คืน: true, คืนเสีย: false },
    });

    expect(result).toContain("ยอดเบิก: 9,000.00 บาท ⚠️ ยังไม่ยืนยัน");
    expect(result).toContain("ยอดชั่งคืน: 1,000.00 บาท ⚠️ ยังไม่ยืนยัน");
    expect(result).toContain("ยอดคืนเสีย: ⚠️ ยังยืนยันไม่ได้");
    expect(result).toContain("ยอดขายสุทธิที่คำนวณได้: ⚠️ ยังยืนยันไม่ได้");
    expect(result).not.toContain("ยอดคืนเสีย: 0.00 บาท");
    expect(result).not.toContain("ยอดขายสุทธิที่คำนวณได้: 8,000.00");
    expectMoneySideUnchanged(result);
  });

  it("COMPLETE known-zero damaged return shows 0.00, not unknown", () => {
    const result = message({
      transactions: { เบิก: 9000, คืน: 1000, คืนเสีย: 0, ยอดส่ง: 8000 },
      produceValueStatus: "complete",
      producePresence: { เบิก: true, คืน: true, คืนเสีย: false },
    });

    expect(result).toContain("ยอดคืนเสีย: 0.00 บาท");
    expect(result).toContain("ยอดขายสุทธิที่คำนวณได้: 8,000.00 บาท");
    expect(result).not.toContain("ยังยืนยันไม่ได้");
    expect(result).not.toContain("ยังไม่ยืนยัน");
  });

  it("PARTIAL authoritative zero damaged return (persisted rows summing to 0) shows 0.00 as unconfirmed", () => {
    const result = message({
      transactions: { เบิก: 9000, คืน: 1000, คืนเสีย: 0, ยอดส่ง: 8000 },
      produceValueStatus: "partial",
      producePresence: { เบิก: true, คืน: true, คืนเสีย: true },
    });

    expect(result).toContain("ยอดคืนเสีย: 0.00 บาท ⚠️ ยังไม่ยืนยัน");
    expect(result).toContain("ยอดขายสุทธิที่คำนวณได้: 8,000.00 บาท ⚠️ ยังไม่ยืนยัน");
    expect(result).not.toContain("ยอดคืนเสีย: ⚠️ ยังยืนยันไม่ได้");
  });

  it("missing withdrawal stays unknown; known returns may still display; no net", () => {
    const result = message({
      transactions: { เบิก: 0, คืน: 10522.2, คืนเสีย: 213, ยอดส่ง: -10735.2 },
      produceValueStatus: "partial",
      producePresence: { เบิก: false, คืน: true, คืนเสีย: true },
    });

    expect(result).toContain("ยอดเบิก: ⚠️ ยังยืนยันไม่ได้");
    expect(result).toContain("ยอดชั่งคืน: 10,522.20 บาท ⚠️ ยังไม่ยืนยัน");
    expect(result).toContain("ยอดคืนเสีย: 213.00 บาท ⚠️ ยังไม่ยืนยัน");
    expect(result).toContain("ยอดขายสุทธิที่คำนวณได้: ⚠️ ยังยืนยันไม่ได้");
    expect(result).not.toContain("ยอดเบิก: 0.00 บาท");
  });

  it("missing overall status never fabricates zeroes from empty totals", () => {
    const result = message({
      transactions: { เบิก: 0, คืน: 0, คืนเสีย: 0, ยอดส่ง: 0 },
      produceValueStatus: "missing",
      producePresence: { เบิก: false, คืน: false, คืนเสีย: false },
      settlement: {
        ยอดโอน: 10,
        เงินสด: 20,
        ค่าใช้จ่าย: 3,
        ค่าแรง: 4,
        ยอดขาย: 33,
        เงินสดต้องส่งเจ๊: 8987,
        ขาดเกิน: -8967,
      },
    });

    expect(result).toContain("ยอดเบิก: ⚠️ ยังยืนยันไม่ได้");
    expect(result).toContain("ยอดชั่งคืน: ⚠️ ยังยืนยันไม่ได้");
    expect(result).toContain("ยอดคืนเสีย: ⚠️ ยังยืนยันไม่ได้");
    expect(result).toContain("ยอดขายสุทธิที่คำนวณได้: ⚠️ ยังยืนยันไม่ได้");
    expect(result).not.toContain("ยอดคืนเสีย: 0.00 บาท");
    expect(result).toContain("เงินโอน: 10.00 บาท");
    expect(result).toContain("เงินสด: 20.00 บาท");
    expect(result).toContain("ค่าใช้จ่าย: 3.00 บาท");
    expect(result).toContain("ค่าแรง: 4.00 บาท");
    expect(result).toContain("ยอดขายจากรายการส่งเงิน: 33.00 บาท");
  });
});
