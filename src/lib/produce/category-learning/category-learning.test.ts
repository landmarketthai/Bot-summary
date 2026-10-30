import { describe, expect, test } from "bun:test";
import {
  approvedCategoryFor,
  buildCategoryPolicy,
  dictionaryCategoryFor,
} from "@/lib/produce/product-code/category";
import { produceSectionOf } from "@/lib/summary/produce-section";
import { stockCategoryFor } from "@/lib/summary/stock-categories";
import { morningBriefProductIdentity } from "@/lib/summary/morning-brief";
import { produceCategoryTotals } from "@/lib/summary/produce-category-totals";
import { LinePushError } from "@/lib/line/reply";
import {
  ANNOUNCE_PER_RUN,
  MAX_DELIVERY_ATTEMPTS,
  classifyPushFailure,
  discoverCategoryCandidates,
  needsCategoryReview,
  runCategoryDiscovery,
  suggestCategory,
} from "./discovery";
import {
  CATEGORY_RULES_PAGE_SIZE,
  enterCategoryPolicy,
  loadApprovedCategoryPolicy,
  runWithCategoryPolicy,
  withApprovedCategoryRules,
} from "./rules";
import { buildCategoryReviewMessage, handleCategoryReviewPostback, parseCategoryReviewPostback } from "./review";
import { fakeDb } from "./test-fake-db";

const ID = "11111111-2222-4333-8444-555555555555";
const GROUP = "Ctestgroup";
const ADMIN = "Uadmin";
const ENV = { CATEGORY_REVIEW_LINE_GROUP_IDS: GROUP, CATEGORY_REVIEW_ADMIN_LINE_USER_IDS: ADMIN } as unknown as NodeJS.ProcessEnv;
const NOTIFY_ENV = { ...ENV, CATEGORY_REVIEW_NOTIFY_ENABLED: "true" } as NodeJS.ProcessEnv;

const rulesDb = (rules: [string, string][], failOn?: (i: number) => boolean) =>
  fakeDb({ produce_category_rules: rules.map(([product_name, category_code]) => ({ product_name, category_code })) },
    { failOn: failOn && ((i) => failOn(i)) });
const withPolicy = <T>(rules: [string, string][], run: () => T) => runWithCategoryPolicy(buildCategoryPolicy(rules), run);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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

describe("category policy snapshot", () => {
  test("10. a failing DB never throws and always keeps the business rules", async () => {
    // Falls back to the last complete snapshot (process-wide, so possibly
    // loaded by another test file) or to business rules only.
    const policy = await loadApprovedCategoryPolicy({ from: () => { throw new Error("relation does not exist"); } });
    expect(policy.get("มะละกอดิบ")).toBe("ผ");
    expect(policy.get("เต้าหู้แผ่น")).toBe("other");
  });

  test("P2. more than 1,000 rules load completely via keyset pages", async () => {
    const rules: [string, string][] = Array.from({ length: 2345 }, (_, i) => [`สินค้า${String(i).padStart(5, "0")}`, i % 2 ? "ผ" : "ม"]);
    const db = rulesDb(rules);
    const policy = await loadApprovedCategoryPolicy(db.client);
    expect(policy.size).toBe(2345 + 2); // + business rules
    expect(policy.get("สินค้า02344")).toBe("ม");
    expect(policy.get("สินค้า00999")).toBe("ผ");
    expect(policy.get("สินค้า01000")).toBe("ม");
    expect(db.requests.map((r) => r.filters)).toEqual([[], ["product_name>สินค้า00999"], ["product_name>สินค้า01999"]]);
  });

  test("P2. an exact multiple of the page size still terminates and is complete", async () => {
    const rules: [string, string][] = Array.from({ length: CATEGORY_RULES_PAGE_SIZE * 2 }, (_, i) => [`ช${String(i).padStart(5, "0")}`, "ผ"]);
    const policy = await loadApprovedCategoryPolicy(rulesDb(rules).client);
    expect(policy.size).toBe(CATEGORY_RULES_PAGE_SIZE * 2 + 2);
  });

  test("P2. a failing later page never yields a partial snapshot — last complete one is kept", async () => {
    const complete = await loadApprovedCategoryPolicy(rulesDb([["ผักทดสอบใหม่", "ผ"]]).client);
    const rules: [string, string][] = Array.from({ length: 1500 }, (_, i) => [`ข${String(i).padStart(5, "0")}`, "ม"]);
    const partial = await loadApprovedCategoryPolicy(rulesDb(rules, (i) => i === 1).client);
    expect(partial).toBe(complete);
    expect(partial.get("ข00000")).toBeUndefined();
  });

  test("P1. concurrent reports each keep their own snapshot across awaits", async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    const reportA = withApprovedCategoryRules(rulesDb([["ชื่อแข่ง", "ผ"]]).client, async () => {
      const before = produceSectionOf("ชื่อแข่ง");
      await gateA; // report B loads a different snapshot meanwhile
      return [before, produceSectionOf("ชื่อแข่ง"), stockCategoryFor("ชื่อแข่ง")];
    });
    await tick();
    const reportB = await withApprovedCategoryRules(rulesDb([["ชื่อแข่ง", "ม"]]).client, async () => {
      await tick();
      return [produceSectionOf("ชื่อแข่ง"), stockCategoryFor("ชื่อแข่ง")];
    });
    releaseA();
    expect(await reportA).toEqual(["vegetable", "vegetable", "ผัก"]);
    expect(reportB).toEqual(["fruit", "ผลไม้"]);
    expect(produceSectionOf("ชื่อแข่ง")).toBe("other"); // outside any report: business rules only
  });

  test("P1. enterCategoryPolicy pins a route handler's own snapshot under interleaving", async () => {
    const route = async (rules: [string, string][], wait: Promise<unknown>) => {
      enterCategoryPolicy(await loadApprovedCategoryPolicy(rulesDb(rules).client));
      const first = produceSectionOf("ชื่อเส้นทาง");
      await wait;
      return [first, produceSectionOf("ชื่อเส้นทาง")];
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const a = route([["ชื่อเส้นทาง", "ผ"]], gate);
    const b = route([["ชื่อเส้นทาง", "ม"]], tick());
    expect(await b).toEqual(["fruit", "fruit"]);
    release();
    expect(await a).toEqual(["vegetable", "vegetable"]);
    expect(produceSectionOf("ชื่อเส้นทาง")).toBe("other");
  });

  test("P1. a failed refresh reuses the last complete snapshot for the next report", async () => {
    await loadApprovedCategoryPolicy(rulesDb([["ผักทดสอบใหม่", "ผ"]]).client);
    const section = await withApprovedCategoryRules(rulesDb([], () => true).client, () => produceSectionOf("ผักทดสอบใหม่"));
    expect(section).toBe("vegetable");
  });

  test("nested report helpers reuse the outer snapshot without reloading", async () => {
    const inner = rulesDb([["ชื่อซ้อน", "ม"]]);
    const result = await withApprovedCategoryRules(rulesDb([["ชื่อซ้อน", "ผ"]]).client,
      () => withApprovedCategoryRules(inner.client, () => produceSectionOf("ชื่อซ้อน")));
    expect(result).toBe("vegetable");
    expect(inner.requests).toHaveLength(0);
  });
});

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
    const seen = await withApprovedCategoryRules(rulesDb([["ผักทดสอบใหม่", "ผ"]]).client, () => ({
      surfaces: surfaces("ผักทดสอบใหม่"),
      business: approvedCategoryFor("มะละกอดิบ"),
    }));
    expect(seen.surfaces).toEqual({
      stockSummary: "vegetable", morningBriefAndPdf: "vegetable", lineCategory: "ผ",
      morningBriefCategory: "ผัก / สมุนไพร / เครื่องประกอบอาหาร",
    });
    expect(seen.business).toBe("ผ"); // business rules survive a DB snapshot
  });

  test("9. surfaces agree for every rule code", () => {
    withPolicy([["ก", "ท"], ["ข", "ม"], ["ค", "ผ"], ["ง", "ห"], ["จ", "ป"], ["ฉ", "พ"], ["ช", "other"]], () => {
      for (const name of ["ก", "ข", "ค", "ง", "จ", "ฉ", "ช"]) {
        const s = surfaces(name);
        expect(s.stockSummary).toBe(s.morningBriefAndPdf);
      }
    });
  });

  test("8. a rule changes category only — money and item counts are unchanged", () => {
    const rows = [
      { product_name: "ผักทดสอบใหม่", transaction_type: "เบิก", total_amount: 123.45 },
      { product_name: "มะละกอ", transaction_type: "เบิก", total_amount: 50 },
      { product_name: "ผักทดสอบใหม่", transaction_type: "คืน", total_amount: 20.1 },
    ];
    const before = produceCategoryTotals(rows);
    const after = withPolicy([["ผักทดสอบใหม่", "ผ"]], () => produceCategoryTotals(rows));
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

  const window = { fromDate: "2026-10-07", toDate: "2026-10-20" };

  /** Fake ledger RPCs; the real state machine is proven in category-delivery.pg.test.ts. */
  function ledger(claimed: Record<string, unknown>[]) {
    const calls: [string, Record<string, unknown>][] = [];
    const db = fakeDb({ produce_transactions: [row("สินค้าลึกลับ")], produce_category_rules: [] });
    const client = {
      from: (db.client as { from: unknown }).from,
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push([name, args]);
        if (name === "claim_produce_category_deliveries") return { data: claimed, error: null };
        if (name === "complete_produce_category_delivery") return { data: args.p_outcome, error: null };
        if (name === "produce_category_delivery_health") return { data: [{ group_id: GROUP, status: "delivered", deliveries: 1 }], error: null };
        return { data: null, error: null };
      },
    };
    return { client: client as never, calls };
  }
  const claim = (group = GROUP) => ({
    candidate_id: ID, revision: 3, group_id: group, claim_token: "00000000-0000-4000-8000-0000000000aa", attempts: 1,
    product_name: "สินค้าลึกลับ", suggested_category: null, confidence: "low", suggestion_reason: "-",
    similar_product_name: null, occurrence_count: 1, distinct_dates: 1, first_seen: "2026-10-20",
    last_seen: "2026-10-20", sample_markets: [],
  });

  test("notifications are opt-in and only go to the review group", async () => {
    const pushes: string[] = [];
    const push = async (to: string) => { pushes.push(to); };
    const off = ledger([claim()]);
    expect(await runCategoryDiscovery(off.client, window, push, {} as unknown as NodeJS.ProcessEnv))
      .toMatchObject({ discovered: 1, notifyMode: "disabled", queue: null });
    expect(off.calls.map(([n]) => n)).toEqual(["observe_produce_category_candidate"]);
    const noGroup = ledger([claim()]);
    expect((await runCategoryDiscovery(noGroup.client, window, push,
      { CATEGORY_REVIEW_NOTIFY_ENABLED: "true" } as unknown as NodeJS.ProcessEnv)).notifyMode).toBe("no_recipient");
    expect(noGroup.calls.map(([n]) => n)).not.toContain("claim_produce_category_deliveries");
    expect(pushes).toEqual([]);

    const on = ledger([claim()]);
    expect(await runCategoryDiscovery(on.client, window, push, NOTIFY_ENV))
      .toMatchObject({ notified: 1, notifyMode: "sent", queue: { delivered: 1 } });
    expect(pushes).toEqual([GROUP]);
    expect(on.calls.find(([n]) => n === "claim_produce_category_deliveries")![1])
      .toMatchObject({ p_groups: [GROUP], p_limit: ANNOUNCE_PER_RUN, p_max_attempts: MAX_DELIVERY_ATTEMPTS });
  });

  test("each claimed delivery is completed with its claim token and a classified outcome", async () => {
    const { client, calls } = ledger([claim(GROUP), claim("C-other")]);
    const push = async (to: string) => { if (to === "C-other") throw new LinePushError("LINE push HTTP 400", 400, false); };
    const result = await runCategoryDiscovery(client, window, push, NOTIFY_ENV);
    expect(result).toMatchObject({ notified: 1, blocked: 1, retrying: 0 });
    const completes = calls.filter(([n]) => n === "complete_produce_category_delivery").map(([, a]) => a);
    expect(completes).toEqual([
      expect.objectContaining({ p_group_id: GROUP, p_revision: 3, p_claim_token: claim().claim_token, p_outcome: "delivered", p_error: null }),
      expect.objectContaining({ p_group_id: "C-other", p_outcome: "blocked", p_error_code: 400, p_error: "HTTP 400" }),
    ]);
  });

  test("push failures are classified without leaking error text", () => {
    expect(classifyPushFailure(new LinePushError("LINE push HTTP 401", 401, false))).toEqual(
      { outcome: "retryable", code: 401, reason: "HTTP 401 (credentials or group permission)" });
    expect(classifyPushFailure(new LinePushError("x", 403, false)).outcome).toBe("retryable");
    expect(classifyPushFailure(new LinePushError("x", 429, true))).toEqual({ outcome: "retryable", code: 429, reason: "HTTP 429" });
    expect(classifyPushFailure(new LinePushError("x", 500, true)).outcome).toBe("retryable");
    expect(classifyPushFailure(new LinePushError("x", null, true))).toEqual({ outcome: "retryable", code: null, reason: "network" });
    expect(classifyPushFailure(new LinePushError("x", 400, false))).toEqual({ outcome: "blocked", code: 400, reason: "HTTP 400" });
    expect(classifyPushFailure(new Error("Bearer secret-token leaked?"))).toEqual({ outcome: "retryable", code: null, reason: "unknown" });
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

  test("unauthorized alias taps never read candidates or category rules", async () => {
    const alias = postbacks().find((d) => d.includes("|al|"))!;
    let reads = 0;
    const supabase = { from: () => { reads += 1; throw new Error("must not read"); }, rpc: () => { throw new Error("must not decide"); } };
    const aliasCodeFor = () => { reads += 1; return "ม" as const; };
    for (const [userId, sourceId] of [["Uother", GROUP], [ADMIN, "Coperations"]] as const) {
      await handleCategoryReviewPostback(
        { data: alias, lineEventId: `evt-${userId}`, userId, sourceType: "group", sourceId },
        { supabase: supabase as never, aliasCodeFor, env: ENV },
      );
    }
    expect(reads).toBe(0);
  });

  test("button labels stay within LINE's 40 code points without splitting characters", () => {
    const long = { ...candidate, similar_product_name: "🍉".repeat(30) + "ชื่อยาวมากเกินกว่าปุ่มจะรับได้" };
    const message = buildCategoryReviewMessage(long, "ม") as { contents: { footer: { contents: { action: { label: string } }[] } } };
    for (const { action } of message.contents.footer.contents) {
      expect([...action.label].length).toBeLessThanOrEqual(40);
      expect(action.label).not.toMatch(/[\uD800-\uDBFF]$/); // no dangling high surrogate
    }
  });
});
