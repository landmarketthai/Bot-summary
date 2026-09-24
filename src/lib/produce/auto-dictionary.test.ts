import { describe, expect, it } from "bun:test";
import {
  inferAutoDictionaryCategory,
  observeAutoDictionaryReviews,
} from "./auto-dictionary";
import type { ProduceValidationReview } from "./entry-validation";

function unknown(name: string): ProduceValidationReview {
  return {
    kind: "unknown_product_vocabulary",
    severity: "review_required",
    itemNumber: 1,
    productName: name,
    suggestions: [],
  };
}

describe("safe auto dictionary category inference", () => {
  const cases: ReadonlyArray<readonly [string, "ม" | "ผ" | "ป" | "ท" | "ห"]> = [
    ["มะกอก", "ม"],
    ["องุ่นสายพันธุ์ใหม่", "ม"],
    ["แตงกวาเล็กพิเศษ", "ผ"],
    ["ต้นหอม", "ผ"],
    ["ดอกแค", "ผ"],
    ["ดอกขจร", "ผ"],
    ["ยอดมะพร้าว", "ผ"],
    ["ยอดฟักแม้ว", "ผ"],
    ["ถั่วแขก", "ผ"],
    ["ถั่วงอก", "ผ"],
    ["ถั่วฝักยาว", "ผ"],
    ["ถั่วพู", "ผ"],
    ["ถั่วลันเตา", "ผ"],
    ["หอมแดง", "ผ"],
    ["หอมหัวใหญ่", "ผ"],
    ["หอมใหญ่", "ผ"],
    ["ใบเตย", "ผ"],
    ["ใบชะพลู", "ผ"],
    ["ใบมะกรูด", "ผ"],
    ["ใบกะเพรา", "ผ"],
    ["ทุเรียนพันธุ์ใหม่", "ท"],
    ["ปลาหวานสูตรใหม่", "ป"],
    ["เห็ดทดลอง", "ห"],
  ];
  it.each(cases)("classifies %s conservatively as %s", (name, code) => {
    expect(inferAutoDictionaryCategory(name)?.code).toBe(code);
  });

  it("leaves an unknown category for human review", () => {
    expect(inferAutoDictionaryCategory("สินค้าใหม่ทดลอง")).toBeNull();
  });

  it("leaves unrelated names beginning with ลูก for human review", () => {
    expect(inferAutoDictionaryCategory("ลูกค้าใหม่")).toBeNull();
  });

  const unrelatedPrefixCases = [
    "ดอกกุหลาบ",
    "ยอดขายรายเดือน",
    "หอมกรุ่นน้ำหอม",
    "ใบเสร็จรับเงิน",
  ];
  const ambiguousBeanCases = ["ถั่วลิสงคั่ว", "ถั่วเหลือง", "ถั่วแดง"];

  it.each(unrelatedPrefixCases)("leaves unrelated name %s for human review", (name) => {
    expect(inferAutoDictionaryCategory(name)).toBeNull();
  });

  it.each(ambiguousBeanCases)("leaves ambiguous bean name %s for human review", (name) => {
    expect(inferAutoDictionaryCategory(name)).toBeNull();
  });

  it("sends unmatched broad-prefix names for review without inferring a category", async () => {
    const names = [...unrelatedPrefixCases, ...ambiguousBeanCases];
    const rpcArgs: Array<Record<string, unknown>> = [];
    const client = {
      from() {
        return {
          select() { return this; },
          eq() { return this; },
          async limit() { return { data: [], error: null }; },
        };
      },
      async rpc(_name: string, args: Record<string, unknown>) {
        rpcArgs.push(args);
        return { data: { status: "needs_review" }, error: null };
      },
    };

    const observations = await observeAutoDictionaryReviews(client as never, {
      sessionKey: "produce:test",
      sessionGeneration: "11111111-1111-1111-1111-111111111111",
      businessDate: "2026-09-24",
    }, names.map(unknown));

    expect(observations.map((observation) => observation.status)).toEqual(names.map(() => "needs_review"));
    expect(rpcArgs.map((args) => args.p_category_code)).toEqual(names.map(() => null));
    expect(rpcArgs.map((args) => args.p_category_name)).toEqual(names.map(() => null));
  });
});

describe("runtime similarity guard", () => {
  it.each(["error", "throw"]) ("fails closed when the runtime dictionary read %s", async (failure) => {
    let rpcCalled = false;
    const client = {
      from() {
        return {
          select() { return this; },
          eq() { return this; },
          async limit() {
            if (failure === "throw") throw new Error("database unavailable");
            return { data: null, error: { message: "database unavailable" } };
          },
        };
      },
      async rpc() {
        rpcCalled = true;
        return { data: { status: "promoted", product_code: "à¸¡99" }, error: null };
      },
    };
    const observations = await observeAutoDictionaryReviews(client as never, {
      sessionKey: "produce:test",
      sessionGeneration: "11111111-1111-1111-1111-111111111111",
      businessDate: "2026-09-24",
    }, [unknown("à¸¥à¸¹à¸à¸žà¸¥à¸¸à¸™")]);
    expect(rpcCalled).toBe(false);
    expect(observations).toEqual([expect.objectContaining({
      status: "needs_review",
      reason: "automation_unavailable",
    })]);
  });

  it("fails closed when the runtime dictionary read reaches its limit", async () => {
    let rpcCalled = false;
    const client = {
      from() {
        return {
          select() { return this; },
          eq() { return this; },
          async limit() {
            return {
              data: Array.from({ length: 5000 }, (_, index) => ({
                product_code: `à¸¡${index}`,
                canonical_name: `à¸ªà¸´à¸™à¸„à¹‰à¸²${index}`,
              })),
              error: null,
            };
          },
        };
      },
      async rpc() {
        rpcCalled = true;
        return { data: { status: "promoted", product_code: "à¸¡99" }, error: null };
      },
    };
    const observations = await observeAutoDictionaryReviews(client as never, {
      sessionKey: "produce:test",
      sessionGeneration: "11111111-1111-1111-1111-111111111111",
      businessDate: "2026-09-24",
    }, [unknown("à¸¥à¸¹à¸à¸žà¸¥à¸¸à¸™")]);
    expect(rpcCalled).toBe(false);
    expect(observations[0]).toMatchObject({ status: "needs_review", reason: "automation_unavailable" });
  });

  it("holds a typo near a product that was added to the DB after deploy", async () => {
    let rpcArgs: Record<string, unknown> | null = null;
    const client = {
      from(table: string) {
        expect(table).toBe("produce_product_codes");
        return {
          select() { return this; },
          eq() { return this; },
          async limit() {
            return { data: [{ product_code: "ม93", canonical_name: "ลูกพรุน" }], error: null };
          },
        };
      },
      async rpc(name: string, args: Record<string, unknown>) {
        expect(name).toBe("observe_produce_dictionary_candidate");
        rpcArgs = args;
        return { data: { status: "needs_review", reason: "similar_existing_product" }, error: null };
      },
    };
    const observations = await observeAutoDictionaryReviews(client as never, {
      sessionKey: "produce:test",
      sessionGeneration: "11111111-1111-1111-1111-111111111111",
      businessDate: "2026-09-24",
    }, [unknown("ลูกพลุน")]);
    expect(rpcArgs).not.toBeNull();
    expect((rpcArgs as unknown as Record<string, unknown>).p_similar_product_code).toBe("ม93");
    expect(observations[0]?.status).toBe("needs_review");
  });
});
