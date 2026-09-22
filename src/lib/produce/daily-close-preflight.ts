/**
 * Daily Close Preflight — can business date YYYY-MM-DD be reported cleanly?
 *
 * One deterministic answer, computed once, consumed by the 08:00 stock report,
 * the 08:10 sales report and the operator's own `ตรวจความพร้อม` command. Before
 * this existed each of those re-derived "unresolved" for itself, which is how
 * the three drifted apart and how a corrected-and-resent document kept being
 * announced as a missing one.
 *
 * The builder below is PURE. Every fact it judges is passed in, already loaded
 * and already classified, so the whole readiness contract is unit-testable
 * without a database. `loadDailyClosePreflight` is the only part that reads
 * Production, and it reuses the deployed loaders rather than re-querying:
 *
 *   loadRoundReturnStatuses          which rounds got their ชั่งคืน
 *   loadProduceFailureEvidence       what landed, and which rounds were retired
 *
 * It writes nothing, repairs nothing and never chooses a price, a round or a
 * replacement on the operator's behalf.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";
import { isQaMarketLabel } from "@/lib/sales/qa-scopes";
import { canonicalMarketLabel, normalizedMarketLabel } from "@/lib/market";
import {
  centralPriceKey,
  centralPriceMapKey,
} from "@/lib/white-sheet/pricing";
import {
  loadRoundReturnStatuses,
  type RoundReturnStatus,
} from "./round-return-status";
import {
  classifyProduceFailures,
  type FinalizedProduceOutcome,
  type ProduceFailureAttempt,
  type ProduceFailureClassification,
} from "./failure-lifecycle";
import { loadProduceFailureEvidence } from "./failure-lifecycle-source";
import {
  buildCentralPriceReview,
  type CentralPriceReviewItem,
  type WithdrawalPriceRow,
} from "./central-price-candidates";
import {
  detectDuplicateAnomalies,
  type DuplicateAnomaly,
  type DuplicateSessionSummary,
} from "./duplicate-detector";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

/** Stable machine codes. Never re-used for a different meaning. */
export type PreflightIssueCode =
  /** A round issued produce and no successful ชั่งคืน exists for it. */
  | "missing_successful_return"
  /** A refused document with no provable replacement. */
  | "active_failed_produce_session"
  /** A return document that was opened and never closed. */
  | "pending_produce_session"
  /** Several entered prices inside one accountability round. */
  | "unresolved_central_price"
  /** More than one open round for the same seller/market/date. */
  | "duplicate_open_accountability_round"
  /** Persisted produce that should carry a round and does not. */
  | "unbound_produce_transaction"
  /** Two withdrawal sessions with the same canonical business fingerprint. */
  | "exact_duplicate_withdrawal"
  /** One withdrawal multiset equals the union of others. Evidence, not proof. */
  | "possible_composite_duplicate"
  /** Recorded for audit only — a failure a later success replaced. */
  | "superseded_failed_session"
  /** Recorded for audit only — a failure an authorized workflow retired. */
  | "abandoned_failed_session"
  /** More than one document could be the replacement. Never resolved by guess. */
  | "round_identity_ambiguity";

export type PreflightSeverity = "blocker" | "warning";

export interface PreflightIssue {
  code: PreflightIssueCode;
  severity: PreflightSeverity;
  /** Operator-facing Thai sentence. Presentation may reuse or replace it. */
  message: string;
  accountabilityRoundId?: string | null;
  staffName?: string | null;
  marketName?: string | null;
  /**
   * The records behind this issue — round ids, pending session ids,
   * `raw:<id>` attempt ids, product keys. What makes an unresolved count
   * explainable rather than a number nobody can reconcile.
   */
  evidenceIds?: string[];
  /**
   * The LINE source (group) that owns the evidence, read from the record's own
   * `source_id` column. Never parsed out of message text, so a sender cannot
   * type their way into another group's scope.
   */
  sourceId?: string | null;
  /**
   * The canonical markets this issue can belong to when it has no parsed
   * identity of its own, derived from the accountability rounds the SAME
   * source opened on this date. Absent means no scope was provable and the
   * issue keeps day-wide fail-closed behaviour.
   */
  sourceMarketScope?: string[];
}

export type PreflightRoundStatus = "ready" | "partial" | "blocked";

export interface PreflightRound {
  accountabilityRoundId: string | null;
  staffName: string | null;
  marketName: string | null;
  status: PreflightRoundStatus;
  blockers: PreflightIssue[];
  warnings: PreflightIssue[];
}

export interface PreflightSupersededFailure {
  attemptId: string;
  origin: ProduceFailureAttempt["origin"];
  supersededByProduceSessionId: string | null;
  state: "superseded" | "abandoned";
  marketName: string | null;
  staffName: string | null;
}

export type DailyClosePreflightStatus = "ready" | "ready_with_warnings" | "blocked";

export interface DailyClosePreflightResult {
  businessDate: string;
  status: DailyClosePreflightStatus;
  summary: {
    readyRounds: number;
    partialRounds: number;
    blockedRounds: number;
    unresolvedPriceProducts: number;
    activeFailedSessions: number;
    supersededFailures: number;
    integrityIssues: number;
  };
  rounds: PreflightRound[];
  pricingConflicts: CentralPriceReviewItem[];
  supersededFailures: PreflightSupersededFailure[];
  integrityIssues: PreflightIssue[];
}

/** One open accountability round of the date, with how much it actually holds. */
export interface PreflightRoundRecord {
  accountabilityRoundId: string;
  sourceId: string | null;
  ownerLineUserId: string | null;
  staffName: string | null;
  marketName: string | null;
  status: string;
  transactionCount: number;
}

/** Persisted produce carrying no accountability round, grouped by market. */
export interface UnboundProduceGroup {
  marketName: string | null;
  sessionIds: string[];
  /** True when the SAME market also has bound produce on this date. */
  marketAlsoHasBoundProduce: boolean;
}

export interface DailyClosePreflightInput {
  businessDate: string;
  roundStatuses: readonly RoundReturnStatus[];
  failureAttempts: readonly ProduceFailureAttempt[];
  failureClassifications: readonly ProduceFailureClassification[];
  priceReview: readonly CentralPriceReviewItem[];
  openRounds: readonly PreflightRoundRecord[];
  unboundProduce: readonly UnboundProduceGroup[];
  /** Read-only duplicate evidence for the date. Nothing here mutates anything. */
  duplicateAnomalies?: readonly DuplicateAnomaly[];
  /**
   * Retained for caller compatibility. Price variation no longer controls
   * round completeness.
   */
  roundPriceKeys?: ReadonlyMap<string, ReadonlySet<string>>;
}

function issue(
  code: PreflightIssueCode,
  severity: PreflightSeverity,
  message: string,
  extra: Partial<PreflightIssue> = {},
): PreflightIssue {
  return { code, severity, message, ...extra };
}

/**
 * The per-round verdict.
 *
 * `blocked`  a ชั่งคืน was sent and refused, or one is still open. The round's
 *            produce cannot be closed until a human fixes the source data.
 * `partial`  retained for API compatibility; price variation never produces it.
 * `ready`    nothing outstanding. A round with NO return at all is ready: that
 *            is the legitimate sold-out day, and it carries a warning so a
 *            human can still sanity-check it.
 */
function classifyRound(
  round: RoundReturnStatus,
  attemptsByRound: ReadonlyMap<string, ProduceFailureAttempt[]>,
  activeAttemptIds: ReadonlySet<string>,
  ambiguousAttemptIds: ReadonlySet<string>,
  disputedPriceKeys: ReadonlySet<string>,
): PreflightRound {
  const blockers: PreflightIssue[] = [];
  const warnings: PreflightIssue[] = [];
  const identity = {
    accountabilityRoundId: round.accountabilityRoundId,
    staffName: round.sellerLabel || null,
    marketName: round.marketLabel || null,
  };

  const attempts = attemptsByRound.get(round.accountabilityRoundId) ?? [];
  const active = attempts.filter((attempt) => activeAttemptIds.has(attempt.attemptId));
  const ambiguous = attempts.filter((attempt) => ambiguousAttemptIds.has(attempt.attemptId));

  if (round.state === "blocked") {
    blockers.push(
      issue(
        "missing_successful_return",
        "blocker",
        "พบการส่งชั่งคืน แต่ยังบันทึกไม่สำเร็จ",
        { ...identity, evidenceIds: [round.accountabilityRoundId] },
      ),
    );
  } else if (round.state === "pending") {
    blockers.push(
      issue("pending_produce_session", "blocker", "มีรายการชั่งคืนที่ยังปิดไม่สำเร็จ", {
        ...identity,
        evidenceIds: [round.accountabilityRoundId],
      }),
    );
  } else if (round.state === "none") {
    warnings.push(
      issue(
        "missing_successful_return",
        "warning",
        `เบิก ${round.withdrawalItemCount} รายการ และยังไม่พบรายการชั่งคืน`,
        { ...identity, evidenceIds: [round.accountabilityRoundId] },
      ),
    );
  }

  if (active.length > 0) {
    blockers.push(
      issue(
        "active_failed_produce_session",
        "blocker",
        `มีรายการที่บันทึกไม่สำเร็จและยังไม่มีรายการใหม่มาแทน ${active.length} ชุด`,
        { ...identity, evidenceIds: active.map((attempt) => attempt.attemptId) },
      ),
    );
  }

  if (ambiguous.length > 0) {
    blockers.push(
      issue(
        "round_identity_ambiguity",
        "blocker",
        "พบรายการที่อาจมาแทนกันมากกว่า 1 ชุด — ต้องให้ผู้ดูแลตรวจสอบ",
        { ...identity, evidenceIds: ambiguous.map((attempt) => attempt.attemptId) },
      ),
    );
  }

  // Only the rounds that actually sell a disputed product are partial. Marking
  // every round partial because SOME product on the day is disputed would drop
  // the "ready" count to zero on a day that is almost entirely fine.
  if (blockers.length === 0 && disputedPriceKeys.size > 0) {
    warnings.push(
      issue("unresolved_central_price", "warning", "ราคากลางบางรายการยังไม่ได้รับการยืนยัน", {
        ...identity,
        evidenceIds: [...disputedPriceKeys].sort(),
      }),
    );
  }

  const status: PreflightRoundStatus = blockers.length > 0 ? "blocked" : "ready";

  return { ...identity, status, blockers, warnings };
}

/**
 * Duplicate open rounds for one seller/market/date.
 *
 * Nothing is merged and nothing is chosen. When exactly ONE of the duplicates
 * holds transactions the canonical round is provable, so this is a warning that
 * names it; when several hold transactions, or none do, no canonical round can
 * be proven and it fails closed as a blocker.
 */
function duplicateRoundIssues(openRounds: readonly PreflightRoundRecord[]): PreflightIssue[] {
  const groups = new Map<string, PreflightRoundRecord[]>();
  for (const round of openRounds) {
    if (round.status !== "open") continue;
    const key = [
      round.sourceId ?? "",
      round.ownerLineUserId ?? "",
      (round.staffName ?? "").normalize("NFC").trim(),
      normalizedMarketLabel(round.marketName),
    ].join("");
    groups.set(key, [...(groups.get(key) ?? []), round]);
  }

  const issues: PreflightIssue[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const withRows = group.filter((round) => round.transactionCount > 0);
    const identity = {
      staffName: group[0].staffName,
      marketName: group[0].marketName,
      evidenceIds: group.map((round) => round.accountabilityRoundId),
    };

    if (withRows.length === 1) {
      issues.push(
        issue(
          "duplicate_open_accountability_round",
          "warning",
          `พบรอบซ้ำ ${group.length} รอบ — รอบที่มีรายการจริงคือรอบเดียว รอบว่างที่เหลือไม่มีผลต่อยอด`,
          { ...identity, accountabilityRoundId: withRows[0].accountabilityRoundId },
        ),
      );
      continue;
    }

    issues.push(
      issue(
        "duplicate_open_accountability_round",
        "blocker",
        `พบรอบซ้ำ ${group.length} รอบ และยังพิสูจน์ไม่ได้ว่ารอบใดถูกต้อง`,
        identity,
      ),
    );
  }

  return issues;
}

/**
 * Produce that carries no accountability round.
 *
 * Pre-P2E produce is unbound by design and blocking every historical date on
 * that account would make the preflight useless, so the escalation test is
 * evidence-based rather than a hardcoded cutover: when the SAME market has both
 * bound and unbound produce on the same date, rounds demonstrably were in use
 * for that scope and an unbound session there is a real integrity fault.
 */
function unboundProduceIssues(groups: readonly UnboundProduceGroup[]): PreflightIssue[] {
  return groups.map((group) =>
    issue(
      "unbound_produce_transaction",
      group.marketAlsoHasBoundProduce ? "blocker" : "warning",
      group.marketAlsoHasBoundProduce
        ? `มีรายการที่ไม่ได้ผูกกับรอบ ${group.sessionIds.length} ชุด ทั้งที่ตลาดนี้ใช้รอบอยู่`
        : `มีรายการที่ไม่ได้ผูกกับรอบ ${group.sessionIds.length} ชุด (ข้อมูลก่อนเริ่มใช้รอบ)`,
      { marketName: group.marketName, evidenceIds: group.sessionIds },
    ),
  );
}

/**
 * Duplicate evidence, translated into preflight issues.
 *
 * An EXACT duplicate blocks: two identical withdrawal sets for the same seller,
 * market and date add the whole withdrawal to calculated sales twice, which is
 * precisely the 2026-08-14 inflation. Nothing is merged or voided here — the
 * date simply is not reportable until a human decides which set is real.
 *
 * A COMPOSITE overlap only warns. The identities differ (different sellers,
 * different markets), so the system has evidence, not proof, and must never
 * bind or merge distinct sellers on its own.
 */
function duplicateAnomalyIssues(
  anomalies: readonly DuplicateAnomaly[],
): PreflightIssue[] {
  const label = (session: DuplicateSessionSummary) =>
    `${session.sellerLabel || "?"} — ${session.marketLabel || "?"}`;
  const evidence = (sessions: readonly DuplicateSessionSummary[]) => [
    ...sessions.map((session) => session.sessionId),
    ...sessions
      .map((session) => session.accountabilityRoundId)
      .filter((id): id is string => !!id),
  ];

  return anomalies.map((anomaly) => {
    if (anomaly.kind === "exact_duplicate_withdrawal") {
      const [first] = anomaly.sessions;
      return issue(
        "exact_duplicate_withdrawal",
        "blocker",
        `พบรายการเบิกซ้ำ ${anomaly.sessions.length} ชุด ที่มีเนื้อหาเหมือนกันทุกรายการ `
        + `(${label(first)} ${first.itemCount} รายการ ${first.totalAmount} บาท)`,
        {
          staffName: first.sellerLabel || null,
          marketName: first.marketLabel || null,
          accountabilityRoundId: first.accountabilityRoundId,
          evidenceIds: [...evidence(anomaly.sessions), `fingerprint:${anomaly.fingerprint}`],
        },
      );
    }

    return issue(
      "possible_composite_duplicate",
      "warning",
      `รายการเบิกของ ${label(anomaly.whole)} ${anomaly.whole.itemCount} รายการ `
      + `ตรงกับผลรวมของ ${anomaly.parts.map((part) => `${label(part)} ${part.itemCount} รายการ`).join(" + ")} `
      + "— ต้องให้ผู้ดูแลตรวจสอบ ระบบไม่รวมหรือลบให้เอง",
      {
        staffName: anomaly.whole.sellerLabel || null,
        marketName: anomaly.whole.marketLabel || null,
        accountabilityRoundId: anomaly.whole.accountabilityRoundId,
        evidenceIds: evidence([anomaly.whole, ...anomaly.parts]),
      },
    );
  });
}

/**
 * The canonical markets each LINE source ran on this date.
 *
 * `accountability_rounds` is the only place the system itself records which
 * group operates which market — both columns are written by the round-opening
 * workflow, never by the text of the document being judged. Cancelled rounds
 * are deliberately included: a retired round still proves the group was
 * working that market, and widening the scope only ever fails closed.
 */
function marketScopeBySource(
  openRounds: readonly PreflightRoundRecord[],
): Map<string, Set<string>> {
  const bySource = new Map<string, Set<string>>();
  for (const round of openRounds) {
    const source = (round.sourceId ?? "").trim();
    const market = canonicalMarketLabel(round.marketName);
    if (!source || !market) continue;
    bySource.set(source, (bySource.get(source) ?? new Set<string>()).add(market));
  }
  return bySource;
}

/** Unattributed attempts grouped by their owning source, in a stable order. */
function attemptsBySource(
  attempts: readonly ProduceFailureAttempt[],
): Array<[string, ProduceFailureAttempt[]]> {
  const bySource = new Map<string, ProduceFailureAttempt[]>();
  for (const attempt of attempts) {
    const source = (attempt.sourceId ?? "").trim();
    bySource.set(source, [...(bySource.get(source) ?? []), attempt]);
  }
  return [...bySource].sort(([left], [right]) => left.localeCompare(right));
}

export function buildDailyClosePreflight(
  input: DailyClosePreflightInput,
): DailyClosePreflightResult {
  const attemptById = new Map(input.failureAttempts.map((row) => [row.attemptId, row]));

  const activeAttemptIds = new Set<string>();
  const ambiguousAttemptIds = new Set<string>();
  const supersededFailures: PreflightSupersededFailure[] = [];

  for (const classification of input.failureClassifications) {
    const attempt = attemptById.get(classification.attemptId);
    if (classification.state === "active_failed") {
      activeAttemptIds.add(classification.attemptId);
      if (classification.ambiguousSuccessor) ambiguousAttemptIds.add(classification.attemptId);
      continue;
    }
    supersededFailures.push({
      attemptId: classification.attemptId,
      origin: attempt?.origin ?? "pending_session",
      supersededByProduceSessionId: classification.supersededByProduceSessionId,
      state: classification.state,
      marketName: attempt?.marketLabel ?? null,
      staffName: attempt?.staffLabel ?? null,
    });
  }

  const attemptsByRound = new Map<string, ProduceFailureAttempt[]>();
  const unattributedActive: ProduceFailureAttempt[] = [];
  for (const attempt of input.failureAttempts) {
    const round = attempt.accountabilityRoundId?.trim();
    if (round) {
      attemptsByRound.set(round, [...(attemptsByRound.get(round) ?? []), attempt]);
      continue;
    }
    if (activeAttemptIds.has(attempt.attemptId)) unattributedActive.push(attempt);
  }

  const pricingConflicts = input.priceReview.filter((item) => item.status === "unresolved");
  const rounds = input.roundStatuses
    .filter((round) => !isQaMarketLabel(round.marketLabel))
    .map((round) => {
      const disputed = new Set(
        pricingConflicts
          .filter((item) => item.accountabilityRoundId === round.accountabilityRoundId)
          .map((item) => centralPriceMapKey(item.productKey, item.unitKey)),
      );
      return classifyRound(round, attemptsByRound, activeAttemptIds, ambiguousAttemptIds, disputed);
    })
    .sort(
      (a, b) =>
        (a.marketName ?? "").localeCompare(b.marketName ?? "", "th")
        || (a.staffName ?? "").localeCompare(b.staffName ?? "", "th"),
    );

  const integrityIssues: PreflightIssue[] = [
    ...duplicateRoundIssues(input.openRounds),
    ...unboundProduceIssues(input.unboundProduce),
    ...duplicateAnomalyIssues(input.duplicateAnomalies ?? []),
  ];

  // A refused document no round can claim is reported at day level rather than
  // attached to a round it might not belong to. It is still an active failure
  // and still blocks — but only as widely as its own evidence allows. The
  // document's LINE source is a column, and when that group opened rounds on
  // this date the failure cannot belong outside those markets. A source the
  // date's rounds do not know stays unscoped and blocks the whole day.
  const scopeBySource = marketScopeBySource(input.openRounds);
  for (const [sourceId, attempts] of attemptsBySource(unattributedActive)) {
    const scope = [...(scopeBySource.get(sourceId) ?? [])].sort();
    integrityIssues.push(
      issue(
        "active_failed_produce_session",
        "blocker",
        `มีรายการที่บันทึกไม่สำเร็จและระบุรอบไม่ได้ ${attempts.length} ชุด`
        + (scope.length > 0 ? ` — กลุ่มนี้เปิดรอบที่ ${scope.join(" / ")}` : ""),
        {
          evidenceIds: attempts.map((attempt) => attempt.attemptId),
          sourceId: sourceId || null,
          ...(scope.length > 0 ? { sourceMarketScope: scope } : {}),
        },
      ),
    );
  }

  for (const conflict of pricingConflicts) {
    integrityIssues.push(
      issue(
        "unresolved_central_price",
        "warning",
        `${conflict.productDisplayName} — พบราคา ${conflict.candidates
          .map((candidate) => `${candidate.priceSatang / 100}`)
          .join(" / ")} บาท`,
        {
          accountabilityRoundId: conflict.accountabilityRoundId,
          evidenceIds: [`${conflict.productKey} ${conflict.unitKey}`],
        },
      ),
    );
  }

  const blockedRounds = rounds.filter((round) => round.status === "blocked").length;
  const partialRounds = rounds.filter((round) => round.status === "partial").length;
  const hasIntegrityBlocker = integrityIssues.some((row) => row.severity === "blocker");
  const hasWarning =
    rounds.some((round) => round.warnings.length > 0)
    || integrityIssues.length > 0
    || supersededFailures.length > 0;

  const status: DailyClosePreflightStatus =
    blockedRounds > 0 || hasIntegrityBlocker
      ? "blocked"
      : hasWarning
        ? "ready_with_warnings"
        : "ready";

  return {
    businessDate: input.businessDate,
    status,
    summary: {
      readyRounds: rounds.filter((round) => round.status === "ready").length,
      partialRounds,
      blockedRounds,
      unresolvedPriceProducts: pricingConflicts.length,
      activeFailedSessions: activeAttemptIds.size,
      supersededFailures: supersededFailures.length,
      integrityIssues: integrityIssues.length,
    },
    rounds,
    pricingConflicts,
    supersededFailures,
    integrityIssues,
  };
}

/** Every open round of the date plus how many transactions it actually holds. */
export async function loadOpenRoundRecords(
  supabase: AnyClient,
  businessDate: string,
  produceRows: readonly DateProduceRow[],
): Promise<PreflightRoundRecord[]> {
  const { data, error } = await supabase
    .from("accountability_rounds")
    .select("id, source_id, owner_line_user_id, seller_label, market_label, status")
    .eq("business_date", businessDate);
  if (error) throw new Error(`accountability round lookup failed: ${error.message}`);

  const rounds = (data ?? []) as Array<{
    id: string;
    source_id: string | null;
    owner_line_user_id: string | null;
    seller_label: string | null;
    market_label: string | null;
    status: string;
  }>;
  if (rounds.length === 0) return [];

  // Counted from the rows the caller already fetched — the date's produce is
  // read exactly once per preflight, not once per question asked about it.
  const counts = new Map<string, number>();
  for (const row of produceRows) {
    const round = row.accountability_round_id;
    if (!round) continue;
    counts.set(round, (counts.get(round) ?? 0) + 1);
  }

  return rounds.map((round) => ({
    accountabilityRoundId: round.id,
    sourceId: round.source_id,
    ownerLineUserId: round.owner_line_user_id,
    staffName: round.seller_label,
    marketName: round.market_label,
    status: round.status,
    transactionCount: counts.get(round.id) ?? 0,
  }));
}

export interface DateProduceRow {
  session_id: string;
  market_name: string | null;
  accountability_round_id: string | null;
  product_name?: string | null;
  unit?: string | null;
  /** The duplicate detector's inputs. Optional so existing callers still fit. */
  session_kind?: string | null;
  staff_name?: string | null;
  quantity?: number | string | null;
  price_per_unit?: number | string | null;
  transaction_type?: string | null;
  basis_quantity?: number | string | null;
  basis_unit?: string | null;
  basis_price?: number | string | null;
}

/**
 * The central-price identities each round holds, under the SAME canonical key
 * the calculator prices with — a round must never be judged against a key its
 * value is not looked up by.
 */
export function roundPriceKeysFromRows(
  rows: readonly DateProduceRow[],
  businessDate: string,
): Map<string, Set<string>> {
  const byRound = new Map<string, Set<string>>();

  for (const row of rows) {
    const round = row.accountability_round_id;
    const productName = row.product_name?.trim();
    const unit = row.unit?.trim();
    if (!round || !productName || !unit) continue;
    try {
      const key = centralPriceKey({ productName, unit, businessDate });
      const keys = byRound.get(round) ?? new Set<string>();
      keys.add(centralPriceMapKey(key.productKey, key.unitKey));
      byRound.set(round, keys);
    } catch {
      // An identity the pricing boundary refuses has no price key to match; the
      // Sales report already blocks it through invalid_identity.
    }
  }

  return byRound;
}

async function fetchDateProduceRows(
  supabase: AnyClient,
  businessDate: string,
): Promise<DateProduceRow[]> {
  const rows: DateProduceRow[] = [];
  const PAGE = 1000;

  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from("produce_transactions")
      .select("session_id, market_name, staff_name, session_kind, accountability_round_id, product_name, unit, quantity, price_per_unit, transaction_type, basis_quantity, basis_unit, basis_price")
      .eq("transaction_date", businessDate)
      .order("id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`preflight produce query failed: ${error.message}`);
    const page = (data ?? []) as DateProduceRow[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }

  return rows;
}

/** Unbound produce for the date, grouped by market, with the escalation test. */
export function groupUnboundProduce(
  rows: readonly DateProduceRow[],
): UnboundProduceGroup[] {
  const bound = new Set<string>();
  const unbound = new Map<string, Set<string>>();

  for (const row of rows) {
    const market = normalizedMarketLabel(row.market_name);
    if (row.accountability_round_id) {
      bound.add(market);
      continue;
    }
    unbound.set(market, (unbound.get(market) ?? new Set<string>()).add(row.session_id));
  }

  return [...unbound]
    .map(([market, sessionIds]) => ({
      marketName: market || null,
      sessionIds: [...sessionIds].sort(),
      marketAlsoHasBoundProduce: bound.has(market),
    }))
    .sort((a, b) => (a.marketName ?? "").localeCompare(b.marketName ?? "", "th"));
}

export interface LoadDailyClosePreflightOptions {
  /**
   * Failed/unfinalized documents for this date, already gathered by the Sales
   * loader. Passed in rather than re-scanned so preflight and the report can
   * never disagree about what was attempted.
   */
  failureAttempts: readonly ProduceFailureAttempt[];
  /** Withdrawal rows of the date — the candidate central prices. */
  withdrawalRows: readonly WithdrawalPriceRow[];
  /** Reuses an already-loaded classification set when the caller has one. */
  outcomes?: readonly FinalizedProduceOutcome[];
  cancelledRoundIds?: ReadonlySet<string>;
  /** Already-loaded facts from a report path; avoids repeating paged reads. */
  roundStatuses?: readonly RoundReturnStatus[];
  produceRows?: readonly DateProduceRow[];
}

export async function loadDailyClosePreflight(
  supabase: AnyClient,
  businessDate: string,
  options: LoadDailyClosePreflightOptions,
): Promise<DailyClosePreflightResult> {
  const evidence =
    options.outcomes && options.cancelledRoundIds
      ? { outcomes: options.outcomes, cancelledRoundIds: options.cancelledRoundIds }
      : await loadProduceFailureEvidence(supabase, businessDate);

  const [roundStatuses, produceRows] = await Promise.all([
    options.roundStatuses
      ? Promise.resolve(options.roundStatuses)
      : loadRoundReturnStatuses(supabase, businessDate),
    options.produceRows
      ? Promise.resolve(options.produceRows)
      : fetchDateProduceRows(supabase, businessDate),
  ]);
  const openRounds = await loadOpenRoundRecords(supabase, businessDate, produceRows);

  const failureClassifications = classifyProduceFailures(
    options.failureAttempts,
    evidence.outcomes,
    { cancelledRoundIds: evidence.cancelledRoundIds },
  );

  const result = buildDailyClosePreflight({
    businessDate,
    roundStatuses,
    failureAttempts: options.failureAttempts,
    failureClassifications,
    priceReview: buildCentralPriceReview(options.withdrawalRows, businessDate, new Map()),
    openRounds,
    unboundProduce: groupUnboundProduce(produceRows),
    roundPriceKeys: roundPriceKeysFromRows(produceRows, businessDate),
    // Read-only, over the rows already in hand. No extra query, no writes.
    duplicateAnomalies: detectDuplicateAnomalies(businessDate, produceRows),
  });

  logger.info("daily_close_preflight", {
    business_date: businessDate,
    report_status: result.status,
    ready_rounds: result.summary.readyRounds,
    partial_rounds: result.summary.partialRounds,
    blocked_rounds: result.summary.blockedRounds,
    unresolved_price_products: result.summary.unresolvedPriceProducts,
    active_failed_sessions: result.summary.activeFailedSessions,
    superseded_failures: result.summary.supersededFailures,
    integrity_issues: result.summary.integrityIssues,
  });

  return result;
}
