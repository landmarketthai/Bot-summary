/**
 * Test-only: a disposable local PostgreSQL database with the assistant
 * migration applied, and a minimal `rpc` client so the REAL
 * SupabaseAssistantJobStore runs against real SQL. Never imported by app code.
 *
 * Opt-in like every *.pg.test.ts: ALLOW_DISPOSABLE_POSTGRES_TESTS=1 and a
 * loopback PGHOST (enforced by createSlipTestDb). PostgreSQL 16+ is enough
 * for this migration.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { createSlipTestDb, type SlipTestDb } from "@/lib/slips/testing/pg-slip-harness";

export const ASSISTANT_MIGRATIONS = [
  "20261031090000_ai_assistant_jobs.sql",
  "20261031150000_ai_assistant_access_scope.sql",
  "20261031160000_ai_assistant_queue_hardening.sql",
  "20261031170000_ai_assistant_recovery_scan.sql",
];

export async function createAssistantTestDb(): Promise<SlipTestDb | null> {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1") {
    if (process.env.AI_ASSISTANT_PG_REQUIRE === "1") throw new Error("AI_ASSISTANT_PG_REQUIRE=1 needs ALLOW_DISPOSABLE_POSTGRES_TESTS=1");
    return null;
  }
  try {
    // 0001 defines raw_messages (present in every real environment), which the
    // recovery-scan function of 20261031170000 reads.
    return await createSlipTestDb("ai_assistant", ["0001_initial_schema.sql", ...ASSISTANT_MIGRATIONS]);
  } catch (error) {
    if (process.env.AI_ASSISTANT_PG_REQUIRE === "1") throw error;
    return null;
  }
}

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

function literal(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.length === 0 ? "'{}'::text[]" : `ARRAY[${value.map((item) => quote(item)).join(", ")}]::text[]`;
  }
  if (typeof value === "object") return `${quote(JSON.stringify(value))}::jsonb`;
  return quote(String(value));
}

/** Supabase-shaped client exposing only `rpc`, which is all the job store uses. */
export function assistantRpcClient(db: SlipTestDb): SupabaseClient<Database> {
  const setReturning = new Map<string, boolean>();
  const client = {
    async rpc(name: string, args: Record<string, unknown> = {}) {
      try {
        if (!/^[a-z_]+$/.test(name)) throw new Error(`refusing rpc ${name}`);
        if (!setReturning.has(name)) {
          const rows = await db.query<{ s: boolean | null }>(
            `SELECT bool_or(proretset) AS s FROM pg_proc WHERE proname = ${quote(name)} AND pronamespace = 'public'::regnamespace`,
          );
          if (rows[0]?.s === null || rows[0]?.s === undefined) {
            return { data: null, error: { code: "42883", message: `function public.${name} does not exist` } };
          }
          setReturning.set(name, Boolean(rows[0].s));
        }
        const argList = Object.entries(args).map(([key, value]) => `"${key}" => ${literal(value)}`).join(", ");
        const isSet = setReturning.get(name)!;
        const statement = isSet
          ? `SELECT to_jsonb(f) AS j FROM public."${name}"(${argList}) f`
          : `SELECT to_jsonb(public."${name}"(${argList})) AS j`;
        const rows = await db.query<{ j: unknown }>(statement);
        const values = rows.map((row) => (typeof row.j === "string" && /^[\[{]/.test(row.j) ? JSON.parse(row.j) : row.j));
        return { data: isSet ? values : (values[0] ?? null), error: null };
      } catch (error) {
        const err = error as { errno?: string; code?: string; message?: string };
        return { data: null, error: { code: err.errno ?? err.code, message: err.message ?? String(error) } };
      }
    },
  };
  return client as unknown as SupabaseClient<Database>;
}
