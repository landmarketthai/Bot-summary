/**
 * Short follow-up context ("แล้วต้องทำยังไง", "ข้อไหนผิด").
 *
 * Only the SAME LINE user's earlier @Botsummary questions in the SAME chat,
 * from the last few minutes, are reused — read back from raw_messages, which
 * already stores every event. Earlier ANSWERS are never stored or replayed, so
 * remembered context can never override fresh database status: every status
 * answer is re-read from the tools.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { LineTextMessage } from "@/lib/line/types";
import { extractBotSummaryQuestion } from "@/lib/ai/line-command";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

export const FOLLOW_UP_WINDOW_MS = 10 * 60_000;
const MAX_PREVIOUS_QUESTIONS = 2;
const MAX_QUESTION_CHARS = 200;

export async function loadRecentBotSummaryQuestions(
  supabase: AnyClient,
  params: {
    sourceId: string;
    lineUserId: string;
    destination: string;
    excludeRawMessageId?: string;
    now?: number;
  },
): Promise<string[]> {
  const since = new Date((params.now ?? Date.now()) - FOLLOW_UP_WINDOW_MS).toISOString();
  try {
    const { data, error } = await supabase
      .from("raw_messages")
      .select("id, payload, created_at")
      .eq("source_id", params.sourceId)
      .eq("user_id", params.lineUserId)
      .eq("message_type", "text")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(6);
    if (error || !data) return [];

    const questions: string[] = [];
    for (const row of data as Array<{ id: string; payload: unknown }>) {
      if (row.id === params.excludeRawMessageId) continue;
      const message = (row.payload as { message?: LineTextMessage } | null)?.message;
      if (!message || message.type !== "text" || typeof message.text !== "string") continue;
      const question = extractBotSummaryQuestion(message, params.destination);
      if (question) questions.push(question.slice(0, MAX_QUESTION_CHARS));
      if (questions.length >= MAX_PREVIOUS_QUESTIONS) break;
    }
    return questions.reverse();
  } catch {
    // Context is optional; a missing history only loses the follow-up hint.
    return [];
  }
}
