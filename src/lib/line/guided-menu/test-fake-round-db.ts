/**
 * Query-router double for the Slice 3D reconciliation reads.
 *
 * Rather than mimic PostgREST it applies the filters the production code
 * actually uses (eq / in / gte / lte / lt / not-null) against canned rows, so a
 * test that seeds a duplicate reference or an out-of-window slip exercises the
 * same classification the real loaders would.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type Row = Record<string, unknown>;

type Filter = (row: Row) => boolean;
type Result = {
  data: Row[];
  error: { message: string } | null;
  count: number;
};


class QueryBuilder implements PromiseLike<Result> {
  private readonly filters: Filter[] = [];
  private limitCount: number | null = null;
  private pending: Row | null = null;
  private mode: "select" | "upsert" | "update" | "insert" = "select";

  constructor(
    private readonly rows: Row[],
    private readonly uniqueKey: readonly string[] = [],
  ) {}

  select(): this {
    return this;
  }
  /** Writes are applied on resolution so filters set afterwards still apply. */
  upsert(values: Row | Row[]): this {
    this.mode = "upsert";
    this.pending = Array.isArray(values) ? values[0]! : values;
    return this;
  }
  update(values: Row): this {
    this.mode = "update";
    this.pending = values;
    return this;
  }
  /** A real INSERT on an existing unique key errors; the finalizer depends on it. */
  insert(values: Row | Row[]): this {
    this.mode = "insert";
    this.pending = Array.isArray(values) ? values[0]! : values;
    return this;
  }
  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value);
    return this;
  }
  in(column: string, values: unknown[]): this {
    const set = new Set(values);
    this.filters.push((row) => set.has(row[column]));
    return this;
  }
  gte(column: string, value: unknown): this {
    this.filters.push((row) => String(row[column] ?? "") >= String(value));
    return this;
  }
  lte(column: string, value: unknown): this {
    this.filters.push((row) => String(row[column] ?? "") <= String(value));
    return this;
  }
  lt(column: string, value: unknown): this {
    this.filters.push((row) => String(row[column] ?? "") < String(value));
    return this;
  }
  /** Only `.not(col, "is", null)` is used by the loaders under test. */
  not(column: string, _operator: string, _value: unknown): this {
    void _operator;
    void _value;
    this.filters.push((row) => row[column] !== null && row[column] !== undefined);
    return this;
  }
  /**
   * Produce preflight uses `.or()` as a documented SUPERSET server-side
   * prefilter; the client-side check remains the authority. Pass through so
   * ปิดรอบ can load settlement Produce status without inventing a second fake.
   */
  or(): this {
    return this;
  }
  order(): this {
    return this;
  }
  range(): this {
    return this;
  }
  limit(count: number): this {
    this.limitCount = count;
    return this;
  }
  is(column: string, value: unknown): this {
    this.filters.push((row) => (row[column] ?? null) === value);
    return this;
  }
  private conflictsOnUniqueKey(): boolean {
    if (this.uniqueKey.length === 0 || !this.pending) return false;
    return this.rows.some((row) =>
      this.uniqueKey.every((column) => row[column] === this.pending![column]),
    );
  }

  private resolve(): Result {
    let matched = this.rows.filter((row) => this.filters.every((f) => f(row)));

    if (this.mode === "update" && this.pending) {
      for (const row of matched) Object.assign(row, this.pending);
    }
    if (this.mode === "insert" && this.pending) {
      if (this.conflictsOnUniqueKey()) {
        return {
          data: [],
          error: { message: "duplicate key value violates unique constraint" },
          count: 0,
        };
      }
      const created = { ...this.pending };
      this.rows.push(created);
      matched = [created];
    }
    if (this.mode === "upsert" && this.pending) {
      const conflicting = this.uniqueKey.length
        ? this.rows.filter((row) =>
            this.uniqueKey.every((c) => row[c] === this.pending![c]),
          )
        : matched;
      if (conflicting.length > 0) {
        for (const row of conflicting) Object.assign(row, this.pending);
        matched = conflicting;
      } else {
        const created = { ...this.pending };
        this.rows.push(created);
        matched = [created];
      }
    }

    const data =
      this.limitCount === null ? matched : matched.slice(0, this.limitCount);
    return { data, error: null, count: data.length };
  }
  maybeSingle(): Promise<{ data: Row | null; error: Result["error"] }> {
    const result = this.resolve();
    return Promise.resolve({ data: result.data[0] ?? null, error: result.error });
  }
  single(): Promise<{ data: Row | null; error: Result["error"] }> {
    return this.maybeSingle();
  }
  then<TResult1 = Result, TResult2 = never>(
    onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.resolve()).then(onfulfilled, onrejected);
  }
}

export class RoundFakeDatabase {
  tables: Record<string, Row[]> = {
    produce_transactions: [],
    raw_messages: [],
    slip_evidences: [],
    slip_checks: [],
    slip_batches: [],
    manual_slip_sessions: [],
    manual_slip_entries: [],
    settlement_entries: [],
    settlement_finalizations: [],
    digital_white_sheet_cash_entries: [],
    pending_sessions: [],
  };

  seed(table: string, rows: Row[]): this {
    this.tables[table] = [...(this.tables[table] ?? []), ...rows];
    return this;
  }

  /**
   * Register one produce transaction so the market counts as a known produce
   * market for the source/date — the gate every market-scoped loader uses.
   */
  seedKnownMarket(input: {
    sourceId: string;
    businessDate: string;
    marketName: string;
    rawMessageId?: string;
  }): this {
    const rawMessageId = input.rawMessageId ?? `raw-${this.tables.produce_transactions.length + 1}`;
    this.seed("produce_transactions", [
      {
        id: `tx-${this.tables.produce_transactions.length + 1}`,
        raw_message_id: rawMessageId,
        transaction_date: input.businessDate,
        base_transaction_type: "เบิก",
        transaction_type: "เบิก",
        market_name: input.marketName,
        total_amount: 0,
        item_created_at: `${input.businessDate}T04:00:00Z`,
      },
    ]);
    this.seed("raw_messages", [{ id: rawMessageId, source_id: input.sourceId }]);
    return this;
  }

  /** Unique keys the production code relies on for insert-conflict behaviour. */
  uniqueKeys: Record<string, string[]> = {
    settlement_finalizations: ["source_id", "business_date", "accountability_round_id"],
    transfer_reconciliations: ["source_id", "business_date", "accountability_round_id"],
    // The real onConflict target of POST /api/settlement's upsert.
    settlement_entries: [
      "settlement_date",
      "settlement_time",
      "staff_name",
      "market_name",
      "accountability_round_id",
    ],
  };

  from = (table: string) => {
    this.tables[table] ??= [];
    return new QueryBuilder(this.tables[table]!, this.uniqueKeys[table] ?? []);
  };

  /** claim_slip_references (20261103100000): first finalization per reference wins; marks the scope settled. */
  rpc = async (name: string, args: { p_finalization_id: string; p_claims: Row[] }) => {
    if (name !== "claim_slip_references") throw new Error(`unexpected rpc: ${name}`);
    const credits = (this.tables.slip_reference_claims ??= []);
    for (const claim of args.p_claims) {
      if (!credits.some((c) => c.reference_id === claim.reference_id)) credits.push({ ...claim, finalization_id: args.p_finalization_id });
    }
    const finalization = this.tables.settlement_finalizations.find((f) => f.id === args.p_finalization_id);
    if (finalization) finalization.claims_recorded_at ??= new Date().toISOString();
    const refs = new Set(args.p_claims.map((c) => c.reference_id));
    return { data: credits.filter((c) => refs.has(c.reference_id)), error: null };
  };

  asClient(): SupabaseClient {
    return this as unknown as SupabaseClient;
  }
}
