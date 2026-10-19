import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { LinePushError } from "@/lib/line/reply";
import {
  SLIP_LEDGER_ALERT_ROUTE_BUDGET_MS,
  handleSlipLedgerAlert,
} from "./handler";
import { maxDuration, runtime } from "./route";
import type {
  SlipLedgerAlertClient,
  SlipLedgerAlertHealth,
  SlipLedgerAlertPush,
} from "@/lib/slips/ledger-health-alert";

const TARGET = "C0a6ce0f4cac43d27ab0df8ca809de511";
const RETRY_KEY = "11111111-1111-4111-8111-111111111111";
const LEASE_ONE = "22222222-2222-4222-8222-222222222222";
const LEASE_TWO = "33333333-3333-4333-8333-333333333333";

const healthy = (overrides: Partial<SlipLedgerAlertHealth> = {}): SlipLedgerAlertHealth => ({
  version: 1,
  unhealthy: false,
  stale_threshold_seconds: 2160,
  ocr_overdue_threshold_seconds: 2160,
  unbound_total: 0,
  unbound_stale: 0,
  received_stale: 0,
  ingesting_stale: 0,
  retry_pending_total: 0,
  retry_stale: 0,
  queue_dead: 0,
  failed_permanent_24h: 0,
  late_after_finalize_24h: 0,
  ocr_missing_overdue: 0,
  ocr_processing_overdue: 0,
  oldest_open_age_seconds: null,
  ...overrides,
});

class FakeDurableAlertClient implements SlipLedgerAlertClient {
  health = healthy();
  pending = false;
  leased = false;
  delivered = false;
  claimCalls = 0;
  completeCalls: Array<Record<string, unknown>> = [];
  missingHelper = false;
  private leaseCount = 0;

  async rpc(name: string, args: Record<string, unknown> = {}) {
    if (this.missingHelper) {
      return { data: null, error: { code: "PGRST202", message: "function not found" } };
    }
    if (name === "slip_ingest_alert_health") return { data: this.health, error: null };
    if (name === "claim_slip_ingest_health_alert") {
      this.claimCalls += 1;
      if (!this.health.unhealthy || this.delivered) {
        return {
          data: { claimed: false, reason: this.health.unhealthy ? "throttled" : "healthy", health: this.health },
          error: null,
        };
      }
      if (!this.pending) this.pending = true;
      if (this.leased) {
        return { data: { claimed: false, reason: "leased", health: this.health }, error: null };
      }
      this.leased = true;
      this.leaseCount += 1;
      return {
        data: {
          claimed: true,
          kind: "incident",
          retry_key: RETRY_KEY,
          lease_token: this.leaseCount === 1 ? LEASE_ONE : LEASE_TWO,
          attempt: this.leaseCount,
          incident_sequence: 1,
          health: this.health,
        },
        error: null,
      };
    }
    if (name === "complete_slip_ingest_health_alert") {
      this.completeCalls.push(args);
      this.leased = false;
      if (args.p_success === true) {
        this.pending = false;
        this.delivered = true;
      }
      return { data: true, error: null };
    }
    return { data: null, error: { code: "PGRST202", message: "unexpected rpc" } };
  }
}

const saved: Record<string, string | undefined> = {};
const request = (secret = "cron-test-secret") => new NextRequest(
  "http://localhost/api/cron/slip-ledger-alert",
  { headers: { authorization: `Bearer ${secret}` } },
);

describe("slip ledger alert cron route", () => {
  beforeEach(() => {
    for (const key of [
      "CRON_SECRET",
      "SLIP_LEDGER_ALERT_ENABLED",
      "SLIP_LEDGER_ALERT_LINE_TARGET",
      "LINE_CHANNEL_ACCESS_TOKEN",
    ]) saved[key] = process.env[key];
    process.env.CRON_SECRET = "cron-test-secret";
    delete process.env.SLIP_LEDGER_ALERT_ENABLED;
    delete process.env.SLIP_LEDGER_ALERT_LINE_TARGET;
    process.env.LINE_CHANNEL_ACCESS_TOKEN = "line-secret-must-not-log";
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("route is node-only and its internal budget fits maxDuration", () => {
    expect(runtime).toBe("nodejs");
    expect(maxDuration).toBe(30);
    expect(SLIP_LEDGER_ALERT_ROUTE_BUDGET_MS).toBeLessThan(maxDuration * 1_000);
  });

  test("scheduler auth accepts only the configured Bearer secret before any SQL", async () => {
    const client = new FakeDurableAlertClient();
    const noAuth = new NextRequest("http://localhost/api/cron/slip-ledger-alert");
    const wrongBearer = request("wrong-secret");
    const legacyHeader = new NextRequest("http://localhost/api/cron/slip-ledger-alert", {
      headers: { "x-cron-secret": "cron-test-secret" },
    });
    for (const req of [noAuth, wrongBearer, legacyHeader]) {
      const res = await handleSlipLedgerAlert(req, { getClient: () => client });
      expect(res.status).toBe(401);
    }
    expect(client.claimCalls).toBe(0);

    delete process.env.CRON_SECRET;
    const missingConfig = await handleSlipLedgerAlert(request(), { getClient: () => client });
    expect(missingConfig.status).toBe(500);
    expect(client.claimCalls).toBe(0);
  });

  test("opt-in flag is exact and disabled mode does not read SQL or send", async () => {
    const client = new FakeDurableAlertClient();
    let pushes = 0;
    const res = await handleSlipLedgerAlert(request(), {
      getClient: () => client,
      push: async () => { pushes += 1; },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mode: "disabled", sent: false });
    expect(client.claimCalls).toBe(0);
    expect(pushes).toBe(0);
  });

  test("enabled without recipient is structured-log dry-run only", async () => {
    process.env.SLIP_LEDGER_ALERT_ENABLED = "true";
    const client = new FakeDurableAlertClient();
    client.health = healthy({ unhealthy: true, queue_dead: 1 });
    let pushes = 0;
    const res = await handleSlipLedgerAlert(request(), {
      getClient: () => client,
      push: async () => { pushes += 1; },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mode: "dry_run", sent: false });
    expect(client.claimCalls).toBe(0);
    expect(pushes).toBe(0);
  });

  test("malformed recipient fails closed before SQL and outbound", async () => {
    process.env.SLIP_LEDGER_ALERT_ENABLED = "true";
    process.env.SLIP_LEDGER_ALERT_LINE_TARGET = "production-default";
    const client = new FakeDurableAlertClient();
    let pushes = 0;
    const res = await handleSlipLedgerAlert(request(), {
      getClient: () => client,
      push: async () => { pushes += 1; },
    });
    expect(res.status).toBe(500);
    expect(client.claimCalls).toBe(0);
    expect(pushes).toBe(0);
  });

  test("active recipient requires a configured LINE token before SQL or outbound", async () => {
    process.env.SLIP_LEDGER_ALERT_ENABLED = "true";
    process.env.SLIP_LEDGER_ALERT_LINE_TARGET = TARGET;
    delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    const client = new FakeDurableAlertClient();
    let pushes = 0;
    const res = await handleSlipLedgerAlert(request(), {
      getClient: () => client,
      push: async () => { pushes += 1; },
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ mode: "misconfigured", sent: false });
    expect(client.claimCalls).toBe(0);
    expect(pushes).toBe(0);
  });

  test("target validation rejects non-hex and wrong-length LINE IDs", async () => {
    process.env.SLIP_LEDGER_ALERT_ENABLED = "true";
    const client = new FakeDurableAlertClient();
    for (const target of [`C${"z".repeat(32)}`, `U${"a".repeat(31)}`, `R${"a".repeat(33)}`]) {
      process.env.SLIP_LEDGER_ALERT_LINE_TARGET = target;
      const res = await handleSlipLedgerAlert(request(), { getClient: () => client });
      expect(res.status).toBe(500);
    }
    expect(client.claimCalls).toBe(0);
  });

  test("healthy and delayed-below-36-min snapshots never send", async () => {
    process.env.SLIP_LEDGER_ALERT_ENABLED = "true";
    process.env.SLIP_LEDGER_ALERT_LINE_TARGET = TARGET;
    for (const health of [
      healthy(),
      healthy({ unbound_total: 1, retry_pending_total: 1, oldest_open_age_seconds: 2159 }),
    ]) {
      const client = new FakeDurableAlertClient();
      client.health = health;
      let pushes = 0;
      const res = await handleSlipLedgerAlert(request(), {
        getClient: () => client,
        push: async () => { pushes += 1; },
      });
      expect(res.status).toBe(200);
      expect((await res.json()).sent).toBe(false);
      expect(pushes).toBe(0);
    }
  });

  test("concurrent stale-unbound invocations produce one leased send", async () => {
    process.env.SLIP_LEDGER_ALERT_ENABLED = "true";
    process.env.SLIP_LEDGER_ALERT_LINE_TARGET = TARGET;
    const client = new FakeDurableAlertClient();
    client.health = healthy({
      unhealthy: true,
      unbound_total: 1,
      unbound_stale: 1,
      oldest_open_age_seconds: 2161,
    });
    const pushes: Array<{ retryKey: string; text: string }> = [];
    let releasePush: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { releasePush = resolve; });
    const push: SlipLedgerAlertPush = async (_to, text, retryKey) => {
      pushes.push({ retryKey, text });
      await gate;
    };

    const first = handleSlipLedgerAlert(request(), { getClient: () => client, push });
    while (pushes.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await handleSlipLedgerAlert(request(), { getClient: () => client, push });
    releasePush!();
    const firstResult = await first;

    expect(firstResult.status).toBe(200);
    expect(second.status).toBe(200);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].retryKey).toBe(RETRY_KEY);
    expect(pushes[0].text).toContain("unbound 1");
  });

  test("LINE 429 releases for retry and retransmission keeps X-Line-Retry-Key", async () => {
    process.env.SLIP_LEDGER_ALERT_ENABLED = "true";
    process.env.SLIP_LEDGER_ALERT_LINE_TARGET = TARGET;
    const client = new FakeDurableAlertClient();
    client.health = healthy({ unhealthy: true, retry_pending_total: 1, retry_stale: 1 });
    const retryKeys: string[] = [];
    const first = await handleSlipLedgerAlert(request(), {
      getClient: () => client,
      push: async (_to, _text, retryKey) => {
        retryKeys.push(retryKey);
        throw new LinePushError("provider body secret", 429, true, 125_000);
      },
    });
    expect(first.status).toBe(502);
    expect(await first.json()).toMatchObject({ retryScheduled: true, retrySeconds: 125 });
    expect(client.completeCalls[0]).toMatchObject({
      p_success: false,
      p_error_code: "line_rate_limit",
      p_retry_after_seconds: 125,
    });

    const second = await handleSlipLedgerAlert(request(), {
      getClient: () => client,
      push: async (_to, _text, retryKey) => { retryKeys.push(retryKey); },
    });
    expect(second.status).toBe(200);
    expect(retryKeys).toEqual([RETRY_KEY, RETRY_KEY]);
  });

  test("missing SQL helper fails closed and never sends", async () => {
    process.env.SLIP_LEDGER_ALERT_ENABLED = "true";
    process.env.SLIP_LEDGER_ALERT_LINE_TARGET = TARGET;
    const client = new FakeDurableAlertClient();
    client.missingHelper = true;
    let pushes = 0;
    const res = await handleSlipLedgerAlert(request(), {
      getClient: () => client,
      push: async () => { pushes += 1; },
    });
    expect(res.status).toBe(503);
    expect((await res.json()).errorCode).toBe("PGRST202");
    expect(pushes).toBe(0);
  });

  test("malformed or internally inconsistent health JSON fails closed", async () => {
    process.env.SLIP_LEDGER_ALERT_ENABLED = "true";
    process.env.SLIP_LEDGER_ALERT_LINE_TARGET = TARGET;
    for (const badHealth of [
      { ...healthy(), queue_dead: undefined },
      { ...healthy(), unhealthy: false, queue_dead: 1 },
      { ...healthy(), stale_threshold_seconds: 2159 },
    ]) {
      const client: SlipLedgerAlertClient = {
        async rpc() {
          return { data: {
            claimed: true,
            kind: "incident",
            retry_key: RETRY_KEY,
            lease_token: LEASE_ONE,
            attempt: 1,
            incident_sequence: 1,
            health: badHealth,
          }, error: null };
        },
      };
      let pushes = 0;
      const res = await handleSlipLedgerAlert(request(), {
        getClient: () => client,
        push: async () => { pushes += 1; },
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ errorCode: "malformed_claim", sent: false });
      expect(pushes).toBe(0);
    }
  });

  test("ambiguous push timeout aborts promptly and preserves the retryable lease state", async () => {
    process.env.SLIP_LEDGER_ALERT_ENABLED = "true";
    process.env.SLIP_LEDGER_ALERT_LINE_TARGET = TARGET;
    const client = new FakeDurableAlertClient();
    client.health = healthy({ unhealthy: true, unbound_stale: 1 });
    let aborted = false;
    const started = performance.now();
    const res = await handleSlipLedgerAlert(request(), {
      getClient: () => client,
      pushTimeoutMs: 20,
      push: async (_to, _text, _retryKey, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(signal.reason);
        }, { once: true });
      }),
    });
    expect(res.status).toBe(502);
    expect(performance.now() - started).toBeLessThan(500);
    expect(aborted).toBe(true);
    expect(client.completeCalls[0]).toMatchObject({
      p_success: false,
      p_error_code: "line_timeout",
    });
  });

  test("recovery rechecks health before LINE push and suppresses a false all-clear", async () => {
    process.env.SLIP_LEDGER_ALERT_ENABLED = "true";
    process.env.SLIP_LEDGER_ALERT_LINE_TARGET = TARGET;
    const client: SlipLedgerAlertClient = {
      async rpc(name) {
        if (name === "claim_slip_ingest_health_alert") {
          return { data: {
            claimed: true, kind: "recovery", retry_key: RETRY_KEY,
            lease_token: LEASE_ONE, attempt: 1, incident_sequence: 1,
            health: healthy(),
          }, error: null };
        }
        if (name === "slip_ingest_alert_health") {
          return { data: healthy({ unhealthy: true, unbound_stale: 1 }), error: null };
        }
        return { data: null, error: { code: "unexpected_rpc" } };
      },
    };
    let pushed = 0;
    const response = await handleSlipLedgerAlert(request(), {
      getClient: () => client,
      push: async () => { pushed += 1; },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ sent: false, reason: "recovery_not_safe" });
    expect(pushed).toBe(0);
  });

  test("LINE already-accepted retry is completed once under the same retry key", async () => {
    process.env.SLIP_LEDGER_ALERT_ENABLED = "true";
    process.env.SLIP_LEDGER_ALERT_LINE_TARGET = TARGET;
    const client = new FakeDurableAlertClient();
    client.health = healthy({ unhealthy: true, queue_dead: 1 });
    const response = await handleSlipLedgerAlert(request(), {
      getClient: () => client,
      push: async (_to, _text, retryKey) => {
        expect(retryKey).toBe(RETRY_KEY);
        return { status: "already_accepted" };
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sent: true, kind: "incident" });
    expect(client.delivered).toBe(true);
  });

  test("logs and JSON never expose recipient, token or thrown provider text", async () => {
    process.env.SLIP_LEDGER_ALERT_ENABLED = "true";
    process.env.SLIP_LEDGER_ALERT_LINE_TARGET = TARGET;
    const client = new FakeDurableAlertClient();
    client.health = healthy({ unhealthy: true, queue_dead: 1 });
    const lines: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    try {
      const res = await handleSlipLedgerAlert(request(), {
        getClient: () => client,
        push: async () => { throw new Error("provider-secret-response"); },
      });
      lines.push(JSON.stringify(await res.json()));
    } finally {
      console.error = originalError;
    }
    const output = lines.join("\n");
    expect(output).not.toContain(TARGET);
    expect(output).not.toContain("line-secret-must-not-log");
    expect(output).not.toContain("provider-secret-response");
  });
});
