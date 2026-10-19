import { describe, expect, it } from "bun:test";
import {
  computeValidationFlags,
  computeMedian,
  selectEffectiveAmount,
  parseBatchDate,
} from "./validation-guard";
import { buildBatchSummaryMessage } from "./batch-finalizer";
import { parseSlipExtraction } from "./extraction-schema";
import type { SlipCheckStatus, SlipType } from "@/types/database";

// ── selectEffectiveAmount ─────────────────────────────────────────────────────

describe("selectEffectiveAmount", () => {
  it("BANK_SLIP_QR returns transfer_amount", () => {
    expect(selectEffectiveAmount("BANK_SLIP_QR", 500, 300)).toBe(500);
  });
  it("BANK_SLIP_NO_QR returns transfer_amount", () => {
    expect(selectEffectiveAmount("BANK_SLIP_NO_QR", 400, 300)).toBe(400);
  });

  // ── subsidy slips: prefer gross_amount for summary ───────────────────────────
  it("GWALLET with gross_amount uses gross (total sale 60 not customer paid 24)", () => {
    // total 60, subsidy 36, customer paid 24 => summary must be 60
    expect(selectEffectiveAmount("GWALLET", null, 24, 60, 36)).toBe(60);
  });
  it("THAI_HELP_THAI with gross_amount uses gross (total 100, subsidy 60, paid 40)", () => {
    // total 100, subsidy 60, customer paid 40 => summary must be 100
    expect(selectEffectiveAmount("THAI_HELP_THAI", null, 40, 100, 60)).toBe(100);
  });
  it("GWALLET without gross but with paid+subsidy derives gross (paid+subsidy)", () => {
    // gross not visible, paid=24, subsidy=36 => derived gross=60
    expect(selectEffectiveAmount("GWALLET", null, 24, null, 36)).toBe(60);
  });
  it("GWALLET with no gross and no subsidy falls back to paid_amount (legacy)", () => {
    expect(selectEffectiveAmount("GWALLET", null, 300)).toBe(300);
  });
  it("THAI_HELP_THAI with no gross and no subsidy falls back to paid_amount (legacy)", () => {
    expect(selectEffectiveAmount("THAI_HELP_THAI", null, 200)).toBe(200);
  });

  it("NUMBERS_ONLY returns null", () => {
    expect(selectEffectiveAmount("NUMBERS_ONLY", 500, 300)).toBeNull();
  });
  it("UNKNOWN returns null", () => {
    expect(selectEffectiveAmount("UNKNOWN", 500, 300)).toBeNull();
  });
  it("null slipType returns null", () => {
    expect(selectEffectiveAmount(null, 500, 300)).toBeNull();
  });

  // ── amount validity ──────────────────────────────────────────────────────────
  it("zero transfer_amount returns null (not a valid payment)", () => {
    expect(selectEffectiveAmount("BANK_SLIP_QR", 0, null)).toBeNull();
  });
  it("negative transfer_amount returns null", () => {
    expect(selectEffectiveAmount("BANK_SLIP_QR", -100, null)).toBeNull();
  });
  it("NaN transfer_amount returns null", () => {
    expect(selectEffectiveAmount("BANK_SLIP_QR", NaN, null)).toBeNull();
  });
  it("Infinity transfer_amount returns null", () => {
    expect(selectEffectiveAmount("BANK_SLIP_QR", Infinity, null)).toBeNull();
  });
  it("zero paid_amount returns null for GWALLET with no gross", () => {
    expect(selectEffectiveAmount("GWALLET", null, 0)).toBeNull();
  });
});

// ── parseBatchDate ────────────────────────────────────────────────────────────

describe("parseBatchDate", () => {
  it("parses Thai Buddhist D/M/BBBB → ISO Gregorian", () => {
    expect(parseBatchDate("10/6/2569")).toBe("2026-06-10");
  });
  it("parses the 2026-08-21 production header date 20/8/2569 as 2026-08-20", () => {
    expect(parseBatchDate("20/8/2569")).toBe("2026-08-20");
  });
  it("does not swap 11/8/2569 into November", () => {
    expect(parseBatchDate("11/8/2569")).toBe("2026-08-11");
    expect(parseBatchDate("11/8/2569")).not.toBe("2026-11-08");
  });
  it("parses leading-zero DD/MM/BBBB", () => {
    expect(parseBatchDate("01/01/2569")).toBe("2026-01-01");
  });
  it("Buddhist year 2568 → Gregorian 2025", () => {
    expect(parseBatchDate("15/3/2568")).toBe("2025-03-15");
  });
  it("passes through valid ISO YYYY-MM-DD unchanged", () => {
    expect(parseBatchDate("2026-06-10")).toBe("2026-06-10");
  });
  it("parses Gregorian D/M/YYYY without subtracting 543", () => {
    expect(parseBatchDate("15/6/2026")).toBe("2026-06-15");
  });
  it("normalizes Buddhist ISO YYYY-MM-DD to Gregorian", () => {
    expect(parseBatchDate("2569-06-15")).toBe("2026-06-15");
  });
  it("returns null for null input", () => {
    expect(parseBatchDate(null)).toBeNull();
  });
  it("returns null for empty string", () => {
    expect(parseBatchDate("")).toBeNull();
  });
  it("returns null for arbitrary text", () => {
    expect(parseBatchDate("not-a-date")).toBeNull();
  });
  it("returns null for calendar-invalid ISO (Feb 30)", () => {
    expect(parseBatchDate("2026-02-30")).toBeNull();
  });
  it("returns null for calendar-invalid Buddhist date (Feb 30)", () => {
    expect(parseBatchDate("30/2/2569")).toBeNull();
  });
  it("accepts 29/2 for Buddhist leap year (2567 → Gregorian 2024, which is a leap year)", () => {
    expect(parseBatchDate("29/2/2567")).toBe("2024-02-29");
  });
  it("returns null for invalid month 13", () => {
    expect(parseBatchDate("1/13/2569")).toBeNull();
  });
});

// ── computeMedian ─────────────────────────────────────────────────────────────

describe("computeMedian", () => {
  it("returns 0 for empty array", () => {
    expect(computeMedian([])).toBe(0);
  });
  it("single value", () => {
    expect(computeMedian([42])).toBe(42);
  });
  it("even count: average of two middle values", () => {
    expect(computeMedian([100, 200, 300, 400])).toBe(250);
  });
  it("odd count: middle value", () => {
    expect(computeMedian([100, 200, 300])).toBe(200);
  });
  it("does not mutate the input array", () => {
    const input = [300, 100, 200];
    computeMedian(input);
    expect(input).toEqual([300, 100, 200]);
  });
});

// ── Outlier guard ─────────────────────────────────────────────────────────────

function makeExtracted(amount: number, idx: number, slipType: SlipType = "BANK_SLIP_QR") {
  return {
    checkStatus:     "EXTRACTED" as SlipCheckStatus,
    slipType,
    transferAmount:  slipType === "BANK_SLIP_QR" || slipType === "BANK_SLIP_NO_QR" ? amount : null,
    paidAmount:      slipType === "GWALLET" || slipType === "THAI_HELP_THAI" ? amount : null,
    transactionTime: null,
    referenceId:     `TEST-REF-${idx}`,
    _idx:            idx,
  };
}

describe("outlier guard", () => {
  it("50000 among normal 20–658 amounts is excluded", () => {
    // 9 normal slips + 1 GPT outlier (should be 500 but stored as 50000)
    const normal = [100, 300, 300, 400, 500, 500, 600, 635, 718.40];
    const evidences = [
      ...normal.map((a, i) => makeExtracted(a, i + 1)),
      makeExtracted(50000, 10), // GPT wrong extraction
    ];
    const flags = computeValidationFlags(evidences, null);
    const outlierFlag = flags[9]; // index 9 = 50000 slip
    expect(outlierFlag.flagged).toBe(true);
    expect(outlierFlag.flagReasons).toContain("ยอดเงินสูงผิดปกติ");
  });

  it("a legitimate 500 amount (below 5000 threshold) is included", () => {
    // Same batch structure but checking that the 500 slip is NOT flagged
    const amounts = [100, 300, 300, 400, 500, 500, 600, 635, 718.40, 50000];
    const evidences = amounts.map((a, i) => makeExtracted(a, i + 1));
    const flags = computeValidationFlags(evidences, null);
    // 500 is at indices 4 and 5 — neither should be flagged (< 5000 threshold)
    const flag500a = flags[4];
    const flag500b = flags[5];
    expect(flag500a.flagged).toBe(false);
    expect(flag500b.flagged).toBe(false);
  });

  it("high amount in batch with fewer than 5 valid items is not rejected by median rule", () => {
    // Only 4 extracted items — outlier guard requires ≥ 5
    const evidences = [100, 200, 300, 50000].map((a, i) => makeExtracted(a, i + 1));
    const flags = computeValidationFlags(evidences, null);
    const bigFlag = flags[3]; // 50000
    expect(bigFlag.flagged).toBe(false);
  });

  it("amount exactly at 5000 is eligible for outlier flagging (≥ threshold)", () => {
    // 5000 with a median of 100 → 5000 >= 10 × 100 → flagged
    const amounts = [100, 100, 100, 100, 100, 5000];
    const evidences = amounts.map((a, i) => makeExtracted(a, i + 1));
    const flags = computeValidationFlags(evidences, null);
    expect(flags[5].flagged).toBe(true);
  });

  it("amount just below 5000 is never flagged by outlier rule", () => {
    const amounts = [100, 100, 100, 100, 100, 4999.99];
    const evidences = amounts.map((a, i) => makeExtracted(a, i + 1));
    const flags = computeValidationFlags(evidences, null);
    expect(flags[5].flagged).toBe(false);
  });
});

// ── Duplicate guard ───────────────────────────────────────────────────────────

function makeExtractedWithRef(
  amount: number,
  referenceId: string | null,
  checkStatus: SlipCheckStatus = "EXTRACTED",
) {
  return {
    checkStatus,
    slipType:        "BANK_SLIP_QR" as SlipType,
    transferAmount:  amount,
    paidAmount:      null,
    transactionTime: null,
    referenceId,
  };
}

describe("duplicate guard", () => {
  it("flags the second occurrence of the same reference_id, keeps the first trusted", () => {
    const evidences = [
      makeExtractedWithRef(500, "REF-001"),
      makeExtractedWithRef(500, "REF-001"), // same slip sent twice
      makeExtractedWithRef(300, "REF-002"),
    ];
    const flags = computeValidationFlags(evidences, null);
    expect(flags[0].flagged).toBe(false);
    expect(flags[1].flagged).toBe(true);
    expect(flags[1].flagReasons).toContain("สลิปซ้ำ");
    expect(flags[2].flagged).toBe(false);
  });

  it("flags every repeat beyond the first (three copies → two flagged)", () => {
    const evidences = [
      makeExtractedWithRef(500, "REF-001"),
      makeExtractedWithRef(500, "REF-001"),
      makeExtractedWithRef(500, "REF-001"),
    ];
    const flags = computeValidationFlags(evidences, null);
    expect(flags.map((f) => f.flagged)).toEqual([false, true, true]);
  });

  it("does not flag distinct references or missing references", () => {
    const evidences = [
      makeExtractedWithRef(500, "REF-001"),
      makeExtractedWithRef(500, null),
      makeExtractedWithRef(500, null), // two no-ref slips can be legitimate twins
      makeExtractedWithRef(500, "  "), // whitespace-only ref is treated as missing
      makeExtractedWithRef(500, "REF-002"),
    ];
    const flags = computeValidationFlags(evidences, null);
    expect(flags[0].flagged).toBe(false);
    expect(flags[1].flagReasons).toContain("ไม่พบรหัสอ้างอิง");
    expect(flags[2].flagReasons).toContain("ไม่พบรหัสอ้างอิง");
    expect(flags[3].flagReasons).toContain("ไม่พบรหัสอ้างอิง");
    expect(flags[4].flagged).toBe(false);
  });

  it("a FAILED check does not consume a reference for the duplicate guard", () => {
    const evidences = [
      makeExtractedWithRef(500, "REF-001", "FAILED"),   // non-terminal
      makeExtractedWithRef(500, "REF-001", "EXTRACTED"), // first terminal use
    ];
    const flags = computeValidationFlags(evidences, null);
    expect(flags[1].flagged).toBe(false);
  });

  it("duplicate is excluded from the batch trusted total in the summary", () => {
    const evidences = [
      { id: "e1", batchIndex: 1, failureReason: null, ...makeExtractedWithRef(500, "REF-001") },
      { id: "e2", batchIndex: 2, failureReason: null, ...makeExtractedWithRef(500, "REF-001") },
      { id: "e3", batchIndex: 3, failureReason: null, ...makeExtractedWithRef(300, "REF-002") },
    ];
    const message = buildBatchSummaryMessage(evidences, { slipDate: null });
    expect(message).toContain("ยอดรวมที่อ่านได้: 800 บาท");
    expect(message).toContain("สลิปซ้ำ");
    expect(message).toContain("ยอดที่ถูกระงับ: 1 รายการ");
  });
});

// ── Date guard ────────────────────────────────────────────────────────────────

function makeExtractedWithTime(
  amount: number,
  transactionTime: string | null,
  idx = 1,
) {
  return {
    checkStatus:     "EXTRACTED" as SlipCheckStatus,
    slipType:        "BANK_SLIP_QR" as SlipType,
    transferAmount:  amount,
    paidAmount:      null,
    transactionTime,
    referenceId:     `TEST-DATE-${idx}`,
    _idx:            idx,
  };
}

describe("date guard", () => {
  const BATCH_DATE = "2026-06-10";

  it("wrong year is flagged", () => {
    const ev = makeExtractedWithTime(500, "2024-06-10T10:00:00+07:00");
    const [flag] = computeValidationFlags([ev], BATCH_DATE);
    expect(flag.flagged).toBe(true);
    expect(flag.flagReasons).toContain("วันที่รายการไม่ตรงกับรอบ");
  });

  it("wrong month is flagged", () => {
    const ev = makeExtractedWithTime(500, "2026-04-10T10:00:00+07:00");
    const [flag] = computeValidationFlags([ev], BATCH_DATE);
    expect(flag.flagged).toBe(true);
    expect(flag.flagReasons).toContain("วันที่รายการไม่ตรงกับรอบ");
  });

  it("same day is not flagged", () => {
    const ev = makeExtractedWithTime(500, "2026-06-10T10:00:00+07:00");
    const [flag] = computeValidationFlags([ev], BATCH_DATE);
    expect(flag.flagged).toBe(false);
  });

  it("previous-day transaction (±1 day) remains allowed", () => {
    const ev = makeExtractedWithTime(500, "2026-06-09T10:00:00+07:00");
    const [flag] = computeValidationFlags([ev], BATCH_DATE);
    expect(flag.flagged).toBe(false);
  });

  it("next-day transaction (±1 day) remains allowed", () => {
    const ev = makeExtractedWithTime(500, "2026-06-11T10:00:00+07:00");
    const [flag] = computeValidationFlags([ev], BATCH_DATE);
    expect(flag.flagged).toBe(false);
  });

  it("two days before is flagged", () => {
    const ev = makeExtractedWithTime(500, "2026-06-08T10:00:00+07:00");
    const [flag] = computeValidationFlags([ev], BATCH_DATE);
    expect(flag.flagged).toBe(true);
  });

  it("Bangkok midnight edge: 23:59:59 on previous day is allowed (1 day difference)", () => {
    // 2026-06-09T23:59:59+07:00 = 2026-06-09T16:59:59Z → Bangkok date = 2026-06-09
    const ev = makeExtractedWithTime(500, "2026-06-09T16:59:59Z");
    const [flag] = computeValidationFlags([ev], BATCH_DATE);
    expect(flag.flagged).toBe(false); // exactly 1 day ≤ tolerance
  });

  it("missing transactionTime is flagged as ไม่พบวันที่รายการ when batch date is known", () => {
    const ev = makeExtractedWithTime(500, null);
    const [flag] = computeValidationFlags([ev], BATCH_DATE);
    expect(flag.flagged).toBe(true);
    expect(flag.flagReasons).toContain("ไม่พบวันที่รายการ");
  });

  it("missing transactionTime is not flagged when no batch date is provided", () => {
    const ev = makeExtractedWithTime(500, null);
    const [flag] = computeValidationFlags([ev], null);
    expect(flag.flagged).toBe(false);
  });

  it("unparseable transactionTime is flagged as วันที่รายการไม่ถูกต้อง", () => {
    const ev = makeExtractedWithTime(500, "not-a-timestamp");
    const [flag] = computeValidationFlags([ev], BATCH_DATE);
    expect(flag.flagged).toBe(true);
    expect(flag.flagReasons).toContain("วันที่รายการไม่ถูกต้อง");
  });

  it("null batchDateStr disables the date guard entirely", () => {
    const ev = makeExtractedWithTime(500, "2020-01-01T10:00:00+07:00");
    const [flag] = computeValidationFlags([ev], null);
    expect(flag.flagged).toBe(false);
  });

  it("batch input date 15/6/2569 matches compact Bangkok transaction time on 2026-06-15", () => {
    const tx = parseSlipExtraction({
      slip_type: "GWALLET",
      gross_amount: 60,
      discount_amount: 36,
      paid_amount: 24,
      transfer_amount: null,
      reference_id: "ref-1",
      transaction_time: "2026-06-15T105400+0700",
      sender_name: null,
      receiver_name: "shop",
      receiver_account_tail: "1234",
      confidence: 0.9,
    }).transactionTime;
    const ev = makeExtractedWithTime(60, tx);
    const [flag] = computeValidationFlags([ev], parseBatchDate("15/6/2569"));
    expect(flag.flagged).toBe(false);
  });

  it("batch input date 17/6/2569 matches Thai short Buddhist year slip date 17 มิ.ย. 69", () => {
    const tx = parseSlipExtraction({
      slip_type: "BANK_SLIP_QR",
      gross_amount: null,
      discount_amount: null,
      paid_amount: null,
      transfer_amount: 130,
      reference_id: "016168181620CTF05042",
      transaction_time: "17 มิ.ย. 69 18:16",
      sender_name: null,
      receiver_name: "shop",
      receiver_account_tail: "1234",
      confidence: 0.96,
    }).transactionTime;
    expect(tx).toBe("2026-06-17T11:16:00.000Z");

    const ev = makeExtractedWithTime(130, tx);
    const [flag] = computeValidationFlags([ev], parseBatchDate("17/6/2569"));
    expect(flag.flagged).toBe(false);
  });

  it("UAT 20 ส.ค. 69 06:59:16 Bangkok matches batch date 20/8/2569 and is not a 2025 miss", () => {
    const tx = parseSlipExtraction({
      slip_type: "THAI_HELP_THAI",
      gross_amount: 107,
      discount_amount: 64.2,
      paid_amount: 42.8,
      transfer_amount: null,
      reference_id: "9ecc8f59c10945afad6165371ace1741-qr",
      transaction_time: "20 ส.ค. 69 - 06:59:16 น.",
      sender_name: "นฤมล พี.",
      receiver_name: "ฟรุตแวลู",
      receiver_account_tail: null,
      confidence: 0.9,
    }).transactionTime;
    expect(tx).toBe("2026-08-19T23:59:16.000Z");

    const ev = makeExtractedWithTime(107, tx);
    const [flag] = computeValidationFlags([ev], parseBatchDate("20/8/2569"));
    expect(flag.flagged).toBe(false);
    expect(flag.flagReasons).not.toContain("วันที่รายการไม่ตรงกับรอบ");
  });

  it("keeps genuinely wrong Thai short Buddhist year dates flagged", () => {
    const tx = parseSlipExtraction({
      slip_type: "BANK_SLIP_QR",
      gross_amount: null,
      discount_amount: null,
      paid_amount: null,
      transfer_amount: 130,
      reference_id: "016168181620CTF05042",
      transaction_time: "17 มิ.ย. 68 18:16",
      sender_name: null,
      receiver_name: "shop",
      receiver_account_tail: "1234",
      confidence: 0.96,
    }).transactionTime;
    expect(tx).toBe("2025-06-17T11:16:00.000Z");

    const ev = makeExtractedWithTime(130, tx);
    const [flag] = computeValidationFlags([ev], parseBatchDate("17/6/2569"));
    expect(flag.flagged).toBe(true);
    expect(flag.flagReasons).toContain("วันที่รายการไม่ตรงกับรอบ");
  });

  it("batch input date 15/6/2026 matches compact Bangkok transaction time on 2026-06-15", () => {
    const tx = parseSlipExtraction({
      slip_type: "GWALLET",
      gross_amount: 60,
      discount_amount: 36,
      paid_amount: 24,
      transfer_amount: null,
      reference_id: "ref-1",
      transaction_time: "2026-06-15T105400+0700",
      sender_name: null,
      receiver_name: "shop",
      receiver_account_tail: "1234",
      confidence: 0.9,
    }).transactionTime;
    const ev = makeExtractedWithTime(60, tx);
    const [flag] = computeValidationFlags([ev], parseBatchDate("15/6/2026"));
    expect(flag.flagged).toBe(false);
  });

  it("batch input date 9/6/2569 mismatches compact Bangkok transaction time on 2026-06-15", () => {
    const tx = parseSlipExtraction({
      slip_type: "GWALLET",
      gross_amount: 60,
      discount_amount: 36,
      paid_amount: 24,
      transfer_amount: null,
      reference_id: "ref-1",
      transaction_time: "2026-06-15T105400+0700",
      sender_name: null,
      receiver_name: "shop",
      receiver_account_tail: "1234",
      confidence: 0.9,
    }).transactionTime;
    const ev = makeExtractedWithTime(60, tx);
    const [flag] = computeValidationFlags([ev], parseBatchDate("9/6/2569"));
    expect(flag.flagged).toBe(true);
    expect(flag.flagReasons).toContain("วันที่รายการไม่ตรงกับรอบ");
  });

  it("compares transaction date using Bangkok local calendar date, not UTC date", () => {
    // 2026-06-13T17:30Z is 2026-06-14 in Bangkok.
    // Against batch date 2026-06-15, Bangkok-local comparison is within the
    // existing ±1 day tolerance; UTC-date comparison would be two days off.
    const ev = makeExtractedWithTime(500, "2026-06-13T17:30:00Z");
    const [flag] = computeValidationFlags([ev], "2026-06-15");
    expect(flag.flagged).toBe(false);
  });
});

// ── NEED_REVIEW items remain excluded ────────────────────────────────────────

describe("NEED_REVIEW items remain excluded from trusted total", () => {
  it("NEED_REVIEW items are not flagged by guards (they never reach trusted set)", () => {
    const ev = {
      checkStatus:     "NEED_REVIEW" as SlipCheckStatus,
      slipType:        "BANK_SLIP_QR" as SlipType,
      transferAmount:  50000, // large amount, but not terminal → guard does not apply
      paidAmount:      null,
      transactionTime: "2020-01-01T00:00:00Z", // very wrong date, but not terminal
    };
    const [flag] = computeValidationFlags([ev], "2026-06-10");
    // Guard only applies to EXTRACTED / PARTIAL_EXTRACTED
    expect(flag.flagged).toBe(false);
    expect(flag.effectiveAmount).toBe(50000); // amount computed but not flagged by guard
  });

  it("NEED_REVIEW items are counted as manual review in summary, not as trusted", () => {
    const evidences = [
      { id: "ev-1", batchIndex: 1, failureReason: null, ...makeExtracted(500, 1), transactionTime: null },
      {
        id:              "ev-2",
        batchIndex:      2,
        failureReason:   null,
        checkStatus:     "NEED_REVIEW" as SlipCheckStatus,
        slipType:        "BANK_SLIP_QR" as SlipType,
        transferAmount:  500,
        paidAmount:      null,
        transactionTime: null,
        _idx:            2,
      },
    ];
    const msg = buildBatchSummaryMessage(evidences, { slipDate: null });
    expect(msg).toContain("อ่านครบ: 1 รูป");   // only the EXTRACTED slip
    expect(msg).toContain("รอตรวจมือ: 1 รูป"); // the NEED_REVIEW slip
  });
});

// ── Production batch fixture: น้อย — วัดตะกล่ำ — 10/6/2569 ──────────────────
//
// Exact 25-row reconstruction of the batch that triggered the Phase 2 guard,
// using actual slip types, amounts, statuses and transaction timestamps.
//
// Confirmed totals:
//   Old raw total (transferAmount ?? paidAmount ?? 0, no guards): 53,553.40 THB
//   Excluding only image #9 (amount outlier 50,000):              3,553.40 THB
//   After both amount + date guards:                              2,781.40 THB
//
// Exclusions:
//   Amount guard: #9 (50,000 — GPT misread; >= 10x median of 154.80)
//   Date-related: #6  (GWALLET, year 2022), #9 (Dec 2026),
//                 #11 (PARTIAL_EXTRACTED, null transactionTime → ไม่พบวันที่รายการ),
//                 #15 (Mar 2026)
//   NEED_REVIEW:  #10, #12
//   Trusted (19): all remaining items, sum = 2,781.40
//
// Expected persisted values: success_count=19, failed_count=6, status=review_needed

describe("Production batch fixture: n0i — wat takl0m — 10/6/2569", () => {
  const BATCH_DATE_BUDDHIST = "10/6/2569";
  const BATCH_DATE_ISO      = "2026-06-10";

  // Transaction timestamps
  const CORRECT_DATE   = "2026-06-10T10:00:00+07:00"; // same day — passes date guard
  const YEAR_2022_DATE = "2022-06-10T10:00:00+07:00"; // #6:  4 years off
  const DEC_2026_DATE  = "2026-12-10T10:00:00+07:00"; // #9:  6 months off
  const MAR_2026_DATE  = "2026-03-10T10:00:00+07:00"; // #15: 3 months off

  type EvFields = {
    id:              string;
    batchIndex:      number;
    checkStatus:     SlipCheckStatus;
    slipType:        SlipType | null;
    grossAmount:     number | null;
    discountAmount:  number | null;
    transferAmount:  number | null;
    paidAmount:      number | null;
    transactionTime: string | null;
    referenceId:     string;
    failureReason:   null;
  };

  function makeEv(
    idx:            number,
    status:         SlipCheckStatus,
    slipType:       SlipType | null,
    transferAmount: number | null,
    paidAmount:     number | null,
    txTime:         string | null,
    grossAmount:    number | null = null,
    discountAmount: number | null = null,
  ): EvFields {
    return {
      id:              `ev-${idx}`,
      batchIndex:      idx,
      checkStatus:     status,
      slipType,
      grossAmount,
      discountAmount,
      transferAmount,
      paidAmount,
      transactionTime: txTime,
      referenceId:     `TEST-FIXTURE-REF-${idx}`,
      failureReason:   null,
    };
  }

  // 25 rows — actual slip types, amounts, statuses and timestamps.
  // Synthetic unique TEST-FIXTURE-REF values isolate legacy amount/date tests;
  // they are NOT recovered real transaction IDs. Missing-reference safety has
  // separate tests and must never be bypassed in production.
  //
  // Trusted 19 items: #1(154.80) + #2-5(4×100) + #7-8(2×200) + #13-14(2×300)
  //                   + #16-18(3×200) + #19-22(4×50) + #23(26.60) + #24-25(2×200)
  //                   = 154.80 + 400 + 400 + 600 + 600 + 200 + 26.60 + 400 = 2,781.40
  const productionFixture: EvFields[] = [
    makeEv( 1, "EXTRACTED",         "THAI_HELP_THAI", null,  154.80, CORRECT_DATE),
    makeEv( 2, "EXTRACTED",         "BANK_SLIP_QR",   100,   null,   CORRECT_DATE),
    makeEv( 3, "EXTRACTED",         "BANK_SLIP_QR",   100,   null,   CORRECT_DATE),
    makeEv( 4, "EXTRACTED",         "BANK_SLIP_QR",   100,   null,   CORRECT_DATE),
    makeEv( 5, "EXTRACTED",         "BANK_SLIP_QR",   100,   null,   CORRECT_DATE),
    makeEv( 6, "EXTRACTED",         "GWALLET",        null,  64,     YEAR_2022_DATE), // date: 2022
    makeEv( 7, "EXTRACTED",         "BANK_SLIP_QR",   200,   null,   CORRECT_DATE),
    makeEv( 8, "EXTRACTED",         "BANK_SLIP_QR",   200,   null,   CORRECT_DATE),
    makeEv( 9, "EXTRACTED",         "BANK_SLIP_QR",   50000, null,   DEC_2026_DATE), // amount + date
    makeEv(10, "NEED_REVIEW",       null,             null,  null,   null),
    makeEv(11, "PARTIAL_EXTRACTED", "BANK_SLIP_QR",   50,    null,   null),           // no timestamp
    makeEv(12, "NEED_REVIEW",       null,             null,  null,   null),
    makeEv(13, "EXTRACTED",         "BANK_SLIP_QR",   300,   null,   CORRECT_DATE),
    makeEv(14, "EXTRACTED",         "BANK_SLIP_QR",   300,   null,   CORRECT_DATE),
    makeEv(15, "EXTRACTED",         "BANK_SLIP_QR",   658,   null,   MAR_2026_DATE), // date: Mar 2026
    makeEv(16, "EXTRACTED",         "BANK_SLIP_QR",   200,   null,   CORRECT_DATE),
    makeEv(17, "EXTRACTED",         "BANK_SLIP_QR",   200,   null,   CORRECT_DATE),
    makeEv(18, "EXTRACTED",         "BANK_SLIP_QR",   200,   null,   CORRECT_DATE),
    makeEv(19, "EXTRACTED",         "BANK_SLIP_QR",   50,    null,   CORRECT_DATE),
    makeEv(20, "EXTRACTED",         "BANK_SLIP_QR",   50,    null,   CORRECT_DATE),
    makeEv(21, "EXTRACTED",         "BANK_SLIP_QR",   50,    null,   CORRECT_DATE),
    makeEv(22, "EXTRACTED",         "BANK_SLIP_QR",   50,    null,   CORRECT_DATE),
    makeEv(23, "EXTRACTED",         "BANK_SLIP_QR",   26.60, null,   CORRECT_DATE),
    makeEv(24, "EXTRACTED",         "BANK_SLIP_QR",   200,   null,   CORRECT_DATE),
    makeEv(25, "EXTRACTED",         "BANK_SLIP_QR",   200,   null,   CORRECT_DATE),
  ];

  it("parseBatchDate converts Buddhist batch date to Gregorian ISO", () => {
    expect(parseBatchDate(BATCH_DATE_BUDDHIST)).toBe(BATCH_DATE_ISO);
  });

  it("old raw total (transferAmount ?? paidAmount, no guards) is 53,553.40", () => {
    // Mirrors the pre-guard production code: (transferAmount ?? paidAmount ?? 0)
    const oldTotal = productionFixture
      .filter((e) => e.checkStatus === "EXTRACTED" || e.checkStatus === "PARTIAL_EXTRACTED")
      .reduce((sum, e) => sum + (e.transferAmount ?? e.paidAmount ?? 0), 0);
    expect(oldTotal).toBeCloseTo(53553.40, 1);
  });

  it("excluding only #9 (50,000 amount outlier) leaves 3,553.40", () => {
    // Amount guard only (no date guard): null batchDateStr
    const amountOnlyFlags = computeValidationFlags(productionFixture, null);
    const total = productionFixture.reduce((sum, e, i) => {
      if (
        (e.checkStatus === "EXTRACTED" || e.checkStatus === "PARTIAL_EXTRACTED") &&
        !amountOnlyFlags[i].flagged
      ) {
        return sum + (e.transferAmount ?? e.paidAmount ?? 0);
      }
      return sum;
    }, 0);
    expect(total).toBeCloseTo(3553.40, 1);
  });

  it("trusted total after both amount and date guards is 2,781.40", () => {
    const flags = computeValidationFlags(productionFixture, BATCH_DATE_ISO);
    const trustedTotal = productionFixture.reduce((sum, _e, i) => {
      if (!flags[i].flagged && flags[i].effectiveAmount !== null) {
        return sum + flags[i].effectiveAmount!;
      }
      return sum;
    }, 0);
    expect(trustedTotal).toBeCloseTo(2781.40, 1);
  });

  it("#9 is flagged by both amount guard and date guard (counted once in manual-review)", () => {
    const flags = computeValidationFlags(productionFixture, BATCH_DATE_ISO);
    const flag9 = flags[8]; // 0-indexed
    expect(flag9.flagged).toBe(true);
    expect(flag9.flagReasons).toContain("ยอดเงินสูงผิดปกติ");
    expect(flag9.flagReasons).toContain("วันที่รายการไม่ตรงกับรอบ");
  });

  it("#6 (GWALLET year 2022) is flagged by date guard only", () => {
    const flags = computeValidationFlags(productionFixture, BATCH_DATE_ISO);
    expect(flags[5].flagged).toBe(true);
    expect(flags[5].flagReasons).toEqual(["วันที่รายการไม่ตรงกับรอบ"]);
  });

  it("#11 (PARTIAL_EXTRACTED null transactionTime) is flagged as ไม่พบวันที่รายการ", () => {
    const flags = computeValidationFlags(productionFixture, BATCH_DATE_ISO);
    expect(flags[10].flagged).toBe(true);
    expect(flags[10].flagReasons).toEqual(["ไม่พบวันที่รายการ"]);
  });

  it("#15 (BANK_SLIP_QR March 2026) is flagged by date guard only", () => {
    const flags = computeValidationFlags(productionFixture, BATCH_DATE_ISO);
    expect(flags[14].flagged).toBe(true);
    expect(flags[14].flagReasons).toEqual(["วันที่รายการไม่ตรงกับรอบ"]);
  });

  it("#10 and #12 (NEED_REVIEW) are not flagged by guards", () => {
    const flags = computeValidationFlags(productionFixture, BATCH_DATE_ISO);
    expect(flags[9].flagged).toBe(false);
    expect(flags[11].flagged).toBe(false);
  });

  it("success_count=19 trusted, failed_count=6, status=review_needed", () => {
    const flags = computeValidationFlags(productionFixture, BATCH_DATE_ISO);
    const successCount = productionFixture.filter(
      (e, i) =>
        (e.checkStatus === "EXTRACTED" || e.checkStatus === "PARTIAL_EXTRACTED") &&
        !flags[i].flagged,
    ).length;
    const failedCount = productionFixture.length - successCount;
    expect(successCount).toBe(19);
    expect(failedCount).toBe(6);
    const status = successCount === 0 ? "failed"
      : failedCount > 0 ? "review_needed"
      : "completed";
    expect(status).toBe("review_needed");
  });

  it("summary with Buddhist date shows 2,781.40 trusted total and 1 amount-suspended item", () => {
    const msg = buildBatchSummaryMessage(productionFixture, { slipDate: BATCH_DATE_BUDDHIST });
    expect(msg).toContain("อ่านครบ: 19 รูป");
    expect(msg).toContain("รอตรวจมือ: 6 รูป");
    // Only #9 has an amount flag — date-only and missing-date items do not count
    expect(msg).toContain("ยอดที่ถูกระงับ: 1 รายการ");
    // Trusted total is 2,781.40
    expect(msg).toMatch(/2[,.]781/);
    expect(msg).not.toMatch(/53[,.]553/);
    expect(msg).not.toMatch(/3[,.]553/);
    // Review section shows both reasons for #9
    expect(msg).toContain("ยอดเงินสูงผิดปกติ");
    expect(msg).toContain("วันที่รายการไม่ตรงกับรอบ");
    // #11 flagged for missing date
    expect(msg).toContain("ไม่พบวันที่รายการ");
  });
});
