import { afterEach, describe, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";
import { FakeDatabase } from "@/lib/summary/test-fake-supabase";

let db = new FakeDatabase();
let missingRetention = false;
mock.module("@/lib/supabase/server", () => ({ createServiceClient: () => ({
  from(table: string) {
    if (missingRetention && table === "pending_session_retired_generations") {
      throw new Error("retention evidence unavailable");
    }
    return db.from(table);
  },
}) }));
mock.module("@/lib/line/reply", () => ({ pushLineMessage: () => { throw new Error("unit test must never send LINE"); } }));
const { GET } = await import("./route");
const originalSecret = process.env.CRON_SECRET;
afterEach(() => {
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
  missingRetention = false;
});
const DATE = "2026-10-07";
const ROUND = "round-1";
const failedReturn = {
  id: "failed-return", session_key: "group:g:user:u", session_generation: "generation-1",
  source_id: "group-1", staff_label: "น้อย", market_label: "ราชพฤกษ์", business_date: DATE,
  accountability_round_id: null, declared_transaction_type: "คืน", finalization_status: "failed_closed",
  accumulated_text: "น้อย-ราชพฤกษ์ ชั่งคืน 7/10/2569\n1.แอปเปิ้ล 20 ลูก\nจบรายการชั่งคืน",
  created_at: "2026-10-07T08:00:00.000Z", generation_created_at: "2026-10-07T08:00:00.000Z",
};
const withdrawal = {
  id: "withdrawal", session_id: "withdrawal-session", raw_message_id: "raw-withdrawal",
  market_name: "ราชพฤกษ์", staff_name: "น้อย", product_name: "แอปเปิ้ล", unit: "ลูก",
  transaction_type: "เบิก", base_transaction_type: "เบิก", transaction_date: DATE,
  quantity: 100, price_per_unit: 20, basis_quantity: null, session_kind: "main",
  accountability_round_id: ROUND, item_created_at: "2026-10-07T02:00:00.000Z",
};
function seed() {
  db = new FakeDatabase().seed("produce_transactions", [withdrawal])
    .seed("accountability_rounds", [{ id: ROUND, source_id: "group-1", business_date: DATE,
      seller_label: "น้อย", market_label: "ราชพฤกษ์" }]);
}
async function messages() {
  process.env.CRON_SECRET = "local-unit-test";
  const response = await GET(new NextRequest(`http://localhost/api/cron/daily-stock-summary?date=${DATE}&debug=1`, {
    headers: { authorization: "Bearer local-unit-test" },
  }));
  expect(response.status).toBe(200);
  return (await response.json()).messages.join("\n") as string;
}
describe("P0 daily-stock sold-out claim", () => {
  test.each(["pending_sessions", "pending_session_retired_generations"])("%s failure prevents sold-out wording", async (table) => {
    seed();
    db.seed(table, [failedReturn]);
    expect(await messages()).not.toContain("สินค้าที่ไม่ได้คืนถือว่าขายออกแล้ว");
    expect(db.appendCalls).toBe(0);
  });
  test("a readiness read error prevents sold-out wording", async () => {
    seed();
    missingRetention = true;
    expect(await messages()).not.toContain("สินค้าที่ไม่ได้คืนถือว่าขายออกแล้ว");
  });
  test("a proven later resend releases the failure", async () => {
    seed();
    db.seed("pending_session_retired_generations", [failedReturn])
      .seed("produce_transactions", [withdrawal, { ...withdrawal, id: "resend-item", session_id: "resend",
        raw_message_id: "raw-resend", transaction_type: "คืน", base_transaction_type: "คืน", quantity: 0 }])
      .seed("produce_sessions", [{ id: "resend", session_date: DATE, session_kind: "main",
        accountability_round_id: ROUND, staff_name: "น้อย", session_title: "ราชพฤกษ์",
        raw_message_id: "raw-resend", finalized_at: "2026-10-07T09:00:00.000Z" }])
      .seed("raw_messages", [{ id: "raw-resend", source_id: "group-1" }]);
    expect(await messages()).toContain("สินค้าที่ไม่ได้คืนถือว่าขายออกแล้ว");
  });
});
