import { createServiceClient } from "@/lib/supabase/server";
import { pushLineMessage } from "@/lib/line/reply";
import { logger } from "@/lib/logger";
import { loadDailyLineAlert } from "@/lib/data-quality/daily-line-alert";
import { createDailyDataQualityAlertHandler } from "@/lib/data-quality/daily-line-alert-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createDailyDataQualityAlertHandler({
  env: () => ({
    CRON_SECRET: process.env.CRON_SECRET,
    BOT_SUMMARY_DQ_ALERT_ENABLED: process.env.BOT_SUMMARY_DQ_ALERT_ENABLED,
    BOT_SUMMARY_DQ_ALERT_TEST_GROUP_ID: process.env.BOT_SUMMARY_DQ_ALERT_TEST_GROUP_ID,
  }),
  load: (date) => loadDailyLineAlert(createServiceClient(), date),
  push: (to, text, retryKey) => pushLineMessage(to, text, retryKey),
  logError: (event) => logger.error(event),
});

// Next otherwise derives HEAD from GET; a probe must never trigger a push.
export function HEAD() {
  return new Response(null, { status: 405, headers: { "Cache-Control": "no-store" } });
}
