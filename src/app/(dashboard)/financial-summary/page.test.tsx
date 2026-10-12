import { expect, mock, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";
import type { GroupRow } from "@/components/financial-summary/FinancialTable";

const ids = Array.from({ length: 930 }, (_, i) => `61100000-0000-4000-8000-${String(i).padStart(12, "0")}`);
const workload = ids.flatMap((id, i) => Array.from({ length: 5 }, () => ({
  raw_message_id: id as string | null, transaction_date: "2026-08-01", transaction_time: null,
  market_name: "market", staff_name: `seller-${i}`, transaction_type: "เบิก",
  total_amount: 10, product_name: "product", unit: "kg", quantity: 1, price_per_unit: 10,
})));
let rows = workload;
let failBatch = 0;
let batches: string[][] = [];
let groups: GroupRow[] = [];
const client = createClient("http://127.0.0.1:56343", "synthetic-test-only", {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    let data: unknown[] = [];
    let status = 200;
    if (url.pathname.endsWith("/produce_transactions")) {
      const offset = Number(url.searchParams.get("offset"));
      data = rows.slice(offset, offset + Number(url.searchParams.get("limit")));
    } else if (url.pathname.endsWith("/raw_messages")) {
      const batch = url.searchParams.get("id")!.slice(4, -1).split(",");
      batches.push(batch);
      expect(batch.length).toBeLessThanOrEqual(50);
      expect(url.href.length).toBeLessThan(6000);
      if (batches.length === failBatch) status = 500;
      data = batch.map(id => ({ id, source_id: `source-${ids.indexOf(id)}` }));
    } else if (!url.pathname.endsWith("/settlement_entries")) {
      throw new Error(`Unexpected query: ${url.pathname}`);
    }
    return new Response(JSON.stringify(status === 200 ? data : { message: "source batch failed" }), {
      status, headers: { "content-type": "application/json" },
    });
  }) as typeof fetch },
});
mock.module("@/lib/supabase/server", () => ({ createServiceClient: () => client, createClient: () => client }));
mock.module("@/lib/settlement/produce-value-status", () => ({
  markUncertifiedProduceNets: async (_client: unknown, input: GroupRow[]) => { groups = input; return input; },
}));
const { default: Page } = await import("./page");
const render = () => Page({ searchParams: Promise.resolve({ month: "2026-08" }) });
function reset() { rows = workload; failBatch = 0; batches = []; groups = []; }

test("monthly page maps all 930 UUIDs across bounded URLs, preserving repeated rows and null IDs", async () => {
  reset();
  rows = [...workload, { ...workload[0], raw_message_id: null, staff_name: "no-source" }];
  await render();
  expect(batches.map(batch => batch.length)).toEqual([...Array(18).fill(50), 30]);
  expect(batches.flat()).toEqual(ids);
  expect(groups).toHaveLength(931);
  for (let i = 0; i < ids.length; i++) {
    expect(groups.find(group => group.seller === `seller-${i}`)).toMatchObject({ sourceId: `source-${i}`, เบิก: 50 });
  }
  expect(groups.find(group => group.seller === "no-source")?.sourceId).toBeUndefined();
});

test.each([1, 10, 19])("monthly page rejects the entire report when source batch %i fails", async batch => {
  reset(); failBatch = batch;
  await expect(render()).rejects.toThrow("source batch failed");
  expect(batches).toHaveLength(batch);
  expect(groups).toHaveLength(0);
});

test("monthly page makes no source query without raw-message IDs", async () => {
  reset(); rows = [];
  await render();
  expect(batches).toEqual([]);
  expect(groups).toEqual([]);
});
