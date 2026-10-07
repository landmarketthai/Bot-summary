/**
 * One-time recovery planning for Produce generations that ended
 * `failed_closed` under the old blocking rules (duplicate/missing numbering,
 * unknown product, unit mismatch, return > withdrawal, unconfirmed review).
 *
 * DRY RUN ONLY. Everything here reads; nothing writes. For each failed
 * generation it rebuilds the document from the preserved ingest evidence,
 * runs today's parser and entry gate against the round's live master, and
 * checks whether the same business document is already persisted. The apply
 * step is deliberately not implemented here: it must re-enter the normal
 * finalizer as a NEW generation, so the unique business fingerprint in
 * imported_sessions remains the single duplicate guard and the original
 * failed generation stays untouched as evidence.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { parseWeighSession, getWeighSessionFinalizationErrors } from "@/lib/parsers/weigh-session/parser";
import { buildSeedFromStructuredMetadata } from "@/lib/parsers/weigh-session/seed";
import type { WeighSession } from "@/lib/parsers/weigh-session/types";
import { plainTextIngestDocument } from "@/lib/line/pending-session-finalizer";
import type { PendingSession } from "@/lib/line/pending-session-service";
import { produceIngestIdempotencyKey, type StructuredPendingSession } from "@/lib/line/produce-session-commands";
import { computeSessionHash } from "@/lib/line/session-dedup-service";
import { weighSessionCompatibilityFingerprints } from "./business-fingerprint";
import { canonicalProduceProductIdentity } from "./product-vocabulary";
import { validateProduceEntry, type RoundMasterRow } from "./entry-validation";
import { produceSectionOf } from "@/lib/summary/produce-section";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

export type RecoveryVerdict =
  /** Today's rules finalize it and no copy of it is persisted. */
  | "would_recover"
  /** The same business document (or this generation) is already persisted. */
  | "already_persisted"
  /** Still not calculable under today's rules; the reasons say why. */
  | "still_blocked"
  /** Nothing to recover: no items in the preserved evidence. */
  | "empty";

export interface RecoveryCandidate {
  sessionKey: string;
  sessionGeneration: string;
  failureReason: string | null;
  createdAt: string;
  businessDate: string | null;
  staffName: string;
  marketLabel: string | null;
  accountabilityRoundId: string | null;
  sections: string[];
  transactionTypes: string[];
  /** Names the Morning Brief would file under "other / unclassified". */
  otherProducts: string[];
  /** Set when the evidence looks wrong enough that a human should look first. */
  humanCheck: string | null;
  itemCount: number;
  /** Canonical "type|product|unit|qty|price" lines, for overlap checks between candidates. */
  itemLines: string[];
  totalBaht: number;
  verdict: RecoveryVerdict;
  reasons: string[];
  /** Non-blocking issues that would be written to data_quality_issues. */
  reconciliation: string[];
  renumberedItems: number;
  businessFingerprint: string | null;
}

/** Pure: classify one rebuilt document. */
export function classifyRecovery(input: {
  parsed: WeighSession;
  roundRows: RoundMasterRow[];
  roundBound: boolean;
  alreadyPersisted: boolean;
}): Pick<RecoveryCandidate, "verdict" | "reasons" | "reconciliation" | "renumberedItems" | "businessFingerprint" | "sections" | "transactionTypes" | "otherProducts" | "humanCheck" | "itemCount" | "itemLines" | "totalBaht"> {
  const { parsed } = input;
  const persisted: WeighSession = {
    ...parsed,
    items: parsed.items.map((item) => ({
      ...item,
      product_name: canonicalProduceProductIdentity(item.product_name, item.unit),
    })),
  };
  const sections = [...new Set(persisted.items.map((item) => produceSectionOf(item.product_name)))].sort();
  const totalBaht = Math.round(persisted.items.reduce((sum, item) => sum
    + (item.basis_quantity && item.basis_price != null
      ? (item.quantity ?? 0) * item.basis_price / item.basis_quantity
      : (item.quantity ?? 0) * item.price_per_unit), 0) * 100) / 100;
  const base = {
    sections,
    transactionTypes: [...new Set(persisted.items.map((item) => item.transaction_type))].sort(),
    otherProducts: [...new Set(persisted.items
      .filter((item) => produceSectionOf(item.product_name) === "other")
      .map((item) => item.product_name))],
    humanCheck: null as string | null,
    itemLines: persisted.items.map((item) =>
      [item.transaction_type, item.product_name, item.unit, item.quantity, item.price_per_unit].join("|")),
    itemCount: persisted.items.length,
    totalBaht,
    renumberedItems: parsed.items.filter((item) => item.original_item_number !== undefined).length,
    businessFingerprint: persisted.items.length > 0 ? computeSessionHash(persisted) : null,
  };
  const reasons = [...getWeighSessionFinalizationErrors(parsed)];
  if (parsed.items.length === 0) {
    return reasons.length > 0
      ? { ...base, verdict: "still_blocked", reasons, reconciliation: [] }
      : { ...base, verdict: "empty", reasons: ["no items in preserved evidence"], reconciliation: [] };
  }

  if (!parsed.date) reasons.push("no business date");
  const gate = validateProduceEntry({ parsed, roundRows: input.roundRows, roundBound: input.roundBound });
  reasons.push(...gate.blocking.map((exception) => exception.kind));
  reasons.push(...gate.reviews.map((review) => `${review.kind} (needs ยืนยันข้อ ${review.itemNumber})`));
  const reconciliation = gate.reconciliation.map((entry) => entry.kind);
  // Most return lines above the withdrawal usually means the withdrawal is
  // missing or the document joined the wrong round — recover only after a look.
  const returnLines = parsed.items.filter((item) => item.transaction_type !== "เบิก" && item.transaction_type !== "เบิกเพิ่ม").length;
  const excessCells = reconciliation.filter((kind) => kind === "return_exceeds_withdrawal").length;
  if (returnLines > 0 && excessCells * 2 > returnLines) {
    base.humanCheck = `${excessCells} of ${returnLines} return lines exceed the recorded withdrawal`;
  }

  if (input.alreadyPersisted) return { ...base, verdict: "already_persisted", reasons, reconciliation };
  return { ...base, verdict: reasons.length === 0 ? "would_recover" : "still_blocked", reasons, reconciliation };
}

/** Rebuild the document the finalizer would have parsed. */
async function rebuildDocument(supabase: AnyClient, row: PendingSession): Promise<WeighSession> {
  const seed = buildSeedFromStructuredMetadata(row as StructuredPendingSession);
  if (seed) return parseWeighSession(row.accumulated_text, null, null, seed);

  let query = supabase
    .from("pending_session_ingest")
    .select("line_event_id, line_timestamp_ms, raw_text")
    .eq("session_key", row.session_key)
    .eq("session_generation", row.session_generation);
  if (row.close_event_timestamp_ms != null) query = query.lte("line_timestamp_ms", row.close_event_timestamp_ms);
  const { data, error } = await query
    .order("line_timestamp_ms", { ascending: true })
    .order("line_event_id", { ascending: true });
  if (error) throw new Error(`ingest read failed: ${error.message}`);
  const ingest = (data ?? []) as Array<{ line_event_id: string; raw_text: string }>;
  const text = ingest.length > 0
    ? plainTextIngestDocument(row.plain_text_opened_line_event_id, ingest)
    : row.accumulated_text;
  return parseWeighSession(text, null);
}

async function isAlreadyPersisted(supabase: AnyClient, row: PendingSession, parsed: WeighSession): Promise<boolean> {
  const ingestKey = produceIngestIdempotencyKey(row.session_key, row.session_generation) ?? "";
  const sameGeneration = await supabase
    .from("produce_sessions")
    .select("id", { count: "exact", head: true })
    .eq("ingest_idempotency_key", ingestKey)
    .is("voided_at", null);
  if (sameGeneration.error) throw new Error(`produce_sessions read failed: ${sameGeneration.error.message}`);
  if ((sameGeneration.count ?? 0) > 0) return true;

  if (parsed.items.length === 0) return false;
  const persisted: WeighSession = {
    ...parsed,
    items: parsed.items.map((item) => ({ ...item, product_name: canonicalProduceProductIdentity(item.product_name, item.unit) })),
  };
  const hashes = [...new Set([computeSessionHash(persisted), ...weighSessionCompatibilityFingerprints(persisted), computeSessionHash(parsed)])];
  const imported = await supabase
    .from("imported_sessions")
    .select("id", { count: "exact", head: true })
    .in("session_hash", hashes);
  if (imported.error) throw new Error(`imported_sessions read failed: ${imported.error.message}`);
  return (imported.count ?? 0) > 0;
}

/**
 * Persisted rows for the same day, market, seller and transaction type. A
 * re-sent, corrected document has a different fingerprint, so this is the
 * check that catches "the operator already fixed it by sending it again".
 */
async function persistedSiblingRows(supabase: AnyClient, parsed: WeighSession): Promise<number> {
  if (!parsed.date || !parsed.session_title || parsed.items.length === 0) return 0;
  const types = [...new Set(parsed.items.map((item) => item.transaction_type))];
  const { count, error } = await supabase
    .from("produce_transactions")
    .select("id", { count: "exact", head: true })
    .eq("transaction_date", parsed.date)
    .eq("market_name", parsed.session_title)
    .eq("staff_name", parsed.staff_name)
    .in("transaction_type", types);
  if (error) throw new Error(`produce_transactions sibling read failed: ${error.message}`);
  return count ?? 0;
}

async function roundMaster(supabase: AnyClient, roundId: string | null): Promise<RoundMasterRow[]> {
  if (!roundId) return [];
  const { data, error } = await supabase
    .from("produce_transactions")
    .select("product_name, unit, quantity, price_per_unit, transaction_type")
    .eq("accountability_round_id", roundId)
    .limit(2000);
  if (error) throw new Error(`round master read failed: ${error.message}`);
  return (data ?? []) as RoundMasterRow[];
}

/** Read-only planning pass over failed generations created on/after `since`. */
/** Failures the old blocking rules caused. Inactivity expiry is not one of them. */
export const POLICY_REFUSAL_REASONS = ["close_refused_unresolved", "validation_failed"] as const;

export async function planFailedSessionRecovery(
  supabase: AnyClient,
  options: { since: string; reasons?: readonly string[] },
): Promise<{ candidates: RecoveryCandidate[]; excluded: Array<{ sessionKey: string; sessionGeneration: string; failureReason: string | null; createdAt: string }> }> {
  const { data, error } = await supabase
    .from("pending_sessions")
    .select("*")
    .eq("terminalized", true)
    .eq("finalization_status", "failed_closed")
    .gte("created_at", options.since)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`pending_sessions read failed: ${error.message}`);

  const out: RecoveryCandidate[] = [];
  const excluded: Array<{ sessionKey: string; sessionGeneration: string; failureReason: string | null; createdAt: string }> = [];
  for (const row of (data ?? []) as PendingSession[]) {
    if (row.runtime_environment != null && row.runtime_environment !== "production") continue;
    const failure = row.finalization_error && typeof row.finalization_error === "object" && !Array.isArray(row.finalization_error)
      ? String((row.finalization_error as Record<string, unknown>).reason ?? "")
      : null;
    if (options.reasons && !options.reasons.includes(failure ?? "")) {
      excluded.push({ sessionKey: row.session_key, sessionGeneration: row.session_generation, failureReason: failure, createdAt: row.created_at });
      continue;
    }

    const parsed = await rebuildDocument(supabase, row);
    const roundId = row.accountability_round_id ?? null;
    const classification = classifyRecovery({
      parsed,
      roundRows: await roundMaster(supabase, roundId),
      roundBound: roundId !== null,
      alreadyPersisted: await isAlreadyPersisted(supabase, row, parsed),
    });
    const siblings = await persistedSiblingRows(supabase, parsed);
    if (siblings > 0) {
      const note = `${siblings} persisted row(s) already exist for this date/market/seller/type — possible corrected resend`;
      classification.humanCheck = classification.humanCheck ? `${classification.humanCheck}; ${note}` : note;
    }
    out.push({
      sessionKey: row.session_key,
      sessionGeneration: row.session_generation,
      failureReason: failure,
      createdAt: row.created_at,
      businessDate: parsed.date,
      staffName: parsed.staff_name,
      marketLabel: parsed.session_title,
      accountabilityRoundId: roundId,
      ...classification,
    });
  }
  // Two failed documents for the same day+market that share most lines are
  // probably one document sent twice; recovering both would double count.
  for (const a of out) {
    for (const b of out) {
      if (a === b || a.businessDate !== b.businessDate || a.marketLabel !== b.marketLabel) continue;
      const other = new Set(b.itemLines);
      const shared = a.itemLines.filter((line) => other.has(line)).length;
      if (shared > 0) {
        const note = `shares ${shared}/${a.itemLines.length} lines with ${b.sessionGeneration}`;
        a.humanCheck = a.humanCheck ? `${a.humanCheck}; ${note}` : note;
      }
    }
  }
  return { candidates: out, excluded };
}
