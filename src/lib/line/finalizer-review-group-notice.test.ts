import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import {
  buildFinalizerReviewGroupNotice,
  notifyFinalizerReviewGroup,
} from "./finalizer-review-group-notice";

const GROUP_ID = "C-market";
const OPERATOR_ID = "U-operator";
const NOW = Date.parse("2026-11-21T05:30:00Z");
const SNAPSHOT = {
  source_id: GROUP_ID,
  session_key: `group:${GROUP_ID}:user:${OPERATOR_ID}`,
  line_user_id: OPERATOR_ID,
  session_generation: "44444444-4444-4444-8444-444444444444",
  close_requested_at: "2026-11-21T05:15:00Z",
};
const PRESENTED = { status: "validation_held", reason: "entry_review_presented" } as const;
const PARTIAL = { ...PRESENTED, reason: "entry_review_partially_presented" };

describe("buildFinalizerReviewGroupNotice", () => {
  it("sends only a fixed status to the opted-in originating group", () => {
    const notice = buildFinalizerReviewGroupNotice(SNAPSHOT, PRESENTED, `C-other,\n${GROUP_ID}`, NOW);

    expect(notice).toEqual({
      to: GROUP_ID,
      text: "⏸️ รายการรอตรวจสอบและยังไม่ได้บันทึก\nระบบส่งข้อความตรวจสอบทางแชตส่วนตัวแล้ว",
      retryKey: expect.stringMatching(/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/),
    });
    expect(buildFinalizerReviewGroupNotice(SNAPSHOT, PRESENTED, "", NOW)).toBeNull();
    expect(buildFinalizerReviewGroupNotice(SNAPSHOT, PRESENTED, `${GROUP_ID}-other`, NOW)).toBeNull();
  });

  it("skips success, duplicates, and reviews without proven private presentation", () => {
    const undelivered = { ...PRESENTED, reason: "entry_review_undelivered" };
    for (const result of [
      null,
      undelivered,
      { status: "validation_held" },
      { status: "finalized", reason: PRESENTED.reason },
      { status: "duplicate" },
    ] as const) {
      expect(buildFinalizerReviewGroupNotice(SNAPSHOT, result, GROUP_ID, NOW)).toBeNull();
    }
  });

  it("rejects a DM, room, mismatched group or operator, and missing operator", () => {
    for (const snapshot of [
      { ...SNAPSHOT, source_id: OPERATOR_ID, session_key: `dm:${OPERATOR_ID}` },
      { ...SNAPSHOT, session_key: `room:${GROUP_ID}:user:${OPERATOR_ID}` },
      { ...SNAPSHOT, session_key: `group:C-other:user:${OPERATOR_ID}` },
      { ...SNAPSHOT, line_user_id: "U-other" },
      { ...SNAPSHOT, line_user_id: null },
    ]) {
      expect(buildFinalizerReviewGroupNotice(snapshot, PRESENTED, `${GROUP_ID},${OPERATOR_ID}`, NOW))
        .toBeNull();
    }
  });

  it("reuses the exact request from partial to full presentation, scoped to group and generation", () => {
    const first = buildFinalizerReviewGroupNotice(SNAPSHOT, PARTIAL, GROUP_ID, NOW);
    expect(first).not.toBeNull();
    expect(buildFinalizerReviewGroupNotice(SNAPSHOT, PRESENTED, GROUP_ID, NOW + 1_000)).toEqual(first);

    const nextGeneration = { ...SNAPSHOT, session_generation: "55555555-5555-4555-8555-555555555555" };
    const otherGroup = { ...SNAPSHOT, source_id: "C-other", session_key: `group:C-other:user:${OPERATOR_ID}` };
    for (const snapshot of [nextGeneration, otherGroup]) {
      const notice = buildFinalizerReviewGroupNotice(snapshot, PRESENTED, `${GROUP_ID},C-other`, NOW);
      expect(notice).not.toBeNull();
      expect(notice?.retryKey).not.toBe(first?.retryKey);
    }
  });

  it("skips attempts before the first close or near retry-key expiration", () => {
    const firstClose = Date.parse(SNAPSHOT.close_requested_at);
    const cutoff = firstClose + 23 * 60 * 60 * 1_000;
    expect(buildFinalizerReviewGroupNotice(SNAPSHOT, PRESENTED, GROUP_ID, cutoff - 1)).not.toBeNull();
    for (const now of [firstClose - 1, cutoff, cutoff + 25 * 60 * 60 * 1_000]) {
      expect(buildFinalizerReviewGroupNotice(SNAPSHOT, PRESENTED, GROUP_ID, now)).toBeNull();
    }
    for (const snapshot of [
      { ...SNAPSHOT, session_generation: "" },
      { ...SNAPSHOT, close_requested_at: null },
      { ...SNAPSHOT, close_requested_at: "invalid" },
    ]) {
      expect(buildFinalizerReviewGroupNotice(snapshot, PRESENTED, GROUP_ID, NOW)).toBeNull();
    }
  });
});

describe("notifyFinalizerReviewGroup", () => {
  const groupIdsEnv = "PRODUCE_FINALIZER_REVIEW_NOTICE_GROUP_IDS";
  let previousGroupIds: string | undefined;
  let recentSnapshot: typeof SNAPSHOT;

  beforeEach(() => {
    previousGroupIds = process.env[groupIdsEnv];
    delete process.env[groupIdsEnv];
    recentSnapshot = { ...SNAPSHOT, close_requested_at: new Date(Date.now() - 60_000).toISOString() };
  });

  afterEach(() => {
    if (previousGroupIds === undefined) delete process.env[groupIdsEnv];
    else process.env[groupIdsEnv] = previousGroupIds;
  });

  it("does not call the transport by default or when the private push is unproven", async () => {
    const push = mock(async () => {});
    await notifyFinalizerReviewGroup(recentSnapshot, PRESENTED, push);
    process.env[groupIdsEnv] = GROUP_ID;
    await notifyFinalizerReviewGroup(recentSnapshot, { ...PRESENTED, reason: "entry_review_undelivered" }, push);
    expect(push).not.toHaveBeenCalled();
  });

  it("swallows LINE failure without retrying the optional push itself", async () => {
    process.env[groupIdsEnv] = GROUP_ID;
    const push = mock(async () => { throw new Error("LINE unavailable"); });

    expect(await notifyFinalizerReviewGroup(recentSnapshot, PRESENTED, push)).toBeUndefined();
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("uses the same LINE retry key and body for concurrent attempts", async () => {
    process.env[groupIdsEnv] = GROUP_ID;
    const accepted = new Set<string>();
    const requests: RequestInit[] = [];
    const line = spyOn(globalThis, "fetch").mockImplementation((async (_request: unknown, init?: RequestInit) => {
      if (!init) throw new Error("missing LINE request options");
      requests.push(init);
      const key = new Headers(init.headers).get("X-Line-Retry-Key");
      if (!key) throw new Error("missing LINE retry key");
      if (accepted.has(key)) return new Response(null, { status: 409 });
      accepted.add(key);
      return new Response(null, { status: 200 });
    }) as typeof fetch);

    try {
      await Promise.all([
        notifyFinalizerReviewGroup(recentSnapshot, PARTIAL),
        notifyFinalizerReviewGroup(recentSnapshot, PRESENTED),
      ]);
      expect(accepted.size).toBe(1);
      expect(requests).toHaveLength(2);
      expect(requests[0].body).toBe(requests[1].body);
      expect(requests[0].signal).toBeInstanceOf(AbortSignal);
      const notice = buildFinalizerReviewGroupNotice(recentSnapshot, PRESENTED, GROUP_ID, Date.now());
      expect(JSON.parse(String(requests[0].body))).toEqual({
        to: GROUP_ID,
        messages: [{ type: "text", text: notice?.text }],
      });
    } finally {
      line.mockRestore();
    }
  });
});
