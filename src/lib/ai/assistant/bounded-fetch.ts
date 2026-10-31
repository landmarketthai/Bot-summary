/**
 * fetch for one assistant job's Supabase client.
 *
 *   deadline     every PostgREST call is aborted at the job deadline, so no
 *                query the job started outlives it (cancellation where the
 *                transport supports it);
 *   per call     no single call may take longer than `callTimeoutMs`;
 *   outstanding  at most `maxOutstanding` calls in flight — some read-only
 *                tools fan out one query per market/round, and this bounds the
 *                outstanding I/O one question can create. Waiting for a slot
 *                also ends at the deadline.
 *
 * The bound does not rely on the server honouring the abort: the returned
 * promise rejects at the deadline regardless (see withTimeout). Server-side
 * PostgreSQL work of an aborted request is bounded by the role's
 * statement_timeout, not by this helper.
 */
import { isIoTimeout, withTimeout } from "@/lib/slips/io-timeout";

function abortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

export function boundedJobFetch(options: {
  deadlineMs: number;
  callTimeoutMs: number;
  maxOutstanding: number;
  fetchImpl?: typeof fetch;
}): typeof fetch {
  const inner = options.fetchImpl ?? globalThis.fetch;
  const max = Math.max(1, Math.floor(options.maxOutstanding));
  let active = 0;
  const waiters: Array<() => void> = [];

  const acquire = (): Promise<void> => new Promise<void>((resolve, reject) => {
    if (active < max) {
      active += 1;
      resolve();
      return;
    }
    const remaining = options.deadlineMs - Date.now();
    if (remaining <= 0) {
      reject(abortError("assistant job deadline reached"));
      return;
    }
    const waiter = () => {
      clearTimeout(timer);
      resolve();
    };
    // A waiter that gives up leaves the queue, so it can never be handed a slot.
    const timer = setTimeout(() => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      reject(abortError("assistant job deadline reached while waiting for I/O slot"));
    }, remaining);
    waiters.push(waiter);
  });
  const release = () => {
    const next = waiters.shift();
    if (next) next(); // slot handed over; `active` unchanged
    else active -= 1;
  };

  const bounded = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    await acquire();
    try {
      const remaining = Math.min(options.callTimeoutMs, options.deadlineMs - Date.now());
      if (remaining <= 0) throw abortError("assistant job deadline reached");
      return await withTimeout("assistant http", remaining, (signal) =>
        inner(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal }),
      ).catch((error: unknown) => {
        if (isIoTimeout(error)) throw abortError(error.message);
        throw error;
      });
    } finally {
      release();
    }
  };
  return bounded as typeof fetch;
}
