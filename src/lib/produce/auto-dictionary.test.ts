import { describe, expect, it } from "bun:test";
import {
  inferAutoDictionaryCategory,
  loadRuntimeApprovedProductNames,
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

const SESSION = {
  sessionKey: "produce:test",
  sessionGeneration: "11111111-1111-1111-1111-111111111111",
  businessDate: "2026-09-24",
};

/** PostgREST max_rows (supabase/config.toml): a larger limit is silently truncated. */
const SERVER_MAX_ROWS = 1000;

/** produce_product_codes behind PostgREST (eq/gt/order, the max_rows cap) plus the observe RPC. */
function dictionaryClient(
  rows: Array<Record<string, unknown>>,
  observe: (args: Record<string, unknown>) => unknown = () => ({ status: "observing" }),
) {
  const pages: Array<string | null> = [];
  const rpcArgs: Array<Record<string, unknown>> = [];
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
          pages.push(after);
          return { data: matched.slice(0, Math.min(count, SERVER_MAX_ROWS)), error: null };
        },
      };
      return query;
    },
    async rpc(_name: string, args: Record<string, unknown>) {
      rpcArgs.push(args);
      return { data: observe(args), error: null };
    },
  };
  return { client, pages, rpcArgs };
}

/** Enabled products in the ท namespace, which sorts before every ม code. */
function fillerRows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    product_code: `ท${String(index).padStart(4, "0")}`,
    canonical_name: `filler product ${index}`,
    code_enabled: true,
  }));
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
    ["ทุเรียนเทศ", "ม"],
    ["ทุเรียนเทศขนาดใหญ่", "ม"],
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
          order() { return this; },
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

  it("sends soursop variants to observation as fruit", async () => {
    const rpcArgs: Array<Record<string, unknown>> = [];
    const client = {
      from() {
        return {
          select() { return this; },
          eq() { return this; },
          order() { return this; },
          async limit() { return { data: [], error: null }; },
        };
      },
      async rpc(_name: string, args: Record<string, unknown>) {
        rpcArgs.push(args);
        return { data: { status: "observing" }, error: null };
      },
    };

    await observeAutoDictionaryReviews(client as never, {
      sessionKey: "produce:test",
      sessionGeneration: "11111111-1111-1111-1111-111111111111",
      businessDate: "2026-09-24",
    }, [unknown("ทุเรียนเทศขนาดใหญ่")]);

    expect(rpcArgs).toEqual([expect.objectContaining({
      p_category_code: "ม",
      p_category_name: "ผลไม้",
    })]);
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
          order() { return this; },
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

  it.each([5000, 5001])("fails closed when the runtime dictionary reaches its ceiling (%i rows)", async (count) => {
    const { client, pages, rpcArgs } = dictionaryClient(fillerRows(count));

    const observations = await observeAutoDictionaryReviews(client as never, SESSION, [unknown("ลูกพลุน")]);

    expect(pages).toHaveLength(5);
    expect(rpcArgs).toEqual([]);
    expect(observations[0]).toMatchObject({ status: "needs_review", reason: "automation_unavailable" });
  });

  it("holds a typo whose near match sits beyond the first 1000 dictionary rows", async () => {
    // The observe RPC's contract: a caller-supplied similar code always goes to review.
    const { client, pages, rpcArgs } = dictionaryClient(
      [...fillerRows(1200), { product_code: "ม93", canonical_name: "ลูกพรุน", code_enabled: true }],
      (args) => (args.p_similar_product_code
        ? { status: "needs_review", reason: "similar_existing_product" }
        : { status: "promoted", product_code: "ม99" }),
    );

    const observations = await observeAutoDictionaryReviews(client as never, SESSION, [unknown("ลูกพลุน")]);

    expect(pages).toEqual([null, "ท0999"]);
    expect(rpcArgs.map((args) => args.p_similar_product_code)).toEqual(["ม93"]);
    expect(observations[0]).toMatchObject({ status: "needs_review", reason: "similar_existing_product" });
  });

  it("holds a typo near a product that was added to the DB after deploy", async () => {
    let rpcArgs: Record<string, unknown> | null = null;
    const client = {
      from(table: string) {
        expect(table).toBe("produce_product_codes");
        return {
          select() { return this; },
          eq() { return this; },
          order() { return this; },
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

describe("runtime approved names", () => {
  it("approves enabled names only after reading every page", async () => {
    const disabled = { product_code: "ม01", canonical_name: "disabled product", code_enabled: false };
    const complete = await loadRuntimeApprovedProductNames(
      dictionaryClient([...fillerRows(1500), disabled]).client as never,
    );
    expect(complete.size).toBe(1500);
    expect(complete.has("filler product 1499")).toBe(true);
    expect(complete.has("disabled product")).toBe(false);

    const atCeiling = await loadRuntimeApprovedProductNames(dictionaryClient(fillerRows(5000)).client as never);
    expect(atCeiling.size).toBe(0);
  });
});
