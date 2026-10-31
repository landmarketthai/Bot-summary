import { describe, expect, test } from "bun:test";
import type { ReadonlyAnalystToolRequest } from "@/lib/ai/readonly-tools";
import { authorizeToolRequest, type AssistantScope } from "./authorization";
import { isFollowUpQuestion, resolveJobBusinessDate } from "./core";
import { FIXTURE_MARKETS } from "./testing/fixture-data";
import { THAI_EVAL_ASKED_DATE, THAI_EVAL_SET } from "./testing/thai-eval-set";

// Regression guard for section A of scripts/ai-assistant-eval.ts.
const STAFF_DAM: AssistantScope = {
  lineUserId: "Udam", role: "staff", staffLabel: "ดำ", markets: new Set([FIXTURE_MARKETS.RATCHAPHRUEK]), grantSource: "grant",
};

describe("Thai evaluation set: deterministic backend rules", () => {
  for (const item of THAI_EVAL_SET) {
    test(`${item.id}: ${item.question}`, () => {
      const turns = item.previous
        ? [{ question: item.previous, answer: "-", businessDate: resolveJobBusinessDate(item.previous, THAI_EVAL_ASKED_DATE, []), context: {}, eventTimestampMs: 1 }]
        : [];
      expect(resolveJobBusinessDate(item.question, THAI_EVAL_ASKED_DATE, turns)).toBe(item.expectedBusinessDate);
      expect(isFollowUpQuestion(item.question)).toBe(item.expectedFollowUp);
      if (!item.expectedTool) {
        expect(item.staffDecision).toBe("no_tool");
        return;
      }
      const request = {
        tool: item.expectedTool, businessDate: item.expectedBusinessDate, staff: null, market: null, days: 2, ...item.expectedArgs,
      } as unknown as ReadonlyAnalystToolRequest;
      const decision = authorizeToolRequest(STAFF_DAM, request);
      expect(decision.ok ? "allowed" : decision.reason).toBe(item.staffDecision);
    });
  }
});
