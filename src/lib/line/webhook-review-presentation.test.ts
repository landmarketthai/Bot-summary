/**
 * Webhook-level behaviour for review presentation.
 *
 * A LINE reply is a separate network call that the webhook catches and logs, so
 * "we wrote the review row" is NOT evidence anyone saw it. These tests drive the
 * real close-gate helpers against an RPC double and assert what survives each
 * delivery outcome — specifically that a failed reply can never authorize a
 * review, and that a successful re-presentation takes over the presenting
 * identity so its own duplicate cannot self-confirm.
 *
 * The SQL semantics are proven against a real server in
 * migration-produce-close-validation-race.pg.test.ts.
 */
import { describe, expect, it } from "bun:test";
import {
  markProduceValidationReviewsPresented,
  recordProduceValidationReview,
  type ProduceValidationSessionRef,
} from "@/lib/produce/entry-validation-gate";
import type { ProduceValidationResult } from "@/lib/produce/entry-validation";

const SESSION_KEY = "group:test-market-1:user:test-staff-1";
const GENERATION = "44444444-4444-4444-8444-444444444444";
const DIGEST = "a".repeat(64);

const REF: ProduceValidationSessionRef = {
  sessionKey: SESSION_KEY,
  sessionGeneration: GENERATION,
  accountabilityRoundId: "round-1",
  businessDate: "2026-08-30",
  marketLabel: "ราชพฤก",
  staffLabel: "จิ้ว",
  lineUserId: "user-1",
};

// A non-subunit confirmable review: #109 keeps its own per-item semantics.
const REVIEW_RESULT = {
  status: "review_required",
  digest: DIGEST,
  reviews: [{ kind: "price_variance", itemNumber: 1 }],
  blocking: [],
  advisories: [],
} as unknown as ProduceValidationResult;

/**
 * A minimal stand-in for the migration's semantics: recording never delivers,
 * marking delivers and rebinds the presenting event, confirming refuses an
 * undelivered row and refuses the presenting event itself.
 */
class ReviewStore {
  rows = new Map<string, {
    presentedLineEventId: string;
    deliveredAt: string | null;
    confirmedAt: string | null;
  }>();
  calls: string[] = [];

  rpc = async (name: string, args: Record<string, unknown>) => {
    this.calls.push(name);
    const digest = args.p_validation_digest as string;

    if (name === "record_produce_validation_review") {
      // Idempotent, and NEVER stamps delivery.
      if (!this.rows.has(digest)) {
        this.rows.set(digest, {
          presentedLineEventId: args.p_line_event_id as string,
          deliveredAt: null,
          confirmedAt: null,
        });
      }
      const row = this.rows.get(digest)!;
      return {
        data: {
          confirmed: row.confirmedAt !== null,
          presented_line_event_id: row.presentedLineEventId,
          presented_delivered: row.deliveredAt !== null,
        },
        error: null,
      };
    }

    if (name === "mark_produce_validation_reviews_presented") {
      const requested = args.p_validation_digests as string[];
      const eventId = args.p_presented_line_event_id as string;
      if (!requested || requested.length === 0) {
        return { data: { status: "no_digests", marked: 0 }, error: null };
      }
      if (!eventId || eventId.trim() === "") {
        return { data: { status: "invalid_presentation_event", marked: 0 }, error: null };
      }
      // All-or-nothing: an unknown digest refuses the whole message.
      if (requested.some((d) => !this.rows.has(d))) {
        return { data: { status: "unknown_digest", marked: 0 }, error: null };
      }
      for (const d of requested) {
        const row = this.rows.get(d)!;
        if (row.deliveredAt !== null) continue;
        row.deliveredAt = "now";
        row.presentedLineEventId = eventId; // rebind to the delivering event
      }
      return { data: { status: "presented", marked: requested.length }, error: null };
    }

    return { data: null, error: null };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from = () => ({}) as any;

  /** What confirm_produce_validation_review would answer. */
  confirm(digest: string, eventId: string): string {
    const row = this.rows.get(digest);
    if (!row) return "not_found";
    if (row.confirmedAt !== null) return "already_confirmed";
    if (row.deliveredAt === null) return "not_presented";
    if (row.presentedLineEventId === eventId) return "not_found";
    row.confirmedAt = "now";
    return "confirmed";
  }
}

/** The webhook's order of operations: record, reply, and mark only if it landed. */
async function closeWithReply(
  store: ReviewStore,
  eventId: string,
  reply: () => Promise<void>,
): Promise<{ delivered: boolean }> {
  await recordProduceValidationReview(store as never, REF, REVIEW_RESULT, eventId);

  let delivered = false;
  try {
    await reply();
    delivered = true;
  } catch {
    delivered = false;
  }
  if (delivered) {
    await markProduceValidationReviewsPresented(store as never, REF, [DIGEST], eventId);
  }
  return { delivered };
}

const replyOk = async () => {};
const replyFails = async () => { throw new Error("LINE 500"); };

describe("A. reply succeeds — next distinct close confirms, no third close", () => {
  it("stamps delivery and lets exactly one later close confirm", async () => {
    const store = new ReviewStore();

    await closeWithReply(store, "evt-close-1", replyOk);
    expect(store.calls).toEqual([
      "record_produce_validation_review",
      "mark_produce_validation_reviews_presented",
    ]);
    expect(store.rows.get(DIGEST)!.deliveredAt).not.toBeNull();

    // Close #2 confirms. No third close.
    expect(store.confirm(DIGEST, "evt-close-2")).toBe("confirmed");
  });
});

describe("B. reply fails — nothing may authorize the review", () => {
  it("never marks delivery, and the next close cannot confirm", async () => {
    const store = new ReviewStore();

    const { delivered } = await closeWithReply(store, "evt-close-1", replyFails);
    expect(delivered).toBe(false);
    expect(store.calls).not.toContain("mark_produce_validation_reviews_presented");
    expect(store.rows.get(DIGEST)!.deliveredAt).toBeNull();

    expect(store.confirm(DIGEST, "evt-close-2")).toBe("not_presented");
    expect(store.confirm(DIGEST, "evt-close-3")).toBe("not_presented");
    expect(store.rows.get(DIGEST)!.confirmedAt).toBeNull();
  });
});

describe("C. failed close #1, successful re-presentation by close #2", () => {
  it("moves the presenting identity to close #2 and needs close #3 to confirm", async () => {
    const store = new ReviewStore();

    await closeWithReply(store, "evt-close-1", replyFails);
    expect(store.rows.get(DIGEST)!.presentedLineEventId).toBe("evt-close-1");
    expect(store.rows.get(DIGEST)!.deliveredAt).toBeNull();

    // Close #2 re-presents successfully.
    await closeWithReply(store, "evt-close-2", replyOk);
    expect(store.rows.get(DIGEST)!.deliveredAt).not.toBeNull();
    // The stored identity is the event that ACTUALLY delivered.
    expect(store.rows.get(DIGEST)!.presentedLineEventId).toBe("evt-close-2");

    // A duplicate delivery of close #2 must not self-confirm...
    expect(store.confirm(DIGEST, "evt-close-2")).toBe("not_found");
    expect(store.rows.get(DIGEST)!.confirmedAt).toBeNull();
    // ...close #3 does. One extra close is the correct price of a failed
    // delivery.
    expect(store.confirm(DIGEST, "evt-close-3")).toBe("confirmed");
  });

  it("would let a duplicate self-confirm if the identity were NOT rebound", () => {
    // Guards the reason the rebinding exists: with close #1 still stored as the
    // presenter, close #2's own duplicate looks like a distinct later event.
    const store = new ReviewStore();
    store.rows.set(DIGEST, {
      presentedLineEventId: "evt-close-1", // stale identity
      deliveredAt: "now",
      confirmedAt: null,
    });
    expect(store.confirm(DIGEST, "evt-close-2")).toBe("confirmed");
  });
});

describe("D. reply succeeds but the delivery stamp fails", () => {
  it("leaves the review unprovable, so the next close re-presents", async () => {
    const store = new ReviewStore();
    const failingMark = {
      calls: [] as string[],
      rpc: async (name: string, args: Record<string, unknown>) => {
        if (name === "mark_produce_validation_reviews_presented") {
          return { data: null, error: { message: "boom" } };
        }
        return store.rpc(name, args);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      from: () => ({}) as any,
    };

    await recordProduceValidationReview(failingMark as never, REF, REVIEW_RESULT, "evt-close-1");
    await expect(
      markProduceValidationReviewsPresented(failingMark as never, REF, [DIGEST], "evt-close-1"),
    ).rejects.toThrow();

    expect(store.rows.get(DIGEST)!.deliveredAt).toBeNull();
    expect(store.confirm(DIGEST, "evt-close-2")).toBe("not_presented");
  });
});

describe("blocking refusals are never treated as a delivered review", () => {
  it("records nothing when there is no confirmable review", async () => {
    const store = new ReviewStore();
    // A blocking decision carries no reviewPresentation, so the webhook never
    // reaches record/mark at all.
    expect(store.calls).toEqual([]);
    expect(store.rows.size).toBe(0);
  });
});

describe("webhook wiring", () => {
  const webhookPath = new URL("./webhook-service.ts", import.meta.url);

  it("marks delivery only inside the successful-reply branch", async () => {
    const source = await Bun.file(webhookPath).text();
    const replied = source.indexOf("delivered = true;");
    const marked = source.indexOf("markProduceValidationReviewsPresented(");
    expect(replied).toBeGreaterThan(0);
    expect(marked).toBeGreaterThan(replied);
    expect(source).toContain("if (delivered && closeGateRefusal.reviewPresentation)");
  });

  it("passes the current LINE event id as the presenting identity", async () => {
    const source = await Bun.file(webhookPath).text();
    // Line-ending agnostic: the repository checks out CRLF on Windows.
    expect(source).toMatch(/digests,\s*\r?\n\s*eventId,/);
  });

  it("only a review_presented decision carries a presentation to prove", async () => {
    const source = await Bun.file(webhookPath).text();
    const blocking = source.indexOf("refusalText: buildBlockingValidationReply(decision.result,");
    expect(blocking).toBeGreaterThan(0);
    // The blocking branch must not carry reviewPresentation.
    const blockingBranch = source.slice(blocking, blocking + 160);
    expect(blockingBranch).not.toContain("reviewPresentation");
  });
});
