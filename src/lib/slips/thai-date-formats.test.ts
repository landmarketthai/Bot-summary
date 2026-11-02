import { describe, expect, test } from "bun:test";
import { determineSlipCheckStatus, parseSlipExtraction } from "@/lib/slips/extraction-schema";
import { computeValidationFlags, parseBatchDate } from "@/lib/slips/validation-guard";

// Thai slip date/time layouts as printed on real receipts. The parser only
// strips labels and separators around a fully printed date + time; it never
// supplies a missing year, day, month or time, and the date guard is unchanged.
const time = (raw: string) => parseSlipExtraction({ slip_type: "THAI_HELP_THAI", transaction_time: raw }).transactionTime;
const OCT29_1749 = "2026-10-29T10:49:00.000Z";

describe("visible Thai date labels and separators are read", () => {
  test.each([
    ["วันที่ 29 ต.ค. 2569 เวลา 17:49 น.", OCT29_1749], // synthetic #3 printed text
    ["วันที่ 29 ต.ค. 2569 เวลา 17:49", OCT29_1749],
    ["วันที่: 29 ต.ค. 2569 เวลา: 17:49 น.", OCT29_1749],
    ["วันที่ทำรายการ 29 ต.ค. 69 17:49", OCT29_1749],
    ["29 ต.ค. 69 เวลา 17:49 น.", OCT29_1749],
    ["29 ต.ค. 69, 17:49", OCT29_1749],
    ["29 ต.ค.69 17:49", OCT29_1749], // no space before year
    ["29ต.ค.69 17:49", OCT29_1749],
    ["29 ต.ค 69 17:49", OCT29_1749], // abbreviation printed without final dot
    ["29 ต.ค. 69 17.49 น.", OCT29_1749], // dotted clock
    ["29 ตุลาคม 2569 เวลา 17:49:00 น.", OCT29_1749],
    ["29/10/2569 เวลา 17:49", OCT29_1749],
  ])("%s", (raw, expected) => {
    expect(time(raw)).toBe(expected);
  });

  test("existing layouts are unchanged", () => {
    expect(time("20 ส.ค. 69 - 06:59:16 น.")).toBe("2026-08-19T23:59:16.000Z");
    expect(time("15 มิ.ย. 2569 1054 น.")).toBe("2026-06-15T03:54:00.000Z");
    expect(time("2026-06-15T105400+0700")).toBe("2026-06-15T03:54:00.000Z");
  });
});

describe("incomplete or invalid dates are still rejected (never guessed)", () => {
  test.each([
    "วันที่ 29 ต.ค. เวลา 17:49",       // no year
    "เวลา 17:49 น.",                   // no date
    "29 ต.ค. 69",                      // date without time: never filled with 00:00
    "วันที่ 29 ต.ค. 2569",
    "29 ตุลาคม 2569 น.",
    "29/10/2569",
    "29-10-69",
    "วันที่",                          // label only
    "วันที่ 31 ก.พ. 2569 เวลา 10:00",  // impossible day
    "วันที่ 29 ต.ค. 2569 เวลา 25:10",  // impossible hour
    "29 ต.ค. 2569 17.4",               // truncated clock
    "29 ตค 2569 17:49",                // not a known month spelling
    "29 Oct 2026 17:49",               // non-Thai month
    "๒๙ ต.ค. ๖๙ ๑๗:๔๙",              // Thai digits
    "unclear",
  ])("%s", (raw) => {
    expect(time(raw)).toBeNull();
  });
});

describe("synthetic #3 through status rule and date guard", () => {
  const extraction = (raw: string) => parseSlipExtraction({
    slip_type: "THAI_HELP_THAI", gross_amount: 100, project_right_amount: 60, gwallet_amount: 40,
    headline_total_amount: 100, reference_id: "TESTW0001", transaction_time: raw, confidence: 0.9,
  });
  const guard = (raw: string, batchDate: string) => {
    const e = extraction(raw);
    return computeValidationFlags([{ ...e, checkStatus: determineSlipCheckStatus(e) }], parseBatchDate(batchDate))[0];
  };

  test("printed date in the round: EXTRACTED and not flagged", () => {
    expect(determineSlipCheckStatus(extraction("วันที่ 29 ต.ค. 2569 เวลา 17:49 น."))).toBe("EXTRACTED");
    expect(guard("วันที่ 29 ต.ค. 2569 เวลา 17:49 น.", "29/10/2569")).toMatchObject({ flagged: false, effectiveAmount: 100 });
  });

  test("date guard is not weakened: same layout, other month is still out of round", () => {
    expect(guard("วันที่ 29 ก.ค. 2569 เวลา 17:49 น.", "29/10/2569").flagReasons).toEqual(["วันที่รายการไม่ตรงกับรอบ"]);
  });
});
