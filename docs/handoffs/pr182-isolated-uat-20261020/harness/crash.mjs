// Phase 4: worker crash mid-burst. Usage:
//   bun crash.mjs send     -> open + 25 images (in-flight work starts)
//   (kill the app process, restart it)
//   bun crash.mjs recover  -> cron sweeps until settled, then verify
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { sql, setPlan, calls, record, sleep, text, image, webhook, cron, batchFor } from "./drive.mjs";

const STATE = new URL("./crash-state.json", import.meta.url);
const n = (q) => Number(sql(q) || 0);

if (process.argv[2] === "send") {
  const g = `C${createHash("md5").update(`crash:${Date.now()}`).digest("hex")}`;
  // slow-ish downloads so the drain is mid-flight when the process dies
  const ids = Array.from({ length: 25 }, (_, i) => `${g.slice(1, 13)}-crash${String(i + 1).padStart(2, "0")}`);
  setPlan({ content: Object.fromEntries(ids.map((id) => [id, { delayMs: 400 }])) });
  await webhook([text(g, "ยูเอที-ราชพฤกษ์ สลิปเงินโอน 20/10/2569")]);
  for (let i = 0; i < 40 && !batchFor(g); i++) await sleep(250);
  const evs = ids.map((id) => image(g, id));
  const r = await webhook(evs); // one payload -> one background drain
  writeFileSync(STATE, JSON.stringify({ g, ids, batch: batchFor(g), close: null }));
  console.log(JSON.stringify({ g, webhook: r.status, attachedAtSend: n(`select count(*) from slip_image_events where source_id='${g}' and state='attached'`) }));
}

if (process.argv[2] === "recover") {
  const { g, batch } = JSON.parse(readFileSync(STATE, "utf8"));
  const before = {
    queue: sql(`select coalesce(string_agg(status||':'||c, ' '),'') from (select q.status, count(*) c from line_webhook_event_queue q where q.source_id='${g}' group by 1) s`),
    ledger: sql(`select coalesce(string_agg(state||':'||c, ' '),'') from (select state, count(*) c from slip_image_events where source_id='${g}' group by 1) s`),
  };
  // Leases of the killed worker must expire before the sweep may reclaim them.
  sql(`set session_replication_role = replica; update line_webhook_event_queue set processing_started_at = now() - interval '6 minutes' where source_id='${g}' and status='processing'; update slip_image_events set lease_until = now() - interval '1 second' where source_id='${g}' and state='ingesting'`);
  for (let i = 0; i < 12 && n(`select count(*) from slip_image_events where source_id='${g}' and state='attached'`) < 25; i++) {
    await cron("finalize-slip-batches");
    await sleep(1500);
  }
  for (let i = 0; i < 40 && n(`select count(*) from slip_checks c join slip_evidences e on e.id=c.evidence_id where e.batch_id='${batch}' and c.status<>'PROCESSING'`) < 25; i++) await sleep(500);
  await webhook([text(g, "จบสลิป")]);
  for (let i = 0; i < 40 && sql(`select status from slip_batches where id='${batch}'`) !== "closing"; i++) await sleep(250);
  sql(`update slip_batches set closing_at=closing_at - interval '30 seconds', last_image_at=last_image_at - interval '30 seconds' where id='${batch}' returning 1`);
  await cron("finalize-slip-batches"); await cron("finalize-slip-batches");
  const after = {
    ledger: sql(`select coalesce(string_agg(state||':'||c, ' '),'') from (select state, count(*) c from slip_image_events where source_id='${g}' group by 1) s`),
    evidence: n(`select count(*) from slip_evidences where source_id='${g}'`),
    distinctEvidence: n(`select count(distinct line_message_id) from slip_evidences where source_id='${g}'`),
    batchIndexes: n(`select count(distinct batch_index) from slip_evidences where batch_id='${batch}'`),
    checks: n(`select count(*) from slip_checks c join slip_evidences e on e.id=c.evidence_id where e.batch_id='${batch}'`),
    batch: sql(`select status||' image_count='||image_count||' success='||success_count from slip_batches where id='${batch}'`),
    pushes: calls().filter((c) => c.kind === "push" && c.to === g && !c.duplicate).length,
  };
  const ok = after.ledger === "attached:25" && after.evidence === 25 && after.distinctEvidence === 25 && after.batchIndexes === 25 && after.checks === 25 && after.batch.startsWith("completed") && after.pushes === 1;
  record({ scenario: "P4-crash", title: "Worker ตายกลาง burst แล้วกู้คืน", expected: "25/25 ไม่มีซ้ำ, completed, สรุป 1 ครั้ง", actual: { before, after }, result: ok ? "PASS" : "FAIL", evidence: { g, batch } });
}
