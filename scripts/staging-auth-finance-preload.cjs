// Test process only; never include in a deployed runtime.
/* eslint-disable @typescript-eslint/no-require-imports -- Node preload. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns');
const dgram = require('node:dgram');
const http2 = require('node:http2');
const capture = path.resolve(__dirname, '../.tmp-staging-uat-20261009/auth-finance');
fs.mkdirSync(capture, { recursive: true });
const log = path.join(capture, `transport-${process.pid}.jsonl`);
function record(event) { fs.appendFileSync(log, JSON.stringify(event) + '\n'); }
function deny() {
  record({ kind: 'denied' });
  throw new Error('Local staging transport denied');
}
function check(host, port) {
  if (host !== '127.0.0.1' || ![56300, 56321, 56331, 56343].includes(Number(port))) deny();
}
function socketOptions(args) {
  const values = Array.isArray(args[0]) ? args[0] : args;
  const first = values[0];
  if (typeof first === 'object' && first && !first.path) return first;
  if (typeof first === 'number') return { port: first, host: values[1] };
  deny(); // No Unix/named-pipe or implicit-host escape.
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = socketOptions(args);
  check(options.host, options.port);
  return connect.apply(this, args);
};
const tlsConnect = tls.connect;
tls.connect = function (...args) {
  const options = socketOptions(args);
  check(options.host, options.port);
  return tlsConnect.apply(this, args);
};
const lookup = dns.lookup;
dns.lookupService = deny;
dns.lookup = function (hostname, ...args) {
  if (hostname !== '127.0.0.1') deny();
  return lookup.call(this, hostname, ...args);
};
for (const name of Object.keys(dns)) {
  if (name.startsWith('resolve') || name === 'reverse') dns[name] = deny;
}
const promiseLookup = dns.promises.lookup;
dns.promises.lookup = async function (hostname, ...args) {
  if (hostname !== '127.0.0.1') deny();
  return promiseLookup.call(this, hostname, ...args);
};
for (const name of Object.keys(dns.promises)) {
  if (name.startsWith('resolve') || name === 'reverse') dns.promises[name] = deny;
}
for (const Resolver of [dns.Resolver, dns.promises.Resolver]) {
  for (const name of Object.getOwnPropertyNames(Resolver.prototype)) {
    if (name.startsWith('resolve') || name === 'reverse') Resolver.prototype[name] = deny;
  }
}
dgram.createSocket = deny;
dgram.Socket.prototype.send = deny;
dgram.Socket.prototype.connect = deny;
const h2Connect = http2.connect;
http2.connect = function (authority, ...args) {
  const url = new URL(authority);
  check(url.hostname, url.port || (url.protocol === 'https:' ? 443 : 80));
  return h2Connect.call(this, authority, ...args);
};
const realFetch = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  // Embedded Yoga WASM only: this has no network transport or filesystem access.
  if (/^data:application\/(?:wasm|octet-stream);base64,[A-Za-z0-9+/=]+$/.test(url.href)) {
    return realFetch.call(this, input, init);
  }
  if (url.origin === 'https://api.line.me' &&
      ['/v2/bot/message/push', '/v2/bot/message/reply'].includes(url.pathname)) {
    const request = new Request(input, init);
    if (request.method !== 'POST') deny();
    const body = await request.json().catch(deny);
    if (!Array.isArray(body?.messages) ||
        typeof (body.to || body.replyToken) !== 'string' ||
        !(body.to || body.replyToken).startsWith('uat-20261009-')) deny();
    // Persist every message, but never credentials or the reply token.
    record({ kind: 'line-captured', path: url.pathname, to: body.to ?? null,
      messages: body.messages, retryKey: request.headers.get('x-line-retry-key'),
      simulated: true });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.protocol !== 'http:' || url.username || url.password) deny();
  check(url.hostname, url.port);
  const request = new Request(input, init);
  if (request.redirect !== 'error') {
    return realFetch.call(this, new Request(request, { redirect: 'error' }));
  }
  return realFetch.call(this, request);
};
const clock = process.env.STAGING_UAT_CLOCK;
if (clock) {
  assert.ok(['2026-10-08T20:59:00.000Z', '2026-10-08T21:00:00.000Z',
    '2026-10-08T21:05:00.000Z'].includes(clock), 'Only reviewed Bangkok cutoff clocks');
  const NativeDate = Date;
  const now = NativeDate.parse(clock);
  function TestDate(...args) {
    if (!new.target) return new NativeDate(now).toString();
    return Reflect.construct(NativeDate, args.length ? args : [now], new.target);
  }
  Object.setPrototypeOf(TestDate, NativeDate);
  TestDate.prototype = NativeDate.prototype;
  TestDate.now = () => now;
  // Next's Middleware VM copies own static properties and may not follow
  // a Function constructor's inherited properties across its boundary.
  TestDate.parse = NativeDate.parse.bind(NativeDate);
  TestDate.UTC = NativeDate.UTC.bind(NativeDate);
  globalThis.Date = TestDate;
}
record({ kind: 'guard-loaded', clock: clock || 'real', pid: process.pid });
