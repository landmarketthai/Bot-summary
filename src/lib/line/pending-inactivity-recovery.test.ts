/**
 * The inactivity sweeps are steps in the finalize cron. A push failure must
 * never crash the cron or block the other sweep, and a missing-function error
 * (pre-migration deploy) must be swallowed exactly like the other recovery
 * sweeps — everything else must fail loudly.
 */
import { describe, expect, it } from "bun:test";
import {
  INACTIVITY_WARNING_TEXT,
  INACTIVITY_EXPIRED_TEXT,
  sweepPendingSessionInactivityExpiry,
  sweepPendingSessionInactivityWarnings,
} from "@/lib/line/pending-inactivity-recovery";

interface RpcError {
  message: string;
  code?: string;
}

function fakeDb(result: { data?: unknown; error?: RpcError | null }) {
  const calls: Array<{ name: string; args: unknown }> = [];
  return {
    calls,
    rpc(name: string, args: unknown) {
      calls.push({ name, args });
      return Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("pending session inactivity warning sweep", () => {
  it("pushes a warning for each claimed row and reports the target used", async () => {
    const db = fakeDb({
      data: [
        {
          session_key: "group:C1:user:U1:gen-a",
          session_generation: "gen-a",
          line_user_id: "U1",
          source_id: "C1",
          updated_at: new Date().toISOString(),
        },
      ],
    });
    const pushed: Array<{ to: string; text: string }> = [];
    const run = await sweepPendingSessionInactivityWarnings(
      db,
      async (to, text) => {
        pushed.push({ to, text });
      },
    );
    expect(run).toEqual({ claimed: 1, pushed: 1, pushFailed: 0 });
    expect(pushed).toEqual([{ to: "C1", text: INACTIVITY_WARNING_TEXT }]);
    expect(db.calls[0].name).toBe("sweep_pending_session_inactivity_warnings");
  });

  it("falls back to line_user_id when no group/room source is present", async () => {
    const db = fakeDb({
      data: [
        {
          session_key: "user:U1:gen-a",
          session_generation: "gen-a",
          line_user_id: "U1",
          source_id: null,
          updated_at: new Date().toISOString(),
        },
      ],
    });
    const pushed: string[] = [];
    await sweepPendingSessionInactivityWarnings(db, async (to) => {
      pushed.push(to);
    });
    expect(pushed).toEqual(["U1"]);
  });

  it("skips a row with no push target and counts it as a failure", async () => {
    const db = fakeDb({
      data: [
        {
          session_key: "orphan:gen-a",
          session_generation: "gen-a",
          line_user_id: null,
          source_id: null,
          updated_at: new Date().toISOString(),
        },
      ],
    });
    let called = false;
    const run = await sweepPendingSessionInactivityWarnings(db, async () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(run).toEqual({ claimed: 1, pushed: 0, pushFailed: 1 });
  });

  it("a push failure is logged and does not throw or block other rows", async () => {
    const db = fakeDb({
      data: [
        { session_key: "a", session_generation: "g1", line_user_id: "U1", source_id: "C1", updated_at: new Date().toISOString() },
        { session_key: "b", session_generation: "g2", line_user_id: "U2", source_id: "C2", updated_at: new Date().toISOString() },
      ],
    });
    const attempted: string[] = [];
    const run = await sweepPendingSessionInactivityWarnings(db, async (to) => {
      attempted.push(to);
      if (to === "C1") throw new Error("LINE push HTTP 500");
    });
    expect(attempted).toEqual(["C1", "C2"]);
    expect(run).toEqual({ claimed: 2, pushed: 1, pushFailed: 1 });
  });

  it("skips quietly when the RPC is not installed yet", async () => {
    for (const code of ["42883", "PGRST202"]) {
      const db = fakeDb({ error: { message: "function does not exist", code } });
      expect(await sweepPendingSessionInactivityWarnings(db)).toEqual({
        claimed: 0,
        pushed: 0,
        pushFailed: 0,
      });
    }
  });

  it("still throws on every other RPC failure", async () => {
    for (const error of [
      { message: "deadlock detected", code: "40P01" },
      { message: "boom", code: null as unknown as string },
    ]) {
      await expect(sweepPendingSessionInactivityWarnings(fakeDb({ error })))
        .rejects.toThrow("inactivity warning sweep failed");
    }
  });
});

describe("pending session inactivity expiry sweep", () => {
  it("splits the run totals by outcome", async () => {
    const db = fakeDb({
      data: [
        {
          session_key: "empty",
          session_generation: "g1",
          line_user_id: "U1",
          source_id: "C1",
          accountability_round_id: null,
          outcome: "expired_empty_draft",
          accepted_item_count: 0,
        },
        {
          session_key: "partial",
          session_generation: "g2",
          line_user_id: "U2",
          source_id: "C2",
          accountability_round_id: "round-1",
          outcome: "failed_closed",
          accepted_item_count: 3,
        },
      ],
    });
    const pushes: string[] = [];
    const run = await sweepPendingSessionInactivityExpiry(db, 25, async (to, text) => { pushes.push(`${to}:${text}`); });
    expect(run).toEqual({ expired: 2, expiredEmptyDraft: 1, expiredIncomplete: 1 });
    expect(pushes).toEqual([`C2:${INACTIVITY_EXPIRED_TEXT}`]);
    expect(pushes[0]).toContain("ยังไม่ได้บันทึกยอดเงิน");
    expect(pushes[0]).toContain("ห้ามใช้คำสั่งเบิกเพิ่ม");
    expect(db.calls[0].name).toBe("sweep_pending_session_inactivity_expiry");
  });

  it("skips quietly when the RPC is not installed yet", async () => {
    for (const code of ["42883", "PGRST202"]) {
      const db = fakeDb({ error: { message: "function does not exist", code } });
      expect(await sweepPendingSessionInactivityExpiry(db)).toEqual({
        expired: 0,
        expiredEmptyDraft: 0,
        expiredIncomplete: 0,
      });
    }
  });

  it("still throws on every other RPC failure", async () => {
    await expect(
      sweepPendingSessionInactivityExpiry(fakeDb({ error: { message: "boom", code: "XX000" } })),
    ).rejects.toThrow("inactivity expiry sweep failed");
  });

  it("retains the expiry outcome if the LINE notification fails", async () => {
    const db = fakeDb({ data: [{ source_id: "C1", accepted_item_count: 26, outcome: "failed_closed" }] });
    const run = await sweepPendingSessionInactivityExpiry(db, 25, async () => { throw new Error("LINE unavailable"); });
    expect(run.expiredIncomplete).toBe(1);
  });
});
