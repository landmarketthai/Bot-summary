import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Cross-instance Gemini request permits, backed by the
 * acquire_ai_provider_permit() RPC (migration 20261107090000).
 *
 * Callers take ONE permit before EVERY Gemini HTTP attempt, retries included.
 * Any limiter failure fails CLOSED: the caller must not call Gemini and should
 * fall back to its secondary provider.
 */

export class GeminiQuotaUnavailableError extends Error {
  constructor(
    readonly reason: "rpm" | "rpd" | "limiter_error",
    message?: string,
  ) {
    super(message ?? `Gemini quota unavailable: ${reason}`);
    this.name = "GeminiQuotaUnavailableError";
  }
}

/** budgetMs: caller's remaining time; the permit never waits past it. */
export type GeminiRequestPermit = (budgetMs?: number) => Promise<void>;

const PROVIDER = "gemini";
// Below the 15 RPM / 500 RPD free-tier caps: fixed-minute windows can admit up
// to 2x RPM across a minute boundary, and other users may share the key.
const DEFAULTS = { rpm: 12, rpd: 450, maxWaitMs: 20_000 };
const MAX_JITTER_MS = 250;

function intEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function readGeminiRateLimitConfig(
  env: Record<string, string | undefined> = process.env,
): { rpm: number; rpd: number; maxWaitMs: number } {
  return {
    rpm: intEnv(env.GEMINI_SLIP_RPM_LIMIT, DEFAULTS.rpm, 1, 15),
    rpd: intEnv(env.GEMINI_SLIP_RPD_LIMIT, DEFAULTS.rpd, 1, 500),
    maxWaitMs: intEnv(env.GEMINI_SLIP_PERMIT_MAX_WAIT_MS, DEFAULTS.maxWaitMs, 0, 60_000),
  };
}

type PermitResult = { granted: true } | { granted: false; reason: "rpm" | "rpd"; retryAfterMs: number };

function parsePermit(data: unknown): PermitResult | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const { granted, reason, retry_after_ms: retry } = data as Record<string, unknown>;
  if (granted === true && reason === "ok") return { granted: true };
  if (granted !== false || (reason !== "rpm" && reason !== "rpd")) return null;
  if (typeof retry !== "number" || !Number.isFinite(retry) || retry < 0) return null;
  return { granted: false, reason, retryAfterMs: retry };
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createGeminiRequestPermit(
  supabase: SupabaseClient,
  options: {
    rpm?: number;
    rpd?: number;
    maxWaitMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): GeminiRequestPermit {
  const config = readGeminiRateLimitConfig();
  const rpm = options.rpm ?? config.rpm;
  const rpd = options.rpd ?? config.rpd;
  const maxWaitMs = options.maxWaitMs ?? config.maxWaitMs;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;

  return async (budgetMs?: number) => {
    const deadline = now() + Math.min(maxWaitMs, budgetMs ?? maxWaitMs);
    for (;;) {
      let result: PermitResult | null;
      try {
        const { data, error } = await supabase.rpc("acquire_ai_provider_permit", {
          p_provider: PROVIDER,
          p_rpm: rpm,
          p_rpd: rpd,
        });
        if (error) {
          throw new GeminiQuotaUnavailableError("limiter_error", `Gemini rate limiter RPC failed: ${error.message}`);
        }
        result = parsePermit(data);
      } catch (error) {
        if (error instanceof GeminiQuotaUnavailableError) throw error;
        throw new GeminiQuotaUnavailableError(
          "limiter_error",
          `Gemini rate limiter RPC failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!result) throw new GeminiQuotaUnavailableError("limiter_error", "Gemini rate limiter returned a malformed permit");
      if (result.granted) return;
      if (result.reason === "rpd") throw new GeminiQuotaUnavailableError("rpd", "Gemini daily request quota exhausted");

      // Jitter de-synchronizes lanes that were all denied in the same minute.
      const waitMs = result.retryAfterMs + Math.floor(Math.random() * MAX_JITTER_MS);
      if (now() + waitMs > deadline) {
        throw new GeminiQuotaUnavailableError("rpm", "Gemini per-minute request quota exhausted");
      }
      await sleep(waitMs);
    }
  };
}
