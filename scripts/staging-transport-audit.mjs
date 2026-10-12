// Test-only accounting. Each explicit run includes its inherited Node workers.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const observed = new WeakMap();

export function transportDirectory(output, runId) {
  assert.match(runId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/, 'Require guard run UUID');
  return join(output, 'transport', runId);
}
function files(output, runIds) {
  return [...new Set(runIds)].flatMap(id => {
    const directory = transportDirectory(output, id);
    assert.ok(existsSync(directory), 'Guard run directory missing');
    return readdirSync(directory).filter(name => /^transport-\d+\.jsonl$/.test(name)).map(name => join(directory, name));
  });
}
function lines(file) {
  const value = readFileSync(file, 'utf8');
  assert.ok(!value || value.endsWith('\n'), 'Incomplete transport audit record');
  if (!value) return [];
  return value.slice(0, -1).split('\n').map(line => {
    assert.ok(line, 'Invalid transport audit record');
    const row = JSON.parse(line);
    assert.ok(row && typeof row === 'object' && !Array.isArray(row)
      && row.runId === basename(dirname(file)) && Number.isSafeInteger(row.pid) && row.pid > 0
      && basename(file) === `transport-${row.pid}.jsonl`, 'Invalid transport audit record identity');
    let fields = ['kind', 'runId', 'pid'];
    if (row.kind === 'guard-loaded') {
      fields = [...fields, 'clock'];
      assert.ok(['real', '2026-10-08T20:59:00.000Z', '2026-10-08T21:00:00.000Z', '2026-10-08T21:05:00.000Z'].includes(row.clock), 'Invalid transport audit record clock');
    } else if (row.kind === 'line-captured') {
      fields = [...fields, 'path', 'to', 'messages', 'retryKey', 'simulated'];
      assert.ok(['/v2/bot/message/push', '/v2/bot/message/reply'].includes(row.path)
        && (row.to === null || typeof row.to === 'string') && Array.isArray(row.messages)
        && (row.retryKey === null || typeof row.retryKey === 'string') && row.simulated === true, 'Invalid transport audit record capture');
    } else assert.equal(row.kind, 'denied', 'Invalid transport audit record kind');
    assert.ok(Object.keys(row).length === fields.length && fields.every(field => Object.hasOwn(row, field)), 'Invalid transport audit record fields');
    return row;
  });
}
export function transportMark(output, runIds) {
  const mark = Object.fromEntries(files(output, runIds).map(file => [file, lines(file).length]));
  observed.set(mark, { ...mark });
  return mark;
}
export function transportRows(output, runIds, mark) {
  assert.ok(mark && observed.has(mark), 'Transport audit requires an explicit baseline');
  const previous = observed.get(mark);
  const current = files(output, runIds);
  assert.ok(Object.keys(previous).every(file => current.includes(file)), 'Observed transport log disappeared');
  const counts = {};
  const rows = current.flatMap(file => {
    const records = lines(file);
    assert.ok(records.length >= (previous[file] ?? 0), 'Transport log truncated during run');
    counts[file] = records.length;
    return records.slice(mark[file] ?? 0);
  });
  observed.set(mark, counts);
  return rows;
}
export async function settleTransport(output, runIds, mark, expectedCaptures = 0) {
  // shortcut: bounded log observation cannot prove arbitrary native/background work ended; use OS containment for that guarantee.
  const start = performance.now();
  let previous = '', quietSince = start;
  while (performance.now() - start < 10000) {
    const rows = transportRows(output, runIds, mark);
    assert.equal(rows.filter(row => row.kind === 'denied').length, 0, 'Blocked transport attempt during this run');
    const captures = rows.filter(row => row.kind === 'line-captured').length;
    assert.ok(captures <= expectedCaptures, 'Unexpected synthetic LINE capture');
    const signature = JSON.stringify(rows);
    if (signature !== previous) { previous = signature; quietSince = performance.now(); }
    if (captures === expectedCaptures && performance.now() - start >= 2000 && performance.now() - quietSince >= 1500) return rows;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Transport audit did not settle within 10 seconds');
}
