import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import { validateProduceEntry } from "@/lib/produce/entry-validation";
import { loadRuntimeApprovedProductNames } from "@/lib/produce/auto-dictionary";
import { dictionaryCategoryFor } from "./category";
import {
  preloadRuntimeProductCodes,
  resetRuntimeProductCodesForTests,
  resolveItemLineProductCode,
  resolveProductCode,
} from "./resolver";

const STATIC_CODE = "\u0e21\u0030\u0032";
const PROMOTED_CODE = "\u0e21\u0039\u0038";
const STALE_CODE = "\u0e21\u0039\u0036";
const LATEST_CODE = "\u0e21\u0039\u0037";

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

function deferredClient() {
  type Response = { data: unknown[] | null; error: { message: string } | null };
  let complete!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => { complete = resolve; });
  return {
    client: {
      from(table: string) {
        expect(table).toBe("produce_product_codes");
        return {
          select() { return this; },
          limit: () => response,
        };
      },
    },
    complete,
  };
}

function row(productCode: string, codeEnabled: boolean) {
  return {
    product_code: productCode,
    category_code: "cat",
    category_name: "category",
    canonical_name: `product ${productCode}`,
    code_enabled: codeEnabled,
  };
}

describe("runtime product-code resolver", () => {
  beforeEach(() => resetRuntimeProductCodesForTests());
  afterEach(() => resetRuntimeProductCodesForTests());

  it("keeps static legacy behavior before preload", () => {
    expect(resolveProductCode(STATIC_CODE)).not.toBeNull();
  });

  it("resolves an auto-added code through ingest parsing and validation", async () => {
    const canonicalName = "\u0e21\u0e30\u0e01\u0e2d\u0e01\u0e43\u0e2b\u0e21\u0e48";
    await preloadRuntimeProductCodes(client([{
      product_code: PROMOTED_CODE,
      category_code: "\u0e21",
      category_name: "\u0e1c\u0e25\u0e44\u0e21\u0e49",
      canonical_name: canonicalName,
      code_enabled: true,
    }]) as never);

    const parsed = parseWeighSession(`1.${PROMOTED_CODE} 10\u0e1a\u0e32\u0e17\n1\u0e42\u0e25`);
    expect(parsed.parse_errors).not.toContain(`unknown product code ${PROMOTED_CODE}`);
    expect(parsed.items[0]?.product_name).toBe(canonicalName);

    const runtimeApprovedProductNames = await loadRuntimeApprovedProductNames(client([{
      canonical_name: canonicalName,
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
    expect(dictionaryCategoryFor(canonicalName)).toBe("\u0e21");
  });

  it("resolves a successful promoted code", async () => {
    await preloadRuntimeProductCodes(client([row(PROMOTED_CODE, true)]) as never);
    expect(resolveProductCode(PROMOTED_CODE)).toBe(`product ${PROMOTED_CODE}`);
  });

  it("lets a successful DB snapshot disable a static code", async () => {
    await preloadRuntimeProductCodes(client([row(STATIC_CODE, false)]) as never);
    expect(resolveProductCode(STATIC_CODE)).toBeNull();
  });

  it("does not use a static code after a cold failed read", async () => {
    const failedClient = {
      from: () => ({
        select() { return this; },
        limit: async () => ({ data: null, error: { message: "read failed" } }),
      }),
    };
    await preloadRuntimeProductCodes(failedClient as never);

    expect(resolveProductCode(STATIC_CODE)).toBeNull();
    expect(resolveItemLineProductCode(`${STATIC_CODE} 10`).kind).toBe("unknown");
  });

  it("does not use a static code after a cold preload throw", async () => {
    await preloadRuntimeProductCodes({ from: () => { throw new Error("read failed"); } });

    expect(resolveProductCode(STATIC_CODE)).toBeNull();
    expect(resolveItemLineProductCode(`${STATIC_CODE} 10`).kind).toBe("unknown");
  });

  it("clears the previous overlay when refresh throws", async () => {
    await preloadRuntimeProductCodes(client([row(PROMOTED_CODE, true)]) as never);
    await preloadRuntimeProductCodes({ from: () => { throw new Error("read failed"); } });
    expect(resolveProductCode(PROMOTED_CODE)).toBeNull();
  });

  it("keeps the current snapshot while overlapping preloads are pending", async () => {
    await preloadRuntimeProductCodes(client([row(PROMOTED_CODE, true)]) as never);
    const older = deferredClient();
    const newer = deferredClient();
    const olderPreload = preloadRuntimeProductCodes(older.client as never);
    const newerPreload = preloadRuntimeProductCodes(newer.client as never);

    expect(resolveProductCode(PROMOTED_CODE)).toBe(`product ${PROMOTED_CODE}`);
    older.complete({ data: [row(STALE_CODE, true)], error: null });
    await olderPreload;
    expect(resolveProductCode(PROMOTED_CODE)).toBe(`product ${PROMOTED_CODE}`);
    expect(resolveProductCode(STALE_CODE)).toBeNull();

    newer.complete({ data: [row(LATEST_CODE, true)], error: null });
    await newerPreload;
    expect(resolveProductCode(LATEST_CODE)).toBe(`product ${LATEST_CODE}`);
    expect(resolveProductCode(PROMOTED_CODE)).toBeNull();
  });

  it("does not let an older preload overwrite a newer successful snapshot", async () => {
    const older = deferredClient();
    const olderPreload = preloadRuntimeProductCodes(older.client as never);
    await preloadRuntimeProductCodes(client([row(LATEST_CODE, true)]) as never);

    older.complete({ data: [row(STALE_CODE, true)], error: null });
    await olderPreload;

    expect(resolveProductCode(LATEST_CODE)).toBe(`product ${LATEST_CODE}`);
    expect(resolveProductCode(STALE_CODE)).toBeNull();
  });

  it("fails closed for an exactly-at-limit snapshot", async () => {
    await preloadRuntimeProductCodes(client([row(PROMOTED_CODE, true)]) as never);
    const rows = Array.from({ length: 5000 }, (_, index) =>
      row(`\u0e21${String(index).padStart(4, "0")}`, true));
    await preloadRuntimeProductCodes(client(rows) as never);

    expect(resolveProductCode(PROMOTED_CODE)).toBeNull();
    expect(resolveProductCode(STATIC_CODE)).toBeNull();
    expect(resolveItemLineProductCode(`${STATIC_CODE} 10`).kind).toBe("unknown");
    expect(resolveProductCode("\u0e21\u0030\u0030\u0030\u0030")).toBeNull();
    expect(resolveItemLineProductCode("\u0e21\u0039\u0039\u0039 10").kind).toBe("unknown");
  });
});
