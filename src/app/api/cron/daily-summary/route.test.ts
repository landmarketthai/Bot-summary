import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";
import { resetRuntimeProductCodesForTests } from "@/lib/produce/product-code/resolver";

let transactions: unknown[] = [];
let productCodes: unknown[] = [];
let productCodeError: unknown = null;
let transactionReadGate: Promise<void> | null = null;
let onTransactionRead: (() => void) | null = null;
let pushed: string[] = [];
const sources = [{ id: "raw-1", source_id: "CdailyTarget00001", source_type: "group" }];

function chain(table: string) {
  const node: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "in"]) node[method] = () => node;
  node.limit = () => Promise.resolve({ data: table === "produce_product_codes" ? productCodes : [], error: productCodeError });
  node.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => {
    const data = table === "produce_transactions" ? transactions : table === "raw_messages" ? sources : [];
    const gate = table === "produce_transactions" ? transactionReadGate : null;
    if (table === "produce_transactions") onTransactionRead?.();
    return Promise.resolve(gate).then(() => ({ data, error: null })).then(resolve, reject);
  };
  return node;
}

mock.module("@/lib/supabase/server", () => ({
  createServiceClient: () => ({
    from: (table: string) => chain(table),
  }),
}));

mock.module("@/lib/line/reply", () => ({
  pushLineMessage: async (_to: string, text: string) => { pushed.push(text); return { status: "delivered" }; },
}));

const { GET } = await import("./route");
const originalSecret = process.env.CRON_SECRET;

beforeEach(() => {
  resetRuntimeProductCodesForTests();
  transactions = [{
    raw_message_id: "raw-1",
    staff_name: "staff",
    market_name: "market",
    transaction_type: "\u0e40\u0e1a\u0e34\u0e01",
    total_amount: 100,
    product_name: "runtime promoted mango",
  }];
  productCodes = [{
    product_code: "\u0e21\u0039\u0038",
    category_code: "\u0e21",
    category_name: "\u0e1c\u0e25\u0e44\u0e21\u0e49",
    canonical_name: "runtime promoted mango",
    code_enabled: true,
  }];
  productCodeError = null;
  transactionReadGate = null;
  onTransactionRead = null;
  pushed = [];
  process.env.CRON_SECRET = "daily-secret";
});

afterEach(() => {
  resetRuntimeProductCodesForTests();
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
});

describe("daily summary cron runtime categories", () => {
  test("preloads runtime product codes before category ledger aggregation", async () => {
    const request = new NextRequest("http://localhost/api/cron/daily-summary?date=2026-07-25", {
      headers: { authorization: "Bearer daily-secret" },
    });
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toContain("\ud83c\udf49 \u0e1c\u0e25\u0e44\u0e21\u0e49");
    expect(pushed[0]).not.toContain("\u0e44\u0e21\u0e48\u0e08\u0e31\u0e14\u0e2b\u0e21\u0e27\u0e14");
  });

  test("keeps request A's category after request B fails to refresh the dictionary", async () => {
    let releaseTransactionRead!: () => void;
    transactionReadGate = new Promise<void>((resolve) => { releaseTransactionRead = resolve; });
    const transactionReadStarted = new Promise<void>((resolve) => { onTransactionRead = resolve; });
    const request = new NextRequest("http://localhost/api/cron/daily-summary?date=2026-07-25", {
      headers: { authorization: "Bearer daily-secret" },
    });

    const requestA = GET(request);
    await transactionReadStarted;
    onTransactionRead = null;
    transactionReadGate = null;
    transactions = [];
    productCodeError = { message: "dictionary read failed" };
    const responseB = await GET(request);
    expect(responseB.status).toBe(200);

    releaseTransactionRead();
    const responseA = await requestA;
    expect(responseA.status).toBe(200);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toContain("\ud83c\udf49 \u0e1c\u0e25\u0e44\u0e21\u0e49");
    expect(pushed[0]).not.toContain("\u0e44\u0e21\u0e48\u0e08\u0e31\u0e14\u0e2b\u0e21\u0e27\u0e14");
  });
});
