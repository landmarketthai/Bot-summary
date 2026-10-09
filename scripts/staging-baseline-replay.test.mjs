import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildReplay, migrationPlan } from './staging-baseline-replay.mjs';

test('recovered SQL payload is exactly the historical Git blob', () => {
  const fixture = readFileSync(new URL('../supabase/tests/staging_missing_baseline.sql', import.meta.url));
  const marker = Buffer.from('-- BEGIN VERBATIM HISTORICAL PAYLOAD\n');
  const payload = fixture.subarray(fixture.indexOf(marker) + marker.length);
  const gitBlob = createHash('sha1').update(`blob ${payload.length}\0`).update(payload).digest('hex');
  assert.equal(gitBlob, 'e55e853e055d95df5c9834ab6a58a6a28d84229e');
});

test('complete replay is deterministic, unchanged, ordered, and never resumes/skips', () => {
  const database = 'botsummary_compose_uat_20261009';
  const replay = buildReplay(database);
  assert.deepEqual(replay, buildReplay(database));
  const migrations = migrationPlan();
  assert.equal(migrations.length, 130);
  assert.deepEqual(replay.manifest.phases.filter(p => p.path.startsWith('supabase/migrations/')).map(p => p.path), migrations.map(p => p.path));
  let position = -1;
  for (const migration of migrations) {
    const next = replay.sql.indexOf(migration.sql, position + 1);
    assert.ok(next > position, `Missing/altered/out-of-order ${migration.path}`);
    position = next;
  }
  const phases = replay.manifest.phases.map(p => p.path);
  const baseline = phases.indexOf('supabase/tests/staging_missing_baseline.sql');
  assert.equal(phases[baseline - 1], 'supabase/migrations/0030_manual_slip_market_key.sql');
  assert.equal(phases[baseline + 2], 'supabase/migrations/0031_pending_session_sender_identity.sql');
  assert.match(replay.sql, /\\set ON_ERROR_STOP on/);
  assert.match(replay.sql, /Database is not fresh/);
  assert.match(replay.sql, /server_version_num'\)::int >= 180000/);
  assert.match(replay.sql, /STAGING_REPLAY_AND_ASSERTIONS_PASSED_130_MIGRATIONS/);
});

test('only exact synthetic targets can be prepared', () => {
  for (const target of ['postgres', 'Production', 'botsummary', "x'; DROP DATABASE postgres; --", undefined]) {
    assert.throws(() => buildReplay(target));
  }
});
