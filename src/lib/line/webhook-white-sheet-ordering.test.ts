import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { WebhookService } from "./webhook-service";
import type { LineEvent, LineMessageEvent } from "./types";
import { PRODUCTION_SECOND_UAT_FIELD_PAYLOAD } from "@/lib/line/fixtures/production-uat-field-payload-a0d07d14";

type QueueStatus = "pending" | "processing" | "processed" | "failed";

function event(id = "evt-ordered"): LineMessageEvent {
  return {
    type: "message",
    webhookEventId: id,
    timestamp: Date.now(),
    replyToken: `reply-${id}`,
    source: { type: "user", userId: "source-1" },
    message: { type: "text", id: `message-${id}`, text: "ตลาด ส่งใบขาวมือ 99/99/2569" },
  } as unknown as LineMessageEvent;
}

function makeQueueDb(seed?: { event: LineMessageEvent; status: QueueStatus; stale?: boolean }) {
  const raws = new Map<string, { id: string; payload: LineEvent }>();
  let queue: {
    lineEventId: string;
    rawMessageId: string;
    sourceId: string;
    status: QueueStatus;
    stale: boolean;
    claimToken: string | null;
    attempts: number;
  } | null = null;
  let sequence = 0;
  let conflictNextCompletion = false;
  let receiveCalls = 0;
  let lastCompletedToken: string | null = null;
  let failNextRawLookup = false;

  function insertOrdered(item: LineMessageEvent, status: QueueStatus, stale = false) {
    const rawMessageId = `raw-${++sequence}`;
    raws.set(item.webhookEventId, { id: rawMessageId, payload: item });
    queue = {
      lineEventId: item.webhookEventId,
      rawMessageId,
      sourceId: "source-1",
      status,
      stale,
      claimToken: status === "processing" ? `token-${++sequence}` : null,
      attempts: status === "processing" ? 1 : 0,
    };
  }

  if (seed) insertOrdered(seed.event, seed.status, seed.stale);

  async function rpc(name: string, args: Record<string, unknown>) {
    if (name === "receive_line_webhook_event") {
      receiveCalls += 1;
      const lineEventId = args.p_line_event_id as string;
      const existing = raws.get(lineEventId);
      if (existing) {
        return { data: { raw_message_id: existing.id, duplicate: true }, error: null };
      }
      const rawMessageId = `raw-${++sequence}`;
      raws.set(lineEventId, { id: rawMessageId, payload: args.p_payload as LineEvent });
      queue = {
        lineEventId,
        rawMessageId,
        sourceId: args.p_source_id as string,
        status: "pending",
        stale: false,
        claimToken: null,
        attempts: 0,
      };
      return { data: { raw_message_id: rawMessageId, duplicate: false }, error: null };
    }

    if (name === "claim_line_webhook_event") {
      if (!queue || queue.sourceId !== args.p_source_id) return { data: null, error: null };
      if (queue.status !== "pending" && !(queue.status === "processing" && queue.stale)) {
        return { data: null, error: null };
      }
      queue.status = "processing";
      queue.stale = false;
      queue.claimToken = `token-${++sequence}`;
      queue.attempts += 1;
      return {
        data: {
          queue_id: "queue-1",
          line_event_id: queue.lineEventId,
          source_id: queue.sourceId,
          raw_message_id: queue.rawMessageId,
          receive_order: 1,
          claim_token: queue.claimToken,
        },
        error: null,
      };
    }

    if (name === "complete_line_webhook_event") {
      if (conflictNextCompletion && queue) {
        conflictNextCompletion = false;
        queue.claimToken = `token-${++sequence}`;
        return { data: false, error: null };
      }
      const matches = queue?.status === "processing"
        && queue.rawMessageId === args.p_raw_message_id
        && queue.claimToken === args.p_claim_token;
      if (!matches || !queue) return { data: false, error: null };
      lastCompletedToken = queue.claimToken;
      queue.status = args.p_status as QueueStatus;
      queue.claimToken = null;
      return { data: true, error: null };
    }

    throw new Error(`unexpected rpc: ${name}`);
  }

  const db = {
    rpc,
    from(table: string) {
      if (table !== "raw_messages") throw new Error(`unexpected table: ${table}`);
      return {
        select() {
          return {
            eq(_column: string, rawMessageId: unknown) {
              return {
                async maybeSingle() {
                  if (failNextRawLookup) {
                    failNextRawLookup = false;
                    return { data: null, error: { message: "Gateway Timeout" } };
                  }
                  const raw = [...raws.values()].find((row) => row.id === rawMessageId);
                  return { data: raw ? { payload: raw.payload } : null, error: null };
                },
              };
            },
          };
        },
        insert(payload: Record<string, unknown>) {
          return {
            select() {
              return {
                async single() {
                  const lineEventId = payload.line_event_id as string;
                  if (raws.has(lineEventId)) {
                    return { data: null, error: { code: "23505", message: "duplicate" } };
                  }
                  const id = `raw-${++sequence}`;
                  raws.set(lineEventId, { id, payload: payload.payload as LineEvent });
                  return { data: { id }, error: null };
                },
              };
            },
          };
        },
      };
    },
    get queue() { return queue; },
    get rawCount() { return raws.size; },
    get queueCount() { return queue ? 1 : 0; },
    get receiveCalls() { return receiveCalls; },
    get lastCompletedToken() { return lastCompletedToken; },
    makeStale() { if (queue) queue.stale = true; },
    conflictOnNextCompletion() { conflictNextCompletion = true; },
    failRawLookupOnce() { failNextRawLookup = true; },
    repeatCompletion() {
      return rpc("complete_line_webhook_event", {
        p_raw_message_id: queue?.rawMessageId,
        p_claim_token: lastCompletedToken,
        p_status: "processed",
      });
    },
  };
  return db;
}

function service(db: ReturnType<typeof makeQueueDb>, replies: string[]) {
  return new WebhookService(db as unknown as SupabaseClient<Database>, {
    replyMessage: async (_token, text) => { replies.push(text); },
    scheduleBackgroundTask: () => {},
  });
}

describe("ordered White Sheet duplicate recovery", () => {
  it("drains a pending duplicate without creating duplicate rows", async () => {
    const item = event();
    const db = makeQueueDb({ event: item, status: "pending" });
    const replies: string[] = [];

    await service(db, replies).processEvents([item], "destination");

    expect(db.queue?.status).toBe("processed");
    expect(replies).toHaveLength(1);
    expect(db.rawCount).toBe(1);
    expect(db.queueCount).toBe(1);
  });

  it("reclaims and drains a stale-processing duplicate", async () => {
    const item = event();
    const db = makeQueueDb({ event: item, status: "processing", stale: true });
    const oldToken = db.queue?.claimToken;
    const replies: string[] = [];

    await service(db, replies).processEvents([item], "destination");

    expect(db.queue?.status).toBe("processed");
    expect(db.lastCompletedToken).not.toBe(oldToken);
    expect(db.queue?.attempts).toBe(2);
    expect(replies).toHaveLength(1);
  });

  it("does not steal a fresh-processing duplicate", async () => {
    const item = event();
    const db = makeQueueDb({ event: item, status: "processing" });
    const token = db.queue?.claimToken;
    const replies: string[] = [];

    await service(db, replies).processEvents([item], "destination");

    expect(db.queue?.claimToken).toBe(token);
    expect(db.queue?.attempts).toBe(1);
    expect(replies).toHaveLength(0);
  });

  it("does not reply again for a processed duplicate", async () => {
    const item = event();
    const db = makeQueueDb({ event: item, status: "processed" });
    const replies: string[] = [];

    await service(db, replies).processEvents([item], "destination");

    expect(db.queue?.status).toBe("processed");
    expect(replies).toHaveLength(0);
  });

  it("leaves unrelated duplicate traffic on the direct path", async () => {
    const item = {
      type: "follow",
      webhookEventId: "evt-follow",
      timestamp: Date.now(),
      source: { type: "user", userId: "source-1" },
    } as unknown as LineEvent;
    const db = makeQueueDb();
    const svc = service(db, []);

    expect((await svc.processEvents([item], "destination"))[0].status).toBe("saved");
    expect((await svc.processEvents([item], "destination"))[0].status).toBe("duplicate");
    expect(db.receiveCalls).toBe(0);
    expect(db.rawCount).toBe(1);
    expect(db.queueCount).toBe(0);
  });
});

describe("ordered White Sheet retryable delivery", () => {
  it("releases a transient raw lookup failure back to pending", async () => {
    const item = event("evt-transient-lookup");
    const db = makeQueueDb();
    db.failRawLookupOnce();
    const replies: string[] = [];
    const svc = service(db, replies);

    const [failed] = await svc.processEvents([item], "destination");
    expect(failed).toMatchObject({ status: "error", retryable: true });
    expect(db.queue?.status).toBe("pending");
    expect(replies).toHaveLength(0);

    const [recovered] = await svc.processEvents([item], "destination");
    expect(recovered.status).toBe("duplicate");
    expect(db.queue?.status).toBe("processed");
    expect(replies).toHaveLength(1);
  });

  it("keeps business processing terminal when LINE reply delivery is ambiguous", async () => {
    const item = event("evt-reply-failure");
    const db = makeQueueDb();
    const delivered: string[] = [];
    const svc = new WebhookService(db as unknown as SupabaseClient<Database>, {
      replyMessage: async () => { throw new Error("LINE reply network error"); },
      scheduleBackgroundTask: () => {},
    });

    const [result] = await svc.processEvents([item], "destination");
    expect(result.status).toBe("saved");
    expect(result.retryable).not.toBe(true);
    expect(db.queue?.status).toBe("processed");
    expect(delivered).toHaveLength(0);

    const [duplicate] = await svc.processEvents([item], "destination");
    expect(duplicate.status).toBe("duplicate");
    expect(db.queue?.status).toBe("processed");
  });
});

describe("ordered White Sheet completion conflicts", () => {
  it("discards stale-worker replies/results and keeps the later completion authoritative", async () => {
    const item = event("evt-conflict");
    const db = makeQueueDb();
    const replies: string[] = [];
    const svc = service(db, replies);
    db.conflictOnNextCompletion();

    const [staleResult] = await svc.processEvents([item], "destination");

    expect(staleResult).toMatchObject({ status: "duplicate", claimConflict: true });
    expect(replies).toHaveLength(0);
    expect(db.queue?.status).toBe("processing");

    db.makeStale();
    await svc.processEvents([item], "destination");
    expect(db.queue?.status).toBe("processed");
    expect(replies).toHaveLength(1);
    expect((await db.repeatCompletion()).data).toBe(false);
  });
});

describe("ordered White Sheet receive activation", () => {
  it("successful receive creates and uses an ordered receipt", async () => {
    const item = event("evt-receive-ok");
    const db = makeQueueDb();
    const replies: string[] = [];

    const [result] = await service(db, replies).processEvents([item], "destination");

    expect(db.receiveCalls).toBeGreaterThanOrEqual(1);
    expect(db.queueCount).toBe(1);
    expect(db.queue?.status).toBe("processed");
    expect(db.rawCount).toBe(1);
    expect(result.status).toBe("saved");
    expect(replies).toHaveLength(1);
  });

  it("schema-cache error on receive surfaces and does not poison ordering", async () => {
    const first = event("evt-cache-1");
    const second = event("evt-cache-2");
    let failNextReceive = true;
    const raws = new Map<string, { id: string; payload: LineEvent }>();
    let queue: {
      lineEventId: string;
      rawMessageId: string;
      sourceId: string;
      status: QueueStatus;
      stale: boolean;
      claimToken: string | null;
      attempts: number;
    } | null = null;
    let sequence = 0;
    let receiveCalls = 0;

    const db = {
      async rpc(name: string, args: Record<string, unknown>) {
        if (name === "receive_line_webhook_event") {
          receiveCalls += 1;
          if (failNextReceive) {
            failNextReceive = false;
            return {
              data: null,
              error: {
                code: "PGRST202",
                message: "Could not find the function public.receive_line_webhook_event in the schema cache",
              },
            };
          }
          const lineEventId = args.p_line_event_id as string;
          const rawMessageId = `raw-${++sequence}`;
          raws.set(lineEventId, { id: rawMessageId, payload: args.p_payload as LineEvent });
          queue = {
            lineEventId,
            rawMessageId,
            sourceId: args.p_source_id as string,
            status: "pending",
            stale: false,
            claimToken: null,
            attempts: 0,
          };
          return { data: { raw_message_id: rawMessageId, duplicate: false }, error: null };
        }
        if (name === "claim_line_webhook_event") {
          if (!queue || queue.sourceId !== args.p_source_id) return { data: null, error: null };
          if (queue.status !== "pending") return { data: null, error: null };
          queue.status = "processing";
          queue.claimToken = `token-${++sequence}`;
          queue.attempts += 1;
          return {
            data: {
              queue_id: "queue-1",
              line_event_id: queue.lineEventId,
              source_id: queue.sourceId,
              raw_message_id: queue.rawMessageId,
              receive_order: 1,
              claim_token: queue.claimToken,
            },
            error: null,
          };
        }
        if (name === "complete_line_webhook_event") {
          const matches = queue?.status === "processing"
            && queue.rawMessageId === args.p_raw_message_id
            && queue.claimToken === args.p_claim_token;
          if (!matches || !queue) return { data: false, error: null };
          queue.status = args.p_status as QueueStatus;
          queue.claimToken = null;
          return { data: true, error: null };
        }
        throw new Error(`unexpected rpc: ${name}`);
      },
      from(table: string) {
        if (table !== "raw_messages") throw new Error(`unexpected table: ${table}`);
        return {
          select() {
            return {
              eq(_column: string, rawMessageId: unknown) {
                return {
                  async maybeSingle() {
                    const raw = [...raws.values()].find((row) => row.id === rawMessageId);
                    return { data: raw ? { payload: raw.payload } : null, error: null };
                  },
                };
              },
            };
          },
          insert() {
            throw new Error("direct raw_messages insert must not run after schema-cache receive failure");
          },
        };
      },
      get receiveCalls() { return receiveCalls; },
      get queue() { return queue; },
      get queueCount() { return queue ? 1 : 0; },
    };

    const replies: string[] = [];
    const svc = new WebhookService(db as unknown as SupabaseClient<Database>, {
      replyMessage: async (_token, text) => { replies.push(text); },
      scheduleBackgroundTask: () => {},
    });

    // First White Sheet event: schema-cache miss must surface (no direct insert).
    const [firstResult] = await svc.processEvents([first], "destination");
    expect(receiveCalls).toBe(1);
    expect(firstResult.status).toBe("error");
    expect(db.queueCount).toBe(0);
    expect(replies).toHaveLength(0);

    // Second White Sheet event on the same service instance must still attempt
    // receive — schema-cache must not poison orderedQueueAvailable.
    await svc.processEvents([second], "destination");
    expect(receiveCalls).toBe(2);
    expect(db.queueCount).toBe(1);
    expect(db.queue?.status).toBe("processed");
    expect(replies.length).toBeGreaterThanOrEqual(1);
  });

  it("opener, field, and close each use ordered receive and create queue rows", async () => {
    const receiveByText: string[] = [];
    const queueRows: Array<{ lineEventId: string; status: QueueStatus }> = [];
    const raws = new Map<string, { id: string; payload: LineEvent; text: string | null }>();
    const notes: Record<string, unknown>[] = [];
    let sequence = 0;
    let receiveOrder = 0;
    const queues = new Map<string, {
      lineEventId: string;
      rawMessageId: string;
      sourceId: string;
      status: QueueStatus;
      claimToken: string | null;
      receiveOrder: number;
    }>();

    function textEvent(id: string, text: string): LineMessageEvent {
      return {
        type: "message",
        webhookEventId: id,
        timestamp: Date.now(),
        replyToken: `reply-${id}`,
        source: { type: "user", userId: "source-1" },
        message: { type: "text", id: `message-${id}`, text },
      } as unknown as LineMessageEvent;
    }

    const db = {
      async rpc(name: string, args: Record<string, unknown>) {
        if (name === "receive_line_webhook_event") {
          const text = (args.p_raw_text as string | null) ?? null;
          receiveByText.push(text ?? "");
          const lineEventId = args.p_line_event_id as string;
          const rawMessageId = `raw-${++sequence}`;
          raws.set(lineEventId, { id: rawMessageId, payload: args.p_payload as LineEvent, text });
          const row = {
            lineEventId,
            rawMessageId,
            sourceId: args.p_source_id as string,
            status: "pending" as QueueStatus,
            claimToken: null as string | null,
            receiveOrder: ++receiveOrder,
          };
          queues.set(lineEventId, row);
          queueRows.push({ lineEventId, status: "pending" });
          return { data: { raw_message_id: rawMessageId, duplicate: false }, error: null };
        }
        if (name === "claim_line_webhook_event") {
          const pending = [...queues.values()]
            .filter((q) => q.sourceId === args.p_source_id && q.status === "pending")
            .sort((a, b) => a.receiveOrder - b.receiveOrder)[0];
          if (!pending) return { data: null, error: null };
          pending.status = "processing";
          pending.claimToken = `token-${++sequence}`;
          return {
            data: {
              queue_id: `queue-${pending.receiveOrder}`,
              line_event_id: pending.lineEventId,
              source_id: pending.sourceId,
              raw_message_id: pending.rawMessageId,
              receive_order: pending.receiveOrder,
              claim_token: pending.claimToken,
            },
            error: null,
          };
        }
        if (name === "complete_line_webhook_event") {
          const row = [...queues.values()].find((q) =>
            q.rawMessageId === args.p_raw_message_id && q.claimToken === args.p_claim_token
          );
          if (!row || row.status !== "processing") return { data: false, error: null };
          row.status = args.p_status as QueueStatus;
          row.claimToken = null;
          return { data: true, error: null };
        }
        if (name === "close_manual_white_sheet_note_session") {
          const session = notes.find((r) => r.id === args.p_session_id);
          if (!session) return { data: { outcome: "not_found", session: null, cash_entry: null }, error: null };
          const empty = ["labor", "location_fee", "bag", "snack", "other_amount", "actual_cash"]
            .every((k) => session[k] === null || session[k] === undefined);
          if (empty) return { data: { outcome: "empty", session, cash_entry: null }, error: null };
          session.status = "closed";
          return {
            data: {
              outcome: "closed",
              session,
              cash_entry: {
                labor: session.labor ?? 0,
                location_fee: session.location_fee ?? 0,
                bag: session.bag ?? 0,
                snack: session.snack ?? 0,
                other: session.other_amount ?? 0,
                other_note: session.other_note ?? null,
                actual_cash_submitted: session.actual_cash ?? 0,
              },
            },
            error: null,
          };
        }
        throw new Error(`unexpected rpc: ${name}`);
      },
      from(table: string) {
        if (table === "raw_messages") {
          return {
            select() {
              return {
                eq(_column: string, rawMessageId: unknown) {
                  return {
                    async maybeSingle() {
                      const raw = [...raws.values()].find((row) => row.id === rawMessageId);
                      return { data: raw ? { payload: raw.payload } : null, error: null };
                    },
                  };
                },
              };
            },
            insert() {
              throw new Error("direct raw_messages insert must not run for White Sheet ordered events");
            },
          };
        }
        if (table === "manual_white_sheet_note_sessions") {
          return {
            select() {
              return {
                eq(col: string, val: unknown) {
                  return {
                    eq(col2: string, val2: unknown) {
                      return {
                        order() {
                          return {
                            limit() {
                              return {
                                async maybeSingle() {
                                  const row = notes.find((r) => r[col] === val && r[col2] === val2);
                                  return { data: row ?? null, error: null };
                                },
                              };
                            },
                          };
                        },
                        async maybeSingle() {
                          const row = notes.find((r) => r[col] === val && r[col2] === val2);
                          return { data: row ?? null, error: null };
                        },
                      };
                    },
                    order() {
                      return {
                        limit() {
                          return {
                            async maybeSingle() {
                              const row = notes.find((r) => r[col] === val);
                              return { data: row ?? null, error: null };
                            },
                          };
                        },
                      };
                    },
                    async maybeSingle() {
                      const row = notes.find((r) => r[col] === val);
                      return { data: row ?? null, error: null };
                    },
                  };
                },
              };
            },
            insert(payload: Record<string, unknown>) {
              return {
                select() {
                  return {
                    single() {
                      const row = {
                        id: `note-${++sequence}`,
                        status: "open",
                        labor: null,
                        location_fee: null,
                        bag: null,
                        snack: null,
                        other_amount: null,
                        other_note: null,
                        actual_cash: null,
                        created_at: new Date().toISOString(),
                        ...payload,
                      };
                      notes.push(row);
                      return Promise.resolve({ data: row, error: null });
                    },
                  };
                },
              };
            },
            update(patch: Record<string, unknown>) {
              return {
                eq(col: string, val: unknown) {
                  return {
                    eq(col2: string, val2: unknown) {
                      return {
                        eq(col3: string, val3: unknown) {
                          return {
                            select() {
                              return {
                                async maybeSingle() {
                                  const idx = notes.findIndex(
                                    (r) => r[col] === val && r[col2] === val2 && r[col3] === val3,
                                  );
                                  if (idx === -1) return { data: null, error: null };
                                  Object.assign(notes[idx], patch);
                                  return { data: notes[idx], error: null };
                                },
                              };
                            },
                          };
                        },
                      };
                    },
                  };
                },
              };
            },
          };
        }
        if (table === "pending_sessions") {
          return {
            select() {
              return {
                eq() {
                  return {
                    async maybeSingle() {
                      return { data: null, error: null };
                    },
                  };
                },
              };
            },
          };
        }
        const noop: unknown = new Proxy({}, { get: () => noop });
        return {
          select() { return noop; },
          insert() { return noop; },
          update() { return noop; },
        };
      },
    };

    const replies: string[] = [];
    const svc = new WebhookService(db as unknown as SupabaseClient<Database>, {
      replyMessage: async (_token, text) => { replies.push(text); },
      scheduleBackgroundTask: () => {},
    });

    const openText = "ตลาดทดสอบอนาคต ส่งใบขาวมือ 31/12/2579";
    const closeText = "จบใบขาวมือ";
    await svc.processEvents([textEvent("evt-open", openText)], "destination");
    await svc.processEvents([textEvent("evt-field", PRODUCTION_SECOND_UAT_FIELD_PAYLOAD)], "destination");
    await svc.processEvents([textEvent("evt-close", closeText)], "destination");

    expect(receiveByText).toEqual([
      openText,
      PRODUCTION_SECOND_UAT_FIELD_PAYLOAD,
      closeText,
    ]);
    expect(queues.size).toBe(3);
    expect([...queues.values()].every((q) => q.status === "processed")).toBe(true);
    expect(notes).toHaveLength(1);
    expect(notes[0].status).toBe("closed");
    expect(notes[0].labor).toBe(620);
    expect(notes[0].actual_cash).toBe(5360);
    expect(replies.length).toBe(3);
  });

  it("unrelated LINE traffic remains on the direct path", async () => {
    const item = {
      type: "follow",
      webhookEventId: "evt-hello",
      timestamp: Date.now(),
      source: { type: "user", userId: "source-1" },
    } as unknown as LineEvent;
    const db = makeQueueDb();
    await service(db, []).processEvents([item], "destination");
    expect(db.receiveCalls).toBe(0);
    expect(db.queueCount).toBe(0);
    expect(db.rawCount).toBe(1);
  });
});
