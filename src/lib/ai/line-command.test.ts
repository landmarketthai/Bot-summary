import { describe, expect, test } from "bun:test";
import type { LineTextMessage } from "@/lib/line/types";
import {
  extractBotSummaryQuestion,
  isBotSummaryAnalystEnabled,
  isBotSummaryAnalystSourceAllowed,
  parseBotSummaryAnalystSourceIds,
} from "./line-command";

function message(
  text: string,
  mention?: LineTextMessage["mention"],
): LineTextMessage {
  return {
    id: "m1",
    type: "text",
    quoteToken: "q1",
    text,
    ...(mention ? { mention } : {}),
  };
}

describe("@Botsummary LINE command extraction", () => {
  test("accepts the literal @Botsummary prefix", () => {
    expect(
      extractBotSummaryQuestion(
        message("@Botsummary วันนี้ยอดขายเท่าไหร่"),
        "Ubot",
      ),
    ).toBe("วันนี้ยอดขายเท่าไหร่");
  });

  test("accepts @Bot-summary and strips punctuation", () => {
    expect(
      extractBotSummaryQuestion(
        message("@Bot-summary: ดำวันนี้เงินขาดหรือเกิน"),
        "Ubot",
      ),
    ).toBe("ดำวันนี้เงินขาดหรือเกิน");
  });

  test("uses LINE mention metadata when the mentionee is the bot destination", () => {
    const text = "@Bot Summary พาซิโอ้วันนี้เป็นไง";
    expect(
      extractBotSummaryQuestion(
        message(text, {
          mentionees: [
            {
              index: 0,
              length: "@Bot Summary".length,
              type: "user",
              userId: "Ubot",
            },
          ],
        }),
        "Ubot",
      ),
    ).toBe("พาซิโอ้วันนี้เป็นไง");
  });

  test("does not treat a mention of another user as a bot command", () => {
    const text = "@Someone ยอดขายวันนี้";
    expect(
      extractBotSummaryQuestion(
        message(text, {
          mentionees: [
            {
              index: 0,
              length: "@Someone".length,
              type: "user",
              userId: "Uother",
            },
          ],
        }),
        "Ubot",
      ),
    ).toBeNull();
  });

  test("returns empty string when addressed without a question", () => {
    expect(extractBotSummaryQuestion(message("@Botsummary"), "Ubot")).toBe("");
  });

  test("feature flag is fail-closed", () => {
    expect(isBotSummaryAnalystEnabled(undefined)).toBe(false);
    expect(isBotSummaryAnalystEnabled("false")).toBe(false);
    expect(isBotSummaryAnalystEnabled("true")).toBe(true);
  });

  test("source allowlist is fail-closed and accepts comma/space separated IDs", () => {
    expect(parseBotSummaryAnalystSourceIds(undefined)).toEqual(new Set());
    expect(isBotSummaryAnalystSourceAllowed("C1", undefined)).toBe(false);
    expect(parseBotSummaryAnalystSourceIds("C1, C2\nU3"))
      .toEqual(new Set(["C1", "C2", "U3"]));
    expect(isBotSummaryAnalystSourceAllowed("C2", "C1 C2")).toBe(true);
    expect(isBotSummaryAnalystSourceAllowed("C9", "C1 C2")).toBe(false);
  });
});
