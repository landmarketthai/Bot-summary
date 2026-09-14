import { describe, expect, it } from "bun:test";
import {
  buildTransientFinalizationRetryMessage,
  finalizePendingGeneration,
  isTransientFinalizationReadError,
} from "./pending-session-finalizer";
import type { PendingSession } from "./pending-session-service";

type Row = Record<string, unknown>;

const SESSION_KEY = "group:group-timeout:user:user-timeout";
const GENERATION = "33333333-3333-4333-8333-333333333333";

function snapshot(finalizationError: unknown = null): PendingSession {
  const now = new Date().toISOString();
  return {
    id: "pending-timeout",
    session_key: SESSION_KEY,
    source_id: "group-timeout",
    accumulated_text: "กี้-วัดทุ่งลานนา เบิก 13/9/2569\n1ทับทิม20บาท\n38ลูก\nจบรายการเบิก",
    latest_reply_token: null,
    line_user_id: "user-timeout",
    created_at: now,
    updated_at: now,
    session_generation: GENERATION,
    close_event_timestamp_ms: 3_000,
    close_requested_at: now,
    close_line_event_id: "close-timeout",
    close_finalize_started_at: null,
    terminalized: false,
    next_attempt_at: now,
    close_deadline_at: now,
    close_session_generation: GENERATION,
    expected_item_count: null,
    ingest_revision: 3,
    finalization_status: "pending",
    finalization_error: finalizationError,
    runtime_environment: "development",
    plain_text_opened_line_event_id: "open-timeout",
    plain_text_opened_line_timestamp_ms: 1_000,
  };
}

class TimeoutDb {
  updates: Row[] = [];
  rpcNames: string[] = [];
  scheduleResult = [{ session_generation: GENERATION }];

  from = (table: string) => {
    const filters: Array<(row: Row) => boolean> = [];
    let updatePayload: Row | null = null;
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = (column: string, value: unknown) => {
      filters.push((row) => row[column] === value);
      return builder;
    };
    builder.lte = () => builder;
    builder.order = () => builder;
    builder.update = (payload: Row) => {
      updatePayload = payload;
      this.updates.push(payload);
      return builder;
    };
    builder.then = (resolve: (value: { data: Row[]; error: Row | null }) => unknown) => {
      if (table === "pending_session_ingest") {
        return Promise.resolve({ data: [], error: { message: "Gateway Timeout" } }).then(resolve);
      }
      if (table === "pending_sessions" && updatePayload) {
        return Promise.resolve({ data: this.scheduleResult, error: null }).then(resolve);
      }
      return Promise.resolve({ data: [], error: null }).then(resolve);
    };
    return builder;
  };

  rpc = async (name: string) => {
    this.rpcNames.push(name);
    return { data: null, error: null };
  };
}

describe("transient pending-finalizer reconstruction failures", () => {
  it("classifies common gateway/network failures as transient", () => {
    expect(isTransientFinalizationReadError(new Error("Gateway Timeout"))).toBe(true);
    expect(isTransientFinalizationReadError(new Error("upstream timed out"))).toBe(true);
    expect(isTransientFinalizationReadError(new Error("permanent malformed session"))).toBe(false);
  });
  it("keeps the generation retryable and never calls the authoritative finalize RPC", async () => {
    const db = new TimeoutDb();
    const pushes: string[] = [];

    const result = await finalizePendingGeneration(
      db as never,
      snapshot(),
      async (_to, text) => { pushes.push(text); return {}; },
    );

    expect(result.status).toBe("pending");
    expect(result.reason).toBe("transient_reconstruction_error");
    expect(db.rpcNames).not.toContain("try_finalize_pending_generation");
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0]).toMatchObject({
      finalization_status: "pending",
      finalization_error: {
        reason: "transient_reconstruction_error",
        retryable: true,
        error: "pending session ingest load failed: Gateway Timeout",
      },
    });
    expect(pushes).toEqual([buildTransientFinalizationRetryMessage()]);
    expect(pushes[0]).toContain("รายการที่ส่งมายังอยู่ครบ");
    expect(pushes[0]).not.toContain("อ่านรายการไม่ครบ");
  });
  it("does not spam the operator on repeated transient retries", async () => {
    const db = new TimeoutDb();
    const pushes: string[] = [];

    const result = await finalizePendingGeneration(
      db as never,
      snapshot({ reason: "transient_reconstruction_error", retryable: true }),
      async (_to, text) => { pushes.push(text); return {}; },
    );

    expect(result.status).toBe("pending");
    expect(pushes).toHaveLength(0);
  });

  it("fails stale instead of claiming a retry was scheduled after the snapshot moved", async () => {
    const db = new TimeoutDb();
    db.scheduleResult = [];
    const pushes: string[] = [];

    const result = await finalizePendingGeneration(
      db as never,
      snapshot(),
      async (_to, text) => { pushes.push(text); return {}; },
    );

    expect(result.status).toBe("stale_snapshot");
    expect(result.reason).toBe("transient_retry_snapshot_moved");
    expect(pushes).toHaveLength(0);
    expect(db.rpcNames).not.toContain("try_finalize_pending_generation");
  });
});
