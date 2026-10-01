import { describe, it, expect } from "bun:test";
import type { LineMessageEvent } from "@/lib/line/types";
import {
  parseWeighSession,
  bangkokTimeFromTimestamp,
  WeighSessionParser,
  assertWeighSessionFinalizable,
  buildWeighSessionValidationReply,
  getWeighSessionFinalizationErrors,
} from "./parser";
import { RE } from "./regex";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const EXAMPLE_1 = `\
18:53 เสือ รายการชั่งคืน
18:53 เสือ 1.หมอนทอง119บาท

38โล
18:53 เสือ 2.หมอนทอง119บาท

42โล
18:53 เสือ 3.หมอนทอง119บาท

18.5โล
18:53 เสือ 4.กระดุม100บาท

30.3โล
18:53 เสือ 5.ชะนี100บาท

38.3โล
18:53 เสือ 6.กระท้อน35บาท

14.5โล
18:53 เสือ คืนเสีย
18:53 เสือ 1.ชะนี100บาท

11.6โล
18:53 เสือ 2.กระท้อน35บาท

4.1โล
18:53 เสือ จบรายการชั่งคืนและคืนเสีย`;

const EXAMPLE_2 = `\
18:56 เสือ รายการชั่งเบิกไปตลาด72

25/5/69
18:56 เสือ 2หมอนทอง119บาท

38.1.โล
18:56 เสือ 3หมอนทอง119บาท

35.7.โล
18:56 เสือ 4กระดุม100บาท

29.9.โล
18:56 เสือ 5ชะนี100บาท

28.3.โล
18:56 เสือ 6ชะนี100บาท

28.โล
18:56 เสือ 7ก้านบาว109บาท

48.1.โล
18:56 เสือ 8กระท้อน40บาท

5.9.โล
18:56 เสือ 9กระท้อน30บาท

14.2.โล
18:56 เสือ 10ส้มไต้หวัน40บาท

2.6.โล
18:56 เสือ 11แอปเปิ้ล15บาท

9ลูก
18:56 เสือ 12แตงไทย20บาท

3ลูก
18:56 เสือ 13สัปปรถ15บาท

6.ลูก
18:56 เสือ 14สละ30บาท

22.2.โล
18:56 เสือ 15ทุเรียนกล่อง100บาท

13.กล่อง
18:56 เสือ รายการเบิกเพิ่ม
18:56 เสือ 16มะพร้าว25บาท

23.ลูก
18:56 เสือ 17ฝรั่งขาว45บาท

18.6.โล
18:56 เสือ 18ทุเรียนกล่อง100บาท

12.กล่อง
18:56 เสือ จบรายการชั่งเบิก`;

// ── Example 1: รายการชั่งคืน ──────────────────────────────────────────────────

describe("Example 1: รายการชั่งคืน", () => {
  const result = parseWeighSession(EXAMPLE_1);

  it("extracts staff name", () => {
    expect(result.staff_name).toBe("เสือ");
  });

  it("extracts session title", () => {
    expect(result.session_title).toBe("รายการชั่งคืน");
  });

  it("has no date (not present in input)", () => {
    expect(result.date).toBeNull();
  });

  it("parses 8 items total", () => {
    expect(result.items).toHaveLength(8);
  });

  it("parses no errors", () => {
    expect(result.parse_errors).toHaveLength(0);
  });

  it("parses main-section items correctly", () => {
    const main = result.items.filter((i) => i.section === "main");
    expect(main).toHaveLength(6);

    expect(main[0]).toMatchObject({
      item_number: 1, product_name: "หมอนทอง", price_per_unit: 119,
      quantity: 38, unit: "โล", section: "main",
    });
    expect(main[2]).toMatchObject({
      item_number: 3, product_name: "หมอนทอง", price_per_unit: 119,
      quantity: 18.5, unit: "โล",
    });
    expect(main[5]).toMatchObject({
      item_number: 6, product_name: "กระท้อน", price_per_unit: 35,
      quantity: 14.5, unit: "โล",
    });
  });

  it("parses คืนเสีย section items correctly", () => {
    const returns = result.items.filter((i) => i.section === "คืนเสีย");
    expect(returns).toHaveLength(2);

    expect(returns[0]).toMatchObject({
      item_number: 1, product_name: "ชะนี", price_per_unit: 100,
      quantity: 11.6, unit: "โล", section: "คืนเสีย",
    });
    expect(returns[1]).toMatchObject({
      item_number: 2, product_name: "กระท้อน", price_per_unit: 35,
      quantity: 4.1, unit: "โล", section: "คืนเสีย",
    });
  });
});

// ── Example 2: รายการชั่งเบิก ─────────────────────────────────────────────────

describe("Example 2: รายการชั่งเบิกไปตลาด", () => {
  const result = parseWeighSession(EXAMPLE_2);

  it("extracts staff name", () => {
    expect(result.staff_name).toBe("เสือ");
  });

  it("extracts session title with market number", () => {
    expect(result.session_title).toBe("รายการชั่งเบิกไปตลาด72");
  });

  it("parses Buddhist short year date", () => {
    expect(result.date).toBe("2026-05-25"); // 25/5/69 → 2569 BE → 2026 CE
  });

  it("parses 17 items total", () => {
    expect(result.items).toHaveLength(17);
  });

  it("parses no errors", () => {
    expect(result.parse_errors).toHaveLength(0);
  });

  it("handles item number without dot separator", () => {
    const item2 = result.items.find((i) => i.item_number === 2);
    expect(item2).toMatchObject({
      product_name: "หมอนทอง", price_per_unit: 119, quantity: 38.1, unit: "โล",
    });
  });

  it("handles weight with trailing dot (38.1.โล → 38.1)", () => {
    const item3 = result.items.find((i) => i.item_number === 3);
    expect(item3?.quantity).toBe(35.7);
  });

  it("handles integer weight with trailing dot (28.โล → 28)", () => {
    const item6 = result.items.find((i) => i.item_number === 6 && i.section === "main");
    expect(item6?.quantity).toBe(28);
    expect(item6?.unit).toBe("โล");
  });

  it("handles ลูก unit without dot (9ลูก)", () => {
    const item11 = result.items.find((i) => i.item_number === 11);
    expect(item11).toMatchObject({ quantity: 9, unit: "ลูก" });
  });

  it("handles ลูก unit with dot (6.ลูก → 6)", () => {
    const item13 = result.items.find((i) => i.item_number === 13);
    expect(item13).toMatchObject({ quantity: 6, unit: "ลูก" });
  });

  it("handles กล่อง unit (13.กล่อง → 13)", () => {
    const item15 = result.items.find((i) => i.item_number === 15);
    expect(item15).toMatchObject({
      product_name: "ทุเรียนกล่อง", price_per_unit: 100, quantity: 13, unit: "กล่อง",
    });
  });

  it("handles two-digit item numbers", () => {
    const item10 = result.items.find((i) => i.item_number === 10);
    expect(item10).toMatchObject({ product_name: "ส้มไต้หวัน", price_per_unit: 40 });
  });

  it("parses รายการเบิกเพิ่ม section items", () => {
    const extra = result.items.filter((i) => i.section === "รายการเบิกเพิ่ม");
    expect(extra).toHaveLength(3);

    expect(extra[0]).toMatchObject({
      item_number: 16, product_name: "มะพร้าว", price_per_unit: 25,
      quantity: 23, unit: "ลูก",
    });
    expect(extra[1]).toMatchObject({
      item_number: 17, product_name: "ฝรั่งขาว", price_per_unit: 45,
      quantity: 18.6, unit: "โล",
    });
    expect(extra[2]).toMatchObject({
      item_number: 18, product_name: "ทุเรียนกล่อง", price_per_unit: 100,
      quantity: 12, unit: "กล่อง",
    });
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe("real message: short withdraw header followed by return section", () => {
  const result = parseWeighSession(`\
13:29 เสือ จิ๋วเบิก 25/5/2569
13:29 เสือ 1.ทุเรียนรวม89บาท

28.8โล
13:29 เสือ 2.ทุเรียนรวม89บาท

38.6โล
13:29 เสือ 3.ทุเรียนรวม100บาท

54.8โล
13:29 เสือ 4.ทุเรียนรวม89บาท

20.1โล
13:29 เสือ จบรายการชั่งเบิก
13:29 เสือ รายการชั่งคืน
13:29 เสือ 1.ทุเรียนรวม100บาท

26.3โล
13:29 เสือ 2.ทุเรียนรวม89บาท

44.7โล
13:30 เสือ จบรายการชั่งคืน`);

  it("extracts session metadata from short header", () => {
    expect(result.staff_name).toBe("เสือ");
    expect(result.session_title).toBe("จิ๋วเบิก 25/5/2569");
    expect(result.date).toBe("2026-05-25");
  });

  it("parses withdraw and return items from the same message", () => {
    expect(result.items).toHaveLength(6);
    expect(result.parse_errors).toHaveLength(0);

    expect(result.items[0]).toMatchObject({
      item_number: 1, product_name: "ทุเรียนรวม", price_per_unit: 89,
      quantity: 28.8, unit: "โล", section: "main",
    });
    expect(result.items[3]).toMatchObject({
      item_number: 4, product_name: "ทุเรียนรวม", price_per_unit: 89,
      quantity: 20.1, unit: "โล", section: "main",
    });
    expect(result.items[4]).toMatchObject({
      item_number: 1, product_name: "ทุเรียนรวม", price_per_unit: 100,
      quantity: 26.3, unit: "โล", section: "รายการชั่งคืน",
    });
    expect(result.items[5]).toMatchObject({
      item_number: 2, product_name: "ทุเรียนรวม", price_per_unit: 89,
      quantity: 44.7, unit: "โล", section: "รายการชั่งคืน",
    });
  });
});

const PRODUCTION_ITEM_14_EXCERPT = `\
กี้-วัดทุ่งลานนา เบิก 29/6/2569
13อินตผารัม100บาท
3.9.โล
14น้อยหน่า50บาท
6.โล
15กระท้อน20บาท
14.8.โล
จบรายการเบิก`;

/** Minimal seed RPC stub — persist now seeds central prices after item writes. */
function seedRpcStub() {
  return {
    async rpc(fn: string, args: Record<string, unknown>) {
      if (fn !== "seed_central_selling_price") {
        return { data: null, error: { message: `unexpected rpc: ${fn}` } };
      }
      return {
        data: {
          product_key: args.p_product_key,
          unit_key: args.p_unit_key,
          business_date: args.p_business_date,
          price_satang: args.p_price_satang,
          set_by: args.p_actor,
          set_reason: args.p_reason ?? null,
          created_at: "2026-06-29T00:00:00Z",
          updated_at: "2026-06-29T00:00:00Z",
        },
        error: null,
      };
    },
  };
}

async function parseAndPersistItems(text: string, eventSuffix: string) {
  const event: LineMessageEvent = {
    type: "message",
    webhookEventId: `event-${eventSuffix}`,
    deliveryContext: { isRedelivery: false },
    timestamp: Date.UTC(2026, 5, 29, 5, 0, 0),
    source: { type: "user", userId: "user-1" },
    mode: "active",
    replyToken: "reply-token",
    message: {
      id: `message-${eventSuffix}`,
      type: "text",
      quoteToken: "quote-token",
      text,
    },
  };
  const result = await new WeighSessionParser().parse(event);
  const parsed = result.data as unknown as ReturnType<typeof parseWeighSession>;
  const itemInserts: Array<Record<string, unknown>> = [];
  const database = {
    from(table: string) {
      return {
        insert(payload: Record<string, unknown>) {
          if (table === "produce_items") itemInserts.push(payload);
          if (table === "produce_sessions") {
            return {
              select() {
                return {
                  async single() {
                    return { data: { id: `session-${eventSuffix}` }, error: null };
                  },
                };
              },
            };
          }
          return Promise.resolve({ error: null });
        },
      };
    },
    ...seedRpcStub(),
  };

  await result.persist(database as never, `raw-message-${eventSuffix}`);
  return { parsed, itemInserts };
}

describe("edge cases", () => {
  it("parses and persists production item 14 น้อยหน่า between items 13 and 15", async () => {
    const result = parseWeighSession(PRODUCTION_ITEM_14_EXCERPT);

    expect(result.parse_errors).toHaveLength(0);
    expect(result.items).toHaveLength(3);
    expect(result.items.map((item) => item.item_number)).toEqual([13, 14, 15]);
    expect(result.items[1]).toMatchObject({
      item_number: 14,
      product_name: "น้อยหน่า",
      price_per_unit: 50,
      quantity: 6,
      unit: "โล",
    });
    expect(() => assertWeighSessionFinalizable(result)).not.toThrow();
    expect(
      result.items.reduce(
        (total, item) => total + item.price_per_unit * (item.quantity ?? 0),
        0,
      ),
    ).toBe(986);

    const event: LineMessageEvent = {
      type: "message",
      webhookEventId: "event-production-item-14",
      deliveryContext: { isRedelivery: false },
      timestamp: Date.UTC(2026, 5, 29, 5, 0, 0),
      source: { type: "user", userId: "user-1" },
      mode: "active",
      replyToken: "reply-token",
      message: {
        id: "message-production-item-14",
        type: "text",
        quoteToken: "quote-token",
        text: PRODUCTION_ITEM_14_EXCERPT,
      },
    };
    const parserResult = await new WeighSessionParser().parse(event);
    const inserts: Array<{ table: string; payload: Record<string, unknown> }> = [];
    const database = {
      from(table: string) {
        return {
          insert(payload: Record<string, unknown>) {
            inserts.push({ table, payload });
            if (table === "produce_sessions") {
              return {
                select() {
                  return {
                    async single() {
                      return { data: { id: "session-1" }, error: null };
                    },
                  };
                },
              };
            }
            return Promise.resolve({ error: null });
          },
        };
      },
      ...seedRpcStub(),
    };

    await parserResult.persist(database as never, "raw-message-1");
    expect(
      inserts.find(
        ({ table, payload }) =>
          table === "produce_items" && payload.item_number === 14,
      )?.payload,
    ).toMatchObject({
      product_name: "น้อยหน่า",
      price_per_unit: 50,
      quantity: 6,
      unit: "โล",
    });
  });

  it("blocks persistence when an item or quantity line is unparseable", async () => {
    const event: LineMessageEvent = {
      type: "message",
      webhookEventId: "event-malformed-item",
      deliveryContext: { isRedelivery: false },
      timestamp: Date.UTC(2026, 5, 29, 5, 0, 0),
      source: { type: "user", userId: "user-1" },
      mode: "active",
      replyToken: "reply-token",
      message: {
        id: "message-malformed-item",
        type: "text",
        quoteToken: "quote-token",
        text: [
          "กี้-วัดทุ่งลานนา เบิก 29/6/2569",
          "13อินตผารัม100บาท",
          "3.9.โล",
          "14น้อยหน่า50บาท",
          "จำนวนหกโล",
          "15กระท้อน20บาท",
          "14.8.โล",
          "จบรายการเบิก",
        ].join("\n"),
      },
    };

    const result = await new WeighSessionParser().parse(event);
    const parsed = result.data as unknown as ReturnType<typeof parseWeighSession>;
    let databaseCalls = 0;
    const noWriteDatabase = {
      from() {
        databaseCalls += 1;
        throw new Error("database must not be called");
      },
    };

    expect(parsed.parse_errors).toContain(
      'unrecognized line: "จำนวนหกโล"',
    );
    expect(() => assertWeighSessionFinalizable(parsed)).toThrow(
      /weigh session validation failed/,
    );
    expect(buildWeighSessionValidationReply(parsed)).toContain("จึงยังไม่บันทึก");
    expect(buildWeighSessionValidationReply(parsed)).toContain("จำนวนหกโล");
    await expect(
      result.persist(noWriteDatabase as never, "raw-message-1"),
    ).rejects.toThrow(/weigh session validation failed/);
    expect(databaseCalls).toBe(0);
  });

  it("keeps legacy quantities 1ถุง, 3แพค, and 6.โล finalizable and persistable", async () => {
    const text = [
      "กี้-วัดทุ่งลานนา เบิก 29/6/2569",
      "1มะม่วง10บาท",
      "1ถุง",
      "2ส้ม20บาท",
      "3แพค",
      "3น้อยหน่า50บาท",
      "6.โล",
      "จบรายการเบิก",
    ].join("\n");
    const parsed = parseWeighSession(text);

    expect(parsed.parse_errors).toHaveLength(0);
    expect(parsed.items).toHaveLength(3);
    expect(parsed.items).toEqual([
      expect.objectContaining({ item_number: 1, quantity: 1, unit: "ถุง" }),
      expect.objectContaining({ item_number: 2, quantity: 3, unit: "แพค" }),
      expect.objectContaining({ item_number: 3, quantity: 6, unit: "โล" }),
    ]);
    expect(() => assertWeighSessionFinalizable(parsed)).not.toThrow();

    const event: LineMessageEvent = {
      type: "message",
      webhookEventId: "event-valid-legacy-quantities",
      deliveryContext: { isRedelivery: false },
      timestamp: Date.UTC(2026, 5, 29, 5, 0, 0),
      source: { type: "user", userId: "user-1" },
      mode: "active",
      replyToken: "reply-token",
      message: {
        id: "message-valid-legacy-quantities",
        type: "text",
        quoteToken: "quote-token",
        text,
      },
    };
    const result = await new WeighSessionParser().parse(event);
    const itemInserts: Array<Record<string, unknown>> = [];
    const database = {
      from(table: string) {
        return {
          insert(payload: Record<string, unknown>) {
            if (table === "produce_items") itemInserts.push(payload);
            if (table === "produce_sessions") {
              return {
                select() {
                  return {
                    async single() {
                      return { data: { id: "session-legacy-units" }, error: null };
                    },
                  };
                },
              };
            }
            return Promise.resolve({ error: null });
          },
        };
      },
      ...seedRpcStub(),
    };

    await result.persist(database as never, "raw-message-legacy-units");
    expect(itemInserts.map(({ quantity, unit }) => ({ quantity, unit }))).toEqual([
      { quantity: 1, unit: "ถุง" },
      { quantity: 3, unit: "แพค" },
      { quantity: 6, unit: "โล" },
    ]);
  });

  it.each([
    ["0.8.ขีด", 0.08, "โล",  100, 8],
    ["0.2ขีด",  0.02, "โล",  100, 2],
    ["1ชิ้น",    1,    "ชิ้น",   100, 100],
    ["1.ชิ้น",   1,    "ชิ้น",   100, 100],
    ["1.2.โล",   1.2,  "โล",     100, 120],
  ])(
    "parses quantity %s with a total-preserving price basis",
    (quantityLine, expectedQuantity, expectedUnit, expectedPrice, expectedTotal) => {
      const parsed = parseWeighSession([
        "กี้-วัดทุ่งลานนา เบิก 29/6/2569",
        "1ดอกแค100บาท",
        quantityLine,
        "จบรายการเบิก",
      ].join("\n"));

      expect(parsed.parse_errors).toEqual([]);
      expect(parsed.items).toHaveLength(1);
      expect(parsed.items[0]).toMatchObject({
        quantity: expectedQuantity,
        unit: expectedUnit,
        price_per_unit: expectedPrice,
      });
      expect(
        parsed.items[0].price_per_unit * (parsed.items[0].quantity ?? 0),
      ).toBeCloseTo(expectedTotal, 10);
    },
  );

  // Behavior change from the old whitelist-only parser (see units.ts):
  // a genuinely unknown unit is no longer rejected — it persists as text,
  // with no invented conversion, rather than blocking the whole session.
  it("accepts a genuinely unknown unit as text with no invented conversion", async () => {
    const { parsed, itemInserts } = await parseAndPersistItems(
      [
        "กี้-วัดทุ่งลานนา เบิก 29/6/2569",
        "1น้อยหน่า50บาท",
        "0.3ปอนด์",
        "จบรายการเบิก",
      ].join("\n"),
      "unknown-unit-pound",
    );
    const item = parsed.items[0];

    expect(parsed.parse_errors).toHaveLength(0);
    expect(item).toMatchObject({
      product_name:   "น้อยหน่า",
      quantity:       0.3,
      unit:           "ปอนด์",
      price_per_unit: 50, // unchanged — no conversion invented for an unknown unit
    });
    expect(() => assertWeighSessionFinalizable(parsed)).not.toThrow();
    expect(itemInserts[0]).toMatchObject({ quantity: 0.3, unit: "ปอนด์" });
  });

  it("parses and persists exact production ฝรั่ง line with a period before บาท", async () => {
    const itemLine = "4ฝรั่ง35.บาท";
    const { parsed, itemInserts } = await parseAndPersistItems(
      [
        "กี้-วัดทุ่งลานนา เบิก 29/6/2569",
        itemLine,
        "6.7.โล",
        "จบรายการเบิก",
      ].join("\n"),
      "production-farang-period-before-baht",
    );
    const item = parsed.items[0];

    expect(parsed.parse_errors).toHaveLength(0);
    expect(parsed.parse_errors.join("\n")).not.toContain(itemLine);
    expect(item).toMatchObject({
      product_name: "ฝรั่ง",
      price_per_unit: 35,
      quantity: 6.7,
      unit: "โล",
    });
    expect(item.price_per_unit * (item.quantity ?? 0)).toBeCloseTo(234.5, 2);
    expect(() => assertWeighSessionFinalizable(parsed)).not.toThrow();
    expect(itemInserts[0]).toMatchObject({
      product_name: "ฝรั่ง",
      price_per_unit: 35,
      quantity: 6.7,
      unit: "โล",
    });
  });

  it("parses and persists exact production กระท้อน line with a period after บาท", async () => {
    const itemLine = "13กระท้อน25บาท.";
    const { parsed, itemInserts } = await parseAndPersistItems(
      [
        "กี้-วัดทุ่งลานนา เบิก 29/6/2569",
        itemLine,
        "18.4.โล",
        "จบรายการเบิก",
      ].join("\n"),
      "production-krathon-period-after-baht",
    );
    const item = parsed.items[0];

    expect(parsed.parse_errors).toHaveLength(0);
    expect(parsed.parse_errors.join("\n")).not.toContain(itemLine);
    expect(item).toMatchObject({
      product_name: "กระท้อน",
      price_per_unit: 25,
      quantity: 18.4,
      unit: "โล",
    });
    expect(item.price_per_unit * (item.quantity ?? 0)).toBeCloseTo(460, 2);
    expect(() => assertWeighSessionFinalizable(parsed)).not.toThrow();
    expect(itemInserts[0]).toMatchObject({
      product_name: "กระท้อน",
      price_per_unit: 25,
      quantity: 18.4,
      unit: "โล",
    });
  });

  it("normalizes typo pack unit in exact raw มะเขือลาย input", () => {
    const result = parseWeighSession(`\
22มะเขือลาย20บาท

9.แพต`);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      product_name: "มะเขือลาย",
      quantity: 9,
      unit: "แพค",
      price_per_unit: 20,
    });
    expect((result.items[0].price_per_unit ?? 0) * (result.items[0].quantity ?? 0)).toBe(180);
  });

  it("replaces an earlier zero-quantity row when the same product and price is later sent with a valid pack quantity", () => {
    const result = parseWeighSession(`\
18:53 เสือ รายการชั่งเบิก
22.มะเขือลาย20บาท
0แพค
22มะเขือลาย20บาท
9.แพค
18:53 เสือ จบรายการเบิก`);

    const items = result.items.filter((item) => item.product_name === "มะเขือลาย");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      item_number: 22,
      product_name: "มะเขือลาย",
      price_per_unit: 20,
      quantity: 9,
      unit: "แพค",
    });
    expect((items[0].price_per_unit ?? 0) * (items[0].quantity ?? 0)).toBe(180);
  });

  it("keeps only one row when a typo pack unit is later corrected for the same item", () => {
    const result = parseWeighSession(`\
22มะเขือลาย20บาท

9.แพต

22มะเขือลาย20บาท

9.แพค`);

    const items = result.items.filter((item) => item.product_name === "มะเขือลาย");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      product_name: "มะเขือลาย",
      quantity: 9,
      unit: "แพค",
      price_per_unit: 20,
    });
    expect((items[0].price_per_unit ?? 0) * (items[0].quantity ?? 0)).toBe(180);
    expect(items.some((item) => item.quantity === 0)).toBe(false);
    expect(result.items).toHaveLength(1);
  });

  it("keeps valid duplicate product rows with different quantities", () => {
    const result = parseWeighSession(`\
พริกหยวก20บาท
8.แพค

พริกหยวก20บาท
6.แพค`);

    const items = result.items.filter((item) => item.product_name === "พริกหยวก");
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ quantity: 8, unit: "แพค", price_per_unit: 20 });
    expect(items[1]).toMatchObject({ quantity: 6, unit: "แพค", price_per_unit: 20 });
  });

  it("parses exact raw มะเขือลาย input as one valid pack row with no zero duplicate", () => {
    const result = parseWeighSession(`\
รายการชั่งเบิก
22มะเขือลาย20บาท

9.แพค`);

    const items = result.items.filter((item) => item.product_name === "มะเขือลาย");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      product_name: "มะเขือลาย",
      quantity: 9,
      unit: "แพค",
      price_per_unit: 20,
    });
    expect((items[0].price_per_unit ?? 0) * (items[0].quantity ?? 0)).toBe(180);
    expect(items.some((item) => item.quantity === 0)).toBe(false);
    expect(result.items).toHaveLength(1);
  });

  it("saves item with null quantity when weight line is missing", () => {
    const result = parseWeighSession(`\
18:53 เสือ รายการชั่งคืน
18:53 เสือ 1.หมอนทอง119บาท
18:53 เสือ 2.กระดุม100บาท

25โล
18:53 เสือ จบรายการชั่งคืน`);

    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({ item_number: 1, quantity: null, unit: null });
    expect(result.items[1]).toMatchObject({ item_number: 2, quantity: 25, unit: "โล" });
  });

  it("records error for orphan quantity (weight with no preceding item)", () => {
    const result = parseWeighSession(`\
18:53 เสือ รายการชั่งคืน
38โล
18:53 เสือ จบรายการชั่งคืน`);

    expect(result.parse_errors).toHaveLength(1);
    expect(result.parse_errors[0]).toMatch(/quantity with no preceding item/);
  });

  it("ignores non-session messages before SESSION_START", () => {
    const result = parseWeighSession(`\
18:50 เสือ ดีครับ
18:51 เสือ รายการชั่งคืน
18:51 เสือ 1.หมอนทอง119บาท

20โล
18:51 เสือ จบรายการชั่งคืน`);

    expect(result.items).toHaveLength(1);
    expect(result.session_title).toBe("รายการชั่งคืน");
  });

  it("handles missing session-end marker", () => {
    const result = parseWeighSession(`\
18:53 เสือ รายการชั่งคืน
18:53 เสือ 1.หมอนทอง119บาท

38โล`);

    // Pending item saved on EOF
    expect(result.items).toHaveLength(1);
    expect(result.items[0].quantity).toBe(38);
  });

  it("parses full Buddhist year date (4 digits)", () => {
    const result = parseWeighSession(`\
18:53 เสือ รายการชั่งคืน
18/5/2568
18:53 เสือ 1.หมอนทอง119บาท

10โล
18:53 เสือ จบรายการชั่งคืน`);

    expect(result.date).toBe("2025-05-18");
  });

  it("uses fallback date when message text has time but no date", () => {
    const result = parseWeighSession("12:47 เสือ รายการชั่งคืน", "2026-05-29");
    expect(result.date).toBe("2026-05-29");
  });
});

// ── Real sample: พี่ดำ-เฉลิมฯ72 with แพค unit ────────────────────────────────

describe("real sample: พี่ดำ-เฉลิมฯ72 ทุเรียน with แพค unit (4 items)", () => {
  const SAMPLE = `\
พี่ดำ-เฉลิมฯ72ทุเรียน เบิก 30/5/2569

1หมอนทอง119บาท

23.4.โล

2ก้านยาว109บาท

8.6.โล

3ชะนี100บาท

15.5.โล

5ทุเนียนกล่อง80บาท

20.แพค

จบรายการเบิก`;

  const result = parseWeighSession(SAMPLE);

  it("parses 4 items", () => {
    expect(result.items).toHaveLength(4);
  });

  it("parses no errors", () => {
    expect(result.parse_errors).toHaveLength(0);
  });

  it("extracts staff name and date", () => {
    expect(result.staff_name).toBe("พี่ดำ");
    expect(result.date).toBe("2026-05-30");
  });

  it("parses item 1 — หมอนทอง 23.4 โล", () => {
    expect(result.items[0]).toMatchObject({
      item_number: 1, product_name: "หมอนทอง", price_per_unit: 119,
      quantity: 23.4, unit: "โล",
    });
  });

  it("parses item 2 — ก้านยาว 8.6 โล", () => {
    expect(result.items[1]).toMatchObject({
      item_number: 2, product_name: "ก้านยาว", price_per_unit: 109,
      quantity: 8.6, unit: "โล",
    });
  });

  it("parses item 3 — ชะนี 15.5 โล", () => {
    expect(result.items[2]).toMatchObject({
      item_number: 3, product_name: "ชะนี", price_per_unit: 100,
      quantity: 15.5, unit: "โล",
    });
  });

  it("parses item 5 — ทุเนียนกล่อง 20 แพค (skipped number 4 is ok)", () => {
    expect(result.items[3]).toMatchObject({
      item_number: 5, product_name: "ทุเนียนกล่อง", price_per_unit: 80,
      quantity: 20, unit: "แพค",
    });
  });

  it("total borrow = 119×23.4 + 109×8.6 + 100×15.5 + 80×20 = 6,872", () => {
    const borrow = result.items
      .filter((i) => i.transaction_type === "เบิก" || i.transaction_type === "เบิกเพิ่ม")
      .reduce((sum, i) => sum + (i.price_per_unit ?? 0) * (i.quantity ?? 0), 0);
    expect(borrow).toBeCloseTo(6872, 1);
  });
});

// ── bangkokTimeFromTimestamp ──────────────────────────────────────────────────

describe("bangkokTimeFromTimestamp", () => {
  it("converts ms timestamp to Bangkok HH:mm", () => {
    // 2026-05-31T11:34:00Z = 18:34 Bangkok (UTC+7)
    const ts = Date.UTC(2026, 4, 31, 11, 34, 0);
    expect(bangkokTimeFromTimestamp(ts)).toBe("18:34");
  });

  it("pads single-digit minute", () => {
    // 2026-05-31T04:05:00Z = 11:05 Bangkok
    const ts = Date.UTC(2026, 4, 31, 4, 5, 0);
    expect(bangkokTimeFromTimestamp(ts)).toBe("11:05");
  });

  it("returns null for undefined", () => {
    expect(bangkokTimeFromTimestamp(undefined)).toBeNull();
  });

  it("returns null for NaN", () => {
    expect(bangkokTimeFromTimestamp(NaN)).toBeNull();
  });
});

// ── transaction_time fallback logic ──────────────────────────────────────────

describe("transaction_time fallback", () => {
  it("uses time from message prefix when present — ignores fallbackTime", () => {
    const result = parseWeighSession("18:34 เสือ รายการชั่งคืน", null, "12:00");
    expect(result.transaction_time).toBe("18:34");
  });

  it("uses fallbackTime when message has no time prefix", () => {
    const result = parseWeighSession(
      "เสือ-ตลาด72 เบิก\n1.หมอนทอง119บาท\n38โล\nจบรายการเบิก",
      null,
      "18:34",
    );
    expect(result.transaction_time).toBe("18:34");
  });

  it("returns null when no prefix and no fallbackTime", () => {
    const result = parseWeighSession("เสือ-ตลาด72 เบิก\n1.หมอนทอง119บาท\n38โล\nจบรายการเบิก");
    expect(result.transaction_time).toBeNull();
  });

  it("pending session simulation: normalized accumulated text uses fallbackTime", () => {
    // normalizeText strips "HH:MM sender " prefixes, so parser sees no TIME_PREFIX.
    // finalizeAccumulated passes created_at-derived time as fallbackTime.
    const accumulated = [
      "เสือ-ตลาด72 เบิก 31/5/2569",
      "1.หมอนทอง119บาท",
      "38โล",
      "จบรายการเบิก",
    ].join("\n");
    const result = parseWeighSession(accumulated, "2026-05-31", "18:34");
    expect(result.transaction_time).toBe("18:34");
    expect(result.date).toBe("2026-05-31");
    expect(result.items).toHaveLength(1);
  });

  it("pending session raw accumulated text preserves LINE sender from prefix", () => {
    const accumulated = [
      "09:50 กี่ วัดทุ่งลานนา เบิก 30/5/2569",
      "09:50 กี่ 1.กระท้อน8.1บาท",
      "1โล",
      "09:50 กี่ จบรายการเบิก",
    ].join("\n");

    const result = parseWeighSession(accumulated, "2026-05-30", "09:50");
    expect(result.sender_name).toBe("กี่");
    expect(result.staff_name).toBe("กี่");
    expect(result.transaction_time).toBe("09:50");
  });
});

// ── Regex unit tests ──────────────────────────────────────────────────────────

describe("WeighSessionParser timestamp fallback", () => {
  it("uses LINE event.timestamp when text has no time prefix", async () => {
    const event: LineMessageEvent = {
      type: "message",
      webhookEventId: "event-1",
      deliveryContext: { isRedelivery: false },
      timestamp: Date.UTC(2026, 4, 31, 11, 34, 0),
      source: { type: "user", userId: "user-1" },
      mode: "active",
      replyToken: "reply-token",
      message: {
        id: "message-1",
        type: "text",
        quoteToken: "quote-token",
        text: [
          "เสือ-ตลาด72 เบิก",
          "1.หมอนทอง119บาท",
          "38โล",
          "จบรายการเบิก",
        ].join("\n"),
      },
    };

    const result = await new WeighSessionParser().parse(event);
    expect(result.data.transaction_time).toBe("18:34");
  });

  it("uses previous business date before 04:00 Bangkok when text has no date", async () => {
    const event: LineMessageEvent = {
      type: "message",
      webhookEventId: "event-before-cutoff",
      deliveryContext: { isRedelivery: false },
      timestamp: Date.UTC(2026, 5, 1, 19, 30, 0), // 2026-06-02 02:30 Bangkok
      source: { type: "user", userId: "user-1" },
      mode: "active",
      replyToken: "reply-token",
      message: {
        id: "message-before-cutoff",
        type: "text",
        quoteToken: "quote-token",
        text: [
          "กี้-ตลาด72 เบิก",
          "1.หมอนทอง119บาท",
          "10โล",
          "จบรายการเบิก",
        ].join("\n"),
      },
    };

    const result = await new WeighSessionParser().parse(event);
    expect(result.data.date).toBe("2026-06-01");
    expect(result.data.transaction_time).toBe("02:30");
  });
});

describe("RE.QUANTITY", () => {
  const cases: [string, number, string][] = [
    ["38โล",      38,   "โล"],
    ["18.5โล",    18.5, "โล"],
    ["38.1.โล",   38.1, "โล"],
    ["28.โล",     28,   "โล"],
    ["9ลูก",      9,    "ลูก"],
    ["23.ลูก",    23,   "ลูก"],
    ["6.ลูก",     6,    "ลูก"],
    ["13.กล่อง",  13,   "กล่อง"],
    ["12.กล่อง",  12,   "กล่อง"],
    ["20.แพค",    20,   "แพค"],
    ["9.แพค",      9,   "แพค"],
    ["5แพค",       5,   "แพค"],
    ["9 แพค",      9,   "แพค"],
    ["9.แพต",      9,   "แพต"],
    ["9แพต",       9,   "แพต"],
    ["9 แพต",      9,   "แพต"],
    ["9.แพ็ด",     9,   "แพ็ด"],
    ["9เเพค",      9,   "เเพค"],
    ["9แผค",       9,   "แผค"],
    ["1แพ็ค",      1,    "แพ็ค"],
    ["1แพ็ก",      1,    "แพ็ก"],
    ["1เเพ็ค",     1,    "เเพ็ค"],
    ["8 แพ็ต",     8,    "แพ็ต"],
    ["16 pack",    16,   "pack"],
    ["0.8.ขีด",    0.8,  "ขีด"],
    ["0.2ขีด",     0.2,  "ขีด"],
    ["1ชิ้น",      1,    "ชิ้น"],
    ["1.ชิ้น",     1,    "ชิ้น"],
    ["3กำ",        3,    "กำ"],
    ["2มัด",       2,    "มัด"],
    ["5ถุง",        5,    "ถุง"],
    ["16หัว",      16,    "หัว"],
  ];

  cases.forEach(([input, expectedAmt, expectedUnit]) => {
    it(`parses "${input}"`, () => {
      const m = input.match(RE.QUANTITY);
      expect(m).not.toBeNull();
      expect(parseFloat(m![1])).toBe(expectedAmt);
      expect(m![2]).toBe(expectedUnit);
    });
  });

  it("does not match non-quantity lines", () => {
    expect("1.หมอนทอง119บาท".match(RE.QUANTITY)).toBeNull();
    expect("รายการชั่งคืน".match(RE.QUANTITY)).toBeNull();
  });
});

describe("real sample: คืนเสีย with แพ็ค spelling", () => {
  const result = parseWeighSession(`\
20:57 เสือ กี้-วัดทุ่งลานนา คืนเสีย 1/6/2569
20:58 เสือ 1.หมอนทอง119บาท
2.4โล
20:58 เสือ 2.องุ่นแดง100บาท
1โล
20:58 เสือ 3.แก้วมังกร40บาท
1.8โล
20:58 เสือ 4.แอปเปิ้ล5บาท
1ลูก
20:58 เสือ 5.ส้มไต้หวัน45บาท
0.6โล
20:58 เสือ 6.สาลี่หอม40บาท
1.2โล
20:58 เสือ 7.ทุเรียนลูกค้าเคลม160บาท
1แพ็ค
20:58 เสือ จบรายการคืนเสีย`);

  it("parses all items as bad returns", () => {
    expect(result.items).toHaveLength(7);
    expect(result.items.every((item) => item.transaction_type === "คืนเสีย")).toBe(true);
    expect(result.items[6]).toMatchObject({
      item_number: 7,
      product_name: "ทุเรียนลูกค้าเคลม",
      price_per_unit: 160,
      quantity: 1,
      unit: "แพค",
    });
  });
});

describe("real sample: return session with หัว unit", () => {
  const result = parseWeighSession(`\
00:47 เสือ ป้าลี-พาซิโอ้ผัก คืน 2/6/2569
00:48 เสือ 1.มะละกอ20บาท
11ลูก
00:50 เสือ 9.บ็อคเคอรี่40บาท
16หัว
00:50 เสือ 10.กระหล่ำปลีนอก30บาท
14แพ็ค
00:51 เสือ 11.ดอกกวางตุ้ง10บาท
36กำ
01:02 เสือ จบรายการคืน`);

  it("keeps every item as คืน after บ็อคเคอรี่16หัว", () => {
    expect(result.items).toHaveLength(4);
    expect(result.parse_errors).toHaveLength(0);
    expect(result.items.every((item) => item.transaction_type === "คืน")).toBe(true);
    expect(result.items[1]).toMatchObject({
      item_number: 9,
      product_name: "บ็อคเคอรี่",
      price_per_unit: 40,
      quantity: 16,
      unit: "หัว",
    });
    expect(result.items[2]).toMatchObject({
      item_number: 10,
      product_name: "กระหล่ำปลีนอก",
      transaction_type: "คืน",
    });
  });
});

describe("real sample: พาซิโอ้ผัก borrow session with ถุง unit", () => {
  const result = parseWeighSession(`\
20:44 เสือ ต้อม-พาซิโอ้ผัก เบิก 3/6/2569
20:45 เสือ 30ผักกาดดอง30บาท
6.ถุง
20:45 เสือ 31หน่อไม้ต้มเหลือง30บาท

4.ถุง
20:45 เสือ 44ข้าวคั่ว20บาท

2.ถุง
20:45 เสือ จบรายการเบิก`);

  it("parses the session metadata and all bag items", () => {
    expect(result.staff_name).toBe("ต้อม");
    expect(result.session_title).toBe("พาซิโอ้ผัก");
    expect(result.date).toBe("2026-06-03");
    expect(result.parse_errors).toHaveLength(0);
    expect(result.items).toHaveLength(3);
    expect(result.items.every((item) => item.transaction_type === "เบิก")).toBe(true);
    expect(result.items.map((item) => item.unit)).toEqual(["ถุง", "ถุง", "ถุง"]);
    expect(result.items[0]).toMatchObject({
      item_number: 30,
      product_name: "ผักกาดดอง",
      price_per_unit: 30,
      quantity: 6,
    });
  });

  it("totals the borrow items to 340", () => {
    const total = result.items.reduce(
      (sum, item) => sum + (item.price_per_unit ?? 0) * (item.quantity ?? 0),
      0,
    );
    expect(total).toBe(340);
  });
});

describe("seller-market header with Latin market suffix", () => {
  const result = parseWeighSession(`\
ดำ-ทดสอบบอทUAT เบิก 31/12/2569
1.มังคุด45บาท
6โล
2.หอมแดง20บาท
12แพค
3.มะนาว20บาท
8แพค
4.กระเทียมหัว30บาท
5แพค
จบรายการเบิก`);

  it("keeps seller and mixed Thai-Latin market metadata while parsing all items", () => {
    expect(result.staff_name).toBe("ดำ");
    expect(result.session_title).toBe("ทดสอบบอทUAT");
    expect(result.date).toBe("2026-12-31");
    expect(result.parse_errors).toEqual([]);
    expect(result.items).toHaveLength(4);
    expect(getWeighSessionFinalizationErrors(result)).toEqual([]);
  });

  it("never claims item parsing failed when a DB-level validation fallback sees a complete parse", () => {
    const reply = buildWeighSessionValidationReply(result);
    expect(reply).toContain("อ่านรายการสินค้าได้ครบ");
    expect(reply).toContain("อ่านสินค้าได้ 4 รายการ");
    expect(reply).not.toContain("อ่านไม่สำเร็จ 0 รายการ");
    expect(reply).not.toContain("อ่านรายการไม่ครบ จึงยังไม่บันทึก");
  });
});

describe("production regression: seller-market header with ชั่งคืน", () => {
  const result = parseWeighSession(`\
ต้อม-พาซิโอ้ผัก ชั่งคืน 30/06/2569
1ผักชีไทย10บาท
28กำ
จบรายการชั่งคืน`);

  it("preserves seller, market, and return metadata", () => {
    expect(result.staff_name).toBe("ต้อม");
    expect(result.session_title).toBe("พาซิโอ้ผัก");
    expect(result.date).toBe("2026-06-30");
    expect(result.parse_errors).toHaveLength(0);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      item_number: 1,
      product_name: "ผักชีไทย",
      price_per_unit: 10,
      quantity: 28,
      unit: "กำ",
      transaction_type: "คืน",
    });
  });
});

describe("main-session closer compatibility", () => {
  const parse = (type: string, closer: string) => parseWeighSession([
    `ดำ-วัดตะกล่ำ ${type} 20/08/2569`,
    "1.มังคุด45บาท",
    "2โล",
    closer,
  ].join("\n"));

  it.each([
    ["เบิก", "จบรายการเบิก"],
    ["ชั่งคืน", "จบรายการชั่งคืน"],
    ["คืนเสีย", "จบรายการคืนเสีย"],
    ["เบิก", "จบรายการชั่งเบิก"],
    ["ชั่งคืน", "จบรายการคืน"],
    ["เบิก", "จบรายการ"],
    ["ชั่งคืน", "จบรายการ 1 รายการ"],
  ])("accepts %s with the supported closer %s", (type, closer) => {
    expect(parse(type, closer).parse_errors).toEqual([]);
  });

  it.each([
    ["เบิก", "จบรายการชั่งคืน"],
    ["ชั่งคืน", "จบรายการเบิก"],
    ["ชั่งคืน", "จบรายการคืนเสีย"],
    ["คืนเสีย", "จบรายการเบิก"],
    ["คืนเสีย", "จบรายการชั่งคืน"],
  ])("rejects %s with the cross-type closer %s", (type, closer) => {
    expect(parse(type, closer).parse_errors.some((error) =>
      error.includes("wrong closer for main session"),
    )).toBe(true);
  });

  it("rejects an unsupported จบรายการ suffix", () => {
    expect(parse("ชั่งคืน", "จบรายการอะไรก็ได้").parse_errors.some((error) =>
      error.includes("wrong closer for main session"),
    )).toBe(true);
  });
});

describe("RE.ITEM", () => {
  it("matches item with dot separator", () => {
    const m = "1.หมอนทอง119บาท".match(RE.ITEM);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("1");
    expect(m![2].trim()).toBe("หมอนทอง");
    expect(m![3]).toBe("119");
  });

  it("matches item without dot separator", () => {
    const m = "2หมอนทอง119บาท".match(RE.ITEM);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("2");
    expect(m![2].trim()).toBe("หมอนทอง");
    expect(m![3]).toBe("119");
  });

  it("matches two-digit item number", () => {
    const m = "10ส้มไต้หวัน40บาท".match(RE.ITEM);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("10");
    expect(m![2].trim()).toBe("ส้มไต้หวัน");
  });

  it("matches product name containing กล่อง", () => {
    const m = "15ทุเรียนกล่อง100บาท".match(RE.ITEM);
    expect(m).not.toBeNull();
    expect(m![2].trim()).toBe("ทุเรียนกล่อง");
    expect(m![3]).toBe("100");
  });

  it("does not match weight lines", () => {
    expect("38โล".match(RE.ITEM)).toBeNull();
    expect("13.กล่อง".match(RE.ITEM)).toBeNull();
  });
});

describe("RE.DATE_ONLY", () => {
  it("matches short Buddhist year", () => {
    const m = "25/5/69".match(RE.DATE_ONLY);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("25");
    expect(m![2]).toBe("5");
    expect(m![3]).toBe("69");
  });

  it("matches full Buddhist year", () => {
    const m = "18/5/2568".match(RE.DATE_ONLY);
    expect(m).not.toBeNull();
    expect(m![3]).toBe("2568");
  });

  it("does not match item lines", () => {
    expect("1.หมอนทอง119บาท".match(RE.DATE_ONLY)).toBeNull();
  });
});

// ── Universal units + generic price-basis support ──────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

describe("30/9 return input resilience", () => {
  it("normalizes pack typos and parses compact bundle shorthand", () => {
    const parsed = parseWeighSession([
      "พี่ดำ-พาซีโอ้ผัก ชั่งคืน 30/9/2569",
      "1กระเทียมหัว30บาท",
      "8 แพ็ต",
      "2ฝรั่ง30บาท",
      "16 pack",
      "3ผักกาดสลัด3/20",
      "15 หัว",
      "4กวางตุ้งญี่ปุ่น4/20",
      "11 หัว",
      "จบรายการชั่งคืน",
    ].join("\n"));

    expect(parsed.parse_errors).toEqual([]);
    expect(parsed.items).toHaveLength(4);
    expect(parsed.items[0]).toMatchObject({ quantity: 8, unit: "แพค" });
    expect(parsed.items[1]).toMatchObject({ quantity: 16, unit: "แพค" });
    expect(parsed.items[2]).toMatchObject({
      product_name: "ผักกาดสลัด",
      quantity: 15,
      unit: "หัว",
      pricing_mode: "basis",
      basis_quantity: 3,
      basis_unit: "หัว",
      basis_price: 20,
    });
    expect(parsed.items[3]).toMatchObject({
      product_name: "กวางตุ้งญี่ปุ่น",
      quantity: 11,
      unit: "หัว",
      pricing_mode: "basis",
      basis_quantity: 4,
      basis_unit: "หัว",
      basis_price: 20,
    });
  });
});

describe("real-world session: mixed plain, basis, and conversion lines", () => {
  const SESSION = [
    "กี้-วัดทุ่งลานนา เบิก 29/6/2569",
    "56ปลาทูเคม20บาท",
    "4ตัว",
    "85ผักกาดขาว3หัว20บาท",
    "32.หัว",
    "102.ฝักกระเจียบ20บาท",
    "26.แพค",
    "52ถั่วพู20บาท",
    "9.แพต",
    "26ดอกผักปัง100บาท",
    "0.5.ขีด",
    "จบรายการเบิก",
  ].join("\n");

  it("parses all 5 items with zero errors", async () => {
    const { parsed, itemInserts } = await parseAndPersistItems(SESSION, "real-world-mixed-session");

    expect(parsed.parse_errors).toHaveLength(0);
    expect(parsed.items).toHaveLength(5);
    expect(parsed.items.map((i) => i.item_number)).toEqual([56, 85, 102, 52, 26]);

    // "ตัว" is accepted with no fixed whitelist and no invented conversion.
    expect(parsed.items[0]).toMatchObject({
      product_name: "ปลาทูเคม", quantity: 4, unit: "ตัว",
      price_per_unit: 20, pricing_mode: "unit", basis_quantity: null,
    });

    // The flagship basis case: 85ผักกาดขาว3หัว20บาท / 32.หัว
    expect(parsed.items[1]).toMatchObject({
      item_number: 85, product_name: "ผักกาดขาว",
      quantity: 32, unit: "หัว",
      pricing_mode: "basis", basis_quantity: 3, basis_unit: "หัว", basis_price: 20,
    });
    expect(round2((parsed.items[1].quantity ?? 0) * parsed.items[1].basis_price! / parsed.items[1].basis_quantity!))
      .toBe(213.33);

    // Product name starting with the unit word ฝัก must not be misread as a basis line.
    expect(parsed.items[2]).toMatchObject({
      item_number: 102, product_name: "ฝักกระเจียบ",
      quantity: 26, unit: "แพค", price_per_unit: 20, pricing_mode: "unit",
    });

    // "แพต" typo alias normalizes to "แพค".
    expect(parsed.items[3]).toMatchObject({
      item_number: 52, product_name: "ถั่วพู", quantity: 9, unit: "แพค", price_per_unit: 20,
    });

    // Product name starting with the unit word ดอก, plus a ขีด→โล conversion
    // on the quantity line — only the measurement converts, price_per_unit
    // stays the header price.
    expect(parsed.items[4]).toMatchObject({
      item_number: 26, product_name: "ดอกผักปัง", quantity: 0.05, unit: "โล", price_per_unit: 100,
    });
    expect(parsed.items[4].price_per_unit * (parsed.items[4].quantity ?? 0)).toBe(5);

    expect(() => assertWeighSessionFinalizable(parsed)).not.toThrow();
    expect(itemInserts.find((i) => i.item_number === 85)).toMatchObject({
      basis_quantity: 3, basis_unit: "หัว", basis_price: 20,
    });
  });
});

describe("exact basis cases", () => {
  it.each([
    ["1เงาะ2โล50บาท",       "10โล",  2,  "โล",   50,  25,     250],
    ["1มะม่วง3โล100บาท",    "9โล",   3,  "โล",   100, 33.33,  300],
    ["1สับปะรด4โล25บาท",    "8โล",   4,  "โล",   25,  6.25,   50],
    ["1มะพร้าว5ลูก100บาท",  "15ลูก", 5,  "ลูก",  100, 20,     300],
    ["1กระท้อน3แพค50บาท",   "6แพค",  3,  "แพค",  50,  16.67,  100],
  ] as const)(
    "%s / %s → basis %d %s / %d บาท",
    (headerLine, quantityLine, basisQty, basisUnit, basisPrice, expectedPricePerUnit, expectedTotal) => {
      const parsed = parseWeighSession([
        "กี้-วัดทุ่งลานนา เบิก 29/6/2569",
        headerLine,
        quantityLine,
        "จบรายการเบิก",
      ].join("\n"));

      expect(parsed.parse_errors).toHaveLength(0);
      expect(parsed.items).toHaveLength(1);
      const item = parsed.items[0];
      expect(item).toMatchObject({
        pricing_mode:   "basis",
        basis_quantity: basisQty,
        basis_unit:     basisUnit,
        basis_price:    basisPrice,
        price_per_unit: expectedPricePerUnit,
      });
      expect(round2((item.quantity ?? 0) * item.basis_price! / item.basis_quantity!)).toBe(expectedTotal);
    },
  );
});

describe("unit aliases and generic unknown units", () => {
  it("matches basis and quantity lines written with different spelling aliases of the same unit", () => {
    const parsed = parseWeighSession([
      "กี้-วัดทุ่งลานนา เบิก 29/6/2569",
      "1กระท้อน2แพ็ค50บาท", // basis unit written with the แพ็ค alias spelling
      "6แพค",                // quantity line written with the canonical spelling
      "จบรายการเบิก",
    ].join("\n"));

    expect(parsed.parse_errors).toHaveLength(0);
    expect(parsed.items[0]).toMatchObject({
      unit: "แพค", basis_unit: "แพค", basis_quantity: 2, basis_price: 50,
    });
  });

  it("accepts a wholly unrecognized unit as long as basis and quantity agree on it", () => {
    const parsed = parseWeighSession([
      "กี้-วัดทุ่งลานนา เบิก 29/6/2569",
      "1ทุเรียนพันธุ์ใหม่2ผล50บาท", // "ผล" is not in any alias/canonical/conversion table
      "6ผล",
      "จบรายการเบิก",
    ].join("\n"));

    expect(parsed.parse_errors).toHaveLength(0);
    expect(parsed.items[0]).toMatchObject({
      unit: "ผล", basis_unit: "ผล", basis_quantity: 2, basis_price: 50, quantity: 6,
    });
  });
});

describe("known unit conversions in a basis context", () => {
  it("converts a ขีด basis to canonical โล", () => {
    const parsed = parseWeighSession([
      "กี้-วัดทุ่งลานนา เบิก 29/6/2569",
      "1เงาะ30ขีด100บาท",
      "15.4โล",
      "จบรายการเบิก",
    ].join("\n"));
    const item = parsed.items[0];

    expect(parsed.parse_errors).toHaveLength(0);
    expect(item).toMatchObject({ basis_quantity: 3, basis_unit: "โล", unit: "โล" });
    expect(round2((item.quantity ?? 0) * item.basis_price! / item.basis_quantity!)).toBe(513.33);
  });

  it("converts a กรัม basis to canonical โล", () => {
    const parsed = parseWeighSession([
      "กี้-วัดทุ่งลานนา เบิก 29/6/2569",
      "1เงาะ300กรัม100บาท",
      "1.5โล",
      "จบรายการเบิก",
    ].join("\n"));
    const item = parsed.items[0];

    expect(parsed.parse_errors).toHaveLength(0);
    expect(item).toMatchObject({ basis_quantity: 0.3, basis_unit: "โล", unit: "โล" });
    expect(round2((item.quantity ?? 0) * item.basis_price! / item.basis_quantity!)).toBe(500);
  });
});

describe("unknown-unit basis/quantity mismatch fails closed", () => {
  it("rejects a basis in an unrecognized unit that disagrees with the quantity line's unit", () => {
    const parsed = parseWeighSession([
      "กี้-วัดทุ่งลานนา เบิก 29/6/2569",
      "1เงาะ2ตัน50บาท", // ตัน (ton) is not a known unit and does not equal โล
      "15.4โล",
      "จบรายการเบิก",
    ].join("\n"));

    expect(parsed.parse_errors.some((e) => e.includes("basis unit mismatch"))).toBe(true);
    expect(() => assertWeighSessionFinalizable(parsed)).toThrow(/weigh session validation failed/);
  });
});

describe("no rounding drift for basis totals", () => {
  it("the true total differs from (rounded price_per_unit × quantity) for a 3-unit basis", () => {
    const parsed = parseWeighSession([
      "กี้-วัดทุ่งลานนา เบิก 29/6/2569",
      "85ผักกาดขาว3หัว20บาท",
      "32.หัว",
      "จบรายการเบิก",
    ].join("\n"));
    const item = parsed.items[0];

    const trueTotal    = round2((item.quantity ?? 0) * item.basis_price! / item.basis_quantity!);
    const driftedTotal = round2(item.price_per_unit * (item.quantity ?? 0));

    expect(trueTotal).toBe(213.33);
    expect(driftedTotal).not.toBe(trueTotal); // 6.67 × 32 = 213.44 — drift from pre-rounding
  });
});

describe("standalone orphan basis line", () => {
  it("does not create a phantom item and records an explicit error", () => {
    const parsed = parseWeighSession([
      "กี้-วัดทุ่งลานนา เบิก 29/6/2569",
      "3โล100บาท",
      "จบรายการเบิก",
    ].join("\n"));

    expect(parsed.items).toHaveLength(0);
    expect(parsed.parse_errors.some((e) => e.includes("orphan basis line"))).toBe(true);
    expect(() => assertWeighSessionFinalizable(parsed)).toThrow(/weigh session validation failed/);
  });

  it.each(["2โล50บาท", "4โล25บาท", "5ลูก100บาท", "3แพค50บาท"])(
    "also rejects bare %s with no product name",
    (line) => {
      const parsed = parseWeighSession([
        "กี้-วัดทุ่งลานนา เบิก 29/6/2569",
        line,
        "จบรายการเบิก",
      ].join("\n"));

      expect(parsed.items).toHaveLength(0);
      expect(parsed.parse_errors.some((e) => e.includes("orphan basis line"))).toBe(true);
    },
  );
});

describe("malformed multi-dot quantities remain fail-closed", () => {
  it.each([".41.1.โล", "36..1.โล"])("rejects %s as an unrecognized line", (badQuantityLine) => {
    const parsed = parseWeighSession([
      "กี้-วัดทุ่งลานนา เบิก 29/6/2569",
      "1เงาะ50บาท",
      badQuantityLine,
      "จบรายการเบิก",
    ].join("\n"));

    expect(parsed.parse_errors.some((e) => e.includes(badQuantityLine))).toBe(true);
    expect(() => assertWeighSessionFinalizable(parsed)).toThrow(/weigh session validation failed/);
  });
});

describe("RE.ITEM_WITH_BASIS", () => {
  it("matches item + product + basis triple", () => {
    const m = "85ผักกาดขาว3หัว20บาท".match(RE.ITEM_WITH_BASIS);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("85");
    expect(m![2]).toBe("ผักกาดขาว");
    expect(m![3]).toBe("3");
    expect(m![4]).toBe("หัว");
    expect(m![5]).toBe("20");
  });

  it("does not match a plain single-price item line", () => {
    expect("102.ฝักกระเจียบ20บาท".match(RE.ITEM_WITH_BASIS)).toBeNull();
  });

  it("does not match a bare quantity line", () => {
    expect("38โล".match(RE.ITEM_WITH_BASIS)).toBeNull();
  });
});

// ── Regression: canonical header price survives a subunit quantity conversion ──
//
// applyQuantity() used to divide price_per_unit by the ขีด/กรัม conversion
// factor after converting the measurement, on the theory that price_per_unit
// was quoted per the raw (sub)unit. It never was: an item header quotes its
// price per the CANONICAL selling unit, so only the measurement should be
// rescaled. See commit 87b1f98 for the fix and the real production message
// that exposed it (below).
describe("canonical header price survives a subunit quantity conversion (regression)", () => {
  it('pins the real production withdrawal "2องุ่นคิมสัน120บาท" / "0.7.ขีด" at 0.070 โล × 120 = 8.40, not × 1200 = 84', async () => {
    const { parsed, itemInserts } = await parseAndPersistItems(
      [
        "กี้-วัดทุ่งลานนา เบิก 29/6/2569",
        "2องุ่นคิมสัน120บาท",
        "0.7.ขีด",
        "จบรายการเบิก",
      ].join("\n"),
      "production-grape-subunit-price-fix",
    );
    const item = parsed.items[0];

    expect(parsed.parse_errors).toHaveLength(0);
    expect(item).toMatchObject({
      product_name: "องุ่นคิมสัน",
      quantity: 0.07,
      unit: "โล",
      price_per_unit: 120,
    });
    // 0.07 * 120 is 8.400000000000002 in IEEE754 (0.07 has no exact binary
    // representation) — toBeCloseTo absorbs that float noise instead of a
    // brittle exact-equality assertion.
    expect(item.price_per_unit * (item.quantity ?? 0)).toBeCloseTo(8.4, 10);
    expect(() => assertWeighSessionFinalizable(parsed)).not.toThrow();
    expect(itemInserts[0]).toMatchObject({
      product_name: "องุ่นคิมสัน",
      quantity: 0.07,
      unit: "โล",
      price_per_unit: 120,
    });
  });

  // The pre-fix price is kept on the parsed item as evidence, so a resend of a
  // message imported before the fix still matches its own reservation (see
  // legacySubunitPricedSession in session-dedup-service.ts). It is transient:
  // it must never reach the produce_items row, where it would be a second,
  // contradictory price.
  it("keeps the retired price as lookup evidence only, never in the persisted row", async () => {
    const { parsed, itemInserts } = await parseAndPersistItems(
      [
        "กี้-วัดทุ่งลานนา เบิก 29/6/2569",
        "2องุ่นคิมสัน120บาท",
        "0.7.ขีด",
        "จบรายการเบิก",
      ].join("\n"),
      "production-grape-legacy-price-evidence",
    );

    expect(parsed.items[0].legacy_subunit_price_per_unit).toBe(1200);
    expect(Object.keys(itemInserts[0])).not.toContain("legacy_subunit_price_per_unit");
    expect(itemInserts[0].price_per_unit).toBe(120);
  });

  it.each([
    // [header, quantityLine, expectedQuantity, expectedUnit, expectedPrice, expectedMoney]
    ["สินค้า100บาท", "1ขีด",   0.1, "โล", 100, 10],
    ["สินค้า120บาท", "10ขีด",  1.0, "โล", 120, 120], // subunit quantity reaching a whole-kilo boundary
    ["สินค้า120บาท", "0.5โล",  0.5, "โล", 120, 60],  // canonical โล input — completely unchanged by the fix
  ])(
    "%s / %s → quantity %s %s, price_per_unit %s, money %s",
    (header, quantityLine, expectedQuantity, expectedUnit, expectedPrice, expectedMoney) => {
      const parsed = parseWeighSession([
        "กี้-วัดทุ่งลานนา เบิก 29/6/2569",
        `1${header}`,
        quantityLine,
        "จบรายการเบิก",
      ].join("\n"));

      expect(parsed.parse_errors).toEqual([]);
      expect(parsed.items).toHaveLength(1);
      expect(parsed.items[0]).toMatchObject({
        quantity: expectedQuantity,
        unit: expectedUnit,
        price_per_unit: expectedPrice,
      });
      expect(
        parsed.items[0].price_per_unit * (parsed.items[0].quantity ?? 0),
      ).toBeCloseTo(expectedMoney, 10);
    },
  );

  // Punctuation variants of the same 0.7ขีด quantity line — verified against
  // RE.QUANTITY directly (see the "RE.QUANTITY" describe block above and the
  // regex comment in regex.ts: the dot before the unit is optional, and any
  // amount of whitespace is allowed). All three genuinely parse and must
  // produce identical results.
  it.each(["0.7ขีด", "0.7.ขีด", "0.7 ขีด"])(
    "treats punctuation variant %s identically: 0.07 โล at price 120",
    (quantityLine) => {
      const parsed = parseWeighSession([
        "กี้-วัดทุ่งลานนา เบิก 29/6/2569",
        "1สินค้า120บาท",
        quantityLine,
        "จบรายการเบิก",
      ].join("\n"));

      expect(parsed.parse_errors).toEqual([]);
      expect(parsed.items[0]).toMatchObject({
        quantity: 0.07,
        unit: "โล",
        price_per_unit: 120,
      });
      expect(
        parsed.items[0].price_per_unit * (parsed.items[0].quantity ?? 0),
      ).toBeCloseTo(8.4, 10);
    },
  );

  // กรัม runs the same applyQuantity code path as ขีด (factor 0.001 instead
  // of 0.1) but has ZERO production usage to date — verified read-only
  // against produce_items: 0 raw messages contain a standalone กรัม quantity
  // line, and the 43 rows containing กิโลกรัม are the factor-1 alias to โล
  // (see UNIT_ALIASES in units.ts), not a กรัม conversion. This test pins
  // the structural contract (same conversion path as ขีด) rather than an
  // observed production shape.
  it("converts กรัม the same way as ขีด: สินค้า120บาท / 500กรัม → 0.5 โล, price 120, money 60", () => {
    const parsed = parseWeighSession([
      "กี้-วัดทุ่งลานนา เบิก 29/6/2569",
      "1สินค้า120บาท",
      "500กรัม",
      "จบรายการเบิก",
    ].join("\n"));

    expect(parsed.parse_errors).toEqual([]);
    expect(parsed.items[0]).toMatchObject({
      quantity: 0.5,
      unit: "โล",
      price_per_unit: 120,
    });
    expect(
      parsed.items[0].price_per_unit * (parsed.items[0].quantity ?? 0),
    ).toBeCloseTo(60, 10);
  });

  // Basis-priced entries (pricing_mode "basis") derive price_per_unit from
  // basis_price/basis_quantity in parseItemLine's ITEM_WITH_BASIS branch —
  // a wholly separate code path from applyQuantity's subunit conversion.
  // This proves the fix did not reach into that branch: a following
  // quantity line only converts the measurement, never price_per_unit.
  it('leaves an explicit basis-priced entry unchanged: "1เงาะ30ขีด100บาท" keeps price_per_unit 33.33 regardless of the quantity line', () => {
    const parsed = parseWeighSession([
      "กี้-วัดทุ่งลานนา เบิก 29/6/2569",
      "1เงาะ30ขีด100บาท",
      "15.4โล",
      "จบรายการเบิก",
    ].join("\n"));
    const item = parsed.items[0];

    expect(parsed.parse_errors).toHaveLength(0);
    expect(item).toMatchObject({
      pricing_mode:   "basis",
      basis_quantity: 3,
      basis_unit:     "โล",
      basis_price:    100,
      price_per_unit: 33.33, // 100 / 3, rounded — unaffected by applyQuantity
      quantity:       15.4,
      unit:           "โล",
    });
  });
});
