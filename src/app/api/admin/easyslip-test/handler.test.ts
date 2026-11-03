import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { handleEasySlipTest } from "./handler";
import type { Database } from "@/types/database";
import type { BankSlipVerifier } from "@/lib/slips/easyslip-bank";
import { EasySlipVerificationError } from "@/lib/slips/easyslip-bank";

const origin = "https://bot-summary.vercel.app";
const original = process.env.EASYSLIP_UAT_ENABLED;
const admin = {
  auth: { getUser: async () => ({ data: { user: { id: "admin-1", email: "admin@example.test", app_metadata: { role: "admin" } } } }) },
} as unknown as SupabaseClient<Database>;
const regular = {
  auth: { getUser: async () => ({ data: { user: { id: "other-1", app_metadata: {} } } }) },
} as unknown as SupabaseClient<Database>;
const anonymous = {
  auth: { getUser: async () => ({ data: { user: null } }) },
} as unknown as SupabaseClient<Database>;

function request(override: { type?: string; origin?: string; size?: number; contentLength?: string } = {}) {
  const form = new FormData();
  form.append("image", new File([new Uint8Array(override.size ?? 10)], "slip.jpg", { type: override.type ?? "image/jpeg" }));
  return new NextRequest(`${origin}/api/admin/easyslip-test`, {
    method: "POST", body: form,
    headers: {
      origin: override.origin ?? origin,
      ...(override.contentLength ? { "content-length": override.contentLength } : {}),
    },
  });
}

const confirmedVerifier: BankSlipVerifier = {
  async verifyImage() {
    return {
      kind: "verified",
      accountMatched: true,
      isDuplicate: false,
      extraction: {
        slipType: "BANK_SLIP_QR", grossAmount: null, discountAmount: null, paidAmount: null,
        transferAmount: 123.45, referenceId: "REF123", transactionTime: "2026-11-03T05:00:00.000Z",
        senderName: null, receiverName: "test receiver", receiverAccountTail: "1234",
        paymentChannelText: null, headlineTotalAmount: null, confidence: 1,
      },
    };
  },
};

beforeEach(() => { process.env.EASYSLIP_UAT_ENABLED = "true"; });
afterEach(() => {
  if (original === undefined) delete process.env.EASYSLIP_UAT_ENABLED;
  else process.env.EASYSLIP_UAT_ENABLED = original;
});

describe("Admin EasySlip read-only UAT", () => {
  it("verifies an image and explicitly never persists/counts money", async () => {
    let called = 0;
    const response = await handleEasySlipTest(request(), admin, {
      async verifyImage(input) { called++; expect(input.bytes.length).toBe(10); return confirmedVerifier.verifyImage(input); },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      status: "verified", amountBaht: 123.45, accountMatched: true, isDuplicate: false,
      persisted: false, countedAsRevenue: false,
    });
    expect(called).toBe(1);
  });

  it("denies anonymous and non-admin without calling verifier", async () => {
    let called = 0;
    const verifier: BankSlipVerifier = { async verifyImage() { called++; return { kind: "not_found" }; } };
    expect((await handleEasySlipTest(request(), anonymous, verifier)).status).toBe(401);
    expect((await handleEasySlipTest(request(), regular, verifier)).status).toBe(403);
    expect(called).toBe(0);
  });

  it("denies cross-origin requests even for admin", async () => {
    const result = await handleEasySlipTest(request({ origin: "https://wrong.example" }), admin, confirmedVerifier);
    expect(result.status).toBe(403);
  });

  it("requires the independent UAT flag (business feature stays off)", async () => {
    delete process.env.EASYSLIP_UAT_ENABLED;
    const result = await handleEasySlipTest(request(), admin, confirmedVerifier);
    expect(result.status).toBe(503);
  });

  it("rejects invalid type and large uploads without provider calls", async () => {
    expect((await handleEasySlipTest(request({ type: "application/pdf" }), admin, confirmedVerifier)).status).toBe(400);
    expect((await handleEasySlipTest(request({ contentLength: String(6 * 1024 * 1024) }), admin, confirmedVerifier)).status).toBe(413);
  });

  it("returns duplicate and mismatch without crediting money", async () => {
    for (const [isDuplicate, accountMatched, status] of [
      [true, true, "duplicate"], [false, false, "receiver_mismatch"],
    ] as const) {
      const response = await handleEasySlipTest(request(), admin, {
        async verifyImage(input) {
          const base = await confirmedVerifier.verifyImage(input);
          if (base.kind !== "verified") throw new Error("fixture invalid");
          return { ...base, isDuplicate, accountMatched };
        },
      });
      expect(await response.json()).toMatchObject({ status, persisted: false, countedAsRevenue: false });
    }
  });

  it("maps provider failure safely and does not expose secrets", async () => {
    const response = await handleEasySlipTest(request(), admin, {
      async verifyImage() { throw new EasySlipVerificationError("provider_error"); },
    });
    expect(response.status).toBe(502);
    const output = JSON.stringify(await response.json());
    expect(output).toContain("provider_error");
    expect(output).not.toContain("API_KEY");
  });
});
