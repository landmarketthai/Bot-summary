// Offline by default; --run is exclusively for the authorized local host coordinator.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, '.tmp-staging-uat-20261009', 'baseline');
export const databases = ['botsummary_compose_uat_20261009', 'botsummary_baseline_replay_20261009'];
const read = name => readFileSync(join(root, name), 'utf8');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function historicalBaseline() {
  const path = 'supabase/tests/staging_missing_baseline.sql';
  const bytes = readFileSync(join(root, path));
  const marker = Buffer.from('-- BEGIN VERBATIM HISTORICAL PAYLOAD\n');
  assert.ok(bytes.indexOf(marker) >= 0, 'Missing historical payload marker');
  const payload = bytes.subarray(bytes.indexOf(marker) + marker.length);
  const blob = createHash('sha1').update(`blob ${payload.length}\0`).update(payload).digest('hex');
  assert.equal(blob, 'e55e853e055d95df5c9834ab6a58a6a28d84229e', 'Historical SQL differs from committed source');
  return { path, sql: bytes.toString('utf8') };
}

export function migrationPlan() {
  const manifest = JSON.parse(read('supabase/tests/staging_migration_manifest.json'));
  assert.equal(manifest.length, 130, 'Expected exactly the reviewed 130 migrations');
  assert.deepEqual(manifest.map(row => row.name),
    readdirSync(join(root, 'supabase/migrations')).filter(name => name.endsWith('.sql')).sort(),
    'Migration names/order changed; review and repin the manifest');
  return manifest.map(row => {
    const path = `supabase/migrations/${row.name}`;
    const bytes = readFileSync(join(root, path));
    // Hash/replay committed LF content, independent of Windows core.autocrlf.
    const sql = bytes.toString('utf8').replaceAll('\r\n', '\n');
    assert.equal(sha256(sql), row.sha256, `Migration mismatch: ${row.name}`);
    return { path, sql, sha256: row.sha256 };
  });
}

export function buildReplay(database) {
  assert.ok(databases.includes(database), 'Only named synthetic local databases permitted');
  const guard = `DO $$
BEGIN
  IF current_database() <> '${database}' OR current_user <> 'postgres'
     OR current_setting('server_version_num')::int < 170000
     OR current_setting('server_version_num')::int >= 180000 THEN
    RAISE EXCEPTION 'Wrong database/owner/PG version; require named disposable PG17';
  END IF;
  IF EXISTS (SELECT FROM pg_namespace WHERE nspname IN ('auth', 'storage', 'extensions'))
     OR EXISTS (SELECT FROM pg_class WHERE relnamespace = 'public'::regnamespace)
     OR EXISTS (SELECT FROM pg_proc WHERE pronamespace = 'public'::regnamespace)
     OR EXISTS (SELECT FROM pg_type WHERE typnamespace = 'public'::regnamespace)
     OR EXISTS (SELECT FROM pg_default_acl) THEN
    RAISE EXCEPTION 'Database is not fresh; never reset or resume a partial replay';
  END IF;
END $$;\n`;
  const fixture = path => ({ path, sql: read(path), sha256: sha256(readFileSync(join(root, path))) });
  const phases = [fixture('supabase/tests/staging_platform_prerequisites.sql')];
  for (const migration of migrationPlan()) {
    if (migration.path.endsWith('/0031_pending_session_sender_identity.sql')) {
      phases.push(historicalBaseline());
      // Committed test precedent: produce_0050_verification.sql:114-117.
      // Separate from the byte-exact historical payload; never disable RLS.
      phases.push({ path: 'test-only-ledger-rls', sql:
        'ALTER TABLE public.pending_session_ingest ENABLE ROW LEVEL SECURITY;\n' +
        'ALTER TABLE public.pending_session_admission ENABLE ROW LEVEL SECURITY;\n' });
    }
    phases.push(migration);
  }
  phases.push(fixture('supabase/tests/staging_baseline_verification.sql'));
  let sql = '\\set ON_ERROR_STOP on\n\\set VERBOSITY verbose\n' + guard;
  for (const [index, phase] of phases.entries()) {
    sql += `\n\\echo START ${index + 1} ${phase.path}\n${phase.sql}\n\\echo OK ${index + 1} ${phase.path}\n`;
  }
  sql += '\\echo STAGING_REPLAY_AND_ASSERTIONS_PASSED_130_MIGRATIONS\n';
  return { sql, manifest: { database, sha256: sha256(sql), phases: phases.map(({ path, sql: body }) => ({ path, sha256: sha256(body) })) } };
}

function main() {
  const [mode, database, ...extra] = process.argv.slice(2);
  assert.ok(['--prepare', '--run'].includes(mode) && !extra.length,
    'Usage: node scripts/staging-baseline-replay.mjs --prepare|--run <exact-synthetic-database>');
  const replay = buildReplay(database);
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'replay.sql'), replay.sql);
  writeFileSync(join(output, 'manifest.json'), JSON.stringify(replay.manifest, null, 2) + '\n');
  console.log(`Prepared 130 migrations; bundle SHA256 ${replay.manifest.sha256}`);
  if (mode === '--prepare') return;

  // Reuse the existing host guard. Missing guard or Docker access is a hard failure.
  // Fixed local Docker transport; no PGHOST/PGPORT/DATABASE_URL/default host 5432.
  const require = createRequire(import.meta.url);
  require(join(root, '.tmp-staging-uat-20261009/compose/verify-owned.cjs')).verifyOwned();
  const result = spawnSync('docker', [
    '--config', join(root, '.tmp-staging-uat-20261009/compose/docker-config'),
    '-H', 'npipe:////./pipe/dockerDesktopLinuxEngine', 'exec', '-i',
    'botsummary-uat-postgres-20261009', 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
    '-h', '/var/run/postgresql', '-p', '5432', '--no-password',
    '-U', 'postgres', '-d', database, '-f', '-',
  ], { input: Buffer.from(replay.sql), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 300000 });
  writeFileSync(join(output, 'replay.log'), (result.stdout ?? '') + (result.stderr ?? ''));
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'Replay failed: inspect ignored baseline/replay.log; do not resume/skip');
  assert.ok(result.stdout.includes('STAGING_REPLAY_AND_ASSERTIONS_PASSED_130_MIGRATIONS'), 'Missing final assertion marker');
  console.log('PG17 ordered replay and schema/security assertions passed. Financial HTTP UAT remains separate.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
