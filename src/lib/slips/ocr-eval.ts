import {
  determineSlipCheckStatus,
  type SlipExtraction,
  type SlipType,
} from "@/lib/slips/extraction-schema";
import { isVerifiedSlipCheckStatus } from "@/lib/slips/transaction-dedupe";
import { computeValidationFlags, parseBatchDate } from "@/lib/slips/validation-guard";
import type { ProviderUsage } from "@/lib/slips/gemini-extractor";

/**
 * Offline OCR model evaluation: scores extraction runs against human labels
 * with the SAME status rule (determineSlipCheckStatus) and the SAME batch
 * validation guard (date, outlier, in-batch duplicate) Production applies, so
 * "accepted" here means "would have been counted as a confirmed sale".
 */

/** Human ground truth. Never derived from either model's output. */
export interface EvalLabel {
  slipType: SlipType;
  /** Effective amount a reviewer confirmed (THB); null = not a payable slip. */
  amount: number | null;
  /** True when the date+time is visible on the image. */
  dateVisible: boolean;
  referenceId: string | null;
  /** False: a correct pipeline must send this image to human review. */
  shouldAccept: boolean;
}

export interface EvalItem {
  id: string;
  file: string;
  mimeType: string;
  /** Images of one slip batch, in LINE order; the duplicate guard runs per batch. */
  batchKey: string;
  /** Batch slip_date, e.g. "16/10/2569"; enables the date guard. */
  slipDate: string | null;
  /** e.g. thai_help_thai, no_qr, qr_present, tilted, glare, missing_date, duplicate. */
  tags: string[];
  label: EvalLabel | null;
}

export interface RunRecord {
  itemId: string;
  model: string;
  run: number;
  extraction: SlipExtraction | null;
  error: string | null;
  latencyMs: number;
  usage: ProviderUsage | null;
}

export interface PricePerMillion { input: number; output: number }

export interface ModelScore {
  model: string;
  group: string;
  itemRuns: number;
  /** Accepted (would count as a confirmed sale) with the right amount. */
  correctAccept: number;
  /** Accepted although the label says review, or accepted with a wrong amount. */
  falseAccept: number;
  /** Sent to human review (includes provider errors). */
  review: number;
  /** Sent to review although a correct read was possible. */
  unnecessaryReview: number;
  providerError: number;
  missingAmount: number;
  missingDate: number;
  missingReference: number;
  /** Of the labelled items: every run gave the same decision and amount. */
  consistentItems: number;
  items: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  avgCostUsd: number | null;
}

const satang = (thb: number) => Math.round(thb * 100);

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

interface Outcome { itemId: string; run: number; trusted: boolean; amount: number | null; record: RunRecord }

/** Applies Production's per-batch guard to one model's run `run`, items in manifest order. */
function outcomesFor(items: EvalItem[], records: RunRecord[]): Outcome[] {
  const byKey = new Map(records.map((r) => [`${r.itemId}#${r.run}`, r]));
  const runs = [...new Set(records.map((r) => r.run))];
  const batches = [...new Set(items.map((i) => i.batchKey))];
  const out: Outcome[] = [];
  for (const run of runs) {
    for (const batchKey of batches) {
      const batchItems = items.filter((i) => i.batchKey === batchKey && byKey.has(`${i.id}#${run}`));
      const recs = batchItems.map((i) => byKey.get(`${i.id}#${run}`)!);
      const evidences = recs.map((r) => {
        const e = r.extraction;
        return {
          checkStatus: e ? determineSlipCheckStatus(e) : "FAILED" as const,
          slipType: e?.slipType ?? null,
          transferAmount: e?.transferAmount ?? null,
          paidAmount: e?.paidAmount ?? null,
          grossAmount: e?.grossAmount ?? null,
          discountAmount: e?.discountAmount ?? null,
          transactionTime: e?.transactionTime ?? null,
          referenceId: e?.referenceId ?? null,
        };
      });
      const flags = computeValidationFlags(evidences, parseBatchDate(batchItems[0]?.slipDate ?? null));
      recs.forEach((record, i) => out.push({
        itemId: record.itemId,
        run,
        trusted: isVerifiedSlipCheckStatus(evidences[i].checkStatus) && !flags[i].flagged,
        amount: flags[i].effectiveAmount,
        record,
      }));
    }
  }
  return out;
}

export function scoreModel(
  model: string,
  items: EvalItem[],
  allRecords: RunRecord[],
  price: PricePerMillion | null,
  group = "all",
  inGroup: (item: EvalItem) => boolean = () => true,
): ModelScore {
  const labelled = items.filter((i) => i.label !== null);
  // The guard needs the whole batch (duplicates), so outcomes use every item.
  const outcomes = outcomesFor(labelled, allRecords.filter((r) => r.model === model));
  const itemById = new Map(labelled.map((i) => [i.id, i]));
  const scoped = outcomes.filter((o) => inGroup(itemById.get(o.itemId)!));

  const score: ModelScore = {
    model, group, itemRuns: scoped.length,
    correctAccept: 0, falseAccept: 0, review: 0, unnecessaryReview: 0, providerError: 0,
    missingAmount: 0, missingDate: 0, missingReference: 0,
    consistentItems: 0, items: new Set(scoped.map((o) => o.itemId)).size,
    latencyP50Ms: null, latencyP95Ms: null, avgCostUsd: null,
  };
  for (const o of scoped) {
    const label = itemById.get(o.itemId)!.label!;
    const e = o.record.extraction;
    const amountRight = label.amount !== null && o.amount !== null && satang(o.amount) === satang(label.amount);
    if (!e) score.providerError += 1;
    if (o.trusted && label.shouldAccept && amountRight) score.correctAccept += 1;
    else if (o.trusted) score.falseAccept += 1;
    else {
      score.review += 1;
      if (label.shouldAccept) score.unnecessaryReview += 1;
    }
    if (label.amount !== null && o.amount === null) score.missingAmount += 1;
    if (label.dateVisible && !e?.transactionTime) score.missingDate += 1;
    if (label.referenceId !== null && !e?.referenceId) score.missingReference += 1;
  }
  const byItem = new Map<string, Outcome[]>();
  for (const o of scoped) byItem.set(o.itemId, [...(byItem.get(o.itemId) ?? []), o]);
  for (const runs of byItem.values()) {
    const key = (o: Outcome) => `${o.trusted}:${o.amount === null ? "-" : satang(o.amount)}`;
    if (runs.every((o) => key(o) === key(runs[0]))) score.consistentItems += 1;
  }
  const latencies = scoped.filter((o) => o.record.extraction).map((o) => o.record.latencyMs).sort((a, b) => a - b);
  score.latencyP50Ms = percentile(latencies, 50);
  score.latencyP95Ms = percentile(latencies, 95);
  const usages = scoped.map((o) => o.record.usage).filter((u): u is ProviderUsage => u !== null);
  if (price && usages.length > 0) {
    const total = usages.reduce((sum, u) => sum + u.inputTokens * price.input + u.outputTokens * price.output, 0);
    score.avgCostUsd = total / 1_000_000 / usages.length;
  }
  return score;
}

export interface AgreementScore {
  model: string;
  reference: string;
  items: number;
  itemRuns: number;
  /** Not accepted by the Production rule + guard (includes provider errors). */
  review: number;
  providerError: number;
  noAmount: number;
  noDate: number;
  noReference: number;
  consistentItems: number;
  /** Same decision and same amount (satang) as the reference model's run 1. */
  agree: number;
  /** Accepted by this model with an amount the reference did not accept or read differently. */
  acceptedDisagree: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  avgCostUsd: number | null;
  disagreements: Array<{ itemId: string; run: number; reference: string; model: string }>;
}

/**
 * Label-free comparison against a reference model (normally production:stored).
 * Agreement is NOT accuracy: it tells a reviewer which images to label first.
 */
export function scoreAgreement(
  model: string,
  reference: string,
  items: EvalItem[],
  allRecords: RunRecord[],
  price: PricePerMillion | null,
): AgreementScore {
  const decision = (o: Outcome | undefined) =>
    !o ? "missing" : o.trusted ? `accept ${o.amount === null ? "-" : (satang(o.amount) / 100).toFixed(2)}` : "review";
  const ref = new Map(
    outcomesFor(items, allRecords.filter((r) => r.model === reference && r.run === 1)).map((o) => [o.itemId, o]),
  );
  const mine = outcomesFor(items, allRecords.filter((r) => r.model === model));
  const s: AgreementScore = {
    model, reference, items: new Set(mine.map((o) => o.itemId)).size, itemRuns: mine.length,
    review: 0, providerError: 0, noAmount: 0, noDate: 0, noReference: 0, consistentItems: 0,
    agree: 0, acceptedDisagree: 0, latencyP50Ms: null, latencyP95Ms: null, avgCostUsd: null, disagreements: [],
  };
  for (const o of mine) {
    const e = o.record.extraction;
    if (!o.trusted) s.review += 1;
    if (!e) s.providerError += 1;
    if (o.amount === null) s.noAmount += 1;
    if (!e?.transactionTime) s.noDate += 1;
    if (!e?.referenceId) s.noReference += 1;
    const r = ref.get(o.itemId);
    if (decision(o) === decision(r)) s.agree += 1;
    else {
      if (o.trusted) s.acceptedDisagree += 1;
      s.disagreements.push({ itemId: o.itemId, run: o.run, reference: decision(r), model: decision(o) });
    }
  }
  const byItem = new Map<string, string[]>();
  for (const o of mine) byItem.set(o.itemId, [...(byItem.get(o.itemId) ?? []), decision(o)]);
  for (const ds of byItem.values()) if (ds.every((d) => d === ds[0])) s.consistentItems += 1;
  const latencies = mine.filter((o) => o.record.extraction).map((o) => o.record.latencyMs).sort((a, b) => a - b);
  s.latencyP50Ms = percentile(latencies, 50);
  s.latencyP95Ms = percentile(latencies, 95);
  const usages = mine.map((o) => o.record.usage).filter((u): u is ProviderUsage => u !== null);
  if (price && usages.length > 0) {
    s.avgCostUsd = usages.reduce((sum, u) => sum + u.inputTokens * price.input + u.outputTokens * price.output, 0)
      / 1_000_000 / usages.length;
  }
  return s;
}

export function renderAgreement(scores: AgreementScore[]): string {
  return [
    "| model | vs | items | runs | agree | accepted-but-disagree | review | no amount | no date | no ref | consistent | provider error | p50 ms | p95 ms | cost/image |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...scores.map((s) => `| ${[
      s.model, s.reference, s.items, s.itemRuns, pct(s.agree, s.itemRuns), pct(s.acceptedDisagree, s.itemRuns),
      pct(s.review, s.itemRuns), pct(s.noAmount, s.itemRuns), pct(s.noDate, s.itemRuns), pct(s.noReference, s.itemRuns),
      pct(s.consistentItems, s.items), pct(s.providerError, s.itemRuns), s.latencyP50Ms ?? "-", s.latencyP95Ms ?? "-",
      s.avgCostUsd === null ? "-" : `$${s.avgCostUsd.toFixed(5)}`,
    ].join(" | ")} |`),
  ].join("\n");
}

const pct = (n: number, d: number) => (d === 0 ? "-" : `${((100 * n) / d).toFixed(1)}%`);

/** Markdown table: one row per model per group (all, each tag, each labelled slip type). */
export function renderScores(scores: ModelScore[]): string {
  const rows = scores.map((s) => [
    s.group, s.model, s.items, s.itemRuns,
    pct(s.correctAccept, s.itemRuns), pct(s.falseAccept, s.itemRuns), pct(s.review, s.itemRuns),
    pct(s.unnecessaryReview, s.itemRuns), pct(s.missingAmount, s.itemRuns), pct(s.missingDate, s.itemRuns),
    pct(s.missingReference, s.itemRuns), pct(s.consistentItems, s.items), pct(s.providerError, s.itemRuns),
    s.latencyP50Ms ?? "-", s.latencyP95Ms ?? "-",
    s.avgCostUsd === null ? "-" : `$${s.avgCostUsd.toFixed(5)}`,
  ].join(" | "));
  return [
    "| group | model | items | runs | correct accept | FALSE ACCEPT | review | unnecessary review | missing amount | missing date | missing ref | consistent | provider error | p50 ms | p95 ms | cost/image |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r} |`),
  ].join("\n");
}

export function groupsFor(items: EvalItem[]): Array<[string, (item: EvalItem) => boolean]> {
  const tags = [...new Set(items.flatMap((i) => i.tags))].sort();
  const types = [...new Set(items.flatMap((i) => (i.label ? [i.label.slipType] : [])))].sort();
  return [
    ["all", () => true],
    ...tags.map((t) => [`tag:${t}`, (i: EvalItem) => i.tags.includes(t)] as [string, (item: EvalItem) => boolean]),
    ...types.map((t) => [`type:${t}`, (i: EvalItem) => i.label?.slipType === t] as [string, (item: EvalItem) => boolean]),
  ];
}
