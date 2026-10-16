import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { pushLineMessage } from "@/lib/line/reply";
import { createDailyDataQualityAlertHandler, dailyDataQualityRetryKey } from "./daily-line-alert-handler";
import type { DailyLineAlert } from "./daily-line-alert";

const SECRET = "fixture-cron-placeholder";
const TARGET = `C${"a".repeat(32)}`;
const DATE = "2026-10-15";
const alert: DailyLineAlert = {
  businessDate: DATE, text: "แจ้งตรวจคุณภาพข้อมูลประจำวัน", counts: {
    critical: 1, actionRequired: 0, materialReturnExceeds: 0, selectedIssues: 1,
    unknownProductIssues: 0, produceItems: 1, anomalyItems: 1, anomalyNames: 1,
    uncategorizedItems: 1, uncategorizedNames: 1, missingCodeItems: 1, missingCodeNames: 1,
    approvedMissingCategoryItems: 0, approvedMissingCategoryNames: 0, omittedNames: 0,
  },
};
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function harness(options: {
  env?: { CRON_SECRET?: string; BOT_SUMMARY_DQ_ALERT_ENABLED?: string; BOT_SUMMARY_DQ_ALERT_TEST_GROUP_ID?: string };
  readError?: boolean; push?: typeof pushLineMessage;
} = {}) {
  const loads: string[] = [], sends: unknown[][] = [], logs: string[] = [];
  const env = options.env ?? { CRON_SECRET: SECRET, BOT_SUMMARY_DQ_ALERT_ENABLED: "true", BOT_SUMMARY_DQ_ALERT_TEST_GROUP_ID: TARGET };
  const handler = createDailyDataQualityAlertHandler({
    env: () => env,
    load: async (date) => { loads.push(date); if (options.readError) throw new Error(`secret-token ${TARGET} raw-chat`); return alert; },
    push: async (to, text, key) => { sends.push([to, text, key]); return options.push ? options.push(to, text, key) : { status: "delivered" }; },
    logError: (event) => { logs.push(event); },
    now: () => Date.parse("2026-10-16T04:00:00+07:00"),
  });
  const call = (query = "", auth: string | null = `Bearer ${SECRET}`, method = "GET") => handler(new Request(`https://fixture.invalid/api/cron/daily-data-quality-alert${query}`, {
    method, headers: auth === null ? {} : { authorization: auth },
  }));
  return { call, loads, sends, logs, env };
}

describe("authenticated manual daily DQ alert handler", () => {
  test("auth required even for debug; missing secret is a configuration error", async () => {
    const missing = harness({ env: {} });
    expect((await missing.call("?debug=1")).status).toBe(500);
    expect(missing.loads).toHaveLength(0);
    for (const auth of [null, "Bearer wrong", "bearer fixture-cron-placeholder", `Bearer ${SECRET} extra`]) {
      const h = harness();
      const response = await h.call("?debug=1", auth);
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain(SECRET);
      expect(h.loads).toHaveLength(0);
      expect(h.sends).toHaveLength(0);
    }
  });
  test("inactive without exact activation AND exact test-group target, with no DB read", async () => {
    for (const enabled of [undefined, "", "false", "TRUE", "1", " true", "true"]) {
      for (const target of [undefined, "", "Cabc", `U${"a".repeat(32)}`, `R${"a".repeat(32)}`, `C${"A".repeat(32)}`, `${TARGET} `, `${TARGET}\n`, TARGET]) {
        if (enabled === "true" && target === TARGET) continue;
        const h = harness({ env: { CRON_SECRET: SECRET, BOT_SUMMARY_DQ_ALERT_ENABLED: enabled, BOT_SUMMARY_DQ_ALERT_TEST_GROUP_ID: target } });
        const response = await h.call();
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true, status: "inactive", sent: false, businessDate: DATE });
        expect(h.loads).toHaveLength(0);
        expect(h.sends).toHaveLength(0);
      }
    }
  });
  test("real strict ISO date and strict query allowlist, never target overrides", async () => {
    for (const query of ["?date=", "?date=2026-02-29", "?date=2026-04-31", "?date=2026-1-01", "?date=15/10/2026", "?date=2026-10-15%20",
      "?date=2026-10-15&date=2026-10-14", "?debug=1&debug=0", "?debug=true", "?debug=", `?debug=1&target=${TARGET}`, "?to=anything"]) {
      const h = harness();
      expect((await h.call(query)).status).toBe(400);
      expect(h.loads).toHaveLength(0);
      expect(h.sends).toHaveLength(0);
    }
    const h = harness();
    expect((await h.call("?date=2024-02-29&debug=1")).status).toBe(200);
    expect(h.loads).toEqual(["2024-02-29"]);
  });
  test("debug=1 always previews, with or without activation/target", async () => {
    for (const env of [{ CRON_SECRET: SECRET }, undefined]) {
      const h = harness({ env });
      const response = await h.call("?debug=1");
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ ok: true, status: "preview", previewOnly: true, sent: false, text: alert.text });
      expect(h.loads).toEqual([DATE]);
      expect(h.sends).toHaveLength(0);
    }
  });
  test("intentional active GET sends once per invocation with deterministic key and no target in response", async () => {
    const h = harness();
    for (const query of ["", `?date=${DATE}&debug=0`]) {
      const response = await h.call(query);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, status: "delivered", sent: true, businessDate: DATE });
    }
    expect(h.sends).toEqual(Array(2).fill([TARGET, alert.text, dailyDataQualityRetryKey(DATE, TARGET)]));
    expect(h.logs).toHaveLength(0);
  });
  test("stable SHA-256 UUID does not include content/revision and differs by date/target", () => {
    const key = dailyDataQualityRetryKey(DATE, TARGET);
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(dailyDataQualityRetryKey(DATE, TARGET)).toBe(key);
    expect(dailyDataQualityRetryKey("2026-10-14", TARGET)).not.toBe(key);
    expect(dailyDataQualityRetryKey(DATE, `C${"b".repeat(32)}`)).not.toBe(key);
    const source = readFileSync(new URL("./daily-line-alert-handler.ts", import.meta.url), "utf8");
    expect(source).toContain('createHash("sha256")');
    expect(source).toContain('`daily-data-quality-alert:${date}:${target}`');
  });
  test("read failures fail 500 without sending, expose no error details or false zero", async () => {
    for (const query of ["", "?debug=1"]) {
      const h = harness({ readError: true });
      const response = await h.call(query);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ ok: false, sent: false, error: "data_unavailable" });
      expect(h.sends).toHaveLength(0);
      expect(h.logs).toEqual(["daily_data_quality_alert_read_failed"]);
    }
  });
  test("HEAD cannot invoke the send handler", async () => {
    const h = harness();
    expect((await h.call("", `Bearer ${SECRET}`, "HEAD")).status).toBe(405);
    expect(h.loads).toHaveLength(0);
    expect(h.sends).toHaveLength(0);
  });
  test("real push helper uses exact target/retry header; mocked LINE 409 is successful", async () => {
    const requests: RequestInit[] = [];
    globalThis.fetch = (async (url, init) => {
      expect(String(url)).toBe("https://api.line.me/v2/bot/message/push");
      requests.push(init!);
      return new Response("private response body", { status: requests.length === 1 ? 200 : 409 });
    }) as typeof fetch;
    const h = harness({ push: pushLineMessage });
    expect((await (await h.call()).json()).status).toBe("delivered");
    expect((await (await h.call()).json()).status).toBe("already_accepted");
    for (const init of requests) {
      expect(JSON.parse(String(init.body))).toEqual({ to: TARGET, messages: [{ type: "text", text: alert.text }] });
      expect(new Headers(init.headers).get("x-line-retry-key")).toBe(dailyDataQualityRetryKey(DATE, TARGET));
    }
  });
  test("LINE HTTP and network failures return non2xx with privacy-safe logs/response", async () => {
    for (const status of [400, 401, 403, 429, 500, null]) {
      globalThis.fetch = (async () => {
        if (status === null) throw new Error(`private-body ${TARGET}`);
        return new Response(`secret-token ${TARGET}`, { status });
      }) as unknown as typeof fetch;
      const h = harness({ push: pushLineMessage });
      const response = await h.call();
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ ok: false, error: "line_push_failed", sent: false, deliveryUnknown: true });
      expect(h.logs).toEqual(["daily_data_quality_alert_push_failed"]);
    }
  });
  test("route wiring and workflow are manual only, no target input or shell-interpolated input", () => {
    const route = readFileSync(new URL("../../app/api/cron/daily-data-quality-alert/route.ts", import.meta.url), "utf8");
    expect(route).toContain("createDailyDataQualityAlertHandler({");
    expect(route).toContain("pushLineMessage(to, text, retryKey)");
    expect(route).toContain("export function HEAD()");
    const workflow = readFileSync(new URL("../../../.github/workflows/manual-data-quality-alert.yml", import.meta.url), "utf8");
    expect(workflow).toContain("  workflow_dispatch:");
    expect(workflow).not.toMatch(/^\s*(schedule|push|pull_request|target|to):/m);
    expect(workflow).toContain("default: true");
    expect(workflow).toContain("${{ secrets.CRON_SECRET }}");
    expect(workflow).toContain("${{ vars.DQ_ALERT_BASE_URL }}");
    expect(workflow).toContain('--data-urlencode "date=$ALERT_DATE"');
    expect(workflow.split("run: |")[1]).not.toContain("${{");
    expect(workflow).not.toContain("--retry");
  });
});
