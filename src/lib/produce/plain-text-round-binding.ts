/**
 * P4A completion — give a plain-text produce session a P2E accountability round.
 *
 * The guided menu gets its round from a typed open command. Plain text has no
 * such command: the seller, market and business date only exist once the
 * accumulated document is parsed. So the binding happens at the two places that
 * already hold a parsed `WeighSession` — the close message and the deferred
 * finalizer — and is idempotent so calling it at both costs nothing.
 *
 * Nothing here decides identity. `bind_plain_text_accountability_round` owns
 * the create/resolve contract; this module supplies the parsed attributes and
 * turns the RPC's outcome into an operator-facing refusal.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { WeighSession } from "@/lib/parsers/weigh-session/types";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import { baseTransactionType } from "@/lib/summary/transactions";
import { normalizedMarketLabel } from "@/lib/market";
import { bangkokBusinessDatesNear } from "@/lib/business-date";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

/**
 * Business dates from this day on must resolve a round or fail closed.
 *
 * Before it, a return whose withdrawal was entered by the previous release has
 * no round to find, and refusing it would make a real return permanently
 * un-recordable. Round creation is not gated — a withdrawal always mints its
 * round, so the first enforced day already has masters to validate against.
 */
export const PLAIN_TEXT_ROUND_ENFORCEMENT_FROM = "2026-08-11";

export type PlainTextRoundBinding =
  | {
      status: "bound";
      accountabilityRoundId: string;
      /** The ROUND's own market label — canonical for everything downstream. */
      marketLabel: string | null;
      /**
       * True when a plain `เบิก` joined a round that already held this
       * seller/market/day rather than minting one. Observability only — nothing
       * downstream branches on it.
       */
      reusedExistingRound: boolean;
    }
  /** Legacy-compatible: no round, so only P4A's unit-vocabulary tier applies. */
  | { status: "unbound" }
  | { status: "refused"; reason: PlainTextRoundRefusal; detail: string };

export type PlainTextRoundRefusal =
  | "no_round"
  | "market_mismatch"
  | "market_near_match"
  | "ambiguous"
  | "not_found"
  | "identity_mismatch"
  | "bind_failed";

/** The pending generation being bound. Never a descriptive tuple. */
export interface PlainTextRoundSessionRef {
  sessionKey: string;
  sessionGeneration: string;
  sourceId: string;
  lineUserId: string | null;
}

const NO_ROUND_REPLY = [
  "⛔ ไม่พบรอบเบิกของรายการนี้",
  "ระบบยังไม่ได้บันทึกอะไร",
  "กรุณาบันทึกรายการเบิกของรอบนี้ก่อน แล้วส่งรายการนี้ใหม่",
].join("\n");

/**
 * The round exists — under another market.
 *
 * Production 2026-08-10 turned this state into silent data corruption: the
 * return was filed into the withdrawal's round while carrying its own market
 * label, and the next morning's report showed that market with เบิก 0. Naming
 * the round's market is what an operator can act on; "no withdrawal found"
 * sends them to re-enter a withdrawal that already exists.
 */
function marketMismatchReply(roundMarketLabel: string | null, sentMarketLabel: string): string {
  return [
    "⛔ ตลาดไม่ตรงกับรอบเบิกที่เปิดอยู่",
    roundMarketLabel
      ? `รอบนี้เปิดไว้ที่ตลาด "${roundMarketLabel}" แต่รายการนี้ระบุ "${sentMarketLabel}"`
      : `รายการนี้ระบุตลาด "${sentMarketLabel}" ซึ่งไม่ตรงกับรอบที่เปิดอยู่`,
    "ระบบยังไม่ได้บันทึกอะไร",
    "กรุณาแก้ชื่อตลาดให้ตรงกับรอบเบิก แล้วส่งใหม่",
  ].join("\n");
}

/**
 * A withdrawal whose market is one character from a round that already holds
 * this seller's day.
 *
 * Production 2026-08-14, ต้อม: `พาซีโอ้` opened a second accountability round
 * beside `พาซิโอ้`, and the day's returns then had two masters to choose from.
 * The two confirmed spellings are reviewed aliases now, so this reply is for the
 * NEXT variant nobody has reviewed yet. It suggests and refuses; it never
 * merges, because a typo and a genuinely new market look identical from here and
 * only the operator knows which this is.
 */
function marketNearMatchReply(
  roundMarketLabel: string | null,
  sentMarketLabel: string,
): string {
  return [
    "⛔ ชื่อตลาดใกล้เคียงกับรอบที่เปิดอยู่ แต่ไม่ตรงกัน",
    `ส่งมา: "${sentMarketLabel}"`,
    ...(roundMarketLabel ? [`รอบที่มีอยู่: "${roundMarketLabel}"`] : []),
    "ระบบยังไม่ได้บันทึกอะไร และยังไม่ได้เปิดรอบใหม่",
    roundMarketLabel
      ? `หากเป็นตลาดเดียวกัน ให้แก้ชื่อตลาดเป็น "${roundMarketLabel}" แล้วส่งใหม่`
      : "หากเป็นตลาดเดียวกัน ให้แก้ชื่อตลาดให้ตรงกับรอบเดิม แล้วส่งใหม่",
    "หากเป็นคนละตลาดจริง กรุณาแจ้งผู้ดูแลให้เพิ่มชื่อตลาดนี้ก่อน",
  ].join("\n");
}

const AMBIGUOUS_REPLY = [
  "⛔ มีรอบที่เปิดค้างอยู่มากกว่า 1 รอบ ของคนขาย/ตลาด/วันที่เดียวกัน",
  "ระบบไม่เดาว่ารายการนี้เป็นของรอบไหน จึงยังไม่บันทึก",
  "กรุณาให้ผู้ดูแลปิดรอบที่ไม่ได้ใช้ก่อน แล้วส่งรายการนี้ใหม่",
].join("\n");

const BIND_FAILED_REPLY = [
  "⛔ ระบบผูกรายการนี้กับรอบไม่สำเร็จ จึงยังไม่บันทึก",
  "กรุณาส่งรายการนี้ใหม่อีกครั้ง",
].join("\n");

/**
 * True when this document is a new economic cycle rather than a continuation.
 *
 * A main session carrying at least one เบิก item brings its own withdrawal
 * master, so it opens a round. Everything else — a return, a damaged return, an
 * additional batch of any type — continues one that already exists and must
 * never create.
 */
export function isNewRoundDocument(parsed: WeighSession): boolean {
  if (parsed.session_kind !== "main") return false;
  return parsed.items.some(
    (item) => baseTransactionType(item.transaction_type) === "เบิก",
  );
}

export const UNDATED_CUTOFF_REPLY = [
  "⛔ รายการนี้ไม่มีวันที่ในหัวรายการ และส่งใกล้เวลาตัดวัน 04:00",
  "ระบบไม่เดาวันที่ให้ จึงยังไม่บันทึก",
  "กรุณาส่งใหม่โดยระบุวันที่ในหัวรายการ เช่น \"น้อย-ราชพฤกษ์ ชั่งคืน 7/10/2569\"",
].join("\n");

/**
 * P0-D: true when a MAIN document names no business date in its header and the
 * clocks that would supply one (insert, close, now) do not pin a single
 * business day — they disagree, or one sits within the cutoff margin of 04:00
 * (BUSINESS_DATE_CUTOFF_MARGIN_MS). No usable clock is ambiguous too. Binding
 * such a document would guess the day, and a wrong day attaches a return to
 * the wrong withdrawal round.
 *
 * Additional batches never take a fallback date, so they are never ambiguous
 * here; an explicit header date is never second-guessed by a clock.
 */
export function undatedBusinessDateAmbiguous(
  text: string,
  timestampsMs: readonly (number | null | undefined)[],
): boolean {
  const explicit = parseWeighSession(text);
  if (explicit.session_kind !== "main" || explicit.date) return false;
  const dates = new Set<string>();
  for (const ms of timestampsMs) {
    if (ms == null || !Number.isFinite(ms)) continue;
    for (const date of bangkokBusinessDatesNear(ms)) dates.add(date);
  }
  return dates.size !== 1;
}

/**
 * P0: may a REFUSED plain-text document still be attached to its round?
 *
 * Only a return (คืน / คืนเสีย) — binding it can never mint a round — whose
 * business day is not a guess. The binding RPC still demands the exact
 * source, seller, market and date. Nothing refused is booked: the parsed
 * subset stays in partial capture; the round only learns that its return
 * was attempted and is therefore not a sold-out.
 */
export function refusedReturnMayBindRound(
  text: string,
  parsed: WeighSession,
  timestampsMs: readonly (number | null | undefined)[],
): boolean {
  if (isNewRoundDocument(parsed)) return false;
  // The header names the kind even when every item line failed.
  const kinds = parsed.declared_transaction_type
    ? [parsed.declared_transaction_type]
    : [
        parsed.header_transaction_type ?? null,
        ...parsed.items.map((item) => baseTransactionType(item.transaction_type)),
      ];
  if (!kinds.some((kind) => kind === "คืน" || kind === "คืนเสีย")) return false;
  return !undatedBusinessDateAmbiguous(text, timestampsMs);
}

/** "group:<id>:user:<id>" / "room:…" / "dm:<id>" — the shape produceSessionKey mints. */
export function sourceTypeFromSessionKey(
  sessionKey: string,
): "user" | "group" | "room" | null {
  if (sessionKey.startsWith("group:")) return "group";
  if (sessionKey.startsWith("room:")) return "room";
  if (sessionKey.startsWith("dm:")) return "user";
  return null;
}

/**
 * Bind the generation, or explain why it cannot be bound.
 *
 * A document the round contract cannot describe — no date, no market, no
 * sender — is left `unbound` rather than refused: those are parse-level
 * failures with their own operator message, and reporting them as a round
 * problem would be misleading.
 */
export async function bindPlainTextRound(
  supabase: AnyClient,
  ref: PlainTextRoundSessionRef,
  parsed: WeighSession,
): Promise<PlainTextRoundBinding> {
  const sourceType = sourceTypeFromSessionKey(ref.sessionKey);
  const market = normalizedMarketLabel(parsed.session_title);
  if (
    !sourceType
    || !ref.lineUserId
    || !parsed.date
    || !parsed.staff_name.trim()
    || !market
  ) {
    return { status: "unbound" };
  }

  let data: unknown;
  try {
    const response = await supabase.rpc("bind_plain_text_accountability_round", {
      p_session_key: ref.sessionKey,
      p_session_generation: ref.sessionGeneration,
      p_source_type: sourceType,
      p_source_id: ref.sourceId,
      p_line_user_id: ref.lineUserId,
      p_business_date: parsed.date,
      p_seller_label: parsed.staff_name,
      p_market_label: parsed.session_title,
      p_market_label_normalized: market,
      p_is_new_round: isNewRoundDocument(parsed),
    });
    if (response.error) {
      return { status: "refused", reason: "bind_failed", detail: BIND_FAILED_REPLY };
    }
    data = response.data;
  } catch {
    return { status: "refused", reason: "bind_failed", detail: BIND_FAILED_REPLY };
  }

  const result = (data ?? {}) as {
    outcome?: string;
    accountability_round_id?: string | null;
    market_label?: string | null;
    reused?: boolean | null;
  };

  switch (result.outcome) {
    case "bound":
    case "already_bound":
      return result.accountability_round_id
        ? {
            status: "bound",
            accountabilityRoundId: result.accountability_round_id,
            marketLabel: result.market_label ?? null,
            // Absent on a database that predates the same-day reuse contract.
            reusedExistingRound: result.reused === true,
          }
        : { status: "refused", reason: "bind_failed", detail: BIND_FAILED_REPLY };
    case "market_mismatch":
      // Always fail closed, on every business date. Unlike `no_round` there is
      // no legacy reading of this state: a round WAS found for this seller and
      // day, so the pre-cutover "the withdrawal predates the release" excuse
      // cannot apply, and persisting under a second market label is the exact
      // corruption this refusal exists to prevent.
      return {
        status: "refused",
        reason: "market_mismatch",
        detail: marketMismatchReply(result.market_label ?? null, market),
      };
    case "market_near_match":
      // Fail closed on every business date, for the same reason as
      // market_mismatch: a round WAS found for this seller and day, so there is
      // no pre-cutover reading of this state. Creating the second round is the
      // corruption the guard exists to prevent.
      return {
        status: "refused",
        reason: "market_near_match",
        detail: marketNearMatchReply(result.market_label ?? null, market),
      };
    case "no_round":
      // Before the cutover the withdrawal side of this round predates the
      // release, so there is genuinely nothing to find and legacy behaviour is
      // the honest answer. From the cutover on, a return with no withdrawal is
      // exactly what P4A exists to stop.
      return parsed.date >= PLAIN_TEXT_ROUND_ENFORCEMENT_FROM
        ? { status: "refused", reason: "no_round", detail: NO_ROUND_REPLY }
        : { status: "unbound" };
    case "ambiguous":
      return { status: "refused", reason: "ambiguous", detail: AMBIGUOUS_REPLY };
    case "not_found":
      return { status: "refused", reason: "not_found", detail: BIND_FAILED_REPLY };
    case "identity_mismatch":
      return { status: "refused", reason: "identity_mismatch", detail: BIND_FAILED_REPLY };
    default:
      return { status: "refused", reason: "bind_failed", detail: BIND_FAILED_REPLY };
  }
}
