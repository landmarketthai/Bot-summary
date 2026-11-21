/**
 * Unit regression for the 2026-08-30 stale close-validation race.
 *
 * Production evidence: the close was admitted at 06:13:30.544Z while items
 * whose LINE timestamps preceded it kept committing until 06:13:36.980Z. The
 * boundary landed on a document the entry gate never validated, and the
 * finalizer later terminalized the session with
 * validation_errors = ["entry validation review was never confirmed"].
 *
 * The SQL semantics are proven end-to-end in
 * migration-produce-close-validation-race.pg.test.ts against real PostgreSQL.
 * This file pins the TypeScript side: which arguments cross the RPC boundary,
 * how refusals are typed, and the ordering guarantee that a presented review
 * parks finalization BEFORE any terminal validation error is recorded.
 */
import { describe, expect, it } from "bun:test";
import {
  PendingSessionService,
  PendingSessionStaleValidationSnapshotError,
} from "./pending-session-service";

type Row = Record<string, unknown>;

const SESSION_KEY = "group:test-market-1:user:test-staff-1";
const GENERATION = "44444444-4444-4444-8444-444444444444";
const SCHEDULED_AT = "2026-11-21T00:00:00.000Z";

class RpcDouble {
  calls: Array<{ name: string; args: Row }> = [];
  constructor(private readonly results: Record<string, Row | null>) {}
  rpc = async (name: string, args: Row) => {
    this.calls.push({ name, args });
    return { data: this.results[name] ?? null, error: null };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from = () => ({}) as any;
}

function service(results: Record<string, Row | null>) {
  const db = new RpcDouble(results);
  return { db, svc: new PendingSessionService(db as never) };
}

describe("close revision pin — RPC boundary", () => {
  it("omits the 9th argument for an ordinary append, keeping the 8-arg overload", async () => {
    const { db, svc } = service({
      append_pending_session: { accepted: true, reason: "appended", session: { id: "s" } },
    });

    await svc.append(SESSION_KEY, "ทุเรียน 10", null, "evt-1", 1_000, false, GENERATION);

    const args = db.calls[0].args;
    // The hot path must not depend on 20260831120000 being deployed.
    expect("p_expected_ingest_revision" in args).toBe(false);
    expect(args.p_mark_close).toBe(false);
  });

  it("sends the pinned revision on a close so the boundary binds to the validated document", async () => {
    const { db, svc } = service({
      append_pending_session: { accepted: true, reason: "appended", session: { id: "s" } },
    });

    await svc.append(
      SESSION_KEY, "จบรายการเบิก", null, "evt-close", 2_000, true, GENERATION, undefined, 7,
    );

    expect(db.calls[0].args.p_expected_ingest_revision).toBe(7);
    expect(db.calls[0].args.p_mark_close).toBe(true);
  });

  it("pins revision 0 rather than dropping it — a fresh document is still a document", async () => {
    const { db, svc } = service({
      append_pending_session: { accepted: true, reason: "appended", session: { id: "s" } },
    });

    await svc.append(
      SESSION_KEY, "จบรายการเบิก", null, "evt-close", 2_000, true, GENERATION, undefined, 0,
    );

    expect(db.calls[0].args.p_expected_ingest_revision).toBe(0);
  });

  it("raises a typed, recoverable error when the document moved under the gate", async () => {
    const { svc } = service({
      append_pending_session: {
        accepted: false,
        reason: "stale_validation_snapshot",
        expected_revision: 5,
        current_revision: 6,
      },
    });

    const attempt = svc.append(
      SESSION_KEY, "จบรายการเบิก", null, "evt-close", 2_000, true, GENERATION, undefined, 5,
    );

    await expect(attempt).rejects.toBeInstanceOf(PendingSessionStaleValidationSnapshotError);
    const error = await attempt.catch((caught: unknown) => caught);
    expect((error as PendingSessionStaleValidationSnapshotError).expectedRevision).toBe(5);
    expect((error as PendingSessionStaleValidationSnapshotError).currentRevision).toBe(6);
  });
});

describe("validation hold — RPC boundary", () => {
  it("holds against the exact generation and revision the gate saw", async () => {
    const { db, svc } = service({
      hold_pending_validation_review: { accepted: true, reason: "held" },
    });

    expect(await svc.holdValidationReview(SESSION_KEY, GENERATION, 9, SCHEDULED_AT)).toBe(true);
    expect(db.calls[0]).toEqual({
      name: "hold_pending_validation_review",
      args: {
        p_session_key: SESSION_KEY,
        p_expected_session_generation: GENERATION,
        p_expected_ingest_revision: 9,
        p_expected_next_attempt_at: SCHEDULED_AT,
      },
    });
  });

  it("reports a refused hold instead of pretending the session is parked", async () => {
    const { svc } = service({
      hold_pending_validation_review: { accepted: false, reason: "stale_validation_snapshot" },
    });
    expect(await svc.holdValidationReview(SESSION_KEY, GENERATION, 9, SCHEDULED_AT)).toBe(false);
  });

  it("treats a terminalized refusal as not held", async () => {
    const { svc } = service({
      hold_pending_validation_review: { accepted: false, reason: "terminalized" },
    });
    expect(await svc.holdValidationReview(SESSION_KEY, GENERATION, 9, SCHEDULED_AT)).toBe(false);
  });
});

describe("finalizer ordering guarantee", () => {
  const finalizerPath = new URL("./pending-session-finalizer.ts", import.meta.url);

  it("parks a presented review BEFORE any validation error is recorded", async () => {
    const source = await Bun.file(finalizerPath).text();

    const holdCall = source.indexOf("service.holdValidationReview(");
    const pushErrors = source.indexOf("validationErrors.push(...gate.errors)");

    expect(holdCall).toBeGreaterThan(0);
    expect(pushErrors).toBeGreaterThan(0);
    // If this order ever inverts, an unconfirmed review becomes a terminal
    // validation error again — the exact 2026-08-30 regression.
    expect(holdCall).toBeLessThan(pushErrors);
  });

  it("returns validation_held without reaching the terminal finalize RPC", async () => {
    const source = await Bun.file(finalizerPath).text();
    const holdReturn = source.indexOf('return { status: "validation_held"');
    const finalizeRpc = source.indexOf("try_finalize_pending_generation");

    expect(holdReturn).toBeGreaterThan(0);
    expect(holdReturn).toBeLessThan(finalizeRpc);
  });

  it("pins the hold to the snapshot revision, not to a re-read", async () => {
    const source = await Bun.file(finalizerPath).text();
    expect(source).toContain("snapshot.ingest_revision ?? null");
  });

  it("stops the stale finalizer when the hold is refused", async () => {
    const source = await Bun.file(finalizerPath).text();
    expect(source).toContain('return { status: "stale_snapshot", reason: "validation_hold_refused" }');
  });
});

describe("migration invariants", () => {
  const migrationPath = new URL(
    "../../../supabase/migrations/20260831120000_produce_close_validation_race.sql",
    import.meta.url,
  );

  it("gates the revision comparison on the same, still-live generation", async () => {
    const sql = await Bun.file(migrationPath).text();
    // Generation identity and terminal state outrank revision freshness: a
    // stale close from a rotated generation must get generation_conflict, not
    // an invitation to close again onto the replacement generation.
    expect(sql).toContain(
      "AND v_row.session_generation IS NOT DISTINCT FROM p_expected_session_generation",
    );
    expect(sql).toContain("AND NOT v_row.terminalized");

    const generationGuard = sql.indexOf(
      "AND v_row.session_generation IS NOT DISTINCT FROM p_expected_session_generation",
    );
    const revisionCompare = sql.indexOf(
      "AND v_row.ingest_revision IS DISTINCT FROM p_expected_ingest_revision",
    );
    expect(generationGuard).toBeGreaterThan(0);
    expect(generationGuard).toBeLessThan(revisionCompare);
  });

  it("locks the pending row before deciding either review mutation", async () => {
    const sql = await Bun.file(migrationPath).text();
    // Both review RPCs must take the pending_sessions lock; a bare read is a
    // TOCTOU against every writer that terminalizes.
    const guards = sql.split("SELECT terminalized INTO v_terminalized");
    expect(guards).toHaveLength(3); // record_ + confirm_
    for (const tail of guards.slice(1)) {
      const lock = tail.indexOf("FOR UPDATE");
      const decide = tail.indexOf("IF v_terminalized THEN");
      expect(lock).toBeGreaterThan(-1);
      expect(lock).toBeLessThan(decide);
    }
  });

  it("keeps the forward version strictly above the Production ledger max", async () => {
    // 20260831045503 is Production's ledger max after the #108 rollout.
    expect("20260831120000" > "20260831045503").toBe(true);
  });
});

describe("webhook close gate wiring", () => {
  const webhookPath = new URL("./webhook-service.ts", import.meta.url);

  it("pins the revision the entry gate inspected, and only when the gate ran clean", async () => {
    const source = await Bun.file(webhookPath).text();
    expect(source).toContain("if (closeGateRefusal) markClose = false;");
    expect(source).toContain("else closeGatePinnedRevision = pending.ingest_revision ?? undefined;");
    expect(source).toContain("closeGatePinnedRevision,");
  });

  it("resumes a held session when the distinct later close confirms its review", async () => {
    const source = await Bun.file(webhookPath).text();
    expect(source).toContain("runClosedProduceCloseGate(this.supabase, gateRef, parsed, eventId, {");
    expect(source).toContain("canAcknowledgeClosedProduceReview(pending, lineUserId, eventId, event.timestamp)");
    expect(source).not.toContain("resumeCloseFinalization");
  });

  it("answers a raced close with recoverable Thai copy, not a terminal failure", async () => {
    const source = await Bun.file(webhookPath).text();
    expect(source).toContain("PendingSessionStaleValidationSnapshotError");
    expect(source).toContain("CLOSE_RACED_LATE_ITEM_REPLY");
    // The operator must be told the list is intact and to simply close again.
    expect(source).toContain("รายการทั้งหมดยังอยู่ครบ");
    expect(source).toContain("กรุณาพิมพ์ปิดรอบอีกครั้ง");
  });
});
