// Explicit host-only continuation of the already running synthetic c stack.
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transportMark, settleTransport } from './staging-transport-audit.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const output = join(root, '.tmp-staging-uat-20261009/auth-finance');
export const database = 'botsummary_baseline_replay_20261009c';
const require = createRequire(import.meta.url);
const network = 'botsummary-uat-loopback-20261009';
const owned = { db: 'botsummary-uat-postgres-20261009', auth: 'botsummary-full-auth-20261009',
  rest: 'botsummary-full-rest-20261009', gateway: 'botsummary-full-gateway-20261009' };
const members = [...Object.values(owned), 'botsummary-uat-auth-20261009', 'botsummary-uat-rest-20261009',
  'botsummary-uat-gateway-20261009', 'botsummary-replay-rest-20261009'];
function docker(args, input) {
  const result = spawnSync('docker', ['--config', join(root, '.tmp-staging-uat-20261009/compose/docker-config'),
    '-H', 'npipe:////./pipe/dockerDesktopLinuxEngine', ...args],
  { cwd: root, input, encoding: 'utf8', timeout: 60000, maxBuffer: 12 * 1024 * 1024 });
  assert.ok(result.status === 0, 'Owned local Docker operation failed; inspect privately, no remote fallback');
  return result.stdout;
}
export const sqlGuard = `DO $$ BEGIN
 IF current_database() <> '${database}' OR current_user <> 'postgres'
 OR current_setting('server_version_num')::int NOT BETWEEN 170000 AND 179999
 THEN RAISE EXCEPTION 'Require exact synthetic PG17 c target'; END IF; END $$;\n`;
export function sql(input) {
  return docker(['exec', '-i', owned.db, 'psql', '-X', '--no-password', '-h', '/var/run/postgresql',
    '-p', '5432', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-Atq', '-f', '-'], sqlGuard + input).trim();
}
function envOf(container) {
  return Object.fromEntries(container.Config.Env.map(value => {
    const at = value.indexOf('='); return [value.slice(0, at), value.slice(at + 1)];
  }));
}
export function validateFullStack(objects, bridge, config) {
  assert.equal(config.api, 'http://127.0.0.1:56343');
  assert.equal(config.database, database);
  assert.equal(bridge.Name, network); assert.equal(bridge.Driver, 'bridge');
  assert.deepEqual(Object.values(bridge.Containers).map(value => value.Name).sort(), [...members].sort());
  for (const [kind, container] of Object.entries(objects)) {
    assert.equal(container.Name, '/' + owned[kind]); assert.equal(container.State.Status, 'running');
    assert.deepEqual(Object.keys(container.NetworkSettings.Networks), [network]);
    const bindings = Object.entries(container.NetworkSettings.Ports).filter(([, value]) => value);
    assert.deepEqual(bindings, kind === 'db' ? [['5432/tcp', [{ HostIp: '127.0.0.1', HostPort: '56322' }]]]
      : kind === 'gateway' ? [['80/tcp', [{ HostIp: '127.0.0.1', HostPort: '56343' }]]] : []);
  }
  assert.equal(objects.db.State.Health?.Status, 'healthy');
  assert.ok(objects.db.Mounts.some(mount => mount.Type === 'volume' && mount.Name === 'botsummary-uat-pgdata-20261009'
    && mount.Destination === '/var/lib/postgresql/data'));
  const auth = envOf(objects.auth), rest = envOf(objects.rest);
  for (const value of [auth.GOTRUE_DB_DATABASE_URL, rest.PGRST_DB_URI]) {
    const uri = new URL(value);
    assert.equal(uri.hostname, owned.db); assert.equal(uri.port, '5432'); assert.equal(uri.pathname, '/' + database);
    assert.equal(uri.search, ''); assert.equal(uri.hash, ''); assert.ok(uri.username && uri.password);
  }
  assert.ok(auth.GOTRUE_JWT_SECRET && auth.GOTRUE_JWT_SECRET === rest.PGRST_JWT_SECRET, 'Shared synthetic signing secret mismatch');
  assert.equal(rest.PGRST_DB_SCHEMAS, 'public'); assert.equal(rest.PGRST_DB_ANON_ROLE, 'anon');
  for (const [key, role] of [['anonKey', 'anon'], ['serviceKey', 'service_role']]) {
    const [header, payload, signature, extra] = String(config[key]).split('.');
    assert.ok(header && payload && signature && !extra, 'Malformed synthetic key');
    assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'HS256');
    assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).role, role);
    assert.ok(createHmac('sha256', rest.PGRST_JWT_SECRET).update(header + '.' + payload).digest('base64url') === signature,
      'Synthetic runtime key signature mismatch');
  }
  assert.ok(/^SYNTHETIC-UAT-ONLY-[a-f0-9]{48}$/.test(config.cronSecret), 'Malformed synthetic cron secret');
}
export function verifyFullStack() {
  assert.equal(resolve(process.cwd()), root);
  const config = JSON.parse(readFileSync(join(output, 'runtime-c.json'), 'utf8'));
  const objects = Object.fromEntries(Object.entries(owned).map(([key, name]) => [key,
    JSON.parse(docker(['inspect', '--type', 'container', name]))[0]]));
  const bridge = JSON.parse(docker(['network', 'inspect', network]))[0];
  validateFullStack(objects, bridge, config);
  sql('SELECT 1;');
  return config;
}
export function expiredTestToken(token) {
  // Only the inspected local Auth secret signs this artificial expired user JWT.
  const auth = envOf(JSON.parse(docker(['inspect', '--type', 'container', owned.auth]))[0]);
  const secret = auth.GOTRUE_JWT_SECRET;
  const [header, payload, signature] = token.split('.');
  assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'HS256');
  assert.ok(createHmac('sha256', secret).update(header + '.' + payload).digest('base64url') === signature, 'Genuine user token signature mismatch');
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.equal(claims.role, 'authenticated'); assert.ok(claims.sub);
  const now = Math.floor(Date.now() / 1000);
  claims.iat = now - 120; claims.exp = now - 60;
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const data = header + '.' + encoded;
  return { token: data + '.' + createHmac('sha256', secret).update(data).digest('base64url'), exp: claims.exp };
}
export function snapshot(tables) {
  assert.ok(tables.every(table => /^[a-z_]+$/.test(table)));
  return JSON.parse(sql('SELECT jsonb_build_object(' + tables.map(table =>
    `'${table}',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM public.${table} t)`).join(',') + ');'));
}
export async function context(clock = 'real') {
  const config = verifyFullStack();
  delete process.env.STAGING_UAT_CLOCK;
  const { runId } = require('./staging-auth-finance-preload.cjs');
  const state = JSON.parse(readFileSync(join(output, 'server-state.json'), 'utf8'));
  const serverId = state.runId;
  assert.equal(state.clock, clock, 'Wrong clocked server metadata');
  const runIds = [runId, serverId], mark = transportMark(output, runIds);
  const ready = await fetch('http://127.0.0.1:56300/api/settlement?month=2026-10', { redirect: 'error', signal: AbortSignal.timeout(60000) });
  await ready.arrayBuffer();
  assert.equal(ready.status, 401); assert.equal(ready.headers.get('x-local-staging-uat'), clock);
  assert.equal(ready.headers.get('x-local-staging-uat-run'), serverId, 'Metadata belongs to another server');
  async function request(path, cookie = '', body, headers = {}) {
    const started = performance.now();
    const response = await fetch('http://127.0.0.1:56300' + path, { redirect: 'manual',
      method: body ? 'POST' : 'GET', headers: { ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000) });
    const bytes = Buffer.from(await response.arrayBuffer()), ms = performance.now() - started;
    assert.equal(response.headers.get('x-local-staging-uat'), clock);
    assert.equal(response.headers.get('x-local-staging-uat-run'), serverId, 'Server changed during UAT');
    return { response, bytes, ms, json: () => JSON.parse(bytes.toString('utf8')) };
  }
  return { config, request, runIds, mark, settle: expected => settleTransport(output, runIds, mark, expected) };
}
export async function authCookies(config, role = 'operator', spoof = false) {
  const { createClient } = require('@supabase/supabase-js');
  const { createServerClient } = require('@supabase/ssr');
  const admin = createClient(config.api, config.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = `uat-20261010-${randomBytes(6).toString('hex')}@staging.invalid`, password = randomBytes(24).toString('base64url');
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true,
    app_metadata: { role }, user_metadata: spoof ? { role: 'admin' } : {} });
  assert.ok(!created.error, 'Synthetic account creation failed');
  const jar = new Map();
  const client = createServerClient(config.api, config.anonKey, { cookies: {
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    setAll: list => list.forEach(({ name, value, options }) => {
      if (!value || options?.maxAge === 0) jar.delete(name); else jar.set(name, value);
    }),
  } });
  const signed = await client.auth.signInWithPassword({ email, password });
  assert.ok(!signed.error && signed.data.user.id === created.data.user.id && jar.size, 'Genuine synthetic login failed');
  return { jar, id: created.data.user.id, cookie: () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ') };
}
export function saveResult(name, facts) {
  writeFileSync(join(output, name + '-20261010-result.json'), JSON.stringify(facts, null, 2) + '\n', { mode: 0o600 });
}
async function main() {
  const [mode, ...extra] = process.argv.slice(2); assert.equal(extra.length, 0);
  if (mode === '--verify-host') { verifyFullStack(); console.log('EXACT_OWNED_FULL_SCHEMA_C_VERIFIED'); }
  else if (mode === '--finance-host') await (await import('./staging-final-finance.mjs')).financeHost();
  else if (mode === '--session-host') await (await import('./staging-session-month.mjs')).sessionHost();
  else if (mode === '--seed-month-host') {
    const current = await context();
    sql(readFileSync(join(root, 'supabase/tests/staging_month31_seed.sql'), 'utf8'));
    await current.settle(0); console.log('SYNTHETIC_MONTH31_SEEDED_NOT_BENCHMARKED');
  }
  else if (mode === '--month-host') await (await import('./staging-session-month.mjs')).monthHost();
  else throw new Error('Use --verify-host|--finance-host|--session-host|--seed-month-host|--month-host');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('FULL_SCHEMA_C_UAT_FAILED; stop and inspect locally, no secrets emitted'); process.exitCode = 1; });
}
