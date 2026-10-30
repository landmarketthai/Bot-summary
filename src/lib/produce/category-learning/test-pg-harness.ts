/**
 * Disposable PostgreSQL 17 harness for category-learning *.pg.test.ts suites.
 * Local hosts only; each suite creates and drops its own database.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const PSQL = existsSync("C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe")
  ? "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe" : "psql";
const PGHOST = process.env.PGHOST ?? "localhost";
const PGUSER = process.env.PGUSER ?? "postgres";
const PGPASSWORD = process.env.PGPASSWORD ?? "postgres";
const PGPORT = process.env.PGPORT ?? "5432";
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const migration = (name: string) => join(ROOT, "supabase", "migrations", `${name}.sql`);
const rollback = (name: string) => join(ROOT, "supabase", "rollback", `${name}.down.sql`);
const NAMES = [
  "20261022120000_produce_category_learning",
  "20261022130000_produce_category_announce_queue",
  "20261023100000_produce_category_delivery_ledger",
  "20261023110000_produce_category_privilege_hardening",
  "20261023120000_produce_category_delivery_exhaustion",
];

export const BOOTSTRAP = join(ROOT, "supabase", "tests", "produce_product_code_dictionary_bootstrap.sql");
/** Release order. */
export const CATEGORY_MIGRATIONS = NAMES.map(migration);
/** Exactly the reverse of the release order. */
export const CATEGORY_ROLLBACKS = [...NAMES].reverse().map(rollback);

/**
 * Supabase's broad default ACL: every new table / function in public is
 * granted to anon, authenticated and service_role unless a migration revokes it.
 */
export const SUPABASE_DEFAULT_ACL = `
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;`;

export type PsqlResult = { code: number; stdout: string; stderr: string };

export function pgHarness(prefix: string) {
  const database = `${prefix}_${randomBytes(4).toString("hex")}`;

  async function psql(args: string[], db = database, stdin?: string): Promise<PsqlResult> {
    const proc = Bun.spawn([PSQL, "-X", ...args], {
      cwd: ROOT,
      stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
      env: { ...process.env, PGHOST, PGUSER, PGPASSWORD, PGPORT, PGDATABASE: db, PGCLIENTENCODING: "UTF8" },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    return { code, stdout, stderr };
  }

  const run = (sql: string, db = database) => psql(["-v", "ON_ERROR_STOP=1", "-qtA", "-f", "-"], db, sql);

  async function scalar(sql: string): Promise<string> {
    const result = await run(sql);
    if (result.code !== 0) throw new Error(`${result.stderr || result.stdout}\nSQL: ${sql}`);
    return result.stdout.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  }

  async function available(): Promise<boolean> {
    if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1" || !ALLOWED_HOSTS.has(PGHOST)) return false;
    const result = await psql(["-tAc", "SHOW server_version_num"], "postgres");
    return result.code === 0 && Number(result.stdout.trim()) >= 140000;
  }

  async function applyFile(file: string, db = database): Promise<void> {
    const result = await psql(["-v", "ON_ERROR_STOP=1", "-f", file], db);
    if (result.code !== 0) throw new Error(`${file}\n${result.stderr}`);
  }

  /** Create the database with the broad Supabase ACL, then every migration in order. */
  async function setup(db = database): Promise<void> {
    const created = await psql(["-d", "postgres", "-c", `CREATE DATABASE ${db}`], "postgres");
    if (created.code !== 0) throw new Error(created.stderr);
    await applyFile(BOOTSTRAP, db);
    const acl = await run(SUPABASE_DEFAULT_ACL, db);
    if (acl.code !== 0) throw new Error(acl.stderr);
    for (const file of CATEGORY_MIGRATIONS) await applyFile(file, db);
  }

  const drop = (db = database) => psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`], "postgres");

  return { database, psql, run, scalar, available, applyFile, setup, drop };
}

/** SQL literal for a JS value (strings, numbers, booleans, null, string arrays). */
export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.length === 0 ? "'{}'::text[]" : `ARRAY[${value.map(sqlLiteral).join(", ")}]::text[]`;
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}
