import type { LineTextMessage } from "@/lib/line/types";

const LITERAL_PREFIX = /^\s*@(?:botsummary|bot[-_\s]?summary)\s*[:：,-]?\s*/iu;

export function isBotSummaryAnalystEnabled(
  value = process.env.BOT_SUMMARY_ANALYST_ENABLED,
): boolean {
  return value === "true";
}

export function parseBotSummaryAnalystSourceIds(
  value = process.env.BOT_SUMMARY_ANALYST_LINE_SOURCE_IDS,
): Set<string> {
  return new Set(
    (value ?? "")
      .split(/[,\s]+/u)
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

export function isBotSummaryAnalystSourceAllowed(
  sourceId: string,
  value = process.env.BOT_SUMMARY_ANALYST_LINE_SOURCE_IDS,
): boolean {
  if (!sourceId) return false;
  return parseBotSummaryAnalystSourceIds(value).has(sourceId);
}

function stripMentionRanges(
  text: string,
  ranges: Array<{ index: number; length: number }>,
): string {
  let output = text;
  for (const range of [...ranges].sort((a, b) => b.index - a.index)) {
    if (
      !Number.isInteger(range.index)
      || !Number.isInteger(range.length)
      || range.index < 0
      || range.length <= 0
      || range.index + range.length > output.length
    ) continue;
    output = output.slice(0, range.index) + output.slice(range.index + range.length);
  }
  return output;
}

/**
 * Returns null when the message is not addressed to Bot Summary.
 * Returns an empty string when Bot Summary was addressed with no question.
 *
 * LINE mention indices are UTF-16 string offsets, which matches JavaScript
 * String#slice semantics. The webhook body destination is the bot's user ID,
 * so mention metadata can identify the bot without trusting display-name text.
 */
export function extractBotSummaryQuestion(
  message: LineTextMessage,
  destinationBotUserId: string,
): string | null {
  const botMentions = (message.mention?.mentionees ?? [])
    .filter(
      (mentionee) =>
        mentionee.type === "user"
        && typeof mentionee.userId === "string"
        && mentionee.userId === destinationBotUserId,
    )
    .map((mentionee) => ({
      index: mentionee.index,
      length: mentionee.length,
    }));

  if (botMentions.length > 0) {
    return stripMentionRanges(message.text, botMentions)
      .replace(/^\s*[:：,-]?\s*/u, "")
      .trim();
  }

  if (!LITERAL_PREFIX.test(message.text)) return null;
  return message.text.replace(LITERAL_PREFIX, "").trim();
}

export const BOT_SUMMARY_USAGE_REPLY = [
  "ถาม @Botsummary ได้ เช่น",
  "• @Botsummary วันนี้ยอดขายเท่าไหร่",
  "• @Botsummary พาซิโอ้ผักวันนี้เป็นยังไง",
  "• @Botsummary พาซิโอ้ผักเหลือของเท่าไหร่",
  "• @Botsummary วันนี้มีอะไรยังไม่จบ",
  "• @Botsummary ดำวันนี้เงินขาดหรือเกิน",
  "• @Botsummary วันนี้มีใครเงินขาดบ้าง",
  "• @Botsummary เทียบยอดขายวันนี้กับเมื่อวาน",
].join("\n");

export const BOT_SUMMARY_NOT_AVAILABLE_REPLY =
  "ตอนนี้ @Botsummary ยังไม่เปิดใช้งานในแชทนี้";

export const BOT_SUMMARY_TEMPORARY_ERROR_REPLY =
  "ตอนนี้ @Botsummary อ่านข้อมูลให้ไม่สำเร็จชั่วคราว กรุณาลองถามใหม่อีกครั้ง";
