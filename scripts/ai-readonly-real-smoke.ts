import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/types/database";
import { answerWithReadonlyTools } from "../src/lib/ai/readonly-analyst";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error("Missing Supabase environment variables.");
}
if (!process.env.OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY.");
}

const supabase = createClient<Database>(url, key, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

const businessDate = process.argv[2] ?? "2026-10-05";
const question = process.argv.slice(3).join(" ").trim()
  || "วันที่ 5 ตุลาคม สรุปยอดขายให้หน่อย";

const startedAt = performance.now();
const result = await answerWithReadonlyTools(
  supabase,
  question,
  {},
  businessDate,
);
const elapsedMs = Math.round(performance.now() - startedAt);

console.log("\n=== BOT SUMMARY GPT-6 LUNA + REAL READ-ONLY DATA ===");
console.log(`Business date: ${result.businessDate}`);
console.log(`Tools: ${result.toolExecutions.map((item) => item.tool).join(", ") || "(none)"}`);
console.log(`Latency: ${elapsedMs} ms`);
console.log("\nAnswer:");
console.log(result.answer);
console.log("\nTool executions:");
console.log(JSON.stringify(result.toolExecutions, null, 2));
console.log("\nREAL_DATA_POC_DONE: GPT-6 Luna + SELECT/read-only tools only.");
