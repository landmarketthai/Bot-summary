import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";
import { LATEST_DATA_UNAVAILABLE_NOTICE } from "@/lib/summary/latest-data-hint";
import {
  HOUSE_STOCK_PRICED_PARSER_VERSION,
  PHYSICAL_INVENTORY_PARSER_VERSION,
} from "@/lib/physical-inventory/types";

// ── Stubs ──────────────────────────────────────────────────────────────────
//
// The route calls createServiceClient() and pushLineMessage() internally, so
// both modules are mocked. Each test points the fixtures at its own data
// before invoking GET(). Same convention as api/pdf/report-summary/route.test.ts.

type QueryResult = { data: unknown[] | null; error: { message: string } | null };

let produceResult: QueryResult = { data: [], error: null };
let sessionResult: QueryResult = { data: [], error: null };
let messageResult: QueryResult = { data: [], error: null };
let physicalSnapshotResult: QueryResult = { data: [], error: null };
let physicalItemResult: QueryResult = { data: [], error: null };
/** P2E round identity + the unfinalized documents attributed to those rounds. */
let roundResult: QueryResult = { data: [], error: null };
let pendingResult: QueryResult = { data: [], error: null };

/**
 * Answer produce_transactions per query rather than per table.
 *
 * The empty-state path issues THREE reads against that view — the requested
 * date, the latest-date probe, and that date's markets — and a fixture that
 * cannot tell them apart cannot prove the route asked the right questions.
 * Null keeps every existing test on the single produceResult fixture.
 */
let produceByQuery: ((filters: Record<string, unknown>) => QueryResult | null) | null = null;

function chain(result: () => QueryResult, produceAware = false, pricedSnapshotAware = false): Record<string, unknown> {
  const filters: Record<string, unknown> = {};
  const answer = () => {
    const response = (produceAware ? produceByQuery?.(filters) ?? null : null) ?? result();
    if (!pricedSnapshotAware || !response.data) return response;
    return {
      ...response,
      data: response.data.filter((entry) =>
        (entry as Record<string, unknown>).parser_version === filters["eq:parser_version"]),
    };
  };

  const node: Record<string, unknown> = {};
  const self = () => node;
  node.select = self;
  node.in = self;
  node.ilike = self;
  node.is = self;
  node.not = self;
  node.order = self;
  node.eq = (column: string, value: unknown) => {
    filters[`eq:${column}`] = value;
    return node;
  };
  node.lt = (column: string, value: unknown) => {
    filters[`lt:${column}`] = value;
    return node;
  };
  node.limit = () => Promise.resolve(answer());
  node.range = () => Promise.resolve(answer());
  node.then = (resolve: (v: QueryResult) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(answer()).then(resolve, reject);
  return node;
}

mock.module("@/lib/supabase/server", () => ({
  createServiceClient: () => ({
    from(table: string) {
      if (table === "produce_transactions") return chain(() => produceResult, true);
      if (table === "produce_sessions") return chain(() => sessionResult);
      if (table === "raw_messages") return chain(() => messageResult);
      if (table === "physical_inventory_snapshots") return chain(() => physicalSnapshotResult, false, true);
      if (table === "physical_inventory_items") return chain(() => physicalItemResult);
      if (table === "accountability_rounds") return chain(() => roundResult);
      if (table === "pending_sessions") return chain(() => pendingResult);
      throw new Error(`Unexpected table: ${table}`);
    },
  }),
}));

interface PushCall {
  to: string;
  text: string;
  retryKey?: string;
}

let pushCalls: PushCall[] = [];
let pushBehavior: (call: PushCall) => { status: string } = () => ({ status: "delivered" });

mock.module("@/lib/line/reply", () => ({
  pushLineMessage: async (to: string, text: string, retryKey?: string) => {
    const call = { to, text, retryKey };
    pushCalls.push(call);
    return pushBehavior(call);
  },
}));

let morningBriefPdfBuilds = 0;
mock.module("@/lib/summary/morning-brief-service", () => ({
  loadMorningBriefReport: async (_client: unknown, businessDate: string) => ({ businessDate }),
}));
mock.module("@/lib/summary/morning-brief-pdf", () => ({
  createMorningBriefPdfArtifact: async (_client: unknown, report: { businessDate: string }) => {
    morningBriefPdfBuilds += 1;
    return { signedUrl: `https://example.test/${report.businessDate}/morning-brief.pdf` };
  },
  morningBriefPdfLineMessage: (url: string) => `📄 PDF สำหรับพิมพ์ A4 พร้อมแล้ว\nดาวน์โหลด: ${url}`,
}));

const { GET } = await import("./route");

const TX_RETURN = "คืน";
const TX_WITHDRAW = "เบิก";

const originalSecret = process.env.CRON_SECRET;
const originalTargets = process.env.STOCK_SUMMARY_LINE_TARGETS;

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  pushCalls = [];
  morningBriefPdfBuilds = 0;
  pushBehavior = () => ({ status: "delivered" });
  produceResult = { data: [], error: null };
  sessionResult = { data: [], error: null };
  messageResult = { data: [], error: null };
  physicalSnapshotResult = { data: [], error: null };
  physicalItemResult = { data: [], error: null };
  roundResult = { data: [], error: null };
  pendingResult = { data: [], error: null };
  produceByQuery = null;
  process.env.CRON_SECRET = "stock-secret";
  delete process.env.STOCK_SUMMARY_LINE_TARGETS;
});

afterEach(() => {
  restore("CRON_SECRET", originalSecret);
  restore("STOCK_SUMMARY_LINE_TARGETS", originalTargets);
});

// `null` means "send no authorization header" — an undefined default would
// silently fall back to the valid secret.
function request(query = "", authorization: string | null = "Bearer stock-secret"): NextRequest {
  return new NextRequest(`http://localhost/api/cron/daily-stock-summary${query}`, {
    method: "GET",
    headers: authorization ? { authorization } : {},
  });
}

function produceRows() {
  return [
    {
      market_name: "ตลาดกี้",
      product_name: "หมอนทอง",
      quantity: 281.1,
      unit: "โล",
      transaction_type: TX_RETURN,
    },
    {
      market_name: "เฉลิม72 ผลไม้",
      product_name: "แก้วมังกร",
      quantity: 9,
      unit: "โล",
      transaction_type: TX_WITHDRAW,
    },
  ];
}

describe("daily stock summary cron — authentication", () => {
  test("rejects a request with no authorization header", async () => {
    expect((await GET(request("", null))).status).toBe(401);
    expect(pushCalls).toHaveLength(0);
  });

  test("rejects a wrong secret", async () => {
    expect((await GET(request("", "Bearer nope"))).status).toBe(401);
    expect(pushCalls).toHaveLength(0);
  });

  test("fails closed when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(pushCalls).toHaveLength(0);
  });
});

describe("daily stock summary cron — delivery", () => {
  test("does nothing when no LINE targets are configured", async () => {
    produceResult = { data: produceRows(), error: null };

    const res = await GET(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.sent).toBe(false);
    expect(body.reason).toBe("no_targets_configured");
    expect(body.morningBriefReferencePersisted).toBe(true);
    expect(morningBriefPdfBuilds).toBe(1);
    expect(pushCalls).toHaveLength(0);
  });

  test("manual target override isolates UAT from configured production targets", async () => {
    produceResult = { data: produceRows(), error: null };
    process.env.STOCK_SUMMARY_LINE_TARGETS = "Cproduction00001";

    const res = await GET(request("?date=2026-07-25&target=CUatTarget00001"));
    expect(res.status).toBe(200);
    expect(pushCalls.length).toBeGreaterThan(0);
    expect(pushCalls.every((call) => call.to === "CUatTarget00001")).toBe(true);
  });

  test("rejects malformed target override before loading or sending", async () => {
    const res = await GET(request("?date=2026-07-25&target=bad-target"));
    expect(res.status).toBe(400);
    expect(pushCalls).toHaveLength(0);
  });

  test("pushes the shared StockSummary snapshot to each configured target", async () => {
    produceResult = { data: produceRows(), error: null };
    process.env.STOCK_SUMMARY_LINE_TARGETS = "Cgroup1,Cgroup2";

    const res = await GET(request("?date=2026-07-25"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sent).toBe(true);
    expect(body.sentCount).toBe(2);
    expect(body.businessDate).toBe("2026-07-25");
    expect(body.incompleteCount).toBe(1);
    expect(body.incompleteMarketCount).toBe(1);
    expect(body.isComplete).toBe(false);
    expect(body.anomalyCount).toBe(1);
    expect(body.anomalyMarketCount).toBe(1);
    expect(body.hasAnomalies).toBe(true);

    // Scheduled 08:00 output carries the business report + House Stock + printable PDF;
    // internal anomaly/remediation diagnostics stay out of LINE.
    expect(pushCalls.map((c) => c.to)).toEqual([
      "Cgroup1", "Cgroup1", "Cgroup1",
      "Cgroup2", "Cgroup2", "Cgroup2",
    ]);
    expect(morningBriefPdfBuilds).toBe(1);
    expect(pushCalls.filter((c) => c.text.includes("PDF สำหรับพิมพ์ A4"))).toHaveLength(2);
    const text = pushCalls.filter((c) => c.to === "Cgroup1").map((c) => c.text).join("\n\n");
    expect(text).toContain("📦 สรุปของดีชั่งคืนประจำวัน");
    expect(text).toContain("🥭 ทุเรียน");
    expect(text).toContain("1. หมอนทอง — 281.1 กก.");
    expect(text).not.toContain("⚠️ รอตรวจทั้งหมดจาก 1 ตลาด");
    expect(text).not.toContain("⚠️ รายละเอียดข้อมูลผิดปกติ");
    expect(text).not.toContain("ตลาดกี้ — หมอนทอง — กก.");
    expect(text).not.toContain("ปัญหา: ไม่พบรายการเบิกที่ตรงกัน");
    expect(text).not.toContain("เฉลิม72 ผลไม้: แก้วมังกร");
  });

  test("repeat scheduler calls reuse the same retry keys — no duplicate LINE spam", async () => {
    produceResult = { data: produceRows(), error: null };
    process.env.STOCK_SUMMARY_LINE_TARGETS = "Cgroup1";

    await GET(request("?date=2026-07-25"));
    const firstKeys = pushCalls.map((c) => c.retryKey);

    pushCalls = [];
    // Second run: LINE answers 409 for the already-accepted key.
    pushBehavior = () => ({ status: "already_accepted" });
    const res = await GET(request("?date=2026-07-25"));

    expect(res.status).toBe(200);
    expect((await res.json()).sent).toBe(true);
    expect(pushCalls.map((c) => c.retryKey)).toEqual(firstKeys);
    for (const key of firstKeys) expect(key).toBeTruthy();
  });

  test("a different business date produces different retry keys", async () => {
    produceResult = { data: produceRows(), error: null };
    process.env.STOCK_SUMMARY_LINE_TARGETS = "Cgroup1";

    await GET(request("?date=2026-07-25"));
    const day1 = pushCalls.map((c) => c.retryKey);

    pushCalls = [];
    await GET(request("?date=2026-07-26"));
    const day2 = pushCalls.map((c) => c.retryKey);

    expect(day2).not.toEqual(day1);
  });

  test("House Stock is a separate priced message with separate retry namespace", async () => {
    produceResult = { data: produceRows(), error: null };
    physicalSnapshotResult = {
      data: [{
        id: "house-snapshot",
        business_date: "2026-08-03",
        parser_version: HOUSE_STOCK_PRICED_PARSER_VERSION,
      }],
      error: null,
    };
    physicalItemResult = {
      data: [{
        id: "house-item", snapshot_id: "house-snapshot", item_ordinal: 1,
        staff_sequence: 1, raw_text: "1 เขียวมรกต 30 บาท\n49.7 โล",
        raw_product_description: "เขียวมรกต", normalized_product: "เขียวมรกต",
        quantity: 49.7, unit_price_satang: 3000, raw_unit: "โล", normalized_unit: "โล",
        resolution_status: "ACCEPTED_NORMALIZED", reason: null, created_at: "2026-08-03T00:00:00Z",
      }],
      error: null,
    };
    process.env.STOCK_SUMMARY_LINE_TARGETS = "Cgroup1";

    const response = await GET(request("?date=2026-08-03"));
    const body = await response.json();
    const good = pushCalls.filter((call) => call.text.includes("สรุปของดีชั่งคืน"));
    const house = pushCalls.filter((call) => call.text.includes("สรุปสต๊อกคงเหลือในบ้าน"));
    expect(good.length).toBeGreaterThan(0);
    expect(house).toHaveLength(1);
    expect(good.every((call) => !call.text.includes("สรุปสต๊อกคงเหลือในบ้าน"))).toBe(true);
    expect(house[0]?.text).toContain("มูลค่า 1,491.00 บาท");
    expect(house[0]?.retryKey).not.toBe(good[0]?.retryKey);
    expect(body).toMatchObject({
      houseStockFound: true,
      houseStockItemCount: 1,
      houseStockGroupCount: 1,
      houseStockTotalValueSatang: 149100,
    });
  });

  test("no-snapshot date sends truthful separate House Stock message", async () => {
    process.env.STOCK_SUMMARY_LINE_TARGETS = "Cgroup1";
    await GET(request("?date=2026-08-03"));
    expect(pushCalls.map((call) => call.text).join("\n\n"))
      .toContain("ยังไม่มีการบันทึกผลไม้คงเหลือในบ้านสำหรับวันนี้");
  });

  test("legacy Physical Inventory snapshot does not fail the House Stock route", async () => {
    physicalSnapshotResult = {
      data: [{
        id: "legacy-snapshot",
        business_date: "2026-08-03",
        parser_version: PHYSICAL_INVENTORY_PARSER_VERSION,
      }],
      error: null,
    };
    physicalItemResult = {
      data: [{ unit_price_satang: null }],
      error: null,
    };
    process.env.STOCK_SUMMARY_LINE_TARGETS = "Cgroup1";

    const response = await GET(request("?date=2026-08-03"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.houseStockFound).toBe(false);
  });
});

describe("daily stock summary cron — QA/test-market exclusion", () => {
  test("the exact QA market ทดสอบ is excluded from the scheduled 08:00 report", async () => {
    produceResult = {
      data: [
        ...produceRows(),
        {
          market_name: "ทดสอบ",
          product_name: "หมอนทอง",
          quantity: 999,
          unit: "โล",
          transaction_type: TX_RETURN,
        },
      ],
      error: null,
    };
    process.env.STOCK_SUMMARY_LINE_TARGETS = "Cgroup1";

    const res = await GET(request("?date=2026-07-25"));
    const body = await res.json();

    expect(res.status).toBe(200);
    // Market/product counts reflect the excluded scope: still 2 markets (QA
    // never counted), and the QA quantity never joins หมอนทอง's total.
    expect(pushCalls[0].text).toContain("หมอนทอง — 281.1 กก.");
    expect(pushCalls[0].text).not.toContain("1280");
    expect(body.productCount).toBe(1);
  });

  test("a legitimate market whose name contains ทดสอบ is not excluded", async () => {
    produceResult = {
      data: [
        {
          market_name: "ตลาดทดสอบทองผาภูมิ",
          product_name: "แตงโม",
          quantity: 12,
          unit: "โล",
          transaction_type: TX_RETURN,
        },
      ],
      error: null,
    };
    process.env.STOCK_SUMMARY_LINE_TARGETS = "Cgroup1";

    await GET(request("?date=2026-07-25"));

    expect(pushCalls[0].text).toContain("แตงโม — 12 กก.");
  });
});

describe("daily stock summary cron — scheduled report date", () => {
  test("a scheduled run with no date param reports the previous business date", async () => {
    produceResult = { data: produceRows(), error: null };
    process.env.STOCK_SUMMARY_LINE_TARGETS = "Cgroup1";

    const res = await GET(request());
    const body = await res.json();

    // The route must not report the day currently in progress.
    const { previousBangkokBusinessDate } = await import("@/lib/summary/daily-stock-cron");
    expect(body.businessDate).toBe(previousBangkokBusinessDate());
  });

  test("scheduled delivery sends the all-market snapshot only", async () => {
    produceResult = { data: produceRows(), error: null };
    process.env.STOCK_SUMMARY_LINE_TARGETS = "Cgroup1";

    await GET(request("?date=2026-07-25"));
    const text = pushCalls.map((c) => c.text).join("\n\n");

    expect(text).toContain("📦 สรุปของดีชั่งคืนประจำวัน");
    expect(text).toContain("🥭 ทุเรียน");
    expect(text).toContain("หมอนทอง — 281.1 กก.");
    expect(text).not.toContain("⚠️ รายละเอียดข้อมูลผิดปกติ");
    expect(text).not.toContain("ปัญหา: ไม่พบรายการเบิกที่ตรงกัน");
    // … and no per-market detail block is appended.
    expect(text).not.toContain("เฉลิม72 ผลไม้: แก้วมังกร");
    expect(text).not.toContain("เหลือขายต่อ:");
    expect(text).not.toContain("เบิกทั้งหมด:");
    // No purchasing judgement of any kind.
    expect(text).not.toContain("เกณฑ์");
    expect(text).not.toContain("ควรซื้อ");
  });

  test("idempotency keys follow the resolved scheduled date, not wall-clock time", async () => {
    produceResult = { data: produceRows(), error: null };
    process.env.STOCK_SUMMARY_LINE_TARGETS = "Cgroup1";

    // Two scheduled runs on the same morning resolve the same date …
    await GET(request());
    const first = pushCalls.map((c) => c.retryKey);
    pushCalls = [];
    await GET(request());
    expect(pushCalls.map((c) => c.retryKey)).toEqual(first);

    // … and equal the keys for that date requested explicitly.
    const { previousBangkokBusinessDate, stockSummaryRetryKey } = await import(
      "@/lib/summary/daily-stock-cron"
    );
    expect(first[0]).toBe(stockSummaryRetryKey(previousBangkokBusinessDate(), "Cgroup1", 0));
  });
});

describe("daily stock summary cron — failure behavior", () => {
  test("returns 500 when the summary cannot be built", async () => {
    produceResult = { data: null, error: { message: "boom" } };
    process.env.STOCK_SUMMARY_LINE_TARGETS = "Cgroup1";

    const res = await GET(request("?date=2026-07-25"));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("boom");
    expect(pushCalls).toHaveLength(0);
  });

  test("isolates a failing target and reports 500 for monitoring", async () => {
    produceResult = { data: produceRows(), error: null };
    process.env.STOCK_SUMMARY_LINE_TARGETS = "Cgood,Cbad";
    pushBehavior = (call) => {
      if (call.to === "Cbad") throw new Error("LINE push HTTP 429");
      return { status: "delivered" };
    };

    const res = await GET(request("?date=2026-07-25"));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.sentCount).toBe(1);
    expect(body.failedCount).toBe(1);
    expect(pushCalls.some((c) => c.to === "Cgood")).toBe(true);
  });
});

describe("daily stock summary cron — debug mode", () => {
  test("previews without pushing", async () => {
    produceResult = { data: produceRows(), error: null };
    process.env.STOCK_SUMMARY_LINE_TARGETS = "Cgroup1";

    const res = await GET(request("?date=2026-07-25&debug=1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.debug).toBe(true);
    expect(body.wouldSendLine).toBe(true);
    expect(body.productCount).toBe(1);
    expect(body.incompleteCount).toBe(1);
    expect(body.isComplete).toBe(false);
    expect(body.anomalyCount).toBe(1);
    expect(body.anomalyMarketCount).toBe(1);
    expect(body.hasAnomalies).toBe(true);
    expect(body.messages[0]).toContain("📦 สรุปของดีชั่งคืนประจำวัน");
    expect(body.messages.join("\n\n")).not.toContain("⚠️ รายละเอียดข้อมูลผิดปกติ");
    expect(body.messages.join("\n\n")).not.toContain("ปัญหา:");
    expect(pushCalls).toHaveLength(0);
    expect(body.goodReturnMessages).toEqual(body.messages);
    expect(body.houseStockMessages[0]).toContain("สต๊อกคงเหลือในบ้าน");
    expect(body.houseStockFound).toBe(false);
  });
});

describe("daily stock summary cron — empty business date", () => {
  const REQUESTED = "2026-07-27";

  /** Nothing on the requested date; `latest` is what history holds. */
  function emptyDayWith(latest: { date: string; markets: string[] } | null) {
    produceByQuery = (filters) => {
      if (filters["lt:transaction_date"] === REQUESTED) {
        return { data: latest ? [{ transaction_date: latest.date }] : [], error: null };
      }
      if (latest && filters["eq:transaction_date"] === latest.date) {
        return { data: latest.markets.map((market_name) => ({ market_name })), error: null };
      }
      return { data: [], error: null };
    };
  }

  test("found: states the requested date is empty and points at the latest date", async () => {
    emptyDayWith({ date: "2026-07-26", markets: ["ตลาดกี้", "เฉลิม72 ผลไม้", "ตลาดกี้"] });
    process.env.STOCK_SUMMARY_LINE_TARGETS = "Cgroup1";

    const res = await GET(request(`?date=${REQUESTED}&debug=1`));
    const body = await res.json();
    const text = body.messages.join("\n\n");

    expect(res.status).toBe(200);
    expect(body.latestLookupStatus).toBe("found");
    expect(body.latestDataDate).toBe("2026-07-26");
    expect(body.latestDataMarketCount).toBe(2);
    expect(text).toContain("ยังไม่พบข้อมูลชั่งคืนประจำวันที่ 27 กรกฎาคม 2569");
    expect(text).toContain("ข้อมูลล่าสุดที่มีคือวันที่ 26 กรกฎาคม 2569");
    expect(text).toContain("พบข้อมูล 2 ตลาด");
    // The report is still ABOUT the requested date, and the misleading
    // completed-calculation header is gone.
    expect(text).toContain("ข้อมูลวันที่ 27 กรกฎาคม 2569");
    expect(text).not.toContain("ข้อมูลจาก 0 ตลาด • พบคงเหลือ 0 ตลาด");
  });

  test("none: says no ชั่งคืน exists when the query PROVED history is empty", async () => {
    emptyDayWith(null);
    process.env.STOCK_SUMMARY_LINE_TARGETS = "Cgroup1";

    await GET(request(`?date=${REQUESTED}`));
    const text = pushCalls.map((call) => call.text).join("\n\n");

    expect(text).toContain("ยังไม่พบข้อมูลชั่งคืนในระบบ");
    expect(text).not.toContain("ข้อมูลล่าสุดที่มีคือ");
    expect(text).not.toContain(LATEST_DATA_UNAVAILABLE_NOTICE);
  });

  test("unavailable: a failed date probe never becomes a 'no history' claim", async () => {
    produceByQuery = (filters) =>
      filters["lt:transaction_date"] === REQUESTED
        ? { data: null, error: { message: "probe exploded" } }
        : { data: [], error: null };
    process.env.STOCK_SUMMARY_LINE_TARGETS = "Cgroup1";

    const res = await GET(request(`?date=${REQUESTED}`));
    const text = pushCalls.map((call) => call.text).join("\n\n");

    // The empty state is still delivered in full …
    expect(res.status).toBe(200);
    expect(pushCalls).toHaveLength(3);
    expect(text).toContain("ยังไม่พบข้อมูลชั่งคืนประจำวันที่ 27 กรกฎาคม 2569");
    expect(text).toContain(LATEST_DATA_UNAVAILABLE_NOTICE);
    // … without telling the business its records are empty on the strength of
    // a database error, and without leaking the error text to LINE.
    expect(text).not.toContain("ยังไม่พบข้อมูลชั่งคืนในระบบ");
    expect(text).not.toContain("probe exploded");
  });

  test("unavailable: a date found but a failed market count is not a latest-date claim", async () => {
    produceByQuery = (filters) => {
      if (filters["lt:transaction_date"] === REQUESTED) {
        return { data: [{ transaction_date: "2026-07-26" }], error: null };
      }
      if (filters["eq:transaction_date"] === "2026-07-26") {
        return { data: null, error: { message: "count exploded" } };
      }
      return { data: [], error: null };
    };
    process.env.STOCK_SUMMARY_LINE_TARGETS = "Cgroup1";

    const res = await GET(request(`?date=${REQUESTED}&debug=1`));
    const body = await res.json();
    const text = body.messages.join("\n\n");

    expect(res.status).toBe(200);
    expect(body.latestLookupStatus).toBe("unavailable");
    expect(body.latestDataDate).toBeNull();
    expect(text).toContain(LATEST_DATA_UNAVAILABLE_NOTICE);
    // Half an answer is not offered as a whole one.
    expect(text).not.toContain("26 กรกฎาคม 2569");
    expect(text).not.toContain("ยังไม่พบข้อมูลชั่งคืนในระบบ");
  });

  test("a date WITH data never runs the lookup", async () => {
    let probed = false;
    produceByQuery = (filters) => {
      if (filters["lt:transaction_date"] !== undefined) probed = true;
      return null;
    };
    produceResult = { data: produceRows(), error: null };
    process.env.STOCK_SUMMARY_LINE_TARGETS = "Cgroup1";

    const res = await GET(request("?date=2026-07-25&debug=1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(probed).toBe(false);
    // null status = never attempted, distinct from all three real outcomes.
    expect(body.latestLookupStatus).toBeNull();
    expect(body.messages[0]).toContain("📦 สรุปของดีชั่งคืนประจำวัน");
    expect(body.messages.join("\n")).not.toContain(LATEST_DATA_UNAVAILABLE_NOTICE);
  });
});

/**
 * Production regression, business date 2026-08-10.
 *
 * One accountability round held a withdrawal labelled ทุ่งลานนา and returns
 * labelled วัดทุ่งลานนา; a second round held a withdrawal whose return was
 * refused by P4A and never landed. The 08:00 report reported the first as
 * "เบิก 0 / ไม่พบรายการเบิกที่ตรงกัน" and said nothing at all about the second.
 */
describe("daily stock summary cron — accountability round identity", () => {
  const LANNA = "d96d2898-43f7-4eeb-9477-5e8b942da477";
  const SAP_PHUN = "b0e8b69f-69b0-4af4-98ea-522bcd051d38";

  beforeEach(() => {
    produceResult = {
      data: [
        {
          market_name: "ทุ่งลานนา", product_name: "หมอนทอง", quantity: 20,
          unit: "โล", transaction_type: TX_WITHDRAW, price_per_unit: 40,
          accountability_round_id: LANNA,
        },
        {
          market_name: "วัดทุ่งลานนา", product_name: "หมอนทอง", quantity: 7,
          unit: "โล", transaction_type: TX_RETURN, accountability_round_id: LANNA,
        },
        {
          market_name: "ทรัพย์พัน2", product_name: "แอปเปิ้ล", quantity: 45,
          unit: "ลูก", transaction_type: TX_WITHDRAW, price_per_unit: 8,
          accountability_round_id: SAP_PHUN,
        },
      ],
      error: null,
    };
    roundResult = {
      data: [
        { id: LANNA, seller_label: "ดำ", market_label: "ทุ่งลานนา" },
        { id: SAP_PHUN, seller_label: "มิ้น", market_label: "ทรัพย์พัน2" },
      ],
      error: null,
    };
  });

  test("a return filed under the alias label never reports เบิก 0", async () => {
    const body = await (await GET(request("?debug=1&date=2026-08-10"))).json();
    const messages = body.messages.join("\n");

    expect(body.anomalyCount).toBe(0);
    expect(messages).not.toContain("ไม่พบรายการเบิกที่ตรงกัน");
    expect(messages).not.toContain("วัดทุ่งลานนา");
  });

  test("a refused return stays internal and does not dump diagnostics into the 08:00 message", async () => {
    pendingResult = {
      data: [{
        accountability_round_id: SAP_PHUN,
        finalization_status: "pending",
        accumulated_text: "มิ้น-ทรัพย์พัน2 ชั่งคืน\n1.แอปเปิ้ล8บาท\n45ลูก\nจบรายการชั่งคืน",
        close_requested_at: null,
      }],
      error: null,
    };

    const body = await (await GET(request("?debug=1&date=2026-08-10"))).json();
    const messages = body.messages.join("\n");

    expect(messages).not.toContain("⚠️ ตลาดที่มีเบิกแต่ยังไม่มีรายการคืนที่บันทึกสำเร็จ");
    expect(messages).not.toContain("ทรัพย์พัน2 — มิ้น");
    expect(messages).not.toContain("พบการส่งชั่งคืน แต่ยังบันทึกไม่สำเร็จ เนื่องจากรายการต้องแก้ไข");
    expect(messages).not.toContain("ทุ่งลานนา — ดำ");
  });

  test("with no return evidence the round diagnostics stay out of the scheduled LINE message", async () => {
    const body = await (await GET(request("?debug=1&date=2026-08-10"))).json();
    const messages = body.messages.join("\n");

    expect(messages).not.toContain("ทรัพย์พัน2 — มิ้น");
    expect(messages).not.toContain("เบิก 1 รายการ แต่ยังไม่พบรายการชั่งคืนที่บันทึกสำเร็จ");
  });
});
