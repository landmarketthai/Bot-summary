import type { SupabaseClient } from "@supabase/supabase-js";
import { bangkokBusinessDateFromTimestamp } from "@/lib/business-date";
import type { Database, SlipCheckStatus } from "@/types/database";

type Supabase = SupabaseClient<Database>;

export const VERIFIED_SLIP_CHECK_STATUSES = [
  "EXTRACTED",
  "PARTIAL_EXTRACTED",
] as const satisfies readonly SlipCheckStatus[];

export function isVerifiedSlipCheckStatus(
  status: SlipCheckStatus | null | undefined,
): status is (typeof VERIFIED_SLIP_CHECK_STATUSES)[number] {
  return VERIFIED_SLIP_CHECK_STATUSES.some((verifiedStatus) => verifiedStatus === status);
}

// Supabase/PostgREST `.in()` filters have a practical URL-length limit; chunk
// the reference id list the same way load.ts chunks raw_message_id lookups
// (see SOURCE_LOOKUP_CHUNK_SIZE in src/lib/white-sheet/load.ts) rather than
// sending one unbounded query.
const REFERENCE_LOOKUP_CHUNK_SIZE = 500;

function chunkReferenceIds<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

export type SlipDuplicateResult =
  | {
      status: "unique";
      transactionId: string;
    }
  | {
      status: "duplicate_same_source";
      transactionId: string;
      originalRecordId: string;
      originalMarketLabel?: string;
      originalBusinessDate?: string;
    }
  | {
      status: "duplicate_cross_source";
      transactionId: string;
      originalRecordId: string;
      originalMarketLabel?: string;
      originalBusinessDate?: string;
    }
  | {
      status: "missing_transaction_id";
    };

export interface SlipDuplicateLookupParams {
  rawTransactionId: string | null;
  sourceId: string;
  excludeCheckId?: string;
}

/**
 * Trims surrounding whitespace only. Case and punctuation are preserved
 * exactly as the extractor returned them — the provider contract does not
 * establish case-insensitivity, so normalizing further would risk merging
 * two genuinely different reference numbers.
 */
export function normalizeTransactionId(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Best-effort duplicate lookup for a verified-slip transaction id.
 *
 * ponytail: this is a query-before-write check, not an atomic claim — no
 * database unique constraint backs reference_id yet (slip_checks has none,
 * see schema gap report), so two verifications racing on the same
 * transaction id can both pass this lookup and both get accepted. Add a
 * partial unique index on slip_checks(reference_id) once the gap is closed,
 * then move this check inside an insert-on-conflict flow for true
 * concurrency safety.
 */
export async function findSlipTransactionDuplicate(
  supabase: Supabase,
  params: SlipDuplicateLookupParams,
): Promise<SlipDuplicateResult> {
  const transactionId = normalizeTransactionId(params.rawTransactionId);
  if (!transactionId) return { status: "missing_transaction_id" };

  const { data: checks, error } = await supabase
    .from("slip_checks")
    .select("id, evidence_id, created_at")
    .eq("reference_id", transactionId)
    .in("status", VERIFIED_SLIP_CHECK_STATUSES)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw new Error(`slip transaction duplicate lookup failed: ${error.message}`);

  const original = (checks ?? []).find((row) => row.id !== params.excludeCheckId);
  if (!original) return { status: "unique", transactionId };

  const { data: evidence, error: evidenceError } = await supabase
    .from("slip_evidences")
    .select("source_id, received_at, batch_id")
    .eq("id", original.evidence_id)
    .maybeSingle();

  if (evidenceError || !evidence?.source_id) {
    throw new Error("slip transaction original source unavailable");
  }

  let originalMarketLabel: string | undefined;
  if (evidence?.batch_id) {
    const { data: batch, error: batchError } = await supabase
      .from("slip_batches")
      .select("market_name")
      .eq("id", evidence.batch_id)
      .maybeSingle();
    originalMarketLabel = !batchError ? batch?.market_name?.trim() || undefined : undefined;
  }

  const originalBusinessDate = evidence?.received_at
    ? bangkokBusinessDateFromTimestamp(Date.parse(evidence.received_at)) ?? undefined
    : undefined;

  const sameSource = evidence?.source_id != null && evidence.source_id === params.sourceId;

  return {
    status: sameSource ? "duplicate_same_source" : "duplicate_cross_source",
    transactionId,
    originalRecordId: original.id,
    originalMarketLabel,
    originalBusinessDate,
  };
}

/**
 * Resolves, for a batch of candidate reference ids, which slip_checks row is
 * the globally-earliest accepted record for each id — across every source
 * and business date, not just the caller's scope.
 *
 * ponytail: batched queries (chunked, see REFERENCE_LOOKUP_CHUNK_SIZE) rather
 * than one lookup per reference id. Still a read-then-decide check, not an
 * atomic claim (same caveat as findSlipTransactionDuplicate above).
 *
 * Chunking safety: the input reference id list — not the result rows — is
 * partitioned into disjoint chunks, so every row for a given reference id
 * always comes back from exactly one chunk's query. Each chunk query keeps
 * the same ORDER BY (created_at, id) as before chunking, so the earliest
 * accepted row per reference id is still resolved correctly; chunks are
 * combined in a fixed, deterministic order (the order distinctReferenceIds
 * was chunked in) so re-running against unchanged data always yields the
 * same winners. Failure is not silently partial: any per-chunk query error
 * propagates immediately, and the fail-closed "incomplete resolution" check
 * runs once against the full merged result across every chunk.
 */
export async function resolveGloballyAcceptedCheckIds(
  supabase: Supabase,
  referenceIds: string[],
): Promise<Set<string>> {
  const winners = await resolveGloballyAcceptedChecks(supabase, referenceIds);
  return new Set([...winners.values()].map((row) => row.id));
}

export async function resolveGloballyAcceptedChecks(
  supabase: Supabase,
  referenceIds: string[],
  requireAll = true,
): Promise<Map<string, { id: string; evidence_id: string }>> {
  if (referenceIds.length === 0) return new Map();

  const distinctReferenceIds = [...new Set(referenceIds)];
  const winners = new Map<string, { id: string; evidence_id: string }>();

  for (const chunk of chunkReferenceIds(distinctReferenceIds, REFERENCE_LOOKUP_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from("slip_checks")
      .select("id, reference_id, created_at, evidence_id")
      .in("reference_id", chunk)
      .in("status", VERIFIED_SLIP_CHECK_STATUSES)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });

    if (error) throw new Error(`global reference resolution failed: ${error.message}`);

    for (const row of data ?? []) {
      if (!row.reference_id) continue;
      if (!winners.has(row.reference_id)) winners.set(row.reference_id, row);
    }
  }

  const unresolvedCount = distinctReferenceIds.filter(
    (referenceId) => !winners.has(referenceId),
  ).length;
  if (requireAll && unresolvedCount > 0) {
    throw new Error(
      `global reference resolution incomplete for ${unresolvedCount} reference id(s)`,
    );
  }

  return winners;
}
