// Local UAT only: inherited by build workers; never load this in a release runtime.
/* eslint-disable @typescript-eslint/no-require-imports -- Loaded synchronously by node --require. */
const net = require('node:net');
const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
let rejected = 0;
function check(host) {
  if (!loopback.has(host)) {
    rejected++;
    throw new Error('UAT blocked non-loopback network');
  }
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof options === 'object' && !options.path) check(options.host || 'localhost');
  if (typeof options === 'number') check(typeof args[1] === 'string' ? args[1] : 'localhost');
  return connect.apply(this, args);
};
const fetch = globalThis.fetch;
globalThis.fetch = function (input, ...args) {
  check(new URL(typeof input === 'string' || input instanceof URL ? input : input.url).hostname);
  return fetch.call(this, input, ...args);
};
process.on('exit', () => console.error(`UAT_NETWORK_GUARD pid=${process.pid} rejected=${rejected}`));
