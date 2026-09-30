import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { WebhookService } from "./webhook-service";
import type { LineMessageEvent } from "./types";

describe("webhook timeout hardening", () => {
  it("durably queues image work and returns before claiming it", async () => {
    let receiveCalls = 0;
    let claimCalls = 0;
    const backgroundTasks: Array<() => Promise<void>> = [];
    const db = {
      async rpc(name: string) {
        if (name === "receive_line_webhook_event") {
          receiveCalls += 1;
          return { data: { raw_message_id: "raw-image", duplicate: false }, error: null };
        }
        if (name === "claim_line_webhook_event") {
          claimCalls += 1;
          return { data: null, error: null };
        }
        throw new Error(`unexpected rpc: ${name}`);
      },
    } as unknown as SupabaseClient<Database>;
    const service = new WebhookService(db, {
      scheduleBackgroundTask(task) { backgroundTasks.push(task); },
    });
    const image = {
      type: "message",
      webhookEventId: "evt-image",
      timestamp: Date.now(),
      replyToken: "reply-image",
      source: { type: "user", userId: "user-1" },
      message: { type: "image", id: "image-1" },
    } as unknown as LineMessageEvent;

    const [result] = await service.processEvents(
      [image],
      "destination",
      { deferOrderedProcessing: true },
    );

    expect(result.status).toBe("saved");
    expect(receiveCalls).toBe(1);
    expect(claimCalls).toBe(0);
    expect(backgroundTasks).toHaveLength(1);
  });

  it("caps one ordered drain chunk at 30 events", async () => {
    const service = new WebhookService({} as SupabaseClient<Database>);
    let claimCalls = 0;
    let completed = 0;

    (service as unknown as { claimOrderedEvent: () => Promise<unknown> }).claimOrderedEvent = async () => {
      claimCalls += 1;
      return {
        raw_message_id: `raw-${claimCalls}`,
        line_event_id: `evt-${claimCalls}`,
        source_id: "source-1",
        claim_token: `token-${claimCalls}`,
      };
    };
    (service as unknown as { loadQueuedEvent: () => Promise<unknown> }).loadQueuedEvent = async () => ({
      destination: "destination",
      event: {
        type: "follow",
        webhookEventId: `evt-${claimCalls}`,
        timestamp: Date.now(),
        source: { type: "user", userId: "user-1" },
      },
    });
    (service as unknown as { completeOrderedEvent: () => Promise<boolean> }).completeOrderedEvent = async () => {
      completed += 1;
      return true;
    };

    const processed = await (service as unknown as {
      drainOrderedSource: (
        sourceId: string,
        destination: string,
        results: Map<string, unknown>,
        maxEvents: number,
      ) => Promise<number>;
    }).drainOrderedSource("source-1", "destination", new Map(), 30);

    expect(processed).toBe(30);
    expect(claimCalls).toBe(30);
    expect(completed).toBe(30);
  });

  it("lets the existing durable scheduler continue recent pending queue work", async () => {
    const rows = [
      { source_id: "source-a" },
      { source_id: "source-a" },
      { source_id: "source-b" },
    ];
    const db = {
      from(table: string) {
        if (table !== "line_webhook_event_queue") throw new Error(`unexpected table: ${table}`);
        const builder = {
          select() { return builder; },
          eq() { return builder; },
          gte() { return builder; },
          order() { return builder; },
          limit() { return Promise.resolve({ data: rows, error: null }); },
        };
        return builder;
      },
    } as unknown as SupabaseClient<Database>;
    const service = new WebhookService(db);
    const drained: string[] = [];
    (service as unknown as {
      drainOrderedSource: (
        sourceId: string,
        destination: string,
        results: Map<string, unknown>,
        maxEvents: number,
        deadlineMs: number,
      ) => Promise<number>;
    }).drainOrderedSource = async (sourceId, destination, _results, maxEvents) => {
      expect(destination).toBe("");
      drained.push(sourceId);
      return Math.min(maxEvents, sourceId === "source-a" ? 2 : 1);
    };

    const result = await service.recoverPendingOrderedEvents(5, 60);

    expect(drained).toEqual(["source-a", "source-b"]);
    expect(result).toEqual({ sources: 2, processed: 3 });
  });

  it("reconciles the queue through the database RPC and returns its metrics", async () => {
    const metrics = {
      quarantined: 1,
      surfaced: [{
        line_event_id: "evt-stale",
        source_id: "source-a",
        raw_message_id: "raw-stale",
        received_at: "2026-09-30T00:00:00Z",
        processing_attempts: 2,
      }],
      pending_count: 3,
      processing_count: 0,
      oldest_pending_age_seconds: 120,
      stale_count: 1,
      oldest_stale_age_seconds: 4000,
    };
    const calls: Array<{ name: string; args: unknown }> = [];
    const db = {
      async rpc(name: string, args: unknown) {
        calls.push({ name, args });
        return { data: metrics, error: null };
      },
    } as unknown as SupabaseClient<Database>;

    expect(await new WebhookService(db).reconcileOrderedQueue()).toEqual(metrics);
    expect(calls).toEqual([{ name: "reconcile_line_webhook_queue", args: { p_surface_limit: 20 } }]);
  });

  it("treats a not-yet-deployed reconcile RPC as unavailable, not as a failure", async () => {
    const missing = {
      async rpc() {
        return {
          data: null,
          error: {
            code: "PGRST202",
            message: "Could not find the function public.reconcile_line_webhook_queue(p_surface_limit) in the schema cache",
          },
        };
      },
    } as unknown as SupabaseClient<Database>;
    expect(await new WebhookService(missing).reconcileOrderedQueue()).toBeNull();

    const broken = {
      async rpc() {
        return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
      },
    } as unknown as SupabaseClient<Database>;
    await expect(new WebhookService(broken).reconcileOrderedQueue()).rejects.toThrow("ordered webhook reconcile failed");
  });
});
