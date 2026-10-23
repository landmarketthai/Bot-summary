import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SlipCheckService } from "@/lib/slips/check-service";
import type { SlipExtraction } from "@/lib/slips/extraction-schema";
import type { Database } from "@/types/database";

function createFakeSupabase(opts: {
  // Rows returned by the transaction-dedupe lookup's slip_checks select —
  // empty means "no duplicate found" (the default for existing tests).
  duplicateChecks?: Array<{ id: string; evidence_id: string; created_at: string }>;
  evidenceSourceId?: string;
} = {}) {
  const insertedChecks: Array<Record<string, unknown>> = [];
  const updatedChecks: Array<Record<string, unknown>> = [];
  const downloads: Array<{ bucket: string; path: string }> = [];
  const duplicateChecks = opts.duplicateChecks ?? [];
  const evidenceSourceId = opts.evidenceSourceId ?? "group-1";

  const client = {
    storage: {
      from(bucket: string) {
        return {
          async download(path: string) {
            downloads.push({ bucket, path });
            return {
              data: new Blob([new Uint8Array([1, 2, 3])]),
              error: null,
            };
          },
        };
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
                        id: "evidence-1",
                        source_id: "group-1",
                        storage_bucket: "slip-evidence",
                        storage_path: "slips/2026-06-06/group-1/message.jpg",
                        mime_type: "image/jpeg",
                        status: "RECEIVED",
                        batch_id: null,
                      },
                      error: null,
                    };
                  },
                  async maybeSingle() {
                    return {
                      data: {
                        source_id: evidenceSourceId,
                        received_at: "2026-06-06T01:00:00Z",
                        batch_id: null,
                      },
                      error: null,
                    };
                  },
                };
              },
            };
          },
        };
      }

      if (table === "slip_checks") {
        return {
          upsert(row: Record<string, unknown>) {
            insertedChecks.push(row);
            return {
              select() {
                return {
                  async single() {
                    return { data: { id: "check-1" }, error: null };
                  },
                };
              },
            };
          },
          update(row: Record<string, unknown>) {
            updatedChecks.push(row);
            return {
              async eq() {
                return { error: null };
              },
            };
          },
          // Used by the transaction-dedupe lookup after a successful extraction.
          select() {
            const chain = {
              eq: () => chain,
              in: () => chain,
              order: () => chain,
              then: (resolve: (v: unknown) => void) => resolve({ data: duplicateChecks, error: null }),
            };
            return chain;
          },
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient<Database>;

  return { client, insertedChecks, updatedChecks, downloads };
}

const extraction: SlipExtraction = {
  slipType: "BANK_SLIP_NO_QR",
  grossAmount: null,
  discountAmount: null,
  paidAmount: null,
  transferAmount: 315,
  referenceId: "004999",
  transactionTime: "2026-06-06T01:35:00.000Z",
  senderName: "ผู้โอน",
  receiverName: "ร้านรับเงิน",
  receiverAccountTail: "1234",
  paymentChannelText: null,
  headlineTotalAmount: null,
  confidence: 0.94,
};

describe("SlipCheckService", () => {
  it("creates one check, extracts private evidence, saves fields, and pushes a summary", async () => {
    const fake = createFakeSupabase();
    const extractorInputs: Array<{ bytes: number[]; mimeType: string }> = [];
    const pushes: Array<{ to: string; text: string }> = [];
    const service = new SlipCheckService(
      fake.client,
      {
        async extract(input) {
          extractorInputs.push({
            bytes: Array.from(input.bytes),
            mimeType: input.mimeType,
          });
          return extraction;
        },
      },
      async (to, text) => {
        pushes.push({ to, text });
      },
    );

    await service.processEvidence("evidence-1");

    expect(fake.insertedChecks).toEqual([{
      evidence_id: "evidence-1",
      status: "PROCESSING",
      slip_type: "UNKNOWN",
      failure_reason: null,
    }]);
    expect(fake.downloads).toEqual([{
      bucket: "slip-evidence",
      path: "slips/2026-06-06/group-1/message.jpg",
    }]);
    expect(extractorInputs).toEqual([{
      bytes: [1, 2, 3],
      mimeType: "image/jpeg",
    }]);
    expect(fake.updatedChecks[0]).toMatchObject({
      status: "EXTRACTED",
      slip_type: "BANK_SLIP_NO_QR",
      transfer_amount: 315,
      reference_id: "004999",
      receiver_account_tail: "1234",
      confidence: 0.94,
      failure_reason: null,
    });
    expect(pushes).toHaveLength(1);
    expect(pushes[0].to).toBe("group-1");
    expect(pushes[0].text).toContain("ยอดโอน 315 บาท");
  });

  it("keeps an extracted check when the LINE push fails", async () => {
    const fake = createFakeSupabase();
    const service = new SlipCheckService(
      fake.client,
      { async extract() { return extraction; } },
      async () => {
        throw new Error("LINE push HTTP 500");
      },
    );

    await expect(service.processEvidence("evidence-1")).resolves.toBeUndefined();
    expect(fake.updatedChecks).toHaveLength(1);
    expect(fake.updatedChecks[0]).toMatchObject({
      status: "EXTRACTED",
      slip_type: "BANK_SLIP_NO_QR",
    });
  });

  it("pushes a duplicate-transaction warning instead of the summary, and keeps the check EXTRACTED", async () => {
    const fake = createFakeSupabase({
      duplicateChecks: [{ id: "check-original", evidence_id: "ev-original", created_at: "2026-06-05T00:00:00Z" }],
      evidenceSourceId: "group-1", // same source as this evidence => duplicate_same_source
    });
    const pushes: Array<{ to: string; text: string }> = [];
    const service = new SlipCheckService(
      fake.client,
      { async extract() { return extraction; } },
      async (to, text) => { pushes.push({ to, text }); },
    );

    await service.processEvidence("evidence-1");

    // The original accepted record and the newly extracted check both keep
    // their real, unmodified status — duplication is a messaging/total
    // concern, not a status the schema has a slot for.
    expect(fake.updatedChecks[0]).toMatchObject({
      status: "EXTRACTED",
      reference_id: "004999",
    });
    // Only the current check (check-1) is ever written — the original
    // accepted record (check-original) is never touched by this flow.
    expect(fake.updatedChecks).toHaveLength(1);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].text).toContain("สลิปนี้ถูกส่งและตรวจสอบแล้วในกลุ่มนี้");
    expect(pushes[0].text).not.toContain("ยอดโอน 315 บาท");
  });

  it("marks the check FAILED and pushes no duplicate warning when the provider fails (no verified entry)", async () => {
    const fake = createFakeSupabase({
      // Even if this reference id would otherwise be a duplicate elsewhere,
      // a provider failure must never reach the dedupe check at all.
      duplicateChecks: [{ id: "check-original", evidence_id: "ev-original", created_at: "2026-06-05T00:00:00Z" }],
    });
    const pushes: Array<{ to: string; text: string }> = [];
    const service = new SlipCheckService(
      fake.client,
      { async extract() { throw new Error("Image extraction provider returned HTTP 500"); } },
      async (to, text) => { pushes.push({ to, text }); },
    );

    await service.processEvidence("evidence-1");

    expect(fake.updatedChecks).toHaveLength(1);
    expect(fake.updatedChecks[0]).toMatchObject({ status: "FAILED" });
    expect(pushes).toHaveLength(1);
    expect(pushes[0].text).not.toContain("สลิปนี้ถูกส่งและตรวจสอบแล้วในกลุ่มนี้");
  });

  // EasySlip opt-in integration must preserve OCR fallback, terminal status,
  // existing batch/dedupe semantics and no unconfirmed revenue.
  async function inEasySlipTest(fn: () => Promise<void>) {
    const priorEnabled = process.env.EASYSLIP_BANK_VERIFICATION_ENABLED;
    const priorSources = process.env.EASYSLIP_LINE_SOURCE_IDS;
    process.env.EASYSLIP_BANK_VERIFICATION_ENABLED = "true";
    process.env.EASYSLIP_LINE_SOURCE_IDS = "group-1";
    try { await fn(); } finally {
      if (priorEnabled === undefined) delete process.env.EASYSLIP_BANK_VERIFICATION_ENABLED;
      else process.env.EASYSLIP_BANK_VERIFICATION_ENABLED = priorEnabled;
      if (priorSources === undefined) delete process.env.EASYSLIP_LINE_SOURCE_IDS;
      else process.env.EASYSLIP_LINE_SOURCE_IDS = priorSources;
    }
  }

  it("EasySlip QR success bypasses AI and saves bank confirmation metadata", () => inEasySlipTest(async () => {
    const fake = createFakeSupabase();
    const messages: string[] = [];
    let aiCalls = 0;
    const service = new SlipCheckService(fake.client, {
      async extract() { aiCalls++; return extraction; },
    }, async (_to, text) => { messages.push(text); }, 300, {
      async verifyImage() {
        return { kind: "verified", isDuplicate: false, accountMatched: true,
          extraction: { ...extraction, slipType: "BANK_SLIP_QR" } };
      },
    });
    await service.processEvidence("evidence-1");
    expect(aiCalls).toBe(0);
    expect(fake.updatedChecks[0]).toMatchObject({ status: "EXTRACTED",
      slip_type: "BANK_SLIP_QR",
      extracted_json: { verification: { bank_verified: true, provider: "easyslip" } },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("EasySlip ตรวจสอบ");
  }));

  it.each([
    [true, true], [false, false],
  ] as const)("EasySlip duplicate=%s, matched=%s is quarantined as NEED_REVIEW", (duplicate, matched) =>
    inEasySlipTest(async () => {
      const fake = createFakeSupabase();
      const messages: string[] = [];
      const service = new SlipCheckService(fake.client, { async extract() { throw new Error("AI must not run"); } },
        async (_to, text) => { messages.push(text); }, 300, {
          async verifyImage() {
            return { kind: "verified", isDuplicate: duplicate, accountMatched: matched,
              extraction: { ...extraction, slipType: "BANK_SLIP_QR" } };
          },
        });
      await service.processEvidence("evidence-1");
      expect(fake.updatedChecks[0]).toMatchObject({ status: "NEED_REVIEW",
        extracted_json: { verification: { bank_verified: false } },
      });
      expect(messages[0]).toContain("ยังไม่รวมยอดเงินอัตโนมัติ");
    }));

  it("EasySlip SLIP_NOT_FOUND falls back to OCR but never verifies an OCR-only bank slip", () =>
    inEasySlipTest(async () => {
      const fake = createFakeSupabase();
      let aiCalls = 0;
      const messages: string[] = [];
      const service = new SlipCheckService(fake.client, { async extract() { aiCalls++; return extraction; } },
        async (_to, text) => { messages.push(text); }, 300, {
          async verifyImage() { return { kind: "not_found" }; },
        });
      await service.processEvidence("evidence-1");
      expect(aiCalls).toBe(1);
      expect(fake.updatedChecks[0]).toMatchObject({ status: "NEED_REVIEW",
        extracted_json: { verification: { bank_verified: false, reason: "slip_not_found" } },
      });
      expect(messages[0]).toContain("ยังไม่รวมยอดเงินอัตโนมัติ");
    }));

  it("EasySlip SLIP_NOT_FOUND preserves government receipt OCR behavior", () =>
    inEasySlipTest(async () => {
      const fake = createFakeSupabase();
      const government: SlipExtraction = { ...extraction, slipType: "THAI_HELP_THAI",
        grossAmount: 50, paidAmount: 20, discountAmount: 30, transferAmount: null };
      const service = new SlipCheckService(fake.client, { async extract() { return government; } },
        async () => {}, 300, { async verifyImage() { return { kind: "not_found" }; } });
      await service.processEvidence("evidence-1");
      expect(fake.updatedChecks[0]).toMatchObject({ status: "EXTRACTED",
        slip_type: "THAI_HELP_THAI",
      });
    }));

  it("EasySlip provider error never uses AI to approve a bank payment", () =>
    inEasySlipTest(async () => {
      const fake = createFakeSupabase();
      let aiCalls = 0;
      const messages: string[] = [];
      const service = new SlipCheckService(fake.client, { async extract() { aiCalls++; return extraction; } },
        async (_to, text) => { messages.push(text); }, 300, {
          async verifyImage() { throw new Error("EasySlip API unavailable"); },
        });
      await service.processEvidence("evidence-1");
      expect(aiCalls).toBe(0);
      expect(fake.updatedChecks[0]).toMatchObject({ status: "FAILED" });
      expect(messages).toHaveLength(1);
      expect(messages[0]).not.toContain("🟢");
    }));
});
