/**
 * End-to-end Preview demonstration of the @Botsummary AI Assistant with the
 * outside world isolated:
 *   LINE      simulated users and events; answers go to a RECORDING adapter
 *             (nothing is sent to LINE)
 *   model     scripted Thai stand-in (no OpenAI call, no cost)
 *   data      invented fixture figures behind the REAL authorization layer
 *   queue     the REAL SQL job queue on a disposable local PostgreSQL when
 *             ALLOW_DISPOSABLE_POSTGRES_TESTS=1 (else the in-memory double)
 * The webhook, dispatcher, worker, delivery state machine, conversation
 * memory, grounding check and authorization are production code.
 *
 *   ALLOW_DISPOSABLE_POSTGRES_TESTS=1 PGPASSWORD=postgres bun scripts/ai-assistant-preview-demo.ts \
 *     --out docs/ai-assistant/preview-demo-transcript.md
 */
import { writeFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../src/types/database";
import { bangkokBusinessDateFromTimestamp } from "../src/lib/business-date";
import { BOT_SUMMARY_TEMPORARY_ERROR_REPLY } from "../src/lib/ai/line-command";
import { OpenAIAnalystError } from "../src/lib/ai/openai-analyst";
import type { LineMessageEvent } from "../src/lib/line/types";
import { WebhookService } from "../src/lib/line/webhook-service";
import { FakeDatabase } from "../src/lib/summary/test-fake-supabase";
import type { AssistantScope, ScopeResolution } from "../src/lib/ai/assistant/authorization";
import { answerAssistantJob, revalidateAssistantJob, type AssistantCoreDeps } from "../src/lib/ai/assistant/core";
import { createAssistantDispatcher } from "../src/lib/ai/assistant/dispatch";
import { SupabaseAssistantJobStore, type AssistantJob, type AssistantJobStore } from "../src/lib/ai/assistant/job-store";
import { createFixtureDataReader, FIXTURE_MARKETS } from "../src/lib/ai/assistant/testing/fixture-data";
import { MemoryAssistantJobStore } from "../src/lib/ai/assistant/testing/memory-job-store";
import { assistantRpcClient, createAssistantTestDb } from "../src/lib/ai/assistant/testing/pg-assistant-db";
import { RecordingLineDelivery } from "../src/lib/ai/assistant/testing/recording-line";
import { ScriptedThaiModel } from "../src/lib/ai/assistant/testing/scripted-provider";
import { runAssistantWorker } from "../src/lib/ai/assistant/worker";

const USERS: Record<string, { name: string; scope: AssistantScope }> = {
  Uboss: { name: "หัวหน้า (supervisor, ทุกตลาด)", scope: { lineUserId: "Uboss", role: "supervisor", staffLabel: null, markets: null, grantSource: "env_supervisor" } },
  Udam: { name: "ดำ (staff, ราชพฤกษ์)", scope: { lineUserId: "Udam", role: "staff", staffLabel: "ดำ", markets: new Set([FIXTURE_MARKETS.RATCHAPHRUEK]), grantSource: "grant" } },
};

const db = await createAssistantTestDb();
const store: AssistantJobStore = db ? new SupabaseAssistantJobStore(assistantRpcClient(db)) : new MemoryAssistantJobStore();
const queueKind = db ? `real SQL queue on disposable PostgreSQL (${db.name})` : "in-memory queue double";
const line = new RecordingLineDelivery();
const model = new ScriptedThaiModel();
const today = bangkokBusinessDateFromTimestamp(Date.now())!;
const out: string[] = [];
const log = (text = "") => { out.push(text); console.log(text); };

const service = new WebhookService(new FakeDatabase() as unknown as SupabaseClient<Database>, {
  botSummaryAnalystEnabled: true,
  botSummaryAnalystSourceAllowed: (sourceId) => ["Cmanagement", "Cworkers", "Udam", "Uboss", "Ustranger"].includes(sourceId),
  botSummaryAssistantDispatcher: createAssistantDispatcher(store),
  botSummaryAssistantKick: async () => {},
  scheduleBackgroundTask: () => {},
  replyMessage: async (_token, text) => { log(`  ↳ webhook immediate reply: ${text}`); },
});

let seq = 0;
async function say(
  userId: string,
  text: string,
  options: { eventId?: string; redelivery?: boolean; ageMs?: number; chat?: "Cmanagement" | "Cworkers" | "dm" } = {},
) {
  seq += 1;
  const id = options.eventId ?? `demo-${seq}`;
  const event: LineMessageEvent = {
    type: "message", webhookEventId: id, deliveryContext: { isRedelivery: options.redelivery ?? false },
    timestamp: Date.now() - (options.ageMs ?? 0),
    source: options.chat === "dm" ? { type: "user", userId } : { type: "group", groupId: options.chat ?? "Cmanagement", userId },
    mode: "active", replyToken: `reply-token-${id}`,
    message: { id: `m-${id}`, type: "text", quoteToken: "q", text: `@Botsummary ${text}` },
  };
  const started = Date.now();
  const [result] = await service.processEvents([event], "Ubot");
  log(`**${USERS[userId]?.name ?? userId}** [${options.chat === "dm" ? "1:1 chat" : options.chat ?? "Cmanagement"}]: @Botsummary ${text}`);
  log(`  ↳ webhook ${result?.status} in ${Date.now() - started} ms${options.redelivery ? " (LINE redelivery of the same webhookEventId)" : ""}`);
}

let privateDeliveryEnabled = false;
const deps = (): AssistantCoreDeps => ({
  supabase: {} as SupabaseClient<Database>,
  store,
  provider: model,
  resolveScope: async (id): Promise<ScopeResolution> => USERS[id] ? { ok: true, scope: USERS[id]!.scope } : { ok: false, reason: "no_grant" },
  // Cmanagement: supervisors' group with an explicit full group policy. Cworkers: no policy.
  resolveGroupPolicy: async (sourceId) => ({
    ok: true,
    policy: sourceId === "Cmanagement" ? { sourceId, allowFinancial: true, allowPersonSpecific: true, markets: null } : null,
  }),
  privateDeliveryEnabled,
  readData: createFixtureDataReader([], { today }),
});

async function work(label = "worker") {
  const before = line.sent.length;
  const summary = await runAssistantWorker({
    store,
    answer: (job: AssistantJob, context) => answerAssistantJob(job, context, deps()),
    revalidate: (job, scopeKey, deliverTo) => revalidateAssistantJob(job, deps(), scopeKey, deliverTo),
    delivery: line,
    pushFallbackEnabled: true,
    workerId: `demo-${label}`,
    budgetMs: 20_000,
    deliveryReserveMs: 2_000,
    temporaryErrorText: BOT_SUMMARY_TEMPORARY_ERROR_REPLY,
  });
  const counts = Object.entries(summary).filter(([, value]) => value).map(([key, value]) => `${key}=${value}`).join(" ");
  log(`  ↳ ${label}: ${counts || "nothing to do"}`);
  for (const message of line.sent.slice(before)) {
    log(`  ↳ **Bot (${message.channel}${message.channel === "push" ? ` to ${message.target}, retry key ${message.retryKey?.slice(0, 8)}…` : ""}):** ${message.text.replaceAll("\n", " / ")}`);
  }
}

log("# @Botsummary AI Assistant — Preview demonstration transcript");
log();
log(`Generated ${new Date().toISOString()} by \`scripts/ai-assistant-preview-demo.ts\`. Business date ${today}.`);
log();
log(`- Queue: ${queueKind}`);
log("- LINE: simulated events in, recording adapter out (nothing sent to LINE)");
log("- Model: scripted Thai stand-in (not GPT-6 Luna); data: invented fixtures behind the real authorization layer");
log();

log("## 1. Six-question conversation (supervisor)");
log();
for (const question of [
  "วันนี้ทุกตลาดขายได้เท่าไหร่?",
  "พี่ดำเบิกอะไรไป แล้วคืนเท่าไหร่?",
  "หนูเล็กมีสลิปที่ยังรอตรวจกี่รายการ?",
  "เมื่อวานตลาดไหนขายดีกว่าวันนี้?",
  "ทำไมรายการของพี่ปลายังปิดไม่ได้?",
  "แล้วของพี่ขวัญล่ะ?",
]) {
  await say("Uboss", question);
  await work();
  log();
}

log("## 2. Duplicate LINE delivery");
log();
await say("Uboss", "วันนี้มีอะไรยังไม่จบ", { eventId: "demo-dup" });
await say("Uboss", "วันนี้มีอะไรยังไม่จบ", { eventId: "demo-dup", redelivery: true });
await work();
log();

log("## 3. Model outage, retry with backoff");
log();
model.failures = [new OpenAIAnalystError("OpenAI analyst request failed: HTTP 503", "http", 503)];
await say("Uboss", "เทียบยอดขายวันนี้กับเมื่อวาน");
await work("worker attempt 1");
if (db) await db.query("UPDATE public.ai_assistant_jobs SET available_at = now() WHERE status = 'queued'");
else (store as MemoryAssistantJobStore).makeAvailable();
log("  ↳ (backoff elapses)");
await work("worker attempt 2");
log();

log("## 4. Reply token already expired (slow queue) → push with a stable retry key");
log();
await say("Uboss", "ใบขาววันนี้ปิดครบทุกตลาดหรือยัง", { ageMs: 70_000 });
await work();
log();

log("## 5. Permission boundaries (staff ดำ, 1:1 chat)");
log();
await say("Udam", "พี่ดำเบิกอะไรไป", { chat: "dm" });
await work();
await say("Udam", "พี่ขวัญเบิกอะไรไป", { chat: "dm" });
await work();
await say("Udam", "ดำวันนี้เงินขาดหรือเกิน", { chat: "dm" });
await work();
await say("Ustranger", "วันนี้ทุกตลาดขายได้เท่าไหร่?", { chat: "dm" });
await work();
log();

log("## 6. Group disclosure: a group without a group policy");
log();
await say("Uboss", "วันนี้ทุกตลาดขายได้เท่าไหร่?", { chat: "Cworkers" });
await work();
log("  ↳ (private delivery enabled: BOT_SUMMARY_ASSISTANT_PRIVATE_DELIVERY_ENABLED=true)");
privateDeliveryEnabled = true;
await say("Uboss", "วันนี้ทุกตลาดขายได้เท่าไหร่?", { chat: "Cworkers" });
await work();
privateDeliveryEnabled = false;
log();

log(`Total messages a LINE user would see: ${line.sent.length} (attempts incl. de-duplicated: ${line.attempts.length}).`);

const outIndex = process.argv.indexOf("--out");
if (outIndex > 0 && process.argv[outIndex + 1]) writeFileSync(process.argv[outIndex + 1]!, out.join("\n") + "\n");
await db?.drop();
