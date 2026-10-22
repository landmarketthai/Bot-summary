import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { KNOWN_TX_TYPES, transactionBucket } from "@/lib/summary/transactions";
import type { RemainingFruitSourceRow } from "@/lib/summary/remaining-fruit";
import { cleanMarketName } from "@/lib/market";
import type { LatestDataLookup } from "@/lib/summary/latest-data-hint";
import { logger } from "@/lib/logger";

const PAGE = 1000;

/**
 * The transaction types that ARE a ชั่งคืน, derived from the report's own
 * bucket rule rather than restated. buildRemainingFruitReport calls
 * transactionBucket on every row, so this list is by construction the set of
 * types that can ever contribute remaining stock — it cannot drift from it, and
 * it can never widen into เบิก − คืนเสีย arithmetic or a P2A snapshot.
 */
const GOOD_RETURN_TX_TYPES = KNOWN_TX_TYPES.filter((type) => transactionBucket(type) === "คืน");

export async function fetchRemainingFruitRows(
  supabase: SupabaseClient<Database>,
  date: string,
  marketFilter?: string | null,
): Promise<RemainingFruitSourceRow[]> {
  const rows: RemainingFruitSourceRow[] = [];
  let offset = 0;

  while (true) {
    let query = supabase
      .from("produce_transactions")
      .select("market_name, product_name, quantity, unit, transaction_type, price_per_unit, session_id, sender_name, accountability_round_id")
      .eq("transaction_date", date)
      .in("transaction_type", [...KNOWN_TX_TYPES])
      .order("item_created_at", { ascending: true })
      .range(offset, offset + PAGE - 1);

    if (marketFilter) {
      query = query.ilike("market_name", `%${marketFilter}%`);
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    rows.push(...((data ?? []) as RemainingFruitSourceRow[]));
    if (!data || data.length < PAGE) break;
    offset += PAGE;
  }

  // Session-identity enrichment (source_id / session_time) is only used for optional
  // dedup — never let a failure here take down the whole report. Displaying possible
  // duplicates is safer than failing the report.
  try {
    await attachSessionIdentity(supabase, rows);
  } catch (err) {
    logger.warn("summary.remaining-fruit.enrichment-failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return rows;
}

/**
 * The latest business date STRICTLY BEFORE `beforeDate` that has ชั่งคืน data,
 * with the number of markets that recorded it.
 *
 * Only ever called when the requested date turned out empty, so the report pays
 * nothing on a normal day.
 *
 * Semantics, all of them inherited rather than reinvented:
 *   - source is produce_transactions, the same void-filtered view (migration
 *     0037) the report itself reads — voided sessions cannot appear here, and
 *     Physical Inventory (P2A) lives in its own tables and cannot either;
 *   - eligibility is GOOD_RETURN_TX_TYPES, so "has data" means the same ชั่งคืน
 *     the report means, never เบิก − คืนเสีย;
 *   - `.lt` makes the search strictly backwards, so a future-dated row can
 *     never be picked as "the latest data we have";
 *   - the date comes from ONE ordered row (a MAX in disguise), not from an
 *     application-side scan of history.
 *
 * The market count is the distinct RESOLVED market names of that date, through
 * the same cleanMarketName boundary the report uses for market identity. Rows
 * whose market could not be resolved have no market to count; they are not
 * silently attributed to one.
 *
 * Returns "none" ONLY when the query succeeded and proved there is nothing
 * earlier. A read failure THROWS rather than degrading to "none" — the caller
 * turns that into "unavailable", because a database error is not evidence that
 * the business has no records.
 */
export async function findLatestStockDataDate(
  supabase: SupabaseClient<Database>,
  beforeDate: string,
): Promise<LatestDataLookup> {
  const { data, error } = await supabase
    .from("produce_transactions")
    .select("transaction_date")
    .lt("transaction_date", beforeDate)
    .in("transaction_type", GOOD_RETURN_TX_TYPES)
    .order("transaction_date", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);

  const date = data?.[0]?.transaction_date ?? null;
  if (!date) return { status: "none" };

  // Bounded by construction: one business date, paged like every other read in
  // this module so a busy day is counted in full rather than truncated.
  const markets = new Set<string>();
  let offset = 0;

  while (true) {
    const { data: rows, error: rowsError } = await supabase
      .from("produce_transactions")
      .select("market_name")
      .eq("transaction_date", date)
      .in("transaction_type", GOOD_RETURN_TX_TYPES)
      .order("market_name", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (rowsError) throw new Error(rowsError.message);

    for (const row of rows ?? []) {
      const market = cleanMarketName(row.market_name);
      if (market) markets.add(market);
    }

    if (!rows || rows.length < PAGE) break;
    offset += PAGE;
  }

  return { status: "found", hint: { date, marketCount: markets.size } };
}

async function attachSessionIdentity(
  supabase: SupabaseClient<Database>,
  rows: RemainingFruitSourceRow[],
): Promise<void> {
  const sessionIds = [...new Set(rows.map((r) => r.session_id).filter((id): id is string => !!id))];
  if (sessionIds.length === 0) return;

  const { data: sessions, error: sessionsError } = await supabase
    .from("produce_sessions")
    .select("id, raw_message_id, finalized_at, created_at")
    .in("id", sessionIds);
  if (sessionsError) throw new Error(sessionsError.message);

  const sessionMeta = new Map<string, { rawMessageId: string; time: string | null }>();
  for (const s of sessions ?? []) {
    sessionMeta.set(s.id, {
      rawMessageId: s.raw_message_id,
      time: s.finalized_at ?? s.created_at ?? null,
    });
  }

  const rawMessageIds = [...new Set([...sessionMeta.values()].map((v) => v.rawMessageId))];
  const sourceIdByRawMessage = new Map<string, string | null>();
  if (rawMessageIds.length > 0) {
    const { data: messages, error: messagesError } = await supabase
      .from("raw_messages")
      .select("id, source_id")
      .in("id", rawMessageIds);
    if (messagesError) throw new Error(messagesError.message);

    for (const m of messages ?? []) sourceIdByRawMessage.set(m.id, m.source_id ?? null);
  }

  for (const row of rows) {
    if (!row.session_id) continue;
    const meta = sessionMeta.get(row.session_id);
    if (!meta) continue;
    row.source_id = sourceIdByRawMessage.get(meta.rawMessageId) ?? null;
    row.session_time = meta.time;
  }
}
