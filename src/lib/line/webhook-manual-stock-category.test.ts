import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { WebhookService } from "./webhook-service";
import type { LineMessageEvent } from "./types";
import { GuidedMenuUxHandler } from "./guided-menu";
import { GuidedMenuFakeDatabase } from "./guided-menu/test-fake-db";
import { loadStockSummary } from "@/lib/summary/stock-summary-service";

/**
 * Regression for independent review F2 (PR #187, 53c6acf): the manual
 * `สรุปคงเหลือ` LINE command classified outside the approved-category
 * snapshot, so an approved rule showed as ❓ ไม่จัดหมวด while the scheduled
 * Stock Summary showed ผัก.
 */
const PRODUCT = "review-new-vegetable";
const ROWS = [{
  market_name: "ตลาดกี้", product_name: PRODUCT, quantity: 12, unit: "ลูก",
  transaction_type: "คืน", price_per_unit: 25, session_id: "s1", sender_name: "x", accountability_round_id: null,
}];

/** Persisted state: one approved rule and one good return, behind PostgREST-shaped queries. */
function persisted() {
  const reads: string[] = [];
  const from = (table: string) => {
    reads.push(table);
    const query: Record<string, unknown> = {};
    for (const method of ["select", "eq", "in", "order", "range", "limit", "gt", "gte", "lte", "is", "not"]) query[method] = () => query;
    query.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve({
      data: table === "produce_category_rules" ? [{ product_name: PRODUCT, category_code: "ผ" }]
        : table === "produce_transactions" ? ROWS : [],
      error: null,
    }).then(resolve, reject);
    return query;
  };
  return { from, reads };
}

function manualStockEvent(text: string): LineMessageEvent {
  return {
    type: "message", webhookEventId: `manual-stock-${Math.random().toString(36).slice(2)}`,
    deliveryContext: { isRedelivery: false }, timestamp: Date.now(), mode: "active",
    source: { type: "group", groupId: "C-test", userId: "U-test" }, replyToken: "reply-manual",
    message: { type: "text", id: "m-manual", text, quoteToken: "q" },
  } as LineMessageEvent;
}

describe("manual สรุปคงเหลือ uses the approved category policy", () => {
  it("shows an approved vegetable under ผัก, matching the scheduled Stock Summary", async () => {
    const db = persisted();
    const scheduled = await loadStockSummary(db as never, "2026-10-20");
    expect(scheduled.categories.map((c) => [c.category, c.products.map((p) => [p.productName, p.quantity, p.unit])]))
      .toEqual([["ผัก", [[PRODUCT, 12, "ลูก"]]]]);

    const raw = new GuidedMenuFakeDatabase();
    const client = new Proxy(raw.asClient(), {
      get(target, prop, receiver) {
        if (prop === "from") {
          return (table: string) => (table === "produce_transactions" || table === "produce_category_rules"
            ? db.from(table) : (target as SupabaseClient).from(table));
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as SupabaseClient;
    const replies: string[] = [];
    const service = new WebhookService(client as never, {
      guidedMenuHandler: new GuidedMenuUxHandler(raw.asClient()),
      replyMessages: async (_token: string, texts: string[]) => { replies.push(...texts); },
      replyMessage: async (_token: string, text: string) => { replies.push(text); },
      replyApiMessages: async () => { throw new Error("unexpected api reply"); },
    });

    db.reads.length = 0;
    await service.processEvents([manualStockEvent("สรุปคงเหลือ 20/10/2569")], "dest");
    const text = replies.join("\n");
    expect(text).toContain(PRODUCT);
    expect(text).toContain("12");
    expect(text).toContain("ผัก");
    expect(text).not.toContain("ไม่จัดหมวด");
    // One rule read for the whole command, before the stock read.
    expect(db.reads.filter((t) => t === "produce_category_rules")).toHaveLength(1);
    expect(db.reads.indexOf("produce_category_rules")).toBeLessThan(db.reads.indexOf("produce_transactions"));
  });

  it("an ordinary Produce text message does not read category rules", async () => {
    const db = persisted();
    const raw = new GuidedMenuFakeDatabase();
    const client = new Proxy(raw.asClient(), {
      get(target, prop, receiver) {
        if (prop === "from") return (table: string) => (table === "produce_category_rules" ? db.from(table) : (target as SupabaseClient).from(table));
        return Reflect.get(target, prop, receiver);
      },
    }) as SupabaseClient;
    const service = new WebhookService(client as never, {
      guidedMenuHandler: new GuidedMenuUxHandler(raw.asClient()),
      replyMessages: async () => {}, replyMessage: async () => {}, replyApiMessages: async () => {},
    });
    await service.processEvents([manualStockEvent("สวัสดีครับ")], "dest").catch(() => undefined);
    expect(db.reads).not.toContain("produce_category_rules");
  });
});
