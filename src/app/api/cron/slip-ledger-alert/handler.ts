import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { checkCronAuth } from "@/app/api/cron/finalize-slip-batches/auth";
import { deadlineFetch, withTimeout } from "@/lib/slips/io-timeout";
import {
  SLIP_LEDGER_ALERT_PUSH_TIMEOUT_MS,
  buildSlipLedgerAlertMessage,
  claimSlipLedgerAlert,
  classifySlipLedgerAlertPushError,
  completeSlipLedgerAlert,
  defaultSlipLedgerAlertPush,
  isValidLineAlertTarget,
  readSlipLedgerAlertHealth,
  slipLedgerAlertRecipientKey,
  slipLedgerAlertRetrySeconds,
  type SlipLedgerAlertClient,
  type SlipLedgerAlertPush,
} from "@/lib/slips/ledger-health-alert";

export const SLIP_LEDGER_ALERT_ROUTE_BUDGET_MS = 25_000;

export interface SlipLedgerAlertHandlerDeps {
  getClient?: (deadlineMs: number) => SlipLedgerAlertClient;
  push?: SlipLedgerAlertPush;
  now?: () => number;
  /** Test seam; Production always uses SLIP_LEDGER_ALERT_PUSH_TIMEOUT_MS. */
  pushTimeoutMs?: number;
}

export async function handleSlipLedgerAlert(
  req: NextRequest,
  deps: SlipLedgerAlertHandlerDeps = {},
): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const auth = checkCronAuth(
    secret,
    req.headers.get("authorization"),
    req.headers.get("x-cron-secret"),
  );
  if (!auth.secretConfigured) {
    logger.error("slip ledger alert rejected - CRON_SECRET is missing");
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 500 });
  }
  if (!auth.authorized) {
    logger.warn("slip ledger alert rejected - invalid authorization");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Exact opt-in only. The recipient is separate and has no Production
  // fallback, so this route cannot accidentally reuse another alert target.
  if (process.env.SLIP_LEDGER_ALERT_ENABLED !== "true") {
    logger.info("slip ledger alert disabled", { enabled: false });
    return NextResponse.json({ ok: true, mode: "disabled", sent: false });
  }

  const target = process.env.SLIP_LEDGER_ALERT_LINE_TARGET?.trim() ?? "";
  if (target && !isValidLineAlertTarget(target)) {
    logger.error("slip ledger alert misconfigured", {
      enabled: true,
      recipientConfigured: true,
      reason: "invalid_recipient",
    });
    return NextResponse.json(
      { ok: false, mode: "misconfigured", sent: false, error: "invalid LINE target" },
      { status: 500 },
    );
  }
  if (target && !process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim()) {
    logger.error("slip ledger alert misconfigured", {
      enabled: true,
      recipientConfigured: true,
      reason: "missing_line_token",
    });
    return NextResponse.json(
      { ok: false, mode: "misconfigured", sent: false, error: "LINE token is not configured" },
      { status: 500 },
    );
  }

  const startedAt = (deps.now ?? Date.now)();
  const deadlineMs = startedAt + SLIP_LEDGER_ALERT_ROUTE_BUDGET_MS;
  const client = deps.getClient?.(deadlineMs)
    ?? createServiceClient({ fetch: deadlineFetch(deadlineMs, 5_000) });

  // An intentionally empty recipient is log-only dry-run. It reads health but
  // never claims durable delivery state, so enabling a recipient later cannot
  // be suppressed by an earlier dry-run.
  if (!target) {
    const { health, errorCode } = await readSlipLedgerAlertHealth(client);
    if (!health) {
      logger.error("slip ledger alert dry-run health unavailable", {
        mode: "dry_run",
        errorCode,
      });
      return NextResponse.json(
        { ok: false, mode: "dry_run", sent: false, error: "health unavailable", errorCode },
        { status: 503 },
      );
    }
    logger.warn("slip ledger alert dry-run", { mode: "dry_run", sent: false, health });
    return NextResponse.json({ ok: true, mode: "dry_run", sent: false, health });
  }

  const recipientKey = slipLedgerAlertRecipientKey(target);
  const { claim, errorCode } = await claimSlipLedgerAlert(client, recipientKey);
  if (!claim) {
    // Missing migration, timeouts and malformed replies all fail closed. Do
    // not fall back to a log-only send path because it would have no dedupe.
    logger.error("slip ledger alert claim unavailable", { errorCode, sent: false });
    return NextResponse.json(
      { ok: false, mode: "active", sent: false, error: "alert claim unavailable", errorCode },
      { status: 503 },
    );
  }
  if (!claim.claimed) {
    logger.info("slip ledger alert no delivery due", {
      reason: claim.reason ?? "not_due",
      unhealthy: claim.health.unhealthy,
      sent: false,
    });
    return NextResponse.json({
      ok: true,
      mode: "active",
      sent: false,
      reason: claim.reason ?? "not_due",
      health: claim.health,
    });
  }

  // A recovery is less urgent than avoiding a false all-clear. Verify the
  // latest durable health again immediately before the outbound attempt.
  // If health changed or cannot be read, keep the lease to be reconciled by
  // the next scheduler tick; never emit an unverified OK message.
  if (claim.kind === "recovery") {
    const latest = await readSlipLedgerAlertHealth(client);
    if (!latest.health || latest.health.unhealthy) {
      logger.warn("slip ledger alert recovery withheld after health recheck", {
        reason: latest.health ? "unhealthy_again" : "health_unavailable",
        errorCode: latest.errorCode,
        sent: false,
      });
      return NextResponse.json(
        { ok: false, mode: "active", sent: false, reason: "recovery_not_safe" },
        { status: 503 },
      );
    }
  }

  const push = deps.push ?? defaultSlipLedgerAlertPush;
  let pushError: unknown = null;
  try {
    const remainingMs = Math.min(
      deps.pushTimeoutMs ?? SLIP_LEDGER_ALERT_PUSH_TIMEOUT_MS,
      deadlineMs - (deps.now ?? Date.now)(),
    );
    if (remainingMs <= 0) throw new Error("route_deadline");
    await withTimeout("slip_ledger_alert_push", remainingMs, (signal) =>
      push(target, buildSlipLedgerAlertMessage(claim), claim.retry_key!, signal),
    );
  } catch (error) {
    pushError = error;
  }

  if (pushError === null) {
    const completed = await completeSlipLedgerAlert(
      client, recipientKey, claim.lease_token!, true, null, null,
    );
    if (!completed) {
      // Delivery may already have succeeded. Leave the sending lease intact;
      // the next claim reuses the stable LINE retry key and receives 409 if so.
      logger.error("slip ledger alert delivery completion unavailable", {
        kind: claim.kind,
        sent: "unknown",
      });
      return NextResponse.json(
        { ok: false, mode: "active", sent: "unknown", error: "completion unavailable" },
        { status: 503 },
      );
    }
    logger.info("slip ledger alert delivered", { kind: claim.kind, sent: true });
    return NextResponse.json({ ok: true, mode: "active", sent: true, kind: claim.kind });
  }

  const failure = classifySlipLedgerAlertPushError(pushError);
  const retrySeconds = slipLedgerAlertRetrySeconds(claim.attempt!, failure.retryAfterMs);
  const released = await completeSlipLedgerAlert(
    client, recipientKey, claim.lease_token!, false, retrySeconds, failure.code,
  );
  logger.error("slip ledger alert delivery failed", {
    kind: claim.kind,
    sent: false,
    errorCode: failure.code,
    retrySeconds,
    released,
  });
  return NextResponse.json(
    {
      ok: false,
      mode: "active",
      sent: false,
      retryScheduled: released,
      retrySeconds,
      error: "LINE delivery failed",
    },
    { status: 502 },
  );
}
