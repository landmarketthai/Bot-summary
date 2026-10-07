import { afterEach, describe, expect, it } from "bun:test";
import { downloadLineMessageContent } from "./content";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("downloadLineMessageContent", () => {
  it("downloads original LINE message bytes with bearer authentication", async () => {
    let requestUrl = "";
    let authorization = "";

    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/jpeg; charset=binary" },
      });
    }) as typeof fetch;

    const result = await downloadLineMessageContent("message/with spaces", "line-token");

    expect(requestUrl).toBe(
      "https://api-data.line.me/v2/bot/message/message%2Fwith%20spaces/content",
    );
    expect(authorization).toBe("Bearer line-token");
    expect(Array.from(result.bytes)).toEqual([1, 2, 3]);
    expect(result.mimeType).toBe("image/jpeg");
  });

  it("rejects unsuccessful LINE responses without reading response content", async () => {
    globalThis.fetch = (async () =>
      new Response("provider detail", { status: 404 })) as unknown as typeof fetch;

    expect(
      downloadLineMessageContent("missing", "line-token"),
    ).rejects.toThrow("LINE content download failed with HTTP 404");
  });
  it("enforces a declared download size before reading bytes", async () => {
    let cancelled = false;
    globalThis.fetch = (async () => new Response(new ReadableStream({
      cancel() { cancelled = true; },
    }), { headers: { "content-length": "100" } })) as unknown as typeof fetch;
    await expect(downloadLineMessageContent("img", "token", { maxBytes: 5 })).rejects.toThrow("size limit");
    expect(cancelled).toBe(true);
  });
  it("enforces the streamed size without trusting content-length", async () => {
    let cancelled = false;
    globalThis.fetch = (async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
      }, cancel() { cancelled = true; },
    }))) as unknown as typeof fetch;
    await expect(downloadLineMessageContent("img", "token", { maxBytes: 5 })).rejects.toThrow("size limit");
    expect(cancelled).toBe(true);
  });
  it("preserves a bounded streamed body and applies a download timeout signal", async () => {
    globalThis.fetch = (async (_input, init) => {
      expect(init?.signal).toBeDefined();
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } });
    }) as typeof fetch;
    expect(await downloadLineMessageContent("img", "token", { maxBytes: 5, timeoutMs: 100 })).toEqual({
      bytes: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg",
    });
  });
});
