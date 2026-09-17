import { afterEach, describe, expect, it } from "bun:test";
import { NextRequest } from "next/server";
import { POST, webhookResponseStatus } from "./route";

const originalSecret = process.env.LINE_CHANNEL_SECRET;

afterEach(() => {
  if (originalSecret === undefined) delete process.env.LINE_CHANNEL_SECRET;
  else process.env.LINE_CHANNEL_SECRET = originalSecret;
});

function postWebhook(headers: Record<string, string>, body = "{}"): NextRequest {
  return new NextRequest("http://localhost/api/webhook/line", {
    method: "POST",
    headers,
    body,
  });
}

describe("webhook retry status", () => {
  it("returns 503 only when durable processing requests redelivery", () => {
    expect(webhookResponseStatus([{ retryable: true }])).toBe(503);
    expect(webhookResponseStatus([{ retryable: false }, {}])).toBe(200);
  });
});

describe("POST /api/webhook/line — signature verification", () => {
  it("rejects a request with no x-line-signature header", async () => {
    process.env.LINE_CHANNEL_SECRET = "test-channel-secret";
    const res = await POST(postWebhook({}));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "Missing signature" });
  });

  it("rejects a request with an invalid x-line-signature", async () => {
    process.env.LINE_CHANNEL_SECRET = "test-channel-secret";
    const res = await POST(
      postWebhook({ "x-line-signature": "not-a-valid-signature" }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "Invalid signature" });
  });
});
