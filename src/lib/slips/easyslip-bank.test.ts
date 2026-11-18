import { afterEach, describe, expect, it } from "bun:test";
import {
  EasySlipBankVerifier, EasySlipVerificationError,
  buildEasySlipBankMessage, isEasySlipEnabledForSource,
} from "./easyslip-bank";

const image = { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg" };
const validResult = {
  success: true,
  data: {
    isDuplicate: false,
    amountInSlip: 120.25,
    matchedAccount: { bankNumber: "redacted" },
    rawSlip: {
      transRef: "ABC123REF",
      date: "2026-10-23T14:10:00+07:00",
      amount: { amount: 120.25 },
      sender: { account: { name: { th: "นายผู้โอน" } } },
      receiver: { account: { name: { th: "ร้านผู้รับ" }, bank: { account: "xxx-x-x5678-x" } } },
    },
  },
};
const fetchMock = (fn: (url: string, init: RequestInit) => Promise<Response>): typeof fetch =>
  Object.assign(fn, { preconnect: fetch.preconnect }) as typeof fetch;

afterEach(() => {
  delete process.env.EASYSLIP_BANK_VERIFICATION_ENABLED;
  delete process.env.EASYSLIP_LINE_SOURCE_IDS;
});

describe("EasySlip QR bank verification", () => {
  it("verifies using v2 multipart image, duplicate and matched receiver gates", async () => {
    let requests = 0;
    const verifier = new EasySlipBankVerifier("secret", fetchMock(async (url, init) => {
      requests++;
      expect(url).toBe("https://api.easyslip.com/v2/verify/bank");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret");
      const form = init.body as FormData;
      expect(form.get("checkDuplicate")).toBe("true");
      expect(form.get("matchAccount")).toBe("true");
      expect(form.get("image")).toBeInstanceOf(Blob);
      expect((form.get("image") as Blob).size).toBe(3);
      return new Response(JSON.stringify(validResult), { status: 200 });
    }));
    const result = await verifier.verifyImage(image);
    expect(requests).toBe(1);
    expect(result.kind).toBe("verified");
    if (result.kind !== "verified") throw new Error("unexpected result");
    expect(result.extraction.slipType).toBe("BANK_SLIP_QR");
    expect(result.extraction.transferAmount).toBe(120.25);
    expect(result.extraction.referenceId).toBe("ABC123REF");
    expect(result.extraction.transactionTime).toBe("2026-10-23T07:10:00.000Z");
    expect(result.extraction.receiverAccountTail).toBe("5678");
    expect(result.accountMatched).toBe(true);
    expect(result.isDuplicate).toBe(false);
    expect(buildEasySlipBankMessage(result.extraction, "EXTRACTED", {bank_verified: true}))
      .toContain("🟢");
  });

  it("keeps an API duplicate or receiver mismatch flagged for review", async () => {
    const verifier = new EasySlipBankVerifier("secret", fetchMock(async () =>
      new Response(JSON.stringify({
        ...validResult,
        data: { ...validResult.data, isDuplicate: true, matchedAccount: null },
      }), { status: 200 })));
    const result = await verifier.verifyImage(image);
    if (result.kind !== "verified") throw new Error("unexpected result");
    expect(result.isDuplicate).toBe(true);
    expect(result.accountMatched).toBe(false);
    expect(buildEasySlipBankMessage(result.extraction, "NEED_REVIEW", {
      bank_verified: false, duplicate: true, receiver_account_matched: false,
    })).toContain("ยังไม่รวมยอดเงินอัตโนมัติ");
  });

  it("falls back to OCR only for SLIP_NOT_FOUND", async () => {
    const verifier = new EasySlipBankVerifier("secret", fetchMock(async () =>
      new Response(JSON.stringify({success:false, error:{code:"SLIP_NOT_FOUND"}}), {status:404})));
    expect(await verifier.verifyImage(image)).toEqual({kind:"not_found"});
  });

  it("fails closed for pending slip and for quota errors", async () => {
    for (const [status, code] of [[404, "SLIP_PENDING"], [403, "QUOTA_EXCEEDED"]] as const) {
      const verifier = new EasySlipBankVerifier("secret", fetchMock(async () =>
        new Response(JSON.stringify({success:false,error:{code}}), {status})));
      await expect(verifier.verifyImage(image)).rejects.toMatchObject({
        reason: "provider_error",
      });
    }
  });

  it("rejects malformed amounts and mismatched totals", async () => {
    const verifier = new EasySlipBankVerifier("secret", fetchMock(async () =>
      new Response(JSON.stringify({...validResult,data:{...validResult.data,amountInSlip:500}}))));
    await expect(verifier.verifyImage(image)).rejects.toMatchObject({reason:"invalid_response"});
  });

  it("rejects oversized images before calling the API and requires a key", async () => {
    let calls = 0;
    const verifier = new EasySlipBankVerifier("secret", fetchMock(async () => {
      calls++;
      return new Response("{}", {status:200});
    }));
    await expect(verifier.verifyImage({ bytes: new Uint8Array(4*1024*1024+1), mimeType:"image/png" }))
      .rejects.toMatchObject({reason:"invalid_image"});
    expect(calls).toBe(0);
    const noKey = new EasySlipBankVerifier("", fetchMock(async () => new Response("{}")));
    await expect(noKey.verifyImage(image)).rejects.toBeInstanceOf(EasySlipVerificationError);
  });

  it("is fail-closed by default and only enabled for explicitly allowlisted LINE IDs", () => {
    expect(isEasySlipEnabledForSource("Ctest")).toBe(false);
    process.env.EASYSLIP_BANK_VERIFICATION_ENABLED = "true";
    expect(isEasySlipEnabledForSource("Ctest")).toBe(false);
    process.env.EASYSLIP_LINE_SOURCE_IDS = "Ctest, Cother";
    expect(isEasySlipEnabledForSource("Ctest")).toBe(true);
    expect(isEasySlipEnabledForSource("Cproduction")).toBe(false);
  });
});
