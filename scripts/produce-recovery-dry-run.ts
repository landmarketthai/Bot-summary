/**
 * READ-ONLY dry run: which failed_closed Produce generations would today's
 * non-blocking rules recover?
 *
 *   bun scripts/produce-recovery-dry-run.ts [--since 2026-09-25] [--out output/recovery]
 *
 * Uses NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from the
 * environment (.env.local). Issues SELECTs only — see
 * src/lib/produce/failed-session-recovery.ts. Writes a JSON and a Markdown
 * report; it never changes the database.
 */
import { createClient } from "@supabase/supabase-js";
import {
  planFailedSessionRecovery,
  POLICY_REFUSAL_REASONS,
  type RecoveryCandidate,
} from "@/lib/produce/failed-session-recovery";

const arg = (name: string, fallback: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
};
const since = arg("since", "2026-09-25");
const outDir = arg("out", "output/recovery");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");

const supabase = createClient(url, key, { auth: { persistSession: false } });
const { candidates, excluded } = await planFailedSessionRecovery(supabase, { since, reasons: POLICY_REFUSAL_REASONS });

const count = (verdict: RecoveryCandidate["verdict"]) => candidates.filter((c) => c.verdict === verdict).length;
const focus = (c: RecoveryCandidate) => c.businessDate === "2026-10-05" || c.businessDate === "2026-10-06";
const tally = (kinds: string[]) => Object.entries(kinds.reduce<Record<string, number>>((acc, kind) => {
  acc[kind] = (acc[kind] ?? 0) + 1;
  return acc;
}, {})).map(([kind, n]) => `${kind}×${n}`).join(", ");
const row = (c: RecoveryCandidate) => [
  c.businessDate ?? "?", c.staffName, c.marketLabel ?? "?", c.transactionTypes.join("+"), c.sections.join("+"),
  c.itemCount, c.totalBaht.toFixed(2), c.failureReason ?? "?", c.verdict, c.reasons.join("; ") || "—",
  tally(c.reconciliation) || "—", c.otherProducts.join(", ") || "—", c.humanCheck ?? "—",
  `${c.sessionKey} / ${c.sessionGeneration}`,
].join(" | ");
const header = [
  "date | staff | market | types | sections | items | total ฿ | failed as | verdict | blocking reasons | reconciliation (audit only) | would be 'other' in brief | human check | session key / generation",
  "---|---|---|---|---|---|---|---|---|---|---|---|---|---",
];

const lines = [
  `# Produce recovery dry run — failed_closed since ${since}`,
  "",
  `Generated ${new Date().toISOString()}. READ-ONLY: nothing was written.`,
  "",
  `- failed generations examined: ${candidates.length}`,
  `- would_recover: ${count("would_recover")}`,
  `- already_persisted: ${count("already_persisted")}`,
  `- still_blocked: ${count("still_blocked")}`,
  `- empty: ${count("empty")}`,
  "",
  `- needing a human check before apply: ${candidates.filter((c) => c.humanCheck).length}`,
  `- excluded (not a policy refusal, e.g. inactivity expiry): ${excluded.length}`,
  "",
  "## 5–6 Oct 2026",
  "",
  ...header,
  ...candidates.filter(focus).map(row),
  "",
  "## All policy-refused generations",
  "",
  ...header,
  ...candidates.map(row),
  "",
  "## Excluded",
  "",
  ...excluded.map((e) => `- ${e.createdAt} ${e.failureReason ?? "?"} — ${e.sessionKey} / ${e.sessionGeneration}`),
  "",
];

await Bun.write(`${outDir}/produce-recovery-dry-run.json`, JSON.stringify({ since, candidates, excluded }, null, 2));
await Bun.write(`${outDir}/produce-recovery-dry-run.md`, lines.join("\n"));
console.log(lines.slice(0, 13).join("\n"));
