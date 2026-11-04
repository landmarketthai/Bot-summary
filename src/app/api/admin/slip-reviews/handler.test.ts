import { afterEach, describe, expect, it } from "bun:test";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { handleSlipReviewRequest } from "./handler";

// No mock.module: the session client and the service client are plain fakes.
type RpcCall = { name: string; args: Record<string, unknown> };

function session(user: { id: string; email?: string; app_metadata?: Record<string, unknown> } | null) {
  return { auth: { getUser: async () => ({ data: { user } }) } } as unknown as SupabaseClient<Database>;
}

function service(calls: RpcCall[], reply: { data?: unknown; error?: { message: string } | null } = {}) {
  return {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { data: reply.data ?? { approval_id: "ap-1", already: false }, error: reply.error ?? null };
    },
  } as unknown as SupabaseClient<Database>;
}

const req = (body: unknown) =>
  new NextRequest("http://localhost/api/admin/slip-reviews", { method: "POST", body: JSON.stringify(body) });

const ADMIN = { id: "u-admin", email: "admin@example.test", app_metadata: { role: "admin" } };

afterEach(() => { delete process.env.ADMIN_USER_IDS; });

describe("POST /api/admin/slip-reviews", () => {
  it("401 without a session and 403 for a non-admin; no RPC is called", async () => {
    const calls: RpcCall[] = [];
    const body = { action: "review", target: "slip_check", id: "c1", decision: "approved", amount: 50, reason: "r" };
    expect((await handleSlipReviewRequest(req(body), session(null), service(calls))).status).toBe(401);
    expect((await handleSlipReviewRequest(req(body), session({ id: "u-op", app_metadata: { role: "operator" } }), service(calls))).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("records the verified admin as reviewer, ignoring any reviewer in the body", async () => {
    const calls: RpcCall[] = [];
    const res = await handleSlipReviewRequest(
      req({ action: "review", target: "slip_check", id: "c1", decision: "approved", amount: 50, reason: "ภาพจริง", reviewer: "someone-else" }),
      session(ADMIN), service(calls),
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ name: "review_slip_check", args: {
      p_check_id: "c1", p_decision: "approved", p_amount: 50, p_reason: "ภาพจริง", p_reviewer: "admin@example.test",
    } }]);
  });

  it("manual entry override and revoke go to their RPCs with the admin as actor", async () => {
    const calls: RpcCall[] = [];
    await handleSlipReviewRequest(req({ action: "review", target: "manual_entry", id: "e1", decision: "rejected", reason: "ซ้ำ" }), session(ADMIN), service(calls));
    await handleSlipReviewRequest(req({ action: "revoke", id: "ap-1", reason: "ตรวจใหม่" }), session(ADMIN), service(calls));
    expect(calls.map((c) => c.name)).toEqual(["review_manual_slip_entry", "revoke_slip_check_review"]);
    expect(calls[0].args.p_amount).toBeNull();
    expect(calls[1].args.p_revoked_by).toBe("admin@example.test");
  });

  it("validates input and maps refusals: 400 / 422 / 409", async () => {
    const calls: RpcCall[] = [];
    expect((await handleSlipReviewRequest(req({ action: "review", target: "slip_check", id: "c1", decision: "approved" }), session(ADMIN), service(calls))).status).toBe(400);
    expect((await handleSlipReviewRequest(req({ action: "review", target: "slip_check", id: "c1", decision: "approved", reason: "r" }), session(ADMIN), service(calls))).status).toBe(422);
    const finalized = service([], { error: { message: "slip_check_round_finalized" } });
    const res = await handleSlipReviewRequest(req({ action: "review", target: "slip_check", id: "c1", decision: "approved", amount: 5, reason: "r" }), session(ADMIN), finalized);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "slip_check_round_finalized" });
    expect(calls).toEqual([]);
  });
});
