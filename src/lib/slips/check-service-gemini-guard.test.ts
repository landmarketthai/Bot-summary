/**
 * Adversarial guard tests for the Gemini-ONLY slip OCR wiring through the
 * fenced SlipCheckService path (claim_slip_check / complete_slip_check /
 * fail_slip_check). There is no OpenAI/legacy fallback: every Gemini failure
 * must fail the check closed (FAILED, nothing counted). Every dependency is
 * injected via the constructor: no bun mock.module, no network, no DB, no LINE.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SlipCheckService } from "@/lib/slips/check-service";
import { EasySlipVerificationError, type BankSlipVerifier, type EasySlipResult } from "@/lib/slips/easyslip-bank";
import type { SlipExtraction } from "@/lib/slips/extraction-schema";
import type { SlipExtractionInput, SlipExtractor } from "@/lib/slips/extractor";
import { GeminiSlipExtractor } from "@/lib/slips/gemini-extractor";
import { createProductionSlipExtractor } from "@/lib/slips/production-extractor";
import type { Database } from "@/types/database";

const API_KEY = "AIza-test-secret-key";
const SOURCE = "group-1";

// ---------------------------------------------------------------------------
// Fake Supabase: fenced claim RPCs + call recording
// ---------------------------------------------------------------------------

interface FakeCheck {
  evidenceId: string;
  status: string;
  token: number;
  fields?: Record<string, unknown>;
  failureReason?: string;
}

interface FakeOpts {
  batchId?: string | null;
  claim?: (evidenceId: string) => Record<string, unknown>;
  completeOutcome?: string;
  failOutcome?: string;
}

function createFakeSupabase(opts: FakeOpts = {}) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const downloads: string[] = [];
  const legacyWrites: Array<Record<string, unknown>> = [];
  const checks = new Map<string, FakeCheck>();
  const claimed = new Set<string>();
  let nextToken = 1;

  const rpc = async (name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    if (name === "claim_slip_check") {
      const evidenceId = String(args.p_evidence_id);
      if (opts.claim) return { data: opts.claim(evidenceId), error: null };
      if (claimed.has(evidenceId)) return { data: { claimed: false, reason: "already_terminal" }, error: null };
      claimed.add(evidenceId);
      const checkId = `check-${evidenceId}`;
      const token = nextToken++;
      checks.set(checkId, { evidenceId, status: "PROCESSING", token });
      return { data: { claimed: true, check_id: checkId, token }, error: null };
    }
    if (name === "complete_slip_check" || name === "fail_slip_check") {
      const override = name === "complete_slip_check" ? opts.completeOutcome : opts.failOutcome;
      if (override) return { data: { outcome: override }, error: null };
      const check = checks.get(String(args.p_check_id));
      if (!check || check.token !== args.p_token) return { data: { outcome: "stale_claim" }, error: null };
      if (check.status !== "PROCESSING") return { data: { outcome: "already_terminal" }, error: null };
      if (name === "complete_slip_check") {
        check.status = String(args.p_status);
        check.fields = args.p_fields as Record<string, unknown>;
      } else {
        check.status = "FAILED";
        check.failureReason = String(args.p_reason);
      }
      return { data: { outcome: name === "complete_slip_check" ? "completed" : "failed" }, error: null };
    }
    return { data: null, error: { code: "PGRST000", message: `unhandled rpc ${name}` } };
  };

  const client = {
    rpc,
    storage: {
      from(bucket: string) {
        return {
          async download(path: string) {
            downloads.push(`${bucket}/${path}`);
            return { data: new Blob([new Uint8Array([1, 2, 3])]), error: null };
          },
        };
      },
    },
    from(table: string) {
      if (table === "slip_evidences") {
        return {
          select() {
            return {
              eq(_col: string, id: string) {
                return {
                  async single() {
                    return {
                      data: {
                        id, source_id: SOURCE, storage_bucket: "slip-evidence",
                        storage_path: `slips/${id}.jpg`, mime_type: "image/jpeg",
                        status: "RECEIVED", batch_id: opts.batchId ?? null,
                      },
                      error: null,
                    };
                  },
                  async maybeSingle() {
                    return { data: { source_id: SOURCE, received_at: "2026-11-07T01:00:00Z", batch_id: null }, error: null };
                  },
                };
              },
            };
          },
        };
      }
      if (table === "slip_checks") {
        return {
          upsert(row: Record<string, unknown>) { legacyWrites.push({ op: "upsert", ...row }); throw new Error("legacy upsert must not run"); },
          update(row: Record<string, unknown>) { legacyWrites.push({ op: "update", ...row }); throw new Error("legacy update must not run"); },
          // transaction-dedupe lookup: no prior checks.
          select() {
            const chain = {
              eq: () => chain, in: () => chain, order: () => chain,
              then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
            };
            return chain;
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient<Database>;

  const callsOf = (name: string) => rpcCalls.filter((c) => c.name === name);
  return { client, rpcCalls, callsOf, downloads, legacyWrites, checks };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A plain bank-slip read, returned by injected (non-HTTP) Gemini stand-ins. */
const bankRead: SlipExtraction = {
  slipType: "BANK_SLIP_NO_QR", grossAmount: null, discountAmount: null, paidAmount: null,
  transferAmount: 315, referenceId: "BANK-REF", transactionTime: "2026-11-07T03:35:00.000Z",
  senderName: "ผู้โอน", receiverName: "ร้านรับเงิน", receiverAccountTail: "1234",
  paymentChannelText: null, headlineTotalAmount: null, confidence: 0.9,
};

/** Wire JSON matching SLIP_EXTRACTION_JSON_SCHEMA (all required keys, no extras). */
const geminiBankJson = {
  slip_type: "BANK_SLIP_QR", gross_amount: null, discount_amount: null, paid_amount: null,
  project_right_amount: null, gwallet_amount: null, headline_total_amount: null,
  transfer_amount: 500, reference_id: "GEMINI-REF", transaction_time: "2026-11-07T10:00:00+07:00",
  sender_name: "ผู้โอน", receiver_name: "ร้านรับเงิน", receiver_account_tail: "5678",
  payment_channel_text: null, confidence: 0.95,
};

function geminiReply(value: unknown = geminiBankJson): Response {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }] }));
}

function countingExtractor(impl: (input: SlipExtractionInput, n: number) => Promise<SlipExtraction>) {
  const counter = { calls: 0 };
  const extractor: SlipExtractor = {
    async extract(input) { counter.calls++; return impl(input, counter.calls); },
  };
  return { counter, extractor };
}

function fakeGeminiFetch(handler: (n: number) => Response | Promise<Response>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fn = async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } });
    return handler(calls.length);
  };
  return { calls, fetchImpl: Object.assign(fn, { preconnect: () => {} }) as unknown as typeof fetch };
}

function realGemini(handler: (n: number) => Response | Promise<Response>) {
  const fake = fakeGeminiFetch(handler);
  return { ...fake, extractor: new GeminiSlipExtractor(API_KEY, "gemini-3.5-flash-lite", fake.fetchImpl, 5_000) };
}

function verifier(impl: () => Promise<EasySlipResult>) {
  const counter = { calls: 0 };
  const v: BankSlipVerifier = { async verifyImage() { counter.calls++; return impl(); } };
  return { counter, verifier: v };
}

const neverVerifier: BankSlipVerifier = {
  async verifyImage() { throw new Error("EasySlip must not run when disabled"); },
};

function pushRecorder() {
  const pushes: Array<{ to: string; text: string }> = [];
  return { pushes, push: async (to: string, text: string) => { pushes.push({ to, text }); } };
}

function completedFields(fake: ReturnType<typeof createFakeSupabase>, i = 0) {
  return fake.callsOf("complete_slip_check")[i]?.args.p_fields as Record<string, unknown>;
}

/** Exactly one fenced FAILED write with `reason`, nothing completed or counted. */
function expectFailedClosed(fake: ReturnType<typeof createFakeSupabase>, reason: string, checkId = "check-ev-1") {
  expect(fake.callsOf("complete_slip_check")).toHaveLength(0);
  expect(fake.callsOf("fail_slip_check")).toHaveLength(1);
  expect(fake.callsOf("fail_slip_check")[0].args.p_reason).toBe(reason);
  expect(fake.legacyWrites).toHaveLength(0);
  expect(fake.checks.get(checkId)?.status).toBe("FAILED");
}

/** One FAILED LINE notice to the source, never a green "counted" summary. */
function expectOneFailedPush(pushes: Array<{ to: string; text: string }>) {
  expect(pushes).toHaveLength(1);
  expect(pushes[0].to).toBe(SOURCE);
  expect(pushes[0].text.startsWith("🔴")).toBe(true);
  expect(pushes[0].text).not.toContain("🟢");
}

// ---------------------------------------------------------------------------
// Env + console isolation
// ---------------------------------------------------------------------------

const ENV_KEYS = ["EASYSLIP_BANK_VERIFICATION_ENABLED", "EASYSLIP_LINE_SOURCE_IDS"] as const;
let savedEnv: Record<string, string | undefined> = {};
let logLines: string[] = [];
const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };

function enableEasySlip() {
  process.env.EASYSLIP_BANK_VERIFICATION_ENABLED = "true";
  process.env.EASYSLIP_LINE_SOURCE_IDS = SOURCE;
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  logLines = [];
  const capture = (...args: unknown[]) => { logLines.push(args.map(String).join(" ")); };
  console.log = capture; console.info = capture; console.warn = capture; console.error = capture; console.debug = capture;
});

afterEach(() => {
  Object.assign(console, originalConsole);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ---------------------------------------------------------------------------
// 1-3. EasySlip verified path never touches OCR
// ---------------------------------------------------------------------------

describe("EasySlip verified results bypass Gemini OCR", () => {
  const cases: Array<[string, { isDuplicate: boolean; accountMatched: boolean }, string, boolean]> = [
    ["verified + matched + unique", { isDuplicate: false, accountMatched: true }, "EXTRACTED", true],
    ["verified but duplicate", { isDuplicate: true, accountMatched: true }, "NEED_REVIEW", false],
    ["verified but receiver mismatch", { isDuplicate: false, accountMatched: false }, "NEED_REVIEW", false],
  ];

  it.each(cases)("%s", async (_label, flags, expectedStatus, bankVerified) => {
    enableEasySlip();
    const fake = createFakeSupabase();
    const gemini = countingExtractor(async () => { throw new Error("Gemini must not run"); });
    const bank = verifier(async () => ({ kind: "verified", ...flags,
      extraction: { ...bankRead, slipType: "BANK_SLIP_QR", referenceId: "EASYSLIP-REF", confidence: 1 } }));
    const { pushes, push } = pushRecorder();
    const service = new SlipCheckService(fake.client, gemini.extractor, push, 300, bank.verifier);

    await service.processEvidence("ev-1");

    expect(bank.counter.calls).toBe(1);
    expect(gemini.counter.calls).toBe(0);
    expect(fake.callsOf("complete_slip_check")).toHaveLength(1);
    expect(fake.callsOf("fail_slip_check")).toHaveLength(0);
    const call = fake.callsOf("complete_slip_check")[0];
    expect(call.args.p_status).toBe(expectedStatus);
    expect(completedFields(fake)).toMatchObject({
      reference_id: "EASYSLIP-REF",
      extracted_json: { verification: { provider: "easyslip", bank_verified: bankVerified } },
    });
    expect(pushes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. EasySlip unavailable/not_found -> Gemini once; OCR never bank-verifies
// ---------------------------------------------------------------------------

describe("EasySlip fallback to Gemini OCR never constitutes bank verification", () => {
  const failures: Array<[string, () => Promise<EasySlipResult>, string]> = [
    ["provider_error", async () => { throw new EasySlipVerificationError("provider_error"); }, "provider_error"],
    ["not_found", async () => ({ kind: "not_found" }), "slip_not_found"],
  ];

  it.each(failures)("EasySlip %s -> Gemini bank slip quarantined NEED_REVIEW", async (_label, verify, reason) => {
    for (const slipType of ["BANK_SLIP_QR", "BANK_SLIP_NO_QR"] as const) {
      enableEasySlip();
      const fake = createFakeSupabase();
      const gemini = realGemini(() => geminiReply({ ...geminiBankJson, slip_type: slipType }));
      const bank = verifier(verify);
      const { pushes, push } = pushRecorder();
      const service = new SlipCheckService(fake.client, gemini.extractor, push, 300, bank.verifier);

      await service.processEvidence("ev-1");

      expect(gemini.calls).toHaveLength(1);
      expect(fake.callsOf("complete_slip_check")).toHaveLength(1);
      expect(fake.callsOf("complete_slip_check")[0].args.p_status).toBe("NEED_REVIEW");
      expect(completedFields(fake)).toMatchObject({
        slip_type: slipType,
        transfer_amount: 500,
        extracted_json: { verification: { provider: "easyslip", bank_verified: false, reason } },
      });
      expect(pushes).toHaveLength(1);
      expect(pushes[0].text).not.toContain("🟢");
      expect(pushes[0].text).toContain("ยังไม่รวมยอดเงินอัตโนมัติ");
    }
  });

  it("EasySlip provider_error + Gemini 429 -> FAILED, never completed or treated as verified", async () => {
    enableEasySlip();
    const fake = createFakeSupabase();
    const gemini = realGemini(() => new Response("quota", { status: 429 }));
    const bank = verifier(async () => { throw new EasySlipVerificationError("provider_error"); });
    const { pushes, push } = pushRecorder();
    const service = new SlipCheckService(fake.client, gemini.extractor, push, 300, bank.verifier);

    await service.processEvidence("ev-1");

    expect(bank.counter.calls).toBe(1);
    expect(gemini.calls).toHaveLength(1);
    expectFailedClosed(fake, "extractor_http_rate_limit");
    expect(JSON.stringify(fake.rpcCalls)).not.toContain("bank_verified\":true");
    expect(pushes).toHaveLength(1);
    expect(pushes[0].text).not.toContain("🟢");
  });
});

// ---------------------------------------------------------------------------
// 5. Wallet amounts: gross is the headline total, never subsidy/paid
// ---------------------------------------------------------------------------

describe("Gemini wallet slip amount semantics through SlipCheckService", () => {
  const walletBase = {
    slip_type: "GWALLET", gross_amount: null, discount_amount: null, paid_amount: null,
    project_right_amount: 60, gwallet_amount: 40, headline_total_amount: 100,
    transfer_amount: null, reference_id: "WALLET-REF", transaction_time: "2026-11-07T09:00:00+07:00",
    sender_name: null, receiver_name: "ร้านค้า", receiver_account_tail: "9999",
    payment_channel_text: null, confidence: 0.92,
  };
  const variants: Array<[string, Record<string, unknown>]> = [
    ["headline only", {}],
    ["generic gross misread as paid (40) is overridden by headline", { gross_amount: 40 }],
    ["generic gross misread as subsidy (60) is overridden by headline", { gross_amount: 60 }],
    ["headline null, generic gross 100, generic paid/discount", {
      headline_total_amount: null, gross_amount: 100, project_right_amount: null, gwallet_amount: null,
      paid_amount: 40, discount_amount: 60 }],
    ["Thai Help Thai channel canonicalization keeps gross 100", { payment_channel_text: "ไทยช่วยไทย พลัส (60/40)", gross_amount: 40 }],
  ];

  it.each(variants)("%s", async (_label, overrides) => {
    const fake = createFakeSupabase();
    const gemini = realGemini(() => geminiReply({ ...walletBase, ...overrides }));
    const service = new SlipCheckService(fake.client, gemini.extractor, async () => {}, 300, neverVerifier);

    await service.processEvidence("ev-wallet");

    expect(gemini.calls).toHaveLength(1);
    const fields = completedFields(fake);
    expect(fields.gross_amount).toBe(100);
    expect(fields.paid_amount).toBe(40);
    expect(fields.discount_amount).toBe(60);
    expect(fields.transfer_amount).toBeNull();
    // Wallet receipts show the payer's tail; the parser fails closed.
    expect(fields.receiver_account_tail).toBeNull();
    expect(fake.callsOf("complete_slip_check")[0].args.p_status).toBe("EXTRACTED");
  });

  it("never derives gross from paid + subsidy when no gross/headline is visible", async () => {
    const fake = createFakeSupabase();
    const gemini = realGemini(() => geminiReply({ ...walletBase, headline_total_amount: null, gross_amount: null }));
    const service = new SlipCheckService(fake.client, gemini.extractor, async () => {}, 300, neverVerifier);

    await service.processEvidence("ev-wallet");

    // The Gemini read itself is stored: gross stays null, no other provider is consulted.
    expect(gemini.calls).toHaveLength(1);
    expect(fake.callsOf("complete_slip_check")).toHaveLength(1);
    expect(fake.callsOf("fail_slip_check")).toHaveLength(0);
    const fields = completedFields(fake);
    expect(fields.gross_amount).toBeNull();
    expect(fields.paid_amount).toBe(40);
    expect(fields.reference_id).toBe("WALLET-REF");
    // determineSlipCheckStatus: wallet with paid + time/ref but no gross -> PARTIAL_EXTRACTED.
    expect(fake.callsOf("complete_slip_check")[0].args.p_status).toBe("PARTIAL_EXTRACTED");
  });
});

// ---------------------------------------------------------------------------
// 6-8. Gemini failure fails closed with exactly one terminal write
// ---------------------------------------------------------------------------

describe("Gemini failure fails the check closed with a single terminal write", () => {
  it("Gemini 429: 1 fetch, no inline retry, one fail, zero complete, one FAILED push", async () => {
    const fake = createFakeSupabase();
    const gemini = realGemini(() => new Response("quota exhausted", { status: 429, headers: { "Retry-After": "1" } }));
    const { pushes, push } = pushRecorder();
    const service = new SlipCheckService(fake.client, gemini.extractor, push, 300, neverVerifier);

    await service.processEvidence("ev-1");

    expect(gemini.calls).toHaveLength(1);
    expect(fake.callsOf("claim_slip_check")).toHaveLength(1);
    expectFailedClosed(fake, "extractor_http_rate_limit");
    expectOneFailedPush(pushes);
  });

  it("Gemini persistent 503: at most 2 fetches, then FAILED upstream_error", async () => {
    const fake = createFakeSupabase();
    const gemini = realGemini(() => new Response("unavailable", { status: 503 }));
    const { pushes, push } = pushRecorder();
    const service = new SlipCheckService(fake.client, gemini.extractor, push, 300, neverVerifier);

    await service.processEvidence("ev-1"); // one real ~1s inline backoff

    expect(gemini.calls.length).toBeGreaterThanOrEqual(1);
    expect(gemini.calls.length).toBeLessThanOrEqual(2);
    expectFailedClosed(fake, "extractor_http_upstream_error");
    expectOneFailedPush(pushes);
  }, 10_000);

  it("Gemini 503 then success on retry: 2 fetches, Gemini read completed", async () => {
    const fake = createFakeSupabase();
    const gemini = realGemini((n) => (n === 1 ? new Response("x", { status: 503 }) : geminiReply()));
    const service = new SlipCheckService(fake.client, gemini.extractor, async () => {}, 300, neverVerifier);

    await service.processEvidence("ev-1");

    expect(gemini.calls).toHaveLength(2);
    expect(fake.callsOf("complete_slip_check")).toHaveLength(1);
    expect(fake.callsOf("fail_slip_check")).toHaveLength(0);
    expect(completedFields(fake)).toMatchObject({ reference_id: "GEMINI-REF", transfer_amount: 500 });
  }, 10_000);

  it("Gemini invalid schema output: 1 fetch, no retry, FAILED invalid_output", async () => {
    const fake = createFakeSupabase();
    const gemini = realGemini(() => geminiReply({ ...geminiBankJson, extra_field: "x" }));
    const { pushes, push } = pushRecorder();
    const service = new SlipCheckService(fake.client, gemini.extractor, push, 300, neverVerifier);

    await service.processEvidence("ev-1");

    expect(gemini.calls).toHaveLength(1);
    expectFailedClosed(fake, "extractor_invalid_output");
    expectOneFailedPush(pushes);
  });

  it("Gemini bank slip with null transfer amount is stored as NEED_REVIEW, not dropped or FAILED", async () => {
    const fake = createFakeSupabase();
    const gemini = realGemini(() => geminiReply({ ...geminiBankJson, transfer_amount: null }));
    const { pushes, push } = pushRecorder();
    const service = new SlipCheckService(fake.client, gemini.extractor, push, 300, neverVerifier);

    await service.processEvidence("ev-1");

    expect(gemini.calls).toHaveLength(1);
    expect(fake.callsOf("complete_slip_check")).toHaveLength(1);
    expect(fake.callsOf("fail_slip_check")).toHaveLength(0);
    expect(fake.callsOf("complete_slip_check")[0].args.p_status).toBe("NEED_REVIEW");
    expect(completedFields(fake)).toMatchObject({ reference_id: "GEMINI-REF", transfer_amount: null });
    expect(fake.checks.get("check-ev-1")?.status).toBe("NEED_REVIEW");
    expect(pushes).toHaveLength(1);
    expect(pushes[0].text).not.toContain("🟢");
  });

  it("arbitrary extractor Error: exactly one fail_slip_check, no complete, check FAILED", async () => {
    const fake = createFakeSupabase();
    const gemini = countingExtractor(async () => { throw new Error("something unexpected"); });
    const { pushes, push } = pushRecorder();
    const service = new SlipCheckService(fake.client, gemini.extractor, push, 300, neverVerifier);

    await service.processEvidence("ev-1");

    expect(gemini.counter.calls).toBe(1);
    expectFailedClosed(fake, "unknown_extraction_failure");
    expectOneFailedPush(pushes);
  });
});

// ---------------------------------------------------------------------------
// 9. Re-entrance / idempotency
// ---------------------------------------------------------------------------

describe("claim fencing prevents duplicate OCR spend and notifications", () => {
  it("claim_slip_check claimed:false -> no download, no extractor calls, no push", async () => {
    const fake = createFakeSupabase({ claim: () => ({ claimed: false, reason: "leased" }) });
    const gemini = countingExtractor(async () => bankRead);
    const { pushes, push } = pushRecorder();
    const service = new SlipCheckService(fake.client, gemini.extractor, push, 300, neverVerifier);

    await service.processEvidence("ev-1");

    expect(fake.downloads).toHaveLength(0);
    expect(gemini.counter.calls).toBe(0);
    expect(pushes).toHaveLength(0);
    expect(fake.callsOf("complete_slip_check")).toHaveLength(0);
    expect(fake.callsOf("fail_slip_check")).toHaveLength(0);
  });

  it("complete_slip_check stale_claim -> no push, no fail call", async () => {
    const fake = createFakeSupabase({ completeOutcome: "stale_claim" });
    const gemini = countingExtractor(async () => bankRead);
    const { pushes, push } = pushRecorder();
    const service = new SlipCheckService(fake.client, gemini.extractor, push, 300, neverVerifier);

    await service.processEvidence("ev-1");

    expect(gemini.counter.calls).toBe(1);
    expect(fake.callsOf("complete_slip_check")).toHaveLength(1);
    expect(fake.callsOf("fail_slip_check")).toHaveLength(0);
    expect(pushes).toHaveLength(0);
  });

  it("fail_slip_check stale_claim after Gemini fails -> no push", async () => {
    const fake = createFakeSupabase({ failOutcome: "stale_claim" });
    const gemini = countingExtractor(async () => { throw new Error("gemini down"); });
    const { pushes, push } = pushRecorder();
    const service = new SlipCheckService(fake.client, gemini.extractor, push, 300, neverVerifier);

    await service.processEvidence("ev-1");

    expect(fake.callsOf("fail_slip_check")).toHaveLength(1);
    expect(fake.callsOf("complete_slip_check")).toHaveLength(0);
    expect(pushes).toHaveLength(0);
  });

  it("same evidence processed twice sequentially -> one extraction, one completion, one push", async () => {
    const fake = createFakeSupabase();
    const gemini = countingExtractor(async () => bankRead);
    const { pushes, push } = pushRecorder();
    const service = new SlipCheckService(fake.client, gemini.extractor, push, 300, neverVerifier);

    await service.processEvidence("ev-1");
    await service.processEvidence("ev-1");

    expect(fake.callsOf("claim_slip_check")).toHaveLength(2);
    expect(gemini.counter.calls).toBe(1);
    expect(fake.downloads).toHaveLength(1);
    expect(fake.callsOf("complete_slip_check")).toHaveLength(1);
    expect(pushes).toHaveLength(1);
  });

  it("batch evidence + Gemini 429 -> one fail, no complete, no per-image push", async () => {
    const fake = createFakeSupabase({ batchId: "batch-1" });
    const gemini = realGemini(() => new Response("quota", { status: 429 }));
    const { pushes, push } = pushRecorder();
    const service = new SlipCheckService(fake.client, gemini.extractor, push, 300, neverVerifier);

    await service.processEvidence("ev-1");

    expect(gemini.calls).toHaveLength(1);
    expectFailedClosed(fake, "extractor_http_rate_limit");
    expect(pushes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 10. Burst: no retry amplification under quota exhaustion
// ---------------------------------------------------------------------------

describe("burst of 25 concurrent evidences", () => {
  const ids = Array.from({ length: 25 }, (_, i) => `ev-${i + 1}`);

  it("Gemini always 429 -> 25 fetches, 25 fails, 0 completes", async () => {
    const fake = createFakeSupabase();
    const gemini = realGemini(() => new Response("quota", { status: 429 }));
    const { pushes, push } = pushRecorder();
    const service = new SlipCheckService(fake.client, gemini.extractor, push, 300, neverVerifier);

    await Promise.all(ids.map((id) => service.processEvidence(id)));

    expect(gemini.calls).toHaveLength(25);
    expect(fake.callsOf("complete_slip_check")).toHaveLength(0);
    const fails = fake.callsOf("fail_slip_check");
    expect(fails).toHaveLength(25);
    expect(new Set(fails.map((c) => c.args.p_check_id)).size).toBe(25);
    expect(fails.every((c) => c.args.p_reason === "extractor_http_rate_limit")).toBe(true);
    expect(pushes).toHaveLength(25);
    expect(pushes.every((p) => !p.text.includes("🟢"))).toBe(true);
  });

  it("mixed: first 15 Gemini calls succeed, rest 429 -> 15 completes, 10 fails", async () => {
    const fake = createFakeSupabase();
    const gemini = realGemini((n) => (n <= 15 ? geminiReply() : new Response("quota", { status: 429 })));
    const service = new SlipCheckService(fake.client, gemini.extractor, async () => {}, 300, neverVerifier);

    await Promise.all(ids.map((id) => service.processEvidence(id)));

    expect(gemini.calls).toHaveLength(25);
    const completes = fake.callsOf("complete_slip_check");
    expect(completes).toHaveLength(15);
    expect(completes.every((c) => (c.args.p_fields as Record<string, unknown>).reference_id === "GEMINI-REF")).toBe(true);
    const fails = fake.callsOf("fail_slip_check");
    expect(fails).toHaveLength(10);
    expect(fails.every((c) => c.args.p_reason === "extractor_http_rate_limit")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 11. Feature flag wiring (Gemini-only: no fallback provider exists)
// ---------------------------------------------------------------------------

describe("createProductionSlipExtractor kill switch wired into SlipCheckService", () => {
  const envs: Array<[string, Record<string, string | undefined>, string | null]> = [
    ["flag unset", {}, "extractor_disabled"],
    ["flag unset, key present", { GEMINI_API_KEY: API_KEY }, "extractor_disabled"],
    ["flag TRUE (case)", { SLIP_GEMINI_OCR_ENABLED: "TRUE", GEMINI_API_KEY: API_KEY }, "extractor_disabled"],
    ["flag 1", { SLIP_GEMINI_OCR_ENABLED: "1", GEMINI_API_KEY: API_KEY }, "extractor_disabled"],
    ["flag yes", { SLIP_GEMINI_OCR_ENABLED: "yes", GEMINI_API_KEY: API_KEY }, "extractor_disabled"],
    ["flag on, key missing", { SLIP_GEMINI_OCR_ENABLED: "true" }, "extractor_not_configured"],
    ["flag on, key blank", { SLIP_GEMINI_OCR_ENABLED: "true", GEMINI_API_KEY: "   " }, "extractor_not_configured"],
    ["flag on (trimmed), key present", { SLIP_GEMINI_OCR_ENABLED: " true ", GEMINI_API_KEY: API_KEY }, null],
  ];

  it.each(envs)("%s", async (_label, env, expectedFailure) => {
    const fake = createFakeSupabase();
    const gemini = countingExtractor(async () => bankRead);
    // Sentinel: an "openai" extractor offered through the removed `legacy`
    // dep must never be reachable. The type system rejects the dep outright.
    const openai = countingExtractor(async () => bankRead);
    const factories = { gemini: 0, openai: 0 };
    const extractor = createProductionSlipExtractor(env, {
      gemini: () => { factories.gemini++; return gemini.extractor; },
      // @ts-expect-error -- the legacy/OpenAI fallback dep no longer exists.
      legacy: () => { factories.openai++; return openai.extractor; },
    });
    const { pushes, push } = pushRecorder();
    const service = new SlipCheckService(fake.client, extractor, push, 300, neverVerifier);

    await service.processEvidence("ev-1");

    expect(factories.openai).toBe(0);
    expect(openai.counter.calls).toBe(0);
    if (expectedFailure === null) {
      expect(factories.gemini).toBe(1);
      expect(gemini.counter.calls).toBe(1);
      expect(fake.callsOf("complete_slip_check")).toHaveLength(1);
      expect(fake.callsOf("fail_slip_check")).toHaveLength(0);
    } else {
      expect(factories.gemini).toBe(0);
      expect(gemini.counter.calls).toBe(0);
      expectFailedClosed(fake, expectedFailure);
      expectOneFailedPush(pushes);
    }
  });
});

// ---------------------------------------------------------------------------
// 12. Secret hygiene
// ---------------------------------------------------------------------------

describe("Gemini API key never leaks into logs, LINE text, or stored fields", () => {
  function assertNoLeak(fake: ReturnType<typeof createFakeSupabase>, pushes: Array<{ text: string }>) {
    expect(logLines.length).toBeGreaterThan(0);
    for (const line of logLines) expect(line).not.toContain(API_KEY);
    for (const p of pushes) expect(p.text).not.toContain(API_KEY);
    expect(JSON.stringify(fake.rpcCalls)).not.toContain(API_KEY);
  }

  it("429 fail-closed path: key only in the request header, never in URL/logs/push/rpc", async () => {
    const fake = createFakeSupabase();
    const gemini = realGemini(() => new Response(`error for key ${API_KEY}`, { status: 429 }));
    const { pushes, push } = pushRecorder();
    const service = new SlipCheckService(fake.client, gemini.extractor, push, 300, neverVerifier);

    await service.processEvidence("ev-1");

    expect(gemini.calls[0].headers["x-goog-api-key"]).toBe(API_KEY);
    expect(gemini.calls[0].url).not.toContain(API_KEY);
    expectFailedClosed(fake, "extractor_http_rate_limit");
    assertNoLeak(fake, pushes);
  });

  it("success path", async () => {
    const fake = createFakeSupabase();
    const gemini = realGemini(() => geminiReply());
    const { pushes, push } = pushRecorder();
    const service = new SlipCheckService(fake.client, gemini.extractor, push, 300, neverVerifier);

    await service.processEvidence("ev-1");

    expect(pushes).toHaveLength(1);
    assertNoLeak(fake, pushes);
  });

  it("Gemini throws an error whose message contains the key", async () => {
    const fake = createFakeSupabase();
    const gemini = countingExtractor(async () => { throw new Error(`gemini failed with ${API_KEY}`); });
    const { pushes, push } = pushRecorder();
    const service = new SlipCheckService(fake.client, gemini.extractor, push, 300, neverVerifier);

    await service.processEvidence("ev-1");

    expectFailedClosed(fake, "unknown_extraction_failure");
    assertNoLeak(fake, pushes);
  });

  it("401 auth error with key echoed in body fails closed without leaking", async () => {
    const fake = createFakeSupabase();
    const gemini = realGemini(() => new Response(`invalid key ${API_KEY}`, { status: 401 }));
    const { pushes, push } = pushRecorder();
    const service = new SlipCheckService(fake.client, gemini.extractor, push, 300, neverVerifier);

    await service.processEvidence("ev-1");

    expect(gemini.calls).toHaveLength(1);
    expectFailedClosed(fake, "extractor_http_auth_error");
    expectOneFailedPush(pushes);
    assertNoLeak(fake, pushes);
  });
});
