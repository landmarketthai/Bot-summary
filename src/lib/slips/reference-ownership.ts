import type { SupabaseClient } from "@supabase/supabase-js";
import { bangkokBusinessDateFromTimestamp } from "@/lib/business-date";
import type { Database } from "@/types/database";

type Supabase = SupabaseClient<Database>;

/**
 * ONE money row per full transaction reference, across the AI path (slip
 * checks + approvals) and the manual path (manual slip entries + overrides).
 * Pure; the review RPCs (migration 20261102140000) enforce the same rules.
 *
 * Ownership, in order:
 *   1. The AI global winner (earliest verified check) is a candidate only when
 *      it carries a transfer amount and is not REJECTED. Wallet reads (no
 *      transfer amount) are never bank money.
 *   2. A manual entry is a candidate when its session is closed, it is not
 *      rejected, and it is approved — or it needs no review and the AI read of
 *      the same reference was not rejected (a rejected AI read means a human
 *      must decide).
 *   3. The EARLIEST candidate owns the money (AI wins a tie). A later arrival
 *      never takes money away from an earlier owner, so a finalized round's
 *      total cannot be moved by an image or entry that comes afterwards.
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
  /** Its round/day settlement was handed out (sending / sent / ambiguous). */
  finalized?: boolean;
  evidenceId?: string;
}

export interface ManualCandidate {
  id: string;
  amount: number;
  createdAt: string;
  requiresReview: boolean;
  closed: boolean;
  decision?: ReviewDecision | null;
  finalized?: boolean;
  sessionId?: string;
}

export type ManualOwnership = "counted" | "pending" | "superseded" | "rejected" | "open";

export interface ReferenceOwnership {
  /** The AI winner counts as this reference's money (still subject to the AI rules unless approved). */
  aiOwns: boolean;
  /** A live AI winner lost the reference to an earlier counted manual entry. */
  aiSupersededByManual: boolean;
  manual: Map<string, ManualOwnership>;
}

const satang = (amount: number) => Math.round(amount * 100);
const order = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) =>
  Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function resolveReferenceOwnership(
  ai: AiCandidate | null,
  manuals: readonly ManualCandidate[],
): ReferenceOwnership {
  const aiRejected = ai?.decision?.decision === "rejected";
  const aiLive = ai !== null && ai.amount !== null && !aiRejected;
  const sorted = [...manuals].sort(order);
  const isCandidate = (m: ManualCandidate) =>
    m.closed && m.decision?.decision !== "rejected"
    && (m.decision?.decision === "approved" || (!m.requiresReview && !(ai !== null && aiRejected)));
  // Containment for money already handed out: when ANY valid claim of this
  // reference sits in a finalized round/day, only finalized claims can own it.
  // A claim in an open round — however it became valid later (session close,
  // approval, a rejected owner, a late OCR completion) — never counts the same
  // transfer a second time; it is superseded (same amount) or pending.
  const validManuals = sorted.filter(isCandidate);
  const finalizedOnly = (aiLive && ai!.finalized === true) || validManuals.some((m) => m.finalized === true);
  const aiEligible = aiLive && (!finalizedOnly || ai!.finalized === true);
  const firstManual = validManuals.find((m) => !finalizedOnly || m.finalized === true) ?? null;

  const aiOwns = aiEligible && (firstManual === null || Date.parse(ai!.createdAt) <= Date.parse(firstManual.createdAt));
  const owner = aiOwns ? null : firstManual;
  const ownerAmount = aiOwns
    ? (ai!.decision?.decision === "approved" ? ai!.decision.amount : ai!.amount!)
    : owner ? (owner.decision?.decision === "approved" ? owner.decision.amount : owner.amount) : null;

  const manual = new Map<string, ManualOwnership>();
  for (const m of sorted) {
    if (!m.closed) { manual.set(m.id, "open"); continue; }
    if (m.decision?.decision === "rejected") { manual.set(m.id, "rejected"); continue; }
    if (owner?.id === m.id) { manual.set(m.id, "counted"); continue; }
    if (ownerAmount !== null) {
      const own = m.decision?.decision === "approved" ? m.decision.amount : m.amount;
      manual.set(m.id, satang(own) === satang(ownerAmount) ? "superseded" : "pending");
      continue;
    }
    manual.set(m.id, "pending"); // no owner: needs review, or its AI read was rejected
  }
  return { aiOwns, aiSupersededByManual: aiLive && !aiOwns, manual };
}

export interface ReferenceIndex {
  ai: Map<string, AiCandidate>;
  manual: Map<string, ManualCandidate[]>;
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
 * zero-width spaces an operator may paste. Matching is exact after this.
 */
export const normalizeSlipReference = (raw: string | null | undefined): string | null => {
  const t = typeof raw === "string" ? raw.replace(/[\s​‌‍﻿]+/g, "") : "";
  return t.length > 0 ? t : null;
};
const norm = normalizeSlipReference;

/**
 * Everything that can claim the money of these references, from every source,
 * market and round (ownership is global, like the AI duplicate winner).
 */
export async function loadReferenceIndex(supabase: Supabase, references: readonly string[]): Promise<ReferenceIndex> {
  const refs = [...new Set(references.map(norm).filter((r): r is string => r !== null))];
  const index: ReferenceIndex = { ai: new Map(), manual: new Map(), manualReferencesUnavailable: false };
  if (refs.length === 0) return index;

  const { data: checks, error: checkError } = await supabase
    .from("slip_checks")
    .select("id, reference_id, transfer_amount, created_at, evidence_id")
    .in("reference_id", refs)
    .in("status", ["EXTRACTED", "PARTIAL_EXTRACTED"])
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (checkError) throw new Error(`reference ownership AI lookup failed: ${checkError.message}`);
  for (const c of checks ?? []) {
    const ref = norm(c.reference_id);
    if (ref && !index.ai.has(ref)) {
      index.ai.set(ref, {
        id: c.id, createdAt: c.created_at, evidenceId: c.evidence_id,
        amount: c.transfer_amount === null ? null : Number(c.transfer_amount),
      });
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
      requiresReview: e.requires_review === true, closed: closed.has(e.session_id), sessionId: e.session_id,
      decision: manualDecisions.get(e.id) ?? null,
    });
    index.manual.set(ref, list);
  }
  await markFinalizedClaims(supabase, index);
  return index;
}

const FINALIZED_STATUSES = ["sending", "sent", "ambiguous"] as const;

async function selectWithFallback<T>(
  query: (columns: string) => PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>,
  columnSets: string[],
  what: string,
): Promise<T[]> {
  for (const columns of columnSets) {
    const { data, error } = await query(columns);
    if (!error) return (data ?? []) as T[];
    if (!isMissingSchemaObject(error)) throw new Error(`${what} failed: ${error.message}`);
  }
  return [];
}

/**
 * Marks claims whose round/day settlement was handed out (sending / sent /
 * ambiguous), only for references with competing claims — the only case the
 * containment rule needs. Scope = accountability round when bound, plus the
 * source's legacy day-level (NULL-round) settlement for the receipt day and
 * the round's business day.
 */
async function markFinalizedClaims(supabase: Supabase, index: ReferenceIndex): Promise<void> {
  const contested = [...new Set([...index.ai.keys(), ...index.manual.keys()])]
    .filter((ref) => (index.ai.has(ref) ? 1 : 0) + (index.manual.get(ref)?.length ?? 0) >= 2);
  if (contested.length === 0) return;
  const ai = contested.map((r) => index.ai.get(r)).filter((a): a is AiCandidate => a !== undefined && !!a.evidenceId);
  const manual = contested.flatMap((r) => index.manual.get(r) ?? []).filter((m) => !!m.sessionId);

  type Scope = { source: string; round: string | null; days: string[] };
  const evidences = ai.length === 0 ? [] : await selectWithFallback<{ id: string; source_id: string; accountability_round_id?: string | null; received_at: string }>(
    (cols) => supabase.from("slip_evidences").select(cols as "id").in("id", ai.map((a) => a.evidenceId!)),
    ["id, source_id, accountability_round_id, received_at", "id, source_id, received_at"], "claim evidence lookup");
  const sessions = manual.length === 0 ? [] : await selectWithFallback<{ id: string; source_id: string; business_date: string; accountability_round_id?: string | null }>(
    (cols) => supabase.from("manual_slip_sessions").select(cols as "id").in("id", manual.map((m) => m.sessionId!)),
    ["id, source_id, business_date, accountability_round_id", "id, source_id, business_date"], "claim session lookup");
  const roundIds = [...new Set(evidences.map((e) => e.accountability_round_id).filter((r): r is string => !!r))];
  const rounds = roundIds.length === 0 ? [] : await selectWithFallback<{ id: string; business_date: string }>(
    // accountability_rounds (P2E) is not in the generated types.
    (cols) => (supabase.from("accountability_rounds" as never) as unknown as ReturnType<Supabase["from"]>).select(cols as never).in("id" as never, roundIds as never),
    ["id, business_date"], "claim round lookup");
  const roundDay = new Map(rounds.map((r) => [r.id, r.business_date]));

  const scopeOfEvidence = new Map<string, Scope>(evidences.map((e) => {
    const receiptDay = bangkokBusinessDateFromTimestamp(Date.parse(e.received_at));
    const round = e.accountability_round_id ?? null;
    const days = [receiptDay, round ? roundDay.get(round) : undefined].filter((d): d is string => !!d);
    return [e.id, { source: e.source_id, round, days }];
  }));
  const scopeOfSession = new Map<string, Scope>(sessions.map((s) =>
    [s.id, { source: s.source_id, round: s.accountability_round_id ?? null, days: [s.business_date] }]));

  const sources = [...new Set([...scopeOfEvidence.values(), ...scopeOfSession.values()].map((s) => s.source))];
  const finals = sources.length === 0 ? [] : await selectWithFallback<{ source_id: string; business_date: string; accountability_round_id?: string | null }>(
    (cols) => supabase.from("settlement_finalizations").select(cols as "source_id").in("source_id", sources).in("status", FINALIZED_STATUSES),
    ["source_id, business_date, accountability_round_id", "source_id, business_date"], "claim finalization lookup");
  const finalized = (scope: Scope | undefined) => scope !== undefined && finals.some((f) =>
    (scope.round !== null && f.accountability_round_id === scope.round)
    || ((f.accountability_round_id ?? null) === null && f.source_id === scope.source && scope.days.includes(f.business_date)));

  for (const a of ai) a.finalized = finalized(scopeOfEvidence.get(a.evidenceId!));
  for (const m of manual) m.finalized = finalized(scopeOfSession.get(m.sessionId!));
}

export function ownershipFor(index: ReferenceIndex, reference: string | null | undefined): ReferenceOwnership | null {
  const ref = norm(reference);
  if (!ref) return null;
  return resolveReferenceOwnership(index.ai.get(ref) ?? null, index.manual.get(ref) ?? []);
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
