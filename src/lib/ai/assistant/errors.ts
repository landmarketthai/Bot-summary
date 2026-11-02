/**
 * Error classification for the assistant worker.
 *
 * Only a short machine code leaves this module: it is what gets logged and
 * stored (the jobs table CHECKs the shape). Provider messages, response
 * bodies, questions and tool arguments never do — a provider error body can
 * echo the prompt, which contains staff names and financial figures.
 */
import { OpenAIAnalystError } from "@/lib/ai/openai-analyst";
import { isIoTimeout } from "@/lib/slips/io-timeout";
import { AssistantStoreError } from "./job-store";

export interface AssistantErrorClass {
  /** ^[a-z0-9_.:-]{1,80}$ */
  code: string;
  retryable: boolean;
}

export function classifyAssistantError(error: unknown): AssistantErrorClass {
  if (error instanceof OpenAIAnalystError) {
    switch (error.kind) {
      case "http": {
        const status = error.httpStatus ?? 0;
        return {
          code: `provider_http_${status}`,
          retryable: status === 408 || status === 409 || status === 429 || status >= 500,
        };
      }
      case "timeout":
        return { code: "provider_timeout", retryable: true };
      case "network":
        return { code: "provider_network", retryable: true };
      case "status":
        return { code: `provider_status_${safeToken(error.providerCode) ?? "unknown"}`, retryable: false };
      case "provider":
        return { code: `provider_error_${safeToken(error.providerCode) ?? "unknown"}`, retryable: error.providerCode === "server_error" };
      case "config":
        return { code: "provider_not_configured", retryable: false };
      case "empty":
        return { code: "provider_empty_answer", retryable: true };
      case "limit":
        return { code: "tool_round_limit", retryable: false };
    }
  }
  if (error instanceof AssistantStoreError) {
    return { code: `store_${error.operation}`, retryable: true };
  }
  if (isIoTimeout(error)) return { code: "answer_timeout", retryable: true };
  if (error instanceof Error && error.name === "AssistantBudgetExhausted") {
    return { code: "worker_budget_exhausted", retryable: true };
  }
  if (error instanceof Error && error.name === "AbortError") {
    return { code: "aborted", retryable: true };
  }
  return { code: "unexpected_error", retryable: true };
}

function safeToken(value: string | null | undefined): string | null {
  if (!value) return null;
  const token = value.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40);
  return token || null;
}
