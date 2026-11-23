import { describe, expect, test } from "bun:test";
import type { ReadonlyAnalystToolRequest } from "@/lib/ai/readonly-tools";
import { authorizeToolRequest, type AssistantScope } from "./authorization";
import { isFollowUpQuestion, resolveJobBusinessDate } from "./core";
import { THAI_EVAL_ASKED_DATE, THAI_EVAL_SET } from "./testing/thai-eval-set";

// Regression guard for section A of scripts/ai-assistant-eval.ts.
const GROUP_MEMBER: AssistantScope = { lineUserId: "Umember", markets: null };

describe("Thai evaluation set: deterministic backend rules", () => {
  for (const item of THAI_EVAL_SET) {
    test(`${item.id}: ${item.question}`, () => {
      const turns = item.previous
        ? [{ question: item.previous, answer: "-", businessDate: resolveJobBusinessDate(item.previous, THAI_EVAL_ASKED_DATE, []), context: {}, eventTimestampMs: 1 }]
        : [];
      expect(resolveJobBusinessDate(item.question, THAI_EVAL_ASKED_DATE, turns)).toBe(item.expectedBusinessDate);
      expect(isFollowUpQuestion(item.question)).toBe(item.expectedFollowUp);
      if (!item.expectedTool) return;
      const request = {
        tool: item.expectedTool, businessDate: item.expectedBusinessDate, staff: null, market: null, days: 2, ...item.expectedArgs,
      } as unknown as ReadonlyAnalystToolRequest;
      expect(authorizeToolRequest(GROUP_MEMBER, request).ok).toBe(true);
    });
  }
});
