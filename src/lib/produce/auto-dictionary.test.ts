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
});

describe("runtime similarity guard", () => {
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
