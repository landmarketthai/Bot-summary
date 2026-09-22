import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizedMarketLabel } from "@/lib/market";
import { RE } from "@/lib/parsers/weigh-session/regex";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import {
  computeItemHash,
  legacySubunitPricedSession,
  sessionHashCandidates,
} from "@/lib/line/session-dedup-service";
import { bangkokBusinessDateFromTimestamp } from "@/lib/business-date";
import { isStrictBusinessDate } from "./cron";
import { isQaMarketLabel } from "./qa-scopes";
import { resolveCentralPricesForDate } from "@/lib/white-sheet/load";
import { resolveWithdrawalUnitPriceBaht } from "@/lib/white-sheet/calculate";
import {
  loadRoundReturnStatuses,
  roundsWithIncompleteReturn,
  roundsWithPersistedReturn,
} from "@/lib/produce/round-return-status";
import {
  activeFailureIds,
  activeIncompleteReturnRoundIds,
  classifyProduceFailures,
  type ProduceFailureAttempt,
  type ProduceFailureClassification,
} from "@/lib/produce/failure-lifecycle";
import {
  loadProduceFailureEvidence,
  pendingFailureAttempt,
  rawMessageFailureAttempt,
  type ProduceFailureEvidence,
} from "@/lib/produce/failure-lifecycle-source";
import type { LatestDataLookup } from "@/lib/summary/latest-data-hint";
import type { Database } from "@/types/database";
import {
  calculateSalesReport,
  type SalesBlockReason,
  type SalesReport,
  type SalesScopeBlocker,
  type SalesSessionAudit,
  type SalesSourceRow,
} from "./calculate";

/**
 * P1 Daily Sales — the only path from the database to a SalesReport.
 *
 * Both the manual `สรุปยอดขาย` LINE command and the scheduled 08:10 delivery go
 * through here, so the two can never drift apart. Every read is read-only; this
 * module writes nothing, seeds no price, and touches no P0 Stock code path.
 *
 * Sources, and why each one:
 *   produce_transactions   the persisted, void-filtered transaction evidence
 *   raw_messages           source_id — the stable half of the market identity
 *   produce_sessions       parser errors and the persisted item-count claim
 *   entered withdrawal prices, scoped by accountability round
 *   pending_sessions       produce data that never finalized
 *   parse_errors           messages whose parse crashed — data that never landed
 */

type Supabase = SupabaseClient<Database>;
type ProduceTransactionRow = Database["public"]["Views"]["produce_transactions"]["Row"];

const PAGE_SIZE = 1000;
const LOOKUP_CHUNK_SIZE = 500;

/**
 * Every column P1 needs. NO transaction-type filter is applied to the query:
 * the legacy "เสีย" spelling is not normalized by the view's
 * base_transaction_type CASE, so filtering on that column server-side would
 * silently drop damage rows and overstate what was sold. Classification happens
 * in the calculator through baseTransactionType, and a genuinely unknown type
 * blocks its identity instead of disappearing.
 */
const PRODUCE_SELECT =
  "id, session_id, market_name, staff_name, product_name, quantity, unit, transaction_type, base_transaction_type, price_per_unit, basis_quantity, basis_unit, basis_price, raw_message_id, session_kind, item_created_at, accountability_round_id" as const;

/**
 * parse_errors rows that mean data may be missing. "unsupported_type" is
 * excluded on purpose — a sticker or an image is not lost produce data, and
 * treating it as one would block every business date forever.
 */
const BLOCKING_PARSE_ERROR_TYPES = ["parser_crash", "timeout", "validation_error"] as const;

/**
 * Pending finalization states that account for the produce: 'finalized' created
 * the produce_session, 'duplicate' proved one already existed, and
 * 'expired_empty_draft' (20260829090000) proves the inactivity sweep found
 * ZERO accepted items — nothing was ever entered, so it is not missing
 * produce. Everything else ('pending', 'processing', 'failed_closed',
 * including the >=1-item 'expired_incomplete' reason on 'failed_closed') is
 * produce that never landed.
 */
const RESOLVED_PENDING_STATUSES = new Set(["finalized", "duplicate", "expired_empty_draft"]);

/**
 * Identity columns a failed pending session needs before its lifecycle can be
 * decided. Structured sessions fill them; plain-text ones leave them null and
 * are read from the accumulated text instead.
 */
const PENDING_FAILURE_SELECT =
  "id, session_key, session_generation, accumulated_text, created_at, finalization_status, business_date, source_id, staff_label, market_label, declared_transaction_type, accountability_round_id" as const;

/** Safety stop for the undated scope scans — a short read must never pass silently. */
const SCOPE_SCAN_MAX_PAGES = 50;

/**
 * Server-side prefilter for the lost-produce scan: a provable SUPERSET of
 * RE.SESSION_START. Every alternative of that regex contains one of these four
 * substrings (คืนเสีย contains คืน; the bare "เสีย DD/MM/YYYY" form contains
 * เสีย), so a message this filter drops cannot possibly be a produce message.
 * It exists only to keep the scan off obvious chat traffic — the authority
 * remains isCompleteProduceMessage in application code.
 */
const PRODUCE_TEXT_FILTER = [
  "raw_text.ilike.*รายการชั่ง*",
  "raw_text.ilike.*เบิก*",
  "raw_text.ilike.*คืน*",
  "raw_text.ilike.*เสีย*",
].join(",");

/**
 * parse_errors is a generic table: any parser that throws lands in it, and the
 * webhook also files "registry" rows for message types nothing handles. Only a
 * failure that could have swallowed produce evidence (เบิก / คืน / คืนเสีย) may
 * demote a Sales report, so relevance is decided per row rather than per day.
 *
 * Two pieces of evidence, in order:
 *   1. parser_name — the crash handler stores the parser that was running, and
 *      the weigh-session parser is the one that produces P1's evidence.
 *   2. the raw message text — a crash from an unrecognized parser still blocks
 *      when the message itself looks like a weighing session, which is the same
 *      RE.SESSION_START test the parser uses to claim a message. That keeps a
 *      future produce parser fail-closed without P1 having to know its name.
 *
 * A non-text message (raw_text null) carries no produce lines by construction,
 * so an unrelated crash on one does not demote the day. A parse error whose raw
 * message cannot be read at all is treated as relevant — fail closed.
 */
const PRODUCE_PARSER_NAMES = new Set(["weigh-session"]);

export class SalesDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SalesDataError";
  }
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

/**
 * The UTC instants bounding one Bangkok business date. The existing 04:00
 * cutoff defines the day (see bangkokBusinessDateFromTimestamp), and Bangkok is
 * UTC+7 year-round with no DST, so business date D runs from D−1T21:00Z to
 * DT21:00Z.
 */
export function bangkokBusinessDateWindow(businessDate: string): { start: string; end: string } {
  const [year, month, day] = businessDate.split("-").map(Number);
  const startOfDayUtc = Date.UTC(year, month - 1, day);
  const start = new Date(startOfDayUtc - 3 * 60 * 60 * 1000).toISOString();
  const end = new Date(startOfDayUtc + 21 * 60 * 60 * 1000).toISOString();
  return { start, end };
}

/**
 * Paginates the day's produce rows with an exact row count, refusing to return
 * a partial set. Same discipline as the White Sheet loader: a short read here
 * would silently understate sales.
 */
export async function fetchSalesProduceRows(
  supabase: Supabase,
  businessDate: string,
): Promise<ProduceTransactionRow[]> {
  const rows: ProduceTransactionRow[] = [];
  const seenRowIds = new Set<string>();
  let offset = 0;
  let expectedCount: number | null = null;

  while (true) {
    const { data, error, count } = await supabase
      .from("produce_transactions")
      .select(PRODUCE_SELECT, { count: "exact" })
      .eq("transaction_date", businessDate)
      .order("item_created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) throw new SalesDataError(`produce transaction query failed: ${error.message}`);
    if (count === null) {
      throw new SalesDataError("produce transaction pagination requires an exact row count");
    }
    if (expectedCount === null) expectedCount = count;
    else if (count !== expectedCount) {
      throw new SalesDataError("produce transaction set changed during pagination");
    }

    const page = (data ?? []) as ProduceTransactionRow[];
    if (page.length === 0) {
      if (offset === expectedCount) break;
      throw new SalesDataError(
        "produce transaction pagination stopped before all rows were loaded",
      );
    }

    for (const row of page) {
      if (seenRowIds.has(row.id)) {
        throw new SalesDataError("produce transaction pagination returned a duplicate row");
      }
      seenRowIds.add(row.id);
      rows.push(row);
    }

    offset += page.length;
    if (offset === expectedCount) break;
    if (offset > expectedCount) {
      throw new SalesDataError("produce transaction pagination exceeded the exact row count");
    }
  }

  return rows;
}

/**
 * The latest business date STRICTLY BEFORE `beforeDate` that has sales
 * evidence, with the number of markets that produced it.
 *
 * Only ever called when the requested date turned out empty, so a normal day
 * pays nothing for it.
 *
 * Eligibility is P1's own, not a second opinion: produce_transactions is the
 * void-filtered view loadSalesReport reads, with NO transaction-type filter —
 * exactly as fetchSalesProduceRows does, because W/R/D classification belongs to
 * the calculator and a server-side type filter would silently drop the legacy
 * "เสีย" spelling. Slips, settlements, cash, purchases, inventory movements and
 * P2A snapshots live in other tables and are unreachable from here.
 *
 * `.lt` keeps the search strictly backwards, so future-dated rows can never be
 * offered as "the latest data we have", and the date itself is ONE ordered row —
 * a MAX in disguise, not a scan of history.
 *
 * The market count uses the same normalizedMarketLabel identity and the same QA
 * exclusion the report applies, so it counts the markets a reader would see.
 * Rows whose market cannot be resolved have no market to count.
 *
 * Returns "none" ONLY when the query succeeded and proved there is nothing
 * earlier. A read failure THROWS rather than degrading to "none" — the caller
 * turns that into "unavailable", because a database error is not evidence that
 * the business has never sold anything.
 */
export async function findLatestSalesDataDate(
  supabase: Supabase,
  beforeDate: string,
): Promise<LatestDataLookup> {
  const { data, error } = await supabase
    .from("produce_transactions")
    .select("transaction_date")
    .lt("transaction_date", beforeDate)
    .order("transaction_date", { ascending: false })
    .limit(1);
  if (error) throw new SalesDataError(`latest sales date query failed: ${error.message}`);

  const date = data?.[0]?.transaction_date ?? null;
  if (!date) return { status: "none" };

  // Bounded by construction: one business date, paged like every other read here.
  const markets = new Set<string>();
  let offset = 0;

  while (true) {
    const { data: rows, error: rowsError } = await supabase
      .from("produce_transactions")
      .select("market_name")
      .eq("transaction_date", date)
      .order("market_name", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (rowsError) {
      throw new SalesDataError(`latest sales market query failed: ${rowsError.message}`);
    }

    for (const row of rows ?? []) {
      const label = normalizedMarketLabel(row.market_name);
      if (label && !isQaMarketLabel(label)) markets.add(label);
    }

    if (!rows || rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return { status: "found", hint: { date, marketCount: markets.size } };
}

async function mapRawMessageSources(
  supabase: Supabase,
  rawMessageIds: readonly string[],
): Promise<Map<string, string>> {
  const sourceByRawMessageId = new Map<string, string>();

  for (const chunk of chunks(rawMessageIds, LOOKUP_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from("raw_messages")
      .select("id, source_id")
      .in("id", chunk);
    if (error) throw new SalesDataError(`market/source mapping query failed: ${error.message}`);
    for (const row of data ?? []) {
      if (row.source_id) sourceByRawMessageId.set(row.id, row.source_id);
    }
  }

  return sourceByRawMessageId;
}

/**
 * Session integrity findings, keyed by session id.
 *
 * parser_errors: the parser could not read every line of the message, so the
 * session's item set is incomplete by the parser's own admission.
 *
 * total_items vs persisted rows: the session recorded how many items it parsed;
 * a different number of rows actually landed. Either way the day's quantities
 * for that session are not provably complete, so its identities are blocked.
 */
async function loadSessionIssues(
  supabase: Supabase,
  rows: readonly ProduceTransactionRow[],
): Promise<Map<string, SalesBlockReason[]>> {
  const issues = new Map<string, SalesBlockReason[]>();
  const sessionIds = [...new Set(rows.map((row) => row.session_id))];
  if (sessionIds.length === 0) return issues;

  const persistedCounts = new Map<string, number>();
  for (const row of rows) {
    persistedCounts.set(row.session_id, (persistedCounts.get(row.session_id) ?? 0) + 1);
  }

  for (const chunk of chunks(sessionIds, LOOKUP_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from("produce_sessions")
      .select("id, total_items, parser_errors")
      .in("id", chunk);
    if (error) throw new SalesDataError(`produce session integrity query failed: ${error.message}`);

    for (const session of data ?? []) {
      const found: SalesBlockReason[] = [];
      const parserErrors = session.parser_errors;
      if (Array.isArray(parserErrors) ? parserErrors.length > 0 : parserErrors != null) {
        found.push("session_parser_errors");
      }
      // Every item of a session shares its session_date, so the rows fetched for
      // this business date are that session's complete persisted item set.
      if ((persistedCounts.get(session.id) ?? 0) !== session.total_items) {
        found.push("session_item_count_mismatch");
      }
      if (found.length > 0) issues.set(session.id, found);
    }
  }

  return issues;
}

/**
 * Integrity problems that cannot be pinned to one market.
 *
 * A pending session that never produced a produce_session, or a message whose
 * parse crashed, may hold produce lines for ANY market — so neither can be
 * attributed, and both demote every total in the scope.
 *
 * ONLY active failures count. A refused document that a later successful
 * document provably replaced is history, not a missing entry, and reporting it
 * as one is what buried the real problems under stale noise.
 */
async function loadScopeBlockers(
  supabase: Supabase,
  businessDate: string,
  failures: ProduceFailureScan,
): Promise<SalesScopeBlocker[]> {
  // No time window here: both scans are attributed by the produce business date
  // their own evidence names, not by when the row happened to be written.
  const blockers: SalesScopeBlocker[] = [];

  const unresolvedPending = failures.attempts.filter(
    (attempt) =>
      attempt.origin === "pending_session" && failures.activeIds.has(attempt.attemptId),
  ).length;
  if (unresolvedPending > 0) {
    blockers.push({ kind: "unresolved_pending_session", count: unresolvedPending });
  }

  const relevant = await countProduceParseErrors(supabase, businessDate);
  if (relevant > 0) {
    blockers.push({ kind: "message_parser_error", count: relevant });
  }

  return blockers;
}

/**
 * Pages through a narrow scope query with no date bound.
 *
 * Both scope scans (unresolved pending sessions, blocking parse errors) are
 * filtered server-side to states that are rare by construction, then attributed
 * client-side by their produce business date — the row's own timestamps cannot
 * do it, because backdated entry is normal. If such a scan ever exceeds
 * SCOPE_SCAN_MAX_PAGES the loader throws rather than returning a short read: a
 * truncated scope scan would silently under-report blockers.
 */
async function fetchAllScopeRows<T>(
  label: string,
  page: (from: number, to: number) => PromiseLike<{
    data: T[] | null;
    error: { message: string } | null;
  }>,
): Promise<T[]> {
  const rows: T[] = [];

  for (let index = 0; index < SCOPE_SCAN_MAX_PAGES; index += 1) {
    const from = index * PAGE_SIZE;
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new SalesDataError(`${label} query failed: ${error.message}`);

    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return rows;
  }

  throw new SalesDataError(`${label} scan exceeded ${SCOPE_SCAN_MAX_PAGES} pages`);
}

/**
 * The business date a produce message belongs to.
 *
 * Hierarchy, in strict order:
 *
 *   1. the explicit header date in the text — what the finalizer would persist
 *      as session_date, so a message sent on the 26th headed 25/07/2569 is
 *      evidence about the 25th, whatever any clock says;
 *   2. otherwise the LINE event timestamp, through the deployed
 *      bangkokBusinessDateFromTimestamp rule — exactly the fallbackDate
 *      WeighSessionParser.parse passes;
 *   3. null, when neither exists — the caller then fails closed.
 *
 * `eventTimestampMs` must be the LINE event time, NOT a database insert time.
 * They straddle the 04:00 cutoff differently: an event sent at 03:59:59 and
 * inserted at 04:00:01 belongs to the PREVIOUS business date, and using the
 * insert time would file that produce under the wrong day.
 */
function produceBusinessDate(
  text: string | null | undefined,
  eventTimestampMs: number | null,
): string | null {
  const fallback = eventTimestampMs === null ? null : bangkokBusinessDateFromTimestamp(eventTimestampMs);
  if (!text || !text.trim()) return fallback;
  return parseWeighSession(text, fallback).date ?? fallback;
}

/**
 * The authoritative LINE event time for a raw message.
 *
 * raw_messages.payload is the webhook event verbatim (see saveRawMessage), so
 * payload.timestamp is the same millisecond value the parser saw at ingestion.
 * created_at is only the row's insert time and is used ONLY when the payload
 * cannot be interpreted — a documented degradation, not an equivalent.
 */
function lineEventTimestampMs(payload: unknown, createdAt: string | null | undefined): number | null {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const timestamp = (payload as { timestamp?: unknown }).timestamp;
    if (typeof timestamp === "number" && Number.isFinite(timestamp)) return timestamp;
  }
  if (!createdAt) return null;
  const parsed = Date.parse(createdAt);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Pending produce sessions that never became a produce_session for this
 * business date.
 *
 * TWO deployed facts drive this (see 0036_additional_produce_entries.sql):
 *
 * 1. A row is NOT resolved just because finalized_at is set. finalize_* stamps
 *    finalized_at together with finalization_status = 'failed_closed' when items
 *    are missing or validation fails — the produce never landed. Only
 *    'finalized' and 'duplicate' mean the evidence is accounted for; every other
 *    status ('pending', 'processing', 'failed_closed') is missing evidence.
 *
 * 2. created_at is NOT the business date, and nothing limits how late produce
 *    may be entered. The scan is therefore filtered by STATE, not by time: the
 *    unresolved rows are the ones that matter, however long ago they were
 *    created, and each is attributed by the business date its own text names.
 *    There is no locked rule capping backdating, so P1 imposes no ceiling.
 */
async function scanUnresolvedPendingAttempts(
  supabase: Supabase,
  businessDate: string,
): Promise<ProduceFailureAttempt[]> {
  // pending_sessions is not part of the generated Database types (it is
  // operational webhook state, never a report source), so this one read uses a
  // loosened client exactly as PendingSessionService does.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const looseClient = supabase as unknown as SupabaseClient<any>;

  const rows = await fetchAllScopeRows<{
    id: string;
    session_key?: string | null;
    session_generation?: string | null;
    accumulated_text?: string | null;
    created_at?: string | null;
    finalization_status?: string | null;
    business_date?: string | null;
    source_id?: string | null;
    staff_label?: string | null;
    market_label?: string | null;
    declared_transaction_type?: string | null;
    accountability_round_id?: string | null;
  }>("pending session", (from, to) =>
    looseClient
      .from("pending_sessions")
      .select(PENDING_FAILURE_SELECT)
      // Resolved rows are the overwhelming majority and can never be evidence
      // of missing produce, so they are excluded server-side; the client-side
      // check below is the authority either way.
      // SQL `NULL NOT IN (...)` is UNKNOWN, not true. Include legacy nulls
      // explicitly or they disappear before the fail-closed client check.
      .or(
        `finalization_status.is.null,finalization_status.not.in.(${[
          ...RESOLVED_PENDING_STATUSES,
        ].join(",")})`,
      )
      .order("id", { ascending: true })
      .range(from, to),
  );

  const unresolved = rows.filter(
    (row) => !RESOLVED_PENDING_STATUSES.has(row.finalization_status ?? "pending"),
  );
  if (unresolved.length === 0) return [];

  const eventTimes = await pendingIngestEventTimes(looseClient, unresolved);

  const attempts: ProduceFailureAttempt[] = [];
  for (const row of unresolved) {
    // The lookup succeeded (it throws otherwise), so a missing entry proves the
    // session predates the ingest ledger — the documented legacy fallback.
    const firstEventTimestampMs = eventTimes.first.get(row.id)
      ?? (row.created_at ? Date.parse(row.created_at) : null);
    const attemptedAtMsRaw = eventTimes.last.get(row.id) ?? firstEventTimestampMs;
    const attemptedAtMs = Number.isFinite(attemptedAtMsRaw as number)
      ? (attemptedAtMsRaw as number)
      : null;
    const dateTimestampMs = Number.isFinite(firstEventTimestampMs as number)
      ? (firstEventTimestampMs as number)
      : null;
    const date = produceBusinessDate(row.accumulated_text, dateTimestampMs);
    // No date evidence at all: keep it. Excluding an unresolved session
    // because its date is unknown is the one direction that loses evidence.
    if (date !== null && date !== businessDate) continue;
    attempts.push(pendingFailureAttempt(row, attemptedAtMs, date));
  }

  return attempts;
}

/**
 * Unresolved pending produce sessions for a business date, EXCLUDING any that a
 * later successful document provably replaced.
 *
 * Kept as a standalone entry point because the 08:00 stock report needs only
 * this number; callers that also need the audits use loadProduceFailureScan and
 * pay for the evidence lookup once.
 */
export async function countUnresolvedPendingSessions(
  supabase: Supabase,
  businessDate: string,
): Promise<number> {
  const [attempts, evidence] = await Promise.all([
    scanUnresolvedPendingAttempts(supabase, businessDate),
    loadProduceFailureEvidence(supabase, businessDate),
  ]);
  const classifications = classifyProduceFailures(attempts, evidence.outcomes, {
    cancelledRoundIds: evidence.cancelledRoundIds,
  });
  return activeFailureIds(classifications).size;
}

/**
 * Every failed/unfinalized produce document attributed to a business date,
 * together with its lifecycle verdict.
 *
 * This is the single place the two report paths and the Daily Close Preflight
 * agree on what "still unresolved" means. The raw candidate rows travel with it
 * so the session audit can render the ones that are still active without
 * scanning raw_messages a second time.
 */
export interface ProduceFailureScan {
  attempts: ProduceFailureAttempt[];
  classifications: ProduceFailureClassification[];
  activeIds: Set<string>;
  evidence: ProduceFailureEvidence;
  lostMessages: LostProduceCandidate[];
}

export async function loadProduceFailureScan(
  supabase: Supabase,
  businessDate: string,
): Promise<ProduceFailureScan> {
  const [pendingAttempts, lostMessages, evidence] = await Promise.all([
    scanUnresolvedPendingAttempts(supabase, businessDate),
    scanLostProduceMessages(supabase, businessDate),
    loadProduceFailureEvidence(supabase, businessDate),
  ]);

  const attempts = [
    ...pendingAttempts,
    ...lostMessages.map((row) => row.attempt),
  ];
  const classifications = classifyProduceFailures(attempts, evidence.outcomes, {
    cancelledRoundIds: evidence.cancelledRoundIds,
  });

  return {
    attempts,
    classifications,
    activeIds: activeFailureIds(classifications),
    evidence,
    lostMessages,
  };
}

/**
 * The LINE event time of each unresolved session's FIRST ingested message.
 *
 * pending_session_ingest stores line_timestamp_ms per (session_key, generation)
 * — the authoritative send time of the header that opened the session, which is
 * what the business date must be derived from when no explicit header date
 * exists. pending_sessions.created_at is the row's insert time and is only used
 * when no ingest evidence survives.
 *
 * A FAILED lookup throws. Falling back to created_at then would invent
 * authority out of a database error: around the 04:00 cutoff the two timestamps
 * name different business dates, so a failed query could silently move produce
 * to the wrong day and leave the report looking clean. Only a lookup that
 * SUCCEEDED and proved no ledger row exists (sessions predating
 * pending_session_ingest) may fall back.
 */
async function pendingIngestEventTimes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  looseClient: SupabaseClient<any>,
  rows: readonly { id: string; session_key?: string | null; session_generation?: string | null }[],
): Promise<{ first: Map<string, number>; last: Map<string, number> }> {
  const first = new Map<string, number>();
  const last = new Map<string, number>();
  const keys = rows.map((row) => row.session_key).filter((key): key is string => Boolean(key));
  if (keys.length === 0) return { first, last };

  const byKeyAndGeneration = new Map<string, string>();
  for (const row of rows) {
    if (row.session_key) byKeyAndGeneration.set(`${row.session_key}|${row.session_generation ?? ""}`, row.id);
  }

  for (const chunk of chunks([...new Set(keys)], LOOKUP_CHUNK_SIZE)) {
    const { data, error } = await looseClient
      .from("pending_session_ingest")
      .select("session_key, session_generation, line_timestamp_ms")
      .in("session_key", chunk);
    if (error) throw new SalesDataError(`pending ingest timestamp query failed: ${error.message}`);

    for (const ingest of data ?? []) {
      const rowId = byKeyAndGeneration.get(
        `${ingest.session_key}|${ingest.session_generation ?? ""}`,
      );
      const timestamp = Number(ingest.line_timestamp_ms);
      if (!rowId || !Number.isFinite(timestamp)) continue;
      const earliest = first.get(rowId);
      const latest = last.get(rowId);
      if (earliest === undefined || timestamp < earliest) first.set(rowId, timestamp);
      if (latest === undefined || timestamp > latest) last.set(rowId, timestamp);
    }
  }

  return { first, last };
}

/**
 * How many of the day's parse failures could have swallowed produce evidence.
 * See PRODUCE_PARSER_NAMES for the rule; the raw-message lookup only runs for
 * rows an unrecognized parser produced.
 */
async function countProduceParseErrors(
  supabase: Supabase,
  businessDate: string,
): Promise<number> {
  const errors = await fetchAllScopeRows<{ parser_name: string; raw_message_id: string }>(
    "parse error",
    (from, to) =>
      supabase
        .from("parse_errors")
        .select("id, parser_name, raw_message_id")
        .in("error_type", [...BLOCKING_PARSE_ERROR_TYPES])
        .range(from, to),
  );

  // Distinct raw messages, not rows: a webhook retry can file the same failure
  // twice, and one lost message is one blocker however often it was recorded.
  const distinct = [...new Map(errors.map((row) => [row.raw_message_id, row])).values()];
  if (distinct.length === 0) return 0;

  // The raw message carries both pieces of evidence a parse error lacks: what
  // was said (is this produce at all?) and which business date it was about.
  const messages = await fetchRawMessageEvidence(
    supabase,
    distinct.map((row) => row.raw_message_id),
    "parse error message lookup",
  );

  return distinct.filter((row) => {
    const message = messages.get(row.raw_message_id);
    // Unreadable evidence: cannot prove it was not this day's produce.
    if (!message) return true;

    const isProduce =
      PRODUCE_PARSER_NAMES.has(row.parser_name)
      || (typeof message.rawText === "string" && RE.SESSION_START.test(message.rawText));
    if (!isProduce) return false;

    // A crash on a message headed 25/07/2569 is a blocker for the 25th, even
    // when it arrived on the 26th — and it must NOT block the 26th.
    const date = produceBusinessDate(message.rawText, message.eventTimestampMs);
    return date === null || date === businessDate;
  }).length;
}

interface RawMessageEvidence {
  rawText: string | null;
  eventTimestampMs: number | null;
}

/** raw_text plus the authoritative LINE event time, keyed by raw message id. */
async function fetchRawMessageEvidence(
  supabase: Supabase,
  rawMessageIds: readonly string[],
  label: string,
): Promise<Map<string, RawMessageEvidence>> {
  const evidence = new Map<string, RawMessageEvidence>();
  const unique = [...new Set(rawMessageIds)].filter(Boolean);

  for (const chunk of chunks(unique, LOOKUP_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from("raw_messages")
      .select("id, raw_text, payload, created_at")
      .in("id", chunk);
    if (error) throw new SalesDataError(`${label} failed: ${error.message}`);
    for (const row of data ?? []) {
      evidence.set(row.id, {
        rawText: row.raw_text,
        eventTimestampMs: lineEventTimestampMs(row.payload, row.created_at),
      });
    }
  }

  return evidence;
}

/**
 * Sessions the transaction rows cannot reveal.
 *
 * loadSessionIssues starts from produce_transactions, so a session that
 * persisted NO rows is invisible to it — total_items says produce was weighed
 * and nothing landed. This audits produce_sessions for the business date
 * independently, and only reports sessions the row-based path did not already
 * catch, so a broken session is never counted twice.
 *
 * Voided sessions are excluded (produce_transactions is already void-filtered;
 * a voided session's absence of rows is correct, not a failure). total_items = 0
 * claims nothing and is left alone.
 */
async function loadSessionAudits(
  supabase: Supabase,
  businessDate: string,
  rows: readonly ProduceTransactionRow[],
  sourceByRawMessageId: ReadonlyMap<string, string>,
  failures: ProduceFailureScan,
): Promise<SalesSessionAudit[]> {
  const { data, error } = await supabase
    .from("produce_sessions")
    .select("id, session_title, total_items, raw_message_id, voided_at, session_date")
    .eq("session_date", businessDate)
    .is("voided_at", null);
  if (error) throw new SalesDataError(`produce session audit query failed: ${error.message}`);

  const sessionsWithRows = new Set(rows.map((row) => row.session_id));
  const audits: SalesSessionAudit[] = [];
  const missingSources: string[] = [];

  for (const session of data ?? []) {
    // The server filter is re-applied client-side: a null-dated session belongs
    // to auditNullDatedSessions, which dates it from its own evidence.
    if (session.session_date !== undefined && session.session_date !== businessDate) continue;
    if (sessionsWithRows.has(session.id)) continue; // already audited through its rows
    if ((session.total_items ?? 0) <= 0) continue; // claimed nothing, lost nothing
    if (session.raw_message_id && !sourceByRawMessageId.has(session.raw_message_id)) {
      missingSources.push(session.raw_message_id);
    }
    audits.push({
      sessionId: session.id,
      sourceId: sourceByRawMessageId.get(session.raw_message_id) ?? null,
      marketName: normalizedMarketLabel(session.session_title) || null,
      reasons: ["session_rows_missing"],
    });
  }

  // A broken session's raw message is usually not among the day's transaction
  // rows, so its source has to be looked up before the market can be attributed.
  if (missingSources.length > 0) {
    const extra = await mapRawMessageSources(supabase, [...new Set(missingSources)]);
    for (const audit of audits) {
      if (audit.sourceId) continue;
      const session = (data ?? []).find((row) => row.id === audit.sessionId);
      if (session?.raw_message_id) audit.sourceId = extra.get(session.raw_message_id) ?? null;
    }
  }

  audits.push(...(await auditNullDatedSessions(supabase, businessDate)));
  audits.push(...auditLostProduceMessages(failures));
  return audits;
}

/**
 * True for a message that would have taken the DIRECT single-message produce
 * path — a real header line plus items or a closer.
 *
 * Mirrors the deployed predicate exactly (hasSessionStart + hasSessionEnd /
 * hasItemLine in webhook-service): SESSION_END lines are skipped before testing
 * for a header, because "จบรายการคืน" contains คืน and would otherwise read as
 * one. Reimplemented here rather than imported — webhook-service imports this
 * module for the สรุปยอดขาย command, and the cycle would be worse than the
 * duplication.
 */
function isCompleteProduceMessage(text: string): boolean {
  const lines = text.normalize("NFC").split("\n").map((line) => line.trim());
  const hasHeader = lines.some((line) => !RE.SESSION_END.test(line) && RE.SESSION_START.test(line));
  if (!hasHeader) return false;
  return lines.some((line) => RE.SESSION_END.test(line)) || parseWeighSession(text).items.length > 0;
}

/**
 * Produce messages that were understood and then vanished.
 *
 * The evidence here is an ABSENCE, which is what makes it durable: raw_messages
 * is written before parsing and is never rolled back, and the webhook marks
 * is_processed only once the produce has actually landed (or has been proven a
 * duplicate). So a complete single-message produce entry that is still
 * unprocessed, has no produce_session and no parse_errors row, is produce that
 * was rejected without leaving a trace — including the case where the
 * parse_errors write itself failed. No extra write can be lost, because no
 * extra write is required.
 *
 * Header-only messages and pending appends are excluded by the predicate above;
 * the pending-session scan already covers those.
 *
 * The scan has NO created_at bound in either direction. Production contains
 * complete produce messages sent BEFORE the date their header names, so a lower
 * bound would discard real evidence; the explicit produce date is authoritative
 * and every candidate is parsed before it is attributed. The only server-side
 * narrowing is a provable SUPERSET of RE.SESSION_START (see
 * PRODUCE_TEXT_FILTER), which cannot exclude a produce message.
 */
interface LostProduceCandidate {
  id: string;
  sourceId: string | null;
  rawText: string | null;
  attempt: ProduceFailureAttempt;
}

async function scanLostProduceMessages(
  supabase: Supabase,
  businessDate: string,
): Promise<LostProduceCandidate[]> {
  const { data: rejectedDeferred, error: deferredError } = await supabase
    .from("pending_produce_deferred_events")
    .select("raw_message_id, source_id, raw_text, line_timestamp_ms, status")
    .in("status", [
      "rejected_orphan",
      "rejected_before_opener",
      "rejected_after_close",
    ]);
  if (deferredError) {
    throw new SalesDataError(
      `deferred Produce evidence lookup failed: ${deferredError.message}`,
    );
  }
  const deferredLost: LostProduceCandidate[] = (rejectedDeferred ?? [])
    .filter((row) => row.status.startsWith("rejected_")
      && isCompleteProduceMessage(row.raw_text)
      && produceBusinessDate(row.raw_text, row.line_timestamp_ms) === businessDate)
    .map((row) => ({
      id: row.raw_message_id,
      sourceId: row.source_id,
      rawText: row.raw_text,
      attempt: rawMessageFailureAttempt(
        {
          id: row.raw_message_id,
          raw_text: row.raw_text,
          source_id: row.source_id,
        },
        row.line_timestamp_ms,
        businessDate,
      ),
    }));

  const candidates = await fetchAllScopeRows<{
    id: string;
    raw_text: string | null;
    payload: unknown;
    created_at: string | null;
    source_id: string | null;
  }>("lost produce message", (from, to) =>
    supabase
      .from("raw_messages")
      .select("id, raw_text, payload, created_at, source_id")
      .eq("is_processed", false)
      .eq("message_type", "text")
      .or(PRODUCE_TEXT_FILTER)
      .order("id", { ascending: true })
      .range(from, to),
  );

  const lost: Array<{
    row: (typeof candidates)[number];
    eventTimestampMs: number | null;
    date: string | null;
  }> = [];
  for (const row of candidates) {
    if (!row.raw_text || !isCompleteProduceMessage(row.raw_text)) continue;
    const eventTimestampMs = lineEventTimestampMs(row.payload, row.created_at);
    const date = produceBusinessDate(row.raw_text, eventTimestampMs);
    if (date !== null && date !== businessDate) continue;
    lost.push({ row, eventTimestampMs, date });
  }
  if (lost.length === 0) return deferredLost;

  const accounted = await accountedProduceMessages(
    supabase,
    lost.map((entry) => entry.row),
  );

  const completeLost = lost
    .filter((entry) => !accounted.has(entry.row.id))
    .map((entry) => ({
      id: entry.row.id,
      sourceId: entry.row.source_id,
      rawText: entry.row.raw_text,
      attempt: rawMessageFailureAttempt(
        { id: entry.row.id, raw_text: entry.row.raw_text, source_id: entry.row.source_id },
        entry.eventTimestampMs,
        entry.date,
      ),
    }));
  return [...completeLost, ...deferredLost];
}

/**
 * Lost produce messages that are STILL lost.
 *
 * A rejected message the seller corrected and re-sent successfully stays in
 * raw_messages forever (nothing rewrites is_processed retroactively), and it
 * used to be announced every morning as an unrecorded weighing. It is now
 * dropped here — and only here, in the reporting layer. The row itself, and
 * every other piece of audit evidence, is untouched.
 */
function auditLostProduceMessages(
  failures: ProduceFailureScan,
): SalesSessionAudit[] {
  return failures.lostMessages
    .filter((row) => failures.activeIds.has(row.attempt.attemptId))
    .map((row) => ({
      sessionId: `raw:${row.id}`,
      sourceId: row.sourceId,
      marketName: normalizedMarketLabel(parseWeighSession(row.rawText ?? "").session_title) || null,
      reasons: ["produce_message_never_landed"] as const,
    }));
}

/**
 * Which candidates are provably accounted for.
 *
 *   1. a produce_session exists for THIS raw message — it landed;
 *   2. a parse_errors row exists for THIS raw message — the parse-error path
 *      already reports it, and counting it twice would inflate the day;
 *   3. DUPLICATE PROOF: imported_sessions holds this exact session hash AND
 *      every one of the candidate's items is present in produce_items.
 *
 * Rule 3 is the deployed ingestion rule, both halves of it. The webhook trusts
 * a dedup reservation only when hasPersistedItems() confirms it is not a ghost
 * (see runParser: an unbacked reservation is released and the session is NOT
 * treated as a duplicate), so a session hash alone proves nothing here either.
 *
 * The item half is deliberately STRICTER than hasPersistedItems, which asks
 * only whether ANY item hash exists. "Any" is a sound ghost check next to a
 * matching session hash, but it is not proof that a whole session landed: a
 * candidate with items A and B, of which only A was ever persisted, would be
 * excused while B stayed missing. Every item must be represented, counting
 * multiplicity so two identical lines need two persisted rows.
 *
 * A candidate with no items cannot be proven this way and stays blocked.
 * computeSessionHash / computeItemHash come verbatim from the deployed
 * SessionDedupService — no new hash semantics.
 *
 * Nothing is written and no flag is repaired: a historical row whose
 * is_processed update never happened is recognised by its hashes, not its state.
 */
async function accountedProduceMessages(
  supabase: Supabase,
  candidates: readonly { id: string; raw_text: string | null }[],
): Promise<Set<string>> {
  const accounted = new Set<string>();

  for (const chunk of chunks(candidates.map((row) => row.id), LOOKUP_CHUNK_SIZE)) {
    const [sessions, errors] = await Promise.all([
      supabase.from("produce_sessions").select("raw_message_id").in("raw_message_id", chunk),
      supabase.from("parse_errors").select("raw_message_id").in("raw_message_id", chunk),
    ]);
    if (sessions.error) {
      throw new SalesDataError(`lost produce session lookup failed: ${sessions.error.message}`);
    }
    if (errors.error) {
      throw new SalesDataError(`lost produce error lookup failed: ${errors.error.message}`);
    }
    for (const row of sessions.data ?? []) accounted.add(row.raw_message_id);
    for (const row of errors.data ?? []) accounted.add(row.raw_message_id);
  }

  const unexplained = candidates
    .filter((row) => !accounted.has(row.id))
    .map((row) => {
      const parsed = parseWeighSession(row.raw_text ?? "");
      // Both identities: rows imported before the canonical business
      // fingerprint shipped are reserved under the legacy hash and must keep
      // proving themselves, or every one of them becomes a false "lost produce".
      // The same applies to price: a message whose quantity line was in ขีด and
      // that landed before the subunit price fix has item hashes built from the
      // old rescaled price, so that reading has to stay provable too. Either
      // variant proving itself in full is proof the produce landed.
      const legacyPriced = legacySubunitPricedSession(parsed);
      const itemHashVariants = [
        parsed.items.map((item) => computeItemHash(parsed, item)),
        ...(legacyPriced
          ? [legacyPriced.items.map((item) => computeItemHash(legacyPriced, item))]
          : []),
      ];
      return { id: row.id, sessionHashes: sessionHashCandidates(parsed), itemHashVariants };
    })
    // No items → nothing to prove landed. Fail closed.
    .filter((row) => row.itemHashVariants[0].length > 0);
  if (unexplained.length === 0) return accounted;

  const importedSessionHashes = new Set<string>();
  for (const chunk of chunks([...new Set(unexplained.flatMap((row) => row.sessionHashes))], LOOKUP_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from("imported_sessions")
      .select("session_hash")
      .in("session_hash", chunk);
    if (error) throw new SalesDataError(`imported session lookup failed: ${error.message}`);
    for (const row of data ?? []) importedSessionHashes.add(row.session_hash);
  }

  const reserved = unexplained.filter((row) =>
    row.sessionHashes.some((hash) => importedSessionHashes.has(hash)));
  if (reserved.length === 0) return accounted;

  // Persisted rows per item hash, so multiplicity is respected.
  const persistedCounts = new Map<string, number>();
  const wanted = [...new Set(reserved.flatMap((row) => row.itemHashVariants.flat()))];
  for (const chunk of chunks(wanted, LOOKUP_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from("produce_items")
      .select("item_hash")
      .in("item_hash", chunk);
    if (error) throw new SalesDataError(`produce item hash lookup failed: ${error.message}`);
    for (const row of data ?? []) {
      const hash = row.item_hash ?? "";
      persistedCounts.set(hash, (persistedCounts.get(hash) ?? 0) + 1);
    }
  }

  for (const row of reserved) {
    const complete = row.itemHashVariants.some((variant) => {
      const needed = new Map<string, number>();
      for (const hash of variant) needed.set(hash, (needed.get(hash) ?? 0) + 1);

      return [...needed].every(([hash, count]) => (persistedCounts.get(hash) ?? 0) >= count);
    });
    if (complete) accounted.add(row.id);
  }

  return accounted;
}

/**
 * Active sessions with NO session_date.
 *
 * transaction_date is derived from session_date, so a null-dated session is
 * invisible to the transaction query AND to the date-scoped audit above — its
 * produce would simply not exist for any report. The schema allows NULL, so P1
 * looks for them explicitly rather than trusting that Production has none.
 *
 * Each one is dated from its own raw message (explicit header date, else the
 * LINE event timestamp) and only blocks the date that evidence names — an
 * unrelated null-dated session must not demote every historical report. When no
 * evidence can date it at all, it blocks the requested date: unattributable
 * produce is exactly what fail-closed exists for.
 */
async function auditNullDatedSessions(
  supabase: Supabase,
  businessDate: string,
): Promise<SalesSessionAudit[]> {
  const { data, error } = await supabase
    .from("produce_sessions")
    .select("id, session_title, total_items, raw_message_id, voided_at, session_date")
    .is("session_date", null)
    .is("voided_at", null);
  if (error) throw new SalesDataError(`null-dated session audit query failed: ${error.message}`);

  // The null check is re-applied client-side: this audit must only ever see
  // rows the server filter selected, never a dated session by accident.
  const sessions = (data ?? []).filter(
    (session) => session.session_date === null && (session.total_items ?? 0) > 0,
  );
  if (sessions.length === 0) return [];

  const messageIds = sessions
    .map((session) => session.raw_message_id)
    .filter((id): id is string => Boolean(id));
  const evidence = await fetchRawMessageEvidence(
    supabase,
    messageIds,
    "null-dated session message lookup",
  );
  const sources = await mapRawMessageSources(supabase, [...new Set(messageIds)]);

  const audits: SalesSessionAudit[] = [];
  for (const session of sessions) {
    const message = session.raw_message_id ? evidence.get(session.raw_message_id) : undefined;
    const date = message
      ? produceBusinessDate(message.rawText, message.eventTimestampMs)
      : null;
    if (date !== null && date !== businessDate) continue;

    audits.push({
      sessionId: session.id,
      sourceId: session.raw_message_id ? sources.get(session.raw_message_id) ?? null : null,
      marketName: normalizedMarketLabel(session.session_title) || null,
      reasons: ["session_date_missing"],
    });
  }

  return audits;
}

/**
 * Adapts persisted rows to calculator input.
 *
 * The market label is resolved through the SAME normalizedMarketLabel boundary
 * the White Sheet uses, and it is only ever half of the identity — the other
 * half is the LINE source that produced the session. A row missing either half
 * is passed through with a null source so the calculator keys it by session and
 * blocks it; it is never merged into a market it might not belong to.
 */
function adaptRows(
  rows: readonly ProduceTransactionRow[],
  sourceByRawMessageId: ReadonlyMap<string, string>,
  sessionIssues: ReadonlyMap<string, SalesBlockReason[]>,
): SalesSourceRow[] {
  return rows.map((row) => {
    const marketLabel = normalizedMarketLabel(row.market_name);
    const rawUnit = row.unit?.trim() ?? "";
    const enteredPriceBaht =
      row.base_transaction_type?.trim() === "เบิก"
      && rawUnit
      && row.price_per_unit !== null
        ? resolveWithdrawalUnitPriceBaht({
            unit: rawUnit,
            unitPrice: Number(row.price_per_unit),
            basisQuantity: row.basis_quantity === null ? null : Number(row.basis_quantity),
          })
        : null;
    const enteredPriceSatang = enteredPriceBaht === null
      ? null
      : Math.round(enteredPriceBaht * 100);
    return {
      sourceId: sourceByRawMessageId.get(row.raw_message_id) ?? null,
      accountabilityRoundId: row.accountability_round_id ?? null,
      marketName: marketLabel || null,
      sessionId: row.session_id,
      sessionKind: row.session_kind,
      productName: row.product_name,
      unit: row.unit,
      quantity: row.quantity === null ? null : Number(row.quantity),
      transactionType: row.transaction_type,
      enteredPriceSatang:
        enteredPriceSatang !== null
        && Number.isSafeInteger(enteredPriceSatang)
        && enteredPriceSatang >= 0
          ? enteredPriceSatang
          : null,
      sessionIssues: sessionIssues.get(row.session_id),
    };
  });
}

export interface LoadSalesReportOptions {
  /**
   * Include known QA/test market scopes. Default false: production reports —
   * automatic and manual alike — exclude them. Audit paths pass true to see
   * the raw picture; nothing is ever deleted or repaired either way.
   */
  includeQaScopes?: boolean;
  /**
   * An already-loaded failure scan. The cron routes build one for the Daily
   * Close Preflight and hand it here so the report and the preflight are
   * computed from the SAME classification, not two independent scans.
   */
  failures?: ProduceFailureScan;
  /** Already-loaded date rows, used by cron paths to avoid a duplicate page scan. */
  rows?: ProduceTransactionRow[];
}

export async function loadSalesReport(
  supabase: Supabase,
  businessDate: string,
  options: LoadSalesReportOptions = {},
): Promise<SalesReport> {
  // Strict: a day that never existed (2026-02-31) would silently return an
  // empty, apparently clean report for a date nothing can ever be filed under.
  if (!isStrictBusinessDate(businessDate)) {
    throw new SalesDataError("businessDate must be a real ISO date (YYYY-MM-DD)");
  }

  const rows = options.rows ?? (await fetchSalesProduceRows(supabase, businessDate));
  const rawMessageIds = [...new Set(rows.map((row) => row.raw_message_id))];

  // Loaded once and shared: the scope blockers and the session audits must
  // agree on which failures are still active, or the header count and the
  // detail list stop reconciling.
  const failures = options.failures ?? (await loadProduceFailureScan(supabase, businessDate));

  const [sourceByRawMessageId, sessionIssues, scopeBlockers, pricing] = await Promise.all([
    mapRawMessageSources(supabase, rawMessageIds),
    loadSessionIssues(supabase, rows),
    loadScopeBlockers(supabase, businessDate, failures),
    // Legacy fallback only. Entered round prices stay authoritative when present.
    resolveCentralPricesForDate(supabase, businessDate, rows),
  ]);

  const sessionAudits = await loadSessionAudits(
    supabase,
    businessDate,
    rows,
    sourceByRawMessageId,
    failures,
  );

  // P2E round identity: the canonical market label for display, the rounds
  // whose ชั่งคืน is unfinished, and the rounds that already have a persisted
  // return. The last one is what stops a withdrawn product omitted from that
  // return from being reported as a confident sold-out sale.
  const roundStatuses = await loadRoundReturnStatuses(supabase, businessDate);

  // QA scopes are dropped HERE, before the calculator sees them, so they can
  // never reach a rollup, a trusted/blocked count or a blocker list. Hiding
  // them at render time would leave them inside the totals.
  const keep = options.includeQaScopes
    ? () => true
    : (marketName: string | null) => !isQaMarketLabel(marketName);

  return calculateSalesReport({
    businessDate,
    rows: adaptRows(rows, sourceByRawMessageId, sessionIssues).filter((row) =>
      keep(row.marketName),
    ),
    centralPrices: pricing.prices,
    priceConflicts: pricing.conflicts,
    scopeBlockers,
    sessionAudits: sessionAudits.filter((audit) => keep(audit.marketName)),
    roundMarketLabels: new Map(
      roundStatuses
        .filter((round) => round.marketLabel)
        .map((round) => [round.accountabilityRoundId, round.marketLabel]),
    ),
    incompleteReturnRounds: new Set([
      ...roundsWithIncompleteReturn(roundStatuses),
      ...activeIncompleteReturnRoundIds(failures.attempts, failures.classifications),
    ]),
    persistedReturnRounds: roundsWithPersistedReturn(roundStatuses),
  });
}
