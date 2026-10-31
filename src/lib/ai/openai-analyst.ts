export type AnalystSnapshot = {
  asOf: string;
  scope: string;
  facts: Record<string, unknown>;
  notes?: readonly string[];
};

export type OpenAIAnalystOptions = {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxOutputTokens?: number;
  /** Receive API usage even when the response status is incomplete or failed. */
  onResponsePayload?: (payload: OpenAIResponsePayload) => void;
  /** Caller cancellation (job deadline); aborts the HTTP request. */
  signal?: AbortSignal;
};

export type OpenAIResponseFunctionCall = {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
  status?: string;
};

export type OpenAIResponseOutputItem =
  | OpenAIResponseFunctionCall
  | {
      type: "message";
      role?: string;
      status?: string;
      content?: Array<{
        type?: string;
        text?: string;
      }>;
    }
  | Record<string, unknown>;

export type OpenAIResponsePayload = {
  id?: string;
  status?: string;
  model?: string;
  output?: OpenAIResponseOutputItem[];
  error?: {
    message?: string;
    code?: string;
  } | null;
  usage?: {
    /** Includes the cached tokens reported in input_tokens_details. */
    input_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens?: number;
    total_tokens?: number;
  };
};

/**
 * Typed so callers can classify a failure without reading free text. The
 * message never includes the HTTP response body or the provider's error
 * message: both can echo the prompt (staff names, financial figures).
 */
export class OpenAIAnalystError extends Error {
  constructor(
    message: string,
    readonly kind: "http" | "timeout" | "network" | "status" | "provider" | "config" | "empty" | "limit",
    readonly httpStatus: number | null = null,
    readonly providerCode: string | null = null,
  ) {
    super(message);
    this.name = "OpenAIAnalystError";
  }
}

export type AnalystTokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

function usdPerMillionTokens(env: Record<string, string | undefined>, name: string): number | null {
  const raw = env[name]?.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Estimated API cost in USD from env prices (USD per 1M tokens) for the
 * configured model. Unknown, never zero: a missing input or output price
 * returns null.
 */
export function estimateAnalystCostUsd(
  usage: AnalystTokenUsage,
  env: Record<string, string | undefined> = process.env,
): number | null {
  const input = usdPerMillionTokens(env, "BOT_SUMMARY_ANALYST_INPUT_USD_PER_MTOK");
  const output = usdPerMillionTokens(env, "BOT_SUMMARY_ANALYST_OUTPUT_USD_PER_MTOK");
  if (input === null || output === null) return null;
  // ponytail: without a cached price, cached tokens are billed at the full input price, so the estimate errs high.
  const cached = usdPerMillionTokens(env, "BOT_SUMMARY_ANALYST_CACHED_INPUT_USD_PER_MTOK") ?? input;
  const cachedTokens = Math.min(usage.cachedInputTokens, usage.inputTokens);
  return (
    (usage.inputTokens - cachedTokens) * input
    + cachedTokens * cached
    + usage.outputTokens * output
  ) / 1_000_000;
}

export type OpenAIResponseRequest = {
  instructions: string;
  input: unknown;
  tools?: unknown[];
  tool_choice?: "auto" | "none";
  parallel_tool_calls?: boolean;
  maxOutputTokens?: number;
  textFormat?: { type: "json_schema"; name: string; strict: true; schema: unknown };
};

const DEFAULT_ENDPOINT = "https://api.openai.com/v1/responses";
export const DEFAULT_ANALYST_MODEL = "gpt-6-luna";
const DEFAULT_TIMEOUT_MS = 20_000;

export const BOT_SUMMARY_ANALYST_INSTRUCTIONS = [
  "คุณคือ Bot Summary Analyst สำหรับข้อมูลร้านค้า ตอบภาษาไทยสั้น กระชับ อ่านง่าย",
  "ใช้เฉพาะข้อมูลจาก read-only tools ที่ระบบส่งให้ ห้ามเดาข้อมูลที่ไม่มี",
  "ห้ามอ้างว่าแก้ ลบ เพิ่ม หรือบันทึกข้อมูล และห้ามเสนอว่าคุณมีสิทธิ์เขียนฐานข้อมูล",
  "ตัวเลขการเงินและสถานะจาก tool เป็นค่าทางการจาก Bot Summary backend ห้ามคำนวณสูตรธุรกิจใหม่เพื่อแทนค่าที่ tool ให้มา",
  "ยอดขายจาก produce analysis ไม่ใช่ settlement เงินสด",
  "priceAdjustmentBaht คือส่วนปรับมูลค่าจากราคา ไม่ใช่เงินสดเกินหรือขาด",
  "ถ้า cashDifferenceBaht หรือ difference เป็นบวก ให้เรียกว่าเงินเกิน; เป็นลบให้เรียกว่าเงินขาด; ศูนย์ให้เรียกว่าเงินปิดตรง",
  "ถ้าสถานะ INCOMPLETE ให้บอกว่ายังสรุปเงินขาด/เกินไม่ได้และระบุข้อมูลที่ขาด",
  "ถ้าข้อมูลไม่พอ ให้บอกว่าขาดข้อมูลอะไร แทนการเดา",
  "อย่าเรียกค่าหนึ่งว่าผิดปกติ สูง ต่ำ ดี หรือแย่ หาก tool ไม่ได้ให้เกณฑ์เปรียบเทียบ",
  "ตอบไม่เกิน 5 ประโยค เว้นแต่ผู้ใช้ขอรายละเอียด",
  "ใช้ภาษากลางแบบ Bot Summary; ถ้าต้องมีคำลงท้ายให้ใช้ 'ครับ' และไม่ใช้ 'ค่ะ'",
].join("\n");

function apiKeyFrom(options: OpenAIAnalystOptions): string {
  const value = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!value?.trim()) throw new OpenAIAnalystError("OPENAI_API_KEY is not configured.", "config");
  return value.trim();
}

export function extractOpenAIOutputText(payload: OpenAIResponsePayload): string {
  const parts: string[] = [];
  for (const item of payload.output ?? []) {
    if (item.type !== "message") continue;
    const message = item as Extract<OpenAIResponseOutputItem, { type: "message" }>;
    for (const content of message.content ?? []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  return parts.join("\n").trim();
}

export function extractOpenAIFunctionCalls(
  payload: OpenAIResponsePayload,
): OpenAIResponseFunctionCall[] {
  return (payload.output ?? []).filter(
    (item): item is OpenAIResponseFunctionCall =>
      item.type === "function_call"
      && typeof (item as OpenAIResponseFunctionCall).call_id === "string"
      && typeof (item as OpenAIResponseFunctionCall).name === "string"
      && typeof (item as OpenAIResponseFunctionCall).arguments === "string",
  );
}

export async function createOpenAIResponse(
  request: OpenAIResponseRequest,
  options: OpenAIAnalystOptions = {},
): Promise<OpenAIResponsePayload> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const abortFromCaller = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });

  try {
    const response = await (options.fetchImpl ?? fetch)(DEFAULT_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKeyFrom(options)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: options.model ?? process.env.BOT_SUMMARY_ANALYST_MODEL ?? DEFAULT_ANALYST_MODEL,
        store: false,
        reasoning: { effort: "none" },
        max_output_tokens: request.maxOutputTokens ?? options.maxOutputTokens ?? 320,
        instructions: request.instructions,
        input: request.input,
        ...(request.textFormat ? { text: { format: request.textFormat } } : {}),
        ...(request.tools ? { tools: request.tools } : {}),
        ...(request.tool_choice ? { tool_choice: request.tool_choice } : {}),
        ...(request.parallel_tool_calls !== undefined
          ? { parallel_tool_calls: request.parallel_tool_calls }
          : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Drained, never surfaced: the body can echo the request.
      await response.text().catch(() => "");
      throw new OpenAIAnalystError(
        `OpenAI analyst request failed: HTTP ${response.status}`,
        "http",
        response.status,
      );
    }

    const payload = await response.json() as OpenAIResponsePayload;
    options.onResponsePayload?.(payload);
    if (payload.error?.message || payload.error?.code) {
      const code = payload.error.code ?? null;
      throw new OpenAIAnalystError(`OpenAI analyst error${code ? ` (${code})` : ""}`, "provider", null, code);
    }
    if (payload.status && payload.status !== "completed") {
      throw new OpenAIAnalystError(
        `OpenAI analyst response status: ${payload.status}`,
        "status",
        null,
        payload.status,
      );
    }
    return payload;
  } catch (error) {
    if (error instanceof OpenAIAnalystError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new OpenAIAnalystError("OpenAI analyst request timed out.", "timeout");
    }
    if (error instanceof SyntaxError) {
      throw new OpenAIAnalystError("OpenAI analyst returned invalid JSON.", "provider", null, "invalid_json");
    }
    throw new OpenAIAnalystError("OpenAI analyst network error.", "network");
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

export async function answerBotSummaryQuestion(
  question: string,
  snapshot: AnalystSnapshot,
  options: OpenAIAnalystOptions = {},
): Promise<string> {
  const trimmedQuestion = question.trim();
  if (!trimmedQuestion) throw new Error("Analyst question must not be empty.");

  const payload = await createOpenAIResponse(
    {
      instructions: BOT_SUMMARY_ANALYST_INSTRUCTIONS,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                `คำถาม: ${trimmedQuestion}`,
                "",
                "SNAPSHOT (ข้อมูลอ่านอย่างเดียว):",
                JSON.stringify(snapshot, null, 2),
              ].join("\n"),
            },
          ],
        },
      ],
      maxOutputTokens: 320,
    },
    options,
  );

  const answer = extractOpenAIOutputText(payload);
  if (!answer) throw new OpenAIAnalystError("OpenAI analyst returned an empty answer.", "empty");
  return answer;
}
