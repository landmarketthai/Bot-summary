import { describe, expect, it } from "bun:test";
import { validateProduceEntry } from "@/lib/produce/entry-validation";
import { buildPartialCaptureReviewReply, buildProducePartialCapture } from "@/lib/produce/partial-capture";
import { getWeighSessionFinalizationErrors, parseWeighSession } from "./parser";

const row = (number: number, name = "มะนาว", quantity = 2) => [
  `${number}.${name}20บาท`, `${quantity}แพค`,
];
const document = (...lines: string[]) => [
  "กี้-ตลาด ชั่งคืน 6/10/2569", ...lines, "จบรายการชั่งคืน",
].join("\n");
const capture = (text: string) => {
  const parsed = parseWeighSession(text);
  return buildProducePartialCapture(parsed,
    validateProduceEntry({ parsed, roundRows: [], roundBound: false }),
    getWeighSessionFinalizationErrors(parsed));
};

describe("source slots survive unreadable numbered input", () => {
  const cases = [
    { name: "valid / invalid / valid", source: [...row(1), "2.อ่านไม่ได้ 36..1 โล 30 บาท", ...row(3, "หอมแดง")], target: 2, remaining: ["มะนาว", "หอมแดง"] },
    { name: "duplicate + invalid", source: [...row(1), "1.อ่านไม่ได้ 36..1 โล 30 บาท", ...row(2, "หอมแดง")], target: 2, remaining: ["มะนาว", "หอมแดง"] },
    { name: "gap + invalid", source: [...row(1), "17.อ่านไม่ได้ 36..1 โล 30 บาท", ...row(24, "หอมแดง")], target: 2, remaining: ["มะนาว", "หอมแดง"] },
    { name: "12 / 12 / unreadable / 13", source: [...row(12), ...row(12, "ผักบุ้ง"), "13.อ่านไม่ได้ 36..1 โล 30 บาท", ...row(13, "หอมแดง")], target: 14, remaining: ["มะนาว", "ผักบุ้ง", "หอมแดง"] },
    { name: "missing price before another row", source: [...row(1), "2.ผักบุ้ง", ...row(3, "หอมแดง")], target: 2, remaining: ["มะนาว", "หอมแดง"] },
    { name: "missing price before quantity", source: [...row(1), "2.ผักบุ้ง", "3แพค", ...row(3, "หอมแดง")], target: 2, remaining: ["มะนาว", "หอมแดง"] },
    { name: "unknown code", source: [...row(1), "2.ม999 20 บาท", ...row(3, "หอมแดง")], target: 2, remaining: ["มะนาว", "หอมแดง"] },
    { name: "unknown code with quantity", source: [...row(1), "2.ม999 20 บาท", "3แพค", ...row(3, "หอมแดง")], target: 2, remaining: ["มะนาว", "หอมแดง"] },
    { name: "numbered line with missing product", source: [...row(1), "2.โล20บาท", "3โล", ...row(3, "หอมแดง")], target: 2, remaining: ["มะนาว", "หอมแดง"] },
    { name: "compact unreadable number", source: [...row(1), "2อ่านไม่ได้36..1โล30บาท", ...row(3, "หอมแดง")], target: 2, remaining: ["มะนาว", "หอมแดง"] },
  ];
  for (const scenario of cases) {
    it(`${scenario.name}: review names the failed slot and keeps good rows accepted`, () => {
      const staged = capture(document(...scenario.source));
      expect(staged.issues).toHaveLength(1);
      expect(staged.issues[0]?.itemNumber).toBe(scenario.target);
      expect(staged.items.every((entry) => entry.status === "accepted")).toBe(true);
      expect(buildPartialCaptureReviewReply(staged)).toContain(`แก้ข้อ ${scenario.target}`);
    });
    it(`${scenario.name}: แก้ข้อ repairs exactly the source slot`, () => {
      const parsed = parseWeighSession(document(...scenario.source,
        `แก้ข้อ ${scenario.target}`, ...row(scenario.target, "คะน้า", 9)));
      expect(getWeighSessionFinalizationErrors(parsed)).toEqual([]);
      expect(parsed.items.find((item) => item.item_number === scenario.target))
        .toMatchObject({ product_name: "คะน้า", quantity: 9 });
      expect(parsed.items.filter((item) => item.product_name !== "คะน้า").map((item) => item.product_name))
        .toEqual(scenario.remaining);
      expect(parsed.failed_item_targets).toBeUndefined();
    });
    it(`${scenario.name}: ลบข้อ removes exactly the failed slot`, () => {
      const parsed = parseWeighSession(document(...scenario.source, `ลบข้อ ${scenario.target}`));
      expect(getWeighSessionFinalizationErrors(parsed)).toEqual([]);
      expect(parsed.items.map((item) => item.product_name)).toEqual(scenario.remaining);
      expect(parsed.failed_item_targets).toBeUndefined();
    });
  }
  for (const malformed of ["2.หัวปลี3ลูก20บาท\n3โล", "2.มะนาว20บาท"]) {
    it(malformed + ": correction and deletion clear only that parsed row's errors", () => {
      const source = [...row(1), malformed, ...row(3, "หอมแดง")];
      const staged = capture(document(...source));
      expect(staged.items.map((entry) => entry.status)).toEqual(["accepted", "needs_review", "accepted"]);
      const fixed = parseWeighSession(document(...source, "แก้ข้อ 2", ...row(2, "คะน้า", 9)));
      expect(getWeighSessionFinalizationErrors(fixed)).toEqual([]);
      expect(fixed.items.map((item) => item.product_name)).toEqual(["มะนาว", "คะน้า", "หอมแดง"]);
      const removed = parseWeighSession(document(...source, "ลบข้อ 2"));
      expect(getWeighSessionFinalizationErrors(removed)).toEqual([]);
      expect(removed.items.map((item) => item.product_name)).toEqual(["มะนาว", "หอมแดง"]);
    });
  }
  for (const nextNumber of [12, 17]) {
    it("missing quantity survives same-product row typed as " + nextNumber, () => {
      const source = [...row(11), "12.หอมแดง20บาท", ...row(nextNumber, "หอมแดง", 9)];
      const parsed = parseWeighSession(document(...source));
      expect(parsed.items.map((item) => [item.item_number, item.quantity])).toEqual([[11, 2], [12, null], [13, 9]]);
      expect(capture(document(...source)).items.map((entry) => entry.status)).toEqual(["accepted", "needs_review", "accepted"]);
      const repaired = parseWeighSession(document(...source, "แก้ข้อ 12", ...row(12, "คะน้า", 7)));
      expect(getWeighSessionFinalizationErrors(repaired)).toEqual([]);
      expect(repaired.items.map((item) => [item.product_name, item.quantity])).toEqual([["มะนาว", 2], ["คะน้า", 7], ["หอมแดง", 9]]);
      const deleted = parseWeighSession(document(...source, "ลบข้อ 12"));
      expect(getWeighSessionFinalizationErrors(deleted)).toEqual([]);
      expect(deleted.items.map((item) => [item.product_name, item.quantity])).toEqual([["มะนาว", 2], ["หอมแดง", 9]]);
    });
  }
  it("duplicate basis mismatch review follows its normalized number", () => {
    const staged = capture(document(...row(12), "12.หัวปลี3ลูก20บาท", "3โล", ...row(13, "หอมแดง")));
    expect(staged.issues[0]?.itemNumber).toBe(13);
    expect(staged.items.map((entry) => entry.status)).toEqual(["accepted", "needs_review", "accepted"]);
  });
  it("unique original-number fallback repairs an unreadable line outside the normalized range", () => {
    const parsed = parseWeighSession(document(...row(1), "17.อ่านไม่ได้36..1โล30บาท", ...row(24),
      "แก้ข้อ 17", ...row(17, "คะน้า", 9)));
    expect(getWeighSessionFinalizationErrors(parsed)).toEqual([]);
    expect(parsed.items.map((item) => item.item_number)).toEqual([1, 2, 3]);
    expect(parsed.items[1]).toMatchObject({ product_name: "คะน้า", original_item_number: 17 });
  });
  it("identical duplicate failed lines are cleared one source occurrence at a time", () => {
    const source = [...row(1), "1.อ่านไม่ได้36..1โล30บาท", "1.อ่านไม่ได้36..1โล30บาท", ...row(4)];
    const once = parseWeighSession(document(...source, "แก้ข้อ 2", ...row(2, "คะน้า")));
    expect(once.failed_item_targets).toHaveLength(1);
    expect(once.failed_item_targets?.[0]?.item_number).toBe(3);
    const twice = parseWeighSession(document(...source, "แก้ข้อ 2", ...row(2, "คะน้า"), "ลบข้อ 3"));
    expect(getWeighSessionFinalizationErrors(twice)).toEqual([]);
    expect(twice.items.map((item) => item.product_name)).toEqual(["มะนาว", "คะน้า", "มะนาว"]);
  });
  it("restarted section numbers target the normalized return row and retain its section", () => {
    const parsed = parseWeighSession([
      "กี้-ตลาด เบิก 6/10/2569", ...row(1), ...row(2, "หอมแดง"), "จบรายการเบิก",
      "รายการชั่งคืน", ...row(1, "ผักบุ้ง"), "2.อ่านไม่ได้36..1โล30บาท",
      ...row(3, "คะน้า"), "แก้ข้อ 4", ...row(4, "ส้ม", 9), "จบรายการชั่งคืน",
    ].join("\n"));
    expect(getWeighSessionFinalizationErrors(parsed)).toEqual([]);
    expect(parsed.items.map((item) => item.item_number)).toEqual([1, 2, 3, 4, 5]);
    expect(parsed.items[3]).toMatchObject({ product_name: "ส้ม", quantity: 9, transaction_type: "คืน", section: "รายการชั่งคืน" });
    expect(parsed.items[4]?.product_name).toBe("คะน้า");
  });
  it("complete duplicate same-product lines both survive numbering normalization", () => {
    const parsed = parseWeighSession(document(...row(12, "มะนาว", 2), ...row(12, "มะนาว", 3)));
    expect(parsed.items.map((item) => [item.item_number, item.quantity])).toEqual([[12, 2], [13, 3]]);
  });
  it("additional-session numbering cannot block a financially readable document", () => {
    const parsed = parseWeighSession([
      "กี้-ตลาด เบิกเพิ่ม 6/10/2569", ...row(10), ...row(11), ...row(12),
      ...row(12, "หอมแดง"), ...row(13), ...row(14), "จบรายการเบิกเพิ่ม",
    ].join("\n"));
    expect(parsed.items.map((item) => item.item_number)).toEqual([10, 11, 12, 13, 14, 15]);
    expect(getWeighSessionFinalizationErrors(parsed)).toEqual([]);
    // No duplicate-number blocker even when called with externally supplied metadata.
    expect(getWeighSessionFinalizationErrors({ ...parsed, items: parsed.items.map((item) => ({ ...item, item_number: 12 })) })).toEqual([]);
  });
});
