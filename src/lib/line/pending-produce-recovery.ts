/**
 * Explicit recovery of Produce item messages rejected at a session boundary.
 *
 * Rejected rows already live in pending_produce_deferred_events. This module
 * never infers seller, market, date, or type. The operator opens a valid
 * header first; กู้รายการล่าสุด then replays one deterministic same-source
 * bundle into that new generation via append_pending_session.
 */
import {
  MAIN_SESSION_EXPECTED_CLOSER,
  MAIN_SESSION_LABEL,
  mainSessionTypeFromText,
} from "@/lib/parsers/weigh-session/main-closer";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import { bangkokBusinessDateFromTimestamp } from "@/lib/business-date";
import { RE } from "@/lib/parsers/weigh-session/regex";
import type { BaseTransactionType } from "@/lib/parsers/weigh-session/types";
import {
  PendingSessionAfterCloseBoundaryError,
  PendingSessionClosedError,
  PendingSessionService,
  type PendingSession,
  type RecoverableDeferredEventRow,
} from "@/lib/line/pending-session-service";

export const RECOVER_LATEST_COMMAND = "กู้รายการล่าสุด";

const KNOWN_PRODUCE_CLOSERS = [
  "จบรายการ",
  "จบรายการเบิก",
  "จบรายการชั่งเบิก",
  "จบรายการชั่งคืน",
  "จบรายการคืน",
  "จบรายการคืนเสีย",
  "จบรายการชั่งคืนและคืนเสีย",
  "จบรายการเบิกเพิ่ม",
  "จบรายการชั่งคืนเพิ่ม",
  "จบรายการคืนเสียเพิ่ม",
] as const;

const GENERIC_COUNTED_CLOSER = /^จบรายการ\s+\d+\s*รายการ\s*$/;

export const RECOVERABLE_DEFERRED_STATUSES = [
  "waiting",
  "rejected_before_opener",
  "rejected_after_close",
  "rejected_orphan",
] as const;

export type RecoverableDeferredStatus = (typeof RECOVERABLE_DEFERRED_STATUSES)[number];
export const RECOVERY_VISIBILITY_MS = 6 * 60 * 60 * 1000;
export type RecoveryReason = "before_opener" | "after_close" | "orphan";

export type RecoverableDeferredEvent = RecoverableDeferredEventRow;

export interface RecoveryBundle {
  key: string;
  reason: RecoveryReason;
  closeLineEventId: string | null;
  openerLineEventId: string | null;
  sessionGeneration: string | null;
  /** Durable no-header-burst identity (20260825090000). Null when the bundle
   * was keyed some other way (waiting / before_opener / after_close / a
   * pre-migration orphan row). */
  recoveryBundleId: string | null;
  events: RecoverableDeferredEvent[];
}

export type HeaderProvenance = {
  type: BaseTransactionType | null;
  staff: string | null;
  market: string | null;
  date: string | null;
};

export type BundleSelection =
  | { kind: "none" }
  | { kind: "unkeyed" }
  | { kind: "one"; bundle: RecoveryBundle }
  | { kind: "ambiguous"; bundles: RecoveryBundle[] };

export function isExactRecoverLatestCommand(text: string): boolean {
  return text.trim() === RECOVER_LATEST_COMMAND;
}

/** Prefix of a known Produce closer that is not itself a complete closer. */
export function isIncompleteProduceCloser(text: string): boolean {
  const line = text.trim();
  if (!line || line.includes("\n")) return false;
  if (isCompleteProduceCloser(line)) return false;
  if (!line.startsWith("จบราย")) return false;
  return KNOWN_PRODUCE_CLOSERS.some((closer) => closer.startsWith(line));
}

function isCompleteProduceCloser(line: string): boolean {
  if ((KNOWN_PRODUCE_CLOSERS as readonly string[]).includes(line)) return true;
  if (GENERIC_COUNTED_CLOSER.test(line)) return true;
  if (RE.SESSION_END_COUNT.test(line)) return true;
  if (RE.ADDITIONAL_END.test(line)) return true;
  return false;
}

export function incompleteCloserReply(sessionText: string): string {
  const activeType = mainSessionTypeFromText(sessionText);
  const expected = activeType ? MAIN_SESSION_EXPECTED_CLOSER[activeType] : "จบรายการเบิก";
  const label = activeType ? MAIN_SESSION_LABEL[activeType] : "รายการนี้";
  return [
    "⚠️ คำสั่งปิดรายการไม่ครบ",
    "",
    `ตอนนี้กำลังบันทึก${label}`,
    "ข้อมูลเดิมยังอยู่ครบ",
    "",
    "กรุณาส่ง:",
    expected,
  ].join("\n");
}

export function durableRecoveryBundleKey(event: RecoverableDeferredEvent): string | null {
  if (event.status === "waiting") {
    if (!isUnexpiredWaiting(event)) return null;
    return "waiting";
  }
  const reason = recoveryReason(event.status);
  if (reason === "after_close") {
    return event.close_line_event_id ? `after_close:${event.close_line_event_id}` : null;
  }
  if (reason === "before_opener") {
    return event.opener_line_event_id ? `before_opener:${event.opener_line_event_id}` : null;
  }
  if (event.close_line_event_id) return `orphan:close:${event.close_line_event_id}`;
  if (event.opener_line_event_id) return `orphan:opener:${event.opener_line_event_id}`;
  if (event.session_generation) return `orphan:gen:${event.session_generation}`;
  // A genuine no-header burst never materializes a session, opener, or close
  // — the only durable identity it ever gets is the recovery_bundle_id
  // assigned at defer time (20260825090000). Without it (pre-migration rows,
  // or a bundle whose DB column is somehow unset) this stays unkeyed by
  // design rather than guessed from timestamps.
  if (event.recovery_bundle_id) return `orphan:bundle:${event.recovery_bundle_id}`;
  return null;
}

function isUnexpiredWaiting(event: RecoverableDeferredEvent): boolean {
  if (!event.expires_at) return false;
  const expiresAt = Date.parse(event.expires_at);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

export function clusterRecoverableEvents(
  events: RecoverableDeferredEvent[],
): RecoveryBundle[] {
  const bundles = new Map<string, RecoveryBundle>();
  for (const event of events) {
    const key = durableRecoveryBundleKey(event);
    if (!key) continue;
    const existing = bundles.get(key);
    if (existing) {
      existing.events.push(event);
      continue;
    }
    const reason = recoveryReason(event.status);
    bundles.set(key, {
      key,
      reason,
      closeLineEventId: event.close_line_event_id,
      openerLineEventId: event.opener_line_event_id,
      sessionGeneration: event.session_generation,
      recoveryBundleId: event.recovery_bundle_id,
      events: [event],
    });
  }
  return [...bundles.values()].map((bundle) => ({
    ...bundle,
    events: [...bundle.events].sort(compareDeferredEvents),
  }));
}

export function selectRecoveryBundle(
  events: RecoverableDeferredEvent[],
  nowMs = Date.now(),
): BundleSelection {
  const currentBusinessDate = bangkokBusinessDateFromTimestamp(nowMs);
  const freshEvents = events.filter((event) => {
    if (event.status === "waiting") return true;
    const receivedAt = Date.parse(event.received_at);
    return Number.isFinite(receivedAt)
      && currentBusinessDate !== null
      && bangkokBusinessDateFromTimestamp(receivedAt) === currentBusinessDate;
  });
  const bundles = clusterRecoverableEvents(freshEvents);
  const keyedCount = bundles.reduce((sum, bundle) => sum + bundle.events.length, 0);
  if (bundles.length === 0) {
    return freshEvents.length > 0 && keyedCount === 0 ? { kind: "unkeyed" } : { kind: "none" };
  }
  if (bundles.length > 1) return { kind: "ambiguous", bundles };
  return { kind: "one", bundle: bundles[0]! };
}

function recoveryReason(status: RecoverableDeferredStatus): RecoveryReason {
  if (status === "rejected_after_close") return "after_close";
  if (status === "rejected_orphan") return "orphan";
  return "before_opener";
}

function compareDeferredEvents(
  left: RecoverableDeferredEvent,
  right: RecoverableDeferredEvent,
): number {
  return left.line_timestamp_ms - right.line_timestamp_ms
    || left.line_event_id.localeCompare(right.line_event_id);
}

export function boundaryRejectReply(
  count: number,
  reason: RecoveryReason,
): string {
  return [
    `⚠️ พบ ${count} ข้อความที่ยังไม่ถูกบันทึก`,
    "",
    reasonLine(reason),
    "ข้อมูลเดิมยังเก็บไว้ ไม่ต้องพิมพ์ใหม่",
    "",
    "กรุณาเปิดหัวรายการใหม่ให้ถูกต้อง",
    "จากนั้นส่ง:",
    RECOVER_LATEST_COMMAND,
  ].join("\n");
}

export function headerOpenedWithRetainedReply(
  count: number,
  reason: RecoveryReason,
): string {
  return [
    "✅ เปิดหัวรายการแล้ว",
    `พบ ${count} ข้อความที่ยังเก็บไว้`,
    "",
    reasonLine(reason),
    "ยังไม่ถูกบันทึกในหัวนี้",
    "",
    "ส่ง:",
    RECOVER_LATEST_COMMAND,
  ].join("\n");
}

export function recoveredReply(count: number): string {
  return [
    `✅ กู้แล้ว ${count} ข้อความ`,
    "รายการอื่นยังอยู่ครบ ไม่ต้องยกเลิก",
    "เมื่อครบแล้วปิดรายการตามประเภทนี้",
  ].join("\n");
}

export const RECOVER_REFUSED_NO_HEADER_REPLY = [
  "⛔ ยังกู้รายการไม่ได้",
  "ยังไม่มีหัวรายการที่เปิดอยู่",
  "ข้อมูลเดิมยังเก็บไว้ ไม่ต้องพิมพ์ใหม่",
  `กรุณาเปิดหัวรายการใหม่ให้ถูกต้อง แล้วส่ง “${RECOVER_LATEST_COMMAND}”`,
].join("\n");

export const RECOVER_REFUSED_AMBIGUOUS_REPLY = [
  "⛔ ยังกู้รายการไม่ได้",
  "พบมากกว่า 1 กลุ่มข้อความที่ยังไม่ถูกบันทึก จึงไม่เลือกกลุ่มให้",
  "ข้อมูลเดิมยังเก็บไว้ ไม่ถูกบันทึก",
].join("\n");

export const RECOVER_REFUSED_NONE_REPLY = [
  "ℹ️ ไม่มีรายการที่กู้ได้",
  "ไม่มีข้อความค้างที่ผูกกับผู้ส่งนี้",
].join("\n");

export const RECOVER_REFUSED_UNKEYED_REPLY = [
  "⛔ ยังกู้รายการไม่ได้",
  "มีข้อความเก็บไว้ แต่จัดกลุ่มรอบเดิมอย่างปลอดภัยไม่ได้",
  "ข้อมูลเดิมยังเก็บไว้ ไม่ถูกบันทึก ไม่ต้องพิมพ์ทิ้ง",
].join("\n");

/**
 * after_close fail-closed refusal: the closed session SHOULD have provenance
 * (it could not have closed without a header), but this bundle's opener text
 * could not be reconstructed, or reconstructed incompletely. Recovery is
 * refused outright rather than matching only the fields that happened to
 * parse — a partially-known origin is not a safe basis for exact-match
 * comparison. No IDs are exposed; the raw/deferred evidence is untouched.
 */
export const RECOVER_REFUSED_AFTER_CLOSE_PROVENANCE_REPLY = [
  "พบรายการที่ส่งหลังปิดรอบเดิม",
  "แต่ระบบยืนยันข้อมูลรอบเดิมได้ไม่ครบ",
  "จึงไม่กู้รายการอัตโนมัติเพื่อป้องกันการผูกผิดตลาด/ผิดประเภท",
  "ข้อมูลเดิมยังเก็บไว้",
].join("\n");

export const RECOVER_REFUSED_CLOSED_REPLY = [
  "⛔ ยังกู้รายการไม่ได้",
  "รายการนี้ปิดแล้ว จึงไม่ใส่ข้อความเก่าเข้าไป",
  "ข้อมูลเดิมยังเก็บไว้ ไม่ต้องพิมพ์ใหม่",
  `กรุณาเปิดหัวรายการใหม่ให้ถูกต้อง แล้วส่ง “${RECOVER_LATEST_COMMAND}”`,
].join("\n");

export function headerProvenance(text: string): HeaderProvenance {
  const parsed = parseWeighSession(text);
  return {
    type: mainSessionTypeFromText(text) ?? parsed.declared_transaction_type,
    staff: parsed.staff_name.trim() ? parsed.staff_name : null,
    market: parsed.session_title,
    date: parsed.date,
  };
}

export function afterCloseProvenanceMismatch(
  origin: HeaderProvenance,
  current: HeaderProvenance,
): Array<"type" | "staff" | "market" | "date"> {
  const fields: Array<"type" | "staff" | "market" | "date"> = [];
  if (origin.type && origin.type !== current.type) fields.push("type");
  if (origin.staff && origin.staff !== current.staff) fields.push("staff");
  if (origin.market && origin.market !== current.market) fields.push("market");
  if (origin.date && origin.date !== current.date) fields.push("date");
  return fields;
}

/**
 * An after_close bundle always originates from a session that once had a
 * complete header (it could not have been closed otherwise). If any
 * authoritative field fails to re-parse from the recovered opener text, the
 * original provenance cannot be reconstructed with confidence — the gap must
 * refuse recovery rather than silently skip the field it could not read.
 */
export function isCompleteHeaderProvenance(provenance: HeaderProvenance): boolean {
  return Boolean(
    provenance.type
    && provenance.staff
    && provenance.market
    && provenance.date,
  );
}

export function incompatibleHeaderReply(
  origin: HeaderProvenance,
  current: HeaderProvenance,
): string {
  const originLabel = origin.type ? MAIN_SESSION_LABEL[origin.type] : "รอบเดิม";
  const currentLabel = current.type ? MAIN_SESSION_LABEL[current.type] : "หัวที่เปิดอยู่";
  const originCloser = origin.type ? MAIN_SESSION_EXPECTED_CLOSER[origin.type] : null;
  return [
    "⛔ ยังกู้รายการไม่ได้",
    `กลุ่มนี้มาจาก${originLabel}${origin.staff ? ` ของ ${origin.staff}` : ""}${origin.market ? `-${origin.market}` : ""}${origin.date ? ` วันที่ ${origin.date}` : ""}`,
    `หัวที่เปิดอยู่เป็น${currentLabel} จึงไม่ใส่เข้าไป`,
    "ข้อมูลเดิมยังเก็บไว้ ไม่ต้องพิมพ์ใหม่",
    originCloser
      ? `กรุณาเปิดหัวรายการให้ตรงประเภท แล้วส่ง “${RECOVER_LATEST_COMMAND}”`
      : `กรุณาเปิดหัวรายการให้ตรงรอบเดิม แล้วส่ง “${RECOVER_LATEST_COMMAND}”`,
  ].join("\n");
}

function reasonLine(reason: RecoveryReason): string {
  if (reason === "after_close") return "รายการถูกส่งมาหลังปิดรอบก่อนแล้ว";
  if (reason === "before_opener") return "รายการถูกส่งมาก่อนเปิดหัวรายการ";
  return "ระบบผูกกับรอบเดิมไม่ได้ จึงไม่กู้ให้อัตโนมัติ";
}

export function canRecoverIntoSession(session: PendingSession | null): boolean {
  return Boolean(
    session
    && session.entry_origin == null
    && !session.terminalized
    && session.close_event_timestamp_ms == null
    && session.plain_text_opened_line_timestamp_ms != null,
  );
}

export type RecoverLatestResult =
  | { status: "recovered"; count: number; session: PendingSession }
  | { status: "none" }
  | { status: "unkeyed" }
  | { status: "ambiguous" }
  | { status: "no_header" }
  | { status: "closed" }
  | { status: "incompatible_header"; origin: HeaderProvenance; current: HeaderProvenance }
  | { status: "missing_provenance" };

const recoveryLocks = new Map<string, Promise<unknown>>();

async function withSessionRecoveryLock<T>(
  sessionKey: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = recoveryLocks.get(sessionKey) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.catch(() => undefined).then(() => gate);
  recoveryLocks.set(sessionKey, current);
  try {
    await previous.catch(() => undefined);
    return await work();
  } finally {
    release();
    if (recoveryLocks.get(sessionKey) === current) {
      recoveryLocks.delete(sessionKey);
    }
  }
}

export async function recoverLatestRejectedBundle(
  service: PendingSessionService,
  session: PendingSession | null,
  replyToken: string | null,
): Promise<RecoverLatestResult> {
  if (!session) return { status: "no_header" };
  if (session.close_event_timestamp_ms != null || session.terminalized) {
    return { status: "closed" };
  }
  if (!canRecoverIntoSession(session)) return { status: "no_header" };

  return withSessionRecoveryLock(session.session_key, async () => {
    const events = (await service.listRecoverableDeferredEvents(session.session_key))
      .filter((event) =>
        event.session_key === session.session_key
        && event.source_id === session.source_id
        && (session.line_user_id == null || event.line_user_id === session.line_user_id),
      );
    const selection = selectRecoveryBundle(events);
    if (selection.kind === "none") return { status: "none" };
    if (selection.kind === "unkeyed") return { status: "unkeyed" };
    if (selection.kind === "ambiguous") return { status: "ambiguous" };

    const bundle = selection.bundle;
    if (bundle.reason === "after_close") {
      // Fail-closed: an after_close bundle can only exist because a session
      // once had a complete header and was closed. Provenance therefore
      // SHOULD always be reconstructible. If the opener text cannot be
      // located, or reconstructs with any authoritative field missing, that
      // is treated identically to a known mismatch — refuse outright rather
      // than comparing only the fields that happened to parse. Nothing is
      // appended and no deferred/raw evidence is mutated.
      const originText = await loadOriginatingOpenerText(service, bundle);
      if (!originText) {
        return { status: "missing_provenance" };
      }
      const origin = headerProvenance(originText);
      if (!isCompleteHeaderProvenance(origin)) {
        return { status: "missing_provenance" };
      }
      const current = headerProvenance(session.accumulated_text);
      if (afterCloseProvenanceMismatch(origin, current).length > 0) {
        return { status: "incompatible_header", origin, current };
      }
    }

    let updated = session;
    const recoveredIds: string[] = [];
    for (const event of bundle.events) {
      try {
        // recoverDeferredEvent commits the append AND the deferred-status
        // flip to 'admitted' in one transaction (20260825090000). There is no
        // window where this specific event is durably appended but its
        // pending_produce_deferred_events row still reads 'waiting' /
        // 'rejected_*' — a crash on the NEXT event leaves every event up to
        // here fully converged, with nothing for an operator to clean up.
        updated = await service.recoverDeferredEvent(
          session.session_key,
          event.line_event_id,
          event.raw_text,
          replyToken,
          event.line_timestamp_ms,
          session.session_generation,
        );
        recoveredIds.push(event.line_event_id);
      } catch (error) {
        if (
          error instanceof PendingSessionAfterCloseBoundaryError
          || error instanceof PendingSessionClosedError
        ) {
          // Every event recovered so far is already durably marked admitted
          // (see above) — nothing further to batch-mark before returning.
          return { status: "closed" };
        }
        throw error;
      }
    }
    return { status: "recovered", count: recoveredIds.length, session: updated };
  });
}

export function recoverCommandReply(result: RecoverLatestResult): string {
  if (result.status === "recovered") return recoveredReply(result.count);
  if (result.status === "ambiguous") return RECOVER_REFUSED_AMBIGUOUS_REPLY;
  if (result.status === "unkeyed") return RECOVER_REFUSED_UNKEYED_REPLY;
  if (result.status === "none") return RECOVER_REFUSED_NONE_REPLY;
  if (result.status === "closed") return RECOVER_REFUSED_CLOSED_REPLY;
  if (result.status === "incompatible_header") {
    return incompatibleHeaderReply(result.origin, result.current);
  }
  if (result.status === "missing_provenance") {
    return RECOVER_REFUSED_AFTER_CLOSE_PROVENANCE_REPLY;
  }
  return RECOVER_REFUSED_NO_HEADER_REPLY;
}

async function loadOriginatingOpenerText(
  service: PendingSessionService,
  bundle: RecoveryBundle,
): Promise<string | null> {
  const generation = bundle.sessionGeneration ?? bundle.events[0]?.session_generation;
  if (!generation) return null;
  const sessionKey = bundle.events[0]?.session_key;
  if (!sessionKey) return null;
  const rows = await service.loadGenerationIngestRows(sessionKey, generation);
  const openerId = bundle.openerLineEventId ?? bundle.events[0]?.opener_line_event_id;
  if (openerId) {
    const opener = rows.find((row) => row.line_event_id === openerId);
    if (opener?.raw_text) return opener.raw_text;
  }
  const start = rows.find((row) =>
    row.raw_text.split(/\r?\n/).some((line) => RE.SESSION_START.test(line.trim())),
  );
  return start?.raw_text ?? null;
}

export async function loadRecoverableSelection(
  service: PendingSessionService,
  sessionKey: string,
): Promise<BundleSelection> {
  const events = await service.listRecoverableDeferredEvents(sessionKey);
  return selectRecoveryBundle(events);
}
