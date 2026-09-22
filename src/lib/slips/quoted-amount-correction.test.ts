import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { parseQuotedSlipAmount, QuotedSlipAmountCorrectionService } from "./quoted-amount-correction";

function fakeRpc(result: unknown, error: { message: string } | null = null) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return Promise.resolve({ data: result, error });
    },
  } as unknown as SupabaseClient<Database>;
  return { client, calls };
}

const baseInput = {
  rawMessageId: "raw-correction",
  lineMessageId: "line-correction",
  quotedMessageId: "line-slip",
  sourceId: "group-1",
  sourceType: "group",
  lineUserId: "user-1",
  text: "\u0e22\u0e2d\u0e14 268",
};

describe("QuotedSlipAmountCorrectionService", () => {
  it("accepts the existing manual and text-assisted amount grammars", () => {
    expect(parseQuotedSlipAmount("ยอด 268")).toBe(268);
    expect(parseQuotedSlipAmount("268")).toBe(268);
    expect(parseQuotedSlipAmount("268 บาท")).toBe(268);
    expect(parseQuotedSlipAmount("1. 268")).toBe(268);
    expect(parseQuotedSlipAmount("ยอด 268\nยอด 269")).toBeNull();
  });

  it("passes the exact quote and ownership binding to the atomic correction path", async () => {
    const { client, calls } = fakeRpc({ kind: "applied" });
    const result = await new QuotedSlipAmountCorrectionService(client).handle(baseInput);

    expect(result).toEqual({ handled: true, kind: "applied", amount: 268 });
    expect(calls).toEqual([{
      name: "apply_slip_amount_correction",
      args: {
        p_raw_message_id: "raw-correction",
        p_line_message_id: "line-correction",
        p_quoted_message_id: "line-slip",
        p_source_id: "group-1",
        p_source_type: "group",
        p_line_user_id: "user-1",
        p_amount: 268,
      },
    }]);
  });

  it("fails closed for wrong source, wrong sender, non-image, or unknown targets", async () => {
    for (const reason of [
      "quoted_target_not_exact",
      "quoted_target_wrong_sender",
      "quoted_target_not_image",
      "quoted_target_unknown",
    ]) {
      const { client, calls } = fakeRpc({ kind: "ignored", reason });
      const result = await new QuotedSlipAmountCorrectionService(client).handle(baseInput);
      expect(result).toMatchObject({ handled: true, kind: "ignored", amount: 268, reason });
      expect(calls).toHaveLength(1);
    }
  });

  it("is idempotent when the database reports a redelivery", async () => {
    const { client } = fakeRpc({ kind: "already_applied" });
    await expect(new QuotedSlipAmountCorrectionService(client).handle(baseInput)).resolves.toEqual({
      handled: true,
      kind: "already_applied",
      amount: 268,
    });
  });

  it("classifies an RPC error as retryable work instead of a business refusal", async () => {
    const { client } = fakeRpc(null, { message: "database unavailable" });

    await expect(new QuotedSlipAmountCorrectionService(client).handle(baseInput)).resolves.toEqual({
      handled: true,
      kind: "failed",
      amount: 268,
      reason: "correction_rpc_failed",
    });
  });

  it("does not claim ordinary text or multi-line amounts", async () => {
    const { client, calls } = fakeRpc({ kind: "applied" });
    const service = new QuotedSlipAmountCorrectionService(client);

    await expect(service.handle({ ...baseInput, text: "hello" })).resolves.toMatchObject({
      handled: false,
      kind: "ignored",
    });
    await expect(service.handle({ ...baseInput, text: "ยอด 268\nยอด 269" })).resolves.toMatchObject({
      handled: false,
      kind: "ignored",
    });
    expect(calls).toHaveLength(0);
  });
});
