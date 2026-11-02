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
