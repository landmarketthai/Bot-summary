import { describe, expect, it } from "bun:test";
import { WebhookService } from "./webhook-service";
import type { LineMessageEvent } from "./types";

/**
 * A complete single-message produce entry that the parser understands but
 * refuses to persist must leave durable evidence behind.
 *
 * Before this, the path was silent: parser handles the message → validation
 * fails → the sender gets a reply → the webhook returns. No produce_session, no
 * pending_session, nothing in parse_errors — so a daily report could never know
 * produce had been lost. The existing validation_error type carries the
 * evidence; no schema change was needed.
 */

type Row = Record<string, unknown>;

/** Only what runParser touches: a raw_messages insert and a parse_errors insert. */
class RecordingDatabase {
  readonly inserts: Record<string, Row[]> = {};
  readonly updates: Record<string, Row[]> = {};
  duplicateSessions = false;

  async rpc(name: string, args?: Row) {
    if (name === "receive_line_webhook_event") {
      const rows = (this.inserts.raw_messages ??= []);
      const rawMessageId = `raw_messages-${rows.length + 1}`;
      rows.push({
        id: rawMessageId,
        line_event_id: args?.p_line_event_id,
        source_id: args?.p_source_id,
        raw_text: args?.p_raw_text,
      });
      return { data: { raw_message_id: rawMessageId, duplicate: false }, error: null };
    }
    throw new Error(`unexpected rpc: ${name}`);
  }

  validationErrors(): Row[] {
    return (this.inserts.parse_errors ?? []).filter(
      (row) => row.error_type === "validation_error",
    );
  }

  from(table: string) {
    const inserts = (this.inserts[table] ??= []);
    const node: Record<string, unknown> = {};
    const self = () => node;

    node.insert = (payload: Row) => {
      inserts.push(payload);
      const inserted = { id: `${table}-${inserts.length}`, ...payload };
      return {
        select: () => ({
          single: async () => ({ data: inserted, error: null }),
        }),
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: [inserted], error: null }).then(resolve),
      };
    };
    node.select = self;
    node.eq = self;
    node.is = self;
    node.in = self;
    node.gte = self;
    node.lt = self;
    node.order = self;
    node.limit = self;
    node.update = (payload: Row) => {
      (this.updates[table] ??= []).push(payload);
      return node;
    };
    node.delete = self;
    node.upsert = self;
    // Duplicate simulation: imported_sessions already holds this session hash,
    // and its produce_items rows exist, which is the real duplicate shape.
    node.maybeSingle = async () => ({
      data: this.duplicateSessions && table === "imported_sessions" ? { id: "existing" } : null,
      error: null,
    });
    node.single = async () => ({ data: null, error: null });
    const rows = this.duplicateSessions && table === "produce_items" ? [{ id: "item-existing" }] : [];
    node.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: rows, error: null }).then(resolve);
    return node;
  }
}

let sequence = 0;

function textEvent(text: string): LineMessageEvent {
  sequence += 1;
  return {
    type: "message",
    webhookEventId: `validation-event-${sequence}`,
    deliveryContext: { isRedelivery: false },
    timestamp: Date.parse("2026-07-25T03:00:00.000Z"),
    source: { type: "group", groupId: "group-1", userId: "user-1" },
    mode: "active",
    replyToken: `reply-${sequence}`,
    message: { id: `validation-message-${sequence}`, type: "text", text },
  } as LineMessageEvent;
}

function service(db: RecordingDatabase, replies: string[]) {
  return new WebhookService(db as never, {
    replyMessage: async (_token: string, text: string) => {
      replies.push(text);
    },
  });
}

/** Understood as a weighing session, but item #1 never got a quantity line. */
const INVALID_ITEMS = [
  "18:53 เสือ รายการชั่งเบิกไปตลาด",
  "25/07/2569",
  "18:53 เสือ 1.หมอนทอง119บาท",
  "18:53 เสือ จบรายการ",
].join("\n");

const VALID_SESSION = [
  "18:53 เสือ รายการชั่งเบิกไปตลาด",
  "25/07/2569",
  "18:53 เสือ 1.หมอนทอง119บาท",
  "38โล",
  "18:53 เสือ จบรายการ",
].join("\n");

/** A header and a closer with nothing between them: zero valid items. */
const NO_ITEMS = ["18:53 เสือ รายการชั่งเบิกไปตลาด", "25/07/2569", "18:53 เสือ จบรายการ"].join("\n");

describe("produce validation failure leaves durable evidence", () => {
  it("records a weigh-session validation_error and still replies to the sender", async () => {
    const db = new RecordingDatabase();
    const replies: string[] = [];

    await service(db, replies).processEvents([textEvent(INVALID_ITEMS)], "destination");

    const errors = db.validationErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0].parser_name).toBe("weigh-session");
    expect(errors[0].error_type).toBe("validation_error");
    expect(errors[0].raw_message_id).toBe("raw_messages-1");
    expect(String(errors[0].error_message)).toContain("หมอนทอง");

    // The existing LINE behavior is unchanged: the sender is still told why.
    expect(replies).toHaveLength(1);
    // …and nothing was persisted as produce.
    expect(db.inserts.produce_sessions ?? []).toHaveLength(0);
  });

  it("writes no parse_errors row for a session that validates", async () => {
    const db = new RecordingDatabase();
    const replies: string[] = [];

    const valid = { ...textEvent(VALID_SESSION), replyToken: undefined } as unknown as LineMessageEvent;
    await service(db, replies).processEvents([valid], "destination");

    expect(db.validationErrors()).toHaveLength(0);
  });

  it("records evidence for a message that parses to no items at all", async () => {
    const db = new RecordingDatabase();
    const replies: string[] = [];

    // No replyToken: that branch replies through the LINE client directly, and
    // a unit test must not reach the network.
    const event = { ...textEvent(NO_ITEMS), replyToken: undefined } as unknown as LineMessageEvent;
    await service(db, replies).processEvents([event], "destination");

    expect(db.validationErrors()).toHaveLength(1);
  });
});

describe("raw message processing state stays unambiguous", () => {
  it("marks a duplicate produce message processed, so it is not read as lost", async () => {
    const db = new RecordingDatabase();
    const replies: string[] = [];
    db.duplicateSessions = true;

    const event = { ...textEvent(VALID_SESSION), replyToken: undefined } as unknown as LineMessageEvent;
    await service(db, replies).processEvents([event], "destination");

    // The produce is already recorded under the message that first carried it.
    expect(db.updates.raw_messages).toContainEqual({ is_processed: true });
  });

  it("leaves a rejected produce message unprocessed — that absence IS the evidence", async () => {
    const db = new RecordingDatabase();
    const replies: string[] = [];

    await service(db, replies).processEvents([textEvent(INVALID_ITEMS)], "destination");

    expect(db.updates.raw_messages ?? []).toHaveLength(0);
  });
});
