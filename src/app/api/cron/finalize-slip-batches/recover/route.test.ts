import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recoverSlipBatch, handleRecoverRequest } from "./route";
import type { Database } from "@/types/database";
import type { PushResult } from "@/lib/line/reply";

// ── Supabase stub ─────────────────────────────────────────────────────────────

interface BatchOverrides {
  status?:          string;
  summary_sent_at?: string | null;
  closing_at?:      string | null;
  created_at?:      string;
  source_id?:       string;
}

/**
 * Builds a minimal Supabase stub.
 * `updateErrors` is a queue: the first call pops the front; subsequent calls
 * get null (success).  Allows simulating fail-then-succeed sequences.
 */
function makeRecoverSupabase(
  batchRow: BatchOverrides | null,
  opts: {
    statusUpdates?: Array<Record<string, unknown>>;
    updateErrors?: Array<{ message: string } | null>;
  } = {},
): SupabaseClient<Database> {
  const { statusUpdates = [], updateErrors = [] } = opts;

  const defaultBatch = {
    id:              "batch-1",
    source_id:       "group-abc",
    status:          "processing",
    summary_sent_at: null,
    closing_at:      new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
    created_at:      new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    ...batchRow,
  };

  return {
    from(table: string) {
      if (table === "slip_batches") {
        return {
          select() {
            return {
              eq(_col: string, _val: unknown) {
                return {
                  maybeSingle() {
                    return Promise.resolve({
                      data: batchRow === null ? null : defaultBatch,
                      error: null,
                    });
                  },
                };
              },
            };
          },
          update(values: Record<string, unknown>) {
            statusUpdates.push(values);
            const err = updateErrors.length > 0 ? updateErrors.shift()! : null;
            return {
              eq() {
                return Promise.resolve({ data: null, error: err });
              },
            };
          },
        };
      }

      if (table === "slip_evidences") {
        return {
          select() {
            return {
              eq() {
                return {
                  order() {
                    return Promise.resolve({ data: [], error: null });
                  },
                };
              },
            };
          },
        };
      }

      if (table === "slip_checks") {
        return {
          select() {
            return {
              in() {
                return Promise.resolve({ data: [], error: null });
              },
            };
          },
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient<Database>;
}

// ── Push stubs ────────────────────────────────────────────────────────────────

function deliveredPush(
  calls: Array<{ to: string; retryKey?: string }> = [],
): (to: string, text: string, retryKey?: string) => Promise<PushResult> {
  return async (to, _text, retryKey) => {
    calls.push({ to, retryKey });
    return { status: "delivered" };
  };
}

function alreadyAcceptedPush(
  calls: Array<{ to: string; retryKey?: string }> = [],
): (to: string, text: string, retryKey?: string) => Promise<PushResult> {
  return async (to, _text, retryKey) => {
    calls.push({ to, retryKey });
    return { status: "already_accepted" };
  };
}

function failingPush(
  message = "LINE push network error",
): (to: string, text: string, retryKey?: string) => Promise<PushResult> {
  return async () => { throw new Error(message); };
}

// ── recoverSlipBatch — business logic tests ───────────────────────────────────

describe("recoverSlipBatch — delivery + persistence outcomes", () => {
  it("A. LINE 2xx + DB update succeeds → finalized", async () => {
    const statusUpdates: Array<Record<string, unknown>> = [];
    const supabase = makeRecoverSupabase(
      { status: "processing", summary_sent_at: null },
      { statusUpdates },
    );

    const result = await recoverSlipBatch(supabase, "batch-1", deliveredPush());

    expect(result.ok).toBe(true);
    expect(result.result).toBe("finalized");
    expect(statusUpdates.find((u) => u.summary_sent_at)).toBeDefined();
  });

  it("B. LINE 409 (already_accepted) + DB update succeeds → finalized", async () => {
    const statusUpdates: Array<Record<string, unknown>> = [];
    const supabase = makeRecoverSupabase(
      { status: "processing", summary_sent_at: null },
      { statusUpdates },
    );

    const result = await recoverSlipBatch(supabase, "batch-1", alreadyAcceptedPush());

    expect(result.ok).toBe(true);
    expect(result.result).toBe("finalized");
    expect(statusUpdates.find((u) => u.summary_sent_at)).toBeDefined();
  });

  it("C. LINE 2xx + DB update fails → persistence_failed, not finalized", async () => {
    const supabase = makeRecoverSupabase(
      { status: "processing", summary_sent_at: null },
      { updateErrors: [{ message: "connection pool exhausted" }] },
    );

    const result = await recoverSlipBatch(supabase, "batch-1", deliveredPush());

    // Result must be persistence_failed — not finalized — so the caller knows
    // the batch is still stuck and a retry is needed.
    expect(result.ok).toBe(false);
    expect(result.result).toBe("persistence_failed");
    expect(result.error).toContain("connection pool exhausted");
  });

  it("D. LINE 409 (already_accepted) + DB update fails → persistence_failed, not finalized", async () => {
    const statusUpdates: Array<Record<string, unknown>> = [];
    const supabase = makeRecoverSupabase(
      { status: "processing", summary_sent_at: null },
      {
        statusUpdates,
        updateErrors: [{ message: "write conflict" }],
      },
    );

    const result = await recoverSlipBatch(supabase, "batch-1", alreadyAcceptedPush());

    expect(result.ok).toBe(false);
    expect(result.result).toBe("persistence_failed");
    expect(result.error).toContain("write conflict");
  });

  it("E. subsequent retry after persistence_failed uses same retry key and repairs DB", async () => {
    // First call: LINE delivers, DB fails
    const pushCalls1: Array<{ to: string; retryKey?: string }> = [];
    const supabase1 = makeRecoverSupabase(
      { status: "processing", summary_sent_at: null },
      { updateErrors: [{ message: "transient error" }] },
    );
    const result1 = await recoverSlipBatch(supabase1, "batch-1", deliveredPush(pushCalls1));
    expect(result1.result).toBe("persistence_failed");
    expect(pushCalls1[0]?.retryKey).toBe("batch-1"); // same retry key as batch.id

    // Second call: LINE returns 409 (already accepted — no duplicate), DB succeeds
    const pushCalls2: Array<{ to: string; retryKey?: string }> = [];
    const statusUpdates2: Array<Record<string, unknown>> = [];
    const supabase2 = makeRecoverSupabase(
      { status: "processing", summary_sent_at: null }, // still null — batch not yet updated
      { statusUpdates: statusUpdates2 },
    );
    const result2 = await recoverSlipBatch(supabase2, "batch-1", alreadyAcceptedPush(pushCalls2));

    expect(result2.ok).toBe(true);
    expect(result2.result).toBe("finalized");
    // Same retry key used — LINE returned 409 (already_accepted), no duplicate delivery
    expect(pushCalls2[0]?.retryKey).toBe("batch-1");
    // DB now updated
    expect(statusUpdates2.find((u) => u.summary_sent_at)).toBeDefined();
  });

  it("real LINE delivery failure → delivery_failed, batch stays processing", async () => {
    const statusUpdates: Array<Record<string, unknown>> = [];
    const supabase = makeRecoverSupabase(
      { status: "processing", summary_sent_at: null },
      { statusUpdates },
    );

    const result = await recoverSlipBatch(supabase, "batch-1", failingPush("LINE push HTTP 503"));

    expect(result.ok).toBe(false);
    expect(result.result).toBe("delivery_failed");
    expect(result.error).toContain("LINE push HTTP 503");
    expect(statusUpdates.find((u) => u.summary_sent_at)).toBeUndefined();
  });

  it("already finalized batch → already_finalized (no-op, no message sent)", async () => {
    const pushCalls: Array<unknown> = [];
    const supabase = makeRecoverSupabase({
      status:          "completed",
      summary_sent_at: "2026-01-01T00:00:00Z",
    });

    const result = await recoverSlipBatch(supabase, "batch-1", async () => {
      pushCalls.push("called");
      return { status: "delivered" as const };
    });

    expect(result.ok).toBe(true);
    expect(result.result).toBe("already_finalized");
    expect(pushCalls).toHaveLength(0);
  });

  it("wrong batch status → throws 422", async () => {
    const supabase = makeRecoverSupabase({ status: "closing", summary_sent_at: null });
    await expect(recoverSlipBatch(supabase, "batch-1", deliveredPush())).rejects.toThrow(
      "not in processing or unsent review_needed status",
    );
  });

  it("unsent review_needed batch (permanent LINE failure) → retried with batch-id key and finalized", async () => {
    const pushCalls: Array<{ to: string; retryKey?: string }> = [];
    const statusUpdates: Array<Record<string, unknown>> = [];
    const supabase = makeRecoverSupabase(
      { status: "review_needed", summary_sent_at: null },
      { statusUpdates },
    );

    const result = await recoverSlipBatch(supabase, "batch-1", deliveredPush(pushCalls));

    expect(result).toEqual({ ok: true, result: "finalized", batchId: "batch-1" });
    expect(pushCalls).toEqual([{ to: "group-abc", retryKey: "batch-1" }]);
    expect(statusUpdates[0]?.summary_sent_at).toBeTruthy();
  });

  it("sent review_needed batch → already_finalized, no message sent", async () => {
    const pushCalls: Array<{ to: string; retryKey?: string }> = [];
    const supabase = makeRecoverSupabase({
      status:          "review_needed",
      summary_sent_at: "2026-01-01T00:00:00Z",
    });

    const result = await recoverSlipBatch(supabase, "batch-1", deliveredPush(pushCalls));

    expect(result.result).toBe("already_finalized");
    expect(pushCalls).toHaveLength(0);
  });

  it("unsent review_needed batch outside 24-hour window → requires_manual_review, no message", async () => {
    const pushCalls: Array<{ to: string; retryKey?: string }> = [];
    const supabase = makeRecoverSupabase({
      status:          "review_needed",
      summary_sent_at: null,
      closing_at:      new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });

    const result = await recoverSlipBatch(supabase, "batch-1", deliveredPush(pushCalls));

    expect(result.result).toBe("requires_manual_review");
    expect(pushCalls).toHaveLength(0);
  });

  it("unsent completed/failed batch → still rejected with 422", async () => {
    for (const status of ["completed", "failed"]) {
      const supabase = makeRecoverSupabase({ status, summary_sent_at: null });
      await expect(recoverSlipBatch(supabase, "batch-1", deliveredPush())).rejects.toThrow(
        "not in processing or unsent review_needed status",
      );
    }
  });

  it("batch not found → throws error", async () => {
    const supabase = makeRecoverSupabase(null);
    await expect(recoverSlipBatch(supabase, "missing-id", deliveredPush())).rejects.toThrow(
      "Batch not found",
    );
  });

  it("batch older than 24-hour window → requires_manual_review, no message", async () => {
    const oldClosingAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const supabase = makeRecoverSupabase({
      status: "processing", summary_sent_at: null, closing_at: oldClosingAt,
    });
    const pushCalls: Array<unknown> = [];
    const result = await recoverSlipBatch(supabase, "batch-1", async () => {
      pushCalls.push("called");
      return { status: "delivered" as const };
    });
    expect(result.ok).toBe(false);
    expect(result.result).toBe("requires_manual_review");
    expect(pushCalls).toHaveLength(0);
  });
});

// ── HTTP route tests via handleRecoverRequest ─────────────────────────────────

const VALID_UUID = "123e4567-e89b-12d3-a456-426614174000";

function makeRequest(
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  const isRawString = typeof body === "string";
  return new NextRequest(
    "http://localhost/api/cron/finalize-slip-batches/recover",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: isRawString ? body : JSON.stringify(body),
    },
  );
}

describe("handleRecoverRequest — HTTP layer", () => {
  const originalSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = "test-secret";
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = originalSecret;
    }
  });

  const authed = { Authorization: "Bearer test-secret" };
  const wrongAuth = { Authorization: "Bearer wrong" };

  it("missing Authorization → 401", async () => {
    const req = makeRequest({ batch_id: VALID_UUID });
    const res = await handleRecoverRequest(req);
    expect(res.status).toBe(401);
  });

  it("wrong Authorization token → 401", async () => {
    const req = makeRequest({ batch_id: VALID_UUID }, wrongAuth);
    const res = await handleRecoverRequest(req);
    expect(res.status).toBe(401);
  });

  it("missing CRON_SECRET configuration → 500", async () => {
    delete process.env.CRON_SECRET;
    const req = makeRequest({ batch_id: VALID_UUID }, authed);
    const res = await handleRecoverRequest(req);
    expect(res.status).toBe(500);
    const body = await res.json() as { error?: string };
    expect(body.error).toContain("CRON_SECRET");
  });

  it("malformed JSON body → 400", async () => {
    const req = makeRequest("{bad json}", authed);
    const res = await handleRecoverRequest(req);
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: string };
    expect(body.error).toContain("JSON");
  });

  it("missing batch_id → 400 with invalid_batch_id result", async () => {
    const req = makeRequest({}, authed);
    const res = await handleRecoverRequest(req);
    expect(res.status).toBe(400);
    const body = await res.json() as { result?: string };
    expect(body.result).toBe("invalid_batch_id");
  });

  it("non-string batch_id (number) → 400 with invalid_batch_id result", async () => {
    const req = makeRequest({ batch_id: 12345 }, authed);
    const res = await handleRecoverRequest(req);
    expect(res.status).toBe(400);
    const body = await res.json() as { result?: string };
    expect(body.result).toBe("invalid_batch_id");
  });

  it("invalid UUID (not a UUID format) → 400 with invalid_batch_id result", async () => {
    const req = makeRequest({ batch_id: "not-a-uuid" }, authed);
    const res = await handleRecoverRequest(req);
    expect(res.status).toBe(400);
    const body = await res.json() as { result?: string };
    expect(body.result).toBe("invalid_batch_id");
  });

  it("valid UUID reaches recoverSlipBatch (no DB call for invalid input)", async () => {
    let dbCalled = false;
    const supabase = {
      from() {
        dbCalled = true;
        throw new Error("should not be called for invalid input");
      },
    } as unknown as SupabaseClient<Database>;

    // First confirm invalid input never hits DB
    const invalidReq = makeRequest({ batch_id: "invalid" }, authed);
    await handleRecoverRequest(invalidReq, { getSupabase: () => supabase });
    expect(dbCalled).toBe(false);

    // Valid UUID does reach recoverSlipBatch (DB called, throws "Batch not found")
    const validReq = makeRequest({ batch_id: VALID_UUID }, authed);
    const res = await handleRecoverRequest(validReq, {
      getSupabase: () => makeRecoverSupabase(null),
    });
    expect(res.status).toBe(404);
  });

  it("persistence_failed maps to HTTP 500", async () => {
    const supabase = makeRecoverSupabase(
      { status: "processing", summary_sent_at: null },
      { updateErrors: [{ message: "db write failed" }] },
    );
    const req = makeRequest({ batch_id: VALID_UUID }, authed);
    const res = await handleRecoverRequest(req, {
      getSupabase: () => supabase,
      push: deliveredPush(),
    });
    expect(res.status).toBe(500);
    const body = await res.json() as { result?: string };
    expect(body.result).toBe("persistence_failed");
  });

  it("finalized maps to HTTP 200", async () => {
    const supabase = makeRecoverSupabase({ status: "processing", summary_sent_at: null });
    const req = makeRequest({ batch_id: VALID_UUID }, authed);
    const res = await handleRecoverRequest(req, {
      getSupabase: () => supabase,
      push: deliveredPush(),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { result?: string };
    expect(body.result).toBe("finalized");
  });

  it("already_finalized maps to HTTP 200 (idempotent)", async () => {
    const supabase = makeRecoverSupabase({
      status: "completed", summary_sent_at: "2026-01-01T00:00:00Z",
    });
    const req = makeRequest({ batch_id: VALID_UUID }, authed);
    const res = await handleRecoverRequest(req, {
      getSupabase: () => supabase,
      push: deliveredPush(),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { result?: string };
    expect(body.result).toBe("already_finalized");
  });

  it("requires_manual_review maps to HTTP 422", async () => {
    const oldClosingAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const supabase = makeRecoverSupabase({
      status: "processing", summary_sent_at: null, closing_at: oldClosingAt,
    });
    const req = makeRequest({ batch_id: VALID_UUID }, authed);
    const res = await handleRecoverRequest(req, {
      getSupabase: () => supabase,
      push: deliveredPush(),
    });
    expect(res.status).toBe(422);
    const body = await res.json() as { result?: string };
    expect(body.result).toBe("requires_manual_review");
  });

  // ── 1. delivery_failed HTTP mapping ──────────────────────────────────────────

  it("delivery_failed maps to HTTP 502 with safe response body", async () => {
    const supabase = makeRecoverSupabase({ status: "processing", summary_sent_at: null });
    const req = makeRequest({ batch_id: VALID_UUID }, authed);
    const res = await handleRecoverRequest(req, {
      getSupabase: () => supabase,
      push: failingPush("LINE push HTTP 429"),
    });
    expect(res.status).toBe(502);
    const body = await res.json() as { ok?: boolean; result?: string; error?: string };
    expect(body.ok).toBe(false);
    expect(body.result).toBe("delivery_failed");
    // Safe: error field carries the message but no tokens or slip data
    expect(typeof body.error).toBe("string");
  });

  // ── 2. Uppercase UUID acceptance ─────────────────────────────────────────────

  it("uppercase UUID passes validation and reaches the handler", async () => {
    const upperUUID = "123E4567-E89B-12D3-A456-426614174000";
    const supabase = makeRecoverSupabase(null); // returns batch not found → 404
    const req = makeRequest({ batch_id: upperUUID }, authed);
    const res = await handleRecoverRequest(req, { getSupabase: () => supabase });
    // Must NOT reject as invalid_batch_id
    expect(res.status).not.toBe(400);
    const body = await res.json() as { result?: string };
    expect(body.result).not.toBe("invalid_batch_id");
    // Reached the DB layer (batch not found)
    expect(res.status).toBe(404);
  });

  // ── 3. Invalid input dependency isolation ─────────────────────────────────────
  //
  // Each case must return 400 without calling getSupabase() or push().

  function makeTrackedDeps(): {
    deps: { getSupabase: () => SupabaseClient<Database>; push: (to: string, text: string, retryKey?: string) => Promise<PushResult> };
    dbCallCount: () => number;
    pushCallCount: () => number;
  } {
    let dbCalls = 0;
    let pushCalls = 0;
    return {
      deps: {
        getSupabase: () => {
          dbCalls++;
          return makeRecoverSupabase(null);
        },
        push: async () => {
          pushCalls++;
          return { status: "delivered" as const };
        },
      },
      dbCallCount:   () => dbCalls,
      pushCallCount: () => pushCalls,
    };
  }

  it("missing batch_id: no DB or push call", async () => {
    const { deps, dbCallCount, pushCallCount } = makeTrackedDeps();
    const req = makeRequest({}, authed);
    const res = await handleRecoverRequest(req, deps);
    expect(res.status).toBe(400);
    expect(dbCallCount()).toBe(0);
    expect(pushCallCount()).toBe(0);
  });

  it("non-string batch_id: no DB or push call", async () => {
    const { deps, dbCallCount, pushCallCount } = makeTrackedDeps();
    const req = makeRequest({ batch_id: 99 }, authed);
    const res = await handleRecoverRequest(req, deps);
    expect(res.status).toBe(400);
    expect(dbCallCount()).toBe(0);
    expect(pushCallCount()).toBe(0);
  });

  it("invalid UUID string: no DB or push call", async () => {
    const { deps, dbCallCount, pushCallCount } = makeTrackedDeps();
    const req = makeRequest({ batch_id: "not-a-uuid" }, authed);
    const res = await handleRecoverRequest(req, deps);
    expect(res.status).toBe(400);
    expect(dbCallCount()).toBe(0);
    expect(pushCallCount()).toBe(0);
  });

  it("malformed JSON: no DB or push call", async () => {
    const { deps, dbCallCount, pushCallCount } = makeTrackedDeps();
    const req = makeRequest("{bad json}", authed);
    const res = await handleRecoverRequest(req, deps);
    expect(res.status).toBe(400);
    expect(dbCallCount()).toBe(0);
    expect(pushCallCount()).toBe(0);
  });
});
