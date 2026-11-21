/**
 * Minimal in-memory PostgREST stand-in for category-learning tests: select,
 * eq / gt / gte / lte, multi-column order, limit / range, update, rpc. Plain
 * code-point ordering is used for both ORDER BY and gt, as one collation is in
 * PostgreSQL. `failOn` simulates a failing request by call number.
 */
type Row = Record<string, unknown>;

export interface FakeDb {
  client: unknown;
  tables: Record<string, Row[]>;
  /** Every from() request: table + filters, in order. */
  requests: { table: string; filters: string[] }[];
}

export function fakeDb(
  tables: Record<string, Row[]>,
  options: { failOn?: (requestIndex: number, table: string) => boolean } = {},
): FakeDb {
  const requests: FakeDb["requests"] = [];
  const value = (_table: string, row: Row, column: string) => row[column];
  const cmp = (a: unknown, b: unknown) => (a === b ? 0 : (a as never) < (b as never) ? -1 : 1);

  const from = (table: string) => {
    const filters: ((row: Row) => boolean)[] = [];
    const described: string[] = [];
    const orders: [string, boolean][] = [];
    let offset = 0;
    let limit = Number.POSITIVE_INFINITY;
    let patch: Row | null = null;
    const index = requests.length;
    requests.push({ table, filters: described });
    const add = (label: string, test: (row: Row) => boolean) => { described.push(label); filters.push(test); };
    const exec = () => {
      if (options.failOn?.(index, table)) return { data: null, error: { message: `injected failure on request ${index}` } };
      const rows = (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
      if (patch) {
        for (const row of rows) Object.assign(row, patch);
        return { data: null, error: null };
      }
      const sorted = [...rows].sort((a, b) => {
        for (const [column, ascending] of orders) {
          const c = cmp(value(table, a, column), value(table, b, column));
          if (c) return ascending ? c : -c;
        }
        return 0;
      });
      return { data: sorted.slice(offset, offset + limit).map((r) => ({ ...r })), error: null };
    };
    const query = {
      select: () => query,
      update: (p: Row) => { patch = p; return query; },
      eq: (c: string, v: unknown) => { add(`${c}=${String(v)}`, (r) => value(table, r, c) === v); return query; },
      gt: (c: string, v: unknown) => { add(`${c}>${String(v)}`, (r) => cmp(value(table, r, c), v) > 0); return query; },
      gte: (c: string, v: unknown) => { add(`${c}>=${String(v)}`, (r) => cmp(value(table, r, c), v) >= 0); return query; },
      lte: (c: string, v: unknown) => { add(`${c}<=${String(v)}`, (r) => cmp(value(table, r, c), v) <= 0); return query; },
      order: (c: string, o: { ascending?: boolean } = {}) => { orders.push([c, o.ascending ?? true]); return query; },
      limit: (n: number) => { limit = n; return query; },
      range: (a: number, b: number) => { offset = a; limit = b - a + 1; return query; },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve().then(exec).then(resolve, reject),
    };
    return query;
  };

  return { client: { from, rpc: async () => ({ data: null, error: null }) }, tables, requests };
}
