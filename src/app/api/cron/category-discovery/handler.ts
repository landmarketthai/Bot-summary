import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";
import { checkCronAuth } from "@/app/api/cron/finalize-slip-batches/auth";
import { bangkokBusinessDateFromTimestamp } from "@/lib/business-date";
import { requeueCategoryDeliveries, runCategoryDiscovery, type PushMessages } from "@/lib/produce/category-learning/discovery";
import { categoryReviewGroupIds } from "@/lib/produce/category-learning/review";

export interface CategoryDiscoveryDeps {
  getClient: () => SupabaseClient;
  push: PushMessages;
  now?: () => number;
}

const WINDOW_DAYS = 14;

/**
 * Scan the last WINDOW_DAYS business dates for names filed under "อื่นๆ".
 * Off the Produce ingestion and daily-close paths entirely: a failure here
 * only skips one learning run.
 */
export async function handleCategoryDiscovery(
  req: Request,
  deps: CategoryDiscoveryDeps,
): Promise<NextResponse> {
  const auth = checkCronAuth(process.env.CRON_SECRET, req.headers.get("authorization"), req.headers.get("x-cron-secret"));
  if (!auth.secretConfigured) return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 500 });
  if (!auth.authorized) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const now = deps.now?.() ?? Date.now();
  const toDate = bangkokBusinessDateFromTimestamp(now) ?? new Date(now).toISOString().slice(0, 10);
  const from = new Date(`${toDate}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - (WINDOW_DAYS - 1));
  const fromDate = from.toISOString().slice(0, 10);

  // `?requeue=blocked[&group=<id>]`: explicit recovery after the LINE token or
  // a group's permission is fixed. Only configured review groups qualify.
  const params = new URL(req.url).searchParams;
  const requeue = params.get("requeue");
  const requeueGroup = params.get("group");
  if (requeue !== null && (requeue !== "blocked"
    || (requeueGroup !== null && !categoryReviewGroupIds().has(requeueGroup)))) {
    return NextResponse.json({ ok: false, error: "invalid requeue request" }, { status: 400 });
  }

  try {
    const client = deps.getClient();
    const requeued = requeue === null ? undefined : await requeueCategoryDeliveries(client, requeueGroup);
    const result = await runCategoryDiscovery(client, { fromDate, toDate }, deps.push);
    logger.info("category discovery finished", { fromDate, toDate, requeued, ...result });
    return NextResponse.json({ ok: true, fromDate, toDate, requeued, ...result });
  } catch (error) {
    logger.error("category discovery failed", { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ ok: false, error: "category discovery failed" }, { status: 500 });
  }
}
