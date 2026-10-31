/**
 * @Botsummary evaluation. Never touches Production data, LINE or the job
 * database: business data is the fixture set behind the real authorization
 * layer, the queue is in memory.
 *
 *   bun scripts/ai-assistant-eval.ts                          # harness check (scripted stand-in)
 *   bun scripts/ai-assistant-eval.ts --model live --max-usd 2 # GPT-6 Luna (BOT_SUMMARY_ANALYST_MODEL)
 *     --out-md docs/ai-assistant/eval-results.md --out-json <scratch>/eval.json [--ids fin-01,pro-02]
 *
 * Live mode needs ALL of:
 *   BOT_SUMMARY_EVAL_OPENAI_API_KEY   an explicit TEST key (OPENAI_API_KEY is never used here)
 *   BOT_SUMMARY_ANALYST_INPUT_USD_PER_MTOK / _OUTPUT_USD_PER_MTOK (and optionally _CACHED_INPUT_)
 *   --max-usd <budget>                new cases stop once the estimated spend reaches it
 * Otherwise it writes a NOT RUN report and exits 2.
 *
 * A  deterministic backend rules (business date, follow-up, 1:1 staff authorization)
 * B  answer-level grading of the final answer against authoritative fixture values;
 *    tool choice is reported as a diagnostic only. The scripted stand-in measures the
 *    harness, NOT GPT-6 Luna.
 */
import { writeFileSync } from "node:fs";
import type { ReadonlyAnalystToolRequest } from "../src/lib/ai/readonly-tools";
import { createOpenAIResponsesProvider, type AssistantModelProvider } from "../src/lib/ai/model-provider";
import { authorizeToolRequest, type AssistantScope } from "../src/lib/ai/assistant/authorization";
import { isFollowUpQuestion, resolveJobBusinessDate } from "../src/lib/ai/assistant/core";
import { ANSWER_EVAL_SET } from "../src/lib/ai/assistant/eval/answer-eval-set";
import { runAnswerEval, type CaseResult, type EvalSummary } from "../src/lib/ai/assistant/eval/runner";
import { FIXTURE_MARKETS } from "../src/lib/ai/assistant/testing/fixture-data";
import { ScriptedThaiModel } from "../src/lib/ai/assistant/testing/scripted-provider";
import { THAI_EVAL_ASKED_DATE, THAI_EVAL_SET } from "../src/lib/ai/assistant/testing/thai-eval-set";

const arg = (name: string) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
};
const mode = arg("--model") === "live" ? "live" : "scripted";
const ids = arg("--ids")?.split(",").map((id) => id.trim()).filter(Boolean);
const cases = ids ? ANSWER_EVAL_SET.filter((testCase) => ids.includes(testCase.id)) : ANSWER_EVAL_SET;
const outMd = arg("--out-md");
const outJson = arg("--out-json");

function write(markdown: string, json: unknown) {
  if (outMd) writeFileSync(outMd, markdown);
  if (outJson) writeFileSync(outJson, JSON.stringify(json, null, 2));
  console.log(markdown);
}

const pct = (n: number, d: number) => `${n}/${d} (${d ? Math.round((n / d) * 1000) / 10 : 0}%)`;

// ── A. deterministic rules ──────────────────────────────────────────────────
const STAFF_DAM: AssistantScope = {
  lineUserId: "Udam", role: "staff", staffLabel: "ดำ", markets: new Set([FIXTURE_MARKETS.RATCHAPHRUEK]), grantSource: "grant",
};
const sectionA = THAI_EVAL_SET.map((item) => {
  const turns = item.previous
    ? [{ question: item.previous, answer: "-", businessDate: resolveJobBusinessDate(item.previous, THAI_EVAL_ASKED_DATE, []), context: {}, eventTimestampMs: 1 }]
    : [];
  const request = item.expectedTool
    ? ({ tool: item.expectedTool, businessDate: item.expectedBusinessDate, staff: null, market: null, days: 2, ...item.expectedArgs } as unknown as ReadonlyAnalystToolRequest)
    : null;
  const decision = request === null ? "no_tool" : (() => {
    const result = authorizeToolRequest(STAFF_DAM, request);
    return result.ok ? "allowed" : result.reason;
  })();
  return {
    date: resolveJobBusinessDate(item.question, THAI_EVAL_ASKED_DATE, turns) === item.expectedBusinessDate,
    followUp: isFollowUpQuestion(item.question) === item.expectedFollowUp,
    auth: decision === item.staffDecision,
  };
});

const header = [
  "# @Botsummary evaluation report",
  "",
  `Run at ${new Date().toISOString()} · fixture data only (no Production data) · asked business date ${THAI_EVAL_ASKED_DATE}.`,
  "",
  "## A. Deterministic backend rules",
  "",
  `- Business date: ${pct(sectionA.filter((row) => row.date).length, sectionA.length)}`,
  `- Follow-up detection: ${pct(sectionA.filter((row) => row.followUp).length, sectionA.length)}`,
  `- 1:1 staff authorization decision: ${pct(sectionA.filter((row) => row.auth).length, sectionA.length)}`,
  "",
];

// ── B. answer-level evaluation ──────────────────────────────────────────────
let provider: AssistantModelProvider;
let label: string;
let maxUsd: number | null = null;
if (mode === "live") {
  const key = process.env.BOT_SUMMARY_EVAL_OPENAI_API_KEY?.trim();
  const budget = Number(arg("--max-usd"));
  const priced = Boolean(process.env.BOT_SUMMARY_ANALYST_INPUT_USD_PER_MTOK?.trim() && process.env.BOT_SUMMARY_ANALYST_OUTPUT_USD_PER_MTOK?.trim());
  const missing = [
    !key && "BOT_SUMMARY_EVAL_OPENAI_API_KEY (explicit test key)",
    !(Number.isFinite(budget) && budget > 0) && "--max-usd <budget>",
    !priced && "BOT_SUMMARY_ANALYST_INPUT_USD_PER_MTOK and _OUTPUT_USD_PER_MTOK (to enforce the budget)",
  ].filter(Boolean);
  if (missing.length) {
    const markdown = [...header, "## B. Live model evaluation", "", `**NOT RUN.** Missing: ${missing.join("; ")}.`, "",
      "No GPT-6 Luna accuracy is claimed. The scripted stand-in is not a substitute.", ""].join("\n");
    write(markdown, { mode, notRun: missing });
    process.exit(2);
  }
  provider = createOpenAIResponsesProvider({ apiKey: key });
  label = `LIVE ${provider.model} (OpenAI Responses API, test key)`;
  maxUsd = budget;
} else {
  provider = new ScriptedThaiModel();
  label = "scripted keyword stand-in — HARNESS CHECK ONLY, not a GPT-6 Luna accuracy measurement";
}

const { results, summary } = await runAnswerEval({
  provider,
  cases,
  maxUsd,
  onResult: (result) => process.stderr.write(`${result.pass ? "PASS" : "FAIL"} ${result.id} ${result.latencyMs}ms\n`),
});

function sectionB(summaryB: EvalSummary, rows: CaseResult[]): string[] {
  const categories = Object.entries(summaryB.byCategory)
    .map(([category, counts]) => `| ${category} | ${counts.passed} | ${counts.total - counts.passed} | ${counts.total} |`);
  const errors = Object.entries(summaryB.errorCategories)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([category, count]) => `| ${category} | ${count} |`);
  const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " / ").slice(0, 140);
  return [
    `## B. Answer-level evaluation — ${label}`,
    "",
    `- Questions: ${summaryB.total} · run ${summaryB.run} · **passed ${summaryB.passed}** · failed ${summaryB.failed} · not run ${summaryB.notRun}`,
    `- Pass rate (run): ${pct(summaryB.passed, summaryB.run)}`,
    `- Tool choice (diagnostic, not graded): ${pct(summaryB.toolMatch.matched, summaryB.toolMatch.expected)}`,
    `- Latency of the final answer: p50 ${summaryB.latencyMs.p50} ms · p95 ${summaryB.latencyMs.p95} ms · max ${summaryB.latencyMs.max} ms`,
    `- Tokens (all turns): ${summaryB.tokens.modelCalls} model calls · input ${summaryB.tokens.inputTokens} (cached ${summaryB.tokens.cachedInputTokens}) · output ${summaryB.tokens.outputTokens}${summaryB.tokens.usageComplete ? "" : " · usage incomplete"}`,
    `- Estimated cost: ${summaryB.costUsd === null ? "unknown (prices not configured or usage incomplete)" : `${summaryB.costUsd} USD`}`,
    "",
    "| category | passed | failed | total |",
    "|---|---|---|---|",
    ...categories,
    "",
    "| error category | cases |",
    "|---|---|",
    ...(errors.length ? errors : ["| (none) | 0 |"]),
    "",
    "| id | chat | result | errors | tools | ms | answer |",
    "|---|---|---|---|---|---|---|",
    ...rows.map((row) => `| ${row.id} | ${row.chat} | ${row.pass ? "PASS" : "FAIL"} | ${cell(row.errors.map((error) => `${error.category}: ${error.detail}`).join("; "))} | ${row.toolsUsed.join(",") || "-"} | ${row.latencyMs} | ${cell(row.answer ?? "")} |`),
    "",
  ];
}

const footer = mode === "live" ? [] : [
  "> The stand-in is a keyword router (no stock routing, limited staff-name extraction). Its failures show the",
  "> grader catches missing facts and wrong claims; its pass rate says nothing about GPT-6 Luna.",
  "",
  "## C. Live GPT-6 Luna",
  "",
  process.env.BOT_SUMMARY_EVAL_OPENAI_API_KEY?.trim()
    ? "Not part of this run. Re-run with `--model live --max-usd <budget>` and the price variables."
    : "**NOT RUN** — no explicit test key (BOT_SUMMARY_EVAL_OPENAI_API_KEY) or authorized budget in this environment. No live-model accuracy is claimed.",
  "",
];
write([...header, ...sectionB(summary, results), ...footer].join("\n"), { mode, label, summary, results });
