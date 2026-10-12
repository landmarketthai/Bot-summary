import { beforeEach, describe, expect, it, mock } from "bun:test";
import { NextRequest } from "next/server";
import type { CookieOptions } from "@supabase/ssr";

let sessionUser: { id: string } | null = null;
let cookieUpdates: { name: string; value: string; options: CookieOptions }[] = [];
beforeEach(() => { sessionUser = null; cookieUpdates = []; });

// proxy() calls supabase.auth.getUser(), which makes a real network call
// against Supabase Auth. Stub createServerClient so "no session" resolves
// instantly without touching the network.
mock.module("@supabase/ssr", () => ({
  createServerClient: (_url: string, _key: string, options: { cookies: { setAll: (list: typeof cookieUpdates) => void } }) => ({
    auth: {
      getUser: async () => {
        options.cookies.setAll(cookieUpdates);
        return { data: { user: sessionUser }, error: null };
      },
    },
  }),
}));

const { proxy } = await import("./proxy");

function postTo(pathname: string): NextRequest {
  return new NextRequest(`http://localhost${pathname}`, { method: "POST" });
}

describe("proxy — LINE webhook auth bypass", () => {
  it("lets POST /api/webhook/line reach the route without a Supabase session", async () => {
    const res = await proxy(postTo("/api/webhook/line"));
    expect(res.status).not.toBe(401);
  });

  it("still returns 401 for another protected API route without a session", async () => {
    const res = await proxy(postTo("/api/settlement"));
    expect(res.status).toBe(401);
  });

  it("does not exempt a webhook-like path that isn't the exact LINE webhook route", async () => {
    const res = await proxy(postTo("/api/webhook/other"));
    expect(res.status).toBe(401);
  });

  it("does not exempt a path that merely starts with the webhook prefix", async () => {
    const res = await proxy(postTo("/api/webhookzzz"));
    expect(res.status).toBe(401);
  });
});

describe("proxy — SSR response cookies", () => {
  it.each([
    ["/financial-summary", true, 200, null],
    ["/login", true, 307, "/"],
    ["/auth/callback", true, 307, "/"],
    ["/api/settlement", false, 401, null],
    ["/financial-summary", false, 307, "/login?next=%2Ffinancial-summary"],
  ] as const)("preserves chunk updates and deletions for %s (authenticated=%s)", async (path, authenticated, status, location) => {
    sessionUser = authenticated ? { id: "synthetic-user" } : null;
    const options: CookieOptions = { path: "/", httpOnly: true, secure: true, sameSite: "lax", maxAge: 3600 };
    cookieUpdates = [
      { name: "sb-test-auth-token.0", value: authenticated ? "fresh-0" : "", options: { ...options, maxAge: authenticated ? 3600 : 0 } },
      { name: "sb-test-auth-token.1", value: authenticated ? "fresh-1" : "", options: { ...options, maxAge: authenticated ? 3600 : 0 } },
      { name: "sb-test-auth-token.2", value: "", options: { ...options, maxAge: 0 } },
    ];
    const req = new NextRequest(`http://localhost${path}`, { headers: { cookie: "sb-test-auth-token.0=old; sb-test-auth-token.1=old; sb-test-auth-token.2=stale" } });
    const res = await proxy(req);
    expect(res.status).toBe(status);
    expect(res.headers.get("location")).toBe(location === null ? null : `http://localhost${location}`);
    if (status === 401) expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(res.headers.getSetCookie()).toHaveLength(3);
    for (const { name, value, options } of cookieUpdates) {
      expect(req.cookies.get(name)?.value).toBe(value);
      expect(res.cookies.get(name)).toMatchObject({ name, value, ...options });
      if (options.maxAge === 0) expect(res.headers.getSetCookie().find(header => header.startsWith(`${name}=`))).toContain("Max-Age=0");
    }
    if (status !== 200) expect(res.headers.has("x-middleware-next")).toBe(false);
  });
});
