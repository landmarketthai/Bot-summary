import { computeDailyFinancialSettlement } from "../src/lib/settlement/daily-financial-settlement";
import { answerSettlementQuestion } from "../src/lib/ai/settlement-analyst";

const settlement = computeDailyFinancialSettlement(
  {
    businessDate: "2026-09-29",
    marketLabelNormalized: "พาซิโอ้ผัก",
  },
  {
    whiteSheetSales: 22527,
    transferTotal: 0,
    ownerCash: 0,
    expensesTotal: 0,
    wagesTotal: 0,
    actualCash: 22665,
  },
);

const question = process.argv.slice(2).join(" ").trim()
  || "@Bot-summary วันนี้พี่ดำพาซิโอ้ผักเป็นยังไง?";

const startedAt = performance.now();
const answer = await answerSettlementQuestion(question, settlement);
const elapsedMs = Math.round(performance.now() - startedAt);

console.log("\n=== Bot Summary Analyst + Existing Calculation Engine ===");
console.log(`Question: ${question}`);
console.log(`Status: ${settlement.status}`);
console.log(`Expected cash: ${settlement.expectedCash}`);
console.log(`Actual cash: ${settlement.actualCash}`);
console.log(`Difference: ${settlement.difference}`);
console.log(`Latency: ${elapsedMs} ms\n`);
console.log(answer);

if (settlement.difference !== 138) {
  console.error("\nENGINE_FAIL: calculation engine did not produce 138 baht.");
  process.exit(2);
}
if (!answer.includes("138") || !answer.includes("เกิน")) {
  console.error("\nANALYST_FAIL: GPT-6 Luna did not explain the positive 138-baht difference correctly.");
  process.exit(3);
}

console.log("\nPOC_PASS: Calculation Engine -> GPT-6 Luna Analyst works without a production write.");
