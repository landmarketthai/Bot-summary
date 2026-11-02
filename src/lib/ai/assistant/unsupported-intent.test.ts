/**
 * Semantic correctness (live GPT-6 Luna hal-03): a question the data cannot
 * answer — profit/cost, a forecast, a month/year total, a write request —
 * must get a limitation that matches what was asked, never a different
 * figure (sales, cash shortfall) rendered as if it answered it.
 */
import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { AssistantModelProvider, ModelRoundRequest } from "@/lib/ai/model-provider";
import { answerAssistantJob, type AssistantCoreDeps } from "./core";
import type { AssistantJob } from "./job-store";
import { createFixtureDataReader, FIXTURE_TODAY, type FixtureRead } from "./testing/fixture-data";
import { MemoryAssistantJobStore } from "./testing/memory-job-store";
import { ScriptedThaiModel } from "./testing/scripted-provider";
import { classifyUnsupportedIntent } from "./unsupported-intent";

const SALES_FIGURES = ["40,550.75", "18,450.50", "9,320.00", "12,780.25", "1,650.00"];

/** What the live model did for hal-03: call the sales tool, whatever the question. */
function salesToolModel(): AssistantModelProvider & { requests: ModelRoundRequest[] } {
  const requests: ModelRoundRequest[] = [];
  return {
    name: "sales-tool", model: "sales-tool", requests,
    async respond(request) {
      requests.push(request);
      const done = request.transcript.some((item) => item.kind === "tool_result");
      return done
        ? { text: "กำไรวันนี้ 40,550.75 บาท", toolCalls: [], model: "sales-tool" }
        : { text: "", toolCalls: [{ callId: "c1", name: "get_daily_summary", arguments: "{}" }], model: "sales-tool" };
    },
  };
}

let seq = 0;
function harness(provider: AssistantModelProvider) {
  const store = new MemoryAssistantJobStore();
  const reads: FixtureRead[] = [];
  const deps: AssistantCoreDeps = {
    supabase: {} as SupabaseClient<Database>,
    store,
    provider,
    sourceAllowed: () => true,
    resolveGroupPolicy: async (sourceId) => ({ ok: true, policy: { sourceId, markets: null } }),
    readData: createFixtureDataReader(reads),
  };
  const ask = async (question: string, overrides: { sourceType?: "user" | "group"; sourceId?: string } = {}) => {
    seq += 1;
    await store.enqueue({
      lineEventId: `ui-${seq}`, rawMessageId: null, destination: "Ubot", sourceType: overrides.sourceType ?? "group",
      sourceId: overrides.sourceId ?? "Capproved", lineUserId: "Umember", question, askedBusinessDate: FIXTURE_TODAY,
      eventTimestampMs: 1_793_000_000_000 + seq, replyToken: null, replyTokenExpiresAt: null,
    });
    const [job] = await store.claim("w", { limit: 1, leaseSeconds: 60, maxRunning: 5 });
    const answer = await answerAssistantJob(job as AssistantJob, { deadlineAt: Date.now() + 10_000, signal: new AbortController().signal }, deps);
    await store.recordAnswer(job!.id, job!.lease_token!, {
      answer: answer.text, kind: answer.kind ?? "answer", turn: answer.turn ?? null, scopeKey: answer.scopeKey ?? null,
    });
    await store.complete(job!.id, job!.lease_token!, "completed");
    return answer;
  };
  return { ask, reads, store };
}

describe("profit / cost questions never get sales or cash results instead (hal-03)", () => {
  for (const question of [
    "กำไรวันนี้เท่าไหร่",
    "วันนี้ได้กำไรไหม",
    "เมื่อวานกำไรเท่าไร",
    "ยอดกำไรพาซิโอ้ผักวันนี้",
    "ต้นทุนวันนี้เท่าไหร่",
    "วันนี้ขาดทุนไหม",
    "กำไรสุทธิเดือนนี้",
    "แล้วกำไรล่ะ",
  ]) {
    test(question, async () => {
      const model = salesToolModel();
      const h = harness(model);
      const answer = await h.ask(question);
      expect(answer.kind).toBe("notice");
      expect(answer.text).toContain("กำไร");
      expect(answer.text).toContain("ต้นทุน");
      for (const figure of SALES_FIGURES) expect(answer.text).not.toContain(figure);
      expect(model.requests).toHaveLength(0);
      expect(h.reads).toHaveLength(0);
    });
  }

  test("mixed sales + profit: sales answered from the backend, profit stated as unavailable", async () => {
    const h = harness(salesToolModel());
    const answer = await h.ask("ยอดขายกับกำไรวันนี้เท่าไหร่");
    expect(answer.kind).toBe("answer");
    expect(answer.text).toContain("ยอดขาย");
    expect(answer.text).toContain("40,550.75");
    expect(answer.text).toMatch(/^ยังสรุปกำไร/u);
    expect(answer.text).not.toContain("กำไรวันนี้ 40,550.75");
  });
});

describe("other unsupported questions get a limitation that matches what was asked", () => {
  test("forecast (hal-01)", async () => {
    for (const question of ["พรุ่งนี้จะขายได้เท่าไหร่", "คาดการณ์ยอดขายสัปดาห์หน้า", "เดือนหน้าจะขายได้กี่บาท"]) {
      const model = salesToolModel();
      const answer = await harness(model).ask(question);
      expect(answer.kind).toBe("notice");
      expect(answer.text).toContain("คาดการณ์");
      for (const figure of SALES_FIGURES) expect(answer.text).not.toContain(figure);
      expect(model.requests).toHaveLength(0);
    }
  });

  test("month / year totals (hal-02)", async () => {
    for (const question of ["ยอดขายทั้งเดือนตุลาคมเท่าไหร่", "ยอดขายเดือนนี้รวมเท่าไหร่", "ยอดขายทั้งปีเท่าไหร่", "สรุปยอดเดือนกันยายน"]) {
      const model = salesToolModel();
      const answer = await harness(model).ask(question);
      expect(answer.kind).toBe("notice");
      expect(answer.text).toContain("รายวัน");
      for (const figure of SALES_FIGURES) expect(answer.text).not.toContain(figure);
      expect(model.requests).toHaveLength(0);
    }
  });

  test("write requests (hal-04)", async () => {
    for (const question of ["ช่วยแก้ยอดขายพาซิโอ้ผักเป็น 20,000 ให้หน่อย", "ลบสลิปของดำให้หน่อย", "บันทึกเบิกมะม่วง 30 กก. ให้ด้วย"]) {
      const model = salesToolModel();
      const answer = await harness(model).ask(question);
      expect(answer.kind).toBe("notice");
      expect(answer.text).toContain("อ่านข้อมูลอย่างเดียว");
      expect(answer.text).not.toContain("20,000");
      expect(model.requests).toHaveLength(0);
    }
  });

  test("cumulative stock asks explain why daily good returns cannot establish a monthly balance (sto-06)", async () => {
    for (const question of ["สต๊อกสะสมทั้งเดือนเหลือเท่าไหร่", "สต็อกเดือนนี้เหลือเท่าไร", "ของเหลือสะสมเท่าไหร่"]) {
      const model = salesToolModel();
      const h = harness(model);
      const answer = await h.ask(question);
      expect(answer.kind).toBe("notice");
      expect(answer.text).toContain("ชั่งคืนดีรายวัน");
      expect(answer.text).toContain("ไม่ใช่บัญชีสินค้าคงคลังต่อเนื่อง");
      expect(answer.text).not.toContain("40,550.75");
      expect(model.requests).toHaveLength(0);
      expect(h.reads).toHaveLength(0);
    }
  });

  test("a 1:1 chat or an unapproved group is still refused first", async () => {
    const h = harness(salesToolModel());
    expect((await h.ask("กำไรวันนี้เท่าไหร่", { sourceType: "user", sourceId: "Umember" })).text).toContain("ตอบเฉพาะในกลุ่ม");
  });
});

describe("supported questions are not caught", () => {
  for (const question of [
    "วันนี้ทุกตลาดขายได้เท่าไหร่?",
    "ดำวันนี้เงินขาดหรือเกิน",
    "เทียบยอดขายวันนี้กับเมื่อวาน",
    "สรุปยอดวันที่ 30 ตุลาคม",
    "ยอดขาย 7 วันย้อนหลัง",
    "ใบขาวเมื่อวานปิดครบไหม",
    "แก้ไขสลิปของดำเสร็จหรือยัง",
    "แก้ไขสลิปให้ดำเสร็จหรือยัง",
    "แก้ไขสลิปของดำเรียบร้อยแล้วหรือยัง",
    "ทำไมรายการของพี่ปลายังปิดไม่ได้?",
    "แล้วปลาล่ะ",
    "พี่ดำคืนเสียเท่าไหร่",
  ]) {
    test(question, () => {
      expect(classifyUnsupportedIntent(question)).toBeNull();
    });
  }

  test("supported sales and settlement answers are unchanged", async () => {
    const h = harness(new ScriptedThaiModel());
    expect((await h.ask("วันนี้ทุกตลาดขายได้เท่าไหร่?")).text).toContain("40,550.75");
    expect((await h.ask("ดำวันนี้เงินขาดหรือเกิน")).text).toContain("เงินขาด 120.00");
  });
});
