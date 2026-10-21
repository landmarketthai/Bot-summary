/** Explicitly opt in with environment credentials. Every network request is GET-only. */
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { renderToBuffer } from "@react-pdf/renderer";
import type { Database } from "../../../src/types/database";
import { canonicalMarketLabel } from "../../../src/lib/market";
import { registerFonts } from "../../../src/lib/pdf/fonts";
import { MorningBriefA4Doc } from "../../../src/lib/pdf/MorningBriefA4Doc";
import { loadMorningBriefReport } from "../../../src/lib/summary/morning-brief-service";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
assert(url && key, "Supply Supabase credentials in the local environment; never commit them.");
const origin = new URL(url).origin;
let reads = 0;
const responses = new Map<string, Promise<Response>>();
const supabase = createClient<Database>(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: (async (input, init) => {
    const address = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    assert(method === "GET" && address.origin === origin && address.pathname.startsWith("/rest/v1/"), "Read-only UAT rejected a network mutation or foreign destination");
    let response = responses.get(address.href);
    if (!response) {
      reads++;
      response = fetch(input, { ...init, signal: AbortSignal.timeout(60_000) });
      responses.set(address.href, response);
    }
    return (await response).clone();
  }) as typeof fetch },
});
registerFonts();
const results = [];
const dates = process.argv.slice(2);
for (const date of dates.length ? dates : ["2026-10-18", "2026-10-19", "2026-10-20"]) {
  assert(/^2026-10-(18|19|20)$/.test(date), "Only the approved UAT dates are supported.");
  const fruit = await loadMorningBriefReport(supabase, date, "fruit");
  const vegetable = await loadMorningBriefReport(supabase, date, "vegetable");
  const original = await loadMorningBriefReport(supabase, date);
  assert(fruit.sales.markets?.every((market) => canonicalMarketLabel(market.marketLabel) !== "พาซิโอ้ผัก"));
  assert(vegetable.sales.markets?.every((market) => canonicalMarketLabel(market.marketLabel) === "พาซิโอ้ผัก"));
  assert.equal(fruit.sales.confirmedSalesSatang + vegetable.sales.confirmedSalesSatang, original.sales.confirmedSalesSatang);
  assert.equal(fruit.sales.pendingReviewSalesSatang + vegetable.sales.pendingReviewSalesSatang, original.sales.pendingReviewSalesSatang);
  const fruitIds = new Set(fruit.sourceTransactions?.map((row) => row.id));
  assert(vegetable.sourceTransactions?.every((row) => !fruitIds.has(row.id)));
  assert.equal(vegetable.readiness?.status, date === "2026-10-20" ? "not_ready" : "ready");
  assert.equal(vegetable.houseStock.status, "missing");
  assert(vegetable.salesDetails?.every((row) => row.valueStatus === "CONFIRMED" || row.expectedSalesSatang === null));
  results.push({ date, fruitConfirmedSatang: fruit.sales.confirmedSalesSatang,
    vegetableConfirmedSatang: vegetable.sales.confirmedSalesSatang, vegetablePendingSatang: vegetable.sales.pendingReviewSalesSatang,
    vegetableUnavailable: vegetable.sales.excludedFromSalesCount, vegetableSources: vegetable.sourceTransactions?.length,
    vegetableDamagedItemCount: vegetable.salesDetails?.filter((row) => row.damagedReturnQuantity > 0).length,
    readiness: vegetable.readiness, salesParity: "PASS", scopeIsolation: "PASS" });
  for (const report of [fruit, vegetable]) {
    await Bun.write(`.tmp-live-uat/${report.reportScope}-${date}.report.json`, JSON.stringify(report, null, 2) + "\n");
    if (report.readiness?.status === "not_ready") continue;
    const pdf = await renderToBuffer(MorningBriefA4Doc({ report, generatedAt: new Date("2026-10-21T13:00:00+07:00") }));
    await Bun.write(`.tmp-live-uat/${report.reportScope}-${date}.pdf`, pdf);
  }
  console.log(JSON.stringify(results.at(-1)));
  await Bun.write(".tmp-live-uat/results.json", JSON.stringify({ reads, mutations: 0, results }, null, 2) + "\n");
}
await Bun.write(".tmp-live-uat/results.json", JSON.stringify({ reads, mutations: 0, results }, null, 2) + "\n");
