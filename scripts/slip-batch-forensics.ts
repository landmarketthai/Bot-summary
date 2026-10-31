/**
 * READ-ONLY forensics for one slip batch: per image, in LINE send order, what
 * the system stored and which existing rule kept it out of the confirmed total.
 * Writes nothing, sends nothing. Does not print names or account digits;
 * reference ids are masked to their last 4 characters.
 *
 *   SLIP_FORENSICS_PRODUCTION_READ_APPROVED=1 bun --env-file=<.env.local> \
 *     scripts/slip-batch-forensics.ts --market "วัดทุ่งลานนา" --slip-date 29/10/2569 [--seller "จ๋า"]
 *   ... scripts/slip-batch-forensics.ts --batch <uuid>
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/types/database";
import type { SlipExtraction, SlipType } from "../src/lib/slips/extraction-schema";
import { applyGlobalDuplicateExclusions, type EvidenceWithCheck } from "../src/lib/slips/batch-finalizer";
import { computeValidationFlags, parseBatchDate } from "../src/lib/slips/validation-guard";
import { anyReadAmount, diagnoseSlipImage, type StoredCheck } from "../src/lib/slips/forensics";

if (process.env.SLIP_FORENSICS_PRODUCTION_READ_APPROVED !== "1") {
  throw new Error("reads Production slip data: set SLIP_FORENSICS_PRODUCTION_READ_APPROVED=1 only with approval");
}
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("Missing Supabase environment variables.");
const supabase = createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const must = <T>(r: { data: T | null; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as T;
};
const mask = (ref: string | null) => (ref ? `…${ref.slice(-4)} (len ${ref.length})` : null);

const batchCols = "id, status, seller_name, market_name, slip_date, image_count, success_count, failed_count, created_at, closing_at, close_event_ts_ms, open_event_ts_ms, finalized_at, summary_sent_at";
let batchQuery = supabase.from("slip_batches").select(batchCols).order("created_at", { ascending: true });
if (arg("--batch")) batchQuery = batchQuery.eq("id", arg("--batch")!);
else {
  if (!arg("--market") || !arg("--slip-date")) throw new Error("need --batch or --market + --slip-date");
  batchQuery = batchQuery.ilike("market_name", `%${arg("--market")}%`).eq("slip_date", arg("--slip-date")!);
  if (arg("--seller")) batchQuery = batchQuery.ilike("seller_name", `%${arg("--seller")}%`);
}
const batches = must(await batchQuery, "batches") as Array<Record<string, unknown> & { id: string; slip_date: string | null }>;
console.log(`batches found: ${batches.length}`);

for (const batch of batches) {
  console.log("\n=== batch", JSON.stringify(batch));
  const accounting = await supabase.rpc("slip_batch_image_accounting", { p_batch_id: batch.id });
  console.log("ledger accounting:", JSON.stringify(accounting.data ?? accounting.error?.message));

  const ledger = must(await supabase.from("slip_image_events")
    .select("line_message_id, event_ts_ms, state, attempts, last_error, evidence_id")
    .eq("batch_id", batch.id).order("event_ts_ms", { ascending: true }), "ledger") ?? [];
  const evidences = must(await supabase.from("slip_evidences")
    .select("id, line_message_id, batch_index, status, received_at")
    .eq("batch_id", batch.id), "evidences") ?? [];
  const checks = evidences.length === 0 ? [] : must(await supabase.from("slip_checks")
    .select("id, evidence_id, status, failure_reason, slip_type, gross_amount, discount_amount, paid_amount, transfer_amount, reference_id, transaction_time, confidence, extracted_json, created_at, updated_at")
    .in("evidence_id", evidences.map((e) => e.id)), "checks") ?? [];
  const corrections = checks.length === 0 ? [] : must(await supabase.from("slip_check_amount_corrections")
    .select("check_id").in("check_id", checks.map((c) => c.id)), "corrections") ?? [];

  const evByMsg = new Map(evidences.map((e) => [e.line_message_id, e]));
  const checkByEv = new Map(checks.map((c) => [c.evidence_id, c]));
  // LINE order from the ledger; evidence without a ledger row goes last, flagged.
  const order = [
    ...ledger.map((l) => l.line_message_id),
    ...evidences.filter((e) => !ledger.some((l) => l.line_message_id === e.line_message_id)).map((e) => e.line_message_id),
  ];

  const rows = order.map((msg, i) => {
    const ev = evByMsg.get(msg);
    const c = ev ? checkByEv.get(ev.id) : undefined;
    const json = (c?.extracted_json ?? {}) as Record<string, unknown>;
    const extraction: SlipExtraction | null = c?.slip_type ? {
      slipType: c.slip_type as SlipType, grossAmount: c.gross_amount, discountAmount: c.discount_amount,
      paidAmount: c.paid_amount, transferAmount: c.transfer_amount, referenceId: c.reference_id,
      transactionTime: c.transaction_time, senderName: null, receiverName: null, receiverAccountTail: null,
      paymentChannelText: typeof json.payment_channel_text === "string" ? json.payment_channel_text : null,
      headlineTotalAmount: typeof json.headline_total_amount === "number" ? json.headline_total_amount : null,
      confidence: c.confidence ?? 0,
    } : null;
    const evidence: EvidenceWithCheck | null = ev ? {
      id: ev.id, checkId: c?.id ?? null, batchIndex: ev.batch_index,
      checkStatus: (c?.status ?? null) as EvidenceWithCheck["checkStatus"], slipType: extraction?.slipType ?? null,
      transferAmount: c?.transfer_amount ?? null, paidAmount: c?.paid_amount ?? null,
      grossAmount: c?.gross_amount ?? null, discountAmount: c?.discount_amount ?? null,
      transactionTime: c?.transaction_time ?? null, referenceId: c?.reference_id ?? null, failureReason: c?.failure_reason ?? null,
    } : null;
    return { lineSeq: i + 1, msg, ledger: ledger.find((l) => l.line_message_id === msg), ev, c, extraction, evidence };
  });

  const attachedEvidences = rows.filter((r) => r.evidence).map((r) => r.evidence!);
  const deduped = await applyGlobalDuplicateExclusions(supabase as never, attachedEvidences);
  const flags = computeValidationFlags(deduped, parseBatchDate(batch.slip_date));
  const flagsById = new Map(deduped.map((e, i) => [e.id, { flags: flags[i], global: e.globallyDuplicate === true }]));

  let confirmedTotal = 0;
  for (const r of rows) {
    const f = r.ev ? flagsById.get(r.ev.id) : undefined;
    const stored: StoredCheck | null = r.c
      ? { status: r.c.status as StoredCheck["status"], failureReason: r.c.failure_reason, extraction: r.extraction }
      : null;
    const d = diagnoseSlipImage(!!r.ev, stored, f?.flags ?? null);
    if (d.diagnosis === "CONFIRMED") confirmedTotal += f?.flags.effectiveAmount ?? 0;
    console.log(JSON.stringify({
      lineSeq: r.lineSeq,
      lineMessageId: r.msg,
      lineTs: r.ledger?.event_ts_ms ?? null,
      ledgerState: r.ledger?.state ?? "NO_LEDGER_ROW",
      attempts: r.ledger?.attempts ?? null,
      ledgerError: r.ledger?.last_error ?? null,
      oldSummaryNo: r.ev?.batch_index ?? null,
      evidenceStatus: r.ev?.status ?? null,
      checkStatus: r.c?.status ?? null,
      failureReason: r.c?.failure_reason ?? null,
      slipType: r.extraction?.slipType ?? null,
      amounts: r.extraction && {
        transfer: r.extraction.transferAmount, gross: r.extraction.grossAmount,
        discount: r.extraction.discountAmount, paid: r.extraction.paidAmount, headline: r.extraction.headlineTotalAmount,
      },
      amountSeen: r.extraction ? anyReadAmount(r.extraction) : null,
      effectiveAmount: f?.flags.effectiveAmount ?? null,
      transactionTime: r.c?.transaction_time ?? null,
      reference: mask(r.c?.reference_id ?? null),
      paymentChannelText: r.extraction?.paymentChannelText ?? null,
      confidence: r.c?.confidence ?? null,
      guardReasons: f?.flags.flagReasons ?? [],
      globalDuplicate: f?.global ?? false,
      amountCorrections: corrections.filter((x) => x.check_id === r.c?.id).length,
      checkCreated: r.c?.created_at ?? null,
      diagnosis: d.diagnosis,
      detail: d.detail,
    }));
  }
  console.log(`confirmed total by current code: ${confirmedTotal}`);
}
