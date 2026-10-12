import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { context, authCookies, expiredTestToken, sql, snapshot, saveResult, database } from './staging-full-schema-uat.mjs';
const require = createRequire(import.meta.url);

export function applyCookies(jar, headers) {
  for (const header of headers.getSetCookie()) {
    const pair = header.split(';', 1)[0], at = pair.indexOf('=');
    assert.ok(at > 0, 'Malformed response cookie');
    const name = pair.slice(0, at), value = decodeURIComponent(pair.slice(at + 1));
    if (!value || /;\s*Max-Age=0(?:;|$)/i.test(header)) jar.delete(name); else jar.set(name, value);
  }
}
async function forceExpired(user, invalidRefresh = false) {
  const { combineChunks, createChunks } = require('@supabase/ssr');
  const key = [...user.jar.keys()].find(name => name.endsWith('-auth-token') || /-auth-token\.0$/.test(name))?.replace(/\.0$/, '');
  assert.ok(key, 'Synthetic session cookie missing');
  const encoded = await combineChunks(key, name => user.jar.get(name));
  assert.ok(encoded.startsWith('base64-'));
  const session = JSON.parse(Buffer.from(encoded.slice(7), 'base64url').toString());
  const expired = expiredTestToken(session.access_token);
  session.access_token = expired.token; session.expires_at = expired.exp;
  if (invalidRefresh) session.refresh_token = randomBytes(32).toString('hex');
  for (const name of [...user.jar.keys()]) if (name === key || name.startsWith(key + '.')) user.jar.delete(name);
  for (const { name, value } of createChunks(key, 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url'))) user.jar.set(name, value);
  return session.refresh_token;
}
export async function sessionHost() {
  const current = await context();
  const before = snapshot(['produce_sessions', 'produce_items', 'digital_white_sheet_cash_entries',
    'white_sheet_lifecycle_events', 'settlement_entries', 'settlement_finalizations', 'transfer_reconciliations']);
  const cases = {};
  // Separate genuine logins avoid rotating a refresh token between scenarios.
  for (const path of ['/api/settlement?month=2026-10', '/login', '/auth/callback']) {
    const user = await authCookies(current.config); await forceExpired(user);
    const previous = user.cookie(), result = await current.request(path, previous);
    const redirect = path !== '/api/settlement?month=2026-10';
    const redirectLocation = result.response.headers.get('location');
    const statusOk = redirect ? result.response.status === 307 && Boolean(redirectLocation) && new URL(redirectLocation, 'http://127.0.0.1:56300').pathname === '/'
      : result.response.status === 200;
    const cookies = result.response.headers.getSetCookie();
    applyCookies(user.jar, result.response.headers);
    const changed = user.cookie() !== previous;
    const follow = await current.request('/api/settlement?month=2026-10', user.cookie());
    cases[path] = { status: result.response.status, expectedStatusAndLocation: statusOk,
      setCookieCount: cookies.length, changedCookies: changed, followStatus: follow.response.status,
      passed: statusOk && cookies.length > 0 && changed && follow.response.status === 200 };
    console.log(`SESSION_CASE ${path.split('?')[0]} status=${result.response.status} cookieCount=${cookies.length} passed=${cases[path].passed}`);
  }
  for (const path of ['/api/settlement?month=2026-10', '/financial-summary?month=2026-10']) {
    const user = await authCookies(current.config); await forceExpired(user, true);
    const result = await current.request(path, user.cookie());
    const api = path.startsWith('/api');
    const location = result.response.headers.get('location');
    const initialRefusal = api ? result.response.status === 401 : result.response.status === 307
      && location && new URL(location, 'http://127.0.0.1:56300').pathname === '/login' && new URL(location, 'http://127.0.0.1:56300').searchParams.get('next') === '/financial-summary';
    const setCookies = result.response.headers.getSetCookie();
    const cookieBefore = user.cookie();
    applyCookies(user.jar, result.response.headers);
    const changedCookies = cookieBefore !== user.cookie();
    const clearedAuthCookie = [...user.jar.keys()].every(name => !name.includes('-auth-token'));
    const follow = await current.request(path, user.cookie());
    const followLocation = follow.response.headers.get('location');
    const followRefused = api ? follow.response.status === 401 :
      follow.response.status === 307 && Boolean(followLocation) &&
      new URL(followLocation, 'http://127.0.0.1:56300').pathname === '/login';
    const passed = Boolean(initialRefusal) && setCookies.length > 0 && changedCookies
      && clearedAuthCookie && followRefused;
    cases['invalid-refresh:' + path] = { status: result.response.status, passed,
      setCookieCount: setCookies.length, changedCookies, clearedAuthCookie, followStatus: follow.response.status };
    console.log(`SESSION_INVALID_REFRESH ${path.split('?')[0]} status=${result.response.status} followStatus=${follow.response.status} passed=${passed}`);
  }
  assert.deepEqual(snapshot(Object.keys(before)), before);
  await current.settle(0);
  const passed = Object.values(cases).every(value => value.passed);
  saveResult('session', { passed, database, mode: 'real-local-http-gotrue',
    expiryFixture: 'synthetic-locally-resigned-expired-user-JWT; genuine-refresh-token', unchangedMoneyTables: true, cases });
  assert.ok(passed, 'Session redirect/refresh gate failed; see safe session result');
  console.log('REAL_LOCAL_SESSION_REFRESH_20261010_PASSED');
}
export function percentile(values, fraction) {
  assert.ok(values.length && fraction > 0 && fraction <= 1);
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
}
export function assertMonthlyHtml(html, sourceSellerLabels = ['ผู้ขาย๐', 'ผู้ขาย๙']) {
  assert.equal(sourceSellerLabels.length, 2, 'Expected first/last sellers from seeded source');
  for (const value of [...sourceSellerLabels, '2026-08-01', '2026-08-31', 'return_incomplete']) {
    assert.ok(html.includes(value), `Monthly HTML workload/blocked group missing: ${value}`);
  }
}
export async function monthHost() {
  const current = await context(), user = await authCookies(current.config);
  const counts = JSON.parse(sql(`SELECT jsonb_build_object(
    'rounds',(SELECT count(*) FROM public.accountability_rounds WHERE source_id='uat-20261010-month31'),
    'sessions',(SELECT count(*) FROM public.produce_sessions s JOIN public.raw_messages m ON m.id=s.raw_message_id WHERE m.source_id='uat-20261010-month31'),
    'transactions',(SELECT count(*) FROM public.produce_transactions t JOIN public.raw_messages m ON m.id=t.raw_message_id WHERE m.source_id='uat-20261010-month31'),
    'retired',(SELECT count(*) FROM public.pending_session_retired_generations WHERE source_id='uat-20261010-month31'));`));
  assert.deepEqual(counts, { rounds: 310, sessions: 930, transactions: 4650, retired: 620 });
  // The owned August dataset was seeded before the synthetic seed source switched
  // to Thai numerals. Do not reseed or accept a false HTML pass: bind the first
  // and last expected labels to the exact stored synthetic round identities.
  const storedSellers = JSON.parse(sql(`SELECT jsonb_build_object(
    'first',(SELECT seller_label FROM public.accountability_rounds WHERE
      source_id='uat-20261010-month31' AND business_date='2026-08-01'
      AND owner_line_user_id='uat-20261010-month-owner-0' LIMIT 1),
    'last',(SELECT seller_label FROM public.accountability_rounds WHERE
      source_id='uat-20261010-month31' AND business_date='2026-08-31'
      AND owner_line_user_id='uat-20261010-month-owner-9' LIMIT 1));`));
  assert.ok(['ผู้ขาย0', 'ผู้ขาย๐'].includes(storedSellers.first), 'Unexpected first seeded seller');
  assert.ok(['ผู้ขาย9', 'ผู้ขาย๙'].includes(storedSellers.last), 'Unexpected last seeded seller');
  const sourceSellerLabels = [storedSellers.first, storedSellers.last];
  // Confirm the actual gateway serves the view with service-only authentication.
  const rest = await fetch(current.config.api + '/rest/v1/produce_transactions?select=id&transaction_date=gte.2026-08-01&transaction_date=lt.2026-09-01', {
    headers: { apikey: current.config.anonKey, Authorization: 'Bearer ' + current.config.serviceKey, Prefer: 'count=exact', Range: '0-0' },
    redirect: 'error', signal: AbortSignal.timeout(30000) });
  await rest.arrayBuffer(); assert.ok([200, 206].includes(rest.status)); assert.match(rest.headers.get('content-range'), /\/4650$/);
  const before = snapshot(['produce_sessions', 'produce_items', 'digital_white_sheet_cash_entries',
    'white_sheet_lifecycle_events', 'settlement_entries', 'settlement_finalizations', 'transfer_reconciliations']);
  const measurements = {};
  for (const path of ['/financial-summary?month=2026-08', '/api/pdf/financial-summary?month=2026-08']) {
    const times = [], sizes = [];
    for (let index = 0; index <= 10; index++) {
      const result = await current.request(path, user.cookie()); assert.equal(result.response.status, 200);
      const pdf = path.startsWith('/api/pdf');
      assert.match(result.response.headers.get('content-type'), pdf ? /application\/pdf/ : /text\/html/);
      if (pdf) assert.equal(result.bytes.subarray(0, 5).toString(), '%PDF-');
      else {
        const html = result.bytes.toString();
        assertMonthlyHtml(html, sourceSellerLabels);
      }
      times.push(result.ms); sizes.push(result.bytes.length);
      console.log(`MONTH31 ${pdf ? 'pdf' : 'html'} sample=${index} ms=${result.ms.toFixed(1)} bytes=${result.bytes.length}`);
    }
    measurements[path] = { firstRequestIncludingDevCompilationMs: times[0], warmMs: times.slice(1),
      p50Ms: percentile(times.slice(1), 0.5), p95Ms: percentile(times.slice(1), 0.95), bytes: sizes };
    saveResult('month', { passed: false, completedEndpoints: Object.keys(measurements), database, counts, measurements });
  }
  assert.deepEqual(snapshot(Object.keys(before)), before); await current.settle(0);
  saveResult('month', { passed: true, database, mode: 'real-local-next-postgrest-pdf', counts, measurements,
    node: process.version, next: require('next/package.json').version, productionSlaEstablished: false,
    caveat: '10 warm samples per endpoint; local development server; uncontrolled process/database caches' });
  console.log('REAL_LOCAL_MONTH31_20261010_MEASURED; production SLA not established');
}
