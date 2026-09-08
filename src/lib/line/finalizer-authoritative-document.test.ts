/**
 * Regression coverage for the 2026-07-30 follow-up production incident:
 * pending_sessions.accumulated_text for a structured (entry_origin=
 * structured_menu) session was repaired by an administrator after a typed
 * "ยกเลิก" control command had already been admitted and ingested (before
 * webhook-level interception existed). เมนู and จบรายการ read accumulated_text
 * directly and correctly showed the repaired, clean document. But the
 * deferred finalizer's structured branch (finalizePendingGeneration →
 * buildAdmittedStructuredText) rebuilt its document by joining the RAW
 * pending_session_ingest ledger text instead — a document the repair never
 * touched — so it still contained "ยกเลิก" and failed closed with
 * `finalization_error = {"validation_errors":["unrecognized line: \"ยกเลิก\""]}`
 * even though the live accumulated_text was clean.
 *
 * Confirmed against the actual production row (session_key
 * dm:U84e999002627396432553ff25bb861ca, session_generation
 * ddf4f72c-f15c-4fca-9b1d-6e58425b56a5): pending_session_ingest still held a
 * line_event_id 01KYS6A228K277W1KVQTV7AFFA row with raw_text = "ยกเลิก",
 * fully admitted (parity holds — no throw), while accumulated_text had
 * already been repaired to the two clean items.
 *
 * The fix keeps the admission/ingest ledger comparison as a pure integrity
 * gate (still fails closed on any genuine asymmetry — a straggler, a drop, a
 * duplicate, a timestamp conflict) but returns accumulated_text — the SAME
 * document GuidedSessionCaptureService.readSnapshot already validated at
 * เมนู, จบรายการ and ยืนยันจบรายการ — as the parsed document, instead of
 * replaying raw ledger text.
 */

import { describe, expect, it } from "bun:test";
import { finalizePendingGeneration } from "./pending-session-finalizer";
import { GuidedSessionCaptureService } from "./guided-menu/session-capture";
import { COMMAND_CONTRACT_VERSION } from "@/lib/parsers/weigh-session/seed";
import { countCodePoints } from "@/lib/summary/line-chunking";
import type { PendingSession } from "./pending-session-service";
import type { GuidedMenuIdentity } from "./guided-menu/ux-types";

type Row = Record<string, unknown>;

/** Same fake-DB shape as pending-session-finalizer-additional.test.ts, plus a
 * from()-call table log so legacy-vs-structured branch selection is provable. */
class FinalizerDocDouble {
  rpcCalls: Array<{ name: string; args: Row }> = [];
  fromCalls: string[] = [];
  rpcResult: Row = { status: "finalized", session_id: "produce-1", notification_id: "notify-1" };

  constructor(private readonly tables: Record<string, Row[]>) {}

  rows(table: string): Row[] {
    return this.tables[table] ?? [];
  }

  asClient() {
    return this as never;
  }

  from = (table: string) => {
    this.fromCalls.push(table);
    const rows = this.rows(table);
    const filters: Array<(row: Row) => boolean> = [];
    const builder = {
      select: () => builder,
      upsert: () => builder,
      update: () => builder,
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return builder;
      },
      lte: (column: string, value: unknown) => {
        filters.push((row) => Number(row[column]) <= Number(value));
        return builder;
      },
      not: () => builder,
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () => ({
        data: rows.filter((row) => filters.every((f) => f(row)))[0] ?? null,
        error: null,
      }),
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
        Promise.resolve({
          data: rows.filter((row) => filters.every((f) => f(row))),
          error: null,
        }).then(resolve),
    };
    return builder;
  };

  rpc = async (name: string, args: Row) => {
    this.rpcCalls.push({ name, args });
    if (name === "close_produce_structured_session") {
      const session = this.rows("pending_sessions").find(
        (row) => row.session_key === args.p_session_key,
      );
      if (!session) return { data: { accepted: false, reason: "not_found" }, error: null };
      Object.assign(session, {
        close_event_timestamp_ms: args.p_line_timestamp_ms,
        close_requested_at: "2026-08-20T10:01:00.000Z",
        close_line_event_id: args.p_close_line_event_id,
        close_session_generation: session.session_generation,
        next_attempt_at: "2026-08-20T10:01:00.000Z",
      });
      return {
        data: { accepted: true, reason: "first_close", session: { ...session } },
        error: null,
      };
    }
    if (name === "try_finalize_pending_generation") {
      const sessionPayload = args.p_session as Row;
      const validationErrors = (sessionPayload.validation_errors ?? []) as string[];
      if (validationErrors.length > 0) {
        return {
          data: { status: "failed_closed", reason: "validation_errors" },
          error: null,
        };
      }

      const sessionId = String(this.rpcResult.session_id ?? "produce-1");
      this.rows("produce_sessions").push({ ...sessionPayload, id: sessionId });
      for (const item of (args.p_items ?? []) as Row[]) {
        const persisted = {
          ...item,
          produce_session_id: sessionId,
          accountability_round_id: sessionPayload.accountability_round_id,
        };
        this.rows("produce_items").push(persisted);
        this.rows("produce_transactions").push(persisted);
      }
      this.rows("produce_session_notifications").push({
        produce_session_id: sessionId,
        notification_payload: sessionPayload.notification_payload,
      });
      return { data: this.rpcResult, error: null };
    }
    return { data: null, error: null };
  };
}

const SESSION_KEY = "group:group-1:user:user-1";
const GENERATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROUND_ID = "11111111-1111-4111-8111-111111111111";
const CLEAN_TEXT = "\n1. แตงโม 40 บาท\n3 ลูก\n2. มะละกอ 20 บาท\n5 ลูก";

function structuredSnapshot(overrides: Row = {}): PendingSession {
  const now = new Date().toISOString();
  return {
    id: "pending-1",
    session_key: SESSION_KEY,
    source_id: "group-1",
    session_generation: GENERATION,
    accumulated_text: CLEAN_TEXT,
    latest_reply_token: null,
    line_user_id: "user-1",
    created_at: now,
    updated_at: now,
    close_event_timestamp_ms: 10_000,
    close_requested_at: now,
    close_line_event_id: "close-evt-1",
    close_finalize_started_at: null,
    terminalized: false,
    next_attempt_at: now,
    close_deadline_at: now,
    close_session_generation: GENERATION,
    expected_item_count: null,
    ingest_revision: 3,
    accountability_round_id: ROUND_ID,
    entry_origin: "structured_menu",
    command_contract_version: COMMAND_CONTRACT_VERSION,
    business_date: "2026-07-29",
    transaction_time: "10:00",
    transaction_time_source: "operator_declared",
    staff_label: "กี้",
    market_label: "วัดทุ่งลานนา",
    session_kind: "main",
    initial_transaction_type: "เบิก",
    declared_transaction_type: null,
    additional_opener: null,
    opened_line_event_id: "evt-open",
    runtime_environment: "development",
    ...overrides,
  } as unknown as PendingSession;
}

/** Mirrors the real production incident: two real item events plus a stale
 * ยกเลิก event, admitted and ingested BEFORE any accumulated_text repair. */
function tables(options: {
  includeStaleCancelEvent: boolean;
  accumulatedTextInLedger?: string;
}): Record<string, Row[]> {
  const ingest: Row[] = [
    {
      session_key: SESSION_KEY, session_generation: GENERATION,
      line_event_id: "evt-1", line_timestamp_ms: 1_000,
      raw_text: "1. แตงโม 40 บาท\n3 ลูก",
    },
    {
      session_key: SESSION_KEY, session_generation: GENERATION,
      line_event_id: "evt-2", line_timestamp_ms: 2_000,
      raw_text: "2. มะละกอ 20 บาท\n5 ลูก",
    },
  ];
  const admission: Row[] = [
    { session_key: SESSION_KEY, session_generation: GENERATION, line_event_id: "evt-1", line_timestamp_ms: 1_000 },
    { session_key: SESSION_KEY, session_generation: GENERATION, line_event_id: "evt-2", line_timestamp_ms: 2_000 },
  ];
  if (options.includeStaleCancelEvent) {
    // The exact stale row from production: admitted and ingested atomically
    // by append_pending_session BEFORE the ยกเลิก interception fix existed,
    // and untouched by the later out-of-band accumulated_text repair.
    ingest.push({
      session_key: SESSION_KEY, session_generation: GENERATION,
      line_event_id: "evt-3-cancel", line_timestamp_ms: 3_000, raw_text: "ยกเลิก",
    });
    admission.push({
      session_key: SESSION_KEY, session_generation: GENERATION,
      line_event_id: "evt-3-cancel", line_timestamp_ms: 3_000,
    });
  }
  return {
    pending_session_ingest: ingest,
    pending_session_admission: admission,
    raw_messages: [{ id: "raw-close-1", line_event_id: "close-evt-1" }],
    produce_sessions: [],
  };
}

function tryFinalizeCall(db: FinalizerDocDouble) {
  const call = db.rpcCalls.find((c) => c.name === "try_finalize_pending_generation");
  if (!call) throw new Error("try_finalize_pending_generation was not called");
  return call;
}

describe("finalizer reads the same authoritative document as review/close/confirm", () => {
  it("1. accumulated_text repaired before close — the finalizer parses the repaired text, not the stale ledger", async () => {
    const db = new FinalizerDocDouble(tables({ includeStaleCancelEvent: true }));
    await finalizePendingGeneration(db.asClient(), structuredSnapshot(), async () => ({}));

    const call = tryFinalizeCall(db);
    expect(call.args.p_raw_text).toBe(CLEAN_TEXT);
    expect((call.args.p_session as Row).validation_errors).toEqual([]);
  });

  it("2. the stale ยกเลิก ledger row is still present (parity holds) but never reaches the parser", async () => {
    const db = new FinalizerDocDouble(tables({ includeStaleCancelEvent: true }));
    await finalizePendingGeneration(db.asClient(), structuredSnapshot(), async () => ({}));

    const call = tryFinalizeCall(db);
    const items = call.args.p_items as Row[];
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.product_name)).toEqual(["แตงโม", "มะละกอ"]);
    for (const item of items) {
      expect(JSON.stringify(item)).not.toContain("ยกเลิก");
    }
    expect(String(call.args.p_raw_text)).not.toContain("ยกเลิก");
  });

  it("3. เมนู snapshot and the finalizer parse an identical document", async () => {
    const db = new FinalizerDocDouble(tables({ includeStaleCancelEvent: true }));
    const snapshot = structuredSnapshot();
    // GuidedSessionCaptureService only touches pending_sessions — seed it too.
    (db as unknown as { tables: Record<string, Row[]> }).tables.pending_sessions = [snapshot as unknown as Row];

    const capture = new GuidedSessionCaptureService(db.asClient());
    const identity: GuidedMenuIdentity = {
      lineUserId: "user-1",
      sourceType: "group",
      sourceId: "group-1",
      sessionKey: SESSION_KEY,
    };
    const menu = await capture.snapshot(identity);
    expect(menu.status).toBe("ok");
    if (menu.status !== "ok") return;

    await finalizePendingGeneration(db.asClient(), snapshot, async () => ({}));
    const call = tryFinalizeCall(db);
    const finalizerItems = call.args.p_items as Row[];

    expect(finalizerItems.map((i) => i.product_name)).toEqual(
      menu.parsed.items.map((i) => i.product_name),
    );
    expect(finalizerItems.map((i) => i.quantity)).toEqual(
      menu.parsed.items.map((i) => i.quantity),
    );
    expect(menu.parsed.parse_errors).toEqual([]);
    expect((call.args.p_session as Row).validation_errors).toEqual([]);
  });

  it("4. a valid two-item structured session finalizes successfully", async () => {
    const db = new FinalizerDocDouble(tables({ includeStaleCancelEvent: false }));
    const result = await finalizePendingGeneration(
      db.asClient(), structuredSnapshot(), async () => ({}),
    );
    expect(result.status).toBe("finalized");
    const call = tryFinalizeCall(db);
    expect((call.args.p_items as Row[])).toHaveLength(2);
    expect((call.args.p_session as Row).validation_errors).toEqual([]);
  });

  it("5. genuinely invalid accumulated_text still fails closed", async () => {
    const brokenText = "\n1. แตงโม 40 บาท\n3 ลูก\nไม่ใช่รายการสินค้า";
    const db = new FinalizerDocDouble({
      pending_session_ingest: [
        {
          session_key: SESSION_KEY, session_generation: GENERATION,
          line_event_id: "evt-1", line_timestamp_ms: 1_000, raw_text: brokenText,
        },
      ],
      pending_session_admission: [
        { session_key: SESSION_KEY, session_generation: GENERATION, line_event_id: "evt-1", line_timestamp_ms: 1_000 },
      ],
      raw_messages: [{ id: "raw-close-1", line_event_id: "close-evt-1" }],
      produce_sessions: [],
    });
    await finalizePendingGeneration(
      db.asClient(), structuredSnapshot({ accumulated_text: brokenText }), async () => ({}),
    );
    const call = tryFinalizeCall(db);
    const errors = (call.args.p_session as Row).validation_errors as string[];
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("unrecognized line"))).toBe(true);
  });

  it("6. no duplicate produce writes — exactly one finalize RPC call, items not duplicated", async () => {
    const db = new FinalizerDocDouble(tables({ includeStaleCancelEvent: true }));
    await finalizePendingGeneration(db.asClient(), structuredSnapshot(), async () => ({}));

    expect(db.rpcCalls.filter((c) => c.name === "try_finalize_pending_generation")).toHaveLength(1);
    const call = tryFinalizeCall(db);
    expect((call.args.p_items as Row[])).toHaveLength(2);
  });

  it("7. ownership/generation identity passed to the finalize RPC is unchanged by this fix", async () => {
    const db = new FinalizerDocDouble(tables({ includeStaleCancelEvent: true }));
    await finalizePendingGeneration(db.asClient(), structuredSnapshot(), async () => ({}));

    const call = tryFinalizeCall(db);
    expect(call.args.p_session_key).toBe(SESSION_KEY);
    expect(call.args.p_expected_generation).toBe(GENERATION);
    expect(call.args.p_expected_line_user_id).toBe("user-1");

    // The capture layer's own ownership gate is untouched by this fix.
    (db as unknown as { tables: Record<string, Row[]> }).tables.pending_sessions = [
      structuredSnapshot({ line_user_id: "someone-else" }) as unknown as Row,
    ];
    const capture = new GuidedSessionCaptureService(db.asClient());
    const refused = await capture.snapshot({
      lineUserId: "user-1", sourceType: "group", sourceId: "group-1", sessionKey: SESSION_KEY,
    });
    expect(refused).toEqual({ status: "refused", reason: "ownership_conflict" });
  });

  it("8. legacy (entry_origin NULL) finalization never touches the admission ledger", async () => {
    const legacyText = "พี่ดำ-วิหาร เบิก 26/5/2569\n1.ทุเรียน100บาท\n2โล\nจบรายการ 1 รายการ";
    const db = new FinalizerDocDouble({
      pending_session_ingest: [
        {
          session_key: SESSION_KEY, session_generation: GENERATION,
          line_event_id: "evt-1", line_timestamp_ms: 1_000, raw_text: legacyText,
        },
      ],
      pending_session_admission: [],
      raw_messages: [{ id: "raw-close-1", line_event_id: "close-evt-1" }],
      produce_sessions: [],
    });
    const legacySnapshot = structuredSnapshot({
      accumulated_text: legacyText,
      entry_origin: null,
      command_contract_version: null,
      business_date: null,
      transaction_time: null,
      transaction_time_source: null,
      staff_label: null,
      market_label: null,
      session_kind: null,
      initial_transaction_type: null,
      opened_line_event_id: null,
      accountability_round_id: null,
    });

    await finalizePendingGeneration(db.asClient(), legacySnapshot, async () => ({}));

    expect(db.fromCalls).not.toContain("pending_session_admission");
    const call = tryFinalizeCall(db);
    expect(call.args.p_raw_text).toBe(legacyText);
  });
});

describe("durable success notification limit", () => {
  it("caps an oversized advisory-free finalizer payload before storing the outbox row", async () => {
    const largeText = Array.from(
      { length: 150 },
      (_, index) => `${index + 1}. แตงโม 25 บาท\n1 ลูก`,
    ).join("\n");
    const db = new FinalizerDocDouble({
      ...tables({ includeStaleCancelEvent: false }),
      produce_items: [],
      produce_transactions: [],
      produce_entry_validation_reviews: [],
      produce_session_notifications: [],
    });

    const result = await finalizePendingGeneration(
      db.asClient(),
      structuredSnapshot({ accumulated_text: largeText }),
      async () => ({}),
    );

    expect(result.status).toBe("finalized");
    expect(tryFinalizeCall(db).args.p_items as Row[]).toHaveLength(150);
    const payload = String(db.rows("produce_session_notifications")[0]?.notification_payload);
    expect(countCodePoints(payload)).toBeLessThanOrEqual(5000);
    expect(payload).toContain("…สรุปรายการถูกย่อเนื่องจากข้อความยาวเกินกำหนด");
    expect(payload).not.toContain("…สรุปรายการถูกย่อเพื่อแสดงคำเตือนราคา");
    expect(payload).not.toContain("⚠️ พบ");
  });
});

/**
 * A WeighSessionItem carries lookup-only evidence next to its real price:
 * legacy_subunit_price_per_unit, the value the retired ขีด/กรัม rescaling
 * would have produced (see weigh-session/types.ts). The RPC payload used to be
 * a spread of the whole item, which put that second, contradictory price on
 * the wire to Postgres — inert against today's named-key extraction, and one
 * permissive change away from resurrecting the 120→1200 bug.
 */
describe("the finalizer RPC payload carries the item's real price only", () => {
  const KHEED_TEXT = "\n1. องุ่นคิมสัน 120 บาท\n0.7 ขีด";

  it("sends the header price and never the retired subunit rescaling", async () => {
    const db = new FinalizerDocDouble(tables({
      includeStaleCancelEvent: false,
      accumulatedTextInLedger: KHEED_TEXT,
    }));
    await finalizePendingGeneration(
      db.asClient(),
      structuredSnapshot({ accumulated_text: KHEED_TEXT }),
      async () => ({}),
    );

    const items = tryFinalizeCall(db).args.p_items as Row[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      product_name:   "องุ่นคิมสัน",
      quantity:       0.07,
      unit:           "โล",
      price_per_unit: 120,
    });
    expect(Object.keys(items[0])).not.toContain("legacy_subunit_price_per_unit");
    // Belt and braces: the retired value must not appear anywhere in the
    // serialized payload, under any key.
    expect(JSON.stringify(items[0])).not.toContain("1200");
  });
});

const GUIDED_PRICE_RETURN = [
  "1.แตงไทย25บาท",
  "22ลูก",
].join("\n");

function guidedFlowTables(
  snapshot: PendingSession,
  master: Row[],
): Record<string, Row[]> {
  return {
    pending_sessions: [snapshot as unknown as Row],
    pending_session_ingest: [{
      session_key: SESSION_KEY,
      session_generation: GENERATION,
      line_event_id: "item-evt-1",
      line_timestamp_ms: 1_000,
      raw_text: snapshot.accumulated_text,
    }],
    pending_session_admission: [{
      session_key: SESSION_KEY,
      session_generation: GENERATION,
      line_event_id: "item-evt-1",
      line_timestamp_ms: 1_000,
    }],
    raw_messages: [{ id: "raw-guided-close", line_event_id: "guided-close" }],
    produce_transactions: master,
    produce_entry_validation_reviews: [],
    produce_items: [],
    produce_sessions: [],
    produce_session_notifications: [],
  };
}

const GUIDED_IDENTITY: GuidedMenuIdentity = {
  lineUserId: "user-1",
  sourceType: "group",
  sourceId: "group-1",
  sessionKey: SESSION_KEY,
};

function guidedReturnSnapshot(text = GUIDED_PRICE_RETURN): PendingSession {
  return structuredSnapshot({
    accumulated_text: text,
    business_date: "2026-08-20",
    transaction_time: "17:00",
    staff_label: "ขวัญ",
    market_label: "ตลาด72",
    initial_transaction_type: "คืน",
    ingest_revision: 1,
  });
}

async function closeGuidedReturn(db: FinalizerDocDouble) {
  return new GuidedSessionCaptureService(db.asClient()).requestClose({
    identity: GUIDED_IDENTITY,
    lineEventId: "guided-close",
    lineTimestampMs: 2_000,
  });
}

describe("guided price advisories survive deferred finalization", () => {
  it("closes once, persists entered price 25, and writes the advisory to the outbox", async () => {
    const snapshot = guidedReturnSnapshot();
    const withdrawal = {
      accountability_round_id: ROUND_ID,
      product_name: "แตงไทย",
      unit: "ลูก",
      quantity: 28,
      price_per_unit: 20,
      transaction_type: "เบิก",
    };
    const db = new FinalizerDocDouble(guidedFlowTables(snapshot, [withdrawal]));

    const closed = await closeGuidedReturn(db);
    expect(closed.status).toBe("closed");
    if (closed.status !== "closed") return;
    expect(db.rpcCalls.filter((call) => call.name === "close_produce_structured_session"))
      .toHaveLength(1);
    expect(db.rpcCalls.some((call) => call.name === "record_produce_validation_review"))
      .toBe(false);
    expect(db.rpcCalls.some((call) => call.name === "confirm_produce_validation_review"))
      .toBe(false);

    const finalized = await finalizePendingGeneration(db.asClient(), closed.session, async () => ({}));
    expect(finalized.status).toBe("finalized");

    const finalizerCall = db.rpcCalls.find(
      (call) => call.name === "try_finalize_pending_generation",
    );
    expect((finalizerCall?.args.p_session as Row).validation_errors).toEqual([]);

    const returnRow = db.rows("produce_items").find(
      (row) => row.product_name === "แตงไทย" && row.transaction_type === "คืน",
    );
    expect(returnRow?.price_per_unit).toBe(25);
    const withdrawalRow = db.rows("produce_transactions").find(
      (row) => row.product_name === "แตงไทย" && row.transaction_type === "เบิก",
    );
    expect(withdrawalRow?.price_per_unit).toBe(20);
    expect(db.rows("produce_entry_validation_reviews")).toHaveLength(0);

    const payload = String(db.rows("produce_session_notifications")[0]?.notification_payload);
    expect(payload).toContain("⚠️ พบ 1 รายการที่ราคาแตกต่างจากตอนเบิก");
    expect(payload).toContain("แตงไทย — เบิก 20 บาท/ลูก → ชั่งคืน 25 บาท/ลูก");
    expect(payload).toContain("ระบบบันทึกตามราคาที่กรอกไว้แล้ว");
    expect(payload).not.toContain("entry validation review was never confirmed");
    expect(countCodePoints(payload)).toBeLessThanOrEqual(5000);
  });

  it("fails closed without produce writes when live master data adds a hard block", async () => {
    const text = [GUIDED_PRICE_RETURN, "2.มังคุด45บาท", "35.2โล"].join("\n");
    const snapshot = guidedReturnSnapshot(text);
    const melon = {
      accountability_round_id: ROUND_ID,
      product_name: "แตงไทย",
      unit: "ลูก",
      quantity: 28,
      price_per_unit: 20,
      transaction_type: "เบิก",
    };
    const mangosteen = {
      accountability_round_id: ROUND_ID,
      product_name: "มังคุด",
      unit: "โล",
      quantity: 36,
      price_per_unit: 45,
      transaction_type: "เบิก",
    };
    const db = new FinalizerDocDouble(guidedFlowTables(snapshot, [melon, mangosteen]));

    const closed = await closeGuidedReturn(db);
    expect(closed.status).toBe("closed");
    if (closed.status !== "closed") return;

    // A live master change after close must be caught by deferred revalidation.
    mangosteen.quantity = 28.8;
    const finalized = await finalizePendingGeneration(db.asClient(), closed.session, async () => ({}));
    expect(finalized.status).toBe("failed_closed");

    const call = db.rpcCalls.find((candidate) => candidate.name === "try_finalize_pending_generation");
    const errors = ((call?.args.p_session as Row | undefined)?.validation_errors ?? []) as string[];
    expect(errors).toContain("return_exceeds_withdrawal");
    expect(db.rows("produce_items")).toHaveLength(0);
    expect(db.rows("produce_sessions")).toHaveLength(0);
    expect(db.rows("produce_session_notifications")).toHaveLength(0);
  });

  it("fails closed when structured round identity is unexpectedly missing", async () => {
    const snapshot = guidedReturnSnapshot();
    snapshot.accountability_round_id = null;
    snapshot.close_event_timestamp_ms = 2_000;
    snapshot.close_requested_at = "2026-08-20T10:01:00.000Z";
    snapshot.close_line_event_id = "guided-close";
    snapshot.close_session_generation = GENERATION;
    const db = new FinalizerDocDouble(guidedFlowTables(snapshot, []));

    const finalized = await finalizePendingGeneration(db.asClient(), snapshot, async () => ({}));
    expect(finalized.status).toBe("failed_closed");
    const call = db.rpcCalls.find((candidate) => candidate.name === "try_finalize_pending_generation");
    const errors = ((call?.args.p_session as Row | undefined)?.validation_errors ?? []) as string[];
    expect(errors).toContain("structured session accountability round is missing");
    expect(db.rows("produce_items")).toHaveLength(0);
  });
});

describe("safe product auto-correction reaches authoritative finalization", () => {
  it("persists canonical กะปิ and records the correction in the success notification", async () => {
    const snapshot = guidedReturnSnapshot(["1.กระปิ50บาท", "2ถุง"].join("\n"));
    const withdrawal = {
      accountability_round_id: ROUND_ID,
      product_name: "กะปิ",
      unit: "ถุง",
      quantity: 5,
      price_per_unit: 50,
      transaction_type: "เบิก",
    };
    const db = new FinalizerDocDouble(guidedFlowTables(snapshot, [withdrawal]));
    const closed = await closeGuidedReturn(db);
    expect(closed.status).toBe("closed");
    if (closed.status !== "closed") return;

    const finalized = await finalizePendingGeneration(db.asClient(), closed.session, async () => ({}));
    expect(finalized.status).toBe("finalized");
    const call = db.rpcCalls.find((candidate) => candidate.name === "try_finalize_pending_generation");
    const [persisted] = (call?.args.p_items ?? []) as Row[];
    expect(persisted.product_name).toBe("กะปิ");
    expect(db.rows("produce_entry_validation_reviews")).toHaveLength(0);

    const payload = String(db.rows("produce_session_notifications")[0]?.notification_payload);
    expect(payload).toContain("✏️ ระบบแก้ชื่อสินค้าอัตโนมัติ");
    expect(payload).toContain("ข้อ 1: กระปิ → กะปิ");
  });
});