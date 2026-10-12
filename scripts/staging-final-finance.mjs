import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { context, authCookies, sql, snapshot, saveResult, database } from './staging-full-schema-uat.mjs';

// A new namespace and unused business day preserve yesterday's synthetic evidence.
export function financeFixture(text) {
  assert.ok(text.includes("current_database() <> 'botsummary_baseline_replay_20261009b'"));
  return text.replaceAll('botsummary_baseline_replay_20261009b', database)
    .replaceAll('61090000', '61100000').replaceAll('uat-20261009-finance', 'uat-20261010-finance')
    .replaceAll('2026-10-07', '2026-10-06').replaceAll('7/10/2569', '6/10/2569');
}
export async function financeHost() {
  const current = await context();
  const source = 'uat-20261010-finance', round = '61100000-0000-4000-8000-000000000001';
  const scope = { sourceId: source, market: 'ราชพฤกษ์', date: '2026-10-06', accountabilityRoundId: round };
  const query = new URLSearchParams(scope), yodQuery = new URLSearchParams({ date: scope.date, market: scope.market, seller: 'น้อย' });
  sql(`DO $$ BEGIN
    IF EXISTS (SELECT FROM public.accountability_rounds WHERE business_date='2026-10-06')
    OR EXISTS (SELECT FROM public.produce_sessions WHERE session_date='2026-10-06')
    OR EXISTS (SELECT FROM public.settlement_entries WHERE settlement_date='2026-10-06')
    OR EXISTS (SELECT FROM public.pending_sessions WHERE source_id='${source}')
    OR EXISTS (SELECT FROM public.pending_session_retired_generations WHERE source_id='${source}')
    OR EXISTS (SELECT FROM public.raw_messages WHERE source_id='${source}')
    THEN RAISE EXCEPTION 'Refuse used date or existing finance fixture'; END IF; END $$;`);
  const admin = await authCookies(current.config, 'admin'), operator = await authCookies(current.config),
    spoof = await authCookies(current.config, 'operator', true);
  const cashTables = ['digital_white_sheet_cash_entries', 'white_sheet_lifecycle_events'];
  async function json(path, user, body, status) {
    const result = await current.request(path, user?.cookie() || '', body);
    assert.equal(result.response.status, status); return result.json();
  }
  const seed = name => sql(financeFixture(readFileSync('supabase/tests/' + name, 'utf8')));
  for (const path of ['/api/settlement?month=2026-10', `/api/white-sheet?${query}`,
    `/api/settlement/yod-song?${yodQuery}`, '/api/pdf/financial-summary?month=2026-10']) await json(path, null, undefined, 401);
  for (const user of [operator, spoof]) await json('/api/white-sheet/finalize', user, scope, 403);
  seed('staging_auth_finance_seed.sql');
  const savedCash = await json('/api/white-sheet', operator, { ...scope, labor: 0, locationFee: 0,
    bag: 0, snack: 0, other: 0, actualCashSubmitted: 70 }, 200);
  assert.equal(savedCash.entryStatus, 'submitted'); assert.equal(savedCash.summary.actualCashSubmitted, 70);
  const before = snapshot(cashTables);
  async function blocked() {
    const yod = await json(`/api/settlement/yod-song?${yodQuery}`, operator, undefined, 200);
    assert.equal(yod.produceValueStatus, 'blocked'); assert.equal(yod['ยอดส่ง'], null);
    const white = await json(`/api/white-sheet?${query}`, operator, undefined, 200);
    assert.ok(white.summary.warnings.some(warning => warning.startsWith('ข้อมูลชั่งคืน/รายการของตลาดนี้ยังไม่ครบหรือยังไม่ผ่านการตรวจ')));
    for (const user of [operator, spoof, admin]) {
      await json('/api/white-sheet/finalize', user, scope, user === admin ? 409 : 403);
      assert.deepEqual(snapshot(cashTables), before);
    }
  }
  await blocked();
  seed('staging_auth_finance_rotate.sql');
  const retainedSql = "SELECT to_jsonb(t) FROM public.pending_session_retired_generations t WHERE session_generation='61100000-0000-4000-8000-000000000006';";
  const retained = JSON.parse(sql(retainedSql));
  assert.equal(retained.finalization_status, 'failed_closed'); await blocked();
  seed('staging_auth_finance_correct.sql');
  const corrected = await json(`/api/settlement/yod-song?${yodQuery}`, operator, undefined, 200);
  assert.equal(corrected.produceValueStatus, 'complete'); assert.equal(corrected['ยอดส่ง'], 70);
  const white = await json(`/api/white-sheet?${query}`, operator, undefined, 200);
  assert.equal(white.summary.expectedSales, 70); assert.equal(white.summary.expectedCash, 70);
  assert.equal(white.summary.difference, 0); assert.equal(white.summary.status, 'matched');
  const finalized = await json('/api/white-sheet/finalize', admin, scope, 200);
  assert.equal(finalized.status, 'finalized'); assert.equal(finalized.finalizedBy, admin.id);
  assert.equal(finalized.actualCashSubmitted, 70);
  const after = snapshot(cashTables);
  assert.equal(after.white_sheet_lifecycle_events.length, before.white_sheet_lifecycle_events.length + 1);
  assert.equal(Number(after.digital_white_sheet_cash_entries.find(row => row.source_id === source).actual_cash_submitted), 70);
  assert.deepEqual(JSON.parse(sql(retainedSql)), retained);
  const locked = await json(`/api/white-sheet?${query}`, operator, undefined, 200);
  assert.equal(locked.entryStatus, 'finalized'); assert.equal(locked.finalizedBy, admin.id);
  const reconciliationBefore = snapshot(['settlement_finalizations', 'transfer_reconciliations']);
  const body = { settlement_date: scope.date, settlement_time: '', staff_name: 'น้อย', market_name: scope.market,
    money_transfer: 0, money_cash: 70, expenses: 0, labor: 0, notes: source, notify_line: false };
  const saved = await json('/api/settlement', operator, body, 200);
  assert.equal(Number(saved.money_cash), 70); assert.equal(saved.lineTargets, 0); assert.equal(saved.lineError, null);
  assert.equal(saved.source_id, null); assert.equal(saved.accountability_round_id, null);
  assert.equal((await json('/api/settlement', operator, body, 200)).id, saved.id);
  assert.deepEqual(snapshot(['settlement_finalizations', 'transfer_reconciliations']), reconciliationBefore);
  for (const path of ['/financial-summary?month=2026-10', '/api/pdf/financial-summary?month=2026-10']) {
    const result = await current.request(path, operator.cookie()); assert.equal(result.response.status, 200);
    if (path.startsWith('/api/pdf')) {
      assert.match(result.response.headers.get('content-type'), /application\/pdf/);
      assert.equal(result.bytes.subarray(0, 5).toString(), '%PDF-');
    } else assert.match(result.response.headers.get('content-type'), /text\/html/);
  }
  await current.settle(0);
  saveResult('finance', { passed: true, database, source, date: scope.date, mode: 'real-local-http-db',
    money: 70, retiredFailurePreserved: true, newBlockedAttempts: 0, syntheticLineCaptures: 0 });
  console.log('REAL_LOCAL_FINANCE_20261010_PASSED money=70 newBlockedAttempts=0 syntheticLineCaptures=0');
}
