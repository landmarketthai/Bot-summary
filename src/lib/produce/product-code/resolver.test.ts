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
  runtimeProductCodeEntryForName,
} from "./resolver";

const STATIC_CODE = "\u0e21\u0030\u0032";
const PROMOTED_CODE = "\u0e21\u0039\u0038";
const STALE_CODE = "\u0e21\u0039\u0036";
const LATEST_CODE = "\u0e21\u0039\u0037";

/** PostgREST max_rows (supabase/config.toml): a larger limit is silently truncated. */
const SERVER_MAX_ROWS = 1000;

/** produce_product_codes behind PostgREST: eq/gt filters, ordering, and the max_rows cap. */
function dictionaryTable(rows: Array<Record<string, unknown>>) {
  const pages: Array<{ after: string | null; limit: number; returned: number }> = [];
  const client = {
    from(table: string) {
      expect(table).toBe("produce_product_codes");
      let matched = [...rows];
      let after: string | null = null;
      const query = {
        select: () => query,
        eq(column: string, value: unknown) {
          matched = matched.filter((row) => row[column] === value);
          return query;
        },
        gt(column: string, value: string) {
          after = value;
          matched = matched.filter((row) => String(row[column]) > value);
          return query;
        },
        order(column: string) {
          matched.sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : 1));
          return query;
        },
        async limit(count: number) {
          const data = matched.slice(0, Math.min(count, SERVER_MAX_ROWS));
          pages.push({ after, limit: count, returned: data.length });
          return { data, error: null };
        },
      };
      return query;
    },
  };
  return { client, pages };
}

function client(rows: Array<Record<string, unknown>>) {
  return dictionaryTable(rows).client;
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
          order() { return this; },
          limit: () => response,
        };
      },
    },
    complete,
  };
}

/** A 4-digit code in the ท namespace, which sorts before every ม code. */
function durianCode(index: number) {
  return `ท${String(index).padStart(4, "0")}`;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
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
    const promoted = {
      product_code: PROMOTED_CODE,
      category_code: "\u0e21",
      category_name: "\u0e1c\u0e25\u0e44\u0e21\u0e49",
      canonical_name: canonicalName,
      code_enabled: true,
    };
    await preloadRuntimeProductCodes(client([promoted]) as never);

    const parsed = parseWeighSession(`1.${PROMOTED_CODE} 10\u0e1a\u0e32\u0e17\n1\u0e42\u0e25`);
    expect(parsed.parse_errors).not.toContain(`unknown product code ${PROMOTED_CODE}`);
    expect(parsed.items[0]?.product_name).toBe(canonicalName);

    const runtimeApprovedProductNames = await loadRuntimeApprovedProductNames(client([promoted]) as never);
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
        order() { return this; },
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
    await flushMicrotasks();
    expect(resolveProductCode(PROMOTED_CODE)).toBe(`product ${PROMOTED_CODE}`);
    expect(resolveProductCode(STALE_CODE)).toBeNull();

    newer.complete({ data: [row(LATEST_CODE, true)], error: null });
    // The superseded caller waits on this winner, so complete it before joining both.
    const [olderSnapshot, newerSnapshot] = await Promise.all([olderPreload, newerPreload]);
    expect(resolveProductCode(LATEST_CODE)).toBe(`product ${LATEST_CODE}`);
    expect(resolveProductCode(PROMOTED_CODE)).toBeNull();
    // ...and is handed the winner's snapshot, never its own stale read.
    expect(olderSnapshot).toBe(newerSnapshot);
    expect(runtimeProductCodeEntryForName(`product ${STALE_CODE}`, olderSnapshot)).toBeNull();
  });

  it("returns each caller's own snapshot, which a later failed refresh cannot change", async () => {
    const loaded = await preloadRuntimeProductCodes(client([row(PROMOTED_CODE, true)]) as never);
    const failed = await preloadRuntimeProductCodes({ from: () => { throw new Error("read failed"); } });

    expect(runtimeProductCodeEntryForName(`product ${PROMOTED_CODE}`, loaded)?.code).toBe(PROMOTED_CODE);
    expect(runtimeProductCodeEntryForName(`product ${PROMOTED_CODE}`, failed)).toBeNull();
    // Everyone reading the process-wide resolver still fails closed.
    expect(runtimeProductCodeEntryForName(`product ${PROMOTED_CODE}`)).toBeNull();
    expect(resolveProductCode(PROMOTED_CODE)).toBeNull();
    expect(resolveProductCode(STATIC_CODE)).toBeNull();
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

  it("holds a superseded caller until the winning snapshot is ready", async () => {
    await preloadRuntimeProductCodes(client([row(PROMOTED_CODE, true)]) as never);
    const older = deferredClient();
    const newer = deferredClient();
    let olderFinished = false;
    const olderPreload = preloadRuntimeProductCodes(older.client as never).then(() => {
      olderFinished = true;
    });
    const newerPreload = preloadRuntimeProductCodes(newer.client as never);

    older.complete({ data: [row(STALE_CODE, true)], error: null });
    await flushMicrotasks();
    expect(olderFinished).toBe(false);

    const latest = deferredClient();
    const latestPreload = preloadRuntimeProductCodes(latest.client as never);
    newer.complete({ data: [row(STATIC_CODE, true)], error: null });
    await flushMicrotasks();
    expect(olderFinished).toBe(false);
    expect(resolveProductCode(PROMOTED_CODE)).toBe(`product ${PROMOTED_CODE}`);
    expect(resolveProductCode(STATIC_CODE)).toBeNull();

    latest.complete({ data: [row(LATEST_CODE, true)], error: null });
    await Promise.all([olderPreload, newerPreload, latestPreload]);
    expect(olderFinished).toBe(true);
    expect(resolveItemLineProductCode(`${LATEST_CODE} 10`).kind).toBe("resolved");
    expect(resolveItemLineProductCode(`${STALE_CODE} 10`).kind).toBe("unknown");
    expect(resolveProductCode(PROMOTED_CODE)).toBeNull();
  });

  it("reads every page of a dictionary larger than PostgREST max_rows", async () => {
    // 1500 ท codes sort first, so the static code's DB tombstone and the
    // promoted code only arrive on the second page.
    const filler = Array.from({ length: 1500 }, (_, index) => row(durianCode(index), true));
    const table = dictionaryTable([...filler, row(STATIC_CODE, false), row(PROMOTED_CODE, true)]);

    await preloadRuntimeProductCodes(table.client as never);

    expect(table.pages).toEqual([
      { after: null, limit: 1000, returned: 1000 },
      { after: durianCode(999), limit: 1000, returned: 502 },
    ]);
    expect(resolveProductCode(durianCode(0))).toBe(`product ${durianCode(0)}`);
    expect(resolveProductCode(PROMOTED_CODE)).toBe(`product ${PROMOTED_CODE}`);
    expect(resolveProductCode(STATIC_CODE)).toBeNull();
  });

  it("accepts a 4999-row dictionary read across five pages", async () => {
    const table = dictionaryTable(Array.from({ length: 4999 }, (_, index) => row(durianCode(index), true)));

    await preloadRuntimeProductCodes(table.client as never);

    expect(table.pages.map((page) => page.returned)).toEqual([1000, 1000, 1000, 1000, 999]);
    expect(resolveProductCode(durianCode(4998))).toBe(`product ${durianCode(4998)}`);
  });

  it.each([5000, 5001])("fails closed at a %i-row dictionary without reading past the ceiling", async (count) => {
    await preloadRuntimeProductCodes(client([row(PROMOTED_CODE, true)]) as never);
    const table = dictionaryTable(Array.from({ length: count }, (_, index) => row(durianCode(index), true)));

    await preloadRuntimeProductCodes(table.client as never);

    expect(table.pages.map((page) => page.returned)).toEqual([1000, 1000, 1000, 1000, 1000]);
    expect(resolveProductCode(durianCode(0))).toBeNull();
    expect(resolveProductCode(PROMOTED_CODE)).toBeNull();
    expect(resolveProductCode(STATIC_CODE)).toBeNull();
    expect(resolveItemLineProductCode(`${STATIC_CODE} 10`).kind).toBe("unknown");
  });
});
