// Staging-only preload: replaces LINE + OpenAI with deterministic mocks and
// refuses EVERY other non-local host, so no real provider call can happen.
// Loaded with: NODE_OPTIONS="--import file:///.../mock-providers.mjs"
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const DIR = new URL(".", import.meta.url);
const PLAN = new URL("./mock-plan.json", DIR);
const LOG = new URL("./mock-calls.jsonl", DIR);
const realFetch = globalThis.fetch.bind(globalThis);
const seenRetryKeys = new Set();
const attempts = new Map();

function plan() {
  try { return existsSync(PLAN) ? JSON.parse(readFileSync(PLAN, "utf8")) : {}; } catch { return {}; }
}
function log(entry) {
  appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const hang = (signal) => new Promise((_, reject) => {
  signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")));
});
function bump(key) { const n = (attempts.get(key) ?? 0) + 1; attempts.set(key, n); return n; }

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (local) return realFetch(input, init);
  const p = plan();

  if (url.hostname === "api.line.me" && /\/v2\/bot\/message\/(reply|push)$/.test(url.pathname)) {
    const kind = url.pathname.endsWith("reply") ? "reply" : "push";
    const body = JSON.parse(init.body ?? "{}");
    const retryKey = new Headers(init.headers).get("x-line-retry-key");
    const text = body.messages?.map((m) => m.text).join("\n") ?? "";
    if (kind === "push" && retryKey && seenRetryKeys.has(retryKey)) {
      log({ provider: "line", kind, to: body.to, retryKey, duplicate: true });
      return json({ message: "The retry key is already accepted" }, 409);
    }
    if (retryKey) seenRetryKeys.add(retryKey);
    log({ provider: "line", kind, to: body.to ?? null, retryKey, text });
    return json({ sentMessages: [{ id: "mock", quoteToken: "mock" }] });
  }

  if (url.hostname === "api-data.line.me") {
    const id = decodeURIComponent(url.pathname.split("/").at(-2));
    const rule = p.content?.[id] ?? {};
    const n = bump(`content:${id}`);
    log({ provider: "line", kind: "content", id, attempt: n, rule });
    if (rule.hang) return hang(init.signal);
    if (rule.delayMs) await new Promise((r) => setTimeout(r, rule.delayMs));
    if (rule.failFirst && n <= rule.failFirst) return json({ message: "mock 500" }, 500);
    if (rule.failAlways) return json({ message: "mock 500" }, 500);
    return new Response(new TextEncoder().encode(`MOCKIMG:${id}`), {
      status: 200, headers: { "content-type": "image/jpeg" },
    });
  }

  if (url.hostname === "api.openai.com") {
    const body = JSON.parse(init.body ?? "{}");
    const dataUri = JSON.stringify(body).match(/data:[^;]+;base64,([A-Za-z0-9+/=]+)/)?.[1];
    const decoded = dataUri ? Buffer.from(dataUri, "base64").toString("utf8") : "";
    const id = decoded.startsWith("MOCKIMG:") ? decoded.slice(8) : null;
    const rule = (id && p.ocr?.[id]) ?? {};
    const n = bump(`ocr:${id}`);
    log({ provider: "openai", kind: "ocr", id, attempt: n, rule });
    if (rule.status429First && n <= rule.status429First) return json({ error: "rate" }, 429, { "retry-after": "1" });
    if (rule.hang) return hang(init.signal);
    const amount = rule.amount ?? p.defaultAmount ?? 100;
    const extraction = {
      slip_type: "BANK_SLIP_QR", transfer_amount: amount, gross_amount: null, discount_amount: null,
      paid_amount: null, reference_id: `MOCKREF${(id ?? "x").replace(/[^A-Za-z0-9]/g, "")}`,
      transaction_time: p.transactionTime ?? new Date().toISOString(), sender_name: "MOCK SENDER",
      receiver_name: "MOCK RECEIVER", receiver_account_tail: "1234", payment_channel_text: null,
      headline_total_amount: null, project_right_amount: null, gwallet_amount: null, confidence: 0.95,
    };
    return json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(extraction) }] }] });
  }

  log({ provider: "blocked", host: url.hostname, path: url.pathname });
  throw new Error(`staging mock: external host blocked: ${url.hostname}`);
};
log({ provider: "boot", pid: process.pid });
