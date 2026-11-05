import type { SlipExtraction } from "@/lib/slips/extraction-schema";
import type { SlipExtractionInput } from "@/lib/slips/extractor";

const ENDPOINT = "https://api.easyslip.com/v2/verify/bank";
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const SUPPORTED_MIME_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

type JsonRecord = Record<string, unknown>;

export type EasySlipResult =
  | { kind: "not_found" }
  | {
      kind: "verified";
      extraction: SlipExtraction;
      isDuplicate: boolean;
      accountMatched: boolean;
    };

export interface BankSlipVerifier {
  verifyImage(input: SlipExtractionInput): Promise<EasySlipResult>;
}

export class EasySlipVerificationError extends Error {
  constructor(public readonly reason: "not_configured" | "invalid_image" | "provider_error" | "invalid_response") {
    super(`EasySlip bank verification: ${reason}`);
    this.name = "EasySlipVerificationError";
  }
}

export function isEasySlipEnabledForSource(sourceId: string): boolean {
  if (process.env.EASYSLIP_BANK_VERIFICATION_ENABLED !== "true") return false;
  const allowed = (process.env.EASYSLIP_LINE_SOURCE_IDS ?? "").split(/[\s,]+/).filter(Boolean);
  return allowed.includes(sourceId);
}

/**
 * Uses the official EasySlip v2 image endpoint. The QR is decoded by EasySlip,
 * not by AI OCR. No image, credential, or unmasked bank number is logged/stored.
 */
export class EasySlipBankVerifier implements BankSlipVerifier {
  constructor(
    private readonly apiKey: string | undefined = process.env.EASYSLIP_API_KEY,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async verifyImage(input: SlipExtractionInput): Promise<EasySlipResult> {
    if (!this.apiKey) throw new EasySlipVerificationError("not_configured");
    const extension = SUPPORTED_MIME_TYPES[input.mimeType];
    if (!extension || input.bytes.length === 0 || input.bytes.length > MAX_IMAGE_BYTES) {
      throw new EasySlipVerificationError("invalid_image");
    }

    const form = new FormData();
    form.append("image", new Blob([Uint8Array.from(input.bytes)], { type: input.mimeType }), `slip.${extension}`);
    form.append("checkDuplicate", "true");
    form.append("matchAccount", "true");

    let response: Response;
    try {
      response = await this.fetchImpl(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new EasySlipVerificationError("provider_error");
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new EasySlipVerificationError("invalid_response");
    }

    const root = record(body);
    const error = record(root?.error);
    if (!response.ok || root?.success !== true) {
      // Other 404s (e.g. SLIP_PENDING) are NOT "no QR" and must not fall back.
      if (response.status === 404 && error?.code === "SLIP_NOT_FOUND") {
        return { kind: "not_found" };
      }
      throw new EasySlipVerificationError("provider_error");
    }

    const data = record(root?.data);
    const raw = record(data?.rawSlip);
    const amount = record(raw?.amount);
    const sender = record(raw?.sender);
    const receiver = record(raw?.receiver);
    const senderAccount = record(sender?.account);
    const receiverAccount = record(receiver?.account);
    const senderName = record(senderAccount?.name);
    const receiverName = record(receiverAccount?.name);
    const receiverBank = record(receiverAccount?.bank);

    const transferAmount = amount?.amount;
    const amountInSlip = data?.amountInSlip;
    const transactionRef = raw?.transRef;
    const timestamp = raw?.date;
    if (
      data?.isDuplicate !== true && data?.isDuplicate !== false
      || typeof transferAmount !== "number" || !Number.isFinite(transferAmount)
      || transferAmount <= 0 || Math.abs(transferAmount - Math.round(transferAmount * 100) / 100) > 1e-7
      || typeof amountInSlip !== "number" || !Number.isFinite(amountInSlip) || amountInSlip <= 0 || Math.abs(amountInSlip - Math.round(amountInSlip * 100) / 100) > 1e-7 || Math.round(amountInSlip * 100) !== Math.round(transferAmount * 100)
      || typeof transactionRef !== "string" || !transactionRef.trim() || transactionRef.length > 128
      || typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))
    ) {
      throw new EasySlipVerificationError("invalid_response");
    }

    const receiverAccountText = typeof receiverBank?.account === "string" ? receiverBank.account : "";
    const tail = receiverAccountText.match(/\d{4}(?!.*\d)/)?.[0] ?? null;
    return {
      kind: "verified",
      isDuplicate: data.isDuplicate,
      // Requires a registered EasySlip receiver account. A successful QR lookup
      // alone does not establish that this store received the transfer.
      accountMatched: text(record(data.matchedAccount)?.bankNumber) !== null,
      extraction: {
        slipType: "BANK_SLIP_QR",
        grossAmount: null,
        discountAmount: null,
        paidAmount: null,
        transferAmount,
        referenceId: transactionRef.trim(),
        transactionTime: new Date(timestamp).toISOString(),
        senderName: text(senderName?.th) ?? text(senderName?.en),
        receiverName: text(receiverName?.th) ?? text(receiverName?.en),
        receiverAccountTail: tail,
        paymentChannelText: null,
        headlineTotalAmount: null,
        confidence: 1,
      },
    };
  }
}

export function buildEasySlipBankMessage(
  extraction: SlipExtraction,
  status: string,
  verification: { bank_verified: boolean; duplicate?: boolean; receiver_account_matched?: boolean; reason?: string },
): string {
  if (!verification.bank_verified || status !== "EXTRACTED") {
    const reason = verification.duplicate
      ? "พบสลิปซ้ำจาก EasySlip"
      : verification.receiver_account_matched === false
        ? "บัญชีผู้รับไม่ตรงกับบัญชีที่ลงทะเบียน"
        : "EasySlip ไม่สามารถตรวจยืนยัน QR ของสลิปนี้ได้";
    return ["🟠 สลิปธนาคารรอตรวจสอบ", reason, "ยังไม่รวมยอดเงินอัตโนมัติ", "กรุณาตรวจสอบหลักฐานหรือส่งสลิปใหม่"].join("\n");
  }
  const amount = extraction.transferAmount?.toLocaleString("th-TH", { maximumFractionDigits: 2 }) ?? "-";
  return [
    "🟢 EasySlip ตรวจสอบสลิปธนาคารแล้ว",
    `ยอดโอน ${amount} บาท`,
    `ผู้รับ ${extraction.receiverName ?? "-"}`,
    `เลขอ้างอิง ${extraction.referenceId ?? "-"}`,
    "บัญชีผู้รับ: ผ่านการจับคู่บัญชีที่ลงทะเบียน",
    "ตรวจสอบโดย EasySlip ไม่ใช่แค่ OCR",
  ].join("\n");
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
