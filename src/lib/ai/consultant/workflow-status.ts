/**
 * READ-ONLY inspection of Produce documents (เบิก / ชั่งคืน / คืนเสีย) for the
 * @Botsummary AI Consultant.
 *
 * Authorization is enforced HERE, inside every query, before any row leaves
 * the database:
 *   own         .eq(line_user_id).eq(source_id) on the pending_sessions query
 *   supervisor  .in(source_id, allowlisted chats); a named staff member is
 *               matched in memory after the bounded query
 * A staff name always goes through authorizeStaffQuery first; `denied` returns
 * `{ status: "forbidden" }` without touching anyone else's rows. Identity and
 * chat ids come only from the ConsultantScope, never from tool arguments.
 *
 * Evidence rules:
 *   - "received" is not "saved": persisted is true only when the pending row is
 *     finalized AND its produce_sessions row is proven (see proveProduceSessions).
 *   - Callers never receive accumulated_text, raw source lines, session keys or
 *     generations. The reference is a short one-way hash.
 *   - Every call re-reads the database. Nothing is cached.
 *   - A database error yields `{ status: "unavailable" }`, never raw error text
 *     and never a guessed state.
 *
 * Runtime environment: rows are filtered to scope.runtimeEnvironment. Legacy
 * rows with runtime_environment NULL are treated as production, exactly like
 * the finalizer / inactivity / refused-close sweeps
 * (20260817080439, 20260915170000), so Preview never sees them.
 */

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import type { ProducePartialCapture, ProducePartialCaptureIssue } from "@/lib/produce/partial-capture";
import { authorizeStaffQuery, normalizeStaffName } from "./authorization";
import {
  diagnoseSubmission,
  TRANSACTION_KIND_THAI,
  type ProduceSessionProof,
  type ProduceTransactionKind,
  type SubmissionBlocker,
  type SubmissionDiagnosis,
  type SubmissionFacts,
  type SubmissionHeader,
} from "./diagnostics";
import type { ConsultantScope, SubmissionLifecycleState } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

export const MAX_SUBMISSION_ROWS = 20;
export const MAX_STAFF_SEARCH_ROWS = 200;
export const DEFAULT_LOOKBACK_DAYS = 3;
/** Two documents touched this close together are "equally plausible" latest. */
export const SIMULTANEOUS_WINDOW_MS = 60_000;

const DAY_MS = 24 * 60 * 60 * 1000;
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

/**
 * Columns read from pending_sessions. accumulated_text is read ONLY to derive
 * header facts (date / staff / market / kind) for plain-text rows that have no
 * current capture snapshot; it is never returned.
 */
const PENDING_COLUMNS = [
  "session_key",
  "session_generation",
  "source_id",
  "line_user_id",
  "created_at",
  "updated_at",
  "terminalized",
  "finalization_status",
  "finalization_error",
  "finalized_produce_session_id",
  "close_requested_at",
  "close_event_timestamp_ms",
  "close_refused_at",
  "close_refused_session_generation",
  "next_attempt_at",
  "finalize_hold_until",
  "finalize_confirmed_at",
  "entry_origin",
  "business_date",
  "staff_label",
  "market_label",
  "initial_transaction_type",
  "declared_transaction_type",
  "runtime_environment",
  "ingest_revision",
  "partial_capture",
  "partial_capture_revision",
  "partial_capture_updated_at",
  "accumulated_text",
].join(", ");

const PRODUCE_COLUMNS =
  "id, ingest_idempotency_key, voided_at, replacement_session_id, total_items, session_date, staff_name, session_title";

interface PendingRow {
  session_key: string;
  session_generation: string;
  source_id: string;
  line_user_id: string | null;
  created_at: string;
  updated_at: string;
  terminalized: boolean | null;
  finalization_status: string | null;
  finalization_error: unknown;
  finalized_produce_session_id: string | null;
  close_requested_at: string | null;
  close_event_timestamp_ms: number | null;
  close_refused_at: string | null;
  close_refused_session_generation: string | null;
  next_attempt_at: string | null;
  finalize_hold_until: string | null;
  finalize_confirmed_at: string | null;
  entry_origin: string | null;
  business_date: string | null;
  staff_label: string | null;
  market_label: string | null;
  initial_transaction_type: string | null;
  declared_transaction_type: string | null;
  runtime_environment: string | null;
  ingest_revision: number | null;
  partial_capture: unknown;
  partial_capture_revision: number | null;
  partial_capture_updated_at: string | null;
  accumulated_text: string | null;
}

interface ProduceRow {
  id: string;
  ingest_idempotency_key: string | null;
  voided_at: string | null;
  replacement_session_id: string | null;
  total_items: number | null;
  session_date: string | null;
  staff_name: string | null;
  session_title: string | null;
}

// ── Public result types ─────────────────────────────────────────────────────

export interface SubmissionEvidence extends SubmissionDiagnosis {
  /** Stable opaque id: short hash of the document identity. */
  reference: string;
  businessDate: string | null;
  staff: string | null;
  market: string | null;
  transactionKind: ProduceTransactionKind | null;
  /** เบิก / ชั่งคืน / คืนเสีย, or null when the kind cannot be proven. */
  transactionKindThai: string | null;
  /** Last change to the document (ISO). */
  updatedAt: string;
}

/** Short form used to ask "which one did you mean?". */
export interface SubmissionCandidate {
  reference: string;
  businessDate: string | null;
  staff: string | null;
  market: string | null;
  transactionKindThai: string | null;
  state: SubmissionLifecycleState;
  updatedAt: string;
}

export type WorkflowReadFailure =
  /** A non-supervisor asked about another worker. Nothing was queried. */
  | { status: "forbidden" }
  /** The database could not be read. No state is claimed. */
  | { status: "unavailable" }
  /** An argument (date, item number) was malformed. Nothing was queried. */
  | { status: "invalid_request"; field: "businessDate" | "itemNumber" };

export type LatestSubmissionResult =
  | { status: "ok"; submission: SubmissionEvidence }
  | { status: "none" }
  | {
      status: "ambiguous";
      reason: "simultaneous_documents" | "item_in_multiple_documents";
      candidates: SubmissionCandidate[];
    }
  | WorkflowReadFailure;

export type PendingSubmissionsResult =
  | { status: "ok"; submissions: SubmissionEvidence[]; truncated: boolean }
  | WorkflowReadFailure;

export type SubmissionDiagnosisResult =
  | {
      status: "ok";
      submission: SubmissionEvidence;
      /** Present when an item number was asked about. */
      requestedItem?: {
        itemNumber: number;
        /** blocker: listed in blockers; accepted: understood fine; not_found: no evidence either way. */
        status: "blocker" | "accepted" | "not_found";
      };
    }
  | Exclude<LatestSubmissionResult, { status: "ok" }>;

export interface SubmissionQueryOptions {
  /** Staff name as asked ("น้อย"). Authorized via authorizeStaffQuery. */
  staff?: string;
  /** YYYY-MM-DD business date. Without it the lookback is DEFAULT_LOOKBACK_DAYS. */
  businessDate?: string;
  transactionKind?: ProduceTransactionKind;
  /** Test seam for the clock. */
  now?: number;
}

export interface SubmissionDiagnosisOptions extends SubmissionQueryOptions {
  itemNumber?: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function bangkokDayStartMs(isoDate: string): number {
  return Date.parse(`${isoDate}T00:00:00.000Z`) - BANGKOK_OFFSET_MS;
}

function bangkokDate(ms: number): string {
  return new Date(ms + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

export function submissionReference(sessionKey: string, sessionGeneration: string): string {
  return createHash("sha256").update(`${sessionKey}:${sessionGeneration}`).digest("hex").slice(0, 10);
}

function failureReason(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const reason = (value as Record<string, unknown>).reason;
  return typeof reason === "string" && reason ? reason : null;
}

function kindFromThai(value: string | null | undefined): ProduceTransactionKind | null {
  switch (value?.trim()) {
    case "เบิก":
    case "เบิกเพิ่ม":
      return "withdrawal";
    case "คืน":
    case "ชั่งคืน":
      return "return";
    case "คืนเสีย":
      return "damaged_return";
    default:
      return null;
  }
}

/** One kind for the whole document, or null when the lines disagree. */
function kindFromItems(types: Array<string | null | undefined>): ProduceTransactionKind | null {
  const kinds = new Set(types.map(kindFromThai));
  if (kinds.size !== 1) return null;
  return [...kinds][0] ?? null;
}

function cleanLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > 40 ? null : trimmed;
}

function asCapture(value: unknown): ProducePartialCapture | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const capture = value as Partial<ProducePartialCapture>;
  if (capture.version !== 1 || !Array.isArray(capture.items) || !Array.isArray(capture.issues)) return null;
  return capture as ProducePartialCapture;
}

/**
 * The snapshot describes THIS generation only if it was evaluated at the
 * current ingest_revision. A generation rotation resets ingest_revision and
 * created_at but does not clear partial_capture, so both fences are checked.
 */
function currentCapture(row: PendingRow): ProducePartialCapture | null {
  const capture = asCapture(row.partial_capture);
  if (!capture) return null;
  if (row.partial_capture_revision == null || row.ingest_revision == null) return null;
  if (Number(row.partial_capture_revision) !== Number(row.ingest_revision)) return null;
  const savedAt = row.partial_capture_updated_at ? Date.parse(row.partial_capture_updated_at) : NaN;
  const openedAt = Date.parse(row.created_at);
  if (Number.isFinite(savedAt) && Number.isFinite(openedAt) && savedAt < openedAt) return null;
  return capture;
}

const ISSUE_THAI: Record<string, { kindThai: string; detailThai: string }> = {
  parse_error: {
    kindThai: "อ่านรายการไม่ได้",
    detailThai: "ระบบอ่านข้อนี้ไม่ได้ ราคาหรือจำนวนอาจพิมพ์ไม่ครบหรือสะกดผิด",
  },
  unknown_unit: {
    kindThai: "หน่วยไม่ถูกต้อง",
    detailThai: "ระบบไม่รู้จักหน่วยที่พิมพ์ในข้อนี้",
  },
  subunit_confirmation: {
    kindThai: "ต้องยืนยันจำนวน",
    detailThai: "จำนวนเป็นขีดหรือกรัม ต้องยืนยันการแปลงหน่วยก่อน",
  },
  price_not_withdrawn: {
    kindThai: "ราคาไม่ตรงกับตอนเบิก",
    detailThai: "ราคาที่ส่งต่างจากราคาตอนเบิก",
  },
};

/** "22.กล้วยน้ำหว้า15บาม" → "กล้วยน้ำหว้า". Only Thai names survive. */
function productNameFromParseDetail(detail: string): string | null {
  const quoted = detail.match(/"([^"]+)"/)?.[1];
  if (!quoted) return null;
  const name = quoted.replace(/^\s*\d+\s*[.)]\s*/u, "").match(/^[^\d]+/u)?.[0]?.trim() ?? "";
  if (!name || /[A-Za-z]/.test(name) || name.length > 40) return null;
  return name;
}

function blockerFromIssue(
  issue: ProducePartialCaptureIssue,
  capture: ProducePartialCapture,
): SubmissionBlocker {
  const thai = ISSUE_THAI[issue.kind] ?? {
    kindThai: "ต้องตรวจ",
    detailThai: "ข้อนี้ต้องตรวจก่อนจึงจะบันทึกได้",
  };
  const parsedItem = issue.itemNumber === null
    ? null
    : capture.items.find((entry) => entry.item.item_number === issue.itemNumber)?.item ?? null;
  return {
    itemNumber: issue.itemNumber,
    productName: cleanLabel(parsedItem?.product_name)
      ?? (issue.kind === "parse_error" ? productNameFromParseDetail(issue.detail) : null),
    kind: issue.kind,
    kindThai: thai.kindThai,
    detailThai: thai.detailThai,
  };
}

function dedupeBlockers(blockers: SubmissionBlocker[]): SubmissionBlocker[] {
  const seen = new Set<string>();
  return blockers.filter((blocker) => {
    const key = `${blocker.itemNumber ?? "-"}|${blocker.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface DerivedRow {
  row: PendingRow;
  facts: SubmissionFacts;
}

function deriveFacts(row: PendingRow, proof: ProduceSessionProof, produce: ProduceRow | null): SubmissionFacts {
  const capture = currentCapture(row);
  const structured = row.entry_origin != null;

  const header: SubmissionHeader = {
    businessDate: null,
    staff: null,
    market: null,
    transactionKind: null,
  };
  let blockers: SubmissionBlocker[] = [];
  let acceptedCount: number | null = null;
  let reviewCount: number | null = null;
  let acceptedItemNumbers: number[] = [];
  let source: SubmissionFacts["capture"]["source"] = "none";

  if (structured) {
    header.businessDate = row.business_date;
    header.staff = cleanLabel(row.staff_label);
    header.market = cleanLabel(row.market_label);
    header.transactionKind = kindFromThai(row.declared_transaction_type)
      ?? kindFromThai(row.initial_transaction_type);
  }

  if (capture) {
    source = "snapshot";
    header.businessDate ??= capture.session?.date ?? null;
    header.staff ??= cleanLabel(capture.session?.staff_name);
    header.market ??= cleanLabel(capture.session?.session_title);
    header.transactionKind ??= kindFromThai(capture.session?.declared_transaction_type)
      ?? kindFromItems(capture.items.map((entry) => entry.item?.transaction_type));
    blockers = dedupeBlockers(capture.issues.map((issue) => blockerFromIssue(issue, capture)));
    acceptedCount = typeof capture.acceptedCount === "number" ? capture.acceptedCount : null;
    reviewCount = typeof capture.reviewCount === "number" ? capture.reviewCount : null;
    acceptedItemNumbers = capture.items
      .filter((entry) => entry.status === "accepted")
      .map((entry) => entry.item.item_number);
  } else if (!structured && row.accumulated_text) {
    // Read-only header recovery. No fallback date: an unparseable date stays
    // null rather than becoming "today".
    const parsed = parseWeighSession(row.accumulated_text, null);
    header.businessDate ??= parsed.date;
    header.staff ??= cleanLabel(parsed.staff_name);
    header.market ??= cleanLabel(parsed.session_title);
    header.transactionKind ??= kindFromThai(parsed.declared_transaction_type)
      ?? kindFromItems(parsed.items.map((item) => item.transaction_type));
    // Only parse failures are certain without the round master; validation
    // issues need the entry gate and are not guessed here.
    const failed = parsed.failed_item_targets ?? [];
    if (parsed.parse_errors.length > 0) {
      source = "parsed";
      blockers = dedupeBlockers(parsed.parse_errors.map((detail) => {
        const target = failed.find((candidate) => candidate.parse_error === detail);
        return {
          itemNumber: target?.item_number ?? null,
          productName: productNameFromParseDetail(detail),
          kind: "parse_error",
          kindThai: ISSUE_THAI.parse_error.kindThai,
          detailThai: ISSUE_THAI.parse_error.detailThai,
        };
      }));
    }
  }

  // A proven produce session is the authoritative header.
  if (proof.kind === "proven" && produce) {
    header.businessDate = produce.session_date ?? header.businessDate;
    header.staff = cleanLabel(produce.staff_name) ?? header.staff;
    header.market = cleanLabel(produce.session_title) ?? header.market;
  }

  const refusedForCurrentGeneration = row.close_refused_at != null
    && row.close_refused_session_generation === row.session_generation;
  const closeRequestedAt = row.close_requested_at
    ?? (row.close_event_timestamp_ms != null ? new Date(Number(row.close_event_timestamp_ms)).toISOString() : null);

  return {
    finalizationStatus: row.finalization_status,
    terminalized: row.terminalized === true,
    failureReason: failureReason(row.finalization_error),
    structured,
    closeRequestedAt,
    closeRefusedAt: refusedForCurrentGeneration ? row.close_refused_at : null,
    nextAttemptAt: row.next_attempt_at,
    finalizeHoldUntil: row.finalize_hold_until,
    finalizeConfirmedAt: row.finalize_confirmed_at,
    updatedAt: row.updated_at,
    produceSession: proof,
    capture: { acceptedCount, reviewCount, blockers, acceptedItemNumbers, source },
    header,
  };
}

function toEvidence(derived: DerivedRow, now: number): SubmissionEvidence {
  const diagnosis = diagnoseSubmission(derived.facts, now);
  const { header } = derived.facts;
  return {
    reference: submissionReference(derived.row.session_key, derived.row.session_generation),
    businessDate: header.businessDate,
    staff: header.staff,
    market: header.market,
    transactionKind: header.transactionKind,
    transactionKindThai: header.transactionKind ? TRANSACTION_KIND_THAI[header.transactionKind] : null,
    updatedAt: derived.row.updated_at,
    ...diagnosis,
  };
}

function toCandidate(evidence: SubmissionEvidence): SubmissionCandidate {
  return {
    reference: evidence.reference,
    businessDate: evidence.businessDate,
    staff: evidence.staff,
    market: evidence.market,
    transactionKindThai: evidence.transactionKindThai,
    state: evidence.state,
    updatedAt: evidence.updatedAt,
  };
}

// ── Authorized read ─────────────────────────────────────────────────────────

type LoadResult =
  | { status: "ok"; rows: DerivedRow[]; truncated: boolean }
  | WorkflowReadFailure;

/**
 * The single authorized read. Applies scope filters IN THE QUERY, then proves
 * produce persistence, then applies in-memory filters (supervisor staff name,
 * business date, kind) on derived facts.
 */
async function loadSubmissions(
  supabase: AnyClient,
  scope: ConsultantScope,
  options: SubmissionQueryOptions,
): Promise<LoadResult> {
  if (options.businessDate !== undefined && !isIsoDate(options.businessDate)) {
    return { status: "invalid_request", field: "businessDate" };
  }

  let staffFilter: string | null = null;
  // "รายการของผม" from a supervisor is still their own; others only by name.
  let selfOnly = true;
  if (options.staff !== undefined && options.staff.trim() !== "") {
    const verdict = authorizeStaffQuery(scope, options.staff);
    if (verdict === "denied") return { status: "forbidden" };
    if (verdict === "allowed") {
      selfOnly = false;
      staffFilter = normalizeStaffName(options.staff);
    }
  }

  if (scope.kind === "supervisor" && scope.sourceIds.length === 0) {
    return { status: "ok", rows: [], truncated: false };
  }

  const now = options.now ?? Date.now();
  const sinceMs = options.businessDate
    ? bangkokDayStartMs(options.businessDate) - DAY_MS
    : bangkokDayStartMs(bangkokDate(now)) - (DEFAULT_LOOKBACK_DAYS - 1) * DAY_MS;
  const untilMs = options.businessDate
    ? bangkokDayStartMs(options.businessDate) + 4 * DAY_MS
    : null;

  let rows: PendingRow[];
  try {
    let query = supabase.from("pending_sessions").select(PENDING_COLUMNS);
    if (scope.kind === "own") {
      query = query.eq("line_user_id", scope.lineUserId).eq("source_id", scope.sourceId);
    } else {
      query = query.in("source_id", [...scope.sourceIds]);
      if (selfOnly) query = query.eq("line_user_id", scope.lineUserId);
    }
    query = scope.runtimeEnvironment === "production"
      ? query.or("runtime_environment.eq.production,runtime_environment.is.null")
      : query.eq("runtime_environment", scope.runtimeEnvironment);
    query = query.gte("updated_at", new Date(sinceMs).toISOString());
    if (untilMs !== null) query = query.lt("updated_at", new Date(untilMs).toISOString());

    // ponytail: the staff name is matched in memory (labels live in jsonb or
    // free text), so a named search reads a wider bounded window.
    const { data, error } = await query
      .order("updated_at", { ascending: false })
      .limit(staffFilter === null ? MAX_SUBMISSION_ROWS : MAX_STAFF_SEARCH_ROWS);
    if (error) return { status: "unavailable" };
    rows = (data ?? []) as unknown as PendingRow[];
  } catch {
    return { status: "unavailable" };
  }

  // Defense in depth: never trust that the client honored the filters.
  rows = rows.filter((row) => scope.kind === "own"
    ? row.line_user_id === scope.lineUserId && row.source_id === scope.sourceId
    : scope.sourceIds.includes(row.source_id) && (!selfOnly || row.line_user_id === scope.lineUserId));
  rows.sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));

  const proofs = await proveProduceSessions(supabase, rows);
  if (proofs === null) return { status: "unavailable" };

  let derived: DerivedRow[];
  try {
    derived = rows.map((row) => {
      const proof = proofs.get(row.session_key) ?? { proof: { kind: "not_checked" } as const, produce: null };
      return { row, facts: deriveFacts(row, proof.proof, proof.produce) };
    });
  } catch {
    // A malformed stored document must not crash the consultant or leak detail.
    return { status: "unavailable" };
  }

  if (staffFilter !== null) {
    derived = derived.filter(({ facts }) =>
      facts.header.staff !== null && normalizeStaffName(facts.header.staff) === staffFilter);
  }
  if (options.businessDate) {
    derived = derived.filter(({ row, facts }) =>
      (facts.header.businessDate ?? bangkokDate(Date.parse(row.created_at))) === options.businessDate);
  }
  if (options.transactionKind) {
    derived = derived.filter(({ facts }) => facts.header.transactionKind === options.transactionKind);
  }

  const limit = staffFilter === null ? MAX_SUBMISSION_ROWS : MAX_STAFF_SEARCH_ROWS;
  return { status: "ok", rows: derived, truncated: rows.length >= limit };
}

/**
 * Prove produce_sessions rows for finalized / duplicate generations.
 *
 *   finalized  finalized_produce_session_id must resolve to a row whose
 *              ingest_idempotency_key is NULL (legacy) or exactly
 *              `<session_key>:<session_generation>` — the identity the
 *              finalizer writes (produceIngestIdempotencyKey). Anything else
 *              is `missing`, which diagnoses as unknown, never finalized.
 *   duplicate  proven only by a row carrying THIS generation's ingest key
 *              (idempotent replay). A content-hash duplicate proves nothing
 *              about this generation (see guided-menu/produce-finalization.ts).
 *
 * Returns null on any read error.
 */
async function proveProduceSessions(
  supabase: AnyClient,
  rows: PendingRow[],
): Promise<Map<string, { proof: ProduceSessionProof; produce: ProduceRow | null }> | null> {
  const out = new Map<string, { proof: ProduceSessionProof; produce: ProduceRow | null }>();
  const ingestKey = (row: PendingRow) => `${row.session_key}:${row.session_generation}`;

  const finalized = rows.filter((row) => row.finalization_status === "finalized");
  const duplicates = rows.filter((row) => row.finalization_status === "duplicate");

  const toProof = (produce: ProduceRow): ProduceSessionProof => ({
    kind: "proven",
    totalItems: Number(produce.total_items ?? 0),
    voided: produce.voided_at != null,
    replaced: produce.replacement_session_id != null,
  });

  try {
    const ids = [...new Set(finalized.flatMap((row) =>
      row.finalized_produce_session_id ? [row.finalized_produce_session_id] : []))];
    let byId = new Map<string, ProduceRow>();
    if (ids.length > 0) {
      const { data, error } = await supabase.from("produce_sessions").select(PRODUCE_COLUMNS).in("id", ids);
      if (error) return null;
      byId = new Map(((data ?? []) as ProduceRow[]).map((produce) => [produce.id, produce]));
    }
    for (const row of finalized) {
      const produce = row.finalized_produce_session_id ? byId.get(row.finalized_produce_session_id) : undefined;
      const identityOk = produce
        && (produce.ingest_idempotency_key == null || produce.ingest_idempotency_key === ingestKey(row));
      out.set(row.session_key, produce && identityOk
        ? { proof: toProof(produce), produce }
        : { proof: { kind: "missing" }, produce: null });
    }

    const keys = duplicates.map(ingestKey);
    if (keys.length > 0) {
      const { data, error } = await supabase
        .from("produce_sessions")
        .select(PRODUCE_COLUMNS)
        .in("ingest_idempotency_key", keys);
      if (error) return null;
      const byKey = new Map(((data ?? []) as ProduceRow[]).map((produce) => [produce.ingest_idempotency_key, produce]));
      for (const row of duplicates) {
        const produce = byKey.get(ingestKey(row));
        out.set(row.session_key, produce
          ? { proof: toProof(produce), produce }
          : { proof: { kind: "not_checked" }, produce: null });
      }
    }
  } catch {
    return null;
  }
  return out;
}

// ── Public API ──────────────────────────────────────────────────────────────

function pickLatest(evidence: SubmissionEvidence[]): LatestSubmissionResult {
  if (evidence.length === 0) return { status: "none" };
  const [first, second] = evidence;
  if (second) {
    const gap = Math.abs(Date.parse(first!.updatedAt) - Date.parse(second.updatedAt));
    const sameDocumentShape = first!.staff === second.staff
      && first!.market === second.market
      && first!.transactionKind === second.transactionKind;
    if (gap <= SIMULTANEOUS_WINDOW_MS && !sameDocumentShape) {
      const close = evidence.filter((entry) =>
        Math.abs(Date.parse(first!.updatedAt) - Date.parse(entry.updatedAt)) <= SIMULTANEOUS_WINDOW_MS);
      return { status: "ambiguous", reason: "simultaneous_documents", candidates: close.map(toCandidate) };
    }
  }
  return { status: "ok", submission: first! };
}

/** Most recent document in scope, or the equally-plausible candidates. */
export async function getLatestSubmissionStatus(
  supabase: AnyClient,
  scope: ConsultantScope,
  options: SubmissionQueryOptions = {},
): Promise<LatestSubmissionResult> {
  const loaded = await loadSubmissions(supabase, scope, options);
  if (loaded.status !== "ok") return loaded;
  const now = options.now ?? Date.now();
  return pickLatest(loaded.rows.map((row) => toEvidence(row, now)));
}

const FINISHED_STATES: ReadonlySet<SubmissionLifecycleState> = new Set([
  "finalized",
  "duplicate_already_saved",
  "expired_empty",
  "cancelled_or_superseded",
]);

/**
 * Documents that are not finished: still open, waiting, failed, or unknown.
 * An unproven "finalized" row is `unknown` and therefore listed here.
 */
export async function getPendingSubmissions(
  supabase: AnyClient,
  scope: ConsultantScope,
  options: Omit<SubmissionQueryOptions, "transactionKind"> = {},
): Promise<PendingSubmissionsResult> {
  const loaded = await loadSubmissions(supabase, scope, options);
  if (loaded.status !== "ok") return loaded;
  const now = options.now ?? Date.now();
  const submissions = loaded.rows
    .map((row) => toEvidence(row, now))
    .filter((evidence) => !FINISHED_STATES.has(evidence.state));
  return { status: "ok", submissions, truncated: loaded.truncated };
}

/**
 * Blockers and next steps for the latest document, or for the one document
 * whose blockers include `itemNumber`.
 */
export async function getSubmissionDiagnosis(
  supabase: AnyClient,
  scope: ConsultantScope,
  options: SubmissionDiagnosisOptions = {},
): Promise<SubmissionDiagnosisResult> {
  const { itemNumber } = options;
  if (itemNumber !== undefined && (!Number.isInteger(itemNumber) || itemNumber < 1 || itemNumber > 999)) {
    return { status: "invalid_request", field: "itemNumber" };
  }
  const loaded = await loadSubmissions(supabase, scope, options);
  if (loaded.status !== "ok") return loaded;
  const now = options.now ?? Date.now();
  const derived = loaded.rows;
  const evidence = derived.map((row) => toEvidence(row, now));

  if (itemNumber === undefined) return pickLatest(evidence);

  const containing = evidence.filter((entry) =>
    entry.blockers.some((blocker) => blocker.itemNumber === itemNumber));
  if (containing.length > 1) {
    return { status: "ambiguous", reason: "item_in_multiple_documents", candidates: containing.map(toCandidate) };
  }
  if (containing.length === 1) {
    return { status: "ok", submission: containing[0]!, requestedItem: { itemNumber, status: "blocker" } };
  }

  const latest = pickLatest(evidence);
  if (latest.status !== "ok") return latest;
  const index = evidence.indexOf(latest.submission);
  const accepted = derived[index]?.facts.capture.acceptedItemNumbers.includes(itemNumber) ?? false;
  return {
    status: "ok",
    submission: latest.submission,
    requestedItem: { itemNumber, status: accepted ? "accepted" : "not_found" },
  };
}
