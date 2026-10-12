import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { transportDirectory, transportMark, transportRows, settleTransport } from './staging-transport-audit.mjs';

function record(runId, pid, kind = 'denied') {
  return { runId, pid, kind, ...(kind === 'guard-loaded' ? { clock: 'real' } : {}),
    ...(kind === 'line-captured' ? { path: '/v2/bot/message/push', to: 'uat-20261009-test', messages: [], retryKey: null, simulated: true } : {}) };
}
const jsonl = row => JSON.stringify(row) + '\n';

test('explicit run scope excludes archives and PID reuse; new worker denials still fail', async t => {
  const output = mkdtempSync(join(tmpdir(), 'staging-audit-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const current = randomUUID(), other = randomUUID();
  for (const id of [current, other]) mkdirSync(transportDirectory(output, id), { recursive: true });
  const file = join(transportDirectory(output, current), 'transport-123.jsonl');
  writeFileSync(file, jsonl(record(current, 123)));
  writeFileSync(join(output, 'transport-123.jsonl'), '{"kind":"denied"}\n');
  writeFileSync(join(transportDirectory(output, other), 'transport-123.jsonl'), '{"kind":"denied"}\n');
  const mark = transportMark(output, [current]);
  assert.deepEqual(transportRows(output, [current], mark), []);
  appendFileSync(file, jsonl(record(current, 123, 'line-captured')));
  assert.equal(transportRows(output, [current], mark).length, 1);
  const worker = join(transportDirectory(output, current), 'transport-124.jsonl');
  writeFileSync(worker, jsonl(record(current, 124)));
  await assert.rejects(settleTransport(output, [current], mark, 1), /Blocked transport attempt/);
  writeFileSync(worker, '{bad}\n');
  assert.throws(() => transportRows(output, [current], mark));
  writeFileSync(worker, '{"kind":"denied"}');
  assert.throws(() => transportRows(output, [current], mark), /Incomplete/);
  writeFileSync(file, '');
  writeFileSync(worker, '');
  assert.throws(() => transportRows(output, [current], mark), /truncated/);
  rmSync(file);
  assert.throws(() => transportRows(output, [current], mark), /disappeared/);
  assert.throws(() => transportDirectory(output, '../escape'));
  assert.throws(() => transportRows(output, [current]));
});

test('bounded settling observes a delayed synthetic after capture', async t => {
  const output = mkdtempSync(join(tmpdir(), 'staging-audit-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const current = randomUUID();
  mkdirSync(transportDirectory(output, current), { recursive: true });
  const mark = transportMark(output, [current]);
  const timer = setTimeout(() => writeFileSync(join(transportDirectory(output, current), 'transport-456.jsonl'), jsonl(record(current, 456, 'line-captured'))), 300);
  t.after(() => clearTimeout(timer));
  const rows = await settleTransport(output, [current], mark, 1);
  assert.equal(rows.length, 1);
});

test('every baseline and new audit record must match the producer schema and containing run/PID', t => {
  const output = mkdtempSync(join(tmpdir(), 'staging-audit-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const current = randomUUID();
  mkdirSync(transportDirectory(output, current), { recursive: true });
  const file = join(transportDirectory(output, current), 'transport-123.jsonl');
  const good = record(current, 123, 'guard-loaded');
  for (const invalid of [null, [], true, 123, 'text', {}, { ...good, kind: 'unknown' },
    { ...good, runId: randomUUID() }, { ...good, pid: 124 }, { ...good, pid: '123' },
    { ...good, clock: 'unexpected' }, { ...good, kind: 'line-captured' }, { ...good, unexpected: true },
    { ...record(current, 123, 'line-captured'), simulated: false },
    { ...record(current, 123, 'line-captured'), path: '/unknown' },
    { ...record(current, 123, 'line-captured'), messages: null },
    { ...record(current, 123, 'line-captured'), to: 123 },
    { ...record(current, 123, 'line-captured'), retryKey: 123 }]) {
    writeFileSync(file, jsonl(invalid));
    assert.throws(() => transportMark(output, [current]), /Invalid transport audit record/);
    writeFileSync(file, jsonl(good));
    const mark = transportMark(output, [current]);
    appendFileSync(file, jsonl(invalid));
    assert.throws(() => transportRows(output, [current], mark), /Invalid transport audit record/);
  }
  writeFileSync(file, '{bad}\n');
  assert.throws(() => transportMark(output, [current]));
  writeFileSync(file, jsonl(good) + '\n');
  assert.throws(() => transportMark(output, [current]), /Invalid transport audit record/);
});

test('newly discovered workers cannot disappear or truncate after observation; offsets stay fixed', t => {
  const output = mkdtempSync(join(tmpdir(), 'staging-audit-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const current = randomUUID();
  mkdirSync(transportDirectory(output, current), { recursive: true });
  for (const truncate of [false, true]) {
    const mark = transportMark(output, [current]);
    const worker = join(transportDirectory(output, current), 'transport-456.jsonl');
    writeFileSync(worker, jsonl(record(current, 456, 'guard-loaded')));
    assert.equal(transportRows(output, [current], mark).length, 1);
    appendFileSync(worker, jsonl(record(current, 456, 'line-captured')));
    assert.equal(transportRows(output, [current], mark).length, 2);
    assert.equal(transportRows(output, [current], mark).length, 2);
    if (truncate) writeFileSync(worker, jsonl(record(current, 456, 'guard-loaded')));
    else rmSync(worker);
    assert.throws(() => transportRows(output, [current], mark), truncate ? /truncated/ : /disappeared/);
    rmSync(worker, { force: true });
  }
});
