/**
 * Missing-return guard — what actually happened to a round's ชั่งคืน.
 *
 * Production 2026-08-10 held four different situations that every report
 * flattened into the same silence ("no return rows, so it sold out"):
 *
 *   ต้อม / พาชิโอ้ทุเรียน   no return was ever sent
 *   ขวัญ / ราชพฤกษ์         a return document was open and never closed
 *   มิ้น / ทรัพย์พัน2       a return WAS sent and P4A refused it (typos, quantity)
 *   ดำ  / ทุ่งลานนา         a return landed normally
 *
 * The first is a legitimate sold-out day. The middle two are incomplete data
 * and must never be presented as a confident sale. The evidence separating them
 * already exists and is durable — `pending_sessions` keeps the unfinalized
 * document, its finalization status and its accountability round — it was
 * simply never read per round.
 *
 * This module owns that classification and nothing else. It computes no money,
 * changes no sold-out arithmetic, and writes nothing.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { RE } from "@/lib/parsers/weigh-session/regex";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import { normalizedMarketLabel } from "@/lib/market";
import { baseTransactionType, transactionBucket } from "@/lib/summary/transactions";
import { transactionKindFromText } from "./failure-lifecycle-source";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

/**
 * `persisted` a good or damaged return actually landed for this round.
 * `blocked`   a return document was closed and refused (P4A, parser, invariant).
 * `pending`   a return document exists and has not been closed yet.
 * `none`      no return evidence of any kind — the legitimate sold-out case.
 */
export type RoundReturnState = "persisted" | "blocked" | "pending" | "none";

/** One round's withdrawal side, from persisted transactions plus round identity. */
export interface RoundWithdrawal {
  accountabilityRoundId: string;
  /** Canonical LINE source and date used only for safety attribution. */
  sourceId?: string | null;
  businessDate?: string | null;
  sellerLabel: string;
  /** The ROUND's canonical market label — never a transaction's raw label. */
  marketLabel: string;
  withdrawalItemCount: number;
  hasPersistedReturn: boolean;
}

/** One unfinalized produce document, already attributed to a round. */
export interface RoundReturnEvidence {
  accountabilityRoundId: string;
  /** pending_sessions.finalization_status ('pending' | 'processing' | 'failed_closed'). */
  finalizationStatus: string | null;
  /** The operator DID try to close: a closer line, or a recorded close request. */
  closeAttempted: boolean;
}

export interface RoundReturnStatus extends RoundWithdrawal {
  state: RoundReturnState;
}

/**
 * Pending finalization states that account for the produce. Same contract as
 * the Sales loader's RESOLVED_PENDING_STATUSES — 'finalized' created the
 * session, 'duplicate' proved one already existed. Everything else is a
 * document that never landed.
 */
export const RESOLVED_PENDING_STATUSES: ReadonlySet<string> = new Set([
  "finalized",
  "duplicate",
  // 20260829090000: an inactivity-expired draft that accepted zero items is
  // not incomplete business — nothing was ever entered. failed_closed (the
  // >=1-item expiry outcome) is deliberately NOT here: that draft DID accept
  // real content and must stay an action-required blocker.
  "expired_empty_draft",
]);

/** True when a produce document carries a closer line (จบรายการ…). */
export function hasCloserLine(text: string | null | undefined): boolean {
  if (!text) return false;
  return text
    .normalize("NFC")
    .split("\n")
    .some((line) => RE.SESSION_END.test(line.trim()));
}

/**
 * The pure rule. Persisted evidence always wins; among unfinalized documents a
 * closed-and-refused one outranks a still-open one, because "you sent it and it
 * was rejected" is the more actionable message.
 */
export function classifyRoundReturns(
  rounds: readonly RoundWithdrawal[],
  evidence: readonly RoundReturnEvidence[],
): RoundReturnStatus[] {
  const byRound = new Map<string, RoundReturnEvidence[]>();
  for (const item of evidence) {
    const list = byRound.get(item.accountabilityRoundId) ?? [];
    list.push(item);
    byRound.set(item.accountabilityRoundId, list);
  }

  return rounds.map((round) => {
    if (round.hasPersistedReturn) return { ...round, state: "persisted" as const };
    const found = byRound.get(round.accountabilityRoundId) ?? [];
    if (found.length === 0) return { ...round, state: "none" as const };
    const blocked = found.some(
      (item) => item.closeAttempted || item.finalizationStatus === "failed_closed",
    );
    return { ...round, state: blocked ? ("blocked" as const) : ("pending" as const) };
  });
}

/** Rounds whose return evidence is incomplete — never confidently sold out. */
export function roundsWithIncompleteReturn(
  statuses: readonly RoundReturnStatus[],
): Set<string> {
  return new Set(
    statuses
      .filter((row) => row.state === "blocked" || row.state === "pending")
      .map((row) => row.accountabilityRoundId),
  );
}

/** Rounds that already have a persisted ชั่งคืน / คืนเสีย document. */
export function roundsWithPersistedReturn(
  statuses: readonly RoundReturnStatus[],
): Set<string> {
  return new Set(
    statuses
      .filter((row) => row.state === "persisted")
      .map((row) => row.accountabilityRoundId),
  );
}

interface ProduceRow {
  accountability_round_id: string | null;
  transaction_type: string;
}

interface RoundRow {
  id: string;
  source_id: string | null;
  business_date: string | null;
  seller_label: string | null;
  market_label: string | null;
}

interface PendingRow {
  accountability_round_id: string | null;
  finalization_status: string | null;
  declared_transaction_type: string | null;
  accumulated_text: string | null;
  close_requested_at: string | null;
  source_id: string | null;
  business_date: string | null;
  staff_label: string | null;
  market_label: string | null;
}

/**
 * P0 safety attribution for an unbound failed return. This is a REPORT-ONLY
 * guard, not an accounting-round binding or reconciliation. Matching requires
 * four explicit business dimensions: LINE source, business date, seller and
 * canonical market. A missing dimension is never a wildcard. More than one
 * matching round remains ambiguous: protect every candidate, but choose none.
 */
export interface UnboundReturnIdentity {
  sourceId: string | null;
  businessDate: string | null;
  sellerLabel: string | null;
  marketLabel: string | null;
}

function exactIdentity(value: string | null | undefined): string | null {
  const text = value?.normalize("NFC").replace(/\s+/g, " ").trim() ?? "";
  return text || null;
}

export function protectiveUnboundReturnRoundIds(
  rounds: readonly (RoundRow & { id: string })[],
  attempts: readonly UnboundReturnIdentity[],
): Set<string> {
  const blocked = new Set<string>();
  for (const attempt of attempts) {
    const source = exactIdentity(attempt.sourceId);
    const date = exactIdentity(attempt.businessDate);
    const seller = exactIdentity(attempt.sellerLabel);
    const market = normalizedMarketLabel(attempt.marketLabel);
    if (!source || !date || !seller || !market) continue;

    for (const round of rounds) {
      if (
        exactIdentity(round.source_id) === source
        && exactIdentity(round.business_date) === date
        && exactIdentity(round.seller_label) === seller
        && normalizedMarketLabel(round.market_label) === market
      ) blocked.add(round.id);
    }
  }
  return blocked;
}

/** Unknown stays fail-closed; a proven withdrawal cannot be return evidence. */
export function pendingRowCanBeReturn(
  declaredTransactionType: string | null,
  accumulatedText: string | null,
): boolean {
  const kind = (declaredTransactionType
    ? baseTransactionType(declaredTransactionType)
    : null) ?? transactionKindFromText(accumulatedText);
  return kind !== "เบิก";
}

const CHUNK = 200;
const PAGE = 1000;

function chunks<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    out.push(values.slice(offset, offset + size));
  }
  return out;
}

/**
 * Load and classify every round that issued produce on this business date.
 *
 * Read-only. Rounds are the unit because a round is the only stable identity a
 * withdrawal and its return share — the raw market labels on the two documents
 * are exactly what drifted in Production.
 *
 * `accountability_rounds` and `pending_sessions` are operational tables outside
 * the generated Database types, so both reads use a loosened client, the same
 * way the Sales loader reads pending_sessions.
 */
export async function loadRoundReturnStatuses(
  supabase: AnyClient,
  businessDate: string,
  /** Optional lifecycle-filtered unbound attempts; avoids reviving superseded failures. */
  activeUnboundAttempts?: readonly UnboundReturnIdentity[],
): Promise<RoundReturnStatus[]> {
  // Paged: a busy business date exceeds PostgREST's default 1000-row ceiling,
  // and a short read here would classify a returned round as never returned.
  const produce: ProduceRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from("produce_transactions")
      .select("accountability_round_id, transaction_type")
      .eq("transaction_date", businessDate)
      .not("accountability_round_id", "is", null)
      .order("id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`round return produce query failed: ${error.message}`);
    const page = (data ?? []) as ProduceRow[];
    produce.push(...page);
    if (page.length < PAGE) break;
  }

  const withdrawals = new Map<string, number>();
  const returned = new Set<string>();
  for (const row of produce) {
    const roundId = row.accountability_round_id;
    if (!roundId) continue;
    const bucket = transactionBucket(row.transaction_type);
    if (bucket === "เบิก") withdrawals.set(roundId, (withdrawals.get(roundId) ?? 0) + 1);
    else if (bucket) returned.add(roundId);
  }

  const roundIds = [...withdrawals.keys()];
  if (roundIds.length === 0) return [];

  const identities = new Map<string, RoundRow>();
  for (const chunk of chunks(roundIds, CHUNK)) {
    const { data, error } = await supabase
      .from("accountability_rounds")
      .select("id, source_id, business_date, seller_label, market_label")
      .in("id", chunk);
    if (error) throw new Error(`accountability round lookup failed: ${error.message}`);
    for (const row of (data ?? []) as RoundRow[]) identities.set(row.id, row);
  }

  const evidence: RoundReturnEvidence[] = [];
  for (const chunk of chunks(roundIds, CHUNK)) {
    const { data, error } = await supabase
      .from("pending_sessions")
      .select(
        "accountability_round_id, finalization_status, declared_transaction_type, accumulated_text, close_requested_at",
      )
      .in("accountability_round_id", chunk);
    if (error) throw new Error(`pending session round lookup failed: ${error.message}`);
    for (const row of (data ?? []) as PendingRow[]) {
      if (!row.accountability_round_id) continue;
      // Client-side authority, exactly as the Sales loader does: a status the
      // server filter did not anticipate must count as unresolved, not vanish.
      if (RESOLVED_PENDING_STATUSES.has(row.finalization_status ?? "pending")) continue;
      if (!pendingRowCanBeReturn(row.declared_transaction_type, row.accumulated_text)) continue;
      evidence.push({
        accountabilityRoundId: row.accountability_round_id,
        finalizationStatus: row.finalization_status,
        closeAttempted:
          Boolean(row.close_requested_at) || hasCloserLine(row.accumulated_text),
      });
    }
  }

  // P0: a refused plain-text return may have failed BEFORE bindPlainTextRound.
  // That is precisely the missing evidence which used to turn into "none".
  // Read only unbound operational records, then attribute through the round's
  // full business identity. Do not mutate pending_sessions or guess a round.
  const unboundAttempts: UnboundReturnIdentity[] = activeUnboundAttempts
    ? [...activeUnboundAttempts]
    : [];
  if (!activeUnboundAttempts) {
    for (let offset = 0; offset < 50 * PAGE; offset += PAGE) {
      const { data, error } = await supabase
        .from("pending_sessions")
        .select(
          "accountability_round_id, finalization_status, declared_transaction_type, accumulated_text, close_requested_at, source_id, business_date, staff_label, market_label",
        )
        .is("accountability_round_id", null)
        // Fetch a superset of unresolved documents; client filter below is final.
        .or(`finalization_status.is.null,finalization_status.not.in.(${[...RESOLVED_PENDING_STATUSES].join(",")})`)
        .order("id", { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) throw new Error(`unbound pending return lookup failed: ${error.message}`);
      const page = (data ?? []) as PendingRow[];
      for (const row of page) {
        if (row.accountability_round_id !== null) continue;
        if (RESOLVED_PENDING_STATUSES.has(row.finalization_status ?? "pending")) continue;
        if (!pendingRowCanBeReturn(row.declared_transaction_type, row.accumulated_text)) continue;
        const parsed = row.accumulated_text ? parseWeighSession(row.accumulated_text) : null;
        // Never use insertion time to invent a date across the 04:00 cutoff.
        // A contradictory explicit header and structured business date is not
        // proof of this particular round.
        if (row.business_date && parsed?.date && row.business_date !== parsed.date) continue;
        const claimedDate = row.business_date ?? parsed?.date ?? null;
        if (claimedDate !== businessDate) continue;
        unboundAttempts.push({
          sourceId: row.source_id,
          businessDate: claimedDate,
          sellerLabel: row.staff_label ?? parsed?.staff_name ?? null,
          marketLabel: row.market_label ?? parsed?.session_title ?? null,
        });
      }
      if (page.length < PAGE) break;
      if (offset + PAGE >= 50 * PAGE) {
        throw new Error("unbound pending return scan exceeded safe page limit");
      }
    }
  }
  const blockedUnboundRounds = protectiveUnboundReturnRoundIds(
    [...identities.values()], unboundAttempts,
  );
  for (const id of blockedUnboundRounds) {
    evidence.push({
      accountabilityRoundId: id,
      finalizationStatus: "failed_closed",
      closeAttempted: true,
    });
  }

  const rounds: RoundWithdrawal[] = roundIds.map((id) => {
    const identity = identities.get(id);
    return {
      accountabilityRoundId: id,
      sourceId: identity?.source_id ?? null,
      businessDate: identity?.business_date ?? null,
      sellerLabel: (identity?.seller_label ?? "").trim(),
      marketLabel: (identity?.market_label ?? "").trim(),
      withdrawalItemCount: withdrawals.get(id) ?? 0,
      hasPersistedReturn: returned.has(id),
    };
  });

  return classifyRoundReturns(rounds, evidence);
}
