/**
 * Independent, bounded worker for @Botsummary answer jobs.
 *
 * Runs from the worker cron route and from the webhook's post-response kick;
 * both are just claimers of the same durable queue, so correctness never
 * depends on a request living on after its response. Per invocation:
 *   - at most `concurrency` jobs in flight, and the SQL claim caps live
 *     leases across ALL invocations at `maxRunning`;
 *   - each answer is bounded by its own deadline, far inside the lease, so a
 *     live lease is never taken over from a healthy worker;
 *   - the answer is recorded before delivery: a crash afterwards re-delivers
 *     the stored answer without paying for the model again;
 *   - a transient failure is retried with backoff; the final attempt (or a
 *     permanent failure) delivers a short Thai notice instead of silence.
 * Logs carry job ids, codes and counts only: never questions, answers or
 * LINE ids.
 */
import { logger } from "@/lib/logger";
import { isIoTimeout, withTimeout } from "@/lib/slips/io-timeout";
import { deliverAnswer, type DeliveryResult, type LineDeliveryAdapter } from "./delivery";
import { classifyAssistantError, type AssistantErrorClass } from "./errors";
import type { AssistantJob, AssistantJobStore } from "./job-store";

export interface AssistantAnswer {
  text: string;
  /** "notice" for permission/usage replies that are not data answers. */
  kind?: "answer" | "notice";
  usage?: Record<string, unknown> | null;
  toolNames?: readonly string[];
  /** Saved as a conversation turn (kind "answer" only). */
  turn?: { businessDate: string; context: Record<string, unknown> } | null;
}

export type AssistantAnswerer = (
  job: AssistantJob,
  context: { deadlineAt: number; signal: AbortSignal },
) => Promise<AssistantAnswer>;

export interface AssistantWorkerOptions {
  store: AssistantJobStore;
  answer: AssistantAnswerer;
  delivery: LineDeliveryAdapter;
  pushFallbackEnabled: boolean;
  workerId: string;
  /** Wall-clock budget for this invocation. */
  budgetMs: number;
  maxJobs?: number;
  concurrency?: number;
  maxRunning?: number;
  leaseSeconds?: number;
  /** Per-job answer budget; clamped to what the invocation has left. */
  answerBudgetMs?: number;
  /** Time reserved for recording + delivery after the answer. */
  deliveryReserveMs?: number;
  temporaryErrorText: string;
}

export interface AssistantWorkerSummary {
  claimed: number;
  completed: number;
  failed: number;
  retried: number;
  fenced: number;
  delivered: number;
  undelivered: number;
}

export const ASSISTANT_WORKER_DEFAULTS = {
  concurrency: 3,
  maxRunning: 4,
  leaseSeconds: 120,
  answerBudgetMs: 35_000,
  deliveryReserveMs: 8_000,
};

/** 4 s, 16 s, 64 s ... capped at 5 minutes. */
export function retryDelaySeconds(attempts: number, retryAfterMs: number | null = null): number {
  const backoff = Math.min(300, 4 ** Math.max(1, attempts));
  return Math.max(backoff, retryAfterMs ? Math.ceil(retryAfterMs / 1000) : 0);
}

type JobOutcome = "completed" | "failed" | "retried" | "fenced";

async function processJob(
  job: AssistantJob,
  options: AssistantWorkerOptions,
  invocationDeadline: number,
  summary: AssistantWorkerSummary,
): Promise<JobOutcome> {
  const lease = job.lease_token;
  if (!lease) return "fenced";
  const { store } = options;
  const reserve = options.deliveryReserveMs ?? ASSISTANT_WORKER_DEFAULTS.deliveryReserveMs;
  const log = { jobId: job.id, attempt: job.attempts, maxAttempts: job.max_attempts };

  let text = job.answer_text;
  let kind = job.answer_kind;
  let errorCode: string | null = null;

  if (text === null) {
    // attempts > max_attempts only after a crash on the final attempt.
    const finalAttempt = job.attempts >= job.max_attempts;
    let answer: AssistantAnswer | null = null;
    if (job.attempts <= job.max_attempts) {
      const answerDeadline = Math.min(
        Date.now() + (options.answerBudgetMs ?? ASSISTANT_WORKER_DEFAULTS.answerBudgetMs),
        invocationDeadline - reserve,
      );
      try {
        if (answerDeadline - Date.now() < 2_000) throw new AssistantBudgetExhausted();
        answer = await withTimeout("ai assistant answer", answerDeadline - Date.now(), (signal) =>
          options.answer(job, { deadlineAt: answerDeadline, signal }));
      } catch (error) {
        const classified: AssistantErrorClass = classifyAssistantError(error);
        errorCode = classified.code;
        logger.warn("ai assistant answer failed", { ...log, code: classified.code, retryable: classified.retryable });
        if (classified.retryable && !finalAttempt) {
          const retried = await store.retry(job.id, lease, retryDelaySeconds(job.attempts), classified.code);
          return retried ? "retried" : "fenced";
        }
      }
    } else {
      errorCode = "attempts_exhausted";
    }

    text = answer?.text.trim() ? answer.text.trim().slice(0, 5000) : options.temporaryErrorText;
    kind = answer?.text.trim() ? (answer.kind ?? "answer") : "notice";
    const recorded = await store.recordAnswer(job.id, lease, {
      answer: text,
      kind,
      usage: answer?.usage ?? null,
      toolNames: answer?.toolNames ?? [],
      turn: kind === "answer" ? answer?.turn ?? null : null,
    });
    if (!recorded) return "fenced";
  }

  const delivery: DeliveryResult = await withTimeout(
    "ai assistant delivery",
    Math.max(1_000, Math.min(reserve, invocationDeadline - Date.now())),
    (signal) => deliverAnswer(job, lease, text!, {
      store,
      adapter: options.delivery,
      pushFallbackEnabled: options.pushFallbackEnabled,
      signal,
    }),
  ).catch((error: unknown): DeliveryResult => {
    // A cut-off delivery is retried: the recorded delivery state decides
    // whether that may resend (push, same retry key) or not (reply -> uncertain).
    // Anything else (store unreachable) is a crash: the lease expires and
    // recovery picks the job up from its recorded state.
    if (isIoTimeout(error)) return { state: "retry", reason: "delivery_timeout", retryAfterMs: null };
    throw error;
  });

  if (delivery.state === "fenced") return "fenced";
  let undeliveredReason: string | null = delivery.state === "delivered" ? null : "reason" in delivery ? delivery.reason : null;
  if (delivery.state === "retry") {
    // Only a push can be in flight here (a reply is never retried), and it
    // keeps its retry key, so the retry cannot duplicate.
    if (job.attempts < job.max_attempts + 1) {
      const retried = await store.retry(job.id, lease, retryDelaySeconds(job.attempts, delivery.retryAfterMs), delivery.reason);
      return retried ? "retried" : "fenced";
    }
    if (!await store.setDelivery(job.id, lease, ["push_started", "pending"], "undeliverable")) return "fenced";
    undeliveredReason = "push_attempts_exhausted";
  }

  if (undeliveredReason === null) summary.delivered += 1;
  else {
    summary.undelivered += 1;
    logger.warn("ai assistant answer not delivered", { ...log, reason: undeliveredReason });
  }
  // A permission notice is a successful answer; only an answer error makes it failed.
  const status = errorCode === null ? "completed" : "failed";
  const completed = await store.complete(job.id, lease, status, errorCode ?? undeliveredReason);
  return completed ? status : "fenced";
}

class AssistantBudgetExhausted extends Error {
  constructor() {
    super("ai assistant worker budget exhausted");
    this.name = "AssistantBudgetExhausted";
  }
}

export async function runAssistantWorker(options: AssistantWorkerOptions): Promise<AssistantWorkerSummary> {
  const startedAt = Date.now();
  const deadline = startedAt + options.budgetMs;
  const concurrency = Math.max(1, options.concurrency ?? ASSISTANT_WORKER_DEFAULTS.concurrency);
  const maxJobs = options.maxJobs ?? 10;
  const reserve = options.deliveryReserveMs ?? ASSISTANT_WORKER_DEFAULTS.deliveryReserveMs;
  const summary: AssistantWorkerSummary = {
    claimed: 0, completed: 0, failed: 0, retried: 0, fenced: 0, delivered: 0, undelivered: 0,
  };
  const inFlight = new Set<Promise<void>>();
  let claimingStopped = false;

  const claimMore = async (): Promise<void> => {
    while (!claimingStopped && inFlight.size < concurrency && summary.claimed < maxJobs) {
      // A new job needs room for at least a short answer plus delivery.
      if (deadline - Date.now() < reserve + 5_000) { claimingStopped = true; return; }
      let jobs: AssistantJob[];
      try {
        jobs = await options.store.claim(options.workerId, {
          limit: Math.min(concurrency - inFlight.size, maxJobs - summary.claimed),
          leaseSeconds: options.leaseSeconds ?? ASSISTANT_WORKER_DEFAULTS.leaseSeconds,
          maxRunning: options.maxRunning ?? ASSISTANT_WORKER_DEFAULTS.maxRunning,
        });
      } catch (error) {
        logger.error("ai assistant claim failed", { code: classifyAssistantError(error).code });
        claimingStopped = true;
        return;
      }
      if (jobs.length === 0) { claimingStopped = true; return; }
      for (const job of jobs) {
        summary.claimed += 1;
        const task: Promise<void> = processJob(job, options, deadline, summary)
          .then((outcome) => { summary[outcome] += 1; })
          .catch((error: unknown) => {
            // The lease expires and another claim retries the job.
            summary.fenced += 1;
            logger.error("ai assistant job crashed", {
              jobId: job.id,
              code: classifyAssistantError(error).code,
            });
          })
          .finally(() => { inFlight.delete(task); });
        inFlight.add(task);
      }
    }
  };

  await claimMore();
  while (inFlight.size > 0) {
    await Promise.race(inFlight);
    await claimMore();
  }
  logger.info("ai assistant worker finished", { ...summary, durationMs: Date.now() - startedAt });
  return summary;
}
