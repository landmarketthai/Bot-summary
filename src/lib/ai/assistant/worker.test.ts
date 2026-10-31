import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { logger } from "@/lib/logger";
import { OpenAIAnalystError } from "@/lib/ai/openai-analyst";
import { LineDeliveryError } from "./delivery";
import type { AssistantJob, AssistantJobRequest, AssistantJobStore } from "./job-store";
import { MemoryAssistantJobStore } from "./testing/memory-job-store";
import { RecordingLineDelivery } from "./testing/recording-line";
import { runAssistantWorker, type AssistantAnswerer, type AssistantWorkerOptions } from "./worker";

const NOTICE = "ตอนนี้ @Botsummary อ่านข้อมูลให้ไม่สำเร็จชั่วคราว กรุณาลองถามใหม่อีกครั้ง";
const QUESTION = "หนูเล็กมีสลิปที่ยังรอตรวจกี่รายการ?";
const ANSWER = "เล็กมีสลิปรอตรวจมือ 2 รายการครับ";

let seq = 0;
function request(overrides: Partial<AssistantJobRequest> = {}): AssistantJobRequest {
  seq += 1;
  return {
    lineEventId: `evt-${seq}`,
    rawMessageId: `raw-${seq}`,
    destination: "Ubot",
    sourceType: "group",
    sourceId: "Cgroup-secret",
    lineUserId: "Usecret-user",
    question: QUESTION,
    askedBusinessDate: "2026-10-31",
    eventTimestampMs: Date.now() + seq,
    replyToken: `token-${seq}`,
    replyTokenExpiresAt: new Date(Date.now() + 50_000).toISOString(),
    ...overrides,
  };
}

function options(
  store: AssistantJobStore,
  answer: AssistantAnswerer,
  delivery: RecordingLineDelivery,
  overrides: Partial<AssistantWorkerOptions> = {},
): AssistantWorkerOptions {
  return {
    store,
    answer,
    delivery,
    pushFallbackEnabled: true,
    workerId: "w-test",
    budgetMs: 30_000,
    deliveryReserveMs: 2_000,
    temporaryErrorText: NOTICE,
    ...overrides,
  };
}

const answered: AssistantAnswerer = async () => ({
  text: ANSWER,
  kind: "answer",
  usage: { inputTokens: 10, outputTokens: 5 },
  toolNames: ["get_slip_status"],
  turn: { businessDate: "2026-10-31", context: { tools: [{ tool: "get_slip_status" }] } },
});

function onlyJob(store: MemoryAssistantJobStore): AssistantJob {
  const jobs = [...store.jobs.values()];
  expect(jobs).toHaveLength(1);
  return jobs[0]!;
}

describe("assistant worker", () => {
  test("answers, replies with the fresh reply token and remembers the turn", async () => {
    const store = new MemoryAssistantJobStore();
    const line = new RecordingLineDelivery();
    await store.enqueue(request());

    const summary = await runAssistantWorker(options(store, answered, line));

    expect(summary).toMatchObject({ claimed: 1, completed: 1, delivered: 1, failed: 0, retried: 0 });
    expect(line.sent).toEqual([{ channel: "reply", target: "token-" + seq, text: ANSWER }]);
    const job = onlyJob(store);
    expect(job).toMatchObject({ status: "completed", delivery_state: "delivered", delivery_channel: "reply", answer_kind: "answer" });
    expect(job.reply_token).toBeNull();
    expect(job.tool_names).toEqual(["get_slip_status"]);
    expect(store.turns.map((turn) => turn.answer)).toEqual([ANSWER]);
  });

  test("a transient provider failure is retried with backoff, then answered", async () => {
    const store = new MemoryAssistantJobStore();
    const line = new RecordingLineDelivery();
    await store.enqueue(request());
    let calls = 0;
    const flaky: AssistantAnswerer = async (job, context) => {
      calls += 1;
      if (calls === 1) throw new OpenAIAnalystError("OpenAI analyst request failed: HTTP 503", "http", 503);
      return answered(job, context);
    };

    const first = await runAssistantWorker(options(store, flaky, line));
    expect(first).toMatchObject({ retried: 1, delivered: 0 });
    const waiting = onlyJob(store);
    expect(waiting).toMatchObject({ status: "queued", attempts: 1, last_error_code: "provider_http_503" });
    expect(Date.parse(waiting.available_at)).toBeGreaterThan(Date.now());
    // Still in backoff: nothing to claim.
    expect((await runAssistantWorker(options(store, flaky, line))).claimed).toBe(0);

    store.makeAvailable();
    const second = await runAssistantWorker(options(store, flaky, line));
    expect(second).toMatchObject({ completed: 1, delivered: 1 });
    expect(onlyJob(store).attempts).toBe(2);
    expect(line.sent.map((message) => message.text)).toEqual([ANSWER]);
  });

  test("the final failed attempt delivers a notice instead of silence; it is not remembered", async () => {
    const store = new MemoryAssistantJobStore();
    const line = new RecordingLineDelivery();
    await store.enqueue(request({ maxAttempts: 2 }));
    const down: AssistantAnswerer = async () => {
      throw new OpenAIAnalystError("OpenAI analyst request timed out.", "timeout");
    };
    await runAssistantWorker(options(store, down, line));
    store.makeAvailable();
    const summary = await runAssistantWorker(options(store, down, line));

    expect(summary).toMatchObject({ failed: 1, delivered: 1 });
    expect(line.sent.map((message) => message.text)).toEqual([NOTICE]);
    expect(onlyJob(store)).toMatchObject({ status: "failed", answer_kind: "notice", last_error_code: "provider_timeout" });
    expect(store.turns).toHaveLength(0);
  });

  test("a permanent provider failure is not retried", async () => {
    const store = new MemoryAssistantJobStore();
    const line = new RecordingLineDelivery();
    await store.enqueue(request());
    const misconfigured: AssistantAnswerer = async () => {
      throw new OpenAIAnalystError("OpenAI analyst request failed: HTTP 401", "http", 401);
    };
    const summary = await runAssistantWorker(options(store, misconfigured, line));
    expect(summary).toMatchObject({ retried: 0, failed: 1 });
    expect(onlyJob(store)).toMatchObject({ attempts: 1, last_error_code: "provider_http_401" });
    expect(line.sent.map((message) => message.text)).toEqual([NOTICE]);
  });

  test("crash after the answer was recorded: recovery re-delivers without calling the model again", async () => {
    const store = new MemoryAssistantJobStore();
    const line = new RecordingLineDelivery();
    const { jobId } = await store.enqueue(request());
    let modelCalls = 0;
    const counting: AssistantAnswerer = async (job, context) => { modelCalls += 1; return answered(job, context); };
    store.failNext.setDelivery = new Error("process killed before delivery");

    const crashed = await runAssistantWorker(options(store, counting, line));
    expect(crashed.fenced).toBe(1);
    expect(store.jobs.get(jobId!)).toMatchObject({ status: "running", answer_text: ANSWER, delivery_state: "pending" });
    expect(line.sent).toHaveLength(0);

    store.expireLease(jobId!);
    const recovered = await runAssistantWorker(options(store, counting, line));
    expect(recovered).toMatchObject({ completed: 1, delivered: 1 });
    expect(modelCalls).toBe(1);
    expect(line.sent.map((message) => message.text)).toEqual([ANSWER]);
  });

  test("crash between a sent reply and recording it: never sent twice (uncertain)", async () => {
    const store = new MemoryAssistantJobStore();
    const line = new RecordingLineDelivery();
    const { jobId } = await store.enqueue(request());
    // Allow pending -> reply_started, then "crash" on reply_started -> delivered.
    const original = store.setDelivery.bind(store);
    let calls = 0;
    store.setDelivery = async (...args) => {
      calls += 1;
      if (calls === 2) throw new Error("process killed after reply");
      return original(...args);
    };
    await runAssistantWorker(options(store, answered, line));
    expect(line.sent).toHaveLength(1);
    store.setDelivery = original;

    store.expireLease(jobId!);
    await runAssistantWorker(options(store, answered, line, { pushFallbackEnabled: true }));
    expect(line.sent).toHaveLength(1);
    expect(store.jobs.get(jobId!)).toMatchObject({ status: "completed", delivery_state: "uncertain" });
  });

  test("an expired reply token falls back to push to the chat, with the job's retry key", async () => {
    const store = new MemoryAssistantJobStore();
    const line = new RecordingLineDelivery();
    await store.enqueue(request({ replyTokenExpiresAt: new Date(Date.now() - 1_000).toISOString() }));
    await runAssistantWorker(options(store, answered, line));
    const job = onlyJob(store);
    expect(line.sent).toEqual([{ channel: "push", target: "Cgroup-secret", text: ANSWER, retryKey: job.delivery_retry_key }]);
    expect(job).toMatchObject({ delivery_state: "delivered", delivery_channel: "push" });
  });

  test("LINE rejecting the token (HTTP 400) is definite non-delivery: push follows", async () => {
    const store = new MemoryAssistantJobStore();
    const line = new RecordingLineDelivery();
    line.replyScript = [new LineDeliveryError("invalid_reply_token", 400, false)];
    await store.enqueue(request());
    await runAssistantWorker(options(store, answered, line));
    expect(line.sent.map((message) => message.channel)).toEqual(["push"]);
    expect(onlyJob(store).delivery_state).toBe("delivered");
  });

  test("an ambiguous reply failure is never resent (no duplicate answer)", async () => {
    const store = new MemoryAssistantJobStore();
    const line = new RecordingLineDelivery();
    line.replyScript = [new LineDeliveryError("ambiguous", 502, false)];
    await store.enqueue(request());
    await runAssistantWorker(options(store, answered, line));
    expect(line.sent).toHaveLength(0);
    expect(line.attempts.map((attempt) => attempt.channel)).toEqual(["reply"]);
    expect(onlyJob(store)).toMatchObject({ status: "completed", delivery_state: "uncertain", last_error_code: "reply_outcome_unknown" });
  });

  test("without push fallback an expired token is recorded as undeliverable", async () => {
    const store = new MemoryAssistantJobStore();
    const line = new RecordingLineDelivery();
    await store.enqueue(request({ replyToken: null, replyTokenExpiresAt: null }));
    await runAssistantWorker(options(store, answered, line, { pushFallbackEnabled: false }));
    expect(line.attempts).toHaveLength(0);
    expect(onlyJob(store)).toMatchObject({ delivery_state: "undeliverable", last_error_code: "reply_token_expired_push_disabled" });
  });

  test("a push whose response was lost is retried with the same key and LINE shows it once", async () => {
    const store = new MemoryAssistantJobStore();
    const line = new RecordingLineDelivery();
    line.pushScript = [{ acceptedThenFail: new LineDeliveryError("ambiguous", null, true) }];
    await store.enqueue(request({ replyToken: null, replyTokenExpiresAt: null }));
    let modelCalls = 0;
    const counting: AssistantAnswerer = async (job, context) => { modelCalls += 1; return answered(job, context); };

    const first = await runAssistantWorker(options(store, counting, line));
    expect(first.retried).toBe(1);
    store.makeAvailable();
    await runAssistantWorker(options(store, counting, line));

    expect(line.sent).toHaveLength(1);
    expect(line.attempts).toHaveLength(2);
    expect(new Set(line.attempts.map((attempt) => attempt.retryKey)).size).toBe(1);
    expect(modelCalls).toBe(1);
    expect(onlyJob(store)).toMatchObject({ status: "completed", delivery_state: "delivered" });
  });

  test("a worker whose lease was taken over cannot record or deliver", async () => {
    const store = new MemoryAssistantJobStore();
    const line = new RecordingLineDelivery();
    const { jobId } = await store.enqueue(request());
    const slow: AssistantAnswerer = async (job, context) => {
      // While this worker thinks, its lease expires and recovery claims the job.
      store.expireLease(job.id);
      await store.claim("recovery", { limit: 1, leaseSeconds: 60, maxRunning: 10 });
      return answered(job, context);
    };
    const summary = await runAssistantWorker(options(store, slow, line));
    expect(summary.fenced).toBe(1);
    expect(line.sent).toHaveLength(0);
    expect(store.jobs.get(jobId!)).toMatchObject({ status: "running", worker_id: "recovery", answer_text: null });
  });

  test("bounded workers: never more answers in flight than the concurrency limit", async () => {
    const store = new MemoryAssistantJobStore();
    const line = new RecordingLineDelivery();
    for (let i = 0; i < 7; i += 1) await store.enqueue(request({ lineUserId: `U${i}` }));
    let inFlight = 0;
    let peak = 0;
    const measured: AssistantAnswerer = async (job, context) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      return answered(job, context);
    };
    const summary = await runAssistantWorker(options(store, measured, line, { concurrency: 2, maxRunning: 2, maxJobs: 10 }));
    expect(summary).toMatchObject({ claimed: 7, completed: 7, delivered: 7 });
    expect(peak).toBe(2);
  });

  test("a hung model is cut at the answer budget and retried later", async () => {
    const store = new MemoryAssistantJobStore();
    const line = new RecordingLineDelivery();
    await store.enqueue(request());
    const hung: AssistantAnswerer = () => new Promise(() => {});
    const started = Date.now();
    const summary = await runAssistantWorker(options(store, hung, line, { answerBudgetMs: 2_500, budgetMs: 10_000 }));
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(summary.retried).toBe(1);
    expect(onlyJob(store).last_error_code).toBe("answer_timeout");
  });
});

describe("assistant logs carry no question, answer or LINE identity", () => {
  const spies: Array<{ mockRestore(): void }> = [];
  afterEach(() => { while (spies.length) spies.pop()!.mockRestore(); });

  test("success, provider failure with an echoing error body, and crash paths", async () => {
    const records: string[] = [];
    for (const level of ["debug", "info", "warn", "error"] as const) {
      spies.push(spyOn(logger, level).mockImplementation((message: string, meta?: Record<string, unknown>) => {
        records.push(`${message} ${JSON.stringify(meta ?? {})}`);
      }));
    }
    const store = new MemoryAssistantJobStore();
    const line = new RecordingLineDelivery();
    await store.enqueue(request());
    await store.enqueue(request({ lineUserId: "Usecret-user-2", maxAttempts: 1 }));
    await store.enqueue(request({ lineUserId: "Usecret-user-3" }));
    let call = 0;
    const mixed: AssistantAnswerer = async (job, context) => {
      call += 1;
      if (call === 2) {
        // A provider error that echoes the prompt must not reach the logs.
        throw new OpenAIAnalystError(`OpenAI analyst request failed: HTTP 400`, "http", 400);
      }
      if (call === 3) throw new Error(`boom while reading ${QUESTION} for Usecret-user-3`);
      return answered(job, context);
    };
    await runAssistantWorker(options(store, mixed, line));

    const all = records.join("\n");
    expect(records.length).toBeGreaterThan(0);
    for (const secret of [QUESTION, ANSWER, "หนูเล็ก", "Usecret-user", "Cgroup-secret", "token-"]) {
      expect(all).not.toContain(secret);
    }
  });
});
