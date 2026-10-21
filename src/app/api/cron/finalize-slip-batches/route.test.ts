/**
 * P1 #6 — the REAL cron GET handler (real supabase-js client, real
 * pushLineMessage, real finalizers) under one end-to-end deadline. No module
 * mocks: globalThis.fetch is replaced by a fake PostgREST + LINE endpoint, so
 * every provider/DB call goes through the same code path as production.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { GET, maxDuration } from "./route";
import { cronRouteBudgetMs } from "@/lib/slips/ingest-policy";

const BATCH = "11111111-1111-4111-8111-111111111111";

interface Call { at: number; method: string; host: string; path: string; retryKey: string | null; signal?: AbortSignal }

let calls: Call[];
let realFetch: typeof fetch;
const saved: Record<string, string | undefined> = {};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Never settles and ignores the abort signal: the worst provider possible. */
const hang = () => new Promise<Response>(() => {});

function fakeFetch(opts: { hangDb?: boolean; hangPush?: boolean }) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const call: Call = {
      at: Date.now(),
      method: init?.method ?? "GET",
      host: url.host,
      path: url.pathname,
      retryKey: headers.get("x-line-retry-key"),
      signal: init?.signal ?? undefined,
    };
    calls.push(call);

    if (url.host === "api.line.me") {
      if (opts.hangPush) return hang();
      return json({});
    }
    if (opts.hangDb) return hang();

    const path = url.pathname.replace("/rest/v1/", "");
    switch (path) {
      case "slip_batches":
        if (call.method === "GET" && url.searchParams.get("status") === "eq.closing") {
          return json([{ id: BATCH, source_id: "G-route" }]);
        }
        if (call.method === "GET" && url.searchParams.get("id") === `eq.${BATCH}`) {
          return json([{
            id: BATCH, source_id: "G-route", status: "processing", summary_sent_at: null,
            closing_at: new Date(Date.now() - 600_000).toISOString(), last_image_at: null,
            created_at: new Date(Date.now() - 900_000).toISOString(), open_event_ts_ms: null,
          }]);
        }
        return json([]);
      case "rpc/claim_closing_slip_batch":
        return json([{ claimed_id: BATCH, claimed_source_id: "G-route", was_timeout: false }]);
      case "rpc/slip_batch_image_accounting":
        return json({
          batch_id: BATCH, received_total: 0, attached: 0, waiting: 0, retry_pending: 0, queue_dead: 0,
          failed_permanent: 0, late_after_finalize: 0, excluded_after_close: 0, excluded_not_slip: 0,
          ocr_complete: 0, ocr_pending: 0, incomplete: 0, oldest_unresolved_age_seconds: null,
        });
      case "rpc/slip_image_ledger_health":
        return json({ unbound: 0, received: 0 });
      default:
        return json(path.startsWith("rpc/") ? [] : []);
    }
  }) as typeof fetch;
}

const request = () => new NextRequest("http://localhost/api/cron/finalize-slip-batches", {
  headers: { authorization: "Bearer route-test-secret" },
});

async function timedGet() {
  const started = Date.now();
  const res = await GET(request());
  const elapsedMs = Date.now() - started;
  return { res, body: await res.json(), elapsedMs, callsAtResponse: calls.length };
}

describe("finalize-slip-batches GET: one end-to-end deadline", () => {
  beforeEach(() => {
    calls = [];
    realFetch = globalThis.fetch;
    for (const k of ["CRON_SECRET", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "LINE_CHANNEL_ACCESS_TOKEN"]) {
      saved[k] = process.env[k];
    }
    process.env.CRON_SECRET = "route-test-secret";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
    process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-line-token";
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("the static budget fits maxDuration", () => {
    expect(maxDuration).toBe(60);
    expect(cronRouteBudgetMs()).toBeLessThan(maxDuration * 1000);
  });

  test("a LINE push that never answers is cut at the push cap; the batch stays retryable with its retry key; nothing runs after the response", async () => {
    globalThis.fetch = fakeFetch({ hangPush: true });
    const { res, body, elapsedMs, callsAtResponse } = await timedGet();

    expect(res.status).toBe(200);
    expect(elapsedMs).toBeLessThan(maxDuration * 1000);
    expect(elapsedMs).toBeLessThan(15_000); // push cap (8 s) + overhead, not the whole budget
    const pushes = calls.filter((c) => c.host === "api.line.me");
    expect(pushes).toHaveLength(1);
    expect(pushes[0].retryKey).toBe(BATCH); // idempotent retry later, never a duplicate summary
    expect(pushes[0].signal?.aborted).toBe(true); // the hung request was really aborted
    expect(body.closedCount).toBe(0); // not counted as finalized: left in processing for the stale sweep
    // The claimed batch is never marked sent or terminal after a cut push.
    expect(calls.some((c) => c.method === "PATCH" && c.path.endsWith("/slip_batches") && c.at > pushes[0].at)).toBe(false);

    await new Promise((r) => setTimeout(r, 1_000));
    expect(calls.length).toBe(callsAtResponse); // no detached work after the response
  }, 30_000);

  test("every DB call hanging (signal ignored): the GET still answers inside maxDuration and starts nothing after it", async () => {
    globalThis.fetch = fakeFetch({ hangDb: true, hangPush: true });
    const { res, body, elapsedMs, callsAtResponse } = await timedGet();

    expect(res.status).toBe(200);
    expect(elapsedMs).toBeLessThan(maxDuration * 1000);
    expect(elapsedMs).toBeLessThanOrEqual(cronRouteBudgetMs() + 2_000);
    expect(body.closedCount).toBe(0);
    expect(body.ledgerDeployed).toBe(true); // a timed-out health read is not "migration missing"
    expect(calls.filter((c) => c.host === "api.line.me")).toHaveLength(0); // nothing claimed, nothing pushed
    // Every DB request was aborted by its phase deadline / per-call cap.
    expect(calls.every((c) => c.signal?.aborted)).toBe(true);

    await new Promise((r) => setTimeout(r, 1_000));
    expect(calls.length).toBe(callsAtResponse);
  }, 75_000);

  test("healthy providers: one summary push with the batch retry key, well inside the budget", async () => {
    globalThis.fetch = fakeFetch({});
    const { res, body, elapsedMs } = await timedGet();
    expect(res.status).toBe(200);
    expect(elapsedMs).toBeLessThan(5_000);
    expect(body.closedCount).toBe(1);
    const pushes = calls.filter((c) => c.host === "api.line.me");
    expect(pushes.map((c) => c.retryKey)).toEqual([BATCH]);
  }, 30_000);
});
