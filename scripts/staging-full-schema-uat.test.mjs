import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validateFullStack, database } from './staging-full-schema-uat.mjs';
import { financeFixture } from './staging-final-finance.mjs';
import { applyCookies, percentile, assertMonthlyHtml, pdfTextItems, pdfTextRuns } from './staging-session-month.mjs';

function sample() {
  const network = 'botsummary-uat-loopback-20261009';
  const names = { db: 'botsummary-uat-postgres-20261009', auth: 'botsummary-full-auth-20261009',
    rest: 'botsummary-full-rest-20261009', gateway: 'botsummary-full-gateway-20261009' };
  const secret = 'synthetic-test-only';
  const uri = role => `postgres://${role}:synthetic@${names.db}:5432/${database}`;
  const objects = Object.fromEntries(Object.entries(names).map(([kind, name]) => [kind, {
    Name: '/' + name, State: { Status: 'running', Health: { Status: 'healthy' } },
    Mounts: [{ Type: 'volume', Name: 'botsummary-uat-pgdata-20261009', Destination: '/var/lib/postgresql/data' }],
    Config: { Env: [] }, NetworkSettings: { Networks: { [network]: {} }, Ports: kind === 'db'
      ? { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '56322' }] }
      : kind === 'gateway' ? { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '56343' }] } : {} },
  }]));
  objects.auth.Config.Env = [`GOTRUE_DB_DATABASE_URL=${uri('local_auth')}`, `GOTRUE_JWT_SECRET=${secret}`];
  objects.rest.Config.Env = [`PGRST_DB_URI=${uri('local_rest')}`, `PGRST_JWT_SECRET=${secret}`, 'PGRST_DB_SCHEMAS=public', 'PGRST_DB_ANON_ROLE=anon'];
  const allNames = [...Object.values(names), 'botsummary-uat-auth-20261009', 'botsummary-uat-rest-20261009',
    'botsummary-uat-gateway-20261009', 'botsummary-replay-rest-20261009'];
  const bridge = { Name: network, Driver: 'bridge', Containers: Object.fromEntries(allNames.map(name => [name, { Name: name }])) };
  const jwt = role => {
    const data = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url') + '.'
      + Buffer.from(JSON.stringify({ role })).toString('base64url');
    return data + '.' + createHmac('sha256', secret).update(data).digest('base64url');
  };
  return { objects, bridge, config: { api: 'http://127.0.0.1:56343', database,
    anonKey: jwt('anon'), serviceKey: jwt('service_role'), cronSecret: 'SYNTHETIC-UAT-ONLY-' + 'a'.repeat(48) } };
}

test('monthly HTML guard matches seeded Thai seller digits and requires the full blocked workload', () => {
  const markers = ['ผู้ขาย๐', 'ผู้ขาย๙', '2026-08-01', '2026-08-31', 'return_incomplete'];
  assertMonthlyHtml(markers.join(' '));
  for (const missing of markers) assert.throws(() => assertMonthlyHtml(markers.filter(value => value !== missing).join(' ')));
  assert.throws(() => assertMonthlyHtml('ผู้ขาย0 ผู้ขาย9 2026-08-01 2026-08-31 return_incomplete'));
  // The existing owned c database was seeded before the Thai-digit fixture edit:
  // its stored seller names have ASCII digits. Host checks bind to those exact
  // rows rather than relaxing the default Thai seed contract or reseeding.
  assertMonthlyHtml('ผู้ขาย0 ผู้ขาย9 2026-08-01 2026-08-31 return_incomplete', ['ผู้ขาย0', 'ผู้ขาย9']);
  assert.throws(() => assertMonthlyHtml('ผู้ขาย0 2026-08-01 2026-08-31 return_incomplete', ['ผู้ขาย0', 'ผู้ขาย9']));
});
function tinyPdf(content, cmap = '1 beginbfchar\n<0001><0E01>\n<0002> <0E32>\nendbfchar', filter = '') {
  const stream = body => `<< /Length ${Buffer.byteLength(body, 'latin1')}${filter} >>\nstream\n${body}\nendstream`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources 4 0 R /Contents 5 0 R >>', '<< /Font << /F1 6 0 R >> >>', stream(content),
    '<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /ToUnicode 7 0 R >>', stream(cmap)];
  let pdf = '%PDF-1.3\n';
  const offsets = objects.map((body, index) => { const at = pdf.length; pdf += `${index + 1} 0 obj\n${body}\nendobj\n`; return at; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map(at => `${String(at).padStart(10, '0')} 00000 n \n`).join('')
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
test('PDF text decoder reads Identity-H glyph runs and fails closed on anything it cannot decode', () => {
  assert.deepEqual(pdfTextRuns(tinyPdf('BT\n/F1 8 Tf\n[<0001> 12 <0002>] TJ\nET\nBT\n/F1 8 Tf\n<0002> Tj\nET')), ['กา', 'า']);
  // Positions compose cm (q/Q scoped) with the first Tm, as the renderer's rows do.
  assert.deepEqual(pdfTextItems(tinyPdf('q\n1 0 0 1 10 20 cm\nq\n1 0 0 -1 0 800 cm\nBT\n1 0 0 1 5 790 Tm\n/F1 8 Tf\n<0001> Tj\n'
    + '1 0 0 1 9 790 Tm\n<0002> Tj\nET\nQ\nQ\nBT\n/F1 8 Tf\n<0002> Tj\nET')),
  [{ page: 1, x: 15, y: 30, text: 'กา' }, { page: 1, x: 0, y: 0, text: 'า' }]);
  for (const [bad, message] of [
    [tinyPdf('BT\n/F1 8 Tf\n<0003> Tj\nET'), /Unmapped PDF glyph 0003/],
    [tinyPdf('BT\n/F1 8 Tf\n(ok) Tj\nET'), /Unsupported PDF text operator \(/],
    [tinyPdf('BT\n/F1 8 Tf\n1 2 Td\n<0001> Tj\nET'), /Unsupported PDF text operator Td/],
    [tinyPdf('q\nBT\n/F1 8 Tf\n<0001> Tj\nET'), /Unbalanced PDF graphics state/],
    [tinyPdf('1 0 0 1 0 0 Tm\nBT\n/F1 8 Tf\n<0001> Tj\nET'), /PDF Tm outside text object/],
    [tinyPdf('BT\n/F2 8 Tf\n<0001> Tj\nET'), /F2 reference missing/],
    [tinyPdf('BT\n/F1 8 Tf\n<0001> Tj\n'), /Unterminated PDF text object/],
    [tinyPdf('BT\n/F1 8 Tf\n<0001> Tj\nET', undefined, ' /Filter /ASCIIHexDecode'), /Unsupported PDF stream filter/],
    [tinyPdf('BT\n/F1 8 Tf\nET', '1 beginbfrange\n<0001> <0002> <0E01>\nendbfrange'), /Unsupported ToUnicode bfrange/],
    [Buffer.from('%PDF-1.3\n%%EOF\n'), /cross-reference/],
  ]) assert.throws(() => pdfTextRuns(bad), message);
});
test('c ownership guard rejects wrong interfaces, database, network members and signing keys', () => {
  const good = sample(); validateFullStack(good.objects, good.bridge, good.config);
  for (const mutate of [
    value => { value.objects.gateway.NetworkSettings.Ports['80/tcp'][0].HostIp = '0.0.0.0'; },
    value => { value.objects.db.NetworkSettings.Ports['5432/tcp'][0].HostPort = '5432'; },
    value => { value.objects.auth.Config.Env[0] = value.objects.auth.Config.Env[0].replace(database, 'production'); },
    value => { value.bridge.Containers.extra = { Name: 'unrelated' }; },
    value => { value.objects.rest.NetworkSettings.Networks.extra = {}; },
    value => { value.config.serviceKey = value.config.anonKey; },
    value => { value.config.serviceKey += 'x'; },
    value => { value.objects.rest.Config.Env[1] = 'PGRST_JWT_SECRET=unrelated'; },
  ]) {
    const changed = structuredClone(good); mutate(changed);
    assert.throws(() => validateFullStack(changed.objects, changed.bridge, changed.config));
  }
});
test('finance fixture adaptation preserves SQL guards and moves the complete namespace/day', () => {
  for (const name of ['seed', 'rotate', 'correct']) {
    const original = readFileSync(`supabase/tests/staging_auth_finance_${name}.sql`, 'utf8');
    const changed = financeFixture(original);
    assert.ok(changed.includes(database)); assert.ok(changed.includes('61100000'));
    for (const stale of ['61090000', 'uat-20261009-finance', '2026-10-07', '7/10/2569']) assert.ok(!changed.includes(stale));
    assert.ok(changed.includes("current_user <> 'postgres'"));
    assert.ok(changed.includes('BETWEEN 170000 AND 179999'));
  }
  assert.throws(() => financeFixture('SELECT 1;'));
});
test('response cookie jar preserves replacement chunks and handles deletion; percentile uses nearest rank', () => {
  const jar = new Map([['sb-test.0', 'old'], ['sb-test.1', 'stale']]);
  const headers = new Headers();
  headers.append('set-cookie', 'sb-test.0=new; Path=/; SameSite=Lax');
  headers.append('set-cookie', 'sb-test.1=; Max-Age=0; Path=/');
  applyCookies(jar, headers);
  assert.deepEqual([...jar], [['sb-test.0', 'new']]);
  assert.equal(percentile([10, 1, 7, 3, 4, 5, 6, 2, 8, 9], 0.5), 5);
  assert.equal(percentile([10, 1, 7, 3, 4, 5, 6, 2, 8, 9], 0.95), 10);
  assert.throws(() => percentile([], 0.95));
});
