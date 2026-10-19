/**
 * Isolated PostgreSQL race test for global slip transaction/image admission.
 * Creates its own temporary database; NEVER connects to production by default.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..");
const migration = join(root, "supabase", "migrations", "20261019143000_guard_global_slip_transaction_reference.sql");
const psql = existsSync("C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe")
  ? "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe" : "psql";
const env = {
  ...process.env,
  PGHOST: process.env.PGHOST ?? "localhost",
  PGPORT: process.env.PGPORT ?? "5432",
  PGUSER: process.env.PGUSER ?? "postgres",
  PGPASSWORD: process.env.PGPASSWORD ?? "postgres",
  PGCLIENTENCODING: "UTF8",
};
async function pg(args: string[], db = "postgres") {
  const child = Bun.spawn([psql, "-X", "-q", "-v", "ON_ERROR_STOP=1", ...args], {
    cwd: root, env: {...env, PGDATABASE: db}, stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {out: out.trim(), err: err.trim(), code};
}
const probe = await pg(["-tAc", "SELECT 1"]).catch(() => ({out:"",err:"postgres unavailable",code:1}));
if (probe.code !== 0 && process.env.REQUIRE_SLIP_GLOBAL_PG === "1") {
  throw new Error("REQUIRE_SLIP_GLOBAL_PG=1 but isolated PostgreSQL is unavailable");
}

describe.skipIf(probe.code !== 0)("global slip transaction atomicity", () => {
  const db = "slipglobal_" + randomBytes(4).toString("hex");
  let created = false;
  async function exec(sql: string) {
    const r = await pg(["-tAc", sql], db);
    if (r.code !== 0) throw new Error(r.err);
    return r.out;
  }

  test("migration idempotence; missing IDs, cross-market ID collisions, identical files and concurrent writers", async () => {
    const create = await pg(["-c", "CREATE DATABASE " + db]);
    expect(create.code, create.err).toBe(0);
    created = true;
    await exec(`
      CREATE TABLE public.slip_evidences (
        id uuid PRIMARY KEY, sha256 text NOT NULL
      );
      CREATE TABLE public.slip_checks (
        id uuid PRIMARY KEY, evidence_id uuid REFERENCES public.slip_evidences(id),
        status text NOT NULL, reference_id text, failure_reason text,
        slip_type text NOT NULL DEFAULT 'BANK_SLIP_QR',
        transaction_time timestamptz DEFAULT '2026-10-19 09:00:00+07',
        transfer_amount numeric DEFAULT 100, gross_amount numeric,
        paid_amount numeric, discount_amount numeric
      );
    `);
    for (let i = 1; i <= 9; i++) {
      await exec(`INSERT INTO public.slip_evidences (id,sha256) VALUES
        ('10000000-0000-4000-8000-${String(i).padStart(12,"0")}',
        '${String(i).repeat(64)}')`);
    }
    for (let n = 0; n < 2; n++) {
      const apply = await pg(["-f", migration], db);
      expect(apply.code, apply.err).toBe(0);
    }

    const mk = (i: number, ref: string | null) => `INSERT INTO public.slip_checks
      (id,evidence_id,status,reference_id) VALUES (
        '20000000-0000-4000-8000-${String(i).padStart(12,"0")}',
        '10000000-0000-4000-8000-${String(i).padStart(12,"0")}',
        'EXTRACTED', ${ref === null ? "NULL" : "'" + ref + "'"}
      )`;
    // Concurrent clients, not an in-memory/mock race.
    const both = await Promise.all([
      pg(["-tAc", mk(1,"REF-CONCURRENT")],db),
      pg(["-tAc", mk(2,"REF-CONCURRENT")],db),
    ]);
    expect(both.every(x => x.code === 0), JSON.stringify(both)).toBe(true);
    expect(await exec(`SELECT count(*) FROM public.slip_checks WHERE reference_id='REF-CONCURRENT' AND status='EXTRACTED'`)).toBe("1");
    expect(await exec(`SELECT count(*) FROM public.slip_checks WHERE reference_id='REF-CONCURRENT' AND status='NEED_REVIEW'`)).toBe("1");

    await exec(mk(3, null));
    expect(await exec(`SELECT status || ':' || failure_reason FROM public.slip_checks WHERE id='20000000-0000-4000-8000-000000000003'`))
      .toBe("NEED_REVIEW:missing_transaction_reference_global");

    // Same image hash but a different reference: must not auto-count twice.
    await exec(`UPDATE public.slip_evidences SET sha256=repeat('4',64) WHERE id='10000000-0000-4000-8000-000000000005'`);
    await exec(mk(4,"REF-IMAGE-1"));
    await exec(mk(5,"REF-IMAGE-2"));
    expect(await exec(`SELECT status || ':' || failure_reason FROM public.slip_checks WHERE id='20000000-0000-4000-8000-000000000005'`))
      .toBe("NEED_REVIEW:duplicate_image_sha256_global");

    // Visually similar SHA-distinct images at the same time and amount => review.
    await exec(`UPDATE public.slip_evidences SET visual_hash_full='0123456789abcdef', visual_hash_center='fedcba9876543210' WHERE id='10000000-0000-4000-8000-000000000006'`);
    await exec(`UPDATE public.slip_evidences SET visual_hash_full='0123456789abcdee', visual_hash_center='fedcba9876543211' WHERE id='10000000-0000-4000-8000-000000000007'`);
    await exec(mk(6,'REF-VISUAL-1'));
    await exec(mk(7,'REF-VISUAL-2'));
    expect(await exec(`SELECT status || ':' || failure_reason FROM public.slip_checks WHERE id='20000000-0000-4000-8000-000000000007'`))
      .toBe('NEED_REVIEW:possible_near_duplicate_image_global');

    // Same-looking receipts but DIFFERENT amount or transaction time must not be auto-flagged.
    await exec(`UPDATE public.slip_evidences SET visual_hash_full='0123456789abcdee' WHERE id='10000000-0000-4000-8000-000000000008'`);
    await exec(`INSERT INTO public.slip_checks(id,evidence_id,status,reference_id,transfer_amount)
      VALUES('20000000-0000-4000-8000-000000000008','10000000-0000-4000-8000-000000000008','EXTRACTED','REF-DIFFERENT-AMOUNT',250)`);
    expect(await exec(`SELECT status FROM public.slip_checks WHERE id='20000000-0000-4000-8000-000000000008'`)).toBe('EXTRACTED');
    await exec(`UPDATE public.slip_evidences SET visual_hash_center='fedcba9876543211' WHERE id='10000000-0000-4000-8000-000000000009'`);
    await exec(`INSERT INTO public.slip_checks(id,evidence_id,status,reference_id,transaction_time)
      VALUES('20000000-0000-4000-8000-000000000009','10000000-0000-4000-8000-000000000009','EXTRACTED','REF-DIFFERENT-TIME','2026-10-19 10:00:00+07')`);
    expect(await exec(`SELECT status FROM public.slip_checks WHERE id='20000000-0000-4000-8000-000000000009'`)).toBe('EXTRACTED');

    // Re-admitting the SAME record must not be considered a separate payment.
    await exec(`UPDATE public.slip_checks SET status='EXTRACTED' WHERE id='20000000-0000-4000-8000-000000000004'`);
    expect(await exec(`SELECT status FROM public.slip_checks WHERE id='20000000-0000-4000-8000-000000000004'`))
      .toBe("EXTRACTED");
  });

  afterAll(async () => {
    if (created) {
      const dropped = await pg(["-c", "DROP DATABASE IF EXISTS " + db + " WITH (FORCE)"]);
      expect(dropped.code, dropped.err).toBe(0);
    }
  });
});
