import { describe, expect, test } from "bun:test";
import {
  CORRECTION_WINDOW_MS,
  diagnoseSubmission,
  documentSubject,
  thaiShortDate,
  type SubmissionBlocker,
  type SubmissionFacts,
} from "./diagnostics";

const NOW = Date.parse("2026-10-08T03:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const item22: SubmissionBlocker = {
  itemNumber: 22,
  productName: "กล้วยน้ำหว้า",
  kind: "parse_error",
  kindThai: "อ่านรายการไม่ได้",
  detailThai: "ระบบอ่านข้อนี้ไม่ได้ ราคาหรือจำนวนอาจพิมพ์ไม่ครบหรือสะกดผิด",
};

const subunit7: SubmissionBlocker = {
  itemNumber: 7,
  productName: "พริก",
  kind: "subunit_confirmation",
  kindThai: "ต้องยืนยันจำนวน",
  detailThai: "จำนวนเป็นขีดหรือกรัม ต้องยืนยันการแปลงหน่วยก่อน",
};

function facts(overrides: Partial<SubmissionFacts> = {}): SubmissionFacts {
  return {
    finalizationStatus: "pending",
    terminalized: false,
    failureReason: null,
    structured: false,
    closeRequestedAt: null,
    closeRefusedAt: null,
    nextAttemptAt: null,
    finalizeHoldUntil: null,
    finalizeConfirmedAt: null,
    updatedAt: minutesAgo(2),
    produceSession: { kind: "not_checked" },
    capture: { acceptedCount: null, reviewCount: null, blockers: [], acceptedItemNumbers: [], source: "none" },
    header: { businessDate: "2026-10-07", staff: "น้อย", market: "ราชพฤกษ์", transactionKind: "return" },
    ...overrides,
  };
}

const incidentCapture: SubmissionFacts["capture"] = {
  acceptedCount: 23,
  reviewCount: 1,
  blockers: [item22],
  acceptedItemNumbers: [],
  source: "snapshot",
};

function expectWorkerSafe(message: string) {
  expect(message).not.toMatch(/[A-Za-z]/);
  expect(message).toContain("ครับ");
  for (const term of ["failed_closed", "terminalized", "partial_capture", "session"]) {
    expect(message).not.toContain(term);
  }
}

describe("documentSubject / thaiShortDate", () => {
  test("formats the incident subject", () => {
    expect(thaiShortDate("2026-10-07")).toBe("7 ต.ค.");
    expect(documentSubject(facts().header)).toBe("รายการชั่งคืนของน้อย–ราชพฤกษ์ วันที่ 7 ต.ค.");
  });

  test("degrades without inventing missing parts", () => {
    expect(thaiShortDate("garbage")).toBeNull();
    expect(documentSubject({ businessDate: null, staff: null, market: null, transactionKind: null })).toBe("รายการ");
  });
});

describe("diagnoseSubmission", () => {
  test("2026-10-07 incident: refused close terminalized → failed_terminal, admin only", () => {
    const result = diagnoseSubmission(facts({
      finalizationStatus: "failed_closed",
      terminalized: true,
      failureReason: "close_refused_unresolved",
      capture: incidentCapture,
    }), NOW);
    expect(result.state).toBe("failed_terminal");
    expect(result.persisted).toBe(false);
    expect(result.savedItemCount).toBeNull();
    expect(result.acceptedUnsavedCount).toBe(23);
    expect(result.allowedActions).toEqual(["contact_admin_recovery"]);
    expect(result.canCorrectInPlace).toBe(false);
    expect(result.blockers.map((blocker) => blocker.itemNumber)).toContain(22);
    expect(result.workerMessage).toBe(
      "รายการชั่งคืนของน้อย–ราชพฤกษ์ วันที่ 7 ต.ค. ยังบันทึกไม่สำเร็จครับ ระบบอ่านได้ 23 รายการ แต่ข้อ 22 ต้องแก้ และรอบเดิมปิดไปแล้ว ตอนนี้ไม่ควรส่งคำสั่งแก้ต่อในรอบเดิม กรุณาให้ผู้ดูแลตรวจและดำเนินการกู้รายการตามขั้นตอนที่ระบบรองรับครับ",
    );
    expect(result.workerMessage).not.toContain("บันทึกแล้ว");
    expectWorkerSafe(result.workerMessage);
  });

  test.each([
    "validation_failed",
    "missing_items",
    "review_not_confirmed",
    "unconfirmed_structured_close",
    "withdrawal_containment",
    "replacement_predecessor_not_found",
    "expired_incomplete",
  ])("failed_closed reason %s is terminal and never suggests correcting in the old round", (reason) => {
    const result = diagnoseSubmission(facts({
      finalizationStatus: "failed_closed",
      terminalized: true,
      failureReason: reason,
    }), NOW);
    expect(result.state).toBe("failed_terminal");
    expect(result.allowedActions).toEqual(["contact_admin_recovery"]);
    expectWorkerSafe(result.workerMessage);
  });

  test("unrecognized failure reason → unknown, honest message", () => {
    const result = diagnoseSubmission(facts({
      finalizationStatus: "failed_closed",
      terminalized: true,
      failureReason: "something_new",
    }), NOW);
    expect(result.state).toBe("unknown");
    expect(result.workerMessage).toContain("ยังตรวจสอบสถานะ");
    expect(result.workerMessage).not.toContain("บันทึกแล้ว");
    expectWorkerSafe(result.workerMessage);
  });

  test("failed_closed but not terminalized is contradictory → unknown", () => {
    expect(diagnoseSubmission(facts({ finalizationStatus: "failed_closed" }), NOW).state).toBe("unknown");
  });

  test("user_cancelled and superseded are cancelled_or_superseded", () => {
    const cancelled = diagnoseSubmission(facts({
      finalizationStatus: "failed_closed", terminalized: true, failureReason: "user_cancelled",
    }), NOW);
    expect(cancelled.state).toBe("cancelled_or_superseded");
    expect(cancelled.allowedActions).toEqual(["start_new_document"]);
    const superseded = diagnoseSubmission(facts({
      finalizationStatus: "failed_closed", terminalized: true, failureReason: "superseded",
    }), NOW);
    expect(superseded.state).toBe("cancelled_or_superseded");
    expect(superseded.allowedActions).toEqual(["nothing_needed"]);
  });

  test("finalized needs a proven produce session", () => {
    const proven = diagnoseSubmission(facts({
      finalizationStatus: "finalized",
      terminalized: true,
      produceSession: { kind: "proven", totalItems: 24, voided: false, replaced: false },
    }), NOW);
    expect(proven.state).toBe("finalized");
    expect(proven.persisted).toBe(true);
    expect(proven.savedItemCount).toBe(24);
    expect(proven.allowedActions).toEqual(["nothing_needed"]);
    expectWorkerSafe(proven.workerMessage);

    for (const produceSession of [{ kind: "missing" as const }, { kind: "not_checked" as const }]) {
      const result = diagnoseSubmission(facts({ finalizationStatus: "finalized", terminalized: true, produceSession }), NOW);
      expect(result.state).toBe("unknown");
      expect(result.persisted).toBe(false);
      expect(result.savedItemCount).toBeNull();
    }
  });

  test("voided produce session is not persisted", () => {
    const result = diagnoseSubmission(facts({
      finalizationStatus: "finalized",
      terminalized: true,
      produceSession: { kind: "proven", totalItems: 24, voided: true, replaced: true },
    }), NOW);
    expect(result.state).toBe("cancelled_or_superseded");
    expect(result.persisted).toBe(false);
  });

  test("duplicate: nothing needed; persisted only with this generation's row", () => {
    const contentHash = diagnoseSubmission(facts({ finalizationStatus: "duplicate", terminalized: true }), NOW);
    expect(contentHash.state).toBe("duplicate_already_saved");
    expect(contentHash.persisted).toBe(false);
    expect(contentHash.allowedActions).toEqual(["nothing_needed"]);
    expect(contentHash.workerMessage).not.toContain("บันทึกแล้ว");
    const replay = diagnoseSubmission(facts({
      finalizationStatus: "duplicate",
      terminalized: true,
      produceSession: { kind: "proven", totalItems: 5, voided: false, replaced: false },
    }), NOW);
    expect(replay.persisted).toBe(true);
  });

  test("expired_empty_draft → expired_empty, start new", () => {
    const result = diagnoseSubmission(facts({ finalizationStatus: "expired_empty_draft", terminalized: true }), NOW);
    expect(result.state).toBe("expired_empty");
    expect(result.allowedActions).toEqual(["start_new_document"]);
  });

  test("close refused inside the window → correct / remove / close again", () => {
    const result = diagnoseSubmission(facts({
      closeRefusedAt: minutesAgo(3),
      updatedAt: minutesAgo(3),
      capture: incidentCapture,
    }), NOW);
    expect(result.state).toBe("close_refused_correctable");
    expect(result.allowedActions).toEqual([
      "correct_item_in_open_draft", "remove_item_in_open_draft", "send_close_again",
    ]);
    expect(result.canCorrectInPlace).toBe(true);
    expect(result.workerMessage).toContain("แก้ข้อ 22");
    expectWorkerSafe(result.workerMessage);
  });

  test("close refused past the grace window adds admin escalation", () => {
    const result = diagnoseSubmission(facts({
      closeRefusedAt: new Date(NOW - CORRECTION_WINDOW_MS - 60_000).toISOString(),
      updatedAt: new Date(NOW - CORRECTION_WINDOW_MS - 60_000).toISOString(),
      capture: incidentCapture,
    }), NOW);
    expect(result.state).toBe("close_refused_correctable");
    expect(result.allowedActions).toContain("contact_admin_recovery");
  });

  test("close refused with no known blocker → admin, no invented fix", () => {
    const result = diagnoseSubmission(facts({ closeRefusedAt: minutesAgo(3) }), NOW);
    expect(result.state).toBe("close_refused_correctable");
    expect(result.allowedActions).toEqual(["contact_admin_recovery"]);
    expect(result.canCorrectInPlace).toBe(false);
  });

  test("subunit review offers ยืนยันข้อ only for that kind", () => {
    const result = diagnoseSubmission(facts({
      capture: { acceptedCount: 5, reviewCount: 1, blockers: [subunit7], acceptedItemNumbers: [], source: "snapshot" },
    }), NOW);
    expect(result.state).toBe("needs_correction");
    expect(result.allowedActions).toEqual(["confirm_review"]);
    expect(result.workerMessage).toContain("ยืนยันข้อ 7");
  });

  test("open draft with no issues is capturing; with issues needs_correction", () => {
    const capturing = diagnoseSubmission(facts({
      capture: { acceptedCount: 4, reviewCount: 0, blockers: [], acceptedItemNumbers: [1, 2, 3, 4], source: "snapshot" },
    }), NOW);
    expect(capturing.state).toBe("capturing");
    expect(capturing.allowedActions).toEqual([]);
    const needs = diagnoseSubmission(facts({ capture: incidentCapture }), NOW);
    expect(needs.state).toBe("needs_correction");
    expect(needs.allowedActions).toEqual(["correct_item_in_open_draft", "remove_item_in_open_draft"]);
  });

  test("structured hold: confirm before the deadline, unknown after", () => {
    const held = diagnoseSubmission(facts({
      structured: true,
      closeRequestedAt: minutesAgo(1),
      finalizeHoldUntil: new Date(NOW + 5 * 60_000).toISOString(),
    }), NOW);
    expect(held.state).toBe("awaiting_confirmation");
    expect(held.allowedActions).toEqual(["confirm_review"]);
    expectWorkerSafe(held.workerMessage);
    const expired = diagnoseSubmission(facts({
      structured: true,
      closeRequestedAt: minutesAgo(20),
      finalizeHoldUntil: minutesAgo(10),
    }), NOW);
    expect(expired.state).toBe("unknown");
  });

  test("close scheduled → finalization_pending; slow adds admin", () => {
    const pending = diagnoseSubmission(facts({ closeRequestedAt: minutesAgo(1), nextAttemptAt: minutesAgo(0) }), NOW);
    expect(pending.state).toBe("finalization_pending");
    expect(pending.allowedActions).toEqual(["wait_for_finalization"]);
    expect(pending.persisted).toBe(false);
    const processing = diagnoseSubmission(facts({ finalizationStatus: "processing", closeRequestedAt: minutesAgo(45) }), NOW);
    expect(processing.state).toBe("finalization_pending");
    expect(processing.allowedActions).toEqual(["wait_for_finalization", "contact_admin_recovery"]);
  });

  test("closed but parked with a subunit review → confirm then close again", () => {
    const result = diagnoseSubmission(facts({
      closeRequestedAt: minutesAgo(2),
      updatedAt: minutesAgo(2),
      capture: { acceptedCount: 5, reviewCount: 1, blockers: [subunit7], acceptedItemNumbers: [], source: "snapshot" },
    }), NOW);
    expect(result.state).toBe("awaiting_confirmation");
    expect(result.allowedActions).toEqual(["confirm_review", "send_close_again"]);
  });

  test("closed, parked, no explanation → unknown", () => {
    expect(diagnoseSubmission(facts({ closeRequestedAt: minutesAgo(2) }), NOW).state).toBe("unknown");
  });
});
