/** Synthetic only: deliberately put the same product in both market scopes. */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../../src/types/database";
import { FakeDatabase, type Row } from "../../../src/lib/summary/test-fake-supabase";
import { HOUSE_STOCK_PRICED_PARSER_VERSION } from "../../../src/lib/physical-inventory/types";

export const DATE = "2026-10-19";
export function scopeFixture(options: {
  withdrawal?: boolean; goodReturn?: boolean; damage?: boolean;
  differentRound?: boolean; pending?: boolean; invalidQuantity?: boolean;
  late?: boolean; alias?: string; rawMarket?: string; extraRows?: Row[];
} = {}) {
  const rows: Row[] = [];
  const add = (scope: string, market: string, product: string, kind: string, quantity: number | null, round = scope) => {
    const id = `${scope}-${kind}`;
    rows.push({ id, session_id: id, market_name: market, staff_name: "synthetic", product_name: product,
      quantity, unit: "โล", transaction_type: kind, base_transaction_type: kind, price_per_unit: options.pending && scope === "vegetable" && kind === "คืน" ? 25 : 20,
      basis_quantity: null, basis_unit: null, basis_price: null, raw_message_id: `raw-${id}`,
      session_kind: "main", transaction_date: DATE, accountability_round_id: round,
      item_created_at: options.late ? "2026-10-20T07:30:00Z" : "2026-10-20T01:00:00Z" });
  };
  const market = options.rawMarket ?? options.alias ?? "พาซิโอ้ผัก";
  if (options.withdrawal !== false) add("vegetable", market, "ผักบุ้ง", "เบิก", 10);
  if (options.goodReturn !== false) add("vegetable", market, "ผักบุ้ง", "คืน", options.invalidQuantity ? null : 3, options.differentRound ? "other-round" : "vegetable");
  if (options.damage) add("vegetable", market, "ผักบุ้ง", "คืนเสีย", 1);
  add("fruit", "พาซิโอ้ผลไม้", "ผักบุ้ง", "เบิก", 40);
  add("fruit", "พาซิโอ้ผลไม้", "ผักบุ้ง", "คืน", 10);
  add("durian", "พาซิโอ้ทุเรียน", "หมอนทอง", "เบิก", 5);
  add("durian", "พาซิโอ้ทุเรียน", "หมอนทอง", "คืน", 1);
  rows.push(...options.extraRows ?? []);
  const db = new FakeDatabase()
    .seed("produce_transactions", rows)
    .seed("accountability_rounds", [
      { id: "vegetable", market_label: options.alias ?? "พาซิโอ้ผัก", seller_label: "synthetic" },
      { id: "fruit", market_label: "พาซิโอ้ผลไม้", seller_label: "synthetic" },
      { id: "durian", market_label: "พาซิโอ้ทุเรียน", seller_label: "synthetic" },
      { id: "other-round", market_label: "พาซิโอ้ผัก", seller_label: "other seller" },
    ])
    .seed("produce_sessions", rows.map((row) => ({ id: row.session_id, session_date: DATE,
      session_title: row.market_name, total_items: 1, parser_errors: [], voided_at: null, raw_message_id: row.raw_message_id })))
    .seed("raw_messages", rows.map((row) => ({ id: row.raw_message_id, source_id: "Csynthetic", is_processed: true })))
    .seed("pending_sessions", options.pending ? [{ id: "pending", session_key: "pending", session_generation: 1,
      business_date: DATE, source_id: "Csynthetic", staff_label: "synthetic", market_label: market,
      declared_transaction_type: "คืนเสีย", accountability_round_id: "vegetable", finalization_status: "pending",
      accumulated_text: null, created_at: "2026-10-20T01:00:00Z" }] : [])
    .seed("physical_inventory_snapshots", [{ id: "house", business_date: DATE, warehouse_code: "MAIN", status: "finalized",
      parser_version: HOUSE_STOCK_PRICED_PARSER_VERSION, replacement_snapshot_id: null }])
    .seed("physical_inventory_items", ["หมอนทอง", "ผักบุ้ง"].map((name, i) => ({ snapshot_id: "house", item_ordinal: i + 1,
      normalized_product: name, raw_product_description: name, normalized_unit: "โล", raw_unit: "โล", quantity: 100,
      unit_price_satang: 2000, raw_text: name, resolution_status: "AUTO_RESOLVED" })));
  return { db, rows, client: db as unknown as SupabaseClient<Database> };
}
