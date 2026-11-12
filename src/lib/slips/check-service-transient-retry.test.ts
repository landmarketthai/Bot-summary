/**
 * SlipCheckService wiring of the durable transient-OCR retry (defer_slip_check,
 * migration 20261110090000) with an in-memory RPC double. The SQL itself is
 * proven in ocr-transient-retry.pg.test.ts; here: which RPC is called with what,
 * that Gemini is never called during a shared cooldown, and that no LINE push
 * or money write happens for a deferred check.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildBatchSummaryMessage, type EvidenceWithCheck } from "@/lib/slips/batch-finalizer";
import { SlipCheckService } from "@/lib/slips/check-service";
import type { SlipExtraction } from "@/lib/slips/extraction-schema";
import { ExtractionHttpError, type SlipExtractor } from "@/lib/slips/extractor";
import { SLIP_INGEST_POLICY, assessOcrRetryWindow, ocrRetryDelaySeconds } from "@/lib/slips/ingest-policy";
import { createProductionSlipExtractor } from "@/lib/slips/production-extractor";
import type { Database } from "@/types/database";

const ok: SlipExtraction = {
  slipType: "BANK_SLIP_NO_QR", grossAmount: null, discountAmount: null, paidAmount: null,
  transferAmount: 500, referenceId: "REF1", transactionTime: "2026-11-10T05:00:00.000Z",
  senderName: "s", receiverName: "r", receiverAccountTail: "1234", paymentChannelText: null,
  headlineTotalAmount: null, confidence: 0.95,
};

interface Opts {
  batchId?: string | null;
  cooldownUntil?: string | null;
  defer?: (args: Record<string, unknown>) => { data: unknown; error: unknown };
}

function fake(opts: Opts = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const pushes: string[] = [];
  const client = {
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      if (name === "claim_slip_check") {
        return { data: { claimed: true, check_id: "c1", token: 7, provider_cooldown_until: opts.cooldownUntil ?? null }, error: null };
      }
      if (name === "defer_slip_check") return opts.defer?.(args) ?? { data: { outcome: "deferred", retry_count: 1 }, error: null };
      if (name === "fail_slip_check") return { data: { outcome: "failed" }, error: null };
      if (name === "complete_slip_check") return { data: { outcome: "completed" }, error: null };
      return { data: null, error: { code: "PGRST000", message: "unhandled" } };
    },
    storage: { from: () => ({ download: async () => ({ data: new Blob([new Uint8Array([1])]), error: null }) }) },
    from() {
      const evidence = {
        id: "e1", source_id: "G1", storage_bucket: "b", storage_path: "p", mime_type: "image/jpeg",
        status: "RECEIVED", batch_id: opts.batchId === undefined ? "batch-1" : opts.batchId,
      };
      return {
        select: () => ({ eq: () => ({
          single: async () => ({ data: evidence, error: null }),
          maybeSingle: async () => ({ data: evidence, error: null }),
          neq: () => ({ limit: async () => ({ data: [], error: null }) }),
        }) }),
      };
    },
  };
  const names = () => calls.map((c) => c.name);
  const svc = (extractor: SlipExtractor) => new SlipCheckService(
    client as unknown as SupabaseClient<Database>, extractor, async (_to, text) => { pushes.push(text); },
  );
  return { calls, names, pushes, svc };
}

function throwing(error: Error) {
  let n = 0;
  const extractor: SlipExtractor = { async extract() { n += 1; throw error; } };
  return { extractor, count: () => n };
}

describe("transient OCR failures are deferred, not failed", () => {
  it("429 with Retry-After: one defer (counted, seconds rounded up), no fail/complete, no push", async () => {
    const f = fake();
    const g = throwing(new ExtractionHttpError(429, "rate_limit", true, "", 3, 1_500));
    await f.svc(g.extractor).processEvidence("e1");
    expect(g.count()).toBe(1);
    expect(f.names()).toEqual(["claim_slip_check", "defer_slip_check"]);
    expect(f.calls[1].args).toEqual({
      p_check_id: "c1", p_token: 7, p_reason: "extractor_http_rate_limit",
      p_retry_after_seconds: 2, p_count_attempt: true,
    });
    expect(f.pushes).toEqual([]);
  });

  it("sanitizes extreme or non-finite Retry-After values before defer RPC", async () => {
    const cases: Array<[number, number | null]> = [
      [(2 ** 31 + 1) * 1_000, 3_600],
      [Number.POSITIVE_INFINITY, null],
      [Number.NaN, null],
    ];
    for (const [retryAfterMs, expected] of cases) {
      const f = fake();
      const error = new ExtractionHttpError(429, "rate_limit", true, "", 3, retryAfterMs);
      await f.svc(throwing(error).extractor).processEvidence("e1");
      expect(f.calls[1]).toEqual({ name: "defer_slip_check", args: expect.objectContaining({
        p_retry_after_seconds: expected,
        p_count_attempt: true,
      }) });
    }
  });

  it.each([
    ["503", new ExtractionHttpError(503, "upstream_error", true, "", 3), "extractor_http_upstream_error"],
    ["timeout", new ExtractionHttpError(0, "timeout", true, "", 10_000), "extractor_http_timeout"],
  ])("%s defers with p_retry_after_seconds null", async (_label, error, reason) => {
    const f = fake();
    await f.svc(throwing(error).extractor).processEvidence("e1");
    expect(f.calls[1]).toEqual({ name: "defer_slip_check", args: expect.objectContaining({
      p_reason: reason, p_retry_after_seconds: null, p_count_attempt: true,
    }) });
    expect(f.names()).not.toContain("fail_slip_check");
  });

  it("active shared cooldown: Gemini is NOT called; uncounted defer with the remaining cooldown", async () => {
    const f = fake({ cooldownUntil: new Date(Date.now() + 45_000).toISOString() });
    const gemini = throwing(new Error("must not be called"));
    await f.svc(gemini.extractor).processEvidence("e1");
    expect(gemini.count()).toBe(0);
    const args = f.calls[1].args;
    expect(f.calls[1].name).toBe("defer_slip_check");
    expect(args.p_count_attempt).toBe(false);
    expect(args.p_reason).toBe("extractor_http_rate_limit");
    expect(args.p_retry_after_seconds as number).toBeGreaterThan(40);
    expect(args.p_retry_after_seconds as number).toBeLessThanOrEqual(45);
  });

  it("an expired cooldown does not block Gemini", async () => {
    const f = fake({ cooldownUntil: new Date(Date.now() - 1_000).toISOString() });
    await f.svc({ async extract() { return ok; } }).processEvidence("e1");
    expect(f.names()).toEqual(["claim_slip_check", "complete_slip_check"]);
  });

  it("disabled / unconfigured extractor fails closed even during a cooldown (no defer)", async () => {
    for (const env of [{}, { SLIP_GEMINI_OCR_ENABLED: "true" }]) {
      const f = fake({ cooldownUntil: new Date(Date.now() + 60_000).toISOString() });
      await f.svc(createProductionSlipExtractor(env)).processEvidence("e1");
      expect(f.names()).toEqual(["claim_slip_check", "fail_slip_check"]);
    }
  });

  it("nontransient (401, invalid output) goes straight to fail_slip_check", async () => {
    for (const error of [
      new ExtractionHttpError(401, "auth_error", false, "", 3),
      new Error("Image extraction provider returned invalid extraction schema"),
    ]) {
      const f = fake();
      await f.svc(throwing(error).extractor).processEvidence("e1");
      expect(f.names()).toEqual(["claim_slip_check", "fail_slip_check"]);
    }
  });

  it("defer says FAILED (un-batched / exhausted): no second write; un-batched gets one notice", async () => {
    const f = fake({ batchId: null, defer: () => ({ data: { outcome: "failed", reason: "unbatched" }, error: null }) });
    await f.svc(throwing(new ExtractionHttpError(429, "rate_limit", true, "", 3)).extractor).processEvidence("e1");
    expect(f.names()).toEqual(["claim_slip_check", "defer_slip_check"]);
    expect(f.pushes).toHaveLength(1);
  });

  it.each(["stale_claim", "already_terminal", "batch_not_open"])(
    "defer outcome %s: nothing else written, no notice", async (outcome) => {
      const f = fake({ batchId: null, defer: () => ({ data: { outcome }, error: null }) });
      await f.svc(throwing(new ExtractionHttpError(503, "upstream_error", true, "", 3)).extractor).processEvidence("e1");
      expect(f.names()).toEqual(["claim_slip_check", "defer_slip_check"]);
      expect(f.pushes).toEqual([]);
    });

  it("defer RPC missing or erroring: falls back to fail_slip_check (fail closed, as before)", async () => {
    for (const error of [{ code: "PGRST202", message: "missing" }, { code: "57014", message: "timeout" }]) {
      const f = fake({ defer: () => ({ data: null, error }) });
      await f.svc(throwing(new ExtractionHttpError(429, "rate_limit", true, "", 3)).extractor).processEvidence("e1");
      expect(f.names()).toEqual(["claim_slip_check", "defer_slip_check", "fail_slip_check"]);
    }
  });
});

describe("policy mirrors defer_slip_check and is reported honestly", () => {
  const sql = readFileSync(
    join(import.meta.dir, "..", "..", "..", "supabase", "migrations", "20261110090000_slip_ocr_transient_retry.sql"),
    "utf8",
  );
  const constant = (name: string) => Number(sql.match(new RegExp(`${name}\\s+constant integer := (\\d+);`))?.[1]);
  const r = SLIP_INGEST_POLICY.ocr.transientRetry;

  it("constants match the migration", () => {
    expect(constant("c_max_retries")).toBe(r.maxRetries);
    expect(constant("c_base")).toBe(r.backoffBaseSeconds);
    expect(constant("c_cap")).toBe(r.backoffCapSeconds);
    expect(constant("c_retry_after")).toBe(r.maxRetryAfterSeconds);
    expect(sql).toMatch(/c_max_age\s+constant interval := interval '24 hours';/);
    expect(r.maxAgeSeconds).toBe(86_400);
  });

  it("backoff: exponential, capped, never shorter than Retry-After", () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => ocrRetryDelaySeconds(n))).toEqual([60, 120, 240, 480, 600, 600]);
    expect(ocrRetryDelaySeconds(1, 200)).toBe(200);
    expect(ocrRetryDelaySeconds(1, 99_999)).toBe(3_600);
  });

  it("the close's OCR wait is not extended: only 1 retry is guaranteed for a 10-image batch", () => {
    expect(assessOcrRetryWindow(10)).toEqual({
      ocrWaitSeconds: 870, maxRetries: 4, maxAgeSeconds: 86_400,
      guaranteedRetriesBeforeClose: 1, nominalRetriesBeforeClose: 2,
    });
  });
});

describe("batch summary for a retry the close outran", () => {
  const base: EvidenceWithCheck = {
    id: "e1", checkId: "c1", batchIndex: 1, checkStatus: "PROCESSING", slipType: "UNKNOWN",
    grossAmount: null, discountAmount: null, transferAmount: null, paidAmount: null, transactionTime: null,
    referenceId: null, ocrFallbackReason: null, bankVerificationIssue: null,
    failureReason: "ocr_retry:extractor_http_rate_limit",
  };

  it("reported as a transient OCR failure, not counted, not 'waiting'", () => {
    const text = buildBatchSummaryMessage([base], { isTimeout: true, slipDate: "2026-11-10" });
    expect(text).toContain("ลองอ่านซ้ำไม่ทันปิดชุด: 1 รูป");
    expect(text).toContain("รูปที่ 1: ระบบอ่านรูปขัดข้องชั่วคราว ลองอ่านซ้ำไม่ทันปิดชุด");
    expect(text).not.toContain("ยังรอผล");
    expect(text).toContain("ยังรวมยอดไม่ได้");
  });

  it("a terminalized FAILED retry marker is reviewable but not also a generic failure", () => {
    const text = buildBatchSummaryMessage([{ ...base, checkStatus: "FAILED" }], { isTimeout: true, slipDate: "2026-11-10" });
    expect(text).toContain("ลองอ่านซ้ำไม่ทันปิดชุด: 1 รูป");
    expect(text).toContain("รูปที่ 1: ระบบอ่านรูปขัดข้องชั่วคราว ลองอ่านซ้ำไม่ทันปิดชุด");
    expect(text).toContain("มีรูปที่ต้องตรวจทาน: 1 รูป");
    expect(text).not.toContain("อ่านไม่สำเร็จ: 1 รูป");
    expect(text).not.toContain("ยังรอผล");
  });

  it("a plain PROCESSING check (no retry marker) still reads as waiting", () => {
    const text = buildBatchSummaryMessage([{ ...base, failureReason: null }], { isTimeout: true, slipDate: "2026-11-10" });
    expect(text).toContain("ยังรอผล: 1 รูป");
    expect(text).not.toContain("ลองอ่านซ้ำไม่ทัน");
  });

  it("exhausted timeout / 5xx failures get an accurate transient wording", () => {
    for (const reason of ["extractor_http_timeout", "extractor_http_upstream_error"]) {
      const text = buildBatchSummaryMessage([{ ...base, checkStatus: "FAILED", failureReason: reason }], { slipDate: "2026-11-10" });
      expect(text).toContain("ระบบอ่านรูปขัดข้องชั่วคราว กรุณาส่งรูปใหม่ภายหลัง");
    }
  });
});
