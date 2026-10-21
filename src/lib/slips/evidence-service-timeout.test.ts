/**
 * P1 #8 - real I/O bounds. Hanging / slow providers must not hold an ingest
 * attempt (or the cron) past the configured wall-clock caps, whether or not the
 * provider honours the abort signal.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { downloadLineMessageContent } from "@/lib/line/content";
import { SlipEvidenceService } from "./evidence-service";
import { ExtractionHttpError, OpenAiSlipExtractor } from "./extractor";
import { IoTimeoutError, withTimeout } from "./io-timeout";
import type { Database } from "@/types/database";

const input = {
  rawMessageId: "raw-1",
  lineMessageId: "m-1",
  sourceId: "G1",
  sourceType: "group" as const,
  lineUserId: "U1",
  eventTimestamp: 1_760_000_000_000,
};

function makeSupabase(uploadImpl: (path: string, bytes: Uint8Array) => Promise<{ error: { message: string } | null }>) {
  const evidenceRows: Array<Record<string, unknown>> = [];
  const client = {
    storage: { from: () => ({ upload: (path: string, bytes: Uint8Array) => uploadImpl(path, bytes) }) },
    from(table: string) {
      if (table === "slip_evidences") {
        return {
          insert(row: Record<string, unknown>) {
            evidenceRows.push(row);
            return { select: () => ({ single: async () => ({ data: { id: `ev-${evidenceRows.length}` }, error: null }) }) };
          },
        };
      }
      return { update: () => ({ eq: async () => ({ error: null }) }) };
    },
  } as unknown as SupabaseClient<Database>;
  return { client, evidenceRows };
}

const bytes = new Uint8Array([1, 2, 3]);
const timeouts = { downloadMs: 120, uploadMs: 120 };

async function timed<T>(run: () => Promise<T>): Promise<{ value: T; elapsedMs: number }> {
  const started = performance.now();
  const value = await run();
  return { value, elapsedMs: performance.now() - started };
}

describe("SlipEvidenceService I/O bounds", () => {
  test("a LINE download that never settles (ignores the signal) is cut off and recorded DOWNLOAD_FAILED", async () => {
    const { client, evidenceRows } = makeSupabase(async () => ({ error: null }));
    const service = new SlipEvidenceService(client, () => new Promise(() => {}), timeouts);

    const { value, elapsedMs } = await timed(() => service.ingest(input));

    expect(value.status).toBe("DOWNLOAD_FAILED");
    expect(elapsedMs).toBeGreaterThanOrEqual(100);
    expect(elapsedMs).toBeLessThan(500);
    expect(evidenceRows).toHaveLength(1);
    expect(evidenceRows[0]).toMatchObject({ status: "DOWNLOAD_FAILED", byte_size: 0 });
  });

  test("a cooperative download is handed a signal that aborts at the timeout", async () => {
    let seen: AbortSignal | undefined;
    const { client } = makeSupabase(async () => ({ error: null }));
    const service = new SlipEvidenceService(
      client,
      (_id, ctx) => new Promise((_resolve, reject) => {
        seen = ctx!.signal;
        expect(ctx!.timeoutMs).toBe(timeouts.downloadMs);
        ctx!.signal.addEventListener("abort", () => reject(new Error("aborted by signal")));
      }),
      timeouts,
    );
    const { value, elapsedMs } = await timed(() => service.ingest(input));
    expect(value.status).toBe("DOWNLOAD_FAILED");
    expect(seen?.aborted).toBe(true);
    expect(seen?.reason).toBeInstanceOf(IoTimeoutError);
    expect(elapsedMs).toBeLessThan(500);
  });

  test("a hung Storage upload is cut off as STORAGE_FAILED; the late upload is harmless", async () => {
    const stored = new Map<string, Uint8Array>();
    let releaseUpload!: () => void;
    const uploadGate = new Promise<void>((resolve) => { releaseUpload = resolve; });
    let uploadCalls = 0;
    const { client, evidenceRows } = makeSupabase(async (path, body) => {
      uploadCalls += 1;
      if (uploadCalls === 1) {
        await uploadGate; // hangs past the cap, then completes
      }
      stored.set(path, body);
      return { error: null };
    });
    const service = new SlipEvidenceService(client, async () => ({ bytes, mimeType: "image/jpeg" }), timeouts);

    const first = await timed(() => service.ingest(input));
    expect(first.value.status).toBe("STORAGE_FAILED");
    expect(first.elapsedMs).toBeGreaterThanOrEqual(100);
    expect(first.elapsedMs).toBeLessThan(500);
    expect(evidenceRows).toHaveLength(1);
    expect(evidenceRows[0]).toMatchObject({ status: "STORAGE_FAILED" });
    expect(stored.size).toBe(0);

    // The orphaned upload finally lands: same deterministic path, same bytes,
    // and no evidence row / ledger write of its own.
    releaseUpload();
    await new Promise((r) => setTimeout(r, 20));
    expect([...stored.keys()]).toEqual([first.value.storagePath]);
    expect([...stored.values()][0]).toEqual(bytes);
    expect(evidenceRows).toHaveLength(1);

    // The next attempt rewrites the identical object (upsert) - idempotent.
    const second = await service.ingest({ ...input, rawMessageId: "raw-1" });
    expect(second.storagePath).toBe(first.value.storagePath);
    expect(stored.size).toBe(1);
  });

  test("download + upload both near their caps stay under their sum (worst-case attempt bound)", async () => {
    const { client } = makeSupabase(async () => new Promise(() => {}));
    const service = new SlipEvidenceService(
      client,
      (_id, ctx) => new Promise((resolve) => setTimeout(() => resolve({ bytes, mimeType: "image/jpeg" }), 100)),
      timeouts,
    );
    const { value, elapsedMs } = await timed(() => service.ingest(input));
    expect(value.status).toBe("STORAGE_FAILED");
    expect(elapsedMs).toBeLessThan(timeouts.downloadMs + timeouts.uploadMs + 250);
  });
});

describe("withTimeout", () => {
  test("rejects with IoTimeoutError(stage) at the cap and never later", async () => {
    const { value, elapsedMs } = await timed(() =>
      withTimeout("stage_x", 80, () => new Promise<never>(() => {})).catch((e: unknown) => e),
    );
    expect(value).toBeInstanceOf(IoTimeoutError);
    expect((value as IoTimeoutError).stage).toBe("stage_x");
    expect(elapsedMs).toBeLessThan(300);
  });

  test("returns the value and leaves no pending timer when the work wins", async () => {
    expect(await withTimeout("fast", 5_000, async () => 7)).toBe(7);
  });
});

describe("downloadLineMessageContent honours its timeout (headers and body)", () => {
  const realFetch = globalThis.fetch;
  // AbortSignal.timeout() timers are unref'd; a real socket keeps the loop
  // alive, the stubbed fetch does not, so hold it open for the test.
  let keepAlive: ReturnType<typeof setInterval>;
  beforeEach(() => { keepAlive = setInterval(() => {}, 25); });

  function stubFetch(handler: (init: RequestInit) => Promise<Response>) {
    globalThis.fetch = ((_url: unknown, init: RequestInit) => handler(init)) as typeof fetch;
  }
  const restore = () => { globalThis.fetch = realFetch; clearInterval(keepAlive); };

  function abortable(signal: AbortSignal | null | undefined): Promise<never> {
    return new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")));
    });
  }

  test("a connection that never answers is aborted at timeoutMs", async () => {
    stubFetch((init) => abortable(init.signal));
    try {
      const { value, elapsedMs } = await timed(() =>
        downloadLineMessageContent("m", "token", { timeoutMs: 100 }).catch((e: unknown) => e),
      );
      expect(value).toBeInstanceOf(Error);
      expect(elapsedMs).toBeGreaterThanOrEqual(80);
      expect(elapsedMs).toBeLessThan(500);
    } finally {
      restore();
    }
  });

  test("a body that stalls after the headers is aborted too", async () => {
    stubFetch(async (init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          init.signal?.addEventListener("abort", () => controller.error(init.signal!.reason));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "image/jpeg" } });
    });
    try {
      const { value, elapsedMs } = await timed(() =>
        downloadLineMessageContent("m", "token", { timeoutMs: 100, maxBytes: 1_000_000 }).catch((e: unknown) => e),
      );
      expect(value).toBeInstanceOf(Error);
      expect(elapsedMs).toBeLessThan(500);
    } finally {
      restore();
    }
  });

  test("an external signal aborts the download even without timeoutMs", async () => {
    stubFetch((init) => abortable(init.signal));
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("caller gave up")), 60);
    try {
      const { value, elapsedMs } = await timed(() =>
        downloadLineMessageContent("m", "token", { signal: controller.signal }).catch((e: unknown) => e),
      );
      expect((value as Error).message).toBe("caller gave up");
      expect(elapsedMs).toBeLessThan(400);
    } finally {
      restore();
    }
  });
});

describe("OpenAiSlipExtractor call timeout", () => {
  test("a provider call that never answers is bounded and retried once, then fails as a retryable timeout", async () => {
    let calls = 0;
    const hanging = (() => { calls += 1; return new Promise(() => {}); }) as unknown as typeof fetch;
    const extractor = new OpenAiSlipExtractor("key", "model", hanging, async () => {}, 100);

    const { value, elapsedMs } = await timed(() =>
      extractor.extract({ bytes, mimeType: "image/jpeg" }).catch((e: unknown) => e),
    );

    expect(value).toBeInstanceOf(ExtractionHttpError);
    expect((value as ExtractionHttpError).failureCode).toBe("timeout");
    expect((value as ExtractionHttpError).retryable).toBe(true);
    expect(calls).toBe(2);
    expect(elapsedMs).toBeGreaterThanOrEqual(180);
    expect(elapsedMs).toBeLessThan(700);
  });

  test("a body that never finishes after the headers is bounded", async () => {
    const stalledBody = (async () => ({
      ok: true,
      status: 200,
      json: () => new Promise(() => {}),
      text: async () => "",
    })) as unknown as typeof fetch;
    const extractor = new OpenAiSlipExtractor("key", "model", stalledBody, async () => {}, 100);
    const { value, elapsedMs } = await timed(() =>
      extractor.extract({ bytes, mimeType: "image/jpeg" }).catch((e: unknown) => e),
    );
    expect((value as ExtractionHttpError).failureCode).toBe("timeout");
    expect(elapsedMs).toBeLessThan(700);
  });
});
