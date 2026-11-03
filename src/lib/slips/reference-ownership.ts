import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type Supabase = SupabaseClient<Database>;

/**
 * ONE money row per full transaction reference, across the AI path (slip
 * checks + approvals) and the manual path (manual slip entries + overrides).
 *
 * A CREDITED reference (slip_reference_claims, written by the settlement
 * finalizer — docs/slip-reference-claims.md) counts only for its claimed AI
 * check or manual entry, at the claimed amount, whatever happens afterwards.
 * Every other claim of it is superseded (same amount) or pending.
 *
 * An uncredited reference follows the preview rule (pure):
 *   1. The AI global winner (earliest verified check) is a candidate only when
 *      it carries a transfer amount and is not REJECTED. Wallet reads (no
 *      transfer amount) are never bank money.
 *   2. A manual entry is a candidate when its session is closed, it is not
 *      rejected, and it is approved — or it needs no review and the AI read of
 *      the same reference was not rejected (a rejected AI read means a human
 *      must decide).
 *   3. The EARLIEST candidate owns the money (AI wins a tie).
 *   4. Every other manual entry of the reference: same amount as the owner →
 *      superseded (not counted); different amount → pending (a conflict a
 *      human resolves; never silently reconciled). With no owner, an entry
 *      that needs review, or whose AI read was rejected, is pending.
 * Matching is by the full normalized reference only — never amount, date or
 * a partial reference.
 */
export type ReviewDecision = { decision: "approved"; amount: number } | { decision: "rejected" };

export interface AiCandidate {
  id: string;
  /** transfer_amount; null for wallet reads. */
  amount: number | null;
  createdAt: string;
  decision?: ReviewDecision | null;
}

export interface ManualCandidate {
  id: string;
  amount: number;
  createdAt: string;
  requiresReview: boolean;
  closed: boolean;
  decision?: ReviewDecision | null;
}

/** A persisted credit: one finalization credited this reference to one target. */
export interface ReferenceCredit {
  finalizationId: string;
  /** The crediting finalization's scope; a credit counts only there. Absent = unknown (never counted). */
  scope?: { sourceId: string; businessDate: string; round: string | null };
  slipCheckId: string | null;
  manualEntryId: string | null;
  amount: number;
}

export type ManualOwnership = "counted" | "pending" | "superseded" | "rejected" | "open";

export interface ReferenceOwnership {
  /** The AI winner counts as this reference's money (still subject to the AI rules unless approved). */
  aiOwns: boolean;
  /** A live AI winner lost the reference to an earlier counted manual entry. */
  aiSupersededByManual: boolean;
  manual: Map<string, ManualOwnership>;
  /** Set when the reference is credited: the only money row, at this amount. */
  credit?: ReferenceCredit;
}

const satang = (amount: number) => Math.round(amount * 100);
const order = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) =>
  Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function resolveReferenceOwnership(
  ai: AiCandidate | null,
  manuals: readonly ManualCandidate[],
  credit?: ReferenceCredit | null,
): ReferenceOwnership {
  const aiRejected = ai?.decision?.decision === "rejected";
  const aiLive = ai !== null && ai.amount !== null && !aiRejected;
  const sorted = [...manuals].sort(order);
  const own = (m: ManualCandidate) => (m.decision?.decision === "approved" ? m.decision.amount : m.amount);

  if (credit) {
    const manual = new Map<string, ManualOwnership>();
    for (const m of sorted) {
      manual.set(m.id, m.id === credit.manualEntryId ? "counted"
        : !m.closed ? "open"
        : m.decision?.decision === "rejected" ? "rejected"
        : satang(own(m)) === satang(credit.amount) ? "superseded" : "pending");
    }
    const aiOwns = ai !== null && ai.id === credit.slipCheckId;
    return { aiOwns, aiSupersededByManual: aiLive && !aiOwns, manual, credit };
  }

  const isCandidate = (m: ManualCandidate) =>
    m.closed && m.decision?.decision !== "rejected"
    && (m.decision?.decision === "approved" || (!m.requiresReview && !(ai !== null && aiRejected)));
  const firstManual = sorted.find(isCandidate) ?? null;
  const aiOwns = aiLive && (firstManual === null || Date.parse(ai!.createdAt) <= Date.parse(firstManual.createdAt));
  const owner = aiOwns ? null : firstManual;
  const ownerAmount = aiOwns
    ? (ai!.decision?.decision === "approved" ? ai!.decision.amount : ai!.amount!)
    : owner ? own(owner) : null;

  const manual = new Map<string, ManualOwnership>();
  for (const m of sorted) {
    if (!m.closed) { manual.set(m.id, "open"); continue; }
    if (m.decision?.decision === "rejected") { manual.set(m.id, "rejected"); continue; }
    if (owner?.id === m.id) { manual.set(m.id, "counted"); continue; }
    if (ownerAmount !== null) {
      manual.set(m.id, satang(own(m)) === satang(ownerAmount) ? "superseded" : "pending");
      continue;
    }
    manual.set(m.id, "pending"); // no owner: needs review, or its AI read was rejected
  }
  return { aiOwns, aiSupersededByManual: aiLive && !aiOwns, manual };
}

export interface ReferenceIndex {
  ai: Map<string, AiCandidate>;
  manual: Map<string, ManualCandidate[]>;
  credits: Map<string, ReferenceCredit>;
  /** The schema predates manual references: every manual entry is unreferenced. */
  manualReferencesUnavailable: boolean;
}

/** PostgREST / Postgres "relation or column does not exist" (migration not applied). */
export function isMissingSchemaObject(error: { code?: string }): boolean {
  return error.code === "42P01" || error.code === "42703" || error.code === "PGRST204" || error.code === "PGRST205";
}

/**
 * The one reference normalizer for ownership: every whitespace character is
 * removed (as parseSlipExtraction does for AI reads), including no-break and
 * zero-width spaces an operator may paste. Matching is exact after this. The
 * SQL normalize_slip_reference (20261102160000) removes the same characters.
 */
export const normalizeSlipReference = (raw: string | null | undefined): string | null => {
  const t = typeof raw === "string" ? raw.replace(/[\s​-‍﻿]+/g, "") : "";
  return t.length > 0 ? t : null;
};
const norm = normalizeSlipReference;

/** Persisted credits of these references; none before migration 20261103100000. */
export async function loadReferenceCredits(supabase: Supabase, refs: readonly string[]): Promise<Map<string, ReferenceCredit>> {
  const credits = new Map<string, ReferenceCredit>();
  if (refs.length === 0) return credits;
  // slip_reference_claims (20261103100000) is not in the generated types.
  const { data, error } = await (supabase.from("slip_reference_claims" as never) as unknown as ReturnType<Supabase["from"]>)
    .select("reference_id, finalization_id, slip_check_id, manual_entry_id, amount" as never)
    .in("reference_id" as never, refs as never);
  if (error) {
    if (isMissingSchemaObject(error)) return credits;
    throw new Error(`slip reference credit lookup failed: ${error.message}`);
  }
  const rows = (data ?? []) as unknown as Array<{ reference_id: string; finalization_id: string; slip_check_id: string | null; manual_entry_id: string | null; amount: number | string }>;
  const scopes = new Map<string, NonNullable<ReferenceCredit["scope"]>>();
  const finalizationIds = [...new Set(rows.map((row) => row.finalization_id))];
  if (finalizationIds.length > 0) {
    const { data: finals, error: finalError } = await supabase.from("settlement_finalizations")
      .select("id, source_id, business_date, accountability_round_id")
      .in("id", finalizationIds);
    if (finalError) throw new Error(`slip reference credit scope lookup failed: ${finalError.message}`);
    for (const f of finals ?? []) {
      scopes.set(f.id, { sourceId: f.source_id, businessDate: f.business_date, round: f.accountability_round_id ?? null });
    }
  }
  for (const row of rows) {
    credits.set(row.reference_id, {
      finalizationId: row.finalization_id, scope: scopes.get(row.finalization_id),
      slipCheckId: row.slip_check_id, manualEntryId: row.manual_entry_id, amount: Number(row.amount),
    });
  }
  return credits;
}

/**
 * Everything that can claim the money of these references, from every source,
 * market and round (ownership is global, like the AI duplicate winner).
 */
export async function loadReferenceIndex(supabase: Supabase, references: readonly string[]): Promise<ReferenceIndex> {
  const refs = [...new Set(references.map(norm).filter((r): r is string => r !== null))];
  const index: ReferenceIndex = { ai: new Map(), manual: new Map(), credits: new Map(), manualReferencesUnavailable: false };
  if (refs.length === 0) return index;
  index.credits = await loadReferenceCredits(supabase, refs);

  const { data: checks, error: checkError } = await supabase
    .from("slip_checks")
    .select("id, reference_id, transfer_amount, created_at")
    .in("reference_id", refs)
    .in("status", ["EXTRACTED", "PARTIAL_EXTRACTED"])
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (checkError) throw new Error(`reference ownership AI lookup failed: ${checkError.message}`);
  for (const c of checks ?? []) {
    const ref = norm(c.reference_id);
    if (ref && !index.ai.has(ref)) {
      index.ai.set(ref, { id: c.id, createdAt: c.created_at, amount: c.transfer_amount === null ? null : Number(c.transfer_amount) });
    }
  }

  let entries: Array<{ id: string; reference_id: string | null; amount: number; created_at: string; requires_review?: boolean; session_id: string }> = [];
  for (const columns of ["id, reference_id, amount, created_at, requires_review, session_id", "id, reference_id, amount, created_at, session_id"]) {
    const { data, error } = await supabase.from("manual_slip_entries")
      .select(columns as "id, reference_id, amount, created_at, requires_review, session_id")
      .in("reference_id", refs);
    if (!error) { entries = (data ?? []) as typeof entries; break; }
    if (!isMissingSchemaObject(error)) throw new Error(`reference ownership manual lookup failed: ${error.message}`);
    if (columns.endsWith(", session_id") && !columns.includes("requires_review")) index.manualReferencesUnavailable = true;
  }
  entries = index.manualReferencesUnavailable ? [] : entries.filter((e) => norm(e.reference_id) !== null);

  const sessionIds = [...new Set(entries.map((e) => e.session_id))];
  const closed = new Set<string>();
  if (sessionIds.length > 0) {
    const { data, error } = await supabase.from("manual_slip_sessions").select("id, status").in("id", sessionIds);
    if (error) throw new Error(`reference ownership session lookup failed: ${error.message}`);
    for (const s of data ?? []) if (s.status === "closed") closed.add(s.id);
  }

  const aiDecisions = await loadActiveDecisions(supabase, "slip_check_id", [...index.ai.values()].map((a) => a.id));
  for (const a of index.ai.values()) a.decision = aiDecisions.get(a.id) ?? null;
  const manualDecisions = await loadActiveDecisions(supabase, "manual_entry_id", entries.map((e) => e.id));
  for (const e of entries) {
    const ref = norm(e.reference_id);
    if (!ref) continue;
    const list = index.manual.get(ref) ?? [];
    list.push({
      id: e.id, amount: Number(e.amount), createdAt: e.created_at,
      requiresReview: e.requires_review === true, closed: closed.has(e.session_id),
      decision: manualDecisions.get(e.id) ?? null,
    });
    index.manual.set(ref, list);
  }
  return index;
}

export function ownershipFor(index: ReferenceIndex, reference: string | null | undefined): ReferenceOwnership | null {
  const ref = norm(reference);
  if (!ref) return null;
  return resolveReferenceOwnership(index.ai.get(ref) ?? null, index.manual.get(ref) ?? [], index.credits.get(ref));
}

/**
 * Active decisions (slip_check_approvals) keyed by AI check or manual entry.
 * None before the migrations: an absent table (20261102120000) or column
 * (manual_entry_id, 20261102130000) means no decision can exist.
 */
export async function loadActiveDecisions(
  supabase: Supabase,
  target: "slip_check_id" | "manual_entry_id",
  ids: string[],
): Promise<Map<string, ReviewDecision>> {
  const decisions = new Map<string, ReviewDecision>();
  if (ids.length === 0) return decisions;
  const { data, error } = await supabase.from("slip_check_approvals")
    .select(`${target}, decision, approved_amount` as "slip_check_id, manual_entry_id, decision, approved_amount")
    .in(target, ids)
    .eq("status", "active");
  if (error) {
    if (isMissingSchemaObject(error)) return decisions;
    throw new Error(`slip review query failed: ${error.message}`);
  }
  for (const row of data ?? []) {
    const key = row[target];
    if (!key) continue;
    decisions.set(key, row.decision === "approved"
      ? { decision: "approved", amount: Number(row.approved_amount) }
      : { decision: "rejected" });
  }
  return decisions;
}
