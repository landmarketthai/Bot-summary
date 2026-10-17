/**
 * Test-only harness: a disposable local PostgreSQL 17 database with the real
 * slip + LINE-queue migrations applied, and a minimal PostgREST-style adapter
 * so production TypeScript (WebhookService, SlipImageIngestionService, the
 * batch finalizer) runs against REAL SQL state. Never imported by app code.
 *
 * Safety: refuses to run unless ALLOW_DISPOSABLE_POSTGRES_TESTS=1, the host is
 * loopback, and the database name matches the throwaway pattern.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const WIN_PSQL = "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe";
const PSQL = existsSync(WIN_PSQL) ? WIN_PSQL : "psql";
export const PGHOST = process.env.PGHOST ?? "localhost";
export const PGUSER = process.env.PGUSER ?? "postgres";
export const PGPASSWORD = process.env.PGPASSWORD ?? "postgres";
export const PGPORT = process.env.PGPORT ?? "5432";
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export const SLIP_PIPELINE_MIGRATIONS = [
  "0001_initial_schema.sql",
  "0019_slip_evidence_ingestion.sql",
  "0020_slip_checks.sql",
  "0021_slip_batches.sql",
  "0022_get_or_create_slip_batch.sql",
  "0023_slip_session_fields.sql",
  "0024_slip_batch_closing.sql",
  "0038_digital_white_sheet_cash_entries.sql",
  "0039_slip_evidence_market_attribution.sql",
  "0043_white_sheet_lifecycle.sql",
  "20260801092255_manual_white_sheet_note_sessions.sql",
  "20260801140442_manual_white_sheet_event_ordering.sql",
  "20260915170100_line_webhook_queue_retryable_completion.sql",
  "20260919134000_line_webhook_semantic_timestamp_order.sql",
  "20260930090000_line_webhook_stale_queue_review.sql",
  "20261017100000_slip_image_ingestion_ledger.sql",
];

const BOOTSTRAP_SQL = `
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS storage.buckets (
  id text PRIMARY KEY, name text, public boolean,
  file_size_limit bigint, allowed_mime_types text[]
);
`;

type PsqlResult = { code: number; stdout: string; stderr: string };

async function psql(args: string[], database: string, input?: string): Promise<PsqlResult> {
  const proc = Bun.spawn([PSQL, "-X", ...args], {
    cwd: ROOT,
    env: { ...process.env, PGHOST, PGUSER, PGPASSWORD, PGPORT, PGDATABASE: database },
    stdin: input === undefined ? undefined : new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

export async function probePg(): Promise<boolean> {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1" || !ALLOWED_HOSTS.has(PGHOST)) return false;
  try {
    const result = await psql(["-tAc", "SHOW server_version_num"], "postgres");
    return result.code === 0 && Number(result.stdout.trim()) >= 170000;
  } catch {
    return false;
  }
}

export interface SlipTestDb {
  name: string;
  sql: Bun.SQL;
  /** Run a statement; returns rows as plain objects. */
  query<T = Record<string, unknown>>(statement: string): Promise<T[]>;
  scalar(statement: string): Promise<string>;
  drop(): Promise<void>;
}

export async function createSlipTestDb(
  prefix: string,
  migrations: string[] = SLIP_PIPELINE_MIGRATIONS,
): Promise<SlipTestDb> {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1") {
    throw new Error("requires ALLOW_DISPOSABLE_POSTGRES_TESTS=1");
  }
  if (!ALLOWED_HOSTS.has(PGHOST)) throw new Error(`refusing PGHOST=${PGHOST}`);
  const name = `${prefix}_${randomBytes(4).toString("hex")}`;
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`refusing database=${name}`);

  const created = await psql(["-d", "postgres", "-c", `CREATE DATABASE ${name}`], "postgres");
  if (created.code !== 0) throw new Error(created.stderr);
  const boot = await psql(["-v", "ON_ERROR_STOP=1", "-c", BOOTSTRAP_SQL], name);
  if (boot.code !== 0) throw new Error(`bootstrap failed: ${boot.stderr}`);
  for (const file of migrations) {
    // Piped through stdin: psql on Windows cannot open non-ASCII file names.
    const result = await psql(
      ["-v", "ON_ERROR_STOP=1", "-f", "-"],
      name,
      await Bun.file(join(ROOT, "supabase", "migrations", file)).text(),
    );
    if (result.code !== 0) throw new Error(`${file}\n${result.stderr}`);
  }

  const sql = new Bun.SQL({
    hostname: PGHOST,
    port: Number(PGPORT),
    username: PGUSER,
    password: PGPASSWORD,
    database: name,
    max: 8,
  });

  return {
    name,
    sql,
    async query<T>(statement: string) {
      return (await sql.unsafe(statement)) as unknown as T[];
    },
    async scalar(statement: string) {
      const rows = (await sql.unsafe(statement)) as unknown as Array<Record<string, unknown>>;
      const first = rows[0];
      if (!first) return "";
      const value = Object.values(first)[0];
      if (value === null || value === undefined) return "";
      return typeof value === "object" ? JSON.stringify(value) : String(value);
    },
    async drop() {
      await sql.close();
      await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${name}`], "postgres");
    },
  };
}

// ── PostgREST-style adapter ───────────────────────────────────────────────────

const lit = (v: unknown): string => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "object") return `'${JSON.stringify(v).replaceAll("'", "''")}'::jsonb`;
  return `'${String(v).replaceAll("'", "''")}'`;
};
const ident = (n: string) => `"${n.replaceAll('"', '""')}"`;

interface PgError { code?: string; message: string }
type Result = { data: unknown; error: PgError | null; count?: number | null };

function toPgError(e: unknown): PgError {
  const err = e as { errno?: string | number; code?: string; message?: string };
  const sqlstate = typeof err.errno === "string" && /^[0-9A-Z]{5}$/.test(err.errno)
    ? err.errno
    : err.code;
  return { code: sqlstate, message: err.message ?? String(e) };
}

class Builder implements PromiseLike<Result> {
  private op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private cols = "*";
  private values: Record<string, unknown> | Record<string, unknown>[] | null = null;
  private onConflict: string | null = null;
  private filters: string[] = [];
  private orders: string[] = [];
  private lim: number | null = null;
  private mode: "many" | "single" | "maybeSingle" = "many";
  private wantCount = false;

  constructor(private readonly db: PgAdapterContext, private readonly table: string) {}

  select(cols = "*", opts?: { count?: string }) {
    if (this.op === "select") this.cols = cols;
    else this.cols = cols;
    this.wantCount = Boolean(opts?.count);
    this.projected = true;
    return this;
  }
  private projected = false;
  insert(v: Record<string, unknown> | Record<string, unknown>[]) { this.op = "insert"; this.values = v; return this; }
  update(v: Record<string, unknown>) { this.op = "update"; this.values = v; return this; }
  upsert(v: Record<string, unknown> | Record<string, unknown>[], o?: { onConflict?: string }) {
    this.op = "upsert"; this.values = v; this.onConflict = o?.onConflict ?? null; return this;
  }
  delete() { this.op = "delete"; return this; }
  eq(c: string, v: unknown) { this.filters.push(`${ident(c)} = ${lit(v)}`); return this; }
  neq(c: string, v: unknown) { this.filters.push(`${ident(c)} <> ${lit(v)}`); return this; }
  lte(c: string, v: unknown) { this.filters.push(`${ident(c)} <= ${lit(v)}`); return this; }
  gte(c: string, v: unknown) { this.filters.push(`${ident(c)} >= ${lit(v)}`); return this; }
  lt(c: string, v: unknown) { this.filters.push(`${ident(c)} < ${lit(v)}`); return this; }
  gt(c: string, v: unknown) { this.filters.push(`${ident(c)} > ${lit(v)}`); return this; }
  is(c: string, v: null | boolean) {
    this.filters.push(`${ident(c)} IS ${v === null ? "NULL" : v ? "TRUE" : "FALSE"}`); return this;
  }
  in(c: string, vs: unknown[]) {
    this.filters.push(vs.length ? `${ident(c)} IN (${vs.map(lit).join(",")})` : "FALSE"); return this;
  }
  order(c: string, o?: { ascending?: boolean }) {
    this.orders.push(`${ident(c)} ${o?.ascending === false ? "DESC" : "ASC"}`); return this;
  }
  limit(n: number) { this.lim = n; return this; }
  single() { this.mode = "single"; return this; }
  maybeSingle() { this.mode = "maybeSingle"; return this; }

  private colList(): string {
    if (this.cols.trim() === "*") return "*";
    return this.cols.split(",").map((c) => ident(c.trim())).join(", ");
  }
  private where(): string { return this.filters.length ? ` WHERE ${this.filters.join(" AND ")}` : ""; }

  private build(): string {
    const t = `public.${ident(this.table)}`;
    const rows = Array.isArray(this.values) ? this.values : this.values ? [this.values] : [];
    if (this.op === "select") {
      const order = this.orders.length ? ` ORDER BY ${this.orders.join(", ")}` : "";
      const limit = this.lim !== null ? ` LIMIT ${this.lim}` : "";
      return `SELECT to_jsonb(q) AS j FROM (SELECT ${this.colList()} FROM ${t}${this.where()}${order}${limit}) q`;
    }
    let stmt: string;
    if (this.op === "insert" || this.op === "upsert") {
      const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      const tuples = rows.map((r) => `(${keys.map((k) => lit(r[k])).join(", ")})`).join(", ");
      stmt = `INSERT INTO ${t} (${keys.map(ident).join(", ")}) VALUES ${tuples}`;
      if (this.op === "upsert" && this.onConflict) {
        const sets = keys.filter((k) => k !== this.onConflict)
          .map((k) => `${ident(k)} = EXCLUDED.${ident(k)}`).join(", ");
        stmt += ` ON CONFLICT (${ident(this.onConflict)}) DO UPDATE SET ${sets}`;
      }
    } else if (this.op === "update") {
      const sets = Object.entries(rows[0] ?? {}).map(([k, v]) => `${ident(k)} = ${lit(v)}`).join(", ");
      stmt = `UPDATE ${t} SET ${sets}${this.where()}`;
    } else {
      stmt = `DELETE FROM ${t}${this.where()}`;
    }
    return `WITH q AS (${stmt} RETURNING *) SELECT to_jsonb(q) AS j FROM q`;
  }

  async run(): Promise<Result> {
    try {
      const raw = (await this.db.sql.unsafe(this.build())) as unknown as Array<{ j: unknown }>;
      let rows = raw.map((r) => (typeof r.j === "string" ? JSON.parse(r.j) : r.j)) as Record<string, unknown>[];
      if (this.op !== "select" && this.cols.trim() !== "*" && this.projected) {
        const keys = this.cols.split(",").map((c) => c.trim());
        rows = rows.map((r) => Object.fromEntries(keys.map((k) => [k, r[k]])));
      }
      const count = this.wantCount ? rows.length : null;
      if (this.mode === "single") {
        if (rows.length !== 1) {
          return { data: null, error: { code: "PGRST116", message: `expected 1 row, got ${rows.length}` }, count };
        }
        return { data: rows[0], error: null, count };
      }
      if (this.mode === "maybeSingle") {
        if (rows.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows" }, count };
        return { data: rows[0] ?? null, error: null, count };
      }
      return { data: rows, error: null, count };
    } catch (e) {
      return { data: null, error: toPgError(e) };
    }
  }

  then<A = Result, B = never>(
    onFulfilled?: ((value: Result) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.run().then(onFulfilled, onRejected);
  }
}

interface PgAdapterContext { sql: Bun.SQL }

export interface FakeStorage {
  /** Paths for which upload() should fail, by exact path. */
  failUpload: Set<string>;
  uploaded: Map<string, Uint8Array>;
}

export function createPgSupabase(db: SlipTestDb, storage: FakeStorage) {
  const ctx: PgAdapterContext = { sql: db.sql };
  const retsetCache = new Map<string, boolean>();
  return {
    from(table: string) { return new Builder(ctx, table); },
    async rpc(name: string, args: Record<string, unknown> = {}): Promise<Result> {
      try {
        if (!retsetCache.has(name)) {
          const rows = (await db.sql.unsafe(
            `SELECT bool_or(proretset) AS s FROM pg_proc WHERE proname = '${name.replaceAll("'", "''")}' AND pronamespace = 'public'::regnamespace`,
          )) as unknown as Array<{ s: boolean | null }>;
          if (rows[0]?.s === null || rows[0]?.s === undefined) {
            return { data: null, error: { code: "42883", message: `function public.${name} does not exist` } };
          }
          retsetCache.set(name, Boolean(rows[0].s));
        }
        const argList = Object.entries(args).map(([k, v]) => `${ident(k)} => ${lit(v)}`).join(", ");
        const isSet = retsetCache.get(name)!;
        const query = isSet
          ? `SELECT to_jsonb(f) AS j FROM public.${ident(name)}(${argList}) f`
          : `SELECT to_jsonb(public.${ident(name)}(${argList})) AS j`;
        const raw = (await db.sql.unsafe(query)) as unknown as Array<{ j: unknown }>;
        const vals = raw.map((r) => (typeof r.j === "string" && /^[\[{]/.test(r.j) ? JSON.parse(r.j) : r.j));
        return { data: isSet ? vals : (vals[0] ?? null), error: null };
      } catch (e) {
        return { data: null, error: toPgError(e) };
      }
    },
    storage: {
      from() {
        return {
          async upload(path: string, bytes: Uint8Array) {
            if (storage.failUpload.has(path)) return { error: { message: "simulated storage failure" } };
            storage.uploaded.set(path, bytes);
            return { error: null };
          },
          async download(path: string) {
            const bytes = storage.uploaded.get(path);
            if (!bytes) return { data: null, error: { message: "not found" } };
            return { data: new Blob([bytes as BlobPart]), error: null };
          },
        };
      },
    },
  };
}
