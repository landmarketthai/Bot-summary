/**
 * Database side of the produce failure lifecycle.
 *
 * Everything here is read-only and date-scoped. The pure rules live in
 * ./failure-lifecycle; this module only turns Production rows into the shapes
 * those rules accept, so the classification stays testable without a database.
 *
 * Two adapters are exported separately from the loaders because the Sales
 * loader already holds the pending/raw-message candidate rows it scanned — it
 * adapts them here rather than reading them a second time.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import { normalizedMarketLabel } from "@/lib/market";
import { baseTransactionType, type TransactionBucket } from "@/lib/summary/transactions";
import {
  classifyProduceFailure,
  classifyProduceFailures,
  type FinalizedProduceOutcome,
  type ProduceFailureAttempt,
  type ProduceFailureClassification,
} from "./failure-lifecycle";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

const PAGE = 1000;
const CHUNK = 500;

function chunks<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    out.push(values.slice(offset, offset + size));
  }
  return out;
}

/**
 * The single transaction kind a document carries, or null.
 *
 * Null is not a shrug — it is "this document declares more than one kind, so
 * no single-kind replacement can be proven for it". The lifecycle rules then
 * keep the attempt active, which is the correct fail-closed answer.
 */
export function singleTransactionKind(
  types: readonly string[],
): TransactionBucket | null {
  const kinds = new Set<TransactionBucket>();
  for (const type of types) {
    const bucket = baseTransactionType(type);
    if (!bucket) return null; // an unknown type is not a provable identity
    kinds.add(bucket);
  }
  return kinds.size === 1 ? [...kinds][0] : null;
}

/** The transaction kind a produce document's raw text declares. */
export function transactionKindFromText(text: string | null | undefined): TransactionBucket | null {
  if (!text || !text.trim()) return null;
  const parsed = parseWeighSession(text);
  if (parsed.declared_transaction_type) return parsed.declared_transaction_type;
  // A document whose every item line failed is still what its header names.
  if (parsed.items.length === 0) return parsed.header_transaction_type ?? null;
  return singleTransactionKind(parsed.items.map((item) => item.transaction_type));
}

export interface PendingFailureRow {
  id: string;
  accumulated_text?: string | null;
  business_date?: string | null;
  source_id?: string | null;
  staff_label?: string | null;
  market_label?: string | null;
  declared_transaction_type?: string | null;
  accountability_round_id?: string | null;
}

/**
 * A pending session that never finalized, as a lifecycle attempt.
 *
 * Structured (guided-menu) sessions carry their identity in columns; plain-text
 * ones carry it only in the accumulated text, so the parsed header is the
 * fallback for each field independently — a structured session missing one
 * column must not lose the others.
 */
export function pendingFailureAttempt(
  row: PendingFailureRow,
  attemptedAtMs: number | null,
  businessDate: string | null,
): ProduceFailureAttempt {
  const parsed = row.accumulated_text ? parseWeighSession(row.accumulated_text) : null;
  return {
    attemptId: row.id,
    origin: "pending_session",
    businessDate: row.business_date ?? businessDate,
    sourceId: row.source_id ?? null,
    staffLabel: row.staff_label ?? parsed?.staff_name ?? null,
    marketLabel:
      normalizedMarketLabel(row.market_label ?? parsed?.session_title ?? null) || null,
    transactionKind:
      (row.declared_transaction_type
        ? baseTransactionType(row.declared_transaction_type)
        : null) ?? transactionKindFromText(row.accumulated_text),
    accountabilityRoundId: row.accountability_round_id ?? null,
    attemptedAtMs,
    sourceText: row.accumulated_text ?? null,
  };
}

/**
 * A complete produce message that was understood and then never landed.
 *
 * It has no round and no columns — every identity dimension comes from the text
 * itself, which is exactly why the identity path demands all of them.
 */
export function rawMessageFailureAttempt(
  row: { id: string; raw_text: string | null; source_id: string | null },
  attemptedAtMs: number | null,
  businessDate: string | null,
): ProduceFailureAttempt {
  const parsed = row.raw_text ? parseWeighSession(row.raw_text) : null;
  return {
    attemptId: `raw:${row.id}`,
    origin: "raw_message",
    businessDate: parsed?.date ?? businessDate,
    sourceId: row.source_id,
    staffLabel: parsed?.staff_name || null,
    marketLabel: normalizedMarketLabel(parsed?.session_title ?? null) || null,
    transactionKind: transactionKindFromText(row.raw_text),
    accountabilityRoundId: null,
    attemptedAtMs,
    sourceText: row.raw_text,
  };
}

interface SessionRow {
  id: string;
  staff_name: string | null;
  session_title: string | null;
  session_date: string | null;
  session_kind: string | null;
  accountability_round_id: string | null;
  raw_message_id: string | null;
  voided_at: string | null;
  finalized_at: string | null;
  created_at: string | null;
}

function timestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Every produce document that LANDED on this business date — the candidate
 * replacements.
 *
 * Voided sessions are excluded: a voided session is not a successful outcome,
 * and letting one excuse a failure would hide the very correction that voiding
 * is meant to force.
 *
 * The transaction kind comes from the session's persisted rows rather than a
 * declared column, because a main session declares nothing — its kind is what
 * it actually recorded.
 */
export async function loadFinalizedProduceOutcomes(
  supabase: AnyClient,
  businessDate: string,
): Promise<FinalizedProduceOutcome[]> {
  const { data, error } = await supabase
    .from("produce_sessions")
    .select(
      "id, staff_name, session_title, session_date, session_kind, accountability_round_id, raw_message_id, voided_at, finalized_at, created_at",
    )
    .eq("session_date", businessDate)
    .is("voided_at", null);
  if (error) throw new Error(`finalized produce session lookup failed: ${error.message}`);

  const sessions = (data ?? []) as SessionRow[];
  if (sessions.length === 0) return [];

  const kinds = await sessionTransactionKinds(supabase, businessDate);
  const sources = await sessionSourceIds(
    supabase,
    sessions.map((row) => row.raw_message_id).filter((id): id is string => Boolean(id)),
  );

  return sessions.map((session) => ({
    produceSessionId: session.id,
    businessDate: session.session_date,
    sourceId: session.raw_message_id ? sources.get(session.raw_message_id) ?? null : null,
    staffLabel: session.staff_name,
    marketLabel: normalizedMarketLabel(session.session_title) || null,
    transactionKind: kinds.get(session.id) ?? null,
    accountabilityRoundId: session.accountability_round_id,
    sessionKind: session.session_kind,
    voidedAtMs: timestampMs(session.voided_at),
    finalizedAtMs: timestampMs(session.finalized_at) ?? timestampMs(session.created_at),
  }));
}

/** The single base transaction type each session of the date persisted. */
async function sessionTransactionKinds(
  supabase: AnyClient,
  businessDate: string,
): Promise<Map<string, TransactionBucket | null>> {
  const types = new Map<string, string[]>();

  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from("produce_transactions")
      .select("session_id, transaction_type")
      .eq("transaction_date", businessDate)
      .order("id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`produce session kind lookup failed: ${error.message}`);

    const page = (data ?? []) as Array<{ session_id: string; transaction_type: string }>;
    for (const row of page) {
      const list = types.get(row.session_id) ?? [];
      list.push(row.transaction_type);
      types.set(row.session_id, list);
    }
    if (page.length < PAGE) break;
  }

  const kinds = new Map<string, TransactionBucket | null>();
  for (const [sessionId, list] of types) kinds.set(sessionId, singleTransactionKind(list));
  return kinds;
}

async function sessionSourceIds(
  supabase: AnyClient,
  rawMessageIds: readonly string[],
): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  const unique = [...new Set(rawMessageIds)];

  for (const chunk of chunks(unique, CHUNK)) {
    const { data, error } = await supabase
      .from("raw_messages")
      .select("id, source_id")
      .in("id", chunk);
    if (error) throw new Error(`produce session source lookup failed: ${error.message}`);
    for (const row of (data ?? []) as Array<{ id: string; source_id: string | null }>) {
      if (row.source_id) sources.set(row.id, row.source_id);
    }
  }

  return sources;
}

/**
 * Accountability rounds an authorized workflow retired.
 *
 * NOT date-scoped: a failed attempt may be bound to a round opened on a
 * different business date than the one being reported, and the retirement is a
 * fact about the round, not about the day.
 */
export async function loadCancelledRoundIds(supabase: AnyClient): Promise<Set<string>> {
  const cancelled = new Set<string>();

  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from("accountability_rounds")
      .select("id")
      .eq("status", "cancelled")
      .order("id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`cancelled round lookup failed: ${error.message}`);

    const page = (data ?? []) as Array<{ id: string }>;
    for (const row of page) cancelled.add(row.id);
    if (page.length < PAGE) break;
  }

  return cancelled;
}

export interface ProduceFailureEvidence {
  outcomes: FinalizedProduceOutcome[];
  cancelledRoundIds: Set<string>;
}

/** Both halves of the lifecycle context in one call. */
export async function loadProduceFailureEvidence(
  supabase: AnyClient,
  businessDate: string,
): Promise<ProduceFailureEvidence> {
  const [outcomes, cancelledRoundIds] = await Promise.all([
    loadFinalizedProduceOutcomes(supabase, businessDate),
    loadCancelledRoundIds(supabase),
  ]);
  return { outcomes, cancelledRoundIds };
}

/**
 * The lifecycle verdict, with the P0-D cutoff rule: an attempt that may belong
 * to the adjacent business day (alternateBusinessDate) is also superseded by a
 * replacement on the EARLIER of the two days — a dated resend of yesterday's
 * late return. Never by the later day: that day's ordinary return is a
 * different document and must not clear yesterday's failure. The other day's
 * landed documents are read only when such an attempt is still active.
 */
export async function classifyProduceFailuresAcrossCutoff(
  supabase: AnyClient,
  attempts: readonly ProduceFailureAttempt[],
  evidence: {
    outcomes: readonly FinalizedProduceOutcome[];
    cancelledRoundIds: ReadonlySet<string>;
  },
): Promise<ProduceFailureClassification[]> {
  const context = { cancelledRoundIds: evidence.cancelledRoundIds };
  const classifications = classifyProduceFailures(attempts, evidence.outcomes, context);
  const otherDays = new Map<string, FinalizedProduceOutcome[]>();
  for (const [index, attempt] of attempts.entries()) {
    const day = attempt.alternateBusinessDate;
    if (!day || !attempt.businessDate || day >= attempt.businessDate) continue;
    if (classifications[index].state !== "active_failed") continue;
    if (!otherDays.has(day)) otherDays.set(day, await loadFinalizedProduceOutcomes(supabase, day));
    const other = classifyProduceFailure({ ...attempt, businessDate: day }, otherDays.get(day)!, context);
    if (other.state === "superseded") classifications[index] = other;
  }
  return classifications;
}
