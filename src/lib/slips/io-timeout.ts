/**
 * Hard wall-clock bound for one I/O step (LINE download, Storage upload, OCR).
 *
 * A signal is handed to the operation so a cooperative provider (fetch) really
 * aborts, but the bound does NOT depend on the provider honouring it: the
 * returned promise rejects at the deadline regardless, so a hung socket, a
 * stalled Storage client or a fake that ignores the signal cannot hold the
 * caller past `timeoutMs`.
 *
 * An abandoned operation may still finish later. That is harmless for slip
 * ingestion because every durable effect is idempotent or fenced:
 *   - Storage upload writes identical bytes to a path derived from the LINE
 *     message id (upsert), and only the awaiting attempt records the evidence;
 *   - ledger attach/fail are fenced by the attempt token (stale_claim);
 *   - OCR terminal writes are fenced by the slip_checks claim token.
 */
export class IoTimeoutError extends Error {
  constructor(
    readonly stage: string,
    readonly timeoutMs: number,
  ) {
    super(`${stage} timed out after ${timeoutMs}ms`);
    this.name = "IoTimeoutError";
  }
}

export function isIoTimeout(error: unknown): error is IoTimeoutError {
  return error instanceof IoTimeoutError;
}

export async function withTimeout<T>(
  stage: string,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const bound = Number.isFinite(timeoutMs) ? Math.max(1, Math.floor(timeoutMs)) : null;
  const controller = new AbortController();
  if (bound === null) return run(controller.signal);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new IoTimeoutError(stage, bound);
      controller.abort(error);
      reject(error);
    }, bound);
  });
  try {
    // Promise.race keeps a handler on the loser, so a late rejection of the
    // abandoned operation is never an unhandled rejection.
    return await Promise.race([run(controller.signal), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * fetch bounded by an absolute deadline AND a per-call cap. Used as the
 * Supabase client's global fetch in the cron route, so every PostgREST /
 * Storage call of a phase is aborted when the phase ends: nothing that phase
 * started can still write after it (no detached effects running into the next
 * phase or past the response). Calls after the deadline fail immediately.
 *
 * Rejects with an AbortError so postgrest-js returns `{ error }` without its
 * own GET retry/sleep loop.
 */
export function deadlineFetch(deadlineMs: number, callTimeoutMs: number): typeof fetch {
  const bounded = (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const remaining = Math.min(callTimeoutMs, deadlineMs - Date.now());
    if (remaining <= 0) {
      return Promise.reject(new DOMException("cron phase deadline reached", "AbortError"));
    }
    return withTimeout("http", remaining, (signal) =>
      globalThis.fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal }),
    ).catch((error: unknown) => {
      if (isIoTimeout(error)) throw new DOMException(error.message, "AbortError");
      throw error;
    });
  };
  return bounded as typeof fetch;
}
