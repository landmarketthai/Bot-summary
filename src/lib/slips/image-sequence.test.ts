import { describe, expect, test } from "bun:test";
import { sequenceBatchImages, type LedgerImage } from "@/lib/slips/image-sequence";
import {
  buildBatchSummaryMessage,
  orderByLineSequence,
  SEQUENCE_UNVERIFIED_NOTE,
  type EvidenceWithCheck,
} from "@/lib/slips/batch-finalizer";

const T0 = 1_760_000_000_000;
const img = (n: number, state = "attached", extra: Partial<LedgerImage> = {}): LedgerImage => ({
  lineMessageId: `5900000000000${String(n).padStart(5, "0")}`,
  eventTsMs: T0 + n * 1000,
  state,
  lineTimestamp: true,
  ...extra,
});

/** Evidence for LINE image n whose attach finished at position `attachedAs`. */
const ev = (n: number, attachedAs: number, check: Partial<EvidenceWithCheck> = {}): EvidenceWithCheck => ({
  id: `ev-${n}`,
  lineMessageId: img(n).lineMessageId,
  batchIndex: attachedAs,
  checkStatus: "EXTRACTED",
  slipType: "BANK_SLIP_QR",
  transferAmount: 100 + n,
  paidAmount: null,
  transactionTime: "2026-10-16T12:00:00+07:00",
  failureReason: null,
  ...check,
});

const shuffle = <T>(items: T[], seed: number): T[] => {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

describe("sequenceBatchImages: #N is the LINE send position", () => {
  test("30 images attached in a scrambled order are numbered by LINE time", () => {
    const images = Array.from({ length: 30 }, (_, i) => img(i + 1));
    const seq = sequenceBatchImages(shuffle(images, 7), new Set(images.map((i) => i.lineMessageId)));
    expect(seq.uncertain).toBe(false);
    expect(seq.missing).toEqual([]);
    for (let n = 1; n <= 30; n++) expect(seq.positions.get(img(n).lineMessageId)).toBe(n);
  });

  test("a failed image between successes keeps its number; later ones do not shift", () => {
    const images = [img(1), img(2), img(3, "failed_permanent"), img(4), img(5, "retry_pending")];
    const attached = new Set([1, 2, 4].map((n) => img(n).lineMessageId));
    const seq = sequenceBatchImages(images, attached);
    expect(seq.positions.get(img(4).lineMessageId)).toBe(4);
    expect(seq.missing).toEqual([
      { sequence: 3, state: "failed_permanent", verified: true },
      { sequence: 5, state: "retry_pending", verified: true },
    ]);
  });

  test("images after the close command or consumed by another flow take no number", () => {
    const images = [img(1), img(2, "excluded_not_slip"), img(3), img(4, "excluded_after_close")];
    const seq = sequenceBatchImages(images, new Set([img(1).lineMessageId, img(3).lineMessageId]));
    expect(seq.positions.get(img(3).lineMessageId)).toBe(2);
    expect(seq.positions.has(img(4).lineMessageId)).toBe(false);
    expect(seq.missing).toEqual([]);
  });

  test("message ids compare numerically, never as text", () => {
    const a = img(1, "attached", { lineMessageId: "999", eventTsMs: T0, imageSet: { id: "S", index: 1 } });
    const b = img(2, "attached", { lineMessageId: "1000", eventTsMs: T0, imageSet: { id: "S", index: 2 } });
    const seq = sequenceBatchImages([b, a], new Set(["999", "1000"]));
    expect(seq.positions.get("999")).toBe(1);
    expect(seq.positions.get("1000")).toBe(2);
    expect(seq.uncertain).toBe(false);
  });

  test("same millisecond inside one LINE image set orders by the set index", () => {
    const a = img(1, "attached", { eventTsMs: T0, imageSet: { id: "S", index: 2 } });
    const b = img(2, "attached", { eventTsMs: T0, imageSet: { id: "S", index: 1 } });
    const seq = sequenceBatchImages([a, b], new Set([a.lineMessageId, b.lineMessageId]));
    expect(seq.positions.get(b.lineMessageId)).toBe(1);
    expect(seq.uncertain).toBe(false);
  });

  describe("marks unverified positions instead of inventing an order", () => {
    const ids = (...ns: number[]) => new Set(ns.map((n) => img(n).lineMessageId));

    test("a receipt-time fallback makes EVERY position unverified (it can shift all of them)", () => {
      const seq = sequenceBatchImages([img(1), img(2, "attached", { lineTimestamp: false }), img(3)], new Set());
      expect(seq.uncertain).toBe(true);
      expect(seq.unverified).toEqual(ids(1, 2, 3));
    });
    test("an image-set index that contradicts the timestamps marks that set only", () => {
      const seq = sequenceBatchImages([
        img(1),
        img(2, "attached", { imageSet: { id: "S", index: 2 } }),
        img(3, "attached", { imageSet: { id: "S", index: 1 } }),
        img(4, "attached", { imageSet: { id: "T", index: 1 } }),
        img(5, "attached", { imageSet: { id: "T", index: 2 } }),
      ], new Set());
      expect(seq.unverified).toEqual(ids(2, 3));
    });
    test("an image set sent in one millisecond, in index order, is fully verified", () => {
      const set = [1, 2, 3].map((n) => img(n, "attached", { eventTsMs: T0, imageSet: { id: "S", index: n } }));
      const seq = sequenceBatchImages(set, new Set());
      expect(seq.uncertain).toBe(false);
      expect(seq.unverified.size).toBe(0);
    });
    test("two separate sends in the same millisecond mark exactly those two", () => {
      const seq = sequenceBatchImages(
        [img(1), img(2, "attached", { eventTsMs: T0 + 2500 }), img(3, "attached", { eventTsMs: T0 + 2500 }), img(4)],
        new Set(),
      );
      expect(seq.unverified).toEqual(ids(2, 3));
    });
    test("an evidence attached without a ledger row makes every position unverified", () => {
      const seq = sequenceBatchImages([img(1), img(2)], new Set([img(1).lineMessageId, "legacy-id"]));
      expect(seq.uncertain).toBe(true);
      expect(seq.unverified).toEqual(ids(1, 2));
    });
    test("a missing image carries its own verified flag", () => {
      const seq = sequenceBatchImages(
        [img(1), img(2, "failed_permanent", { eventTsMs: T0 + 3000 }), img(3)],
        ids(1, 3),
      );
      expect(seq.missing).toEqual([{ sequence: 2, state: "failed_permanent", verified: false }]);
    });
  });
});

describe("summary #N, amount and reason come from the same evidence", () => {
  const slipDate = "16/10/2569";
  // LINE order 1..6; download retries made 2 and 5 attach last.
  const images = [1, 2, 3, 4, 5, 6, 7].map((n) => img(n, n === 7 ? "failed_permanent" : "attached"));
  const evidences = [
    ev(1, 1),
    ev(3, 2, { transactionTime: null }),                       // missing date
    ev(4, 3, { transactionTime: "2026-10-10T12:00:00+07:00" }), // outside the period
    ev(6, 4, { checkStatus: "NEED_REVIEW", transferAmount: null }),
    ev(2, 5),
    ev(5, 6),
  ];
  const attached = new Set(evidences.map((e) => e.lineMessageId!));

  const render = (input: EvidenceWithCheck[]) => {
    const seq = sequenceBatchImages(shuffle(images, input.length), attached);
    return buildBatchSummaryMessage(orderByLineSequence(input, seq), {
      slipDate,
      missingImages: seq.missing,
      sequenceUncertain: seq.uncertain,
    });
  };

  test("every #N line carries its own image's amount and reason", () => {
    const text = render(evidences);
    expect(text).toContain("#1 เช็คได้ 101 บาท");
    expect(text).toContain("#2 เช็คได้ 102 บาท");
    expect(text).toContain("#3 ไม่พบวันที่รายการ");
    expect(text).toContain("#4 วันที่รายการไม่ตรงกับรอบ");
    expect(text).toContain("#5 เช็คได้ 105 บาท");
    expect(text).toContain("#6 ไม่พบข้อมูลครบถ้วน");
    expect(text).toContain("#7 รูปเข้าระบบไม่สำเร็จ");
    expect(text).toContain("รับทั้งหมด: 7 รูป");
    expect(text).toContain("อ่านครบ: 3 รูป");
    expect(text).toContain("รอตรวจมือ: 4 รูป");
    expect(text).toContain("ยอดรวมที่อ่านได้: 308 บาท");
    expect(text).not.toContain("ยืนยันลำดับจาก LINE ไม่ได้");
    // Review lines are listed in #N order.
    const review = text.split("รูปที่ต้องตรวจมือ:")[1];
    expect(review.match(/#\d+/g)).toEqual(["#3", "#4", "#6", "#7"]);
  });

  test("rendering is identical whatever order the evidences were loaded or attached in", () => {
    const first = render(evidences);
    for (let seed = 1; seed <= 10; seed++) expect(render(shuffle(evidences, seed))).toBe(first);
  });

  test("an in-batch duplicate keeps the image sent FIRST in LINE, not the one attached first", () => {
    const dupImages = [img(1), img(2)];
    const dup = [
      ev(2, 1, { referenceId: "REF-1" }), // sent second, attached first
      ev(1, 2, { referenceId: "REF-1" }),
    ];
    const seq = sequenceBatchImages(dupImages, new Set(dup.map((e) => e.lineMessageId!)));
    const text = buildBatchSummaryMessage(orderByLineSequence(dup, seq), { slipDate });
    expect(text).toContain("#1 เช็คได้ 101 บาท");
    expect(text).toContain("#2 สลิปซ้ำ");
  });

  test("evidence the ledger cannot place is shown as #? with a warning, never a guessed number", () => {
    const seq = sequenceBatchImages([img(1)], new Set([img(1).lineMessageId, "legacy-id"]));
    const text = buildBatchSummaryMessage(
      orderByLineSequence([ev(1, 1), { ...ev(9, 2), lineMessageId: "legacy-id" }], seq),
      { slipDate, missingImages: seq.missing, sequenceUncertain: seq.uncertain },
    );
    // The unplaced evidence can belong anywhere, so #1 is not confirmed either.
    expect(text).toContain("#1? เช็คได้ 101 บาท");
    expect(text).not.toMatch(/^#1 /m);
    expect(text).toContain("#? เช็คได้ 109 บาท");
    expect(text.indexOf(SEQUENCE_UNVERIFIED_NOTE)).toBeLessThan(text.indexOf("รูปที่ตรวจผ่าน:"));
  });

  test("ambiguous positions print #N? (amount unchanged); confirmed ones print plain #N", () => {
    const ambiguous = [
      img(1),
      img(2, "attached", { eventTsMs: T0 + 2500 }),
      img(3, "attached", { eventTsMs: T0 + 2500 }),
      img(4, "failed_permanent", { imageSet: { id: "S", index: 2 } }),
      img(5, "attached", { imageSet: { id: "S", index: 1 } }),
    ];
    const evs = [ev(1, 1), ev(2, 2), ev(3, 3), ev(5, 4)];
    const seq = sequenceBatchImages(ambiguous, new Set(evs.map((e) => e.lineMessageId!)));
    const text = buildBatchSummaryMessage(orderByLineSequence(evs, seq), {
      slipDate, missingImages: seq.missing, sequenceUncertain: seq.uncertain,
    });
    expect(text).toContain("#1 เช็คได้ 101 บาท");
    expect(text).toContain("#2? เช็คได้ 102 บาท");
    expect(text).toContain("#3? เช็คได้ 103 บาท");
    expect(text).toContain("#4? รูปเข้าระบบไม่สำเร็จ");
    expect(text).toContain("#5? เช็คได้ 105 บาท");
    expect(text).toContain(SEQUENCE_UNVERIFIED_NOTE);
    // Same money as with a fully verified order: only the labels differ.
    expect(text).toContain("ยอดรวมที่อ่านได้: 411 บาท");
  });

  test("money is unchanged by the reorder: same trusted count, total and duplicate exclusions as batch_index order", () => {
    const totalOf = (text: string) => text.match(/ยอดรวมที่อ่านได้: ([\d,.]+) บาท/)?.[1] ?? "none";
    const countOf = (text: string, label: string) => text.match(new RegExp(`${label}: (\\d+) รูป`))?.[1];
    for (let seed = 1; seed <= 200; seed++) {
      const n = 3 + (seed % 25);
      const order = shuffle(Array.from({ length: n }, (_, i) => i + 1), seed);
      const batch = order.map((lineNo, attachIdx) => ev(lineNo, attachIdx + 1, {
        // Duplicate pairs share a reference AND the same amount (same bank slip).
        referenceId: lineNo % 7 === 0 ? "REF-DUP" : `REF-${lineNo}`,
        transferAmount: lineNo % 7 === 0 ? 700 : lineNo % 11 === 0 ? 90_000 : 100 + lineNo,
        checkStatus: lineNo % 13 === 0 ? "NEED_REVIEW" : "EXTRACTED",
        transactionTime: lineNo % 5 === 0 ? null : "2026-10-16T12:00:00+07:00",
      }));
      const legacy = buildBatchSummaryMessage([...batch].sort((a, b) => a.batchIndex! - b.batchIndex!), { slipDate });
      const seq = sequenceBatchImages(
        Array.from({ length: n }, (_, i) => img(i + 1)),
        new Set(batch.map((e) => e.lineMessageId!)),
      );
      const fixed = buildBatchSummaryMessage(orderByLineSequence(batch, seq), { slipDate });
      expect(totalOf(fixed)).toBe(totalOf(legacy));
      expect(countOf(fixed, "อ่านครบ")).toBe(countOf(legacy, "อ่านครบ"));
      expect(countOf(fixed, "รอตรวจมือ")).toBe(countOf(legacy, "รอตรวจมือ"));
      expect(fixed.match(/สลิปซ้ำ/g)?.length ?? 0).toBe(legacy.match(/สลิปซ้ำ/g)?.length ?? 0);
    }
  });

  test("a verified batch carries no '?' label and no warning", () => {
    const seq = sequenceBatchImages(images, attached);
    const text = buildBatchSummaryMessage(orderByLineSequence(evidences, seq), {
      slipDate, missingImages: seq.missing, sequenceUncertain: seq.uncertain,
    });
    expect(text).not.toMatch(/#\d+\?|#\?/);
    expect(text).not.toContain(SEQUENCE_UNVERIFIED_NOTE);
  });
});
