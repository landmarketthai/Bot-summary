import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";
import {
  morningBriefRetryKey,
  purchasePlanningRetryKey,
  stockSummaryRetryKey,
} from "@/lib/summary/daily-stock-cron";

const serviceClient = { name: "service-client" };
let loadedReport: unknown = { businessDate: "2026-08-22", financial: [] };
let loadError: Error | null = null;
let loadCalls: Array<{ client: unknown; businessDate: string }> = [];
let formatterCalls: unknown[] = [];
let formatterMessages = ["🌅 สรุปเช้า — 22 สิงหาคม 2569"];
let pushCalls: Array<{ to: string; text: string; retryKey?: string }> = [];
let failingTarget: string | null = null;
let pdfCalls: Array<{ client: unknown; report: unknown }> = [];
let pdfError: Error | null = null;
let pdfUrl = "https://example.test/morning-brief.pdf?token=signed";

mock.module("@/lib/supabase/server", () => ({
  createServiceClient: () => serviceClient,
}));

mock.module("@/lib/summary/morning-brief-service", () => ({
  loadMorningBriefReport: async (client: unknown, businessDate: string) => {
    loadCalls.push({ client, businessDate });
    if (loadError) throw loadError;
    return loadedReport;
  },
}));

mock.module("@/lib/summary/morning-brief-message", () => ({
  buildMorningBriefMessages: (report: unknown) => {
    formatterCalls.push(report);
    return formatterMessages;
  },
}));

mock.module("@/lib/summary/morning-brief-pdf", () => ({
  createMorningBriefPdfArtifact: async (client: unknown, report: unknown) => {
    pdfCalls.push({ client, report });
    if (pdfError) throw pdfError;
    return { signedUrl: pdfUrl };
  },
  morningBriefPdfLineMessage: (url: string) => `PDF A4\n${url}`,
}));

mock.module("@/lib/line/reply", () => ({
  pushLineMessage: async (to: string, text: string, retryKey?: string) => {
    pushCalls.push({ to, text, retryKey });
    if (to === failingTarget) throw new Error("LINE unavailable");
    return { status: "delivered" };
  },
}));

const { GET } = await import("./route");

const originalSecret = process.env.CRON_SECRET;
const originalTargets = process.env.MORNING_BRIEF_LINE_TARGETS;
const realDateNow = Date.now;

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function request(query = "", authorization: string | null = "Bearer brief-secret") {
  return new NextRequest(`http://localhost/api/cron/daily-morning-brief${query}`, {
    headers: authorization ? { authorization } : {},
  });
}

beforeEach(() => {
  process.env.CRON_SECRET = "brief-secret";
  process.env.MORNING_BRIEF_LINE_TARGETS = "Cowner";
  loadedReport = { businessDate: "2026-08-22", financial: [] };
  loadError = null;
  loadCalls = [];
  formatterCalls = [];
  formatterMessages = ["🌅 สรุปเช้า — 22 สิงหาคม 2569"];
  pushCalls = [];
  failingTarget = null;
  pdfCalls = [];
  pdfError = null;
  pdfUrl = "https://example.test/morning-brief.pdf?token=signed";
  Date.now = realDateNow;
});

afterEach(() => {
  restore("CRON_SECRET", originalSecret);
  restore("MORNING_BRIEF_LINE_TARGETS", originalTargets);
  Date.now = realDateNow;
});

describe("daily morning brief cron", () => {
  test("rejects unauthorized calls and fails closed without CRON_SECRET", async () => {
    expect((await GET(request("", null))).status).toBe(401);
    expect((await GET(request("", "Bearer wrong"))).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await GET(request())).status).toBe(500);
    expect(loadCalls).toHaveLength(0);
    expect(pushCalls).toHaveLength(0);
  });

  test("rejects a malformed ?date= before loading or sending anything", async () => {
    const response = await GET(request("?date=not-a-date"));
    expect(response.status).toBe(400);
    expect(loadCalls).toHaveLength(0);
  });

  test("morning 23/08/2569 loads and formats the PREVIOUS business date, 22/08/2569", async () => {
    Date.now = () => Date.UTC(2026, 7, 23, 1, 15);

    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(loadCalls).toEqual([{ client: serviceClient, businessDate: "2026-08-22" }]);
    expect(formatterCalls).toEqual([loadedReport]);
  });

  test("an explicit ?date= is used verbatim, never shifted", async () => {
    await GET(request("?date=2026-01-05"));
    expect(loadCalls).toEqual([{ client: serviceClient, businessDate: "2026-01-05" }]);
  });

  test("pushes every formatter chunk in order with deterministic distinct keys", async () => {
    formatterMessages = ["part 1", "part 2", "part 3"];

    await GET(request("?date=2026-08-22"));
    expect(pushCalls.map(({ to, text }) => ({ to, text }))).toEqual([
      { to: "Cowner", text: "part 1" },
      { to: "Cowner", text: "part 2" },
      { to: "Cowner", text: "part 3" },
      { to: "Cowner", text: `PDF A4\n${pdfUrl}` },
    ]);
    expect(new Set(pushCalls.map((call) => call.retryKey)).size).toBe(4);
    expect(pdfCalls).toEqual([{ client: serviceClient, report: loadedReport }]);

    const firstKeys = pushCalls.map((call) => call.retryKey);
    pushCalls = [];
    await GET(request("?date=2026-08-22"));
    expect(pushCalls.map((call) => call.retryKey)).toEqual(firstKeys);
  });

  test("retry-key namespace never collides with the existing report crons for the same date/target/part", async () => {
    const briefKey = morningBriefRetryKey("2026-08-22", "Cowner", 0);
    const purchaseKey = purchasePlanningRetryKey("2026-08-22", "Cowner", 0);
    const stockKey = stockSummaryRetryKey("2026-08-22", "Cowner", 0);
    expect(briefKey).not.toBe(purchaseKey);
    expect(briefKey).not.toBe(stockKey);

    await GET(request("?date=2026-08-22"));
    expect(pushCalls[0]!.retryKey).toBe(briefKey);
  });

  test("manual target override isolates a UAT send from configured production targets", async () => {
    const response = await GET(request("?date=2026-09-17&target=C12345678901"));
    expect(response.status).toBe(200);
    expect(pushCalls.length).toBeGreaterThan(0);
    expect(pushCalls.every((call) => call.to === "C12345678901")).toBe(true);
  });

  test("rejects malformed manual target override before report loading", async () => {
    const response = await GET(request("?date=2026-09-17&target=bad-target"));
    expect(response.status).toBe(400);
    expect(loadCalls).toHaveLength(0);
    expect(pushCalls).toHaveLength(0);
  });

  test("debug returns exact messages without sending LINE", async () => {
    formatterMessages = ["part 1", "part 2"];
    const response = await GET(request("?date=2026-08-22&debug=1"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      debug: true,
      businessDate: "2026-08-22",
      messageCount: 2,
      messages: formatterMessages,
    });
    expect(pushCalls).toHaveLength(0);
    expect(pdfCalls).toHaveLength(0);
  });

  test("no targets configured is a successful no-op, not a failure", async () => {
    delete process.env.MORNING_BRIEF_LINE_TARGETS;
    const response = await GET(request("?date=2026-08-22"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sent: false, reason: "no_targets_configured" });
    expect(pushCalls).toHaveLength(0);
  });

  test("loader or formatter failure returns 500 without LINE delivery", async () => {
    loadError = new Error("report unavailable");
    expect((await GET(request("?date=2026-08-22"))).status).toBe(500);
    expect(pushCalls).toHaveLength(0);
  });

  test("PDF failure keeps the text brief deliverable but returns 500 for recovery", async () => {
    pdfError = new Error("storage unavailable");
    formatterMessages = ["part 1", "part 2"];

    const response = await GET(request("?date=2026-08-22"));
    expect(response.status).toBe(500);
    expect(pushCalls.map((call) => call.text)).toEqual(["part 1", "part 2"]);
    expect(await response.json()).toMatchObject({ sent: true, sentCount: 1, pdfFailed: true });
  });

  test("isolates target failures and reports the partial failure", async () => {
    process.env.MORNING_BRIEF_LINE_TARGETS = "Cbroken,Cowner";
    formatterMessages = ["part 1", "part 2"];
    failingTarget = "Cbroken";

    const response = await GET(request("?date=2026-08-22"));
    expect(response.status).toBe(500);
    expect(pushCalls.map((call) => call.to)).toEqual(["Cbroken", "Cowner", "Cowner", "Cowner"]);
    expect(await response.json()).toMatchObject({ sent: true, sentCount: 1, failedCount: 1 });
  });
});
