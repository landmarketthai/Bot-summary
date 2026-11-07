import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createGeminiRequestPermit,
  GeminiQuotaUnavailableError,
  readGeminiRateLimitConfig,
} from "@/lib/slips/gemini-rate-limit";

type RpcResult = { data: unknown; error: { message: string } | null };

function fakeSupabase(respond: (args: Record<string, unknown>) => RpcResult | Promise<RpcResult>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return respond(args);
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

const granted: RpcResult = { data: { granted: true, reason: "ok", retry_after_ms: 0 }, error: null };
const deny = (reason: "rpm" | "rpd", retry: number): RpcResult => ({
  data: { granted: false, reason, retry_after_ms: retry },
  error: null,
});

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    expect(error).toBeInstanceOf(GeminiQuotaUnavailableError);
    return (error as GeminiQuotaUnavailableError).reason;
  }
}

describe("createGeminiRequestPermit", () => {
  test("granted resolves after one RPC with the configured limits", async () => {
    const { client, calls } = fakeSupabase(() => granted);
    await createGeminiRequestPermit(client, { rpm: 7, rpd: 99, sleep: async () => {} })();
    expect(calls).toEqual([
      { name: "acquire_ai_provider_permit", args: { p_provider: "gemini", p_rpm: 7, p_rpd: 99 } },
    ]);
  });

  test("rpm denial waits retry_after_ms (+jitter) then succeeds", async () => {
    const replies = [deny("rpm", 1_500), deny("rpm", 800), granted];
    const { client, calls } = fakeSupabase(() => replies.shift()!);
    const sleeps: number[] = [];
    let clock = 0;
    const permit = createGeminiRequestPermit(client, {
      maxWaitMs: 20_000,
      now: () => clock,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    });
    await permit();
    expect(calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(1_500);
    expect(sleeps[0]).toBeLessThan(1_500 + 250);
    expect(sleeps[1]).toBeGreaterThanOrEqual(800);
  });

  test("rpm denial that would exceed maxWaitMs throws rpm without oversleeping", async () => {
    const { client, calls } = fakeSupabase(() => deny("rpm", 4_000));
    let clock = 0;
    let slept = 0;
    const permit = createGeminiRequestPermit(client, {
      maxWaitMs: 10_000,
      now: () => clock,
      sleep: async (ms) => { slept += ms; clock += ms; },
    });
    expect(await reason(permit())).toBe("rpm");
    expect(slept).toBeLessThanOrEqual(10_000);
    expect(calls).toHaveLength(3); // waited twice (~8s), third wait would pass the deadline
  });

  test("maxWaitMs 0 never sleeps", async () => {
    const { client } = fakeSupabase(() => deny("rpm", 10));
    let slept = false;
    const permit = createGeminiRequestPermit(client, { maxWaitMs: 0, sleep: async () => { slept = true; } });
    expect(await reason(permit())).toBe("rpm");
    expect(slept).toBe(false);
  });

  test("caller budget caps the wait below maxWaitMs", async () => {
    const { client } = fakeSupabase(() => deny("rpm", 5_000));
    let slept = false;
    const permit = createGeminiRequestPermit(client, { maxWaitMs: 60_000, sleep: async () => { slept = true; } });
    expect(await reason(permit(3_000))).toBe("rpm");
    expect(slept).toBe(false);
  });

  test("rpd denial throws immediately", async () => {
    const { client, calls } = fakeSupabase(() => deny("rpd", 3_600_000));
    let slept = false;
    const permit = createGeminiRequestPermit(client, { sleep: async () => { slept = true; } });
    expect(await reason(permit())).toBe("rpd");
    expect(calls).toHaveLength(1);
    expect(slept).toBe(false);
  });

  test("RPC error, missing function and thrown transport errors fail closed", async () => {
    const cases: Array<() => RpcResult | Promise<RpcResult>> = [
      () => ({ data: null, error: { message: "function public.acquire_ai_provider_permit does not exist" } }),
      () => ({ data: null, error: { message: "permission denied" } }),
      () => { throw new Error("fetch failed"); },
    ];
    for (const respond of cases) {
      const { client } = fakeSupabase(respond);
      expect(await reason(createGeminiRequestPermit(client, { sleep: async () => {} })())).toBe("limiter_error");
    }
  });

  test("malformed payloads fail closed", async () => {
    const payloads: unknown[] = [
      null,
      "granted",
      [],
      {},
      { granted: "true", reason: "ok" },
      { granted: true, reason: "rpm" },
      { granted: false, reason: "other", retry_after_ms: 10 },
      { granted: false, reason: "rpm" },
      { granted: false, reason: "rpm", retry_after_ms: -5 },
      { granted: false, reason: "rpm", retry_after_ms: Number.NaN },
    ];
    for (const data of payloads) {
      const { client } = fakeSupabase(() => ({ data, error: null }));
      expect(await reason(createGeminiRequestPermit(client, { sleep: async () => {} })())).toBe("limiter_error");
    }
  });
});

describe("readGeminiRateLimitConfig", () => {
  test("defaults stay below the free-tier caps", () => {
    expect(readGeminiRateLimitConfig({})).toEqual({ rpm: 12, rpd: 450, maxWaitMs: 20_000 });
  });

  test("clamps and falls back on invalid values", () => {
    expect(readGeminiRateLimitConfig({
      GEMINI_SLIP_RPM_LIMIT: "100",
      GEMINI_SLIP_RPD_LIMIT: "0",
      GEMINI_SLIP_PERMIT_MAX_WAIT_MS: "999999",
    })).toEqual({ rpm: 15, rpd: 1, maxWaitMs: 60_000 });
    expect(readGeminiRateLimitConfig({
      GEMINI_SLIP_RPM_LIMIT: "abc",
      GEMINI_SLIP_RPD_LIMIT: " ",
      GEMINI_SLIP_PERMIT_MAX_WAIT_MS: "-1",
    })).toEqual({ rpm: 12, rpd: 450, maxWaitMs: 0 });
    expect(readGeminiRateLimitConfig({ GEMINI_SLIP_RPM_LIMIT: "5.9" }).rpm).toBe(5);
  });
});

describe("burst across lanes", () => {
  test("10 concurrent lanes x 3 attempts never exceed rpm grants in ANY 60s interval", async () => {
    const RPM = 12;
    const SECOND = 1_000;
    // Virtual clock + timer queue shared by all lanes. Mid-second start exercises bucket truncation.
    let clock = 10 * 60_000 + 45_300;
    const timers: Array<{ at: number; resolve: () => void }> = [];
    const sleep = (ms: number) => new Promise<void>((resolve) => timers.push({ at: clock + ms, resolve }));

    // In-memory model of acquire_ai_provider_permit: per-second buckets, a bucket
    // counts while its start > now - 61s, retry when the oldest one leaves.
    const buckets = new Map<number, number>();
    const { client } = fakeSupabase(async (args) => {
      await Promise.resolve(); // interleave lanes between call and reply
      const live = [...buckets].filter(([start]) => start > clock - 61 * SECOND);
      const used = live.reduce((n, [, c]) => n + c, 0);
      if (used >= (args.p_rpm as number)) {
        const oldest = Math.min(...live.map(([start]) => start));
        return deny("rpm", Math.max(1, oldest + 61 * SECOND - clock));
      }
      const bucket = Math.floor(clock / SECOND) * SECOND;
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
      return granted;
    });

    const httpCalls: number[] = [];
    const permit = createGeminiRequestPermit(client, { rpm: RPM, rpd: 500, maxWaitMs: 300_000, sleep, now: () => clock });
    const outcomes = Promise.all(Array.from({ length: 10 }, async () => {
      const results: string[] = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await permit();
          httpCalls.push(clock);
          results.push("ok");
        } catch (error) {
          results.push((error as GeminiQuotaUnavailableError).reason);
        }
      }
      return results;
    }));

    let done = false;
    void outcomes.then(() => { done = true; });
    while (!done) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (done) break;
      timers.sort((a, b) => a.at - b.at);
      const next = timers.shift();
      if (!next) continue;
      clock = Math.max(clock, next.at);
      next.resolve();
    }

    const results = (await outcomes).flat();
    expect(results).toHaveLength(30);
    expect(results.every((r) => r === "ok" || r === "rpm")).toBe(true);
    expect(results.filter((r) => r === "ok")).toHaveLength(httpCalls.length);
    expect(httpCalls.length).toBe(30); // generous wait lets every attempt through eventually

    // Rolling guarantee: every 60s interval starting at a grant holds <= RPM grants.
    httpCalls.sort((a, b) => a - b);
    for (const start of httpCalls) {
      expect(httpCalls.filter((t) => t >= start && t < start + 60_000).length).toBeLessThanOrEqual(RPM);
    }
  });
});
