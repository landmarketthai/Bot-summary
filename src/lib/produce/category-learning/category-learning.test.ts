import { afterEach, describe, expect, test } from "bun:test";
import {
  approvedCategoryFor,
  dictionaryCategoryFor,
  setApprovedCategoryRules,
} from "@/lib/produce/product-code/category";
import { produceSectionOf } from "@/lib/summary/produce-section";
import { stockCategoryFor } from "@/lib/summary/stock-categories";
import { morningBriefProductIdentity } from "@/lib/summary/morning-brief";
import { produceCategoryTotals } from "@/lib/summary/produce-category-totals";
import { discoverCategoryCandidates, needsCategoryReview, runCategoryDiscovery, suggestCategory } from "./discovery";
import { loadApprovedCategoryRules } from "./rules";
import { buildCategoryReviewMessage, handleCategoryReviewPostback, parseCategoryReviewPostback } from "./review";

afterEach(() => setApprovedCategoryRules([]));

const ID = "11111111-2222-4333-8444-555555555555";
const GROUP = "Ctestgroup";
const ADMIN = "Uadmin";
const ENV = { CATEGORY_REVIEW_LINE_GROUP_IDS: GROUP, CATEGORY_REVIEW_ADMIN_LINE_USER_IDS: ADMIN } as unknown as NodeJS.ProcessEnv;

/** Every report surface's view of one name, as fruit / vegetable / other. */
function surfaces(name: string) {
  const stock = stockCategoryFor(name);
  return {
    stockSummary: stock === "ผลไม้" || stock === "ทุเรียน" ? "fruit" : stock === "ผัก" ? "vegetable" : "other",
    morningBriefAndPdf: produceSectionOf(name),
    lineCategory: dictionaryCategoryFor(name),
    morningBriefCategory: morningBriefProductIdentity(name, "กก.").category,
  };
}

describe("business-approved category rules", () => {
  test("1. มะละกอดิบ is vegetable on every surface", () => {
    expect(surfaces("มะละกอดิบ")).toEqual({
      stockSummary: "vegetable", morningBriefAndPdf: "vegetable", lineCategory: "ผ",
      morningBriefCategory: "ผัก / สมุนไพร / เครื่องประกอบอาหาร",
    });
  });

  test("2. มะละกอ stays fruit and a separate product from มะละกอดิบ", () => {
    expect(surfaces("มะละกอ")).toEqual({
      stockSummary: "fruit", morningBriefAndPdf: "fruit", lineCategory: "ม", morningBriefCategory: "ผลไม้",
    });
    expect(morningBriefProductIdentity("มะละกอดิบ", "กก.").productName).toBe("มะละกอดิบ");
  });

  test("เต้าหู้แผ่น / ปลาทู / ขนมจีน remain other and raise no review", () => {
    for (const name of ["เต้าหู้แผ่น", "ปลาทู", "ขนมจีน"]) {
      expect(produceSectionOf(name)).toBe("other");
      expect(needsCategoryReview(name)).toBe(false);
    }
  });
});

describe("runtime approved rules", () => {
  test("3. a DB-approved category reaches every surface without a deployment", async () => {
    expect(surfaces("ผักทดสอบใหม่").morningBriefAndPdf).toBe("other");
    await loadApprovedCategoryRules({
      from: () => ({ select: async () => ({ data: [{ product_name: "ผักทดสอบใหม่", category_code: "ผ" }], error: null }) }),
    });
    expect(surfaces("ผักทดสอบใหม่")).toEqual({
      stockSummary: "vegetable", morningBriefAndPdf: "vegetable", lineCategory: "ผ",
      morningBriefCategory: "ผัก / สมุนไพร / เครื่องประกอบอาหาร",
    });
    // Built-in business rules survive a DB refresh.
    expect(approvedCategoryFor("มะละกอดิบ")).toBe("ผ");
  });

  test("9. surfaces agree for every rule code", () => {
    setApprovedCategoryRules([["ก", "ท"], ["ข", "ม"], ["ค", "ผ"], ["ง", "ห"], ["จ", "ป"], ["ฉ", "พ"], ["ช", "other"]]);
    for (const name of ["ก", "ข", "ค", "ง", "จ", "ฉ", "ช"]) {
      const s = surfaces(name);
      expect(s.stockSummary).toBe(s.morningBriefAndPdf);
    }
  });

  test("10. rule load failure keeps the previous snapshot and never throws", async () => {
    setApprovedCategoryRules([["ผักทดสอบใหม่", "ผ"]]);
    await loadApprovedCategoryRules({ from: () => { throw new Error("relation does not exist"); } });
    await loadApprovedCategoryRules({ from: () => ({ select: async () => ({ data: null, error: { message: "timeout" } }) }) });
    expect(approvedCategoryFor("ผักทดสอบใหม่")).toBe("ผ");
  });

  test("8. a rule changes category only — money and item counts are unchanged", () => {
    const rows = [
      { product_name: "ผักทดสอบใหม่", transaction_type: "เบิก", total_amount: 123.45 },
      { product_name: "มะละกอ", transaction_type: "เบิก", total_amount: 50 },
      { product_name: "ผักทดสอบใหม่", transaction_type: "คืน", total_amount: 20.1 },
    ];
    const before = produceCategoryTotals(rows);
    setApprovedCategoryRules([["ผักทดสอบใหม่", "ผ"]]);
    const after = produceCategoryTotals(rows);
    expect(after.netSatang).toBe(before.netSatang);
    for (const bucket of ["เบิก", "คืน", "คืนเสีย"] as const) {
      expect(after[bucket].totalSatang).toBe(before[bucket].totalSatang);
      const items = (b: typeof before) => b[bucket].categories.reduce((n, c) => n + c.itemCount, 0);
      expect(items(after)).toBe(items(before));
    }
    expect(after.เบิก.categories.find((c) => c.id === "ผ")?.totalSatang).toBe(12345);
  });
});

describe("discovery", () => {
  const row = (product_name: string, transaction_date = "2026-10-20", market_name = "ตลาดA") =>
    ({ product_name, unit: "กก.", transaction_date, market_name });

  test("finds only unclassified names, with evidence and durable per-name grouping", () => {
    const found = discoverCategoryCandidates([
      row("มะละกอดิบ"), row("ปลาทู"), row("เต้าหู้แผ่น"), row("มะละกอ"),
      row("สินค้าลึกลับ", "2026-10-19"), row("สินค้าลึกลับ", "2026-10-20", "ตลาดB"), row("สินค้าลึกลับ", "2026-10-20"),
    ]);
    expect(found.map((c) => c.productName)).toEqual(["สินค้าลึกลับ"]);
    expect(found[0]).toMatchObject({ occurrences: 3, dates: ["2026-10-19", "2026-10-20"], markets: ["ตลาดA", "ตลาดB"], code: null, confidence: "low" });
  });

  test("5. a similar name only SUGGESTS a category — identity is never merged", () => {
    const suggestion = suggestCategory("มะม่วงง");
    expect(suggestion).toMatchObject({ code: "ม", confidence: "high", similar: "มะม่วง" });
    const [candidate] = discoverCategoryCandidates([row("มะม่วงง")]);
    expect(candidate!.productName).toBe("มะม่วงง");
    expect(produceSectionOf("มะม่วงง")).toBe("other"); // until an admin approves
  });

  test("notifications are opt-in and only go to the review group", async () => {
    const pushes: string[] = [];
    const candidate = { id: ID, product_name: "สินค้าลึกลับ", suggested_category: null, confidence: "low", suggestion_reason: "-",
      similar_product_name: null, occurrence_count: 1, distinct_dates: 1, first_seen: "2026-10-20", last_seen: "2026-10-20",
      sample_markets: [], revision: 1, notified_revision: null };
    const chain = (result: unknown): unknown => new Proxy(() => {}, {
      get: (_, prop) => prop === "then" ? (resolve: (v: unknown) => void) => resolve(result) : () => chain(result),
    });
    const client = {
      from: (table: string) => chain(table === "produce_transactions"
        ? { data: [row("สินค้าลึกลับ")], error: null }
        : { data: table === "produce_category_candidates" ? [candidate] : [], error: null }),
      rpc: async () => ({ data: null, error: null }),
    };
    const push = async (to: string) => { pushes.push(to); };
    const window = { fromDate: "2026-10-07", toDate: "2026-10-20" };

    const off = await runCategoryDiscovery(client as never, window, push, {} as unknown as NodeJS.ProcessEnv);
    expect(off).toMatchObject({ discovered: 1, notifyMode: "disabled" });
    const noGroup = await runCategoryDiscovery(client as never, window, push, { CATEGORY_REVIEW_NOTIFY_ENABLED: "true" } as unknown as NodeJS.ProcessEnv);
    expect(noGroup.notifyMode).toBe("no_recipient");
    expect(pushes).toEqual([]);
    const on = await runCategoryDiscovery(client as never, window, push, { ...ENV, CATEGORY_REVIEW_NOTIFY_ENABLED: "true" });
    expect(on).toMatchObject({ notified: 1, notifyMode: "sent" });
    expect(pushes).toEqual([GROUP]);
  });
});

describe("LINE review postback", () => {
  const candidate = {
    id: ID, product_name: "มะม่วงง", suggested_category: "ม" as const, confidence: "high" as const,
    suggestion_reason: "x", similar_product_name: "มะม่วง", occurrence_count: 3, distinct_dates: 2,
    first_seen: "2026-10-19", last_seen: "2026-10-20", sample_markets: ["ตลาดA"], revision: 2,
  };

  function client(rpcResult: unknown) {
    const calls: unknown[] = [];
    return {
      calls,
      supabase: {
        rpc: async (_fn: string, args: unknown) => { calls.push(args); return { data: rpcResult, error: null }; },
        from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { similar_product_name: "มะม่วง" }, error: null }) }) }) }),
      },
    };
  }

  const postbacks = () => {
    const message = buildCategoryReviewMessage(candidate, "ม") as { contents: { footer: { contents: { action: { data: string } }[] } } };
    return message.contents.footer.contents.map((b) => b.action.data);
  };

  test("card offers every review action and every postback parses", () => {
    const parsed = postbacks().map(parseCategoryReviewPostback);
    expect(parsed.every(Boolean)).toBe(true);
    expect(new Set(parsed.map((p) => p!.action))).toEqual(new Set([
      "approve_suggested", "select_category", "approve_alias", "new_product", "legitimate_other", "reject",
    ]));
    expect(parsed.every((p) => p!.revision === 2 && p!.candidateId === ID)).toBe(true);
  });

  test("malformed postbacks are rejected", () => {
    for (const data of ["pcat1|x|1|as|", `pcat1|${ID}|1|sc|`, `pcat1|${ID}|1|sc|Z`, `pcat1|${ID}|-1|as|`, `pcat1|${ID}|1|zz|`]) {
      expect(parseCategoryReviewPostback(data)).toBeNull();
    }
  });

  test("7. non-admins and other groups cannot approve; other groups get no reply", async () => {
    const { supabase, calls } = client({ status: "applied" });
    const data = postbacks()[0]!;
    const deps = { supabase: supabase as never, aliasCodeFor: () => "ม" as const, env: ENV };
    expect(await handleCategoryReviewPostback({ data, lineEventId: "e1", userId: "Uother", sourceType: "group", sourceId: GROUP }, deps))
      .toBe("⛔ ไม่มีสิทธิ์อนุมัติหมวดสินค้า");
    expect(await handleCategoryReviewPostback({ data, lineEventId: "e2", userId: ADMIN, sourceType: "group", sourceId: "Coperations" }, deps))
      .toBeNull();
    expect(await handleCategoryReviewPostback({ data, lineEventId: "e3", userId: ADMIN, sourceType: "user", sourceId: ADMIN }, deps))
      .toBeNull();
    expect(await handleCategoryReviewPostback({ data, lineEventId: "e4", userId: ADMIN, sourceType: "group", sourceId: GROUP },
      { ...deps, env: {} as unknown as NodeJS.ProcessEnv })).toBeNull();
    expect(calls).toEqual([]);
  });

  test("admin decision forwards the verified identity and event id; replay and stale answers are safe", async () => {
    const data = postbacks()[0]!;
    const input = { data, lineEventId: "evt-1", userId: ADMIN, sourceType: "group", sourceId: GROUP };
    const applied = client({ status: "applied", product_name: "มะม่วงง", category_code: "ม" });
    expect(await handleCategoryReviewPostback(input, { supabase: applied.supabase as never, aliasCodeFor: () => "ม", env: ENV }))
      .toContain("มะม่วงง → ผลไม้");
    expect(applied.calls[0]).toMatchObject({ p_candidate_id: ID, p_revision: 2, p_action: "approve_suggested", p_line_user_id: ADMIN, p_source_id: GROUP, p_line_event_id: "evt-1" });

    const replay = client({ status: "duplicate" });
    expect(await handleCategoryReviewPostback(input, { supabase: replay.supabase as never, aliasCodeFor: () => "ม", env: ENV }))
      .toBe("ℹ️ คำสั่งนี้บันทึกไปแล้ว");
    const stale = client({ status: "stale" });
    expect(await handleCategoryReviewPostback(input, { supabase: stale.supabase as never, aliasCodeFor: () => "ม", env: ENV }))
      .toContain("หมดอายุ");
  });

  test("alias approval copies the CATEGORY of the reviewed target, resolved server-side", async () => {
    const alias = postbacks().find((d) => d.includes("|al|"))!;
    const { supabase, calls } = client({ status: "applied", product_name: "มะม่วงง", category_code: "ม" });
    await handleCategoryReviewPostback(
      { data: alias, lineEventId: "evt-2", userId: ADMIN, sourceType: "group", sourceId: GROUP },
      { supabase: supabase as never, aliasCodeFor: (name) => (name === "มะม่วง" ? "ม" : null), env: ENV },
    );
    expect(calls[0]).toMatchObject({ p_action: "approve_alias", p_category_code: "ม", p_alias_target: "มะม่วง" });
  });
});
