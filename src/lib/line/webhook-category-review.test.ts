import { afterEach, describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { WebhookService } from "./webhook-service";
import type { LinePostbackEvent } from "./types";
import { GuidedMenuUxHandler } from "./guided-menu";
import { GuidedMenuFakeDatabase } from "./guided-menu/test-fake-db";

const GROUP = "C-review";
const ADMIN = "U-admin";
const DATA = "pcat1|11111111-2222-4333-8444-555555555555|1|sc|ผ";
const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

function postback(webhookEventId: string, userId: string, groupId = GROUP): LinePostbackEvent {
  return {
    type: "postback", webhookEventId, deliveryContext: { isRedelivery: false }, timestamp: Date.now(),
    source: { type: "group", groupId, userId }, mode: "active", replyToken: "reply-pb", postback: { data: DATA },
  } as LinePostbackEvent;
}

function setup() {
  process.env.CATEGORY_REVIEW_LINE_GROUP_IDS = GROUP;
  process.env.CATEGORY_REVIEW_ADMIN_LINE_USER_IDS = ADMIN;
  const db = new GuidedMenuFakeDatabase();
  const decisions: Record<string, unknown>[] = [];
  const client = new Proxy(db.asClient(), {
    get(target, prop, receiver) {
      if (prop !== "rpc") return Reflect.get(target, prop, receiver);
      return async (name: string, args: Record<string, unknown>) => {
        if (name !== "decide_produce_category_candidate") return db.rpc(name, args);
        decisions.push(args);
        return { data: { status: "applied", product_name: "ผักทดสอบ", category_code: "ผ" }, error: null };
      };
    },
  }) as SupabaseClient;
  const replies: string[] = [];
  const service = new WebhookService(client as never, {
    guidedMenuHandler: new GuidedMenuUxHandler(db.asClient()),
    replyMessage: async (_token: string, text: string) => { replies.push(text); },
    replyApiMessages: async () => { throw new Error("category review must not use the guided menu path"); },
  });
  return { service, decisions, replies };
}

describe("webhook category review postback", () => {
  it("6. a replayed LINE event does not duplicate the decision", async () => {
    const { service, decisions, replies } = setup();
    const event = postback("evt-cat-1", ADMIN);
    await service.processEvents([event], "dest");
    await service.processEvents([event], "dest");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ p_line_event_id: "evt-cat-1", p_line_user_id: ADMIN, p_source_id: GROUP, p_action: "select_category", p_category_code: "ผ" });
    expect(replies).toEqual(["✅ บันทึกแล้ว: ผักทดสอบ → ผัก\nมีผลกับรายงานรอบถัดไป"]);
  });

  it("7. unauthorized users and groups never reach the decision RPC", async () => {
    const { service, decisions, replies } = setup();
    await service.processEvents([postback("evt-cat-2", "U-stranger")], "dest");
    await service.processEvents([postback("evt-cat-3", ADMIN, "C-operations")], "dest");
    expect(decisions).toHaveLength(0);
    expect(replies).toEqual(["⛔ ไม่มีสิทธิ์อนุมัติหมวดสินค้า"]);
  });
});
