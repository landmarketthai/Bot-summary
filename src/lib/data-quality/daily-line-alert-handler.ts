import { createHash, timingSafeEqual } from "node:crypto";
import type { PushResult } from "@/lib/line/reply";
import { dailyAlertDate, type DailyLineAlert } from "./daily-line-alert";

interface AlertEnv {
  CRON_SECRET?: string;
  BOT_SUMMARY_DQ_ALERT_ENABLED?: string;
  BOT_SUMMARY_DQ_ALERT_TEST_GROUP_ID?: string;
}
interface Dependencies {
  env: () => AlertEnv;
  load: (date: string) => Promise<DailyLineAlert>;
  push: (to: string, text: string, retryKey: string) => Promise<PushResult>;
  logError: (event: string) => void;
  now?: () => number;
}

/** No revision/content component: editing a report must not mint another delivery key. */
export function dailyDataQualityRetryKey(date: string, target: string): string {
  const bytes = createHash("sha256").update(`daily-data-quality-alert:${date}:${target}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createDailyDataQualityAlertHandler(deps: Dependencies) {
  return async (req: Request): Promise<Response> => {
    const json = (body: object, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
    const env = deps.env();
    if (!env.CRON_SECRET) return json({ ok: false, sent: false, error: "auth_not_configured" }, 500);
    const expected = Buffer.from(`Bearer ${env.CRON_SECRET}`);
    const actual = Buffer.from(req.headers.get("authorization") ?? "");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return json({ ok: false, sent: false, error: "unauthorized" }, 401);
    }
    if (req.method !== "GET") return json({ ok: false, sent: false, error: "method_not_allowed" }, 405);
    const params = new URL(req.url).searchParams;
    if ([...params.keys()].some((key) => !["date", "debug"].includes(key) || params.getAll(key).length !== 1)
      || (params.has("debug") && !["0", "1"].includes(params.get("debug")!))) {
      return json({ ok: false, sent: false, error: "invalid_query" }, 400);
    }
    let date: string;
    try { date = dailyAlertDate(params.get("date"), deps.now?.()); }
    catch { return json({ ok: false, sent: false, error: "invalid_date" }, 400); }
    const debug = params.get("debug") === "1";
    const target = env.BOT_SUMMARY_DQ_ALERT_TEST_GROUP_ID;
    const active = env.BOT_SUMMARY_DQ_ALERT_ENABLED === "true" && !!target && /^C[0-9a-f]{32}$/.test(target);
    if (!debug && !active) return json({ ok: true, status: "inactive", sent: false, businessDate: date });
    let alert: DailyLineAlert;
    try { alert = await deps.load(date); }
    catch {
      deps.logError("daily_data_quality_alert_read_failed");
      return json({ ok: false, sent: false, error: "data_unavailable" }, 500);
    }
    if (debug) return json({ ok: true, status: "preview", previewOnly: true, sent: false, ...alert });
    try {
      const result = await deps.push(target!, alert.text, dailyDataQualityRetryKey(date, target!));
      return json({ ok: true, status: result.status, sent: true, businessDate: date });
    } catch {
      deps.logError("daily_data_quality_alert_push_failed");
      return json({ ok: false, error: "line_push_failed", sent: false, deliveryUnknown: true }, 502);
    }
  };
}
