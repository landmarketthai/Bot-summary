import { beforeEach, describe, expect, it, mock } from "bun:test";
import { NextRequest } from "next/server";

const pushes: Array<{ to: string; text: string; retryKey?: string }> = [];
mock.module("@/lib/line/reply", () => ({
  pushLineMessage: async (to: string, text: string, retryKey?: string) => {
    pushes.push({ to, text, retryKey });
    return { status: "delivered" as const };
  },
}));

const { POST } = await import("./route");

function req(body: unknown, secret = "test-secret") {
  return new NextRequest("https://example.test/api/cron/admin-line-alert", {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("admin LINE alert", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "test-secret";
    pushes.length = 0;
  });

  it("rejects unauthorized calls", async () => {
    const res = await POST(req({ target: "C12345678901", text: "hello" }, "wrong"));
    expect(res.status).toBe(401);
    expect(pushes).toHaveLength(0);
  });

  it("rejects malformed targets", async () => {
    const res = await POST(req({ target: "bad", text: "hello" }));
    expect(res.status).toBe(400);
    expect(pushes).toHaveLength(0);
  });

  it("pushes one protected text message to exactly one target", async () => {
    const res = await POST(req({ target: "C0a6ce0f4cac43d27ab0df8ca809de511", text: "✅ update" }));
    expect(res.status).toBe(200);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.to).toBe("C0a6ce0f4cac43d27ab0df8ca809de511");
    expect(pushes[0]?.text).toBe("✅ update");
    expect(pushes[0]?.retryKey).toMatch(/^[0-9a-f-]{36}$/i);
  });
});
