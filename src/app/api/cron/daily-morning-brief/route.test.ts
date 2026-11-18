import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { NextRequest } from "next/server";
import type { BriefDelivery, BriefPayload } from "@/lib/summary/morning-brief-delivery";
let deliveryRows = new Map<string, BriefDelivery & { leaseUntil: number; firstAttempt: number | null; frozenAt: number | null }>();
let allowPreflight = true;
let stateUnavailable = false;
let failPart: string | null = null;
let unknownAccepted = false;
let preflightArgs: Record<string, unknown> | undefined;
let parityResult: Record<string, unknown>;
import {
  morningBriefRetryKey,
  purchasePlanningRetryKey,
  stockSummaryRetryKey,
} from "@/lib/summary/daily-stock-cron";

let markerSourceId: string | null = "Cmarker12345678901";
let markerLookupError: Error | null = null;
let markerOps: Array<[string, ...unknown[]]> = [];
const markerQuery = {
  select: (columns: string) => (markerOps.push(["select", columns]), markerQuery),
  eq: (column: string, value: unknown) => (markerOps.push(["eq", column, value]), markerQuery),
  order: (column: string, options: unknown) => (markerOps.push(["order", column, options]), markerQuery),
  limit: (value: number) => (markerOps.push(["limit", value]), markerQuery),
  maybeSingle: async () => ({
    data: markerSourceId ? { source_id: markerSourceId } : null,
    error: markerLookupError ? { message: markerLookupError.message } : null,
  }),
};
const serviceClient = {
  name: "service-client",
  from: (table: string) => (markerOps.push(["from", table]), markerQuery),
  rpc: async (name: string, args: Record<string, unknown>) => {
    if (stateUnavailable) return { data: null, error: { message: "offline" } };
    if (name === "morning_brief_context") return { data: { readiness: { status: "ready", reasons: [] }, roundMarkets: {} }, error: null };
    if (name === "morning_brief_target_parity") return { data: parityResult, error: null };
    if (name === "morning_brief_delivery_status") return { data: {
      acceptedCount: [...deliveryRows.values()].filter((row) => row.state === "accepted").length,
      pendingCount: [...deliveryRows.values()].filter((row) => row.state === "pending").length,
      reviewCount: [...deliveryRows.values()].filter((row) => row.state === "needs_review" || (row.state === "pending"
        && ((row.firstAttempt !== null && Date.now()-row.firstAttempt>=23*3600_000)
          || (row.frozenAt !== null && Date.now()-row.frozenAt>=6*24*3600_000)))).length,
    }, error: null };
    if (name === "morning_brief_should_invoke") { preflightArgs = args; return { data: allowPreflight, error: null }; }
    const key = `${args.p_date}/${args.p_scope}/${args.p_target}`;
    let row = deliveryRows.get(key);
    if (!row) {
      row = { state: "pending", lease_token: "", leaseUntil: 0, firstAttempt: null, frozenAt: null, payload: null, next_part: 0 };
      deliveryRows.set(key, row);
    }
    if (row.state !== "pending") return { data: { ...row }, error: null };
    if ((row.firstAttempt !== null && Date.now() - row.firstAttempt >= 23 * 3600_000)
      || (row.frozenAt !== null && Date.now() - row.frozenAt >= 6 * 24 * 3600_000)) {
      row.state = "needs_review";
      return { data: { ...row }, error: null };
    }
    if (args.p_action === "claim") {
      if (row.leaseUntil > Date.now()) return { data: { state: "busy" }, error: null };
      row.lease_token = crypto.randomUUID(); row.leaseUntil = Date.now() + 300_000;
    } else {
      if (row.lease_token !== args.p_token || row.leaseUntil <= Date.now()) throw new Error("lost lease");
      if (args.p_action === "freeze") {
        const payload = args.p_payload as BriefPayload | null;
        if (!Array.isArray(payload?.parts) || !payload.parts.length) throw new Error("missing delivery parts");
        if (!row.payload) { row.payload = payload; row.frozenAt = Date.now(); }
      }
      if (["prepare", "accept"].includes(String(args.p_action)) && (!row.payload || args.p_part !== row.next_part)) throw new Error("invalid part");
      if (args.p_action === "accept" && row.firstAttempt === null) throw new Error("invalid part");
      if (args.p_action === "prepare") row.firstAttempt ??= Date.now();
      if (args.p_action === "accept") {
        row.next_part++;
        if (row.next_part === row.payload!.parts.length) row.state = "accepted";
      }
      if (args.p_action === "release") row.leaseUntil = 0;
    }
    return { data: { ...row }, error: null };
  },
};
let loadedReport: unknown = { businessDate: "2026-08-22", financial: [] };
let loadError: Error | null = null;
let loadCalls: Array<{ client: unknown; businessDate: string; reportScope: string }> = [];
let formatterCalls: unknown[] = [];
let formatterMessages = ["🌅 สรุปเช้า — 22 สิงหาคม 2569"];
let pushCalls: Array<{ to: string; text: string; retryKey?: string }> = [];
let acceptedRetryKeys = new Set<string>();
let failingTarget: string | null = null;
let pdfCalls: Array<{ client: unknown; report: unknown }> = [];
let pdfError: Error | null = null;
let pdfUrl = "https://example.test/morning-brief.pdf?token=signed";

mock.module("@/lib/supabase/server", () => ({
  createServiceClient: () => serviceClient,
}));

mock.module("@/lib/summary/morning-brief-service", () => ({
  loadMorningBriefReport: async (client: unknown, businessDate: string, reportScope: string) => {
    loadCalls.push({ client, businessDate, reportScope });
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
    return { signedUrl: pdfUrl, path: "synthetic/report.pdf" };
  },
  morningBriefPdfLineMessage: (url: string) => `PDF A4\n${url}`,
}));

mock.module("@/lib/line/reply", () => ({
  pushLineMessage: async (to: string, text: string, retryKey?: string) => {
    pushCalls.push({ to, text, retryKey });
    if (to === failingTarget) throw new Error("LINE unavailable");
    if (retryKey && acceptedRetryKeys.has(retryKey)) return { status: "already_accepted" };
    if (text === failPart && !unknownAccepted) throw new Error("rejected");
    if (retryKey) acceptedRetryKeys.add(retryKey);
    if (text === failPart) throw new Error("response lost after acceptance");
    return { status: "delivered" };
  },
}));

const { GET } = await import("./route");

const originalSecret = process.env.CRON_SECRET;
const originalTargets = process.env.MORNING_BRIEF_LINE_TARGETS;
const originalVegetableTargets = process.env.MORNING_BRIEF_VEGETABLE_LINE_TARGETS;
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
  delete process.env.MORNING_BRIEF_VEGETABLE_LINE_TARGETS;
  process.env.CRON_SECRET = "brief-secret";
  process.env.MORNING_BRIEF_LINE_TARGETS = "Cowner";
  markerSourceId = "Cmarker12345678901";
  markerLookupError = null;
  markerOps = [];
  loadedReport = { businessDate: "2026-08-22", financial: [] };
  loadError = null;
  loadCalls = [];
  formatterCalls = [];
  formatterMessages = ["🌅 สรุปเช้า — 22 สิงหาคม 2569"];
  pushCalls = [];
  acceptedRetryKeys = new Set();
  failingTarget = null;
  pdfCalls = [];
  pdfError = null;
  pdfUrl = "https://example.test/morning-brief.pdf?token=signed";
  Date.now = () => Date.UTC(2026, 7, 23, 5, 0);
  deliveryRows = new Map(); allowPreflight = true; stateUnavailable = false; failPart = null; unknownAccepted = false;
  preflightArgs = undefined;
  parityResult = { matched: true, configuredCount: 1, requestedCount: 1, missingCount: 0, excessCount: 0 };
});

afterEach(() => {
  restore("MORNING_BRIEF_VEGETABLE_LINE_TARGETS", originalVegetableTargets);
  restore("CRON_SECRET", originalSecret);
  restore("MORNING_BRIEF_LINE_TARGETS", originalTargets);
  Date.now = realDateNow;
});

describe("daily morning brief cron", () => {
  test.each([[1,0],[0,1],[1,1]])("target parity rejects missing=%i excess=%i before claims, render or push", async (missing, excess) => {
    parityResult = { matched: false, configuredCount: 2, requestedCount: 2, missingCount: missing, excessCount: excess,
      target_keys: ["private-hash"], command_template: "private-command" };
    const response = await GET(request());
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toEqual({ ok: false, status: "target_config_mismatch", sent: false,
      configuredCount: 2, requestedCount: 2, missingCount: missing, excessCount: excess });
    expect(deliveryRows.size).toBe(0);
    expect(loadCalls).toHaveLength(0); expect(pdfCalls).toHaveLength(0); expect(pushCalls).toHaveLength(0);
    expect(preflightArgs).toBeUndefined();
  });
  test("isolated manual UAT and debug do not require dispatcher config", async () => {
    parityResult = { matched: false };
    expect((await GET(request("?debug=1"))).status).toBe(200);
    expect(deliveryRows.size).toBe(0); expect(pushCalls).toHaveLength(0);
    expect((await GET(request("?target=C12345678901"))).status).toBe(200);
    expect(pushCalls.every((call) => call.to === "C12345678901")).toBe(true);
  });
  test("repeat acceptance is reported as previous, including mixed accepted and unready recipients", async () => {
    const first = await GET(request());
    expect(await first.json()).toMatchObject({ sent: true, newlyAcceptedCount: 1, previouslyAcceptedCount: 0 });
    const repeat = await GET(request());
    expect(await repeat.json()).toMatchObject({ sent: false, sentCount: 0, newlyAcceptedCount: 0, previouslyAcceptedCount: 1, pdfDelivered: false });
    process.env.MORNING_BRIEF_LINE_TARGETS = "Cowner,Cother";
    loadedReport = { readiness: { status: "not_ready", reasons: ["unresolved_vegetable_document"] } };
    const mixed = await GET(request());
    expect(await mixed.json()).toMatchObject({ status: "not_ready", sent: false, newlyAcceptedCount: 0, previouslyAcceptedCount: 1 });
    expect(pushCalls).toHaveLength(2);
  });
  test("review takes precedence over an unready recipient", async () => {
    await GET(request());
    [...deliveryRows.values()][0].state = "needs_review";
    process.env.MORNING_BRIEF_LINE_TARGETS = "Cowner,Cother";
    loadedReport = { readiness: { status: "not_ready", reasons: ["unresolved_vegetable_document"] } };
    const response = await GET(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ status: "needs_review", reviewCount: 1, sent: false });
    expect(pushCalls).toHaveLength(2);
  });
  test("a repeated vegetable cron is accepted once while fruit remains a separate delivery", async () => {
    Date.now = () => Date.UTC(2026, 7, 23, 7, 0);
    const query = "?date=2026-08-22&target=C12345678901";
    await GET(request(`${query}&scope=vegetable`));
    const accepted = acceptedRetryKeys.size;
    expect(accepted).toBe(2);
    await GET(request(`${query}&scope=vegetable`));
    expect(acceptedRetryKeys.size).toBe(accepted);
    await GET(request(`${query}&scope=fruit`));
    expect(acceptedRetryKeys.size).toBe(accepted * 2);
  });
  test("rejects an unknown report scope before reading data", async () => {
    expect((await GET(request("?scope=all"))).status).toBe(400);
    expect(loadCalls).toHaveLength(0);
  });

  test("not_ready never formats, renders, uploads or delivers a vegetable report", async () => {
    Date.now = () => Date.UTC(2026, 7, 23, 7, 0);
    process.env.MORNING_BRIEF_VEGETABLE_LINE_TARGETS = "Cvegetable";
    loadedReport = { readiness: { status: "not_ready", reasons: ["missing_good_return"] } };
    const response = await GET(request("?date=2026-08-22&scope=vegetable"));
    expect(await response.json()).toMatchObject({ status: "not_ready", sent: false, pdfDelivered: false });
    expect(formatterCalls).toHaveLength(0);
    expect(pdfCalls).toHaveLength(0);
    expect(pushCalls).toHaveLength(0);
  });

  test("vegetable recipients never fall back to fruit recipients", async () => {
    Date.now = () => Date.UTC(2026, 7, 23, 7, 0);
    const response = await GET(request("?scope=vegetable"));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ status: "target_config_mismatch" });
    expect(pushCalls).toHaveLength(0);
    process.env.MORNING_BRIEF_VEGETABLE_LINE_TARGETS = "Cvegetable";
    await GET(request("?scope=vegetable"));
    expect(pushCalls.every((call) => call.to === "Cvegetable")).toBe(true);
    expect(loadCalls.every((call) => call.reportScope === "vegetable")).toBe(true);
  });

  test("PDF retry identity does not depend on text message count", async () => {
    Date.now = () => Date.UTC(2026, 7, 23, 7, 0);
    await GET(request("?date=2026-08-22&scope=vegetable" + "&target=C12345678901"));
    const firstPdfKey = pushCalls.at(-1)?.retryKey;
    formatterMessages = ["part 1", "part 2"];
    await GET(request("?date=2026-08-22&scope=vegetable&target=C12345678901"));
    expect(pushCalls.at(-1)?.retryKey).toBe(firstPdfKey);
  });
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
    Date.now = () => Date.UTC(2026, 7, 23, 5, 0);

    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(loadCalls).toEqual([{ client: serviceClient, businessDate: "2026-08-22", reportScope: "fruit" }]);
    expect(formatterCalls).toEqual([loadedReport]);
  });

  test("an explicit ?date= is used verbatim, never shifted", async () => {
    await GET(request("?date=2026-01-05"));
    expect(loadCalls).toEqual([{ client: serviceClient, businessDate: "2026-01-05", reportScope: "fruit" }]);
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

    pushCalls = [];
    await GET(request("?date=2026-08-22"));
    expect(pushCalls).toHaveLength(0);
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

  test("exact marker resolves the newest matching LINE group source for UAT", async () => {
    const response = await GET(request("?date=2026-09-17&target_marker=Make%20down"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ targetCount: 1, sentCount: 1 });
    expect(pushCalls.every((call) => call.to === "Cmarker12345678901")).toBe(true);
    expect(markerOps).toEqual([
      ["from", "raw_messages"],
      ["select", "source_id"],
      ["eq", "raw_text", "Make down"],
      ["eq", "source_type", "group"],
      ["order", "created_at", { ascending: false }],
      ["limit", 1],
    ]);
  });

  test("marker targeting fails closed on ambiguity or a missing marker match", async () => {
    const ambiguous = await GET(request("?date=2026-09-17&target=C12345678901&target_marker=Make%20down"));
    expect(ambiguous.status).toBe(400);
    expect(loadCalls).toHaveLength(0);
    expect(pushCalls).toHaveLength(0);

    markerSourceId = null;
    const missing = await GET(request("?date=2026-09-17&target_marker=Make%20down"));
    expect(missing.status).toBe(404);
    expect(loadCalls).toHaveLength(0);
    expect(pushCalls).toHaveLength(0);
  });

  test("manual retry nonce cannot bypass an accepted delivery", async () => {
    await GET(request("?date=2026-09-17&target=C12345678901"));
    pushCalls = [];
    expect((await GET(request("?date=2026-09-17&target=C12345678901&retry_nonce=uat2"))).status).toBe(400);
    expect(pushCalls).toHaveLength(0);
  });

  test("retry nonce is rejected without a manual target", async () => {
    const response = await GET(request("?date=2026-09-17&retry_nonce=uat2"));
    expect(response.status).toBe(400);
    expect(pushCalls).toHaveLength(0);
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

  test("absent configured targets fail closed without claims or delivery", async () => {
    delete process.env.MORNING_BRIEF_LINE_TARGETS;
    const response = await GET(request("?date=2026-08-22"));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ sent: false, status: "target_config_mismatch" });
    expect(pushCalls).toHaveLength(0);
  });

  test("loader or formatter failure returns 500 without LINE delivery", async () => {
    loadError = new Error("report unavailable");
    expect((await GET(request("?date=2026-08-22"))).status).toBe(500);
    expect(pushCalls).toHaveLength(0);
  });

  test("PDF failure sends nothing until the complete artifact is available", async () => {
    pdfError = new Error("storage unavailable");
    formatterMessages = ["part 1", "part 2"];

    const response = await GET(request("?date=2026-08-22"));
    expect(response.status).toBe(500);
    expect(pushCalls).toHaveLength(0);
    expect(await response.json()).toMatchObject({ sent: false, failedCount: 1, pdfDelivered: false });
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

  test("concurrent requests claim once, and acceptance survives later calls", async () => {
    const responses = await Promise.all([GET(request()), GET(request()), GET(request())]);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(pushCalls).toHaveLength(2);
    expect(pdfCalls).toHaveLength(1);
    await GET(request());
    expect(pushCalls).toHaveLength(2);
  });

  test.each([false, true])("partial/unknown part resumes with frozen body and key: %s", async (unknown) => {
    formatterMessages = ["part 1", "part 2"];
    failPart = "part 2"; unknownAccepted = unknown;
    expect((await GET(request())).status).toBe(500);
    expect([...deliveryRows.values()][0].next_part).toBe(1);
    const originalKey = pushCalls[1].retryKey;
    formatterMessages = ["changed after attempt"];
    loadedReport = { readiness: { status: "not_ready", reasons: ["data changed after freeze"] } };
    pdfUrl = "https://example.test/changed";
    failPart = null;
    await GET(request());
    expect(pushCalls.map((call) => call.text)).toEqual(["part 1", "part 2", "part 2", "PDF A4\nhttps://example.test/morning-brief.pdf?token=signed"]);
    expect(pushCalls[2].retryKey).toBe(originalKey);
    expect(pdfCalls).toHaveLength(1);
    expect([...deliveryRows.values()][0].state).toBe("accepted");
  });

  test("stale claim resumes with the same frozen key after lease expiry", async () => {
    const query = "?date=2026-08-22&target=C12345678901";
    failPart = formatterMessages[0]; unknownAccepted = true;
    await GET(request(query));
    const row = [...deliveryRows.values()][0];
    row.leaseUntil = Date.now() + 300_000;
    await GET(request(query));
    expect(pushCalls).toHaveLength(1);
    const initialNow = Date.now();
    Date.now = () => initialNow + 301_000;
    failPart = null;
    await GET(request(query));
    expect(row.state).toBe("accepted");
    expect(pushCalls[1].retryKey).toBe(pushCalls[0].retryKey);
    expect(pdfCalls).toHaveLength(1);
  });

  test("a 23h unknown outcome is held for review", async () => {
    failPart = formatterMessages[0]; unknownAccepted = true;
    await GET(request());
    const row = [...deliveryRows.values()][0];
    row.leaseUntil = Date.now() + 300_000;
    await GET(request());
    expect(pushCalls).toHaveLength(1);
    const initialNow = Date.now();
    failPart = null;
    Date.now = () => initialNow + 24 * 3600_000;
    await GET(request("?date=2026-08-22"));
    expect(row.state).toBe("needs_review");
    expect(pushCalls).toHaveLength(1);
  });

  test("preflight skip exposes expired unknown delivery as actionable review", async () => {
    failPart = formatterMessages[0]; unknownAccepted = true;
    await GET(request());
    const initialNow = Date.now();
    Date.now = () => initialNow + 24*3600_000;
    allowPreflight = false;
    const response = await GET(request("?date=2026-08-22"));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, status: "needs_review", deliveryStatus: { reviewCount: 1 }, sent: false });
    expect(pushCalls).toHaveLength(1);
  });

  test("preflight/state errors fail closed before loading or sending", async () => {
    allowPreflight = false;
    await GET(request());
    expect(loadCalls).toHaveLength(0);
    stateUnavailable = true;
    const unavailable = await GET(request());
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ status: "schema_unavailable", stage: "context", sent: false });
    expect(deliveryRows.size).toBe(0);
    expect(pdfCalls).toHaveLength(0);
    expect(pushCalls).toHaveLength(0);
  });

  test("after 18:05 configured vegetables return outside_window and do no work", async () => {
    process.env.MORNING_BRIEF_VEGETABLE_LINE_TARGETS = "Cvegetable";
    Date.now = () => Date.UTC(2026, 7, 23, 11, 5);
    const response = await GET(request("?scope=vegetable"));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, status: "outside_window" });
    expect(loadCalls).toHaveLength(0);
    expect(pushCalls).toHaveLength(0);
  });

  test.each(["12:00:59", "12:01:30", "12:04:59"])("configured Fruit tolerates delayed arrival %s and dedupes", async (time) => {
    Date.now = () => Date.parse(`2026-08-23T${time}+07:00`);
    expect((await GET(request())).status).toBe(200);
    expect((await GET(request())).status).toBe(200);
    expect(pushCalls).toHaveLength(2);
    expect(deliveryRows.size).toBe(1);
  });

  test("one captured arrival controls TS and SQL when clocks straddle the grace boundary", async () => {
    let calls = 0;
    const arrival = Date.parse("2026-08-23T12:04:59+07:00");
    Date.now = () => arrival + (calls++ ? 2_000 : 0);
    expect((await GET(request())).status).toBe(200);
    expect(preflightArgs?.p_now).toBe(new Date(arrival).toISOString());
    expect(pushCalls).toHaveLength(2);
  });

  test("runtime budget leaves a frozen partial delivery for bounded retry", async () => {
    const timer = spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(195_001);
    try {
      const response = await GET(request());
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ status: "pending", deferredCount: 1, sent: false });
      expect(pushCalls).toHaveLength(1);
      expect([...deliveryRows.values()][0].next_part).toBe(1);
    } finally { timer.mockRestore(); }
    formatterMessages = ["changed"];
    expect((await GET(request())).status).toBe(200);
    expect(pushCalls.map((call) => call.text)).toEqual(["🌅 สรุปเช้า — 22 สิงหาคม 2569", "PDF A4\nhttps://example.test/morning-brief.pdf?token=signed"]);
    expect([...deliveryRows.values()][0].state).toBe("accepted");
  });
});
