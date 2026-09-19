import { NextRequest, NextResponse } from "next/server";
import { pushLineMessage } from "@/lib/line/reply";
import { logger } from "@/lib/logger";

const TARGET_RE = /^[CUR][0-9A-Za-z]{10,}$/;
const MAX_TEXT_CODE_POINTS = 5000;

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    logger.error("admin LINE alert rejected - CRON_SECRET is missing");
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 500 });
  }

  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    logger.warn("admin LINE alert rejected - invalid authorization");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "body must be an object" }, { status: 400 });
  }

  const { target, text } = body as Record<string, unknown>;
  if (typeof target !== "string" || !TARGET_RE.test(target.trim())) {
    return NextResponse.json({ error: "invalid LINE target" }, { status: 400 });
  }
  if (typeof text !== "string" || text.trim().length === 0) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }
  if ([...text].length > MAX_TEXT_CODE_POINTS) {
    return NextResponse.json({ error: "text exceeds LINE limit" }, { status: 400 });
  }

  const normalizedTarget = target.trim();
  const normalizedText = text.trim();
  const retryKey = crypto.randomUUID();
  try {
    const result = await pushLineMessage(normalizedTarget, normalizedText, retryKey);
    logger.info("admin LINE alert sent", { target: normalizedTarget, status: result.status });
    return NextResponse.json({ ok: true, status: result.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("admin LINE alert failed", { target: normalizedTarget, error: message });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
