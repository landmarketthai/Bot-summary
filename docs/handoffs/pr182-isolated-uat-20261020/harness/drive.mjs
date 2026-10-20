// Staging scenario driver: signed synthetic LINE webhooks against the LOCAL
// production build, cron calls, and DB verification on the LOCAL Supabase DB.
// Every target is localhost; there is no remote URL in this file.
import { createHmac, randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const APP = "http://127.0.0.1:3100";
const SECRET = "staging-line-channel-secret";
const CRON = "staging-cron-secret";
const PSQL = "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe";
const DIR = new URL(".", import.meta.url);
const PLAN = new URL("./mock-plan.json", DIR);
const CALLS = new URL("./mock-calls.jsonl", DIR);
const RESULTS = new URL("./results.jsonl", DIR);

export const sql = (q) => execFileSync(PSQL, ["-X", "-tA", "-v", "ON_ERROR_STOP=1", "-c", q], {
  env: { ...process.env, PGHOST: "127.0.0.1", PGPORT: "54322", PGUSER: "postgres", PGPASSWORD: "postgres", PGDATABASE: "botsummary_baseline_replay_20261009c" },
  encoding: "utf8",
}).trim();
export const setPlan = (p) => writeFileSync(PLAN, JSON.stringify(p, null, 2));
export const calls = () => readFileSync(CALLS, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
export const record = (r) => { appendFileSync(RESULTS, JSON.stringify(r) + "\n"); console.log(JSON.stringify(r)); };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let clock = Date.now();
const ts = () => (clock += 1000);
const src = (g) => ({ type: "group", groupId: g, userId: "U-staging-seller" });

export const text = (g, t) => ({
  type: "message", mode: "active", webhookEventId: randomUUID(), timestamp: ts(),
  replyToken: randomUUID(), deliveryContext: { isRedelivery: false }, source: src(g),
  message: { type: "text", id: `t-${randomUUID()}`, text: t, quoteToken: "q" },
});
export const image = (g, id) => ({
  type: "message", mode: "active", webhookEventId: randomUUID(), timestamp: ts(),
  replyToken: randomUUID(), deliveryContext: { isRedelivery: false }, source: src(g),
  message: { type: "image", id, quoteToken: "q", contentProvider: { type: "line" } },
});

export async function webhook(events) {
  const body = JSON.stringify({ destination: "Ustagingbot", events });
  const sig = createHmac("sha256", SECRET).update(body).digest("base64");
  const res = await fetch(`${APP}/api/webhook/line`, {
    method: "POST", headers: { "content-type": "application/json", "x-line-signature": sig }, body,
  });
  return { status: res.status, body: await res.text() };
}
export async function cron(path) {
  const t0 = Date.now();
  const res = await fetch(`${APP}/api/cron/${path}`, { headers: { authorization: `Bearer ${CRON}` } });
  return { status: res.status, ms: Date.now() - t0, body: await res.json().catch(() => null) };
}
export const accounting = (batchId) => JSON.parse(sql(`select public.slip_batch_image_accounting('${batchId}')`));
export const batchFor = (g) => sql(`select id from slip_batches where source_id='${g}' order by created_at desc limit 1`);
