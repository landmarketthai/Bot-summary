import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
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
