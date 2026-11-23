/**
 * Model provider seam for the @Botsummary tool loop.
 *
 * The loop speaks a small provider-neutral transcript (messages, tool calls,
 * tool results). A provider maps it to its own API. GPT-6 Luna through the
 * OpenAI Responses API is the only implementation today; another model is
 * one more `AssistantModelProvider`, selected by BOT_SUMMARY_ASSISTANT_PROVIDER.
 */
import {
  createOpenAIResponse,
  DEFAULT_ANALYST_MODEL,
  extractOpenAIFunctionCalls,
  extractOpenAIOutputText,
  type AnalystTokenUsage,
  type OpenAIAnalystOptions,
} from "./openai-analyst";

export type ModelTranscriptItem =
  | { kind: "message"; role: "user" | "assistant"; text: string }
  | { kind: "tool_call"; callId: string; name: string; arguments: string }
  | { kind: "tool_result"; callId: string; output: string };

export interface ModelToolSpec {
  name: string;
  description: string;
  /** JSON Schema; every property listed in `required` (strict mode). */
  parameters: Record<string, unknown>;
}

export interface ModelRoundRequest {
  instructions: string;
  transcript: readonly ModelTranscriptItem[];
  tools: readonly ModelToolSpec[];
  maxOutputTokens: number;
}

export interface ModelRoundOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Billing evidence for this round, reported even when the round then fails
   * (incomplete/failed status). null usage means the provider did not report it.
   */
  onUsage?: (usage: AnalystTokenUsage | null, model: string | null) => void;
}

export interface ModelToolCall {
  callId: string;
  name: string;
  arguments: string;
}

export interface ModelRoundResult {
  text: string;
  toolCalls: ModelToolCall[];
  model: string | null;
}

export interface AssistantModelProvider {
  readonly name: string;
  readonly model: string;
  respond(request: ModelRoundRequest, options: ModelRoundOptions): Promise<ModelRoundResult>;
}

function toResponsesInput(transcript: readonly ModelTranscriptItem[]): unknown[] {
  return transcript.map((item) => {
    switch (item.kind) {
      case "message":
        return {
          role: item.role,
          content: [{ type: item.role === "user" ? "input_text" : "output_text", text: item.text }],
        };
      case "tool_call":
        return { type: "function_call", call_id: item.callId, name: item.name, arguments: item.arguments };
      case "tool_result":
        return { type: "function_call_output", call_id: item.callId, output: item.output };
    }
  });
}

export function createOpenAIResponsesProvider(
  base: Omit<OpenAIAnalystOptions, "timeoutMs" | "onResponsePayload" | "signal"> = {},
): AssistantModelProvider {
  const model = base.model ?? process.env.BOT_SUMMARY_ANALYST_MODEL ?? DEFAULT_ANALYST_MODEL;
  return {
    name: "openai-responses",
    model,
    async respond(request, options) {
      const payload = await createOpenAIResponse(
        {
          instructions: request.instructions,
          input: toResponsesInput(request.transcript),
          tools: request.tools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            strict: true,
          })),
          tool_choice: "auto",
          parallel_tool_calls: true,
          maxOutputTokens: request.maxOutputTokens,
        },
        {
          ...base,
          model,
          timeoutMs: options.timeoutMs,
          signal: options.signal,
          onResponsePayload: (payload) => {
            const usage = payload.usage;
            options.onUsage?.(
              typeof usage?.input_tokens === "number" && typeof usage.output_tokens === "number"
                ? {
                  inputTokens: usage.input_tokens,
                  cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
                  outputTokens: usage.output_tokens,
                }
                : null,
              payload.model ?? null,
            );
          },
        },
      );
      return {
        text: extractOpenAIOutputText(payload),
        toolCalls: extractOpenAIFunctionCalls(payload).map((call) => ({
          callId: call.call_id,
          name: call.name,
          arguments: call.arguments,
        })),
        model: payload.model ?? null,
      };
    },
  };
}

/** The configured provider. Unknown names fail closed rather than silently switching models. */
export function createAssistantModelProvider(
  base: Omit<OpenAIAnalystOptions, "timeoutMs" | "onResponsePayload" | "signal"> = {},
  name = process.env.BOT_SUMMARY_ASSISTANT_PROVIDER?.trim() || "openai-responses",
): AssistantModelProvider {
  if (name === "openai-responses" || name === "openai") return createOpenAIResponsesProvider(base);
  throw new Error(`Unsupported BOT_SUMMARY_ASSISTANT_PROVIDER: ${name}`);
}
