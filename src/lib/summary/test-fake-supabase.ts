/**
 * A small in-memory PostgREST for read-only report tests.
 *
 * Not a test file itself — shared by the purchase-planning service and webhook
 * command tests so neither has to grow its own copy.
 *
 * Two deliberate simplifications, both safe because production code re-checks
 * them:
 *   - `.or(...)` is a pass-through. Every `.or()` in the produce failure scan is
 *     documented as a SUPERSET prefilter whose authority is a client-side check,
 *     so returning more rows than PostgREST would cannot change a verdict.
 *   - an unseeded table returns no rows rather than throwing, because the
 *     webhook path touches operational tables these reports never read.
 */

export type Row = Record<string, unknown>;
type QueryMode = "select" | "insert" | "update" | "upsert" | "delete";

export class FakeQuery {
  private readonly filters: Array<(row: Row) => boolean> = [];
  private maxRows: number | null = null;
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  private returning = false;

  constructor(
    private readonly db: FakeDatabase,
    private readonly table: string,
    private readonly mode: QueryMode,
    private readonly payload?: Row | Row[],
  ) {}

  select(): this {
    this.returning = true;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  is(column: string, value: unknown): this {
    this.filters.push((row) => (row[column] ?? null) === value);
    return this;
  }

  not(column: string, operator: string, value: unknown): this {
    if (operator === "is") {
      this.filters.push((row) => (row[column] ?? null) !== value);
      return this;
    }
    this.filters.push((row) => row[column] !== value);
    return this;
  }

  in(column: string, values: unknown[]): this {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }

  ilike(column: string, pattern: string): this {
    const needle = pattern.replace(/[%*]/g, "").toLowerCase();
    this.filters.push((row) => String(row[column] ?? "").toLowerCase().includes(needle));
    return this;
  }

  /** Superset prefilter in production; a pass-through here. See the file header. */
  or(): this {
    return this;
  }

  gte(column: string, value: unknown): this {
    this.filters.push((row) => String(row[column]) >= String(value));
    return this;
  }

  lte(column: string, value: unknown): this {
    this.filters.push((row) => String(row[column]) <= String(value));
    return this;
  }

  lt(column: string, value: unknown): this {
    this.filters.push((row) => String(row[column]) < String(value));
    return this;
  }

  order(): this {
    return this;
  }

  limit(count: number): this {
    this.maxRows = count;
    return this;
  }

  range(from: number, to: number): this {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }

  async single() {
    const result = this.execute();
    return {
      data: Array.isArray(result.data) ? result.data[0] ?? null : result.data,
      error: result.error,
    };
  }

  async maybeSingle() {
    return this.single();
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: {
      data: Row[] | Row | null;
      error: null;
      count: number | null;
    }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }

  private execute(): { data: Row[] | Row | null; error: null; count: number | null } {
    const rows = this.db.rows(this.table);
    const matches = () => rows.filter((row) => this.filters.every((filter) => filter(row)));

    if (this.mode === "select") {
      const matched = matches();
      let selected = matched;
      if (this.rangeFrom !== null && this.rangeTo !== null) {
        selected = matched.slice(this.rangeFrom, this.rangeTo + 1);
      }
      if (this.maxRows !== null) selected = selected.slice(0, this.maxRows);
      return { data: selected, error: null, count: matched.length };
    }

    if (this.mode === "insert" || this.mode === "upsert") {
      const payloads = Array.isArray(this.payload) ? this.payload : [this.payload ?? {}];
      const inserted = payloads.map((payload) => this.db.insert(this.table, payload, this.mode));
      return { data: this.returning ? inserted : null, error: null, count: null };
    }

    if (this.mode === "update") {
      const updated = matches();
      this.db.noteWrite(this.table);
      for (const row of updated) Object.assign(row, this.payload);
      return { data: this.returning ? updated : null, error: null, count: null };
    }

    const removed = matches();
    this.db.remove(this.table, new Set(removed));
    return { data: this.returning ? removed : null, error: null, count: null };
  }
}

export class FakeDatabase {
  private readonly tables = new Map<string, Row[]>();
  /** Writes to pending_sessions — a read-only report must cause none. */
  appendCalls = 0;

  seed(table: string, rows: Row[]): this {
    this.tables.set(table, rows.map((row) => ({ ...row })));
    return this;
  }

  rows(table: string): Row[] {
    const existing = this.tables.get(table);
    if (existing) return existing;
    const created: Row[] = [];
    this.tables.set(table, created);
    return created;
  }

  noteWrite(table: string): void {
    if (table === "pending_sessions") this.appendCalls += 1;
  }

  insert(table: string, payload: Row, mode: QueryMode): Row {
    const rows = this.rows(table);
    if (table === "pending_sessions") this.appendCalls += 1;
    if (mode === "upsert" && table === "pending_sessions") {
      const existing = rows.find((row) => row.session_key === payload.session_key);
      if (existing) {
        Object.assign(existing, payload);
        return existing;
      }
    }
    const row = { ...payload };
    if (table === "raw_messages") {
      row.id = row.id ?? `raw-${rows.length + 1}`;
      row.created_at = row.created_at ?? new Date().toISOString();
    }
    rows.push(row);
    return row;
  }

  remove(table: string, doomed: Set<Row>): void {
    const rows = this.rows(table);
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (doomed.has(rows[index]!)) rows.splice(index, 1);
    }
  }

  from(table: string) {
    return {
      select: () => new FakeQuery(this, table, "select").select(),
      insert: (payload: Row | Row[]) => new FakeQuery(this, table, "insert", payload),
      upsert: (payload: Row | Row[]) => new FakeQuery(this, table, "upsert", payload),
      update: (payload: Row) => new FakeQuery(this, table, "update", payload),
      delete: () => new FakeQuery(this, table, "delete"),
    };
  }

  /** Names of every RPC the code under test attempted, in order. */
  readonly rpcCalls: string[] = [];

  rpc(name: string, args?: Row) {
    this.rpcCalls.push(name);
    if (name === "receive_line_webhook_event") {
      const row = this.insert("raw_messages", {
        line_event_id: args?.p_line_event_id,
        source_id: args?.p_source_id,
        raw_text: args?.p_raw_text,
      }, "insert");
      return Promise.resolve({
        data: { raw_message_id: row.id, duplicate: false },
        error: null,
      });
    }
    throw new Error(`unexpected rpc: ${name}`);
  }
}
