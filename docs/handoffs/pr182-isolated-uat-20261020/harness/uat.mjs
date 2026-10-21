// Isolated E2E UAT scenarios for PR #182. Usage: bun uat.mjs <scenario|all>
// Real app (next start) + real local Supabase (PostgREST, Storage, Postgres) +
// mocked LINE/OCR only. Time travel (moving next_retry_at / closing_at back)
// replaces waiting for real backoff and cron cadence; it is recorded per run.
import { createHash } from "node:crypto";
import { sql, setPlan, calls, record, sleep, text, image, webhook, cron, accounting, batchFor } from "./drive.mjs";

const HEADER = (seller) => `${seller}-ราชพฤกษ์ สลิปเงินโอน 20/10/2569`;
const CLOSE = "จบสลิป";
const run = Date.now().toString(36);
const gid = (n) => `C${createHash("md5").update(`${run}:${n}`).digest("hex")}`;

async function waitFor(fn, ms = 60_000, step = 500) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(step);
  }
}
const n = (q) => Number(sql(q) || 0);
const pushesTo = (g) => calls().filter((c) => c.provider === "line" && c.kind === "push" && c.to === g && !c.duplicate);
const repliesText = () => calls().filter((c) => c.provider === "line" && c.kind === "reply").map((c) => c.text);
function counts(g, batch) {
  return {
    receivedRaw: n(`select count(*) from raw_messages where source_id='${g}' and message_type='image'`),
    queue: n(`select count(*) from line_webhook_event_queue q join raw_messages r on r.id=q.raw_message_id where q.source_id='${g}' and r.message_type='image'`),
    ledger: n(`select count(*) from slip_image_events where source_id='${g}'`),
    ledgerStates: sql(`select coalesce(string_agg(state||':'||c, ' ' order by state),'') from (select state, count(*) c from slip_image_events where source_id='${g}' group by 1) s`),
    evidenceInBatch: batch ? n(`select count(*) from slip_evidences where batch_id='${batch}'`) : 0,
    evidenceAll: n(`select count(*) from slip_evidences where source_id='${g}'`),
    checks: batch ? n(`select count(*) from slip_checks c join slip_evidences e on e.id=c.evidence_id where e.batch_id='${batch}'`) : 0,
    checksTerminal: batch ? n(`select count(*) from slip_checks c join slip_evidences e on e.id=c.evidence_id where e.batch_id='${batch}' and c.status<>'PROCESSING'`) : 0,
    batch: batch ? JSON.parse(sql(`select to_jsonb(b) - 'header_text' from (select status, image_count, success_count, failed_count, summary_sent_at is not null as summary_sent from slip_batches where id='${batch}') b`)) : null,
  };
}
const verified = (batch) => Number(sql(`select coalesce(sum(c.transfer_amount),0) from slip_checks c join slip_evidences e on e.id=c.evidence_id where e.batch_id='${batch}' and c.status in ('EXTRACTED','PARTIAL_EXTRACTED')`));
const backdateClose = (batch, s) => sql(`update slip_batches set closing_at=closing_at - interval '${s} seconds', last_image_at=last_image_at - interval '${s} seconds' where id='${batch}' returning 1`);
const dueNow = (g) => sql(`update slip_image_events set next_retry_at=now() - interval '1 second' where source_id='${g}' and state='retry_pending' returning 1`);

async function openSession(g, seller = "ยูเอที") {
  const r = await webhook([text(g, HEADER(seller))]);
  const batch = await waitFor(() => batchFor(g), 20_000);
  return { r, batch };
}
async function sendImages(g, ids, { together = false } = {}) {
  if (together) return [await webhook(ids.map((id) => image(g, id)))];
  const out = [];
  for (const id of ids) out.push(await webhook([image(g, id)]));
  return out;
}
const ids = (g, count) => Array.from({ length: count }, (_, i) => `${g.slice(1, 13)}-img${String(i + 1).padStart(2, "0")}`);
async function settle(g, expectAttached, ms = 90_000) {
  return waitFor(() => n(`select count(*) from slip_image_events where source_id='${g}' and state in ('attached','failed_permanent','excluded_after_close','late_after_finalize','excluded_not_slip')`) >= expectAttached, ms);
}
async function ocrDone(batch, k, ms = 90_000) {
  return waitFor(() => n(`select count(*) from slip_checks c join slip_evidences e on e.id=c.evidence_id where e.batch_id='${batch}' and c.status<>'PROCESSING'`) >= k, ms);
}
async function finalizeNow(batch) {
  backdateClose(batch, 30);
  return cron("finalize-slip-batches");
}
function result(id, title, expected, actual, pass, evidence) {
  record({ scenario: id, title, expected, actual, result: pass ? "PASS" : "FAIL", evidence });
  return pass;
}

const S = {};

S.s1 = async () => {
  const g = gid(1); setPlan({});
  const { batch } = await openSession(g);
  const list = ids(g, 25);
  await sendImages(g, list);
  await settle(g, 25); await ocrDone(batch, 25);
  await webhook([text(g, CLOSE)]);
  await waitFor(() => sql(`select status from slip_batches where id='${batch}'`) === "closing", 20_000);
  const c1 = await finalizeNow(batch);
  const c = counts(g, batch);
  const push = pushesTo(g);
  const ok = c.ledger === 25 && c.evidenceInBatch === 25 && c.checksTerminal === 25 && c.batch.status === "completed" && push.length === 1 && push[0].text.includes("2,500") && !push[0].text.includes("ยังไม่ครบ");
  return result("1", "25 รูปตามลำดับปกติ", "ledger/evidence/OCR = 25, completed, 1 summary 2,500", { ...c, verified: verified(batch), cron: c1.status, summary: push[0]?.text }, ok, { g, batch });
};

S.s2 = async () => {
  const g = gid(2); const list = ids(g, 25);
  setPlan({ content: { [list[5]]: { failFirst: 1 } } });
  const { batch } = await openSession(g);
  await sendImages(g, list);
  await settle(g, 24);
  let st = sql(`select state||':'||attempts from slip_image_events where line_message_id='${list[5]}'`);
  // in-request retry or one cron sweep
  if (!st.startsWith("attached")) { await sleep(20_000); dueNow(g); await cron("finalize-slip-batches"); }
  await settle(g, 25); await ocrDone(batch, 25);
  st = sql(`select state||':'||attempts from slip_image_events where line_message_id='${list[5]}'`);
  await webhook([text(g, CLOSE)]);
  await waitFor(() => sql(`select status from slip_batches where id='${batch}'`) === "closing", 20_000);
  await finalizeNow(batch);
  const c = counts(g, batch); const push = pushesTo(g);
  const ok = st.startsWith("attached") && Number(st.split(":")[1]) >= 2 && c.evidenceInBatch === 25 && c.batch.status === "completed" && push.length === 1 && push[0].text.includes("2,500");
  return result("2", "รูปที่ 6 เสียชั่วคราว", "รูป 6 retry แล้ว attached, ครบ 25, completed", { image6: st, ...c, summary: push[0]?.text }, ok, { g, batch });
};

S.s3 = async () => {
  const g = gid(3); const list = ids(g, 25);
  setPlan({ content: { [list[5]]: { failAlways: true } } });
  const { batch } = await openSession(g);
  await sendImages(g, list);
  await settle(g, 24); await ocrDone(batch, 24);
  await webhook([text(g, CLOSE)]);
  await waitFor(() => sql(`select status from slip_batches where id='${batch}'`) === "closing", 20_000);
  const early = await finalizeNow(batch);
  const earlyStatus = sql(`select status from slip_batches where id='${batch}'`);
  for (let i = 0; i < 8 && !sql(`select state from slip_image_events where line_message_id='${list[5]}'`).startsWith("failed_permanent"); i++) {
    dueNow(g); await cron("finalize-slip-batches");
  }
  const img6 = sql(`select state||':'||attempts||':'||coalesce(last_error,'') from slip_image_events where line_message_id='${list[5]}'`);
  await finalizeNow(batch);
  const c = counts(g, batch); const push = pushesTo(g);
  const ok = earlyStatus === "closing" && img6.startsWith("failed_permanent:5") && c.batch.status === "review_needed" && c.batch.failed_count === 1
    && push.length === 1 && push[0].text.includes("2,400") && push[0].text.includes("ยังไม่ครบ: 1 รูป") && verified(batch) === 2400;
  return result("3", "รูปที่ 6 เสียถาวร", "failed_permanent หลัง 5 ครั้ง, review_needed, แจ้งขาด 1 รูป, ไม่นับ 0 บาท", { earlyClaim: earlyStatus, image6: img6, ...c, verified: verified(batch), summary: push[0]?.text }, ok, { g, batch });
};

S.s4 = async () => {
  const g = gid(4); const list = ids(g, 25);
  setPlan({ content: Object.fromEntries(list.slice(10).map((id) => [id, { failFirst: 1 }])) });
  const { batch } = await openSession(g);
  // images + close in ONE payload (close right after the 25th image)
  const evs = list.map((id) => image(g, id)); evs.push(text(g, CLOSE));
  const r = await webhook(evs);
  const snap = [];
  for (let i = 0; i < 6; i++) {
    await finalizeNow(batch);
    snap.push({ status: sql(`select status from slip_batches where id='${batch}'`), attached: n(`select count(*) from slip_image_events where source_id='${g}' and state='attached'`), pushes: pushesTo(g).length });
    if (snap.at(-1).status !== "closing") break;
    dueNow(g); await sleep(3000);
  }
  await settle(g, 25); await ocrDone(batch, 25);
  await finalizeNow(batch);
  const c = counts(g, batch); const push = pushesTo(g);
  const prematurely = snap.some((s) => s.pushes > 0 && s.attached < 25);
  const ok = !prematurely && c.evidenceInBatch === 25 && c.batch.status === "completed" && push.length === 1 && push[0].text.includes("2,500");
  return result("4", "ปิดชุดทันทีหลังรูป 25 ใบ (payload เดียว)", "ไม่สรุปก่อนรูปครบ, สุดท้ายครบ 25 สรุปครั้งเดียว", { webhook: r.status, timeline: snap, ...c, summary: push[0]?.text }, ok, { g, batch });
};

S.s5 = async () => {
  const g = gid(5); const list = ids(g, 10); setPlan({});
  const { batch } = await openSession(g);
  const evs = list.map((id) => image(g, id));
  for (const e of evs) await webhook([e]);
  // LINE redelivery: identical webhookEventIds, marked redelivery, plus a duplicate message id under a new event id
  for (const e of evs) await webhook([{ ...e, deliveryContext: { isRedelivery: true } }]);
  await webhook([{ ...image(g, list[0]) }]);
  await settle(g, 10); await ocrDone(batch, 10);
  await webhook([text(g, CLOSE)]);
  await waitFor(() => sql(`select status from slip_batches where id='${batch}'`) === "closing", 20_000);
  await finalizeNow(batch); await finalizeNow(batch);
  const c = counts(g, batch); const push = pushesTo(g);
  const ok = c.ledger === 10 && c.evidenceAll === 10 && c.checks === 10 && verified(batch) === 1000 && push.length === 1;
  return result("5", "Webhook ซ้ำ", "ไม่มี ledger/evidence/ยอดซ้ำ, สรุปครั้งเดียว 1,000", { ...c, verified: verified(batch), pushes: push.length }, ok, { g, batch });
};

S.s6 = async () => {
  const g = gid(6); const list = ids(g, 25); setPlan({});
  const { batch } = await openSession(g);
  const evs = list.map((id) => image(g, id));          // timestamps ascending in send order
  const closeEv = text(g, CLOSE);                      // close sent after all 25
  const shuffled = [...evs.slice(0, 20)].sort(() => Math.random() - 0.5);
  for (const e of shuffled) await webhook([e]);
  await webhook([closeEv]);                            // close delivered BEFORE the last 5 images
  for (const e of evs.slice(20).reverse()) await webhook([e]);
  const afterClose = image(g, `${g.slice(1, 13)}-late`); // genuinely sent after close
  await webhook([afterClose]);
  await settle(g, 26); await ocrDone(batch, 25);
  await finalizeNow(batch);
  const c = counts(g, batch); const push = pushesTo(g);
  const lateState = sql(`select state from slip_image_events where line_message_id='${g.slice(1, 13)}-late'`);
  const ok = c.evidenceInBatch === 25 && lateState === "excluded_after_close" && c.batch.status === "completed" && push.length === 1 && push[0].text.includes("2,500");
  return result("6", "รูปผิดลำดับ / close มาก่อนรูปท้าย", "ครบ 25, รูปที่ส่งหลังปิดไม่เข้าชุด", { ...c, lateImage: lateState, summary: push[0]?.text }, ok, { g, batch });
};

S.s7 = async () => {
  const g = gid(7); const list = ids(g, 25);
  setPlan({ content: Object.fromEntries(list.slice(0, 3).map((id) => [id, { failAlways: true }])) });
  const { batch } = await openSession(g);
  await sendImages(g, list);
  await settle(g, 22); await ocrDone(batch, 22);
  await webhook([text(g, CLOSE)]);
  await waitFor(() => sql(`select status from slip_batches where id='${batch}'`) === "closing", 20_000);
  // No cron at all; time passes beyond the ingest bound.
  const health = JSON.parse(sql(`select public.slip_image_ledger_health()`));
  const acc = accounting(batch);
  backdateClose(batch, 2200);
  // the wait bound runs from the latest receipt, so time-travel it too
  sql(`update slip_image_events set received_at = received_at - interval '2200 seconds' where source_id='${g}' returning 1`);
  await cron("finalize-slip-batches");
  const c = counts(g, batch); const push = pushesTo(g);
  const ok = acc.waiting + acc.retry_pending >= 3 && c.batch.status === "review_needed" && push.length === 1 && push[0].text.includes("ยังไม่ครบ: 3 รูป") && push[0].text.includes("2,200");
  return result("7", "Cron หยุดหลายรอบ", "เห็นรายการค้าง, หมดเวลาแล้วสรุปไม่ครบ ไม่ completed", { beforeTimeout: { health, accounting: acc }, ...c, summary: push[0]?.text }, ok, { g, batch });
};

S.s8 = async () => {
  const g = gid(8); const list = ids(g, 5);
  setPlan({ ocr: { [list[2]]: { hang: true } } });
  const { batch } = await openSession(g);
  await sendImages(g, list);
  await settle(g, 5);
  await webhook([text(g, CLOSE)]);
  await waitFor(() => sql(`select status from slip_batches where id='${batch}'`) === "closing", 20_000);
  await ocrDone(batch, 5, 120_000);
  const ocr3 = sql(`select c.status||':'||coalesce(c.failure_reason,'') from slip_checks c join slip_evidences e on e.id=c.evidence_id where e.line_message_id='${list[2]}'`);
  // DB error: accounting RPC unavailable -> finalizer must fail closed
  sql(`alter function public.slip_batch_image_accounting(uuid) rename to slip_batch_image_accounting__off`);
  sql(`notify pgrst, 'reload schema'`); await sleep(1500);
  await finalizeNow(batch);
  const duringOutage = { status: sql(`select status from slip_batches where id='${batch}'`), pushes: pushesTo(g).length };
  sql(`alter function public.slip_batch_image_accounting__off(uuid) rename to slip_batch_image_accounting`);
  sql(`notify pgrst, 'reload schema'`); await sleep(1500);
  // bypass trg_slip_batches_updated_at for this test-only clock move
  sql(`set session_replication_role = replica; update slip_batches set updated_at = now() - interval '5 minutes' where id='${batch}'`);
  await cron("finalize-slip-batches");
  const c = counts(g, batch); const push = pushesTo(g);
  const ok = !ocr3.startsWith("EXTRACTED") && duringOutage.pushes === 0 && duringOutage.status === "processing"
    && push.length === 1 && c.batch.status === "review_needed" && verified(batch) === 400;
  return result("8", "OCR timeout + DB error", "OCR ที่ timeout ไม่ถูกนับ, DB error ไม่ส่งสรุป, กู้แล้วสรุปครั้งเดียว 400", { ocrImage3: ocr3, duringOutage, ...c, verified: verified(batch), summary: push[0]?.text }, ok, { g, batch });
};

S.s9 = async () => {
  const a = await cron("slip-ledger-alert"); const b = await cron("slip-ledger-alert");
  const alertPushes = calls().filter((x) => x.provider === "line" && x.kind === "push" && !String(x.to ?? "").startsWith("C" + run));
  const ok = a.status === 200 && a.body?.mode === "dry_run" && a.body?.sent === false && b.body?.sent === false && a.body?.health?.unhealthy === true;
  return result("9", "Alert dry-run", "dry_run, unhealthy เห็นได้, ไม่ส่ง LINE", { first: a.body, second: { mode: b.body?.mode, sent: b.body?.sent }, alertPushesOutsideScenarioGroups: alertPushes.length }, ok, {});
};

S.s10 = async () => {
  const done = sql(`select coalesce(string_agg(source_id, ','), '') from slip_batches where summary_sent_at is not null`).split(",").filter(Boolean);
  for (let i = 0; i < 3; i++) await cron("finalize-slip-batches");
  const per = Object.fromEntries(done.map((g) => [g, pushesTo(g).length]));
  const dupAccepted = calls().filter((x) => x.duplicate).length;
  const ok = done.length > 0 && Object.values(per).every((v) => v === 1);
  return result("10", "Batch ครบสรุปครั้งเดียว", "ทุก batch ที่สรุปแล้วมี push 1 ครั้งหลังเรียก cron ซ้ำ", { batches: done.length, pushesPerGroup: per, duplicateRetryKeyAttempts: dupAccepted }, ok, {});
};

const which = process.argv[2] ?? "all";
const order = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10"];
for (const k of which === "all" ? order : which.split(",")) {
  try { await S[k](); } catch (e) { record({ scenario: k, result: "FAIL", error: String(e?.stack ?? e).slice(0, 800) }); }
}
console.log("replies sample:", JSON.stringify(repliesText().slice(0, 4)));
