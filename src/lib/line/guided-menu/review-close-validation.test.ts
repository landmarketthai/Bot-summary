/**
 * Second review, finding #2 — validate BEFORE the immutable close boundary.
 *
 * `close_produce_structured_session` writes a boundary that cannot be undone,
 * and after it the round stops accepting item text. Discovering a validation
 * problem at confirm time therefore left the operator stuck with an
 * administrator as the only way out.
 *
 * The finalizer's own validation now runs first, so an unfinishable round is
 * refused with no boundary at all and a correction is still an ordinary append.
 * The confirm-time check stays where it was: content can change between the two
 * presses, and a straggler admitted after the close can still make the final
 * parse differ.
 */

import { describe, expect, it } from "bun:test";
import { GuidedMenuUxHandler } from "./ux-handler";
import { GuidedMenuFakeDatabase } from "./test-fake-db";
import { GuidedSessionCaptureService } from "./session-capture";
import { GUIDED_MENU_COPY } from "./ux-types";
import type { MenuActionType } from "./menu-state-types";

const IDENTITY = {
  lineUserId: "U-op-1",
  sourceType: "group" as const,
  sourceId: "G-1",
  sessionKey: "group:G-1:user:U-op-1",
};
const SESSION_KEY = "group:G-1:user:U-op-1";
const TS = Date.parse("2026-07-29T10:00:00+07:00");

/** Product line + quantity/unit line: genuinely finalizable. */
const VALID_TEXT = "1.ทุเรียน100บาท\n2โล";
/** Parses into an item, but has no quantity or unit — never finalizable. */
const INVALID_TEXT = "1.ทุเรียน100บาท";
/** The correction the operator sends after the refusal. */
const CORRECTION = "2โล";

function seed(db: GuidedMenuFakeDatabase): GuidedMenuUxHandler {
  db.seedOperator({
    line_user_id: IDENTITY.lineUserId,
    staff_label: "ผู้บันทึก",
    active: true,
  });
  db.seedMarket({ market_code: "wat", label: "วัดทุ่งลานนา", active: true });
  db.seedSeller({ seller_code: "kee", label: "กี้", active: true, sort_order: 1 });
  db.seedSellerMarket({
    seller_code: "kee",
    market_code: "wat",
    active: true,
    sort_order: 1,
  });
  return new GuidedMenuUxHandler(db.asClient());
}

function seedOpenRound(
  db: GuidedMenuFakeDatabase,
  overrides: Record<string, unknown> = {},
): void {
  db.seedPendingSession({
    session_key: SESSION_KEY,
    source_id: "G-1",
    line_user_id: "U-op-1",
    session_generation: "gen-open",
    accumulated_text: VALID_TEXT,
    terminalized: false,
    close_event_timestamp_ms: null,
    opened_line_event_id: "evt-open",
    entry_origin: "structured_menu",
    command_contract_version: 1,
    business_date: "2026-07-29",
    transaction_time: "10:00",
    transaction_time_source: "line_event",
    staff_label: "กี้",
    market_label: "วัดทุ่งลานนา",
    session_kind: "main",
    initial_transaction_type: "เบิก",
    declared_transaction_type: null,
    additional_opener: null,
    ...overrides,
  });
}

async function mintToken(
  db: GuidedMenuFakeDatabase,
  actionType: Extract<MenuActionType, "request_close" | "confirm_finalize">,
): Promise<string> {
  const { GuidedMenuStateService } = await import("./menu-state-service");
  const created = await new GuidedMenuStateService(db.asClient()).createState({
    actionType,
    lineUserId: IDENTITY.lineUserId,
    sourceType: IDENTITY.sourceType,
    sourceId: IDENTITY.sourceId,
    sessionKey: IDENTITY.sessionKey,
    payload: {},
  });
  if (created.status !== "created") throw new Error("token mint refused");
  return created.wireToken;
}

function row(db: GuidedMenuFakeDatabase): Record<string, unknown> {
  const found = (db.tables.pending_sessions ?? [])[0];
  if (!found) throw new Error("no pending session seeded");
  return found;
}

import { guidedControlLabels } from "./messages";

function controlLabels(messages: unknown[]): string[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const labels = guidedControlLabels(messages[i]);
    if (labels.length > 0) return labels;
  }
  return [];
}

describe("จบรายการ validates before it writes the close boundary", () => {
  it("creates no boundary for a round that cannot finalize", async () => {
    const db = new GuidedMenuFakeDatabase();
    seed(db);
    seedOpenRound(db, { accumulated_text: INVALID_TEXT });

    const capture = new GuidedSessionCaptureService(db.asClient());
    const outcome = await capture.requestClose({
      identity: IDENTITY,
      lineEventId: "evt-close",
      lineTimestampMs: TS,
    });

    expect(outcome.status).toBe("validation_failed");
    if (outcome.status !== "validation_failed") return;
    expect(outcome.errors.length).toBeGreaterThan(0);
    // The two things that make the boundary immutable were never written.
    expect(row(db).close_event_timestamp_ms).toBeNull();
    expect(row(db).close_line_event_id ?? null).toBeNull();
    expect(db.closeRpcCalls).toBe(0);
    expect(row(db).terminalized).toBe(false);
  });

  it("keeps the round in capture so a correction is an ordinary append", async () => {
    const db = new GuidedMenuFakeDatabase();
    seed(db);
    seedOpenRound(db, { accumulated_text: INVALID_TEXT });
    const capture = new GuidedSessionCaptureService(db.asClient());

    await capture.requestClose({
      identity: IDENTITY,
      lineEventId: "evt-close-1",
      lineTimestampMs: TS,
    });

    // The append path the operator's next message takes is unaffected: the row
    // is still open and unclosed, so the accumulated text can still grow.
    const current = row(db);
    current.accumulated_text = `${INVALID_TEXT}\n${CORRECTION}`;

    const snapshot = await capture.snapshot(IDENTITY);
    expect(snapshot.status).toBe("ok");
    if (snapshot.status !== "ok") return;
    expect(snapshot.closeRequested).toBe(false);
    expect(snapshot.parsed.items).toHaveLength(1);
  });

  it("closes and finalizes once the correction has been sent", async () => {
    const db = new GuidedMenuFakeDatabase();
    seed(db);
    seedOpenRound(db, { accumulated_text: INVALID_TEXT });
    const capture = new GuidedSessionCaptureService(db.asClient());

    const refused = await capture.requestClose({
      identity: IDENTITY,
      lineEventId: "evt-close-1",
      lineTimestampMs: TS,
    });
    expect(refused.status).toBe("validation_failed");

    row(db).accumulated_text = `${INVALID_TEXT}\n${CORRECTION}`;

    const closed = await capture.requestClose({
      identity: IDENTITY,
      lineEventId: "evt-close-2",
      lineTimestampMs: TS + 1000,
    });
    expect(closed.status).toBe("closed");
    expect(row(db).close_event_timestamp_ms).not.toBeNull();

    db.deferredFinalizerOutcome = "finalized";
    const confirmed = await capture.confirmFinalize({
      identity: IDENTITY,
      lineEventId: "evt-confirm",
      lineTimestampMs: TS + 2000,
    });
    expect(confirmed.status).toBe("confirmed");
  });

  it("leaves a valid request-close exactly as it was", async () => {
    const db = new GuidedMenuFakeDatabase();
    seed(db);
    seedOpenRound(db);

    const outcome = await new GuidedSessionCaptureService(db.asClient()).requestClose({
      identity: IDENTITY,
      lineEventId: "evt-close",
      lineTimestampMs: TS,
    });
    expect(outcome.status).toBe("closed");
    if (outcome.status !== "closed") return;
    expect(outcome.reason).toBe("first_close");
    expect(row(db).close_event_timestamp_ms).toBe(TS);
  });

  it("stays idempotent when the same close press is delivered twice", async () => {
    const db = new GuidedMenuFakeDatabase();
    seed(db);
    seedOpenRound(db);
    const capture = new GuidedSessionCaptureService(db.asClient());

    const first = await capture.requestClose({
      identity: IDENTITY,
      lineEventId: "evt-close",
      lineTimestampMs: TS,
    });
    const second = await capture.requestClose({
      identity: IDENTITY,
      lineEventId: "evt-close",
      lineTimestampMs: TS,
    });
    expect(first.status).toBe("closed");
    expect(second.status).toBe("closed");
  });

  it("does not start refusing a round whose boundary already exists", async () => {
    // The content went bad AFTER the close. The boundary is already there, so
    // this is confirm-time's problem — request-close must not change its answer.
    const db = new GuidedMenuFakeDatabase();
    seed(db);
    seedOpenRound(db, {
      accumulated_text: INVALID_TEXT,
      close_event_timestamp_ms: TS,
      close_line_event_id: "evt-close",
    });

    const outcome = await new GuidedSessionCaptureService(db.asClient()).requestClose({
      identity: IDENTITY,
      lineEventId: "evt-close",
      lineTimestampMs: TS,
    });
    expect(outcome.status).toBe("closed");
  });

  it("still blocks at confirm time when the content changed after the close", async () => {
    const db = new GuidedMenuFakeDatabase();
    seed(db);
    seedOpenRound(db);
    const capture = new GuidedSessionCaptureService(db.asClient());

    await capture.requestClose({
      identity: IDENTITY,
      lineEventId: "evt-close",
      lineTimestampMs: TS,
    });
    // A straggler admitted through the boundary makes the final parse invalid.
    row(db).accumulated_text = INVALID_TEXT;

    const outcome = await capture.confirmFinalize({
      identity: IDENTITY,
      lineEventId: "evt-confirm",
      lineTimestampMs: TS + 1000,
    });
    expect(outcome.status).toBe("validation_failed");
    expect(row(db).finalize_confirmed_at ?? null).toBeNull();
  });
});

describe("the refusal screen keeps the operator in capture", () => {
  it("offers จบรายการ again and never the white sheet", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedOpenRound(db, { accumulated_text: INVALID_TEXT });

    const result = await handler.handlePostback({
      wireToken: await mintToken(db, "request_close"),
      lineEventId: "evt-close",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });

    expect(result.screen).toBe("session_validation_failed");
    const body = result.messages
      .map((m) => (m as { text: string }).text)
      .join("\n");
    expect(body).toContain(GUIDED_MENU_COPY.produceCloseValidationFailed.split("\n")[0]!);
    expect(body).not.toContain("กรอกใบขาว");
    expect(controlLabels(result.messages)).toContain(
      "จบรายการ",
    );
    expect(result.result).toMatchObject({ close_requested: false, saved: false });
  });

  it("names the offending line without leaking internal error text", async () => {
    const db = new GuidedMenuFakeDatabase();
    const handler = seed(db);
    seedOpenRound(db, { accumulated_text: INVALID_TEXT });

    const result = await handler.handlePostback({
      wireToken: await mintToken(db, "request_close"),
      lineEventId: "evt-close",
      identity: IDENTITY,
      lineTimestampMs: TS,
    });
    const body = result.messages
      .map((m) => (m as { text: string }).text)
      .join("\n");
    expect(body).toContain("ทุเรียน");
    expect(body).not.toContain("finalization_error");
    expect(body).not.toContain("Error");
  });
});
