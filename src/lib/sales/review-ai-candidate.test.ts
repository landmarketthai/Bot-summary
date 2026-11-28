import { describe, expect, test } from "bun:test";
import {
  MAX_REVIEW_AI_CANDIDATES,
  selectReviewAiCandidate,
  type ReviewAiCandidateInput,
} from "./review-ai-candidate";

const A = `c_${"a".repeat(32)}`;
const B = `c_${"b".repeat(32)}`;
const C = `c_${"c".repeat(32)}`;
const fixture = (): ReviewAiCandidateInput => ({
  synthetic: true,
  allowedCandidateIds: [A, B, C],
  candidates: [
    { id: B, features: { similarity: "weak", sameCategory: true } },
    { id: A, features: { similarity: "strong", sameCategory: false } },
  ],
});
const enabled = { enabled: true, environment: "synthetic" };

describe("synthetic review AI candidate adapter", () => {
  test("is off by default even with a provider injected", async () => {
    let calls = 0;
    const provider = () => { calls++; return { candidateId: B }; };
    for (const options of [{ provider }, { ...enabled, enabled: false, provider }]) {
      expect(await selectReviewAiCandidate(fixture(), options)).toEqual({
        candidateId: A, source: "fallback", reason: "disabled", needsHumanReview: true,
      });
    }
    expect(calls).toBe(0);
  });

  test("requires synthetic environment and explicit boolean opt-in", async () => {
    let calls = 0;
    const provider = () => { calls++; return { candidateId: B }; };
    for (const options of [
      { enabled: true, provider },
      { enabled: true, environment: "real", provider },
      { enabled: false, environment: "real", provider },
      { enabled: true, environment: "production", provider },
      { enabled: "true", environment: "synthetic", provider },
    ]) {
      const output = await selectReviewAiCandidate(fixture(), options);
      expect(output.candidateId).toBeNull();
      expect(output.needsHumanReview).toBe(true);
    }
    expect(calls).toBe(0);
  });

  test("deterministic fallback uses generic features then opaque ID, independent of order", async () => {
    const input = fixture();
    expect((await selectReviewAiCandidate(input)).candidateId).toBe(A);
    const tied = { ...input, candidates: input.candidates.map((c) => ({ ...c, features: { similarity: "weak", sameCategory: true } })) };
    expect((await selectReviewAiCandidate(tied)).candidateId).toBe(A);
    expect((await selectReviewAiCandidate({ ...tied, candidates: [...tied.candidates].reverse() })).candidateId).toBe(A);
    expect(await selectReviewAiCandidate(input, enabled)).toEqual({
      candidateId: A, source: "fallback", reason: "no_provider", needsHumanReview: true,
    });
  });

  test("rejects invalid input schemas and sensitive or arbitrary extra fields before calling provider", async () => {
    let calls = 0;
    const provider = () => { calls++; return { candidateId: B }; };
    const input = fixture();
    const invalid: unknown[] = [null, [], {}, { ...input, synthetic: false },
      { ...input, candidates: "invalid" }, { ...input, allowedCandidateIds: ["raw-product-name"] },
      { ...input, candidates: [{ ...input.candidates[0], id: C }] , allowedCandidateIds: [A, B] },
      { ...input, candidates: [{ id: A, features: { similarity: 1, sameCategory: true } }] },
      { ...input, candidates: [{ id: A, features: { similarity: "strong", sameCategory: "true" } }] },
      { ...input, candidates: [{ id: A, features: { similarity: "strong" } }] },
      { ...input, candidates: [undefined] },
    ];
    for (const field of ["name", "date", "market", "amount", "quantity", "message", "personalData"]) {
      invalid.push({ ...input, [field]: "synthetic forbidden field" });
      invalid.push({ ...input, candidates: [{ ...input.candidates[0], [field]: "synthetic forbidden field" }] });
      invalid.push({ ...input, candidates: [{ id: A, features: { ...input.candidates[0].features, [field]: "synthetic forbidden field" } }] });
    }
    for (const value of invalid) {
      expect(await selectReviewAiCandidate(value, { ...enabled, provider })).toEqual({
        candidateId: null, source: "none", reason: "invalid_input", needsHumanReview: true,
      });
    }
    expect(calls).toBe(0);
  });

  test("rejects duplicate IDs, oversized lists, sparse entries, accessors and inherited schemas", async () => {
    const input = fixture();
    const ids = Array.from({ length: MAX_REVIEW_AI_CANDIDATES + 1 }, (_, i) => `c_${i.toString(16).padStart(32, "0")}`);
    let getterCalls = 0;
    const accessor = { ...input };
    Object.defineProperty(accessor, "synthetic", { get() { getterCalls++; return true; } });
    const accessorList = [input.candidates[0]];
    Object.defineProperty(accessorList, "0", { get() { getterCalls++; return input.candidates[0]; } });
    const invalid = [
      { ...input, allowedCandidateIds: [A, A] },
      { ...input, candidates: [input.candidates[0], input.candidates[0]] },
      { ...input, allowedCandidateIds: ids },
      { ...input, candidates: Array(MAX_REVIEW_AI_CANDIDATES + 1).fill(input.candidates[0]) },
      { ...input, candidates: Array(1) },
      { ...input, candidates: Object.assign([...input.candidates], { message: "synthetic forbidden field" }) },
      { ...input, allowedCandidateIds: Object.assign([...input.allowedCandidateIds], { name: "synthetic forbidden field" }) },
      { ...input, candidates: accessorList },
      accessor, Object.create(input), { ...input, [Symbol("extra")]: true },
    ];
    for (const value of invalid) expect((await selectReviewAiCandidate(value)).reason).toBe("invalid_input");
    expect(getterCalls).toBe(0);
    const boundary = { synthetic: true, allowedCandidateIds: ids.slice(0, MAX_REVIEW_AI_CANDIDATES), candidates: ids.slice(0, MAX_REVIEW_AI_CANDIDATES).map((id) => ({ id, features: { similarity: "none", sameCategory: false } })) };
    expect((await selectReviewAiCandidate(boundary)).candidateId).toBe(ids[0]);
  });

  test("strictly validates options and timeout bounds without calling provider", async () => {
    let calls = 0;
    const provider = () => { calls++; return { candidateId: A }; };
    for (const options of [null, [], { ...enabled, provider: true },
      ...[0, -1, 1001, NaN, Infinity, 1.5, "5"].map((timeoutMs) => ({ ...enabled, provider, timeoutMs })),
      { ...enabled, provider, approved: true }]) {
      expect((await selectReviewAiCandidate(fixture(), options)).reason).toBe("invalid_options");
    }
    expect(calls).toBe(0);
  });

  test("provider receives only a frozen validated snapshot and cannot mutate caller input", async () => {
    const input = fixture();
    const before = JSON.stringify(input);
    let calls = 0;
    const output = await selectReviewAiCandidate(input, { ...enabled, provider: (snapshot: ReviewAiCandidateInput) => {
      calls++;
      expect(snapshot).toEqual(input);
      expect(snapshot).not.toBe(input);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.allowedCandidateIds)).toBe(true);
      expect(Object.isFrozen(snapshot.candidates)).toBe(true);
      expect(Object.isFrozen(snapshot.candidates[0])).toBe(true);
      expect(Object.isFrozen(snapshot.candidates[0].features)).toBe(true);
      return { candidateId: B };
    } });
    expect(calls).toBe(1);
    expect(output).toEqual({ candidateId: B, source: "provider", reason: "selected", needsHumanReview: true });
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.isFrozen(output)).toBe(true);
  });

  test("strict result schema rejects unknown IDs, noncandidate allowlisted IDs, duplicates and approval instructions", async () => {
    for (const response of [null, [], {}, { candidateId: "unknown" }, { candidateId: C },
      { candidateId: [A, A] }, { candidateIds: [A, A] }, { candidateId: A, approved: true },
      { candidateId: A, needsHumanReview: false }, { candidateId: A, explanation: "synthetic text" },
      { candidateId: 1 }, Object.create({ candidateId: A })]) {
      expect(await selectReviewAiCandidate(fixture(), { ...enabled, provider: () => response })).toEqual({
        candidateId: A, source: "fallback", reason: "invalid_result", needsHumanReview: true,
      });
    }
    expect((await selectReviewAiCandidate(fixture(), { ...enabled, provider: () => ({ candidateId: null }) })).candidateId).toBeNull();
  });

  test("sync throws, rejections and timeout fall back without leaking provider errors", async () => {
    for (const provider of [
      () => { throw new Error("synthetic error detail"); },
      () => Promise.reject(new Error("synthetic error detail")),
      () => new Promise<never>(() => {}),
      () => new Promise((_, reject) => setTimeout(() => reject(new Error("late rejection")), 15)),
    ]) {
      expect(await selectReviewAiCandidate(fixture(), { ...enabled, provider, timeoutMs: 5 })).toEqual({
        candidateId: A, source: "fallback", reason: "provider_error", needsHumanReview: true,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  test("empty input selects nothing and never calls provider; results never approve", async () => {
    let calls = 0;
    const empty = await selectReviewAiCandidate({ synthetic: true, allowedCandidateIds: [], candidates: [] }, {
      ...enabled, provider: () => { calls++; return { candidateId: A }; },
    });
    expect(calls).toBe(0);
    expect(empty.candidateId).toBeNull();
    for (const output of [empty, await selectReviewAiCandidate(fixture()), await selectReviewAiCandidate(fixture(), {
      ...enabled, provider: () => ({ candidateId: B }),
    })]) {
      expect(Object.keys(output).sort()).toEqual(["candidateId", "needsHumanReview", "reason", "source"]);
      expect(output.needsHumanReview).toBe(true);
      expect(output).not.toHaveProperty("approved");
      expect(output).not.toHaveProperty("action");
    }
  });
});
