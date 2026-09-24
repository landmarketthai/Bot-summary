import { describe, expect, it } from "bun:test";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import { validateProduceEntry } from "@/lib/produce/entry-validation";
import { loadRuntimeApprovedProductNames } from "@/lib/produce/auto-dictionary";
import { dictionaryCategoryFor } from "./category";
import {
  preloadRuntimeProductCodes,
  resolveItemLineProductCode,
  resolveProductCode,
} from "./resolver";

function client(rows: unknown[]) {
  return {
    from(table: string) {
      expect(table).toBe("produce_product_codes");
      return {
        select() { return this; },
        eq() { return this; },
        limit: async () => ({ data: rows, error: null }),
      };
    },
  };
}

describe("runtime product-code overlay", () => {
  it("resolves an auto-added code through ingest parsing and validation", async () => {
    await preloadRuntimeProductCodes(client([{
      product_code: "ม98",
      category_code: "ม",
      category_name: "ผลไม้",
      canonical_name: "มะกอกใหม่",
      code_enabled: true,
    }]) as never);

    const parsed = parseWeighSession("1.ม98 10บาท\n1โล");
    expect(parsed.parse_errors).not.toContain("unknown product code ม98");
    expect(parsed.items[0]?.product_name).toBe("มะกอกใหม่");

    const runtimeApprovedProductNames = await loadRuntimeApprovedProductNames(client([{
      canonical_name: "มะกอกใหม่",
    }]) as never);
    const result = validateProduceEntry({
      parsed,
      roundRows: [],
      roundBound: false,
      runtimeApprovedProductNames,
      validationIdentity: {
        sessionKey: "produce:test",
        sessionGeneration: "11111111-1111-1111-1111-111111111111",
        accountabilityRoundId: null,
      },
    });
    expect(result.reviews.some((review) => review.kind === "unknown_product_vocabulary")).toBe(false);
    expect(dictionaryCategoryFor("มะกอกใหม่")).toBe("ม");
  });

  it("keeps static codes and fail-closed unknown codes unchanged", async () => {
    await preloadRuntimeProductCodes(client([]) as never);
    expect(resolveProductCode("ม02")).toBe("กล้วยน้ำว้า");
    expect(resolveItemLineProductCode("ม999 10บาท").kind).toBe("unknown");
  });
});
