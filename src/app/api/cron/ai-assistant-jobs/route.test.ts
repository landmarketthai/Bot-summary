import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";

const originalSecret = process.env.CRON_SECRET;
const originalEnabled = process.env.BOT_SUMMARY_ANALYST_ENABLED;

const rpcMock = mock(async (name: string) => ({
  data: name === "ai_assistant_queue_health" ? { queued: 0, running: 0 } : { expired_turns_deleted: 0 },
  error: null,
}));
mock.module("@/lib/supabase/server", () => ({
  createServiceClient: () => ({ rpc: rpcMock }),
}));

const workerMock = mock(async (options: { budgetMs: number; maxJobs?: number }) => ({
  budgetMs: options.budgetMs,
  claimed: 1, completed: 1, failed: 0, retried: 0, fenced: 0, delivered: 1, undelivered: 0,
}));
mock.module("@/lib/ai/assistant/runtime", () => ({ runAssistantWorkerOnce: workerMock }));
const recoveryMock = mock(async () => ({ scanned: 2, enqueued: 1, duplicate: 0, deferred: 0, skipped: 1 }));
mock.module("@/lib/ai/assistant/recovery", () => ({ recoverUnenqueuedQuestions: recoveryMock }));

const { GET } = await import("./route");

beforeEach(() => {
  delete process.env.CRON_SECRET;
  delete process.env.BOT_SUMMARY_ANALYST_ENABLED;
});
afterEach(() => {
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
  if (originalEnabled === undefined) delete process.env.BOT_SUMMARY_ANALYST_ENABLED;
  else process.env.BOT_SUMMARY_ANALYST_ENABLED = originalEnabled;
  workerMock.mockClear();
  rpcMock.mockClear();
  recoveryMock.mockClear();
});

function request(secret?: string): NextRequest {
  return new NextRequest("http://localhost/api/cron/ai-assistant-jobs", {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

describe("AI assistant worker cron", () => {
  test("fails closed when CRON_SECRET is missing", async () => {
    expect((await GET(request())).status).toBe(500);
    expect(workerMock).not.toHaveBeenCalled();
  });

  test("rejects a wrong secret", async () => {
    process.env.CRON_SECRET = "s3cret";
    process.env.BOT_SUMMARY_ANALYST_ENABLED = "true";
    expect((await GET(request("nope"))).status).toBe(401);
    expect(workerMock).not.toHaveBeenCalled();
  });

  test("does nothing while the assistant is disabled", async () => {
    process.env.CRON_SECRET = "s3cret";
    const response = await GET(request("s3cret"));
    expect(response.status).toBe(200);
    expect((await response.json()).skipped).toContain("BOT_SUMMARY_ANALYST_ENABLED");
    expect(workerMock).not.toHaveBeenCalled();
  });

  test("runs one bounded worker pass, prunes and reports queue health", async () => {
    process.env.CRON_SECRET = "s3cret";
    process.env.BOT_SUMMARY_ANALYST_ENABLED = "true";
    const response = await GET(request("s3cret"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.worker.delivered).toBe(1);
    expect(body.queue).toEqual({ queued: 0, running: 0 });
    expect(body.recovered).toMatchObject({ enqueued: 1 });
    expect(recoveryMock).toHaveBeenCalledTimes(1);
    expect(workerMock).toHaveBeenCalledTimes(1);
    expect(workerMock.mock.calls[0]![0].budgetMs).toBeLessThanOrEqual(50_000);
    expect(rpcMock.mock.calls.map((call) => call[0]).sort()).toEqual(["ai_assistant_queue_health", "prune_ai_assistant_history"]);
  });
});
