import { describe, expect, test } from "bun:test";
import { resolveReferenceOwnership, type AiCandidate, type ManualCandidate } from "@/lib/slips/reference-ownership";

const T = (m: number) => `2026-10-29T12:${String(m).padStart(2, "0")}:00Z`;
const ai = (o: Partial<AiCandidate> = {}): AiCandidate => ({ id: "ai", amount: 50, createdAt: T(10), ...o });
const man = (id: string, o: Partial<ManualCandidate> = {}): ManualCandidate =>
  ({ id, amount: 50, createdAt: T(20), requiresReview: false, closed: true, ...o });
const states = (r: ReturnType<typeof resolveReferenceOwnership>) => Object.fromEntries(r.manual);

describe("one money row per full reference", () => {
  test("AI first + manual later, same amount: AI owns, manual superseded (50, not 100)", () => {
    const r = resolveReferenceOwnership(ai(), [man("m")]);
    expect(r).toMatchObject({ aiOwns: true, aiSupersededByManual: false });
    expect(states(r)).toEqual({ m: "superseded" });
  });

  test("manual first (counted) + AI later: manual owns, the AI read is superseded", () => {
    const r = resolveReferenceOwnership(ai({ createdAt: T(30) }), [man("m")]);
    expect(r).toMatchObject({ aiOwns: false, aiSupersededByManual: true });
    expect(states(r)).toEqual({ m: "counted" });
  });

  test("same instant: AI wins the tie", () => {
    expect(resolveReferenceOwnership(ai({ createdAt: T(20) }), [man("m")]).aiOwns).toBe(true);
  });

  test("AI approved at a corrected amount: manual with that amount superseded; other amount pending", () => {
    const approved = ai({ amount: 5, decision: { decision: "approved", amount: 50 } });
    expect(states(resolveReferenceOwnership(approved, [man("m")]))).toEqual({ m: "superseded" });
    expect(states(resolveReferenceOwnership(approved, [man("m", { amount: 60 })]))).toEqual({ m: "pending" });
  });

  test("conflicting amounts are never silently reconciled", () => {
    expect(states(resolveReferenceOwnership(ai({ amount: 70 }), [man("m", { amount: 700 })]))).toEqual({ m: "pending" });
  });

  test("AI rejected + manual not approved: pending; approved: counted", () => {
    const rejected = ai({ decision: { decision: "rejected" } });
    expect(states(resolveReferenceOwnership(rejected, [man("m")]))).toEqual({ m: "pending" });
    const r = resolveReferenceOwnership(rejected, [man("m", { decision: { decision: "approved", amount: 50 } })]);
    expect(r.aiOwns).toBe(false);
    expect(states(r)).toEqual({ m: "counted" });
  });

  test("wallet read (no transfer amount) is never bank money: manual decides by its own rules", () => {
    expect(states(resolveReferenceOwnership(ai({ amount: null }), [man("m")]))).toEqual({ m: "counted" });
    expect(states(resolveReferenceOwnership(ai({ amount: null }), [man("m", { requiresReview: true })]))).toEqual({ m: "pending" });
  });

  test("two manual entries of one reference: the earliest counts, the other is superseded", () => {
    const r = resolveReferenceOwnership(null, [man("late", { createdAt: T(40) }), man("early", { createdAt: T(5) })]);
    expect(states(r)).toEqual({ early: "counted", late: "superseded" });
  });

  test("needs review and no AI: pending until approved; rejected entries are out; open sessions are not money", () => {
    expect(states(resolveReferenceOwnership(null, [man("m", { requiresReview: true })]))).toEqual({ m: "pending" });
    expect(states(resolveReferenceOwnership(null, [man("m", { decision: { decision: "rejected" } })]))).toEqual({ m: "rejected" });
    expect(states(resolveReferenceOwnership(ai(), [man("m", { closed: false })]))).toEqual({ m: "open" });
  });

  test("a pending manual entry earlier than the AI read does not block the AI read", () => {
    const r = resolveReferenceOwnership(ai({ createdAt: T(30) }), [man("m", { requiresReview: true })]);
    expect(r.aiOwns).toBe(true);
    expect(states(r)).toEqual({ m: "superseded" });
  });
});

describe("containment: money already handed out in a finalized round never moves", () => {
  test("scenario 1 — an earlier manual entry becomes valid (session closed) after the AI read's round was finalized", () => {
    const r = resolveReferenceOwnership(ai({ createdAt: T(30), finalized: true }), [man("e1", { createdAt: T(10) })]);
    expect(r.aiOwns).toBe(true);
    expect(states(r)).toEqual({ e1: "superseded" });
  });

  test("scenario 2 — approving an earlier pending entry cannot take the reference from a finalized owner", () => {
    const approvedEarlier = man("e1", { createdAt: T(5), requiresReview: true, decision: { decision: "approved", amount: 50 } });
    const finalizedOwner = man("e2", { createdAt: T(20), finalized: true });
    expect(states(resolveReferenceOwnership(null, [approvedEarlier, finalizedOwner]))).toEqual({ e2: "counted", e1: "superseded" });
  });

  test("scenario 3 — rejecting the open-round owner never makes an open-round claim count; only a finalized claim can own", () => {
    const rejectedOwner = man("e1", { createdAt: T(5), decision: { decision: "rejected" } });
    const openLater = man("e3", { createdAt: T(30) });
    const r = resolveReferenceOwnership(ai({ createdAt: T(40), finalized: true }), [rejectedOwner, openLater]);
    expect(r.aiOwns).toBe(true);
    expect(states(r)).toEqual({ e1: "rejected", e3: "superseded" });
  });

  test("an open AI read loses to a finalized manual claim even if it is earlier", () => {
    const r = resolveReferenceOwnership(ai({ createdAt: T(1) }), [man("m", { createdAt: T(20), finalized: true })]);
    expect(r).toMatchObject({ aiOwns: false, aiSupersededByManual: true });
    expect(states(r)).toEqual({ m: "counted" });
  });
});

describe("one reference normalizer", () => {
  test("every whitespace kind is removed; empty is null", async () => {
    const { normalizeSlipReference } = await import("@/lib/slips/reference-ownership");
    expect(normalizeSlipReference(" 0123 4567 ")).toBe("01234567");
    expect(normalizeSlipReference("01​23\t45\n67")).toBe("01234567");
    expect(normalizeSlipReference("   ")).toBeNull();
    expect(normalizeSlipReference(null)).toBeNull();
  });
});
