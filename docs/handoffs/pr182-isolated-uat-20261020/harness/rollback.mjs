// Phase 4 full rollback on the isolated replay DB.
//   bun rollback.mjs snapshot <label>     -> finalized-money fingerprint
//   bun rollback.mjs alert-off-check      -> PR app with flag off: disabled, no send
//   bun rollback.mjs down <alert|ledger>  -> run committed rollback script
//   bun rollback.mjs legacy               -> PRE-PR app lifecycle (open, 5 images, close, finalize)
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { sql, calls, record, sleep, text, image, webhook, cron, batchFor } from "./drive.mjs";

const REPO = "C:/GitHub/_worktrees/bot-summary-p0-slip-ingest-20261017";
const PSQL = "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe";
const env = { ...process.env, PGHOST: "127.0.0.1", PGPORT: "54322", PGUSER: "postgres", PGPASSWORD: "postgres", PGDATABASE: "botsummary_baseline_replay_20261009c" };
const n = (q) => Number(sql(q) || 0);
const [, , cmd, arg] = process.argv;

if (cmd === "snapshot") {
  const rows = sql(`select coalesce(jsonb_agg(x order by x->>'id'), '[]') from (
    select jsonb_build_object('id', b.id, 'status', b.status, 'success', b.success_count, 'failed', b.failed_count,
      'summary_sent_at', b.summary_sent_at, 'finalized_at', b.finalized_at, 'image_count', b.image_count,
      'evidences', (select count(*) from slip_evidences e where e.batch_id=b.id),
      'verified_thb', (select coalesce(sum(c.transfer_amount),0) from slip_checks c join slip_evidences e on e.id=c.evidence_id where e.batch_id=b.id and c.status in ('EXTRACTED','PARTIAL_EXTRACTED')),
      'checks', (select coalesce(jsonb_agg(jsonb_build_array(c.evidence_id, c.status, c.transfer_amount) order by c.evidence_id), '[]') from slip_checks c join slip_evidences e on e.id=c.evidence_id where e.batch_id=b.id)) x
    from slip_batches b where b.summary_sent_at is not null) s`);
  const hash = createHash("sha256").update(rows).digest("hex");
  const parsed = JSON.parse(rows);
  writeFileSync(new URL(`./snapshot-${arg}.json`, import.meta.url), rows);
  console.log(JSON.stringify({ label: arg, finalizedBatches: parsed.length, totalVerifiedThb: parsed.reduce((s, b) => s + Number(b.verified_thb), 0), sha256: hash }));
}

if (cmd === "alert-off-check") {
  const before = calls().filter((c) => c.kind === "push").length;
  const r = await cron("slip-ledger-alert");
  const after = calls().filter((c) => c.kind === "push").length;
  console.log(JSON.stringify({ status: r.status, body: r.body, newPushes: after - before }));
}

if (cmd === "inflight") {
  console.log(sql(`select coalesce(string_agg(ev.state||':'||count, ' '),'none') from (select ev.state, count(*) from slip_image_events ev join slip_batches b on b.id=ev.batch_id where b.status in ('collecting','closing') and ev.state in ('received','ingesting','retry_pending','unbound') group by 1) ev`));
}

if (cmd === "down") {
  const file = arg === "alert"
    ? `${REPO}/supabase/rollback/20261019120000_slip_ingest_health_alert.down.sql`
    : `${REPO}/supabase/rollback/20261017100000_slip_image_ingestion_ledger.down.sql`;
  const r = spawnSync(PSQL, ["-X", "-v", "ON_ERROR_STOP=1", "-f", "-"], { env, input: readFileSync(file), encoding: "utf8" });
  sql(`notify pgrst, 'reload schema'`);
  console.log(JSON.stringify({ script: arg, exit: r.status, msgs: (r.stderr + r.stdout).split("\n").filter((l) => /ERROR|NOTICE|WARNING|refused|recorded/i.test(l)).slice(0, 5) }));
}

if (cmd === "shape") {
  console.log(JSON.stringify({
    ledgerFns: n(`select count(*) from pg_proc where pronamespace='public'::regnamespace and proname in ('begin_slip_image_attempt','attach_slip_image_event','fail_slip_image_event','slip_batch_image_accounting','capture_slip_image_event','bind_unbound_slip_image_events','receive_line_webhook_payload','resolve_slip_image_batch','slip_image_event_ts','list_due_slip_image_events','slip_image_ledger_health')`),
    alertTable: sql(`select to_regclass('public.slip_ingest_alert_states')::text`) || null,
    triggers: n(`select count(*) from pg_trigger where tgname in ('trg_capture_slip_image_event','trg_bind_unbound_slip_image_events')`),
    windowCols: n(`select count(*) from information_schema.columns where table_name='slip_batches' and column_name in ('open_event_ts_ms','close_event_ts_ms')`),
    claimArgs: sql(`select string_agg(pronargs::text, ',') from pg_proc where proname='claim_closing_slip_batch' and pronamespace='public'::regnamespace`),
    ledgerRowsKept: n(`select count(*) from slip_image_events`),
    ocrFencing: n(`select count(*) from pg_proc where proname='claim_slip_check' and pronamespace='public'::regnamespace`),
  }));
}

if (cmd === "legacy") {
  const g = `C${createHash("md5").update(`legacy:${Date.now()}`).digest("hex")}`;
  const ids = Array.from({ length: 5 }, (_, i) => `${g.slice(1, 13)}-leg${i + 1}`);
  await webhook([text(g, "ยูเอที-ราชพฤกษ์ สลิปเงินโอน 20/10/2569")]);
  for (let i = 0; i < 40 && !batchFor(g); i++) await sleep(250);
  const batch = batchFor(g);
  for (const id of ids) await webhook([image(g, id)]);
  for (let i = 0; i < 60 && n(`select count(*) from slip_checks c join slip_evidences e on e.id=c.evidence_id where e.batch_id='${batch}' and c.status<>'PROCESSING'`) < 5; i++) await sleep(500);
  await webhook([text(g, "จบสลิป")]);
  for (let i = 0; i < 40 && sql(`select status from slip_batches where id='${batch}'`) !== "closing"; i++) await sleep(250);
  sql(`update slip_batches set closing_at=closing_at - interval '30 seconds', last_image_at=last_image_at - interval '30 seconds' where id='${batch}' returning 1`);
  await cron("finalize-slip-batches"); await cron("finalize-slip-batches");
  const pushes = calls().filter((c) => c.kind === "push" && c.to === g && !c.duplicate);
  const res = {
    batch: sql(`select status||' image_count='||image_count from slip_batches where id='${batch}'`),
    evidences: n(`select count(*) from slip_evidences where batch_id='${batch}'`),
    ledgerRowsForGroup: n(`select count(*) from slip_image_events where source_id='${g}'`),
    pushes: pushes.length,
    summary: pushes[0]?.text?.split("\n").slice(0, 5).join(" | "),
  };
  const ok = res.batch.startsWith("completed") && res.evidences === 5 && res.ledgerRowsForGroup === 0 && res.pushes === 1 && res.summary?.includes("500");
  record({ scenario: "P4-legacy", title: "โค้ดก่อน PR (11e2f43) บน schema หลัง rollback", expected: "open/5 รูป/close/finalize ได้ 1 สรุป 500, ไม่เขียน ledger", actual: res, result: ok ? "PASS" : "FAIL", evidence: { g, batch } });
}
