import assert from "node:assert/strict";
import { markUncertifiedProduceNets, type ProduceNetStatus } from "../src/lib/settlement/produce-value-status";

// Local fixture timings model query round trips; they are never Production latency.
type Row = Record<string, unknown>;
const dates = Array.from({ length: 31 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
const tables: Record<string, Row[]> = Object.fromEntries([
  "produce_transactions", "produce_sessions", "raw_messages", "accountability_rounds",
  "pending_session_retired_generations", "pending_sessions", "pending_session_ingest",
  "parse_errors", "pending_produce_deferred_events", "imported_sessions", "produce_items",
  "central_selling_prices", "settlement_entries",
].map((name) => [name, []]));
const groups: Array<{ date: string; market: string; seller: string; produceNetStatus: ProduceNetStatus }> = [];
const products = ["หมอนทอง", "มังคุด", "ลองกอง", "มะม่วง", "มะนาว"];
for (const date of dates) {
  const day = Number(date.slice(-2));
  for (let seller = 0; seller < 10; seller++) {
    const staff = `ผู้ขาย${seller}`;
    const round = `${date}-r${seller}`;
    groups.push({ date, market: "ราชพฤกษ์", seller: staff, produceNetStatus: "trusted" });
    tables.accountability_rounds.push({ id: round, business_date: date, source_id: "Cuat",
      seller_label: staff, market_label: "ราชพฤกษ์", owner_line_user_id: `U${seller}`, status: "open" });
    for (const kind of ["เบิก", "คืน", "คืนเสีย"]) {
      const id = `${round}-${kind}`;
      const title = `${staff}-ราชพฤกษ์ ${kind === "เบิก" ? "เบิก" : kind === "คืน" ? "ชั่งคืน" : "ชั่งคืนเสีย"} ${day}/10/2569`;
      tables.produce_sessions.push({ id, session_date: date, staff_name: staff, session_title: title,
        session_kind: "main", accountability_round_id: round, raw_message_id: id,
        voided_at: null, finalized_at: `${date}T12:00:00Z`, created_at: `${date}T08:00:00Z`,
        total_items: 5, parser_errors: [] });
      tables.raw_messages.push({ id, source_id: "Cuat", is_processed: true, message_type: "text",
        created_at: `${date}T08:00:00Z`, raw_text: title, payload: {} });
      for (const product of products) tables.produce_transactions.push({ id: `${id}-${product}`,
        session_id: id, session_kind: "main", transaction_date: date, transaction_type: kind,
        base_transaction_type: kind, market_name: "ราชพฤกษ์", staff_name: staff,
        product_name: product, unit: "โล", quantity: kind === "เบิก" ? 10 : 1,
        price_per_unit: 100, total_amount: kind === "เบิก" ? 1000 : 100,
        basis_quantity: null, basis_unit: null, basis_price: null,
        accountability_round_id: round, raw_message_id: id, item_created_at: `${date}T08:00:00Z` });
    }
    for (let generation = 0; generation < 2; generation++) {
      tables.pending_session_retired_generations.push({ session_generation: `${round}-g${generation}`,
        session_key: `group:Cuat:user:U${seller}:draft${generation}`, source_id: "Cuat",
        staff_label: staff, market_label: "ราชพฤกษ์", business_date: date,
        declared_transaction_type: "คืน", finalization_status: "failed_closed", finalization_error: null,
        accountability_round_id: null, generation_created_at: `${date}T15:00:00Z`,
        close_requested_at: null, close_refused_at: null,
        accumulated_text: `${staff}-ราชพฤกษ์ ชั่งคืน ${day}/10/2569\n1.หมอนทอง 1 โล\nจบรายการชั่งคืน` });
    }
  }
}
assert.equal(tables.produce_transactions.length, 4650);
assert.equal(tables.produce_sessions.length, 930);
assert.equal(tables.pending_session_retired_generations.length, 620);

export function fixtureClient(delayMs: number, options: { resolved?: boolean; missingEvidence?: boolean } = {}) {
  const queries: Record<string, number> = {};
  let active = 0;
  let maxActive = 0;
  const client = {
    from(table: string) {
      assert.ok(table in tables, `unexpected table ${table}`);
      if (options.missingEvidence && table === "pending_session_retired_generations") {
        throw new Error("local fixture: required evidence table unavailable");
      }
      let rows = options.resolved && table === "pending_session_retired_generations" ? [] : [...tables[table]];
      let first = 0;
      let last = Infinity;
      const node = {
        select() { return node; },
        order() { return node; },
        or() { return node; }, // Both OR scans have empty/processed-only fixture inputs.
        eq(column: string, value: unknown) { rows = rows.filter((r) => r[column] === value); return node; },
        gte(column: string, value: string) { rows = rows.filter((r) => String(r[column]) >= value); return node; },
        lt(column: string, value: string) { rows = rows.filter((r) => String(r[column]) < value); return node; },
        in(column: string, values: unknown[]) { rows = rows.filter((r) => values.includes(r[column])); return node; },
        is(column: string, value: unknown) { rows = rows.filter((r) => (r[column] ?? null) === value); return node; },
        not(column: string, op: string, value: unknown) {
          assert.equal(op, "is");
          rows = rows.filter((r) => (r[column] ?? null) !== value); return node;
        },
        range(start: number, end: number) { first = start; last = end; return node; },
        then(resolve: (result: { data: Row[]; error: null; count: number }) => unknown,
          reject: (error: unknown) => unknown) {
          queries[table] = (queries[table] ?? 0) + 1;
          active++;
          maxActive = Math.max(maxActive, active);
          const result = { data: rows.slice(first, last + 1), error: null, count: rows.length };
          return new Promise<typeof result>((done) => {
            if (delayMs) setTimeout(() => { active--; done(result); }, delayMs);
            else { active--; done(result); }
          }).then(resolve, reject);
        },
      };
      return node;
    },
  };
  return { client, queries, maxActive: () => maxActive };
}

if (import.meta.main) {
  let networkAttempts = 0;
  globalThis.fetch = (() => { networkAttempts++; throw new Error("UAT network forbidden"); }) as unknown as typeof fetch;
  for (const [delayMs, samples] of [[0, 5], [25, 5], [100, 5], [250, 1]]) {
    const elapsed: number[] = [];
    let queryCounts: Record<string, number> = {};
    let maxActive = 0;
    for (let sample = 0; sample < samples; sample++) {
      const fake = fixtureClient(delayMs);
      const start = performance.now();
      const marked = await markUncertifiedProduceNets(fake.client as never, groups);
      elapsed.push(performance.now() - start);
      assert.equal(marked.length, 310);
      assert.ok(marked.every((g) => g.produceNetStatus === "return_incomplete"));
      assert.equal(fake.queries.accountability_rounds, 93); // Every preflight reached its final round query.
      if (sample) assert.deepEqual(fake.queries, queryCounts);
      queryCounts = fake.queries;
      maxActive = Math.max(maxActive, fake.maxActive());
      console.log(JSON.stringify({ delayMs, sample: sample + 1, ms: elapsed.at(-1) }));
    }
    elapsed.sort((a, b) => a - b);
    const percentile = (p: number) => elapsed[Math.ceil(p * elapsed.length) - 1];
    console.log(JSON.stringify({ delayMs, samples, minMs: elapsed[0], p50Ms: percentile(.5),
      p95Ms: percentile(.95), maxMs: elapsed.at(-1), queries: queryCounts,
      totalQueries: Object.values(queryCounts).reduce((a, b) => a + b, 0), maxActive, networkAttempts }));
    assert.equal(networkAttempts, 0);
  }
}
