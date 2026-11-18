import { expect, test } from "bun:test";
import { morningBriefSlot, morningBriefSlotMinute } from "./morning-brief-schedule";
import { morningBriefMarket } from "./morning-brief-identity";
import { loadMorningBriefReport, morningBriefReadiness } from "./morning-brief-service";
import { DATE, scopeFixture } from "../../../docs/handoffs/split-morning-brief-20261021/fixtures";
import { canonicalMarketLabel } from "@/lib/market";
import { buildMorningBriefMessages } from "./morning-brief-message";
import { fetchSalesProduceRows } from "@/lib/sales/load";

test.each(["12:00:59", "12:01:30", "12:04:59"])("Fruit delayed arrival %s belongs to noon", (time) => {
  expect(morningBriefSlotMinute("fruit", Date.parse(`2026-11-17T${time}+07:00`))).toBe(720);
});
test("grace is bounded, including the final vegetable slot", () => {
  for (const time of ["12:05:00", "11:59:59", "12:30:00"]) expect(morningBriefSlot("fruit", Date.parse(`2026-11-17T${time}+07:00`))).toBe(false);
  expect(morningBriefSlotMinute("vegetable", Date.parse("2026-11-17T18:04:59+07:00"))).toBe(1080);
  expect(morningBriefSlot("vegetable", Date.parse("2026-11-17T18:05:00+07:00"))).toBe(false);
});

test.each(["พาซิโอ้", "ตลาดใหม่", "unbound", "unbound_pasio", "unbound_unknown", "cancelled", "date_mismatch", "missing", "QA"])("unassigned %s stays visible and reconciles without guessing business", async (variant) => {
  const { client, db } = scopeFixture({ pending: true });
  const originals = db.rows("produce_transactions").filter((row) => row.accountability_round_id === "vegetable");
  const label = variant === "พาซิโอ้" || variant === "unbound_pasio" ? "พาซิโอ้" : variant === "ตลาดใหม่" || variant === "unbound_unknown" ? "ตลาดใหม่" : variant === "QA" ? "ทดสอบ" : "พาซิโอ้ผลไม้";
  db.rows("produce_transactions").push(...originals.map((row) => ({ ...row, id: `review-${row.id}`, session_id: `review-${row.session_id}`,
    market_name: label, accountability_round_id: variant.startsWith("unbound") ? null : "review" })));
  if (variant !== "missing") db.rows("accountability_rounds").push({ id: "review", market_label: label, seller_label: "ต้อม",
    business_date: variant === "date_mismatch" ? "2026-10-18" : DATE, status: variant === "cancelled" ? "cancelled" : "closed" });
  db.rows("produce_sessions").push(...originals.map((row) => ({ id: `review-${row.session_id}`, session_title: label,
    session_date: DATE, total_items: 1, parser_errors: [], voided_at: null })));
  const fruit = await loadMorningBriefReport(client, DATE, "fruit");
  const vegetable = await loadMorningBriefReport(client, DATE, "vegetable");
  const legacy = await loadMorningBriefReport(client, DATE);
  const unassigned = fruit.unassigned;
  if (variant === "QA" || variant === "unbound") {
    expect(unassigned).toBeUndefined(); // Reviewed legacy fruit remains attributable; QA stays excluded.
    expect(vegetable.readiness?.status).toBe("not_ready"); // Independent unresolved vegetable draft.
  } else {
    expect(unassigned?.transactionCount).toBe(2);
    expect(unassigned?.sourceTransactions.map((row) => row.id).sort()).toEqual(originals.map((row) => `review-${row.id}`).sort());
    const text = buildMorningBriefMessages(fruit).join("\n");
    expect(text).toContain("ยังไม่จัดขอบเขต 2 รายการ");
    expect(text).toContain("ห้ามบวกซ้ำ");
    expect(vegetable.unassigned).toBeUndefined();
    expect(JSON.stringify(vegetable)).not.toContain("review-");
  }
  for (const key of ["confirmedSalesSatang", "pendingReviewSalesSatang"] as const) {
    expect(fruit.sales[key] + vegetable.sales[key] + (unassigned?.[key] ?? 0)).toBe(legacy.sales[key]);
  }
  const withdrawal = (report: typeof fruit) => Object.values(report.produceFinancial ?? {}).reduce((sum, section) => sum + section!.withdrawalValueSatang, 0);
  expect(withdrawal(fruit) + withdrawal(vegetable) + (unassigned?.withdrawalValueSatang ?? 0)).toBe(withdrawal(legacy));
  const assignedIds = [...fruit.sourceTransactions!, ...vegetable.sourceTransactions!].map((row) => row.id);
  expect(new Set(assignedIds).size).toBe(assignedIds.length);
  expect(unassigned?.sourceTransactions.every((row) => !assignedIds.includes(row.id)) ?? true).toBe(true);
});

test.each(["ชั่งคืนเพิ่ม", "คืนเสีย", "เบิก", null, "unknown"])("persisted pair waits for every unresolved pending document: %s", async (kind) => {
  const { client, db } = scopeFixture();
  db.seed("pending_sessions", [{ id: "extra", accountability_round_id: "vegetable", declared_transaction_type: kind,
    finalization_status: "pending", accumulated_text: "จบรายการคืน", business_date: DATE }]);
  const report = await loadMorningBriefReport(client, DATE, "vegetable");
  expect(report.readiness).toMatchObject({ status: "not_ready" });
  expect(report.readiness?.reasons).toContain("unresolved_vegetable_document");
  expect((await loadMorningBriefReport(client, DATE, "fruit")).readiness?.status).toBe("ready");
});

test.each(["finalized", "duplicate", "expired_empty_draft"])("resolved pending status %s leaves open vegetable round ready", async (status) => {
  const { client, db } = scopeFixture();
  db.rows("accountability_rounds")[0].status = "open";
  db.seed("pending_sessions", [{ id: "resolved", accountability_round_id: "vegetable", finalization_status: status }]);
  expect((await loadMorningBriefReport(client, DATE, "vegetable")).readiness?.status).toBe("ready");
});

test("pending documents on unrelated or cancelled rounds do not block Vegetable; plausible empty rounds do", async () => {
  for (const [label, status, expected] of [["ตลาดใหม่", "open", "ready"], ["พาซิโอ้ผลไม้", "open", "ready"],
    ["พาซิโอ้ผัก", "cancelled", "ready"], ["พาซิโอ้", "open", "not_ready"]]) {
    const { client, db } = scopeFixture();
    db.rows("accountability_rounds").push({ id: "extra", business_date: DATE, market_label: label, status });
    db.seed("pending_sessions", [{ id: "pending", accountability_round_id: "extra", finalization_status: "failed_closed" }]);
    expect((await loadMorningBriefReport(client, DATE, "vegetable")).readiness?.status).toBe(expected as "ready" | "not_ready");
  }
});

test("returns-only unassigned evidence records zero withdrawals", async () => {
  const { client, db } = scopeFixture({ alias: "ตลาดใหม่", withdrawal: false });
  const fruit = await loadMorningBriefReport(client, DATE, "fruit");
  expect(fruit.unassigned?.transactionCount).toBe(1);
  expect(fruit.unassigned?.withdrawalValueSatang).toBe(0);
  expect(buildMorningBriefMessages(fruit).join("\n")).toContain("มูลค่าเบิกที่บันทึก 0.00 บาท");
  expect(db.rows("produce_transactions").some((row) => row.accountability_round_id === "vegetable" && row.transaction_type === "เบิก")).toBe(false);
});

test("unassigned parser failure self-loads, stays unavailable, and conserves the financial partition", async () => {
  const { client, db } = scopeFixture({ alias: "ตลาดใหม่" });
  db.rows("produce_sessions").filter((row) => String(row.id).startsWith("vegetable-")).forEach((row) => { row.parser_errors = ["synthetic parser failure"]; });
  const fruit = await loadMorningBriefReport(client, DATE, "fruit");
  const veg = await loadMorningBriefReport(client, DATE, "vegetable");
  const legacy = await loadMorningBriefReport(client, DATE);
  expect(fruit.unassigned?.unavailableCount).toBeGreaterThan(0);
  for (const key of ["confirmedSalesSatang", "pendingReviewSalesSatang"] as const) {
    expect(fruit.sales[key] + veg.sales[key] + fruit.unassigned![key]).toBe(legacy.sales[key]);
  }
  expect(veg.unassigned).toBeUndefined();
});

test("QA round metadata excludes misleading display rows, including cancelled or wrong-date QA rounds", async () => {
  for (const state of ["closed", "cancelled", "wrong_date"]) {
    const { client, db } = scopeFixture();
    db.rows("accountability_rounds").push({ id: "qa", market_label: "QAไวท์ชีท", seller_label: "synthetic",
      status: state, business_date: state === "wrong_date" ? "2026-10-18" : DATE });
    db.rows("produce_transactions").push({ ...db.rows("produce_transactions")[0], id: "qa", accountability_round_id: "qa", market_name: "พาซิโอ้ผลไม้" });
    for (const scope of ["fruit", "vegetable"] as const) {
      const report = await loadMorningBriefReport(client, DATE, scope);
      expect(report.sourceTransactions?.map((row) => row.id)).not.toContain("qa");
      expect(report.unassigned).toBeUndefined();
      expect(report.readiness?.status).toBe("ready");
    }
  }
});

test("unrelated unknown market does not block Vegetable, plausible Pasio ambiguity does", async () => {
  for (const [label, blocked] of [["ตลาดใหม่", false], ["พาซิโอ้", true], ["พาซีโอ้ ผัก", true], ["", true]] as const) {
    const { client, db } = scopeFixture();
    db.rows("accountability_rounds").push({ id: "unknown", market_label: label, seller_label: "ต้อม" });
    db.rows("produce_transactions").push({ ...db.rows("produce_transactions")[0], id: "unknown", accountability_round_id: "unknown", market_name: label });
    expect((await loadMorningBriefReport(client, DATE, "vegetable")).readiness?.status).toBe(blocked ? "not_ready" : "ready");
  }
});

test("produce pagination retains every source beyond 1000 rows", async () => {
  const { client, db } = scopeFixture();
  const template = db.rows("produce_transactions")[0];
  db.seed("produce_transactions", Array.from({ length: 1003 }, (_, index) => ({ ...template, id: `row-${String(index).padStart(5, "0")}` })));
  const loaded = await fetchSalesProduceRows(client, DATE);
  expect(loaded).toHaveLength(1003);
  expect(new Set(loaded.map((row) => row.id)).size).toBe(1003);
  expect(loaded[1002].id).toBe("row-01002");
});

test.each([
  [[{ data: [{ id: "a" }], count: null }], "requires an exact row count"],
  [[{ data: [{ id: "a" }], count: 2 }, { data: [{ id: "b" }], count: 3 }], "set changed"],
  [[{ data: [{ id: "a" }], count: 2 }, { data: [{ id: "a" }], count: 2 }], "duplicate row"],
  [[{ data: [{ id: "a" }], count: 2 }, { data: [], count: 2 }], "before all rows"],
] as const)("pagination refuses incomplete or inconsistent evidence %#", async (pages, error) => {
  let index = 0;
  const query = { select: () => query, eq: () => query, order: () => query,
    range: async () => ({ ...pages[index++], error: null }) };
  const client = { from: () => query } as unknown as Parameters<typeof fetchSalesProduceRows>[0];
  await expect(fetchSalesProduceRows(client, DATE)).rejects.toThrow(error);
});

test("unvalued unassigned rows retain unknown withdrawal and an incomplete-total warning", async () => {
  const { client, db } = scopeFixture({ alias: "ตลาดใหม่", invalidQuantity: true });
  db.rows("produce_transactions")[0].quantity = null;
  const fruit = await loadMorningBriefReport(client, DATE, "fruit");
  expect(fruit.unassigned?.withdrawalValueSatang).toBeNull();
  expect(fruit.unassigned?.unavailableCount).toBeGreaterThan(0);
  expect(buildMorningBriefMessages(fruit).join("\n")).toContain("ยอดรวมส่วนนี้ยังสรุปไม่ได้");
});

test("exactly nine vegetable slots, fruit still only noon, each with five-minute arrival grace", () => {
  const slots: string[] = [];
  for (let minute = 0; minute < 1440; minute++) {
    const now = Date.parse("2026-11-17T00:00:00+07:00") + minute * 60_000;
    if (morningBriefSlotMinute("vegetable", now) === minute) slots.push(`${Math.floor(minute / 60)}:${minute % 60}`);
    expect(morningBriefSlot("fruit", now)).toBe(minute >= 720 && minute < 725);
  }
  expect(slots).toEqual(["14:0", "14:30", "15:0", "15:30", "16:0", "16:30", "17:0", "17:30", "18:0"]);
});

test("targeted seller spelling partitions both scopes without historical alias changes", async () => {
  const { client } = scopeFixture({ alias: "หนูเล็ก-พาซีโอ้" });
  const vegetable = await loadMorningBriefReport(client, DATE, "vegetable");
  expect(vegetable.sourceTransactions).toHaveLength(2);
  expect(vegetable.sales.markets?.map((market) => market.marketLabel)).toEqual(["พาซิโอ้ผัก"]);
  expect((await loadMorningBriefReport(client, DATE, "fruit")).sourceTransactions).toHaveLength(4);
  expect(canonicalMarketLabel("หนูเล็ก-พาซีโอ้")).toBe("พาซิโอ้");
  const split = scopeFixture({ alias: "พาซีโอ้" });
  split.db.rows("accountability_rounds")[0].seller_label = "หนูเล็ก";
  expect((await loadMorningBriefReport(split.client, DATE, "vegetable")).sourceTransactions).toHaveLength(2);
  expect((await loadMorningBriefReport(split.client, DATE, "fruit")).sourceTransactions).toHaveLength(4);
  expect(morningBriefMarket("คนอื่น-พาซีโอ้", "หนูเล็ก")).toBe("");
  expect(morningBriefMarket("หนูเล็ก-พาซีโอ้", "คนอื่น")).toBe("");
  for (const ambiguous of ["พาซีโอ้", "พาซิโอ้", "Pasio", "คนอื่น-พาซีโอ้", "พาซีโอ้ ผัก", "ตลาดใหม่"]) {
    expect(morningBriefMarket(ambiguous)).toBe("");
    const fixture = scopeFixture({ alias: ambiguous });
    expect((await loadMorningBriefReport(fixture.client, DATE, "fruit")).sourceTransactions).toHaveLength(4);
    expect((await loadMorningBriefReport(fixture.client, DATE, "vegetable")).sourceTransactions).toHaveLength(0);
  }
});

test("a complete pair cannot hide a second known incomplete round", () => {
  const rows = [
    { accountability_round_id: "one", transaction_type: "เบิก" },
    { accountability_round_id: "one", transaction_type: "คืน" },
    { accountability_round_id: "two", transaction_type: "เบิกเพิ่ม" },
  ];
  expect(morningBriefReadiness(rows, "vegetable").status).toBe("not_ready");
  expect(morningBriefReadiness([...rows, { accountability_round_id: "two", transaction_type: "ชั่งคืนเพิ่ม" }], "vegetable").status).toBe("ready");
  expect(morningBriefReadiness(rows, "fruit").status).toBe("ready");
});

test("multiple rounds for one market retain separate sources but one additive market summary", async () => {
  const { client, db } = scopeFixture();
  const original = db.rows("produce_transactions").filter((row) => row.accountability_round_id === "vegetable");
  const second = original.map((row) => ({ ...row, id: `second-${row.id}`, session_id: `second-${row.session_id}`, accountability_round_id: "second" }));
  db.rows("produce_transactions").push(...second);
  db.rows("accountability_rounds").push({ id: "second", market_label: "หนูเล็ก-พาซีโอ้", seller_label: "หนูเล็ก" });
  db.rows("produce_sessions").push(...second.map((row) => ({ id: row.session_id, session_date: DATE, total_items: 1, parser_errors: [], voided_at: null })));
  const report = await loadMorningBriefReport(client, DATE, "vegetable");
  expect(report.sourceTransactions).toHaveLength(4);
  expect(report.sales.markets).toHaveLength(1);
  expect(report.sales.markets![0].confirmedSalesSatang).toBe(report.sales.confirmedSalesSatang);
  expect(report.produceFinancial?.vegetable?.markets.reduce((sum, market) => sum + market.salesValueSatang, 0)).toBe(report.sales.confirmedSalesSatang);
});
