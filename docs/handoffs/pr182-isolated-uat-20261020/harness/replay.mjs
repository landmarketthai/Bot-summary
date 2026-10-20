// Evidence-backed isolated replay (phase order from commit 87b7c46,
// docs/staging-baseline-recovery-20261009.md). Fixtures are read byte-exact
// from Git; migrations from the PR #182 worktree (CRLF -> LF as Git stores).
// Target: fresh local DB botsummary_baseline_replay_20261009c only.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = "C:/GitHub/_worktrees/bot-summary-p0-slip-ingest-20261017";
const DB = "botsummary_baseline_replay_20261009c";
const PSQL = "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe";
const env = { ...process.env, PGHOST: "127.0.0.1", PGPORT: "54322", PGUSER: "postgres", PGPASSWORD: "postgres" };
const git = (spec) => execFileSync("git", ["-C", REPO, "show", spec], { encoding: "utf8", maxBuffer: 64 << 20 });
const sha = (s) => createHash("sha256").update(s).digest("hex");
const FIX = "87b7c46";
const BASELINE = { commit: "48450f00bba1d371b6af210a80fa804e0435d077", path: "supabase/migrations/0042_pending_close_ingest.sql", blob: "e55e853e055d95df5c9834ab6a58a6a28d84229e" };

const blob = execFileSync("git", ["-C", REPO, "rev-parse", `${BASELINE.commit}:${BASELINE.path}`], { encoding: "utf8" }).trim();
if (blob !== BASELINE.blob) throw new Error(`baseline blob mismatch ${blob}`);

const phases = [{ path: "fixture:staging_platform_prerequisites.sql", sql: git(`${FIX}:supabase/tests/staging_platform_prerequisites.sql`) }];
const files = readdirSync(join(REPO, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
for (const f of files) {
  if (f === "0031_pending_session_sender_identity.sql") {
    phases.push({ path: `history:${BASELINE.commit.slice(0, 7)}:0042_pending_close_ingest.sql`, sql: git(`${BASELINE.commit}:${BASELINE.path}`) });
    phases.push({ path: "test-only-ledger-rls", sql: "ALTER TABLE public.pending_session_ingest ENABLE ROW LEVEL SECURITY;\nALTER TABLE public.pending_session_admission ENABLE ROW LEVEL SECURITY;\n" });
  }
  if (f === "20260809045849_p2e_accountability_round_identity_contract.sql") {
    phases.push({ path: "fixture:staging_p2e_legacy_unique_name.sql", sql: git(`${FIX}:supabase/tests/staging_p2e_legacy_unique_name.sql`) });
  }
  phases.push({ path: `migration:${f}`, sql: readFileSync(join(REPO, "supabase/migrations", f), "utf8").replace(/\r\n/g, "\n") });
}

const mode = process.argv[2];
if (mode === "create") {
  const r = spawnSync(PSQL, ["-X", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE ${DB} TEMPLATE template0`], { env, encoding: "utf8" });
  process.stdout.write(r.stdout + r.stderr); process.exit(r.status);
}
if (mode === "run") {
  const manifest = [];
  for (const [i, p] of phases.entries()) {
    const r = spawnSync(PSQL, ["-X", "-q", "-d", DB, "-v", "ON_ERROR_STOP=1", "-f", "-"], { env, input: Buffer.from(p.sql, "utf8"), encoding: "utf8" });
    manifest.push({ i: i + 1, path: p.path, sha256: sha(p.sql), ok: r.status === 0 });
    if (r.status !== 0) {
      writeFileSync(new URL("./replay-manifest.json", import.meta.url), JSON.stringify(manifest, null, 1));
      console.log(`FAIL phase ${i + 1}/${phases.length} ${p.path}\n${(r.stderr || r.stdout).split("\n").filter((l) => /ERROR|DETAIL|CONTEXT|HINT/.test(l)).slice(0, 6).join("\n")}`);
      process.exit(1);
    }
  }
  writeFileSync(new URL("./replay-manifest.json", import.meta.url), JSON.stringify(manifest, null, 1));
  console.log(`OK ${phases.length}/${phases.length} phases; bundle sha256=${sha(phases.map((p) => p.sql).join("\n"))}`);
}
if (mode === "verify") {
  const r = spawnSync(PSQL, ["-X", "-q", "-d", DB, "-v", "ON_ERROR_STOP=1", "-f", "-"], { env, input: Buffer.from(git(`${FIX}:supabase/tests/staging_baseline_verification.sql`), "utf8"), encoding: "utf8" });
  console.log(r.status === 0 ? "VERIFY OK" : `VERIFY FAIL\n${(r.stderr || r.stdout).split("\n").filter((l) => /ERROR|DETAIL|CONTEXT/.test(l)).slice(0, 6).join("\n")}`);
}
if (mode === "list") console.log(phases.map((p, i) => `${i + 1} ${p.path}`).join("\n"));
