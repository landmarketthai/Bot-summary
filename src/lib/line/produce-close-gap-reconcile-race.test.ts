/**
 * Regression for the 2026-09-05 stale close-validation race (item-number gap).
 *
 * PRODUCTION INCIDENT — LINE group C9e43ef85ecb8167cf93b0d3a9e7781eb, session
 * "ป้อม-ราชพฤกษ์ ชั่งคืน 3/9/2569". The operator sent items 1..18 rapidly, but
 * webhook arrival ordering was interleaved. Around the final close, events were
 * persisted 13,14,17,18, "จบรายการชั่งคืน", THEN 15,16. The close was observed
 * against a snapshot that had not yet folded the late items, so the entry gate
 * computed an item-number gap and falsely told the operator items 15,16 (and
 * earlier stragglers) were missing. No data was corrupted — a later generic
 * "จบรายการ" reconciled and finalized all 18 items — but the false block pushes
 * operators to resend/cancel/restart.
 *
 * Two things this file pins:
 *   1. the stale snapshot really does fabricate an item-number gap, and that is
 *      the ONLY blocking kind a late straggler can fabricate; and
 *   2. the webhook consults a bounded snapshot re-read before it commits to the
 *      rejection, answering a moved snapshot with recoverable copy instead of a
 *      false missing-item block.
 */
import { describe, expect, it } from "bun:test";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import type { WeighSession } from "@/lib/parsers/weigh-session/types";
import { validateProduceEntry, type ProduceValidationResult } from "@/lib/produce/entry-validation";
import { closeGapBlockIsStragglerFabricable } from "@/lib/produce/entry-validation-gate";

const DATE = "2026-09-03";

function validate(parsed: WeighSession): ProduceValidationResult {
  // Unbound: no round master. The gap check does not need one — it reads only
  // the operator's own printed numbering — so this isolates the gap.
  return validateProduceEntry({ parsed, roundRows: [], roundBound: false });
}

/** A ชั่งคืน document whose lines carry exactly the given printed numbers. */
function returnDocument(numbers: number[]): WeighSession {
  const products = ["องุ่น", "มะม่วง", "ส้ม", "ทุเรียน", "กล้วย", "มะละกอ", "เงาะ", "ลำไย"];
  const lines = ["ป้อม-ราชพฤกษ์ ชั่งคืน 3/9/69"];
  numbers.forEach((number, index) => {
    lines.push(`${number}.${products[index % products.length]}${(index + 1) * 10}บาท`, "2โล");
  });
  return parseWeighSession(lines.join("\n"), DATE);
}

function gapOf(result: ProduceValidationResult): number[] | null {
  const gap = result.blocking.find((entry) => entry.kind === "item_number_gap");
  return gap && gap.kind === "item_number_gap" ? gap.missingItemNumbers : null;
}

describe("2026-09-05 incident — a stale close snapshot fabricates a gap", () => {
  const SENT = Array.from({ length: 18 }, (_, index) => index + 1);
  // The two items whose events landed AFTER the close was observed.
  const STALE_SNAPSHOT = SENT.filter((number) => number !== 15 && number !== 16);

  it("reports 15,16 missing from the snapshot the close was observed against", () => {
    const result = validate(returnDocument(STALE_SNAPSHOT));
    expect(result.status).toBe("blocked");
    expect(gapOf(result)).toEqual([15, 16]);
  });

  it("marks that block straggler-fabricable, so the caller re-reads first", () => {
    expect(closeGapBlockIsStragglerFabricable(validate(returnDocument(STALE_SNAPSHOT)))).toBe(true);
  });

  it("clears the moment the late items are folded in — the block was never real", () => {
    const result = validate(returnDocument(SENT));
    expect(gapOf(result)).toBeNull();
    expect(closeGapBlockIsStragglerFabricable(result)).toBe(false);
  });
});

describe("closeGapBlockIsStragglerFabricable — narrow by construction", () => {
  it("is false for a clean document", () => {
    expect(closeGapBlockIsStragglerFabricable(validate(returnDocument([1, 2, 3])))).toBe(false);
  });

  it("is true when the block set contains an item-number gap", () => {
    expect(closeGapBlockIsStragglerFabricable(validate(returnDocument([1, 3])))).toBe(true);
  });

  it("is false for a duplicate-number block — a straggler cannot invent that", () => {
    // A duplicate is content that is present; a late item only ever ADDS, so it
    // cannot fabricate a duplicate. This block must never be suppressed.
    const parsed = parseWeighSession(
      [
        "ป้อม-ราชพฤกษ์ ชั่งคืน 3/9/69",
        "1.องุ่น100บาท", "10โล",
        "1.มะม่วง50บาท", "5โล",
      ].join("\n"),
      DATE,
    );
    const result = validate(parsed);
    expect(result.blocking.some((entry) => entry.kind === "duplicate_item_number")).toBe(true);
    expect(gapOf(result)).toBeNull();
    expect(closeGapBlockIsStragglerFabricable(result)).toBe(false);
  });

  it("is true when a gap rides alongside a duplicate — the next close re-blocks either way", () => {
    const parsed = parseWeighSession(
      [
        "ป้อม-ราชพฤกษ์ ชั่งคืน 3/9/69",
        "1.องุ่น100บาท", "10โล",
        "1.มะม่วง50บาท", "5โล",
        "4.ส้ม20บาท", "4โล",
      ].join("\n"),
      DATE,
    );
    const result = validate(parsed);
    expect(result.blocking.map((entry) => entry.kind).sort())
      .toEqual(["duplicate_item_number", "item_number_gap"]);
    expect(closeGapBlockIsStragglerFabricable(result)).toBe(true);
  });
});

describe("webhook close gate wiring", () => {
  const webhookPath = new URL("./webhook-service.ts", import.meta.url);

  it("re-reads the snapshot before committing to a fabricable gap block", async () => {
    const source = await Bun.file(webhookPath).text();
    const guard = source.indexOf("closeGapBlockIsStragglerFabricable(decision.result)");
    const recheck = source.indexOf("this.closeSnapshotMovedUnderGate(pending, log)");
    const raced = source.indexOf("return { refusalText: CLOSE_RACED_LATE_ITEM_REPLY };");
    const definitive = source.indexOf("refusalText: buildBlockingValidationReply(decision.result,");

    expect(guard).toBeGreaterThan(0);
    expect(recheck).toBeGreaterThan(guard);
    // The recoverable answer must be reachable BEFORE the definitive rejection,
    // or the false missing-item block returns exactly as it did on 2026-09-05.
    expect(raced).toBeGreaterThan(recheck);
    expect(raced).toBeLessThan(definitive);
  });

  it("scopes the barrier to the same generation and a strictly advanced revision", async () => {
    const source = await Bun.file(webhookPath).text();
    expect(source).toContain("row.session_generation !== pending.session_generation");
    expect(source).toContain("(row.ingest_revision ?? 0) > (pending.ingest_revision ?? 0)");
  });
});
