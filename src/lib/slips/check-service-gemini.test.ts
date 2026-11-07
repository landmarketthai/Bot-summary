import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SlipCheckService } from "@/lib/slips/check-service";
import { EasySlipVerificationError, type BankSlipVerifier, type EasySlipResult } from "@/lib/slips/easyslip-bank";
import type { SlipExtraction } from "@/lib/slips/extraction-schema";
import type { SlipExtractionInput, SlipExtractor } from "@/lib/slips/extractor";
import type { Database } from "@/types/database";

/**
 * Synthetic gate tests for the CURRENT SlipCheckService: the OCR extractor
 * (Gemini in production) runs ONLY when EasySlip did not verify the QR, and
 * OCR output is never bank verification. Everything is injected through the
 * constructor; no mock.module, no network.
 */

// Minimal copy of check-service.test.ts's fake (it is not exported). Legacy
// path: no rpc, so claims use the unfenced upsert/update.
function createFakeSupabase() {
  const updatedChecks: Array<Record<string, unknown>> = [];
  const client = {
    storage: {
      from() {
        return { async download() { return { data: new Blob([new Uint8Array([1, 2, 3])]), error: null }; } };
      },
    },
    from(table: string) {
      if (table === "slip_evidences") {
        return {
          select() {
            return {
              eq() {
                return {
                  async single() {
                    return {
                      data: {
                        id: "evidence-1", source_id: "group-1", storage_bucket: "slip-evidence",
                        storage_path: "slips/2026-11-07/group-1/message.jpg", mime_type: "image/jpeg",
                        status: "RECEIVED", batch_id: null,
                      },
                      error: null,
                    };
                  },
                  async maybeSingle() {
                    return { data: { source_id: "group-1", received_at: "2026-11-07T01:00:00Z", batch_id: null }, error: null };
                  },
                };
              },
            };
          },
        };
      }
      if (table === "slip_checks") {
        return {
          upsert() {
            return { select() { return { async single() { return { data: { id: "check-1" }, error: null }; } }; } };
          },
          update(row: Record<string, unknown>) {
            updatedChecks.push(row);
            return { async eq() { return { error: null }; } };
          },
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
  return { client, updatedChecks };
}

const ocrBankSlip: SlipExtraction = {
  slipType: "BANK_SLIP_QR",
  grossAmount: null,
  discountAmount: null,
  paidAmount: null,
  transferAmount: 315,
  referenceId: "004999",
  transactionTime: "2026-11-07T01:35:00.000Z",
  senderName: "ผู้โอน",
  receiverName: "ร้านรับเงิน",
  receiverAccountTail: "1234",
  paymentChannelText: null,
  headlineTotalAmount: null,
  confidence: 0.94,
};

const easySlipExtraction: SlipExtraction = { ...ocrBankSlip, referenceId: "QR-REF-1", confidence: 1 };

function spyExtractor(result: SlipExtraction = ocrBankSlip) {
  const calls: SlipExtractionInput[] = [];
  const extractor: SlipExtractor = {
    async extract(input) { calls.push(input); return result; },
  };
  return { extractor, calls };
}

function fakeVerifier(outcome: EasySlipResult | Error) {
  let calls = 0;
  const verifier: BankSlipVerifier = {
    async verifyImage() {
      calls++;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
  return { verifier, calls: () => calls };
}

async function run(extractor: SlipExtractor, verifier: BankSlipVerifier) {
  const fake = createFakeSupabase();
  const messages: string[] = [];
  const service = new SlipCheckService(fake.client, extractor, async (_to, text) => { messages.push(text); }, 300, verifier);
  await service.processEvidence("evidence-1");
  expect(fake.updatedChecks).toHaveLength(1);
  return { check: fake.updatedChecks[0], messages };
}

function verificationOf(check: Record<string, unknown>) {
  return (check.extracted_json as Record<string, unknown>).verification as Record<string, unknown> | undefined;
}

const ENV_KEYS = ["EASYSLIP_BANK_VERIFICATION_ENABLED", "EASYSLIP_LINE_SOURCE_IDS"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.EASYSLIP_BANK_VERIFICATION_ENABLED = "true";
  process.env.EASYSLIP_LINE_SOURCE_IDS = "group-1";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("SlipCheckService OCR gate: EasySlip verified never calls the OCR extractor", () => {
  it("verified + unique + receiver matched: no OCR, EXTRACTED, bank_verified true", async () => {
    const ocr = spyExtractor();
    const bank = fakeVerifier({ kind: "verified", isDuplicate: false, accountMatched: true, extraction: easySlipExtraction });
    const { check, messages } = await run(ocr.extractor, bank.verifier);
    expect(bank.calls()).toBe(1);
    expect(ocr.calls).toHaveLength(0);
    expect(check).toMatchObject({ status: "EXTRACTED", reference_id: "QR-REF-1", transfer_amount: 315 });
    expect(verificationOf(check)).toEqual({
      provider: "easyslip", duplicate: false, receiver_account_matched: true, bank_verified: true,
    });
    expect(messages[0]).toContain("EasySlip ตรวจสอบสลิปธนาคารแล้ว");
  });

  it("verified duplicate: no OCR, NEED_REVIEW, bank_verified false", async () => {
    const ocr = spyExtractor();
    const bank = fakeVerifier({ kind: "verified", isDuplicate: true, accountMatched: true, extraction: easySlipExtraction });
    const { check, messages } = await run(ocr.extractor, bank.verifier);
    expect(ocr.calls).toHaveLength(0);
    expect(check).toMatchObject({ status: "NEED_REVIEW" });
    expect(verificationOf(check)).toMatchObject({ provider: "easyslip", duplicate: true, bank_verified: false });
    expect(messages[0]).toContain("พบสลิปซ้ำจาก EasySlip");
    expect(messages[0]).toContain("ยังไม่รวมยอดเงินอัตโนมัติ");
  });

  it("verified receiver mismatch: no OCR, NEED_REVIEW, bank_verified false", async () => {
    const ocr = spyExtractor();
    const bank = fakeVerifier({ kind: "verified", isDuplicate: false, accountMatched: false, extraction: easySlipExtraction });
    const { check, messages } = await run(ocr.extractor, bank.verifier);
    expect(ocr.calls).toHaveLength(0);
    expect(check).toMatchObject({ status: "NEED_REVIEW" });
    expect(verificationOf(check)).toMatchObject({ receiver_account_matched: false, bank_verified: false });
    expect(messages[0]).toContain("บัญชีผู้รับไม่ตรงกับบัญชีที่ลงทะเบียน");
  });
});

describe("SlipCheckService OCR gate: EasySlip not verified runs OCR exactly once, never as bank verification", () => {
  it("not_found: OCR called once with the downloaded image; bank slip NEED_REVIEW, bank_verified false", async () => {
    const ocr = spyExtractor();
    const { check, messages } = await run(ocr.extractor, fakeVerifier({ kind: "not_found" }).verifier);
    expect(ocr.calls).toHaveLength(1);
    expect(Array.from(ocr.calls[0].bytes)).toEqual([1, 2, 3]);
    expect(ocr.calls[0].mimeType).toBe("image/jpeg");
    expect(check).toMatchObject({ status: "NEED_REVIEW", slip_type: "BANK_SLIP_QR", transfer_amount: 315 });
    expect(verificationOf(check)).toEqual({ provider: "easyslip", bank_verified: false, reason: "slip_not_found" });
    expect(messages[0]).not.toContain("🟢");
  });

  it.each(["provider_error", "invalid_response", "not_configured", "invalid_image"] as const)(
    "EasySlipVerificationError(%s): OCR called once; bank slip NEED_REVIEW, bank_verified false",
    async (reason) => {
      const ocr = spyExtractor();
      const { check } = await run(ocr.extractor, fakeVerifier(new EasySlipVerificationError(reason)).verifier);
      expect(ocr.calls).toHaveLength(1);
      expect(check).toMatchObject({ status: "NEED_REVIEW", transfer_amount: 315 });
      expect(verificationOf(check)).toEqual({ provider: "easyslip", bank_verified: false, reason });
    },
  );

  it("generic verifier throw: OCR called once; reason provider_error, bank_verified false", async () => {
    const ocr = spyExtractor();
    const { check } = await run(ocr.extractor, fakeVerifier(new Error("network down")).verifier);
    expect(ocr.calls).toHaveLength(1);
    expect(check).toMatchObject({ status: "NEED_REVIEW" });
    expect(verificationOf(check)).toEqual({ provider: "easyslip", bank_verified: false, reason: "provider_error" });
  });

  it("OCR bank slip claiming high confidence still never becomes bank_verified", async () => {
    const ocr = spyExtractor({ ...ocrBankSlip, confidence: 1 });
    const { check } = await run(ocr.extractor, fakeVerifier({ kind: "not_found" }).verifier);
    expect(check.status).toBe("NEED_REVIEW");
    expect(verificationOf(check)?.bank_verified).toBe(false);
  });

  it("not_found + OCR wallet receipt keeps normal OCR status and has no verification meta", async () => {
    const wallet: SlipExtraction = {
      ...ocrBankSlip, slipType: "THAI_HELP_THAI", grossAmount: 100, discountAmount: 60, paidAmount: 40,
      transferAmount: null, receiverAccountTail: null, headlineTotalAmount: 100,
    };
    const ocr = spyExtractor(wallet);
    const { check } = await run(ocr.extractor, fakeVerifier({ kind: "not_found" }).verifier);
    expect(ocr.calls).toHaveLength(1);
    expect(check).toMatchObject({ status: "EXTRACTED", slip_type: "THAI_HELP_THAI", gross_amount: 100, paid_amount: 40 });
    expect(verificationOf(check)).toBeUndefined();
  });

  it("OCR failure after EasySlip miss records FAILED, never an invented amount", async () => {
    const failing: SlipExtractor = { async extract() { throw new Error("Image extraction provider returned invalid JSON"); } };
    const { check, messages } = await run(failing, fakeVerifier({ kind: "not_found" }).verifier);
    expect(check).toMatchObject({ status: "FAILED", failure_reason: "extractor_invalid_output" });
    expect(check.transfer_amount).toBeUndefined();
    expect(messages[0]).not.toContain("🟢");
  });
});

describe("SlipCheckService OCR gate: EasySlip disabled for the source", () => {
  it.each([
    ["flag off", () => { process.env.EASYSLIP_BANK_VERIFICATION_ENABLED = "false"; }],
    ["flag unset", () => { delete process.env.EASYSLIP_BANK_VERIFICATION_ENABLED; }],
    ["source not allowlisted", () => { process.env.EASYSLIP_LINE_SOURCE_IDS = "another-group"; }],
  ] as const)("%s: verifier not called, OCR called once, no verification meta", async (_label, configure) => {
    configure();
    const ocr = spyExtractor({ ...ocrBankSlip, slipType: "BANK_SLIP_NO_QR" });
    const bank = fakeVerifier(new Error("EasySlip must not run"));
    const { check } = await run(ocr.extractor, bank.verifier);
    expect(bank.calls()).toBe(0);
    expect(ocr.calls).toHaveLength(1);
    expect(check).toMatchObject({ status: "EXTRACTED", slip_type: "BANK_SLIP_NO_QR" });
    expect(verificationOf(check)).toBeUndefined();
  });
});
