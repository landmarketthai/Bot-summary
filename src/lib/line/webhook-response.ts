import type { WebhookProcessResult } from "./webhook-service";

export function webhookResponseStatus(
  results: Pick<WebhookProcessResult, "retryable">[],
): number {
  return results.some((result) => result.retryable === true) ? 503 : 200;
}
