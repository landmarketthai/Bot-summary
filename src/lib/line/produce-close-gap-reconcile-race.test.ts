/**
 * Regression for the 2026-09-05 stale close-validation race (item-number gap).
 *
 * PRODUCTION INCIDENT — "ป้อม-ราชพฤกษ์ ชั่งคืน 3/9/2569". Items 15,16 were
 * persisted after the close was observed, so the entry gate saw 1..14,17,18
 * and falsely told the operator 15,16 were missing.
 *
 * Item numbers are input metadata now: the parser renumbers, and the gate
 * never reports a gap. A stale snapshot can therefore no longer produce a
 * false missing-item block, and the webhook no longer needs a re-read barrier.
 */
import { describe, expect, it } from "bun:test";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import type { WeighSession } from "@/lib/parsers/weigh-session/types";
import { validateProduceEntry } from "@/lib/produce/entry-validation";

const DATE = "2026-09-03";

function returnDocument(numbers: number[]): WeighSession {
  const products = ["องุ่น", "มะม่วง", "ส้ม", "ทุเรียน", "กล้วย", "มะละกอ", "เงาะ", "ลำไย"];
  const lines = ["ป้อม-ราชพฤกษ์ ชั่งคืน 3/9/69"];
  numbers.forEach((number, index) => {
    lines.push(`${number}.${products[index % products.length]}${(index + 1) * 10}บาท`, "2โล");
  });
  return parseWeighSession(lines.join("\n"), DATE);
}

describe("2026-09-05 incident — a stale close snapshot", () => {
  const SENT = Array.from({ length: 18 }, (_, index) => index + 1);
  const STALE_SNAPSHOT = SENT.filter((number) => number !== 15 && number !== 16);

  it("no longer fabricates a missing-item block", () => {
    const result = validateProduceEntry({
      parsed: returnDocument(STALE_SNAPSHOT),
      roundRows: [],
      roundBound: false,
    });
    expect(result.blocking).toEqual([]);
  });

  it("folds the late items into one sequential list once they arrive", () => {
    const parsed = returnDocument([...STALE_SNAPSHOT, 15, 16]);
    expect(parsed.items.map((item) => item.item_number)).toEqual(SENT);
  });
});
