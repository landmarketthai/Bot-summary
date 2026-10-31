/**
 * Production wiring of the @Botsummary assistant: env configuration,
 * deadline-bound Supabase clients, the GPT-6 Luna provider and the real LINE
 * adapter. Tests and the Preview demo build the same pieces with fakes.
 */
import { randomUUID } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/server";
import { deadlineFetch } from "@/lib/slips/io-timeout";
import { BOT_SUMMARY_TEMPORARY_ERROR_REPLY } from "@/lib/ai/line-command";
import { createAssistantModelProvider } from "@/lib/ai/model-provider";
import { boundedJobFetch } from "./bounded-fetch";
import { answerAssistantJob, ASSISTANT_SCOPE_CHANGED_REPLY, revalidateAssistantJob, type AssistantCoreDeps } from "./core";
import { lineMessagingDelivery, type LineDeliveryAdapter } from "./delivery";
import { SupabaseAssistantJobStore, type AssistantJobStore } from "./job-store";
import {
  ASSISTANT_WORKER_DEFAULTS,
  runAssistantWorker,
  type AssistantAnswerer,
  type AssistantWorkerSummary,
} from "./worker";

function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw >= min && raw <= max ? raw : fallback;
}

export function assistantRuntimeConfig() {
  return {
    /** Push costs LINE message quota; off unless explicitly enabled. */
    pushFallbackEnabled: process.env.BOT_SUMMARY_ASSISTANT_PUSH_FALLBACK_ENABLED === "true",
    concurrency: intFromEnv("BOT_SUMMARY_ASSISTANT_WORKER_CONCURRENCY", ASSISTANT_WORKER_DEFAULTS.concurrency, 1, 8),
    maxRunning: intFromEnv("BOT_SUMMARY_ASSISTANT_MAX_RUNNING", ASSISTANT_WORKER_DEFAULTS.maxRunning, 1, 20),
    leaseSeconds: intFromEnv("BOT_SUMMARY_ASSISTANT_LEASE_SECONDS", ASSISTANT_WORKER_DEFAULTS.leaseSeconds, 60, 900),
    answerBudgetMs: intFromEnv("BOT_SUMMARY_ASSISTANT_ANSWER_BUDGET_MS", ASSISTANT_WORKER_DEFAULTS.answerBudgetMs, 5_000, 50_000),
    dbCallTimeoutMs: 12_000,
    dbMaxOutstanding: intFromEnv("BOT_SUMMARY_ASSISTANT_DB_MAX_OUTSTANDING", 4, 1, 16),
  };
}

function productionDeps(store: AssistantJobStore, deadlineMs: number): AssistantCoreDeps {
  const config = assistantRuntimeConfig();
  return {
    supabase: createServiceClient({
      fetch: boundedJobFetch({
        deadlineMs,
        callTimeoutMs: config.dbCallTimeoutMs,
        maxOutstanding: config.dbMaxOutstanding,
      }),
    }),
    store,
    provider: createAssistantModelProvider(),
  };
}

/** Default answerer: every job gets its own client, aborted at the job deadline. */
export function createProductionAnswerer(store: AssistantJobStore): AssistantAnswerer {
  return (job, context) => answerAssistantJob(job, context, productionDeps(store, context.deadlineAt));
}

export async function runAssistantWorkerOnce(options: {
  budgetMs: number;
  maxJobs?: number;
  workerId?: string;
  delivery?: LineDeliveryAdapter;
}): Promise<AssistantWorkerSummary> {
  const config = assistantRuntimeConfig();
  const deadlineMs = Date.now() + options.budgetMs;
  // Queue bookkeeping gets a little slack past the work deadline so a job can
  // still be completed or released; nothing it starts outlives that.
  const store = new SupabaseAssistantJobStore(createServiceClient({
    fetch: deadlineFetch(deadlineMs + 4_000, 8_000),
  }));
  return runAssistantWorker({
    store,
    answer: createProductionAnswerer(store),
    revalidate: (job, scopeKey) =>
      revalidateAssistantJob(job, productionDeps(store, Math.min(deadlineMs, Date.now() + 10_000)), scopeKey),
    scopeChangedText: ASSISTANT_SCOPE_CHANGED_REPLY,
    delivery: options.delivery ?? lineMessagingDelivery,
    pushFallbackEnabled: config.pushFallbackEnabled,
    workerId: options.workerId ?? `worker-${randomUUID()}`,
    budgetMs: options.budgetMs,
    maxJobs: options.maxJobs,
    concurrency: config.concurrency,
    maxRunning: config.maxRunning,
    leaseSeconds: config.leaseSeconds,
    answerBudgetMs: config.answerBudgetMs,
    temporaryErrorText: BOT_SUMMARY_TEMPORARY_ERROR_REPLY,
  });
}
