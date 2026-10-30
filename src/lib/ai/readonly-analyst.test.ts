import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { logger } from "@/lib/logger";
import { FakeDatabase } from "@/lib/summary/test-fake-supabase";
import {
  answerWithReadonlyTools,
  resolveAnalystBusinessDate,
} from "./readonly-analyst";

function client(db: FakeDatabase): SupabaseClient<Database> {
  return db as unknown as SupabaseClient<Database>;
}

function responseWithToolCall(name: string, args: Record<string, unknown>) {
  return {
    id: "resp_tool",
    status: "completed",
    output: [
      {
        type: "function_call",
        call_id: "call_1",
        name,
        arguments: JSON.stringify(args),
        status: "completed",
      },
    ],
  };
}

function responseWithText(text: string) {
  return {
    id: "resp_text",
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

describe("Bot Summary business-date resolution", () => {
  test("uses backend date for today and previous date for เมื่อวาน", () => {
    expect(resolveAnalystBusinessDate("วันนี้ยอดขายเท่าไหร่", "2026-10-07"))
      .toBe("2026-10-07");
    expect(resolveAnalystBusinessDate("เมื่อวานยอดขายเท่าไหร่", "2026-10-07"))
      .toBe("2026-10-06");
  });

  test("accepts Buddhist numeric and Thai-month dates", () => {
    expect(resolveAnalystBusinessDate("สรุป 5/10/69", "2026-10-07"))
      .toBe("2026-10-05");
    expect(resolveAnalystBusinessDate("วันที่ 5 ตุลาคม ยอดขายเท่าไหร่", "2026-10-07"))
      .toBe("2026-10-05");
  });

  test("rejects impossible explicit dates by falling back safely", () => {
    expect(resolveAnalystBusinessDate("สรุป 31/02/69", "2026-10-07"))
      .toBe("2026-10-07");
  });
});

describe("GPT-6 Luna read-only tool orchestration", () => {
  test("executes an allowlisted staff settlement tool then returns the model answer", async () => {
    const db = new FakeDatabase();
    const bodies: Array<Record<string, unknown>> = [];
    let call = 0;

    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      call += 1;
      const payload = call === 1
        ? responseWithToolCall("get_staff_settlement", { staff: "ดำ" })
        : responseWithText("ไม่พบข้อมูลปิดเงินของดำในวันที่ 7 ตุลาคม");
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const result = await answerWithReadonlyTools(
      client(db),
      "ดำวันนี้เงินขาดหรือเกิน",
      { apiKey: "test-key", fetchImpl },
      "2026-10-07",
    );

    expect(result.businessDate).toBe("2026-10-07");
    expect(result.toolExecutions).toEqual([
      { tool: "get_staff_settlement", arguments: { staff: "ดำ" } },
    ]);
    expect(result.answer).toContain("ไม่พบข้อมูล");
    expect(bodies).toHaveLength(2);

    const secondInput = bodies[1]?.input as Array<Record<string, unknown>>;
    const outputItem = secondInput.find((item) => item.type === "function_call_output");
    expect(String(outputItem?.output)).toContain('"businessDate":"2026-10-07"');
    expect(String(outputItem?.output)).toContain('"found":false');
  });

  test("supports market stock questions through the existing read-only stock service", async () => {
    const db = new FakeDatabase();
    let call = 0;

    const fetchImpl = (async () => {
      call += 1;
      const payload = call === 1
        ? responseWithToolCall("get_market_stock", { market: "พาซิโอ้ผัก" })
        : responseWithText("ยังไม่พบข้อมูลของคงเหลือในพาซิโอ้ผักสำหรับวันนี้");
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await answerWithReadonlyTools(
      client(db),
      "พาซิโอ้ผักเหลือของเท่าไหร่",
      { apiKey: "test-key", fetchImpl },
      "2026-10-07",
    );

    expect(result.toolExecutions).toEqual([
      { tool: "get_market_stock", arguments: { market: "พาซิโอ้ผัก" } },
    ]);
    expect(result.answer).toContain("ยังไม่พบข้อมูล");
  });

  test("does not expose arbitrary write tools to GPT", async () => {
    let requestBody: Record<string, unknown> = {};
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify(responseWithText(
        "@Botsummary เป็นโหมดอ่านข้อมูลอย่างเดียว จึงไม่สามารถลบข้อมูลได้",
      )), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const result = await answerWithReadonlyTools(
      client(new FakeDatabase()),
      "ลบยอดพี่ดำเมื่อวาน",
      { apiKey: "test-key", fetchImpl },
      "2026-10-06",
    );

    const tools = requestBody.tools as Array<{ name?: string }>;
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("get_daily_summary");
    expect(names).toContain("get_staff_settlement");
    expect(names.some((name) => /delete|insert|update|upsert|sql/i.test(name ?? ""))).toBe(false);
    expect(result.toolExecutions).toEqual([]);
    expect(result.answer).toContain("อ่านข้อมูลอย่างเดียว");
  });
});

describe("read-only tool implementation boundary", () => {
  test("contains no direct Supabase mutation primitives or raw SQL execution", async () => {
    const source = await Bun.file(new URL("./readonly-tools.ts", import.meta.url)).text();

    for (const forbidden of [
      ".insert(",
      ".update(",
      ".delete(",
      ".upsert(",
      ".rpc(",
      "execute_sql",
    ]) {
      expect(source).not.toContain(forbidden);
    }

    expect(source).toContain("loadSalesReport");
    expect(source).toContain("loadProduceFailureScan");
    expect(source).toContain("getDailyFinancialSettlement");
    expect(source).toContain("loadStockSummary");
  });
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function withUsage<T extends object>(payload: T, input: number, cached: number, output: number) {
  return {
    ...payload,
    model: "gpt-6-luna",
    usage: {
      input_tokens: input,
      input_tokens_details: { cached_tokens: cached },
      output_tokens: output,
      total_tokens: input + output,
    },
  };
}

/** Never answers; rejects like fetch does when the request is aborted. */
const hangingFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    });
  })) as typeof fetch;

describe("tool loop keeps the conversation (store:false)", () => {
  test("every round resends the question and all earlier calls and outputs", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const replies = [
      responseWithToolCall("get_daily_summary", {}),
      responseWithToolCall("get_settlement_overview", {}),
      responseWithText("สรุปแล้ว"),
    ];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse(replies[bodies.length - 1]);
    }) as typeof fetch;

    const result = await answerWithReadonlyTools(
      client(new FakeDatabase()),
      "วันนี้ยอดขายและเงินขาดเป็นยังไง",
      { apiKey: "test-key", fetchImpl },
      "2026-10-07",
    );

    expect(result.answer).toBe("สรุปแล้ว");
    expect(bodies).toHaveLength(3);
    for (const body of bodies) {
      const [first] = body.input as Array<Record<string, unknown>>;
      expect(first).toEqual({
        role: "user",
        content: [{ type: "input_text", text: "วันนี้ยอดขายและเงินขาดเป็นยังไง" }],
      });
    }
    const third = bodies[2]!.input as Array<Record<string, unknown>>;
    expect(third.map((item) => item.type ?? item.role)).toEqual([
      "user",
      "function_call",
      "function_call_output",
      "function_call",
      "function_call_output",
    ]);
    expect(third.filter((item) => item.type === "function_call").map((item) => item.name))
      .toEqual(["get_daily_summary", "get_settlement_overview"]);
  });
});

describe("tool loop total deadline", () => {
  test("a hanging model call stops at the total budget instead of the 20 s per-call default", async () => {
    const startedAt = Date.now();
    await expect(answerWithReadonlyTools(
      client(new FakeDatabase()),
      "วันนี้ยอดขายเท่าไหร่",
      { apiKey: "test-key", fetchImpl: hangingFetch, budgetMs: 1_200 },
      "2026-10-07",
    )).rejects.toThrow("timed out");
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  test("no new model round starts when under 1 s of the budget is left", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 300));
      return jsonResponse(responseWithToolCall("get_daily_summary", {}));
    }) as unknown as typeof fetch;

    await expect(answerWithReadonlyTools(
      client(new FakeDatabase()),
      "วันนี้ยอดขายเท่าไหร่",
      { apiKey: "test-key", fetchImpl, budgetMs: 1_200 },
      "2026-10-07",
    )).rejects.toThrow("timed out");
    expect(calls).toBe(1);
  });

  test("the caller's shorter per-call timeout still applies", async () => {
    const startedAt = Date.now();
    await expect(answerWithReadonlyTools(
      client(new FakeDatabase()),
      "วันนี้ยอดขายเท่าไหร่",
      { apiKey: "test-key", fetchImpl: hangingFetch, timeoutMs: 300, budgetMs: 10_000 },
      "2026-10-07",
    )).rejects.toThrow("timed out");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});

describe("tool loop usage and cost log", () => {
  const PRICE_ENV = [
    "BOT_SUMMARY_ANALYST_INPUT_USD_PER_MTOK",
    "BOT_SUMMARY_ANALYST_CACHED_INPUT_USD_PER_MTOK",
    "BOT_SUMMARY_ANALYST_OUTPUT_USD_PER_MTOK",
  ] as const;
  const savedEnv = Object.fromEntries(PRICE_ENV.map((name) => [name, process.env[name]]));

  afterEach(() => {
    for (const name of PRICE_ENV) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  });

  function usageEntries(spy: { mock: { calls: Array<[string, Record<string, unknown>?]> } }) {
    return spy.mock.calls
      .filter(([message]) => message === "bot summary analyst usage")
      .map(([, context]) => context!);
  }

  test("sums tokens over every round and estimates cost from env prices", async () => {
    process.env.BOT_SUMMARY_ANALYST_INPUT_USD_PER_MTOK = "2";
    process.env.BOT_SUMMARY_ANALYST_CACHED_INPUT_USD_PER_MTOK = "0.5";
    process.env.BOT_SUMMARY_ANALYST_OUTPUT_USD_PER_MTOK = "8";
    const replies = [
      withUsage(responseWithToolCall("get_staff_settlement", { staff: "ดำ" }), 1_000, 200, 50),
      withUsage(responseWithText("ไม่พบข้อมูลปิดเงินของดำ"), 1_500, 1_000, 40),
    ];
    let call = 0;
    const fetchImpl = (async () => jsonResponse(replies[call++])) as unknown as typeof fetch;
    const spy = spyOn(logger, "info");
    try {
      await answerWithReadonlyTools(
        client(new FakeDatabase()),
        "ดำวันนี้เงินขาดหรือเกิน",
        { apiKey: "test-key", fetchImpl },
        "2026-10-07",
      );
      const [entry] = usageEntries(spy);
      expect(entry).toMatchObject({
        model: "gpt-6-luna",
        businessDate: "2026-10-07",
        outcome: "answered",
        modelCalls: 2,
        toolCalls: ["get_staff_settlement"],
        usageComplete: true,
        inputTokens: 2_500,
        cachedInputTokens: 1_200,
        outputTokens: 90,
      });
      // (1300 × 2 + 1200 × 0.5 + 90 × 8) / 1e6
      expect(entry!.estimatedCostUsd).toBeCloseTo(0.00392, 10);
      expect(typeof entry!.durationMs).toBe("number");
      // No question text, staff name, tool arguments or answer in telemetry.
      expect(JSON.stringify(entry)).not.toContain("ดำ");
    } finally {
      spy.mockRestore();
    }
  });

  test("cost is unknown (null), never zero, without prices or usage", async () => {
    for (const name of PRICE_ENV) delete process.env[name];
    const fetchImpl = (async () => jsonResponse(responseWithText("สรุปแล้ว"))) as unknown as typeof fetch;
    const spy = spyOn(logger, "info");
    try {
      await answerWithReadonlyTools(
        client(new FakeDatabase()),
        "วันนี้ยอดขายเท่าไหร่",
        { apiKey: "test-key", fetchImpl },
        "2026-10-07",
      );
      const [entry] = usageEntries(spy);
      expect(entry).toMatchObject({ outcome: "answered", usageComplete: false, estimatedCostUsd: null });
    } finally {
      spy.mockRestore();
    }
  });

  test("a failed answer is still logged, with incomplete usage and no cost", async () => {
    process.env.BOT_SUMMARY_ANALYST_INPUT_USD_PER_MTOK = "2";
    process.env.BOT_SUMMARY_ANALYST_OUTPUT_USD_PER_MTOK = "8";
    let call = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      call += 1;
      return call === 1
        ? jsonResponse(withUsage(responseWithToolCall("get_daily_summary", {}), 800, 0, 30))
        : hangingFetch(input, init);
    }) as typeof fetch;
    const spy = spyOn(logger, "info");
    try {
      await expect(answerWithReadonlyTools(
        client(new FakeDatabase()),
        "วันนี้ยอดขายเท่าไหร่",
        { apiKey: "test-key", fetchImpl, budgetMs: 1_500 },
        "2026-10-07",
      )).rejects.toThrow("timed out");
      const [entry] = usageEntries(spy);
      expect(entry).toMatchObject({
        outcome: "error",
        modelCalls: 2,
        usageComplete: false,
        inputTokens: 800,
        outputTokens: 30,
        estimatedCostUsd: null,
      });
    } finally {
      spy.mockRestore();
    }
  });
});
