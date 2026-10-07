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
  output?: OpenAIResponseOutputItem[];
  error?: {
    message?: string;
    code?: string;
  } | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
};

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
const DEFAULT_MODEL = "gpt-6-luna";
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
  if (!value?.trim()) throw new Error("OPENAI_API_KEY is not configured.");
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

  try {
    const response = await (options.fetchImpl ?? fetch)(DEFAULT_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKeyFrom(options)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: options.model ?? process.env.BOT_SUMMARY_ANALYST_MODEL ?? DEFAULT_MODEL,
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
      const detail = await response.text().catch(() => "");
      throw new Error(
        `OpenAI analyst request failed: HTTP ${response.status}${detail ? ` - ${detail.slice(0, 300)}` : ""}`,
      );
    }

    const payload = await response.json() as OpenAIResponsePayload;
    if (payload.error?.message) {
      throw new Error(`OpenAI analyst error: ${payload.error.message}`);
    }
    if (payload.status && payload.status !== "completed") {
      throw new Error(`OpenAI analyst response status: ${payload.status}`);
    }
    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("OpenAI analyst request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
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
  if (!answer) throw new Error("OpenAI analyst returned an empty answer.");
  return answer;
}
