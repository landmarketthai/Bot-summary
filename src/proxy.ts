import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

export async function proxy(req: NextRequest) {
  const res = NextResponse.next();
  function withCookies(response: NextResponse) {
    res.cookies.getAll().forEach(cookie => response.cookies.set(cookie));
    return response;
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll:  () => req.cookies.getAll(),
        setAll: (list) => {
          list.forEach(({ name, value, options }) => {
            req.cookies.set(name, value);
            res.cookies.set(name, value, options);
          });
        },
      },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();

  const { pathname } = req.nextUrl;

  // Already on login — let through (avoids redirect loop)
  if (pathname.startsWith("/login") || pathname.startsWith("/auth")) {
    // Redirect authenticated users away from login
    if (user) {
      return withCookies(NextResponse.redirect(new URL("/", req.url)));
    }
    return res;
  }

  // Only the LINE webhook may bypass the session guard. Exact match (not a
  // startsWith prefix) so no other current or future /api/webhook* route is
  // accidentally exempted from auth — LINE request authenticity is enforced
  // separately inside the route handler via x-line-signature verification.
  if (pathname === "/api/webhook/line") {
    return res;
  }

  // Cron endpoints use CRON_SECRET auth inside route handlers
  if (pathname.startsWith("/api/cron")) {
    return res;
  }

  // Local parser test endpoint is disabled in production by its route handler.
  if (process.env.NODE_ENV !== "production" && pathname === "/api/test-parser") {
    return res;
  }

  // All other routes require a session
  if (!user) {
    if (pathname.startsWith("/api/")) {
      return withCookies(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
    }

    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("next", pathname);
    return withCookies(NextResponse.redirect(loginUrl));
  }

  return res;
}

export const config = {
  matcher: [
    /*
     * Match every route except Next.js internals and static assets.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
