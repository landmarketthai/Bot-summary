/**
 * Isolated end-to-end UAT for the slip money paths (local PostgreSQL 17 only).
 *
 * Real code: WebhookService → ingestion ledger → SlipEvidenceService →
 * recovery → batch finalizer (the LINE summary text) → money loaders
 * (loadMarketScopedAiVerifiedTransfers + loadMarketScopedManualSlipBreakdown,
 * the two halves White Sheet / settlement / round close add) → round-close
 * rows → POST /api/admin/slip-reviews handler → review RPCs (migrations
 * 20261102120000/130000/140000). Simulated: the LINE content download, Storage,
 * and the OCR provider — which returns a scripted extraction that goes through
 * the REAL parseSlipExtraction + determineSlipCheckStatus. No network, no
 * LINE, no Gemini, no Production.
 *
 *   ALLOW_DISPOSABLE_POSTGRES_TESTS=1 PGPASSWORD=postgres UAT_ARTIFACT=<path.md> \
 *     bun test src/lib/slips/uat-manual-approval.pg.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { writeFileSync } from "node:fs";
import { handleSlipReviewRequest } from "@/app/api/admin/slip-reviews/handler";
import { bangkokBusinessDateFromTimestamp } from "@/lib/business-date";
import { WebhookService } from "@/lib/line/webhook-service";
import { loadGuidedSlipRows } from "@/lib/line/guided-menu/round-close";
import { loadMarketScopedAiVerifiedTransfers, loadMarketScopedManualSlipBreakdown } from "@/lib/reconciliation";
import { finalizeClosingSlipBatches } from "@/lib/slips/batch-finalizer";
import { SlipEvidenceService } from "@/lib/slips/evidence-service";
import { determineSlipCheckStatus, extractionToJson, parseSlipExtraction } from "@/lib/slips/extraction-schema";
import {
  createPgSupabase,
  createSlipTestDb,
  probePg,
  ROOT,
  SLIP_PIPELINE_MIGRATIONS,
  type SlipTestDb,
} from "@/lib/slips/testing/pg-slip-harness";

const pgAvailable = await probePg();
if (!pgAvailable && process.env.SLIP_INGEST_REQUIRE === "1") {
  throw new Error("SLIP_INGEST_REQUIRE=1 but PostgreSQL 17 harness unavailable");
}

// ── calendar: the market day is today (Bangkok business date) ──────────────
const DAY = bangkokBusinessDateFromTimestamp(Date.now())!;
const [Y, M, D] = DAY.split("-").map(Number);
const SLIP_DATE_BE = `${D}/${M}/${Y + 543}`;
const at = (day: string) => `${day}T10:00:00+07:00`;
const THREE_MONTHS_AGO = new Date(Date.UTC(Y, M - 4, D)).toISOString().slice(0, 10);
const MARKET = "วัดทุ่งลานนา";
const OTHER_MARKET = "หน้าเซเวน";
const KNOWN = new Set([MARKET, OTHER_MARKET]);
const T0 = Date.now() - 3_600_000;

// ── scripted OCR per LINE image (amounts, references, printed dates) ────────
type Scripted = Record<string, unknown>;
const bank = (amount: number, ref: string, time: string | null): Scripted => ({
  slip_type: "BANK_SLIP_QR", transfer_amount: amount, reference_id: ref, transaction_time: time,
  receiver_name: "ร้านทดสอบ", confidence: 0.95,
});
const OCR = new Map<string, Scripted>([
  ["m-U1-1", bank(40, "UAT-1", at(DAY))],                 // confirmed
  ["m-U1-2", bank(50, "UAT-2", at(THREE_MONTHS_AGO))],    // printed month misread → pending → approved
  ["m-U1-3", bank(40, "UAT-3", null)],                    // no printed date → pending (download fails once)
  ["m-U1-4", bank(60, "UAT-4", at(DAY))],
  ["m-U1-5", bank(70, "UAT-5", at(DAY))],                 // also keyed manually with its reference
  ["m-U1-6", bank(50000, "UAT-6", at(DAY))],              // LINE batch outlier
  ["m-U1-7", {                                            // ไทยช่วยไทย wallet receipt
    slip_type: "THAI_HELP_THAI", headline_total_amount: 100, project_right_amount: 60, gwallet_amount: 40,
    payment_channel_text: "ไทยช่วยไทย พลัส (60/40)", reference_id: "UAT-W", transaction_time: at(DAY), confidence: 0.95,
  }],
  ["m-U2-1", bank(40, "UAT-1", at(DAY))],                 // same transfer seen in another market
]);

let db: SlipTestDb;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let supa: any;
const backgroundTasks: Array<() => Promise<void>> = [];
const downloads = new Map<string, number>();
const failFirst = new Set(["m-U1-3"]);
const results: Array<{ scenario: string; input: string; expected: string; actual: string; pass: boolean; evidence: string }> = [];

function record(scenario: string, input: string, expected: unknown, actual: unknown, evidence: string) {
  const pass = JSON.stringify(expected) === JSON.stringify(actual);
  results.push({ scenario, input, expected: JSON.stringify(expected), actual: JSON.stringify(actual), pass, evidence });
  expect(actual).toEqual(expected as never);
}

async function download(messageId: string) {
  const calls = (downloads.get(messageId) ?? 0) + 1;
  downloads.set(messageId, calls);
  if (failFirst.has(messageId) && calls === 1) throw new Error("simulated LINE content 500");
  return { bytes: new TextEncoder().encode(`img:${messageId}`), mimeType: "image/jpeg" };
}

function makeWebhook(): WebhookService {
  return new WebhookService(supa, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    guidedJourneyService: { resolve: async () => ({ stage: "idle", reason: "no_session" }), findRoundOwner: async () => ({ kind: "none" }) } as any,
    evidenceIngestor: new SlipEvidenceService(supa, download),
    checkProcessor: {
      processEvidence: async (evidenceId: string) => {
        const [ev] = await db.query<{ line_message_id: string }>(`SELECT line_message_id FROM slip_evidences WHERE id = '${evidenceId}'`);
        const extraction = parseSlipExtraction(OCR.get(ev.line_message_id) ?? { slip_type: "UNKNOWN" });
        const status = determineSlipCheckStatus(extraction);
        const lit = (v: unknown) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replaceAll("'", "''")}'`);
        await db.query(
          `INSERT INTO slip_checks (evidence_id, status, slip_type, transfer_amount, gross_amount, discount_amount, paid_amount,
                                   reference_id, transaction_time, receiver_name, confidence, extracted_json)
           VALUES ('${evidenceId}', '${status}', '${extraction.slipType}', ${lit(extraction.transferAmount)}, ${lit(extraction.grossAmount)},
                   ${lit(extraction.discountAmount)}, ${lit(extraction.paidAmount)}, ${lit(extraction.referenceId)},
                   ${lit(extraction.transactionTime)}, ${lit(extraction.receiverName)}, ${extraction.confidence},
                   ${lit(JSON.stringify(extractionToJson(extraction)))}::jsonb)
           ON CONFLICT (evidence_id) DO NOTHING`,
        );
      },
    },
    scheduleBackgroundTask: (task) => { backgroundTasks.push(task); },
    slipRetrySleep: async () => {},
    replyMessage: async () => {},
  });
}

const imageEvent = (src: string, n: number, id = `evt-${src}-${n}`) => ({
  type: "message", webhookEventId: id, timestamp: T0 + 1000 * n, replyToken: `rt-${id}`, mode: "active",
  source: { type: "group", groupId: src, userId: "U-seller" },
  message: { type: "image", id: `m-${src}-${n}`, contentProvider: { type: "line" } },
});

async function runTasks() {
  while (backgroundTasks.length > 0) await backgroundTasks.shift()!();
}

/** One LINE batch, end to end; returns the LINE summary text the finalizer pushes. */
async function runBatch(src: string, market: string, images: number, redeliver: number[] = []): Promise<string> {
  const [batch] = await db.query<{ id: string }>(
    `INSERT INTO slip_batches (source_id, source_type, sender_id, status, seller_name, market_name, slip_date, header_text, open_event_ts_ms)
     VALUES ('${src}', 'group', 'U-seller', 'collecting', 'จ๋า', '${market}', '${SLIP_DATE_BE}', 'จ๋า ${market} ${SLIP_DATE_BE}', ${T0}) RETURNING id`,
  );
  const webhook = makeWebhook();
  for (let n = 1; n <= images; n++) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await webhook.processEvents([imageEvent(src, n)] as any, "dest", { deferOrderedProcessing: true });
  }
  for (const n of redeliver) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await webhook.processEvents([imageEvent(src, n)] as any, "dest", { deferOrderedProcessing: true });
  }
  await db.query(`UPDATE slip_batches SET status='closing', closing_at=now(), close_event_ts_ms=${T0 + 1000 * (images + 1)} WHERE id='${batch.id}'`);
  await runTasks();
  for (let pass = 0; pass < 5; pass++) {
    await db.query(`UPDATE slip_image_events SET next_retry_at = now() - interval '1 second' WHERE state = 'retry_pending'`);
    await makeWebhook().recoverSlipIngest();
    await runTasks();
  }
  await db.query(`UPDATE slip_batches SET closing_at = closing_at - interval '60 seconds', last_image_at = last_image_at - interval '60 seconds' WHERE id='${batch.id}'`);
  const pushes: string[] = [];
  await finalizeClosingSlipBatches(supa, async (_to, text) => { pushes.push(text); }, 10, 120);
  return pushes.join("\n");
}

const lineAmount = (text: string, label: string) => {
  const m = new RegExp(`${label}: ([\\d,.]+) บาท`).exec(text);
  return m ? Number(m[1].replace(/,/g, "")) : null;
};
const checkId = async (messageId: string) =>
  (await db.query<{ id: string }>(`SELECT c.id FROM slip_checks c JOIN slip_evidences e ON e.id = c.evidence_id WHERE e.line_message_id = '${messageId}'`))[0].id;
const session = (user: { id: string; email?: string; app_metadata?: Record<string, unknown> } | null) =>
  ({ auth: { getUser: async () => ({ data: { user } }) } }) as never;
const ADMIN = { id: "u-admin", email: "admin@uat.test", app_metadata: { role: "admin" } };
const route = async (body: unknown, user: Parameters<typeof session>[0] = ADMIN) => {
  const res = await handleSlipReviewRequest(
    new NextRequest("http://localhost/api/admin/slip-reviews", { method: "POST", body: JSON.stringify(body) }),
    session(user), supa,
  );
  return { status: res.status, body: await res.json() };
};
const aiMoney = (src: string) => loadMarketScopedAiVerifiedTransfers(supa, src, DAY, src === "U2" ? OTHER_MARKET : MARKET, KNOWN);
const manualMoney = () => loadMarketScopedManualSlipBreakdown(supa, "U1", DAY, MARKET);

describe.skipIf(!pgAvailable)("isolated UAT: slip money end to end", () => {
  beforeAll(async () => {
    db = await createSlipTestDb("slip_uat", [
      ...SLIP_PIPELINE_MIGRATIONS,
      "0027_manual_slip_session.sql", "0029_settlement_finalizations.sql", "0030_manual_slip_market_key.sql",
      "20260926090000_manual_slip_atomic_append_close.sql",
    ]);
    for (const table of ["slip_batches", "slip_evidences", "settlement_finalizations", "manual_slip_sessions"]) {
      await db.query(`ALTER TABLE public.${table} ADD COLUMN IF NOT EXISTS accountability_round_id uuid`);
    }
    await db.query(`CREATE TABLE IF NOT EXISTS public.accountability_rounds (id uuid PRIMARY KEY, business_date date NOT NULL)`);
    for (const m of ["20261102120000_slip_check_approval_link", "20261102130000_manual_slip_entry_review", "20261102140000_slip_review_hardening", "20261102150000_slip_reference_scope", "20261102160000_finalization_claim_order", "20261103100000_slip_reference_claims", "20261103120000_financial_write_guards"]) {
      await db.exec(await Bun.file(`${ROOT}/supabase/migrations/${m}.sql`).text());
    }
    supa = createPgSupabase(db, { failUpload: new Set(), uploaded: new Map() });
  }, 180_000);

  afterAll(async () => {
    if (process.env.UAT_ARTIFACT) {
      const rows = results.map((r, i) =>
        `| ${i + 1} | ${r.scenario} | ${r.input} | \`${r.expected}\` | \`${r.actual}\` | ${r.pass ? "PASS" : "**FAIL**"} | ${r.evidence} |`);
      writeFileSync(process.env.UAT_ARTIFACT, [
        `# Isolated UAT — slip money end to end (${new Date().toISOString()})`, "",
        `Local PostgreSQL 17, business date ${DAY} (slip date ${SLIP_DATE_BE}). Real webhook, ledger, recovery, LINE summary builder, money loaders, round-close rows, admin route and review RPCs; simulated LINE download/Storage/OCR provider only.`, "",
        "| # | Scenario | Input | Expected | Actual | Result | Evidence |", "|---|---|---|---|---|---|---|", ...rows,
        "", `**${results.filter((r) => r.pass).length}/${results.length} PASS**`, "",
      ].join("\n"));
    }
    await db?.drop();
  }, 60_000);

  test("UAT end to end", async () => {
    // 1/3/4/11/13 — ingestion with a failed download, a redelivered webhook, then the LINE summary.
    const line1 = await runBatch("U1", MARKET, 7, [1]);
    record("Failed download recovered; redelivered webhook not duplicated", "7 images, #3 download fails once, #1 delivered twice",
      { evidences: 7, distinctMessages: 7 },
      { evidences: Number(await db.scalar(`SELECT count(*) FROM slip_evidences WHERE source_id = 'U1'`)),
        distinctMessages: Number(await db.scalar(`SELECT count(DISTINCT line_message_id) FROM slip_evidences WHERE source_id = 'U1'`)) },
      "slip_evidences / slip_image_events");
    record("LINE summary: confirmed vs readable-but-pending (outlier listed, not summed)", "U1 batch",
      { confirmed: 270, pending: 90 },
      { confirmed: lineAmount(line1, "ยอดยืนยัน"), pending: lineAmount(line1, "ยอดรอตรวจ") },
      "finalizer LINE push text (confirmed includes the ไทยช่วยไทย gross 100 — wallet policy pending)");

    // 5 — cross-market duplicate of reference UAT-1.
    const line2 = await runBatch("U2", OTHER_MARKET, 1);
    record("Duplicate reference across markets", "UAT-1 read in U1 and U2",
      { u2LineConfirmedIsAbsent: true, u2Money: 0 },
      { u2LineConfirmedIsAbsent: !/ยอดยืนยัน: [1-9]/.test(line2), u2Money: (await aiMoney("U2")).attributedTotal },
      "LINE U2 text + loader");

    // 1/2/3/4 + wallet — bank-transfer money before any decision.
    const before = await aiMoney("U1");
    record("Bank money before review: wrong date, no date, outlier, wallet all excluded", "U1",
      { attributed: 170, pendingDate: 90, pendingOutlier: 50000 },
      { attributed: before.attributedTotal, pendingDate: before.pendingDateAmount, pendingOutlier: before.pendingOutlierAmount },
      "loadMarketScopedAiVerifiedTransfers");

    // 6/7/12 — manual slips: AI+manual same reference, legacy, new-flow unreferenced.
    const [s] = await db.query<{ id: string }>(
      `INSERT INTO manual_slip_sessions (source_id, business_date, status, market_label, market_key) VALUES ('U1', '${DAY}', 'open', '${MARKET}', 'uat') RETURNING id`,
    );
    const append = await supa.rpc("append_manual_slip_entries_atomic", {
      p_session_id: s.id, p_line_message_id: "uat-manual", p_line_user_id: "U-op",
      p_entries: [
        { raw_line: "ยอด 70 อ้างอิง UAT-5", amount: 70, reference_id: "UAT-5" },
        { raw_line: "ยอด 30", amount: 30 },
        { raw_line: "ยอด 25", amount: 25, requires_review: true },
      ],
    });
    expect(append.error).toBeNull();
    await supa.rpc("close_manual_slip_session_atomic", { p_session_id: s.id, p_line_user_id: "U-op", p_line_message_id: "uat-close" });
    record("Manual: same reference as AI superseded; legacy counted; new unreferenced pending", "70(UAT-5) + 30 + 25(review)",
      { total: 30, superseded: 1, pending: 25 },
      (({ total, supersededCount, pendingAmount }) => ({ total, superseded: supersededCount, pending: pendingAmount }))(await manualMoney()),
      "loadMarketScopedManualSlipBreakdown");

    // 8 — admin route: non-admin refused; approve the misdated slip; override the pending manual entry.
    const misdated = await checkId("m-U1-2");
    record("Non-admin cannot review", "operator session", { status: 403 },
      { status: (await route({ action: "review", target: "slip_check", id: misdated, decision: "approved", amount: 50, reason: "x" }, { id: "op", app_metadata: { role: "operator" } })).status },
      "POST /api/admin/slip-reviews");
    const approve = await route({ action: "review", target: "slip_check", id: misdated, decision: "approved", amount: 50, reason: "ภาพเป็นวันตลาด", reviewer: "spoof" });
    const reviewer = await db.scalar(`SELECT reviewer FROM slip_check_approvals WHERE slip_check_id = '${misdated}'`);
    record("Admin approves misdated AI slip (reviewer = verified admin)", "approve UAT-2 at 50",
      { status: 200, reviewer: "admin@uat.test", attributed: 220 },
      { status: approve.status, reviewer, attributed: (await aiMoney("U1")).attributedTotal },
      "route + review_slip_check + loader");
    const repeat = await route({ action: "review", target: "slip_check", id: misdated, decision: "approved", amount: 50, reason: "ภาพเป็นวันตลาด" });
    record("Repeated approval request is idempotent", "same request twice", { status: 200, already: true },
      { status: repeat.status, already: repeat.body.already }, "route");
    const pendingEntry = (await db.query<{ id: string }>(`SELECT id FROM manual_slip_entries WHERE session_id = '${s.id}' AND requires_review`))[0].id;
    await route({ action: "review", target: "manual_entry", id: pendingEntry, decision: "approved", amount: 25, reason: "สลิปกระดาษ", reviewer: "x" });
    const manualAfter = await manualMoney();
    const aiAfter = await aiMoney("U1");
    record("Checked total after reviews (AI + manual), counted once", "after approvals",
      { ai: 220, manual: 55, checked: 275 },
      { ai: aiAfter.attributedTotal, manual: manualAfter.total, checked: aiAfter.attributedTotal + manualAfter.total },
      "loaders used by White Sheet / settlement / round close");

    // 15 — round-close rows equal the money; reject + revoke.
    const rows = await loadGuidedSlipRows(supa, {
      sourceId: "U1", businessDate: DAY, marketLabel: MARKET, marketLabelNormalized: MARKET,
      sessionKey: "k", lineUserId: "U-op", sellerLabel: "จ๋า", transactionType: "เบิก", sessionGeneration: "g",
    }, KNOWN);
    const verifiedSum = rows.filter((r) => r.status === "verified").reduce((t, r) => t + (r.amount ?? 0), 0);
    record("Round-close rows: verified rows sum to the AI money; excluded rows do not block", "U1 rows",
      { verifiedSum: 220, blockingRows: 0 },
      { verifiedSum, blockingRows: rows.filter((r) => r.status === "manual_review").length },
      "loadGuidedSlipRows");
    const four = await checkId("m-U1-4");
    const rejected = await route({ action: "review", target: "slip_check", id: four, decision: "rejected", reason: "ไม่ใช่ลูกค้า" });
    const afterReject = (await aiMoney("U1")).attributedTotal;
    const revoked = await route({ action: "revoke", id: rejected.body.approvalId, reason: "ตรวจใหม่ถูกต้อง" });
    expect(revoked.status).toBe(200);
    record("Reject excludes; revoke restores the automatic rule", "UAT-4 reject then revoke",
      { afterReject: 160, afterRevoke: 220 },
      { afterReject, afterRevoke: (await aiMoney("U1")).attributedTotal }, "route + loader");

    // 9 — the round is being finalized: no review lands afterwards.
    await db.query(`INSERT INTO settlement_finalizations (source_id, business_date, status) VALUES ('U1', '${DAY}', 'sending')`);
    const late = await route({ action: "review", target: "slip_check", id: await checkId("m-U1-3"), decision: "approved", amount: 40, reason: "x" });
    record("Review after the round entered finalization is refused", "approve UAT-3 after close",
      { status: 409, error: "slip_check_round_finalized", ai: 220 },
      { status: late.status, error: late.body.error, ai: (await aiMoney("U1")).attributedTotal }, "route + money-close lock");
  }, 300_000);
});
