import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const ROOT = join(import.meta.dir, "..", "..", "..");
const WIN_PSQL = "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe";
const PSQL = existsSync(WIN_PSQL) ? WIN_PSQL : "psql";
const PGHOST = process.env.PGHOST ?? "localhost";
const PGUSER = process.env.PGUSER ?? "postgres";
const PGPASSWORD = process.env.PGPASSWORD ?? "postgres";
const PGPORT = process.env.PGPORT ?? "5432";
const DATABASE = `mslip_atomic_${randomBytes(4).toString("hex")}`;
const SAFE_DB = /^mslip_atomic_[a-f0-9]{8}$/;
const SAFE_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
if (process.env.GITHUB_ACTIONS === "true" && process.env.PGHOST) SAFE_HOSTS.add(process.env.PGHOST);

const BASE = join(ROOT, "supabase", "migrations", "0027_manual_slip_session.sql");
const MIGRATION = join(ROOT, "supabase", "migrations", "20260908180000_manual_slip_atomic_append_close.sql");

async function run(args: string[], database = DATABASE) {
  const proc = Bun.spawn([PSQL, "-X", ...args], {
    cwd: ROOT,
    env: { ...process.env, PGHOST, PGUSER, PGPASSWORD, PGPORT, PGDATABASE: database },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

async function scalar(sql: string): Promise<string> {
  const result = await run(["-v", "ON_ERROR_STOP=1", "-tAc", sql]);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

async function apply(file: string): Promise<void> {
  const result = await run(["-v", "ON_ERROR_STOP=1", "-f", file]);
  expect(result.code, `${file}\n${result.stderr}\n${result.stdout}`).toBe(0);
}

async function probe(): Promise<boolean> {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1" || !SAFE_HOSTS.has(PGHOST)) return false;
  try {
    const result = await run(["-tAc", "SHOW server_version_num"], "postgres");
    return result.code === 0 && Number(result.stdout.trim()) >= 170000;
  } catch {
    return false;
  }
}

const pgAvailable = await probe();
let created = false;

describe.skipIf(!pgAvailable)("manual slip atomic append/close migration", () => {
  beforeAll(async () => {
    if (!SAFE_DB.test(DATABASE)) throw new Error(`unsafe disposable DB name: ${DATABASE}`);
    const create = await run(["-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE ${DATABASE}`], "postgres");
    expect(create.code, create.stderr).toBe(0);
    created = true;
    await apply(BASE);
    await apply(MIGRATION);
  }, 60_000);

  afterAll(async () => {
    if (!created || !SAFE_DB.test(DATABASE)) return;
    await run(["-c", `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DATABASE}'`], "postgres");
    await run(["-c", `DROP DATABASE ${DATABASE}`], "postgres");
  }, 30_000);

  test("closed session rejects late entries and preserves the close total", async () => {
    const id = "81000000-0000-4000-8000-000000000001";
    await scalar(`INSERT INTO manual_slip_sessions(id,source_id,business_date,status)
      VALUES ('${id}','G-audit','2026-09-07','open') RETURNING id`);

    const appended = await scalar(`SELECT public.append_manual_slip_entries_atomic(
      '${id}'::uuid, '[{"raw_line":"100","amount":100}]'::jsonb, 'msg-1', 'u-1')::text`);
    expect(appended).toContain('"inserted": 1');

    const closed = await scalar(`SELECT public.close_manual_slip_session_atomic(
      '${id}'::uuid, 'u-close', 'msg-close')::text`);
    expect(closed).toContain('"total": 100.00');
    expect(closed).toContain('"already_closed": false');

    const late = await run(["-v", "ON_ERROR_STOP=1", "-c", `
      INSERT INTO public.manual_slip_entries(
        session_id, sequence_no, raw_line, amount, line_message_id, line_user_id
      ) VALUES (
        '${id}'::uuid, 1, '50', 50.00, 'msg-late', 'u-late'
      );
    `]);
    expect(late.code).not.toBe(0);
    expect(late.stderr).toContain("manual_slip_session_not_open");

    const total = await scalar(`SELECT coalesce(sum(amount),0)::text
      FROM public.manual_slip_entries WHERE session_id='${id}'::uuid`);
    expect(total).toBe("100.00");
  });
});
