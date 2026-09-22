import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

/**
 * Minimal in-memory fake of the exact Supabase query shapes evidence-service.ts
 * and draft-service.ts use against settlement_sheet_drafts / raw_messages.
 * Not a general PostgREST simulator — only eq/neq/order/limit/select/single/
 * maybeSingle/update, because that is all these two modules call.
 */
export function createFakeSettlementSheetClient(options: {
  storageError?: string;
  download?: { bytes: Uint8Array } | { error: string };
} = {}) {
  const drafts: Record<string, unknown>[] = [];
  const rawUpdates: Record<string, unknown>[] = [];
  const uploads: Array<{ bucket: string; path: string; bytes: number[]; contentType?: string }> = [];
  let nextId = 1;

  type Filter = ["eq" | "neq", string, unknown];

  function matches(row: Record<string, unknown>, filters: Filter[]): boolean {
    return filters.every(([kind, col, val]) => (kind === "eq" ? row[col] === val : row[col] !== val));
  }

  function selectBuilder(filters: Filter[]) {
    let orderCol: string | null = null;
    let ascending = true;
    let limitN: number | null = null;
    const builder = {
      eq(col: string, val: unknown) {
        filters.push(["eq", col, val]);
        return builder;
      },
      neq(col: string, val: unknown) {
        filters.push(["neq", col, val]);
        return builder;
      },
      order(col: string, opts: { ascending: boolean }) {
        orderCol = col;
        ascending = opts.ascending;
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      async maybeSingle() {
        let results = drafts.filter((row) => matches(row, filters));
        if (orderCol) {
          const col = orderCol;
          results = [...results].sort((a, b) => {
            const av = a[col] as string, bv = b[col] as string;
            return ascending ? (av < bv ? -1 : av > bv ? 1 : 0) : (av > bv ? -1 : av < bv ? 1 : 0);
          });
        }
        if (limitN !== null) results = results.slice(0, limitN);
        return { data: results[0] ?? null, error: null };
      },
      async single() {
        const results = drafts.filter((row) => matches(row, filters));
        return results[0]
          ? { data: results[0], error: null }
          : { data: null, error: { message: "not found" } };
      },
    };
    return builder;
  }

  function updateBuilder(patch: Record<string, unknown>) {
    return {
      eq(col: string, val: unknown) {
        const row = drafts.find((r) => r[col] === val);
        if (row) Object.assign(row, patch);
        const result = { data: row ?? null, error: row ? null : { message: "not found" } };
        return {
          then(resolve: (value: typeof result) => void) {
            resolve(result);
          },
          select() {
            return { async single() { return result; } };
          },
        };
      },
    };
  }

  const client = {
    storage: {
      from(bucket: string) {
        return {
          async upload(path: string, body: Uint8Array, opts: { contentType?: string }) {
            uploads.push({ bucket, path, bytes: Array.from(body), contentType: opts.contentType });
            return { data: null, error: options.storageError ? { message: options.storageError } : null };
          },
          async download() {
            if (options.download && "error" in options.download) {
              return { data: null, error: { message: options.download.error } };
            }
            const bytes = options.download && "bytes" in options.download
              ? options.download.bytes
              : new Uint8Array([1, 2, 3]);
            return {
              data: { arrayBuffer: async () => bytes.buffer.slice(0) },
              error: null,
            };
          },
        };
      },
    },
    from(table: string) {
      if (table === "settlement_sheet_drafts") {
        return {
          insert(row: Record<string, unknown>) {
            const lineMessageId = row.line_message_id;
            if (drafts.some((r) => r.line_message_id === lineMessageId)) {
              return {
                select() {
                  return {
                    async single() {
                      return { data: null, error: { code: "23505", message: "duplicate key" } };
                    },
                  };
                },
              };
            }
            const stored = { id: `draft-${nextId++}`, ...row };
            drafts.push(stored);
            return {
              select() {
                return { async single() { return { data: stored, error: null }; } };
              },
            };
          },
          select() {
            return selectBuilder([]);
          },
          update(patch: Record<string, unknown>) {
            return updateBuilder(patch);
          },
        };
      }
      if (table === "raw_messages") {
        return {
          update(values: Record<string, unknown>) {
            rawUpdates.push(values);
            return { async eq() { return { error: null }; } };
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient<Database>;

  return { client, drafts, rawUpdates, uploads };
}
