import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LinePushError, pushLineMessage } from "@/lib/line/reply";
import { isIoTimeout, withTimeout } from "@/lib/slips/io-timeout";

export const SLIP_LEDGER_ALERT_STALE_SECONDS = 36 * 60;
export const SLIP_LEDGER_ALERT_OCR_OVERDUE_SECONDS = 36 * 60;
export const SLIP_LEDGER_ALERT_REALERT_SECONDS = 6 * 60 * 60;
export const SLIP_LEDGER_ALERT_LEASE_SECONDS = 60;
export const SLIP_LEDGER_ALERT_DB_TIMEOUT_MS = 5_000;
export const SLIP_LEDGER_ALERT_PUSH_TIMEOUT_MS = 8_000;

type RpcError = { code?: string; message?: string } | null;
type RpcResult = { data: unknown; error: RpcError };

// The alert table is deliberately not part of the broad generated database
// surface. All mutations cross these service-role RPCs.
export interface SlipLedgerAlertClient {
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<RpcResult>;
}

export type SlipLedgerAlertHealth = {
  version: number;
  unhealthy: boolean;
  stale_threshold_seconds: number;
  ocr_overdue_threshold_seconds: number;
  unbound_total: number;
  unbound_stale: number;
  received_stale: number;
  ingesting_stale: number;
  retry_pending_total: number;
  retry_stale: number;
  queue_dead: number;
  failed_permanent_24h: number;
  late_after_finalize_24h: number;
  ocr_missing_overdue: number;
  ocr_processing_overdue: number;
  oldest_open_age_seconds: number | null;
};

export type SlipLedgerAlertClaim = {
  claimed: boolean;
  reason?: string;
  kind?: "incident" | "recovery";
  retry_key?: string;
  lease_token?: string;
  attempt?: number;
  incident_sequence?: number;
  incident_started_at?: string | null;
  health: SlipLedgerAlertHealth;
};

export type SlipLedgerAlertPush = (
  target: string,
  text: string,
  retryKey: string,
  signal: AbortSignal,
) => Promise<unknown>;

export const defaultSlipLedgerAlertPush: SlipLedgerAlertPush =
  (target, text, retryKey, signal) => pushLineMessage(target, text, retryKey, { signal });

export function slipLedgerAlertRecipientKey(target: string): string {
  return createHash("sha256").update(target, "utf8").digest("hex");
}

export function isValidLineAlertTarget(value: string): boolean {
  // LINE user/group/room IDs are the type prefix plus a 128-bit hex id.
  // Reject broad "looks identifier-ish" values before any outbound request.
  return /^[CUR][0-9a-f]{32}$/i.test(value);
}

function nonNegativeInteger(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export function parseSlipLedgerAlertHealth(value: unknown): SlipLedgerAlertHealth | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.unhealthy !== "boolean") return null;
  const numericKeys = [
    "version",
    "stale_threshold_seconds",
    "ocr_overdue_threshold_seconds",
    "unbound_total",
    "unbound_stale",
    "received_stale",
    "ingesting_stale",
    "retry_pending_total",
    "retry_stale",
    "queue_dead",
    "failed_permanent_24h",
    "late_after_finalize_24h",
    "ocr_missing_overdue",
    "ocr_processing_overdue",
  ] as const;
  const parsed = Object.fromEntries(
    numericKeys.map((key) => [key, nonNegativeInteger(row[key])]),
  ) as Record<(typeof numericKeys)[number], number | null>;
  if (Object.values(parsed).some((field) => field === null)) return null;

  const version = parsed.version!;
  const staleThreshold = parsed.stale_threshold_seconds!;
  const ocrThreshold = parsed.ocr_overdue_threshold_seconds!;
  const actionable = parsed.unbound_stale! + parsed.received_stale!
    + parsed.ingesting_stale! + parsed.retry_stale! + parsed.queue_dead!
    + parsed.failed_permanent_24h! + parsed.late_after_finalize_24h!
    + parsed.ocr_missing_overdue! + parsed.ocr_processing_overdue!;
  if (
    version !== 1
    || staleThreshold < SLIP_LEDGER_ALERT_STALE_SECONDS
    || ocrThreshold < SLIP_LEDGER_ALERT_OCR_OVERDUE_SECONDS
    || row.unhealthy !== (actionable > 0)
  ) return null;

  const oldest = row.oldest_open_age_seconds === null
    ? null
    : nonNegativeInteger(row.oldest_open_age_seconds);
  if (oldest === null && row.oldest_open_age_seconds !== null) return null;

  return {
    version,
    unhealthy: row.unhealthy,
    stale_threshold_seconds: staleThreshold,
    ocr_overdue_threshold_seconds: ocrThreshold,
    unbound_total: parsed.unbound_total!,
    unbound_stale: parsed.unbound_stale!,
    received_stale: parsed.received_stale!,
    ingesting_stale: parsed.ingesting_stale!,
    retry_pending_total: parsed.retry_pending_total!,
    retry_stale: parsed.retry_stale!,
    queue_dead: parsed.queue_dead!,
    failed_permanent_24h: parsed.failed_permanent_24h!,
    late_after_finalize_24h: parsed.late_after_finalize_24h!,
    ocr_missing_overdue: parsed.ocr_missing_overdue!,
    ocr_processing_overdue: parsed.ocr_processing_overdue!,
    oldest_open_age_seconds: oldest,
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function boundedRpc(
  client: SlipLedgerAlertClient,
  name: string,
  args: Record<string, unknown>,
): Promise<RpcResult> {
  return withTimeout("slip_ledger_alert_rpc", SLIP_LEDGER_ALERT_DB_TIMEOUT_MS, async () =>
    Promise.resolve(client.rpc(name, args)),
  );
}

export async function readSlipLedgerAlertHealth(
  client: SlipLedgerAlertClient,
): Promise<{ health: SlipLedgerAlertHealth | null; errorCode: string | null }> {
  try {
    const result = await boundedRpc(client, "slip_ingest_alert_health", {
      p_stale_seconds: SLIP_LEDGER_ALERT_STALE_SECONDS,
      p_ocr_overdue_seconds: SLIP_LEDGER_ALERT_OCR_OVERDUE_SECONDS,
    });
    if (result.error) return { health: null, errorCode: result.error.code ?? "rpc_error" };
    return { health: parseSlipLedgerAlertHealth(result.data), errorCode: null };
  } catch (error) {
    return { health: null, errorCode: error instanceof Error ? error.name : "rpc_exception" };
  }
}

export async function claimSlipLedgerAlert(
  client: SlipLedgerAlertClient,
  recipientKey: string,
): Promise<{ claim: SlipLedgerAlertClaim | null; errorCode: string | null }> {
  try {
    const result = await boundedRpc(client, "claim_slip_ingest_health_alert", {
      p_recipient_key: recipientKey,
      p_stale_seconds: SLIP_LEDGER_ALERT_STALE_SECONDS,
      p_ocr_overdue_seconds: SLIP_LEDGER_ALERT_OCR_OVERDUE_SECONDS,
      p_realert_seconds: SLIP_LEDGER_ALERT_REALERT_SECONDS,
      p_lease_seconds: SLIP_LEDGER_ALERT_LEASE_SECONDS,
    });
    if (result.error) return { claim: null, errorCode: result.error.code ?? "rpc_error" };
    if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
      return { claim: null, errorCode: "malformed_claim" };
    }
    const raw = result.data as Record<string, unknown>;
    const health = parseSlipLedgerAlertHealth(raw.health);
    if (typeof raw.claimed !== "boolean" || !health) {
      return { claim: null, errorCode: "malformed_claim" };
    }
    const attempt = nonNegativeInteger(raw.attempt);
    const incidentSequence = nonNegativeInteger(raw.incident_sequence);
    const claim: SlipLedgerAlertClaim = {
      claimed: raw.claimed,
      reason: typeof raw.reason === "string" ? raw.reason : undefined,
      kind: raw.kind === "incident" || raw.kind === "recovery" ? raw.kind : undefined,
      retry_key: typeof raw.retry_key === "string" ? raw.retry_key : undefined,
      lease_token: typeof raw.lease_token === "string" ? raw.lease_token : undefined,
      attempt: attempt ?? undefined,
      incident_sequence: incidentSequence ?? undefined,
      incident_started_at: typeof raw.incident_started_at === "string" ? raw.incident_started_at : null,
      health,
    };
    if (
      claim.claimed
      && (
        !claim.kind
        || !claim.retry_key
        || !UUID_PATTERN.test(claim.retry_key)
        || !claim.lease_token
        || !UUID_PATTERN.test(claim.lease_token)
        || !claim.attempt
        || !claim.incident_sequence
      )
    ) {
      return { claim: null, errorCode: "malformed_claim" };
    }
    return { claim, errorCode: null };
  } catch (error) {
    return { claim: null, errorCode: error instanceof Error ? error.name : "rpc_exception" };
  }
}

export async function completeSlipLedgerAlert(
  client: SlipLedgerAlertClient,
  recipientKey: string,
  leaseToken: string,
  success: boolean,
  retryAfterSeconds: number | null,
  errorCode: string | null,
): Promise<boolean> {
  try {
    const result = await boundedRpc(client, "complete_slip_ingest_health_alert", {
      p_recipient_key: recipientKey,
      p_lease_token: leaseToken,
      p_success: success,
      p_retry_after_seconds: retryAfterSeconds,
      p_error_code: errorCode,
    });
    return !result.error && result.data === true;
  } catch {
    return false;
  }
}

export function slipLedgerAlertRetrySeconds(attempt: number, retryAfterMs: number | null): number {
  const exponential = Math.min(60 * (2 ** Math.max(0, attempt - 1)), 30 * 60);
  return Math.max(exponential, Math.ceil((retryAfterMs ?? 0) / 1_000));
}

export function classifySlipLedgerAlertPushError(error: unknown): {
  code: string;
  retryAfterMs: number | null;
} {
  if (isIoTimeout(error)) return { code: "line_timeout", retryAfterMs: null };
  if (error instanceof LinePushError) {
    const code = error.httpStatus === 429
      ? "line_rate_limit"
      : error.httpStatus === null
        ? "line_network"
        : error.httpStatus >= 500
          ? "line_upstream"
          : "line_rejected";
    return { code, retryAfterMs: error.retryAfterMs };
  }
  return { code: "line_unknown", retryAfterMs: null };
}

function formatAge(seconds: number | null): string {
  if (seconds === null) return "-";
  if (seconds < 60) return `${seconds} วินาที`;
  return `${Math.floor(seconds / 60)} นาที`;
}

export function buildSlipLedgerAlertMessage(claim: SlipLedgerAlertClaim): string {
  const h = claim.health;
  if (claim.kind === "recovery") {
    return [
      "✅ Slip ingest กลับสู่ภาวะปกติ",
      `Incident #${claim.incident_sequence ?? "-"}`,
      "ตรวจล่าสุดไม่พบ receipt/retry/OCR ที่เกิน 36 นาที และไม่พบ terminal loss ที่ยังอยู่ในช่วงเฝ้าระวัง",
    ].join("\n");
  }

  return [
    "🚨 Slip ingest ต้องตรวจสอบ",
    `Incident #${claim.incident_sequence ?? "-"} · oldest ${formatAge(h.oldest_open_age_seconds)}`,
    `ค้างเกิน 36 นาที: unbound ${h.unbound_stale}, received ${h.received_stale}, ingesting ${h.ingesting_stale}, retry ${h.retry_stale}`,
    `สูญเสีย/ล้มเหลว: queue-dead ${h.queue_dead}, permanent ${h.failed_permanent_24h}, late ${h.late_after_finalize_24h}`,
    `OCR เกิน 36 นาที: missing ${h.ocr_missing_overdue}, processing ${h.ocr_processing_overdue}`,
    "Action: ตรวจ finalize-slip-batches/recovery logs, queue+ledger row และ provider health; ห้ามสรุป batch ว่าครบจนเคลียร์รายการค้าง",
  ].join("\n");
}

export type GenericSupabaseClient = SupabaseClient<never>;
