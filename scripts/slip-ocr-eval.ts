/**
 * Offline slip OCR model evaluation (existing OpenAI model vs Gemini Flash).
 * Never writes to Supabase, never sends LINE messages, never touches
 * slip_checks. Production OCR is not changed by anything here.
 *
 *   export  READ-ONLY copy of already-ingested slip images + the stored
 *           Production result into a local folder, with an empty label per
 *           image for a human reviewer. Reads Production business data, so it
 *           refuses to run without SLIP_EVAL_PRODUCTION_READ_APPROVED=1.
 *     bun scripts/slip-ocr-eval.ts export <outDir> <batchId> [<batchId> ...]
 *
 *   run     Sends the LOCAL labelled images to each model N times. Refuses a
 *           provider not listed in SLIP_EVAL_PROVIDER_UPLOAD_APPROVED
 *           (comma list: openai,gemini) — slip images are private data.
 *     bun scripts/slip-ocr-eval.ts run <outDir> openai:gpt-6-luna gemini:gemini-3.8-flash [--runs 3]
 *
 *   score   Re-scores <outDir>/runs.jsonl against the labels. No network.
 *     bun scripts/slip-ocr-eval.ts score <outDir>
 *
 * Keep <outDir> OUTSIDE the repository: it holds private payment images.
 */
import { createClient } from "@supabase/supabase-js";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Database } from "../src/types/database";
import { OpenAiSlipExtractor, type SlipExtractor } from "../src/lib/slips/extractor";
import { GeminiSlipExtractor, readProviderUsage } from "../src/lib/slips/gemini-extractor";
import type { SlipExtraction } from "../src/lib/slips/extraction-schema";
import {
  groupsFor,
  renderAgreement,
  renderScores,
  scoreAgreement,
  scoreModel,
  type EvalItem,
  type PricePerMillion,
  type RunRecord,
} from "../src/lib/slips/ocr-eval";

/** USD per 1M tokens, standard paid tier, read 2026-10-31 from the official pricing pages. */
const PRICES: Record<string, PricePerMillion> = {
  "openai:gpt-6-luna": { input: 0.10, output: 0.50 },
  "openai:gpt-6.1-sol": { input: 2.00, output: 10.00 },
  // Introductory until 2026-12-31; $1.50 / $7.50 from 2027-01-01.
  "gemini:gemini-3.8-flash": { input: 0.75, output: 3.75 },
  "gemini:gemini-3.1-flash-lite": { input: 0.25, output: 1.50 },
  "gemini:gemini-3.5-flash-lite": { input: 0.30, output: 2.50 },
};

const [command, outArg, ...rest] = process.argv.slice(2);
if (!command || !outArg) {
  console.error("usage: slip-ocr-eval.ts <export|run|score> <outDir> ...");
  process.exit(2);
}
const outDir = resolve(outArg);
if (outDir.startsWith(resolve(import.meta.dir, ".."))) {
  throw new Error("refusing an output folder inside the repository: it holds private slip images");
}
const manifestPath = join(outDir, "manifest.json");
const runsPath = join(outDir, "runs.jsonl");

if (command === "export") await exportBatches(rest);
else if (command === "run") await runModels(rest);
else if (command === "score") await score();
else throw new Error(`unknown command ${command}`);

async function exportBatches(args: string[]) {
  let batchIds = args;
  if (process.env.SLIP_EVAL_PRODUCTION_READ_APPROVED !== "1") {
    throw new Error("export reads Production slip images: set SLIP_EVAL_PRODUCTION_READ_APPROVED=1 only with written approval");
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase environment variables.");
  const supabase = createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  // --recent-images N: newest batches whose summary was already sent, until >= N images.
  const recentIdx = batchIds.indexOf("--recent-images");
  if (recentIdx >= 0) {
    const want = Number(batchIds[recentIdx + 1]);
    if (!Number.isInteger(want) || want < 1 || want > 500) throw new Error("--recent-images must be 1..500");
    const { data: recent, error } = await supabase
      .from("slip_batches").select("id, image_count")
      .not("summary_sent_at", "is", null).gt("image_count", 0)
      .order("created_at", { ascending: false }).limit(200);
    if (error) throw new Error(`recent batches: ${error.message}`);
    batchIds = [];
    let total = 0;
    for (const b of recent ?? []) {
      if (total >= want) break;
      batchIds.push(b.id);
      total += b.image_count;
    }
  }
  if (batchIds.length === 0) throw new Error("export needs batch ids or --recent-images N");
  await mkdir(join(outDir, "images"), { recursive: true });

  const items: EvalItem[] = [];
  const stored: RunRecord[] = [];
  for (const batchId of batchIds) {
    const { data: batch, error: batchError } = await supabase
      .from("slip_batches").select("id, slip_date").eq("id", batchId).maybeSingle();
    if (batchError || !batch) throw new Error(`batch ${batchId}: ${batchError?.message ?? "not found"}`);
    const { data: evidences, error } = await supabase
      .from("slip_evidences")
      .select("id, storage_bucket, storage_path, mime_type, status, received_at")
      .eq("batch_id", batchId)
      .eq("status", "RECEIVED")
      .order("received_at", { ascending: true });
    if (error) throw new Error(`evidences ${batchId}: ${error.message}`);
    const { data: checks, error: checkError } = await supabase
      .from("slip_checks")
      .select("evidence_id, slip_type, gross_amount, discount_amount, paid_amount, transfer_amount, reference_id, transaction_time, confidence")
      .in("evidence_id", (evidences ?? []).map((e) => e.id));
    if (checkError) throw new Error(`checks ${batchId}: ${checkError.message}`);
    const checkByEvidence = new Map((checks ?? []).map((c) => [c.evidence_id, c]));

    for (const e of evidences ?? []) {
      const { data: blob, error: dlError } = await supabase.storage.from(e.storage_bucket).download(e.storage_path);
      if (dlError || !blob) throw new Error(`download ${e.id}: ${dlError?.message ?? "empty"}`);
      const file = join("images", `${e.id}.${(e.mime_type ?? "image/jpeg").split("/")[1] ?? "jpg"}`);
      await writeFile(join(outDir, file), new Uint8Array(await blob.arrayBuffer()));
      items.push({
        id: e.id, file, mimeType: e.mime_type ?? "image/jpeg", batchKey: batchId,
        slipDate: batch.slip_date, tags: [], label: null,
      });
      // The result Production actually stored (names/account tail deliberately not exported).
      const c = checkByEvidence.get(e.id);
      const extraction: SlipExtraction | null = c?.slip_type ? {
        slipType: c.slip_type, grossAmount: c.gross_amount, discountAmount: c.discount_amount,
        paidAmount: c.paid_amount, transferAmount: c.transfer_amount, referenceId: c.reference_id,
        transactionTime: c.transaction_time, senderName: null, receiverName: null,
        receiverAccountTail: null, paymentChannelText: null, headlineTotalAmount: null,
        confidence: c.confidence ?? 0,
      } : null;
      stored.push({ itemId: e.id, model: "production:stored", run: 1, extraction, error: extraction ? null : "no stored check", latencyMs: 0, usage: null });
    }
  }
  await writeFile(manifestPath, JSON.stringify(items, null, 2));
  await writeFile(runsPath, stored.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`exported ${items.length} images from ${batchIds.length} batches to ${outDir}`);
  console.log("next: a reviewer fills `label` (and `tags`) for each item in manifest.json from the image itself");
}

async function runModels(args: string[]) {
  const runsIdx = args.indexOf("--runs");
  const runs = runsIdx >= 0 ? Number(args[runsIdx + 1]) : 3;
  const models = args.filter((a, i) => a.includes(":") && (runsIdx < 0 || i !== runsIdx + 1));
  if (models.length === 0) throw new Error("run needs at least one provider:model");
  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
  const approved = new Set((process.env.SLIP_EVAL_PROVIDER_UPLOAD_APPROVED ?? "").split(",").map((s) => s.trim()));
  for (const m of models) {
    const provider = m.split(":")[0];
    if (!approved.has(provider)) {
      throw new Error(`${provider} is not in SLIP_EVAL_PROVIDER_UPLOAD_APPROVED: private slip images may not be sent to it`);
    }
  }
  // Every exported image runs, labelled or not: agreement metrics need no label.
  const items = JSON.parse(await readFile(manifestPath, "utf8")) as EvalItem[];
  if (items.length === 0) throw new Error("manifest.json has no items");

  for (const spec of models) {
    const [provider, model] = spec.split(":") as ["openai" | "gemini", string];
    let lastPayload: unknown = null;
    // Tee the provider reply to read token usage without changing the extractor.
    const tee = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fetch(input, init);
      lastPayload = await response.clone().json().catch(() => null);
      return response;
    }) as typeof fetch;
    const extractor: SlipExtractor = provider === "openai"
      ? new OpenAiSlipExtractor(undefined, model, tee)
      : new GeminiSlipExtractor(undefined, model, tee);
    for (let run = 1; run <= runs; run++) {
      for (const item of items) {
        const bytes = new Uint8Array(await readFile(join(outDir, item.file)));
        lastPayload = null;
        const started = performance.now();
        let extraction: SlipExtraction | null = null;
        let error: string | null = null;
        try {
          extraction = await extractor.extract({ bytes, mimeType: item.mimeType });
        } catch (e) {
          error = e instanceof Error ? e.message.slice(0, 120) : "error";
        }
        const record: RunRecord = {
          itemId: item.id, model: spec, run, extraction, error,
          latencyMs: Math.round(performance.now() - started),
          usage: readProviderUsage(provider, lastPayload),
        };
        await appendFile(runsPath, JSON.stringify(record) + "\n");
      }
      console.log(`${spec}: run ${run}/${runs} done`);
    }
  }
  await score();
}

async function score() {
  const items = JSON.parse(await readFile(manifestPath, "utf8")) as EvalItem[];
  const records = existsSync(runsPath)
    ? (await readFile(runsPath, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as RunRecord)
    : [];
  const models = [...new Set(records.map((r) => r.model))];
  const unlabelled = items.filter((i) => i.label === null).length;
  const reference = "production:stored";
  const agreement = models.filter((m) => m !== reference)
    .map((m) => scoreAgreement(m, reference, items, records, PRICES[m] ?? null));
  const typeCounts = new Map<string, number>();
  for (const r of records.filter((x) => x.model === reference)) {
    const t = r.extraction?.slipType ?? "NO_STORED_RESULT";
    typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
  }
  const report = [
    `# Slip OCR evaluation (${new Date().toISOString()})`,
    `Images: ${items.length} (labelled ${items.length - unlabelled}). Stored slip types: ${[...typeCounts].map(([t, n]) => `${t} ${n}`).join(", ")}.`,
    "Accepted = Production status rule + batch validation guard. QR codes are NOT decoded anywhere in the pipeline;",
    "every acceptance below is AI image extraction only.",
    "",
    "## Label-free: agreement with the result Production stored (agreement is NOT accuracy)",
    renderAgreement(agreement),
    "",
    "## Accuracy against human labels",
    unlabelled === items.length
      ? "No labels yet: label the images in disagreements.json first, then re-run `score`."
      : renderScores(groupsFor(items).flatMap(([group, inGroup]) =>
          models.map((m) => scoreModel(m, items, records, PRICES[m] ?? null, group, inGroup)))),
  ].join("\n");
  await writeFile(join(outDir, "report.md"), report);
  await writeFile(join(outDir, "disagreements.json"), JSON.stringify(
    agreement.flatMap((a) => a.disagreements.map((d) => ({ ...d, modelName: a.model }))), null, 2));
  console.log(report);
}
