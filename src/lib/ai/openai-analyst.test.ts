import { describe, expect, test } from "bun:test";
import {
  answerBotSummaryQuestion,
  createOpenAIResponse,
  extractOpenAIFunctionCalls,
  extractOpenAIOutputText,
} from "./openai-analyst";

function completedText(text: string) {
  return {
    id: "resp_test",
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text }],
      },
    ],
  };
}

describe("OpenAI Bot Summary analyst", () => {
  test("uses GPT-6 Luna Responses API with storage disabled and no reasoning", async () => {
    let url = "";
    let body: Record<string, unknown> = {};
    let auth = "";

    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      url = String(input);
      auth = String((init?.headers as Record<string, string>)?.authorization ?? "");
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify(completedText("เงินเกิน 138 บาท")), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const answer = await answerBotSummaryQuestion(
      "ดำวันนี้เงินขาดหรือเกิน",
      {
        asOf: "2026-10-07",
        scope: "settlement",
        facts: {
          expectedCashBaht: 8377,
          actualCashBaht: 8515,
          differenceBaht: 138,
        },
      },
      { apiKey: "test-key", fetchImpl },
    );

    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(auth).toBe("Bearer test-key");
    expect(body.model).toBe("gpt-6-luna");
    expect(body.store).toBe(false);
    expect(body.reasoning).toEqual({ effort: "none" });
    expect(Number(body.max_output_tokens)).toBeLessThanOrEqual(420);
    expect(answer).toBe("เงินเกิน 138 บาท");
  });

  test("extracts text and function calls from Responses output items", () => {
    const payload = {
      status: "completed",
      output: [
        {
          type: "function_call" as const,
          call_id: "call_1",
          name: "get_daily_summary",
          arguments: "{}",
        },
        {
          type: "message" as const,
          content: [{ type: "output_text", text: "สรุปแล้ว" }],
        },
      ],
    };

    expect(extractOpenAIFunctionCalls(payload)).toHaveLength(1);
    expect(extractOpenAIFunctionCalls(payload)[0]?.name).toBe("get_daily_summary");
    expect(extractOpenAIOutputText(payload)).toBe("สรุปแล้ว");
  });

  test("rejects missing API key before sending", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;

    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await expect(
        createOpenAIResponse(
          { instructions: "test", input: "test" },
          { fetchImpl },
        ),
      ).rejects.toThrow("OPENAI_API_KEY");
      expect(called).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  test("surfaces OpenAI HTTP errors", async () => {
    const fetchImpl = (async () =>
      new Response("rate limited", { status: 429 })) as unknown as typeof fetch;

    await expect(
      createOpenAIResponse(
        { instructions: "test", input: "test" },
        { apiKey: "test-key", fetchImpl },
      ),
    ).rejects.toThrow("HTTP 429");
  });
});
