import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { childEnvironment, database, dbUrl, jwt, names, validateConfig, validateContainers } from './staging-auth-finance.mjs';

const secret = 'SYNTHETIC-UAT-ONLY-' + 'a'.repeat(64);
const config = { api: 'http://127.0.0.1:56321', database, jwtSecret: secret,
  anonKey: jwt(secret, 'anon'), serviceKey: jwt(secret, 'service_role'),
  cronSecret: 'SYNTHETIC-UAT-ONLY-' + 'b'.repeat(48) };
const network = 'botsummary-uat-loopback-20261009';
function samples() {
  const containers = Object.fromEntries(Object.entries(names).map(([kind, name]) => [kind, {
    Name: '/' + name, State: { Status: 'running', Health: { Status: 'healthy' } },
    Mounts: [{ Type: 'volume', Name: 'botsummary-uat-pgdata-20261009', Destination: '/var/lib/postgresql/data' }],
    Config: { Env: [], Labels: { 'com.docker.compose.project': 'botsummary-compose-uat-20261009' } },
    NetworkSettings: { Networks: { [network]: {} }, Ports: {} },
  }]));
  for (const [kind, internal, port] of [['db', '5432/tcp', '56322'], ['gateway', '80/tcp', '56321'], ['fullRest', '3000/tcp', '56331']]) {
    containers[kind].NetworkSettings.Ports[internal] = [{ HostIp: '127.0.0.1', HostPort: port }];
  }
  const uri = role => `postgres://${role}:synthetic@${names.db}:5432/${database}`;
  containers.auth.Config.Env = [`GOTRUE_DB_DATABASE_URL=${uri('botsummary_uat_auth')}`, `GOTRUE_JWT_SECRET=${secret}`,
    'GOTRUE_SITE_URL=http://127.0.0.1:56300', 'API_EXTERNAL_URL=http://127.0.0.1:56321', 'GOTRUE_DB_NAMESPACE=auth',
    'GOTRUE_JWT_AUD=authenticated', 'GOTRUE_JWT_ADMIN_ROLES=service_role'];
  for (const [kind, role] of [['rest', 'botsummary_uat_rest'], ['fullRest', 'botsummary_replay_rest_20261009']]) {
    containers[kind].Config.Env = [`PGRST_DB_URI=${uri(role)}`, `PGRST_JWT_SECRET=${secret}`, 'PGRST_DB_SCHEMAS=public', 'PGRST_DB_ANON_ROLE=anon'];
  }
  return { containers, owned: { Name: network, Driver: 'bridge', Containers: Object.fromEntries(Object.values(names).map(name => [name, { Name: name }])) } };
}
test('owned runtime guard accepts only the exact five services and synthetic DB wiring', () => {
  const { containers, owned } = samples();
  validateContainers(containers, owned, database);
  for (const mutate of [
    c => { c.db.NetworkSettings.Ports['5432/tcp'][0].HostIp = '0.0.0.0'; },
    c => { c.db.NetworkSettings.Ports['5432/tcp'][0].HostPort = '5432'; },
    c => { c.auth.NetworkSettings.Ports['9999/tcp'] = [{ HostIp: '127.0.0.1', HostPort: '56399' }]; },
    c => { c.fullRest.NetworkSettings.Networks.extra = {}; },
    c => { c.gateway.Config.Labels['com.docker.compose.project'] = 'other'; },
    c => { c.auth.Config.Env[1] = 'GOTRUE_JWT_SECRET=different'; },
    c => { c.rest.Config.Env[0] = c.rest.Config.Env[0].replace(database, 'production'); },
  ]) {
    const changed = structuredClone(containers); mutate(changed);
    assert.throws(() => validateContainers(changed, owned, database));
  }
  const extra = structuredClone(owned); extra.Containers.other = { Name: 'unrelated' };
  assert.throws(() => validateContainers(containers, extra, database));
  assert.throws(() => dbUrl('postgres://botsummary_uat_auth:synthetic@remote.invalid:5432/' + database, 'botsummary_uat_auth', database));
});
test('child environment clears inherited and dotenv app secrets, fixes local keys and rejects unsafe clocks', () => {
  const env = childEnvironment({ PATH: 'local', SystemRoot: 'C:/Windows', NODE_OPTIONS: '--require malicious',
    ADMIN_USER_IDS: 'real-admin', HTTP_PROXY: 'remote', OPENAI_API_KEY: 'real-key', LINE_CHANNEL_ACCESS_TOKEN: 'real-token' },
  config, ['ADMIN_USER_IDS', 'OPENAI_API_KEY', 'CUSTOM_REMOTE_URL']);
  assert.equal(env.PATH, 'local'); assert.equal(env.ADMIN_USER_IDS, ''); assert.equal(env.OPENAI_API_KEY, '');
  assert.equal(env.CUSTOM_REMOTE_URL, ''); assert.equal(env.LINE_CHANNEL_ACCESS_TOKEN, 'SYNTHETIC-UAT-ONLY');
  assert.equal(env.NEXT_PUBLIC_SUPABASE_URL, config.api); assert.equal(env.HTTP_PROXY, undefined);
  assert.equal(env.CRON_SECRET, ''); assert.equal(env.VERCEL_ENV, 'development');
  assert.ok(!env.NODE_OPTIONS.includes('malicious'));
  assert.throws(() => childEnvironment({}, config, [], '2026-10-09T00:00:00Z'));
  assert.throws(() => validateConfig({ ...config, api: 'https://remote.invalid' }));
  assert.throws(() => validateConfig({ ...config, serviceKey: config.anonKey }));
});
function isolated(code, clock = '') {
  const result = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 10000,
    cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, NODE_OPTIONS: '', STAGING_UAT_CLOCK: clock } });
  assert.equal(result.status, 0, result.stderr);
}
test('preload denies external fetch, sockets, DNS, UDP and wrong local ports before transport', () => {
  isolated(`const assert=require('node:assert/strict'); require('./scripts/staging-auth-finance-preload.cjs');
    (async()=>{
      for(const url of ['https://api.line.me/unknown','https://api-data.line.me/content','https://api.openai.com/v1',
        'http://127.0.0.1:5432','http://localhost:56321','http://127.0.0.1:56321@remote.invalid/']) {
        await assert.rejects(fetch(url),/transport denied/);
      }
      assert.throws(()=>require('node:net').connect({host:'remote.invalid',port:443}),/transport denied/);
      assert.throws(()=>require('node:net').connect('unsafe-pipe'),/transport denied/);
      assert.throws(()=>require('node:tls').connect({host:'remote.invalid',port:443}),/transport denied/);
      assert.throws(()=>require('node:http2').connect('https://remote.invalid'),/transport denied/);
      assert.throws(()=>require('node:dns').lookup('remote.invalid',()=>{}),/transport denied/);
      assert.throws(()=>new (require('node:dns').Resolver)().resolve4('remote.invalid',()=>{}),/transport denied/);
      assert.throws(()=>new (require('node:dns').promises.Resolver)().resolve4('remote.invalid'),/transport denied/);
      assert.throws(()=>require('node:dgram').createSocket('udp4'),/transport denied/);
      const udp=new (require('node:dgram').Socket)('udp4');
      assert.throws(()=>udp.send('x',53,'192.0.2.1'),/transport denied/); udp.close();
    })().catch(e=>{console.error(e);process.exitCode=1;});`);
});
test('preload accepts embedded WASM and captures only synthetic LINE POSTs with secrets omitted', () => {
  isolated(`const assert=require('node:assert/strict'); const fs=require('node:fs');
    require('./scripts/staging-auth-finance-preload.cjs');
    (async()=>{
      const wasm=await fetch('data:application/octet-stream;base64,AGFzbQEAAAA=');
      assert.equal(Buffer.from(await wasm.arrayBuffer()).toString('hex'),'0061736d01000000');
      for(const endpoint of ['push','reply']) {
        const body={messages:[{type:'text',text:'synthetic cutoff 04:00'}],
          ...(endpoint==='push'?{to:'uat-20261009-test'}:{replyToken:'uat-20261009-secret-reply'})};
        const res=await fetch('https://api.line.me/v2/bot/message/'+endpoint,{method:'POST',
          headers:{Authorization:'Bearer secret-credential','X-Line-Retry-Key':'synthetic-retry'},body:JSON.stringify(body)});
        assert.equal(res.status,200);
      }
      await assert.rejects(fetch('https://api.line.me/v2/bot/message/push',{method:'POST',body:JSON.stringify({to:'real-target',messages:[]})}),/transport denied/);
      const log=fs.readFileSync('.tmp-staging-uat-20261009/auth-finance/transport-'+process.pid+'.jsonl','utf8');
      assert.ok(!log.includes('secret-credential')); assert.ok(!log.includes('secret-reply'));
      assert.equal(log.split('line-captured').length-1,2);
    })().catch(e=>{console.error(e);process.exitCode=1;});`);
});
test('all cutoff process clocks preserve explicit dates and monotonic elapsed time', () => {
  for (const clock of ['2026-10-08T20:59:00.000Z', '2026-10-08T21:00:00.000Z', '2026-10-08T21:05:00.000Z']) {
    isolated(`const assert=require('node:assert/strict'); const started=performance.now();
      require('./scripts/staging-auth-finance-preload.cjs');
      assert.equal(new Date().toISOString(),process.env.STAGING_UAT_CLOCK);
      assert.equal(Date.now(),Date.parse(process.env.STAGING_UAT_CLOCK));
      assert.equal(Object.hasOwn(Date,'parse'),true);
      assert.equal(Object.hasOwn(Date,'UTC'),true);
      assert.equal(Date(),new Date(process.env.STAGING_UAT_CLOCK).toString());
      assert.equal(new Date('2020-01-01T00:00:00Z').toISOString(),'2020-01-01T00:00:00.000Z');
      assert.ok(Number.isNaN(new Date(undefined).getTime()));
      assert.equal(Date.UTC(2020,0,1),1577836800000);
      assert.ok(performance.now()>=started);`, clock);
  }
});
