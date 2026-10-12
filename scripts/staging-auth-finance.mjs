// Local host handoff; no Docker/HTTP calls on import or in offline tests.
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transportMark, settleTransport } from './staging-transport-audit.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, '.tmp-staging-uat-20261009/auth-finance');
const composeDir = join(root, '.tmp-staging-uat-20261009/compose');
const require = createRequire(import.meta.url);
export const database = 'botsummary_baseline_replay_20261009b';
export const names = {
  db: 'botsummary-uat-postgres-20261009', rest: 'botsummary-uat-rest-20261009',
  auth: 'botsummary-uat-auth-20261009', gateway: 'botsummary-uat-gateway-20261009',
  fullRest: 'botsummary-replay-rest-20261009',
};
const network = 'botsummary-uat-loopback-20261009';
const api = 'http://127.0.0.1:56321';
const app = 'http://127.0.0.1:56300';
let serverRunId;
const source = 'uat-20261009-finance';
const round = '61090000-0000-4000-8000-000000000001';
const scope = { sourceId: source, market: 'ราชพฤกษ์', date: '2026-10-07', accountabilityRoundId: round };
function docker(args, input) {
  const result = spawnSync('docker', ['--config', join(composeDir, 'docker-config'),
    '-H', 'npipe:////./pipe/dockerDesktopLinuxEngine', ...args],
  { cwd: root, input, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024, stdio: 'pipe' });
  // Docker errors/inspect output can contain passwords; never print them.
  if (result.status !== 0) {
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, 'host-failure.log'), result.stderr || 'Docker process unavailable', { mode: 0o600 });
  }
  assert.equal(result.status, 0, 'Owned local Docker step failed; inspect privately on host');
  return result.stdout;
}
const inspect = (kind, name) => JSON.parse(docker(['inspect', '--type', kind, name]))[0];
export function dbUrl(value, role, target) {
  const url = new URL(value);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.equal(url.hostname, names.db);
  assert.equal(url.port, '5432');
  assert.equal(url.username, role);
  assert.equal(url.pathname, `/${target}`);
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
  assert.ok(url.password);
  return url;
}
export function validateContainers(containers, ownedNetwork, target) {
  assert.equal(ownedNetwork.Name, network);
  assert.equal(ownedNetwork.Driver, 'bridge');
  const expectedNames = Object.values(names).sort();
  assert.deepEqual(Object.values(ownedNetwork.Containers).map(c => c.Name).sort(), expectedNames);
  for (const [kind, name] of Object.entries(names)) {
    const c = containers[kind];
    assert.equal(c.Name, `/${name}`);
    assert.equal(c.State.Status, 'running');
    assert.deepEqual(Object.keys(c.NetworkSettings.Networks), [network]);
    const expectedPort = { db: ['5432/tcp', '56322'], gateway: ['80/tcp', '56321'], fullRest: ['3000/tcp', '56331'] }[kind];
    const actual = Object.entries(c.NetworkSettings.Ports).flatMap(([port, bindings]) =>
      (bindings ?? []).map(b => `${port}:${b.HostIp}:${b.HostPort}`));
    assert.deepEqual(actual, expectedPort ? [`${expectedPort[0]}:127.0.0.1:${expectedPort[1]}`] : []);
    if (['auth', 'rest', 'gateway'].includes(kind)) {
      assert.equal(c.Config.Labels['com.docker.compose.project'], 'botsummary-compose-uat-20261009');
    }
  }
  assert.equal(containers.db.State.Health?.Status, 'healthy');
  assert.ok(containers.db.Mounts.some(m => m.Type === 'volume' &&
    m.Name === 'botsummary-uat-pgdata-20261009' && m.Destination === '/var/lib/postgresql/data'));
  const env = kind => Object.fromEntries(containers[kind].Config.Env.map(line => {
    const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)];
  }));
  const auth = env('auth'), rest = env('rest'), full = env('fullRest');
  dbUrl(auth.GOTRUE_DB_DATABASE_URL, 'botsummary_uat_auth', target);
  dbUrl(rest.PGRST_DB_URI, 'botsummary_uat_rest', target);
  dbUrl(full.PGRST_DB_URI, 'botsummary_replay_rest_20261009', database);
  assert.equal(auth.GOTRUE_JWT_SECRET, rest.PGRST_JWT_SECRET);
  assert.ok(rest.PGRST_JWT_SECRET.length >= 32);
  assert.equal(rest.PGRST_DB_SCHEMAS, 'public');
  assert.equal(rest.PGRST_DB_ANON_ROLE, 'anon');
  assert.equal(full.PGRST_DB_SCHEMAS, 'public');
  assert.equal(full.PGRST_DB_ANON_ROLE, 'anon');
  assert.equal(auth.GOTRUE_SITE_URL, app);
  assert.equal(auth.API_EXTERNAL_URL, api);
  assert.equal(auth.GOTRUE_DB_NAMESPACE, 'auth');
  assert.equal(auth.GOTRUE_JWT_AUD, 'authenticated');
  assert.equal(auth.GOTRUE_JWT_ADMIN_ROLES, 'service_role');
  return { auth, rest };
}
function verify(target = database) {
  const containers = Object.fromEntries(Object.entries(names).map(([key, name]) => [key, inspect('container', name)]));
  return validateContainers(containers, inspect('network', network), target);
}
function sql(body) {
  return docker(['exec', '-i', names.db, 'psql', '-X', '--no-password', '-h', '/var/run/postgresql',
    '-p', '5432', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-Atq'], body);
}
export const sqlGuard = `DO $$ BEGIN
  IF current_database() <> '${database}' OR current_user <> 'postgres'
    OR current_setting('server_version_num')::int NOT BETWEEN 170000 AND 179999 THEN
    RAISE EXCEPTION 'Require exact synthetic PG17 database and owner';
  END IF;
END $$;\n`;
export function jwt(secret, role) {
  const enc = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ role, aud: 'authenticated', iss: 'botsummary-local-uat', exp: 1893456000 })}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}
export function validateConfig(config) {
  assert.equal(config.api, api);
  assert.equal(config.database, database);
  assert.match(config.cronSecret, /^SYNTHETIC-UAT-ONLY-[a-f0-9]{48}$/);
  for (const [key, role] of [['anonKey', 'anon'], ['serviceKey', 'service_role']]) {
    const [header, payload, signature] = config[key].split('.');
    assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'HS256');
    assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).role, role);
    assert.ok(JSON.parse(Buffer.from(payload, 'base64url')).exp > Date.now() / 1000);
    assert.equal(createHmac('sha256', config.jwtSecret).update(`${header}.${payload}`).digest('base64url'), signature);
  }
  return config;
}
const runtimeConfig = () => validateConfig(JSON.parse(readFileSync(join(output, 'runtime.json'), 'utf8')));
function prepareHost() {
  const { auth, rest } = verify('botsummary_compose_uat_20261009');
  const authUrl = dbUrl(auth.GOTRUE_DB_DATABASE_URL, 'botsummary_uat_auth', 'botsummary_compose_uat_20261009');
  const restUrl = dbUrl(rest.PGRST_DB_URI, 'botsummary_uat_rest', 'botsummary_compose_uat_20261009');
  authUrl.pathname = restUrl.pathname = `/${database}`;
  mkdirSync(output, { recursive: true });
  const override = { services: {
    auth: { environment: { GOTRUE_DB_DATABASE_URL: authUrl.href, GOTRUE_DB_NAMESPACE: 'auth',
      GOTRUE_JWT_SECRET: rest.PGRST_JWT_SECRET, GOTRUE_DISABLE_SIGNUP: 'true', GOTRUE_MAILER_AUTOCONFIRM: 'true' } },
    rest: { environment: { PGRST_DB_URI: restUrl.href, PGRST_JWT_SECRET: rest.PGRST_JWT_SECRET } },
  } };
  writeFileSync(join(output, 'override.json'), JSON.stringify(override, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const secret = rest.PGRST_JWT_SECRET;
  writeFileSync(join(output, 'runtime.json'), JSON.stringify({ api, database, jwtSecret: secret,
    anonKey: jwt(secret, 'anon'), serviceKey: jwt(secret, 'service_role'),
    cronSecret: 'SYNTHETIC-UAT-ONLY-' + randomBytes(24).toString('hex') }) + '\n', { mode: 0o600, flag: 'wx' });
  console.log('Prepared ignored override/runtime config; credentials preserved and never displayed. No service or SQL change.');
}
function compose(args) {
  return docker(['compose', '--env-file', join(composeDir, '.env'), '-f', join(composeDir, 'compose.json'),
    '-f', join(output, 'override.json'), ...args]);
}
function rewireHost() {
  phase('rewire-owned-inventory');
  verify('botsummary_compose_uat_20261009');
  const config = runtimeConfig();
  const override = JSON.parse(readFileSync(join(output, 'override.json'), 'utf8'));
  assert.deepEqual(Object.keys(override), ['services']);
  assert.deepEqual(Object.keys(override.services).sort(), ['auth', 'rest']);
  for (const service of Object.values(override.services)) assert.deepEqual(Object.keys(service), ['environment']);
  assert.deepEqual(Object.keys(override.services.auth.environment).sort(), [
    'GOTRUE_DB_DATABASE_URL', 'GOTRUE_DB_NAMESPACE', 'GOTRUE_DISABLE_SIGNUP', 'GOTRUE_JWT_SECRET', 'GOTRUE_MAILER_AUTOCONFIRM',
  ].sort());
  assert.deepEqual(Object.keys(override.services.rest.environment).sort(), ['PGRST_DB_URI', 'PGRST_JWT_SECRET']);
  assert.equal(override.services.auth.environment.GOTRUE_DB_NAMESPACE, 'auth');
  assert.equal(override.services.auth.environment.GOTRUE_DISABLE_SIGNUP, 'true');
  assert.equal(override.services.auth.environment.GOTRUE_MAILER_AUTOCONFIRM, 'true');
  dbUrl(override.services.auth.environment.GOTRUE_DB_DATABASE_URL, 'botsummary_uat_auth', database);
  dbUrl(override.services.rest.environment.PGRST_DB_URI, 'botsummary_uat_rest', database);
  assert.equal(override.services.rest.environment.PGRST_JWT_SECRET, config.jwtSecret);
  assert.equal(override.services.auth.environment.GOTRUE_JWT_SECRET, config.jwtSecret);
  compose(['config', '--quiet']);
  phase('rewire-existing-baseline-assertions');
  // Reuse the actual replay assertions, inside their existing BEGIN/ROLLBACK.
  sql(sqlGuard + readFileSync(join(root, 'supabase/tests/staging_baseline_verification.sql'), 'utf8'));
  phase('rewire-narrow-auth-schema-bootstrap');
  sql(sqlGuard + `BEGIN;
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT * FROM pg_roles WHERE rolname IN ('botsummary_uat_auth','botsummary_uat_rest') LOOP
    IF NOT r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls THEN
      RAISE EXCEPTION 'Unsafe synthetic connection role';
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('botsummary_uat_auth','botsummary_uat_rest')) <> 2 THEN
    RAISE EXCEPTION 'Existing connection roles missing';
  END IF;
  IF EXISTS (SELECT FROM pg_namespace WHERE nspname='auth') THEN
    RAISE EXCEPTION 'Auth schema already exists; inspect rather than overwrite';
  END IF;
  IF NOT pg_has_role('botsummary_uat_rest','anon','MEMBER')
    OR NOT pg_has_role('botsummary_uat_rest','authenticated','MEMBER')
    OR NOT pg_has_role('botsummary_uat_rest','service_role','MEMBER') THEN
    RAISE EXCEPTION 'PostgREST role memberships missing';
  END IF;
END $$;
GRANT CONNECT ON DATABASE ${database} TO botsummary_uat_auth, botsummary_uat_rest;
CREATE SCHEMA auth AUTHORIZATION botsummary_uat_auth;
ALTER ROLE botsummary_uat_auth IN DATABASE ${database} SET search_path = auth;
COMMIT;`);
  phase('rewire-original-three-compose-services');
  compose(['up', '-d', '--pull', 'never', '--no-build', '--no-deps', 'auth', 'rest', 'gateway']);
  verify();
  console.log('Original Compose Auth/REST rewired to b. Real health/login still require smoke; standalone REST unchanged.');
}
export function appEnvNames() {
  const keys = new Set();
  function walk(dir) {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, item.name);
      if (item.isDirectory()) walk(file);
      else if (/\.[cm]?[jt]sx?$/.test(item.name)) {
        for (const match of readFileSync(file, 'utf8').matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]*)|\[['"]([A-Z][A-Z0-9_]*)['"]\])/g)) keys.add(match[1] || match[2]);
      }
    }
  }
  walk(join(root, 'src'));
  for (const file of readdirSync(root).filter(name => /^\.env(?:\.|$)/.test(name))) {
    for (const match of readFileSync(join(root, file), 'utf8').matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) keys.add(match[1]);
  }
  return keys;
}
export function childEnvironment(parent, config, keys, clock = '') {
  validateConfig(config);
  assert.ok(['', '2026-10-08T20:59:00.000Z', '2026-10-08T21:00:00.000Z', '2026-10-08T21:05:00.000Z'].includes(clock));
  const env = Object.fromEntries(Object.entries(parent).filter(([key]) =>
    /^(PATH|SystemRoot|WINDIR|TEMP|TMP|COMSPEC|PATHEXT|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i.test(key)));
  for (const key of keys) env[key] = '';
  Object.assign(env, {
    NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', VERCEL_ENV: 'development',
    NEXT_PUBLIC_SUPABASE_URL: api, NEXT_PUBLIC_SUPABASE_ANON_KEY: config.anonKey,
    SUPABASE_SERVICE_ROLE_KEY: config.serviceKey, ADMIN_USER_IDS: '',
    LINE_CHANNEL_ACCESS_TOKEN: 'SYNTHETIC-UAT-ONLY', LINE_CHANNEL_SECRET: '', OPENAI_API_KEY: '',
    CRON_SECRET: clock ? config.cronSecret : '', STAGING_UAT_CLOCK: clock,
    STAGING_UAT_CHILD: '1', NEXT_FONT_GOOGLE_MOCKED_RESPONSES: join(root, 'scripts/release-uat-fonts.cjs'),
    NODE_OPTIONS: `--require "${join(root, 'scripts/staging-auth-finance-preload.cjs')}"`,
  });
  return env;
}
async function serve(clock) {
  verify();
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--server'], {
    cwd: root, env: childEnvironment(process.env, runtimeConfig(), appEnvNames(), clock), stdio: 'inherit',
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  await new Promise(resolve => child.on('exit', code => { process.exitCode = code ?? 1; resolve(); }));
}
async function server() {
  assert.equal(process.env.STAGING_UAT_CHILD, '1', 'Start only through --serve');
  const { runId } = require('./staging-auth-finance-preload.cjs');
  const { createServer } = await import('node:http');
  const next = require('next');
  const nextApp = next({ dev: true, dir: root, hostname: '127.0.0.1', port: 56300,
    webpack: true, turbopack: false, conf: { distDir: '.tmp-staging-uat-20261009/auth-finance/next' } });
  await nextApp.prepare();
  const handle = nextApp.getRequestHandler();
  const httpServer = createServer((req, res) => {
    res.setHeader('x-local-staging-uat', process.env.STAGING_UAT_CLOCK || 'real');
    res.setHeader('x-local-staging-uat-run', runId);
    const pathname = new URL(req.url, app).pathname;
    // Local harness boundary; no application debug/clock endpoint is added.
    if (pathname.startsWith('/api/webhook') ||
        (pathname.startsWith('/api/cron') && !(process.env.STAGING_UAT_CLOCK &&
          pathname === '/api/cron/finalize-pending-produce-sessions' && req.method === 'GET'))) {
      res.writeHead(404); res.end(); return;
    }
    handle(req, res);
  });
  httpServer.on('error', async () => {
    console.error('Local Next listener failed; port may be occupied');
    try { await nextApp.close(); } finally { process.exit(1); }
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    httpServer.close(); await nextApp.close(); process.exit(0);
  });
  httpServer.listen(56300, '127.0.0.1', () => {
    writeFileSync(join(output, 'server-state.json'), JSON.stringify({ runId, pid: process.pid,
      clock: process.env.STAGING_UAT_CLOCK || 'real' }) + '\n', { mode: 0o600 });
    console.log('LOCAL_UAT_NEXT_READY 127.0.0.1:56300 development; outbound guard active');
  });
}
async function main() {
  assert.equal(resolve(process.cwd()), root, 'Stay in the authorized worktree');
  const [mode, clock = '', ...extra] = process.argv.slice(2);
  assert.equal(extra.length, 0);
  if (mode !== '--serve') assert.equal(clock, '');
  if (mode === '--prepare-host') prepareHost();
  else if (mode === '--rewire-host') rewireHost();
  else if (mode === '--verify-host') { verify(); console.log('Exact owned containers, DB wiring and ports verified.'); }
  else if (mode === '--serve') await serve(clock);
  else if (mode === '--server') await server();
  else if (mode === '--smoke-host') await smokeHost();
  else if (mode === '--cutoff-host') await cutoffHost();
  else throw new Error('Use --prepare-host|--rewire-host|--verify-host|--serve [reviewed UTC clock]|--smoke-host|--cutoff-host');
}
const query = new URLSearchParams(scope).toString();
const yodQuery = new URLSearchParams({ date: scope.date, market: scope.market, seller: 'น้อย' }).toString();
function phase(name) { console.log(`LOCAL_UAT_PHASE ${name}`); }
function installGuard() {
  delete process.env.STAGING_UAT_CLOCK;
  require('./staging-auth-finance-preload.cjs');
}
async function request(path, cookie = '', body, headers = {}) {
  const response = await fetch(app + path, { method: body ? 'POST' : 'GET', redirect: 'error',
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000) });
  const bytes = Buffer.from(await response.arrayBuffer());
  console.log(`REAL_LOCAL_NEXT_HTTP ${path.split('?')[0]} status=${response.status} bytes=${bytes.length}`);
  assert.ok(response.headers.get('x-local-staging-uat'), 'Refuse another Next process');
  if (serverRunId) assert.equal(response.headers.get('x-local-staging-uat-run'), serverRunId, 'Server changed during UAT');
  return { response, bytes, json: () => JSON.parse(bytes.toString('utf8')) };
}
async function expectJson(path, cookie, body, status) {
  const result = await request(path, cookie, body);
  assert.equal(result.response.status, status);
  return result.json();
}
function snapshot(tables) {
  return JSON.parse(sql(sqlGuard + 'SELECT jsonb_build_object(' + tables.map(table =>
    `'${table}',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM public.${table} t)`).join(',') + ');'));
}
async function authCookies(config, label, trusted = false, spoof = false) {
  const { createClient } = require('@supabase/supabase-js');
  const { createServerClient } = require('@supabase/ssr');
  const admin = createClient(api, config.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = `${label}-${randomBytes(6).toString('hex')}@uat-20261009.invalid`;
  const password = randomBytes(24).toString('base64url');
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true,
    app_metadata: { role: trusted ? 'admin' : 'operator' }, user_metadata: spoof ? { role: 'admin' } : {} });
  assert.equal(created.error, null, 'Synthetic local user creation failed');
  const jar = new Map();
  const client = createServerClient(api, config.anonKey, { cookies: {
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    setAll: list => list.forEach(({ name, value, options }) => {
      if (options.maxAge === 0 || !value) jar.delete(name); else jar.set(name, value);
    }),
  } });
  const signed = await client.auth.signInWithPassword({ email, password });
  assert.equal(signed.error, null, 'Genuine local password sign-in failed');
  assert.equal(signed.data.user.id, created.data.user.id);
  assert.ok(jar.size > 0, 'SSR SDK emitted no cookies');
  assert.ok([...jar.keys()].every(name => name.startsWith('sb-127-auth-token')));
  return { cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '),
    id: created.data.user.id, bearer: signed.data.session.access_token };
}
const cashTables = ['digital_white_sheet_cash_entries', 'white_sheet_lifecycle_events'];
const moneyTables = ['produce_sessions', 'produce_items', ...cashTables, 'settlement_entries',
  'settlement_finalizations', 'transfer_reconciliations'];
async function smokeHost() {
  verify();
  const config = runtimeConfig();
  const { rest } = verify();
  assert.equal(config.jwtSecret, rest.PGRST_JWT_SECRET);
  installGuard();
  const state = JSON.parse(readFileSync(join(output, 'server-state.json'), 'utf8'));
  const runIds = [process.env.STAGING_UAT_RUN_ID, state.runId];
  const transportBefore = transportMark(output, runIds);
  serverRunId = state.runId;
  phase('real-auth-health-and-rest-acl');
  const health = await fetch(api + '/auth/v1/health', { redirect: 'error', signal: AbortSignal.timeout(10000) });
  assert.equal(health.status, 200); await health.arrayBuffer();
  for (const [key, status] of [[config.serviceKey, 200], [config.anonKey, 401]]) {
    const res = await fetch(api + '/rest/v1/pending_session_retired_generations?select=session_generation&limit=1', {
      headers: { apikey: config.anonKey, Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    assert.equal(res.status, status); await res.arrayBuffer();
  }
  const readiness = await request('/api/settlement?month=2026-10');
  assert.equal(readiness.response.headers.get('x-local-staging-uat'), 'real');
  assert.equal(readiness.response.status, 401, 'Money smoke requires unclocked Next process');
  phase('genuine-gotrue-users-and-ssr-cookies');
  const admin = await authCookies(config, 'admin', true);
  const operator = await authCookies(config, 'operator');
  const spoof = await authCookies(config, 'spoof', false, true);
  const authenticatedRetiredRead = await fetch(api + '/rest/v1/pending_session_retired_generations?select=session_generation&limit=1', {
    headers: { apikey: config.anonKey, Authorization: `Bearer ${operator.bearer}` },
    redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  assert.ok([401, 403].includes(authenticatedRetiredRead.status)); await authenticatedRetiredRead.arrayBuffer();
  for (const path of ['/api/settlement?month=2026-10', `/api/settlement/yod-song?${yodQuery}`,
    `/api/white-sheet?${query}`, '/api/pdf/financial-summary?month=2026-10']) {
    await expectJson(path, '', undefined, 401);
  }
  const bearerOnly = await request('/api/settlement?month=2026-10', '', undefined, { Authorization: `Bearer ${admin.bearer}` });
  assert.equal(bearerOnly.response.status, 401);
  for (const user of [operator, spoof]) await expectJson('/api/white-sheet/finalize', user.cookie, scope, 403);
  phase('seed-real-backing-tables-and-submit-cash');
  verify();
  sql(readFileSync(join(root, 'supabase/tests/staging_auth_finance_seed.sql'), 'utf8'));
  const submitted = await expectJson('/api/white-sheet', operator.cookie, { ...scope,
    labor: 0, locationFee: 0, bag: 0, snack: 0, other: 0, actualCashSubmitted: 70 }, 200);
  assert.equal(submitted.entryStatus, 'submitted');
  assert.equal(submitted.summary.actualCashSubmitted, 70);
  const blocked = async () => {
    const yod = await expectJson(`/api/settlement/yod-song?${yodQuery}`, operator.cookie, undefined, 200);
    assert.equal(yod.produceValueStatus, 'blocked'); assert.equal(yod['ยอดส่ง'], null);
    const page = await expectJson(`/api/white-sheet?${query}`, operator.cookie, undefined, 200);
    assert.ok(page.summary.warnings.some(w => w.startsWith('ข้อมูลชั่งคืน/รายการของตลาดนี้ยังไม่ครบหรือยังไม่ผ่านการตรวจ')));
  };
  await blocked();
  const before = snapshot(cashTables);
  phase('forbidden-and-hard-stop-no-mutation');
  for (const user of [operator, spoof]) {
    await expectJson('/api/white-sheet/finalize', user.cookie, scope, 403);
    assert.deepEqual(snapshot(cashTables), before);
  }
  await expectJson('/api/white-sheet/finalize', admin.cookie, scope, 409);
  assert.deepEqual(snapshot(cashTables), before);
  phase('retain-failure-through-generation-rotation');
  verify(); sql(readFileSync(join(root, 'supabase/tests/staging_auth_finance_rotate.sql'), 'utf8'));
  const retained = JSON.parse(sql(sqlGuard + "SELECT to_jsonb(t) FROM public.pending_session_retired_generations t WHERE session_generation='61090000-0000-4000-8000-000000000006';"));
  await blocked();
  await expectJson('/api/white-sheet/finalize', admin.cookie, scope, 409);
  assert.deepEqual(snapshot(cashTables), before);
  phase('later-matching-return-and-admin-finalize');
  verify(); sql(readFileSync(join(root, 'supabase/tests/staging_auth_finance_correct.sql'), 'utf8'));
  const yod = await expectJson(`/api/settlement/yod-song?${yodQuery}`, operator.cookie, undefined, 200);
  assert.equal(yod.produceValueStatus, 'complete'); assert.equal(yod['ยอดส่ง'], 70);
  const page = await expectJson(`/api/white-sheet?${query}`, operator.cookie, undefined, 200);
  assert.equal(page.summary.expectedSales, 70); assert.equal(page.summary.expectedCash, 70);
  assert.equal(page.summary.difference, 0); assert.equal(page.summary.status, 'matched');
  const finalized = await expectJson('/api/white-sheet/finalize', admin.cookie, scope, 200);
  assert.equal(finalized.status, 'finalized'); assert.equal(finalized.finalizedBy, admin.id);
  assert.equal(finalized.actualCashSubmitted, 70);
  const after = snapshot(cashTables);
  assert.equal(Number(after.digital_white_sheet_cash_entries.find(row => row.source_id === source).actual_cash_submitted), 70);
  assert.equal(after.white_sheet_lifecycle_events.length, before.white_sheet_lifecycle_events.length + 1);
  assert.deepEqual(JSON.parse(sql(sqlGuard + "SELECT to_jsonb(t) FROM public.pending_session_retired_generations t WHERE session_generation='61090000-0000-4000-8000-000000000006';")), retained);
  const locked = await expectJson(`/api/white-sheet?${query}`, operator.cookie, undefined, 200);
  assert.equal(locked.entryStatus, 'finalized'); assert.equal(locked.finalizedBy, admin.id);
  assert.equal(locked.summary.expectedCash, 70); assert.equal(locked.summary.difference, 0);
  phase('contained-settlement-repeat-upsert');
  const settlementBefore = snapshot(['settlement_finalizations', 'transfer_reconciliations']);
  const body = { settlement_date: scope.date, settlement_time: '', staff_name: 'น้อย', market_name: scope.market,
    money_transfer: 0, money_cash: 70, expenses: 0, labor: 0, notes: 'uat-20261009-finance', notify_line: false };
  const saved = await expectJson('/api/settlement', operator.cookie, body, 200);
  assert.equal(Number(saved.money_cash), 70); assert.equal(saved.lineTargets, 0); assert.equal(saved.lineError, null);
  assert.equal(saved.accountability_round_id, null); assert.equal(saved.source_id, null);
  assert.equal((await expectJson('/api/settlement', operator.cookie, body, 200)).id, saved.id);
  assert.deepEqual(snapshot(['settlement_finalizations', 'transfer_reconciliations']), settlementBefore);
  const entries = await expectJson('/api/settlement?month=2026-10', operator.cookie, undefined, 200);
  assert.ok(entries.some(row => row.id === saved.id && Number(row.money_cash) === 70));
  phase('real-small-fixture-html-pdf');
  for (const path of ['/financial-summary?month=2026-10', '/api/pdf/financial-summary?month=2026-10']) {
    const res = await request(path, operator.cookie);
    assert.equal(res.response.status, 200); assert.ok(res.bytes.length > 0);
    if (path.startsWith('/api/pdf')) {
      assert.match(res.response.headers.get('content-type'), /application\/pdf/);
      assert.equal(res.bytes.subarray(0, 5).toString(), '%PDF-');
    } else assert.match(res.response.headers.get('content-type'), /text\/html/);
  }
  const transport = await settleTransport(output, runIds, transportBefore);
  assert.equal(transport.filter(row => row.kind === 'line-captured').length, 0);
  assert.equal(transport.filter(row => row.kind === 'denied').length, 0);
  console.log('REAL_LOCAL_AUTH_FINANCE_SMOKE_PASSED; small seeded fixture, no LINE delivery or monthly performance claim.');
  writeFileSync(join(output, 'money-result.json'), JSON.stringify({ passed: true, database, mode: 'real-local-http-db',
    money: 70, adminId: admin.id, retiredFailurePreserved: true, monthlyPerformanceMeasured: false }) + '\n');
}
async function cutoffHost() {
  verify();
  const config = runtimeConfig();
  const { rest } = verify(); assert.equal(config.jwtSecret, rest.PGRST_JWT_SECRET);
  installGuard();
  const state = JSON.parse(readFileSync(join(output, 'server-state.json'), 'utf8'));
  const runIds = [process.env.STAGING_UAT_RUN_ID, state.runId];
  const transportBefore = transportMark(output, runIds);
  serverRunId = state.runId;
  const readiness = await request('/api/settlement?month=2026-10');
  const clock = readiness.response.headers.get('x-local-staging-uat');
  assert.ok(['2026-10-08T20:59:00.000Z', '2026-10-08T21:00:00.000Z', '2026-10-08T21:05:00.000Z'].includes(clock));
  const suffix = clock.slice(11, 16).replace(':', '');
  const cutoffSource = `uat-20261009-cutoff-${suffix}`;
  const user = `uat-20261009-cutoff-user-${suffix}`;
  const key = `group:${cutoffSource}:user:${user}`;
  const event = `uat-20261009-cutoff-event-${suffix}`;
  const text = 'น้อย-ราชพฤกษ์ ชั่งคืน\n1.มังคุด45บาท\n4โล\nจบรายการชั่งคืน';
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  function inventory(expected) {
    const rows = JSON.parse(sql(sqlGuard + `SELECT jsonb_build_object(
      'pending',(SELECT coalesce(jsonb_agg(jsonb_build_object('key',session_key,'generation',session_generation)),'[]')
        FROM public.pending_sessions WHERE NOT terminalized),
      'notifications',(SELECT count(*) FROM public.produce_session_notifications),
      'deferred',(SELECT count(*) FROM public.pending_produce_deferred_events),
      'queue',(SELECT count(*) FROM public.line_webhook_event_queue));`));
    assert.deepEqual(rows.pending, expected);
    assert.equal(rows.notifications, 0); assert.equal(rows.deferred, 0); assert.equal(rows.queue, 0);
  }
  phase(`cutoff-process-clock-${suffix}-inventory`);
  inventory([]);
  assert.equal(sql(sqlGuard + "SELECT clock_timestamp() > timestamptz '2026-10-08T20:00:30Z';").trim(), 't',
    'Real SQL close deadline must already have elapsed');
  const before = snapshot(moneyTables);
  // Named RPC creates genuine admission/ingest/close authority; dates do not fake SQL now().
  const opened = JSON.parse(sql(sqlGuard + `BEGIN;
    INSERT INTO public.raw_messages(line_event_id,destination,event_type,source_type,source_id,user_id,message_type,raw_text,payload,is_processed,created_at)
    VALUES (${quote(event)},'uat-20261009-channel','message','group',${quote(cutoffSource)},${quote(user)},'text',${quote(text)},
      jsonb_build_object('timestamp',extract(epoch FROM timestamptz '2026-10-08T20:00:00Z')*1000),true,'2026-10-08T20:00:00Z');
    SELECT public.open_pending_plain_text_generation(
      p_session_key=>${quote(key)},p_source_id=>${quote(cutoffSource)},p_line_user_id=>${quote(user)},
      p_line_event_id=>${quote(event)},p_line_timestamp_ms=>${Date.parse('2026-10-08T20:00:00Z')},
      p_raw_text=>${quote(text)},p_reply_token=>NULL,p_mark_close=>true,p_expected_item_count=>1,
      p_expected_session_generation=>NULL,p_runtime_environment=>'development');
    COMMIT;`));
  assert.equal(opened.opened, true);
  const generation = opened.session.session_generation;
  assert.match(generation, /^[a-f0-9-]{36}$/);
  sql(sqlGuard + `DO $$ DECLARE n integer; BEGIN
    UPDATE public.pending_sessions SET created_at='2026-10-08T20:00:00Z',close_requested_at='2026-10-08T20:00:00Z',
      next_attempt_at='2026-10-08T20:00:08Z',close_deadline_at='2026-10-08T20:00:30Z',updated_at=clock_timestamp()
      WHERE session_key=${quote(key)} AND session_generation=${quote(generation)};
    GET DIAGNOSTICS n=ROW_COUNT;
    IF n<>1 THEN RAISE EXCEPTION 'Exact cutoff fixture missing'; END IF;
  END $$;`);
  inventory([{ key, generation }]);
  const cron = '/api/cron/finalize-pending-produce-sessions';
  phase(`cutoff-process-clock-${suffix}-local-finalizer`);
  const res = await request(cron, '', undefined, { Authorization: `Bearer ${config.cronSecret}` });
  assert.equal(res.response.status, 200);
  const result = res.json();
  assert.equal(result.due, 1); assert.equal(result.failedClosed, 1);
  assert.equal(result.finalized, 0); assert.equal(result.errors, 0);
  const pending = JSON.parse(sql(sqlGuard + `SELECT to_jsonb(t) FROM public.pending_sessions t WHERE session_key=${quote(key)};`));
  assert.equal(pending.session_generation, generation); assert.equal(pending.terminalized, true);
  assert.equal(pending.finalization_status, 'failed_closed'); assert.equal(pending.accountability_round_id, null);
  assert.equal(pending.finalized_produce_session_id, null);
  assert.ok(JSON.stringify(pending.finalization_error).includes('business date ambiguous: undated document near the 04:00 cutoff'));
  // Capture remains active during Next after(); a short bounded settle precedes inventory/snapshot checks.
  let transport = await settleTransport(output, runIds, transportBefore, 1);
  inventory([]); assert.deepEqual(snapshot(moneyTables), before);
  assert.equal(transport.filter(row => row.kind === 'denied').length, 0);
  const messages = transport.filter(row => row.kind === 'line-captured' && row.to === cutoffSource);
  assert.equal(messages.length, 1); assert.ok(JSON.stringify(messages[0].messages).includes('04:00'));
  const repeated = await request(cron, '', undefined, { Authorization: `Bearer ${config.cronSecret}` });
  assert.equal(repeated.response.status, 200); assert.equal(repeated.json().due, 0);
  transport = await settleTransport(output, runIds, transportBefore, 1);
  inventory([]); assert.deepEqual(snapshot(moneyTables), before);
  assert.equal(transport.filter(row => row.kind === 'line-captured').length, 1);
  assert.equal(transport.filter(row => row.kind === 'denied').length, 0);
  writeFileSync(join(output, `cutoff-${suffix}-result.json`), JSON.stringify({ passed: true, clock,
    processClockOnly: true, databaseClock: 'real', lineTransport: 'simulated-200-captured-no-send',
    unchangedMoneyTables: moneyTables }) + '\n');
  console.log(`REAL_LOCAL_CUTOFF_${suffix}_PASSED; process clock only; LINE response simulated, no delivery.`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('LOCAL_UAT_FAILED: inspect the named phase privately; no secrets emitted.'); process.exitCode = 1; });
}
