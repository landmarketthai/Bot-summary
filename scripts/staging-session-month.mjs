import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { inflateSync } from 'node:zlib';
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
// Decodes the visible text of the react-pdf/pdfkit report from its bytes: xref
// objects, Flate page content, Identity-H fonts and bfchar ToUnicode CMaps.
// Returns one string per BT..ET text run. Anything outside that contract
// (unknown filter/encoding, unmapped glyph, literal string) throws, never
// returning partial text. ponytail: only the structure our renderer emits.
export function pdfTextItems(bytes) {
  const source = Buffer.from(bytes).toString('latin1');
  assert.ok(source.startsWith('%PDF-'), 'Not a PDF');
  const start = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(source)?.[1]);
  const table = /^xref\s+0 (\d+)\r?\n/.exec(source.slice(start));
  assert.ok(table, 'Unsupported PDF cross-reference');
  const offsets = new Map();
  for (let id = 1; id < Number(table[1]); id++) {
    const entry = /^(\d{10}) \d{5} ([nf])/.exec(source.substr(start + table[0].length + id * 20, 20));
    assert.ok(entry, 'Malformed PDF cross-reference entry');
    if (entry[2] === 'n') offsets.set(String(id), Number(entry[1]));
  }
  const ref = (dict, key) => {
    const id = new RegExp(`/${key}\\s+(\\d+) 0 R`).exec(dict)?.[1];
    assert.ok(id, `PDF /${key} reference missing`); return id;
  };
  const read = id => {
    const at = offsets.get(id), head = new RegExp(`^${id} 0 obj\\s*`).exec(source.slice(at, at + 32));
    assert.ok(head, `PDF object ${id} missing`);
    const body = source.slice(at + head[0].length), end = body.search(/\bstream\r?\n|\bendobj\b/);
    const dict = body.slice(0, end), stream = /^stream\r?\n/.exec(body.slice(end));
    if (!stream) return { dict };
    const length = Number(/\/Length (\d+)(?!\s+\d+\s+R)/.exec(dict)?.[1]);
    assert.ok(Number.isInteger(length), 'PDF stream length must be direct');
    const raw = Buffer.from(body.substr(end + stream[0].length, length), 'latin1');
    const filter = /\/Filter\s*(\/\w+|\[)/.exec(dict)?.[1];
    assert.ok(!filter || filter === '/FlateDecode', 'Unsupported PDF stream filter');
    return { dict, data: filter ? inflateSync(raw) : raw };
  };
  const unicode = new Map();
  const cmapFor = fontId => {
    if (!unicode.has(fontId)) {
      const font = read(fontId).dict;
      assert.match(font, /\/Encoding\s*\/Identity-H/, 'Unsupported PDF font encoding');
      const cmap = read(ref(font, 'ToUnicode')).data.toString('latin1'), map = new Map();
      assert.ok(!/beginbfrange/.test(cmap), 'Unsupported ToUnicode bfrange');
      for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
        for (const [, code, text] of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F\s]*)>/g)) {
          map.set(code.toLowerCase().padStart(4, '0'), Buffer.from(text.replace(/\s/g, ''), 'hex').swap16().toString('utf16le'));
        }
      }
      unicode.set(fontId, map);
    }
    return unicode.get(fontId);
  };
  const items = [];
  const kids = /\/Kids\s*\[([^\]]*)\]/.exec(read(ref(read(ref(source.slice(source.lastIndexOf('trailer')), 'Root')).dict, 'Pages')).dict)?.[1];
  assert.ok(kids, 'PDF page tree missing');
  // Row vector convention: [a b c d e f] maps (x, y) to (ax + cy + e, bx + dy + f).
  const times = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
  let page = 0;
  for (const [, pageId] of kids.matchAll(/(\d+) 0 R/g)) {
    const pageDict = read(pageId).dict;
    assert.match(pageDict, /\/Type\s*\/Page\b/, 'Nested PDF page trees are unsupported');
    const fonts = /\/Font\s*<<([^>]*)>>/.exec(read(ref(pageDict, 'Resources')).dict)?.[1] ?? '';
    const content = read(ref(pageDict, 'Contents')).data.toString('latin1');
    let map, run = null, ctm = [1, 0, 0, 1, 0, 0], tm, at;
    const stack = [];
    page++;
    for (const [op, matrix, matrixOp, font, array, single, unsupported] of content.matchAll(
      /(?<![\d.])((?:-?[\d.]+\s+){6})(cm|Tm)\b|\/(\S+)\s+[-\d.]+\s+Tf|\[([^\]]*)\]\s*TJ|<([0-9a-fA-F]*)>\s*Tj|\b(?:BT|ET)\b|(?<![\w/])[qQ](?!\w)|(\bT[dD*]|\(|')/g)) {
      assert.equal(unsupported, undefined, `Unsupported PDF text operator ${unsupported}`);
      if (op === 'q') stack.push(ctm);
      else if (op === 'Q') { assert.ok(stack.length, 'Unbalanced PDF graphics state'); ctm = stack.pop(); }
      else if (op === 'BT') { assert.equal(run, null, 'Nested PDF text object'); run = ''; tm = [1, 0, 0, 1, 0, 0]; at = undefined; }
      else if (op === 'ET') { assert.ok(run !== null, 'Unbalanced PDF text object'); items.push({ page, ...at, text: run }); run = null; }
      else if (matrix) {
        const m = matrix.trim().split(/\s+/).map(Number);
        assert.ok(m.every(Number.isFinite), 'Malformed PDF matrix');
        if (matrixOp === 'cm') ctm = times(m, ctm);
        else { assert.ok(run !== null, 'PDF Tm outside text object'); tm = m; }
      } else if (font) map = cmapFor(ref(fonts, font));
      else {
        assert.ok(map && run !== null, 'PDF text shown without font or text object');
        // A run is positioned by its first glyph's device-space origin.
        if (!at) { const [, , , , x, y] = times(tm, ctm); at = { x, y }; }
        for (const [, hex] of (array ?? `<${single}>`).matchAll(/<([0-9a-fA-F]*)>/g)) {
          assert.equal(hex.length % 4, 0, 'Odd Identity-H glyph string');
          for (const code of hex.toLowerCase().match(/.{4}/g) ?? []) {
            assert.ok(map.has(code), `Unmapped PDF glyph ${code}`); run += map.get(code);
          }
        }
      }
    }
    assert.equal(run, null, 'Unterminated PDF text object');
    assert.equal(stack.length, 0, 'Unbalanced PDF graphics state');
  }
  return items;
}
export const pdfTextRuns = bytes => pdfTextItems(bytes).map(item => item.text);
// FinancialSummaryDoc draws each table row (wrap={false}, never split across
// pages) as 13 content-width cells on one shared baseline, so a row is every
// run on one page within 0.5pt of the same y, read left to right. Cells may
// split into several runs by script ("1 " + "ส.ค. 69", "ตลาด" + "A 1"), so a
// row must start with runs that concatenate exactly to the date, then exactly
// to the seller (no prefix/longer label); the market has free-form runs. The
// last ten runs are the fixed financial cells เบิก คืน คืนเสีย ยอดส่ง เงินโอน
// เงินสด ค่าใช้จ่าย ค่าแรง ยอดขาย ขาด/เกิน, each one run. Both
// return_incomplete and returns_exceed_withdrawal render ยอดส่ง and ขาด/เกิน
// as ตรวจสอบ, so the PDF cannot tell those statuses apart; it can prove that
// every row for the protected seller/date shows no certified value there.
// A ตรวจสอบ elsewhere (another row, the footer, a market name) never counts.
const PDF_AMOUNT = /^[-+]?\d{1,3}(?:,\d{3})*\.\d{2}$/;
/**
 * @param {Uint8Array | Buffer} bytes
 * @param {string[]} [sourceSellerLabels]
 * @param {{ month?: string, firstDate?: string, lastDate?: string, expectedRows?: string[][] | null }} [options]
 */
export function assertMonthlyPdf(bytes, sourceSellerLabels = ['ผู้ขาย๐', 'ผู้ขาย๙'],
  { month = 'สิงหาคม 2569', firstDate = '1 ส.ค. 69', lastDate = '31 ส.ค. 69', expectedRows = null } = {}) {
  assert.equal(sourceSellerLabels.length, 2, 'Expected first/last sellers from seeded source');
  const items = pdfTextItems(bytes).filter(item => item.text);
  const runs = items.map(item => item.text);
  for (const value of ['สรุปการเงิน', month]) assert.ok(runs.includes(value), `Monthly PDF text missing: ${value}`);
  const rows = [];
  for (const item of [...items].sort((a, b) => a.page - b.page || b.y - a.y)) {
    const row = rows.at(-1);
    if (row?.page === item.page && Math.abs(row.y - item.y) < 0.5) row.items.push(item);
    else rows.push({ page: item.page, y: item.y, items: [item] });
  }
  const cellEnd = (texts, start, value) => {
    for (let index = start, text = ''; index < texts.length && text.length < value.length; index++) {
      text += texts[index]; if (text === value) return index + 1;
    }
    return -1;
  };
  // The host passes all authoritative date/seller identities from its isolated
  // synthetic rounds: a certified middle row must not escape first/last checks.
  const protectedRows = expectedRows ?? [[firstDate, sourceSellerLabels[0]], [lastDate, sourceSellerLabels[1]]];
  assert.equal(new Set(protectedRows.map(([date, seller]) => `${date}|${seller}`)).size, protectedRows.length,
    'Duplicate source date/seller identity');
  for (const [date, seller] of protectedRows) {
    let found = 0;
    for (const row of rows) {
      const texts = row.items.sort((a, b) => a.x - b.x).map(item => item.text);
      const afterDate = cellEnd(texts, 0, date), market = afterDate > 0 ? cellEnd(texts, afterDate, seller) : -1;
      if (market < 0) continue;
      found++;
      // At least one market run, then exactly the ten financial cells.
      assert.ok(texts.length - market > 10 && texts.slice(-10).every((text, index) =>
        index === 3 || index === 9 ? text === 'ตรวจสอบ' : PDF_AMOUNT.test(text)),
      `Monthly PDF row not provisional: ${date} ${seller}: ${texts.join(' | ')}`);
    }
    assert.equal(found, 1, `Monthly PDF row missing or duplicated: ${date} ${seller}`);
  }
  return runs;
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
  // Validate all 310 real source identities, not only the first/last seller.
  // A certified return on any middle day must fail this host PDF gate.
  const sourceRows = JSON.parse(sql(`SELECT coalesce(jsonb_agg(
    jsonb_build_object('day', extract(day FROM business_date)::int, 'seller', seller_label)
    ORDER BY business_date, owner_line_user_id), '[]'::jsonb)
    FROM public.accountability_rounds WHERE source_id='uat-20261010-month31';`));
  assert.equal(sourceRows.length, counts.rounds, 'Synthetic source row count changed');
  const pdfExpectedRows = sourceRows.map(({ day, seller }) => {
    assert.ok(Number.isInteger(day) && day >= 1 && day <= 31, 'Invalid source August day');
    assert.match(seller, /^ผู้ขาย[0-9๐-๙]$/, 'Unexpected source seller label');
    return [`${day} ส.ค. 69`, seller];
  });
  assert.equal(new Set(pdfExpectedRows.map(([date, seller]) => `${date}|${seller}`)).size, 310,
    'Missing or duplicated synthetic source seller/date');
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
      if (pdf) {
        assert.equal(result.bytes.subarray(0, 5).toString(), '%PDF-');
        assertMonthlyPdf(result.bytes, sourceSellerLabels, { expectedRows: pdfExpectedRows });
      } else {
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
