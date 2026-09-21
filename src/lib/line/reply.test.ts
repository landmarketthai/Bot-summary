import { afterEach, describe, it, expect, spyOn } from "bun:test";
import {
  buildAdditionalSessionSummary,
  buildWeighSessionSummary,
  LinePushError,
  measureLineText,
  parseRetryAfterMs,
  pushLineMessage,
  replyLineMessage,
  replyLineMessages,
} from "./reply";
import type { WeighSession } from "@/lib/parsers/weigh-session/types";
import { LINE_MESSAGE_MAX_CODE_POINTS, countCodePoints } from "@/lib/summary/line-chunking";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeSession(overrides: Partial<WeighSession> = {}): WeighSession {
  return {
    date: "2026-06-01",
    staff_name: "กี้",
    sender_name: null,
    transaction_time: null,
    session_title: null,
    session_kind: "main",
    declared_transaction_type: null,
    items: [],
    parse_errors: [],
    ...overrides,
  };
}

const BORROW_ITEM = {
  item_number: 1,
  product_name: "ทุเรียน",
  price_per_unit: 100,
  quantity: 10,
  unit: "โล" as const,
  section: "",
  transaction_type: "เบิก" as const,
  pricing_mode: "unit" as const,
  basis_quantity: null,
  basis_unit: null,
  basis_price: null,
};

const BORROW_EXTRA_ITEM = {
  item_number: 2,
  product_name: "หมอนทอง",
  price_per_unit: 119,
  quantity: 5,
  unit: "โล" as const,
  section: "",
  transaction_type: "เบิกเพิ่ม" as const,
  pricing_mode: "unit" as const,
  basis_quantity: null,
  basis_unit: null,
  basis_price: null,
};

const RETURN_ITEM = {
  item_number: 1,
  product_name: "ชะนี",
  price_per_unit: 100,
  quantity: 8,
  unit: "โล" as const,
  section: "",
  transaction_type: "คืน" as const,
  pricing_mode: "unit" as const,
  basis_quantity: null,
  basis_unit: null,
  basis_price: null,
};

const BAD_RETURN_ITEM = {
  item_number: 1,
  product_name: "กระดุม",
  price_per_unit: 80,
  quantity: 3,
  unit: "โล" as const,
  section: "",
  transaction_type: "คืนเสีย" as const,
  pricing_mode: "unit" as const,
  basis_quantity: null,
  basis_unit: null,
  basis_price: null,
};

const BASIS_ITEM = {
  item_number: 1,
  product_name: "ผักกาดขาว",
  price_per_unit: 6.67, // rounded display approximation, not used for the total below
  quantity: 32,
  unit: "หัว" as const,
  section: "",
  transaction_type: "เบิก" as const,
  pricing_mode: "basis" as const,
  basis_quantity: 3,
  basis_unit: "หัว" as const,
  basis_price: 20,
};

describe("buildWeighSessionSummary — ยอดส่ง must not appear", () => {
  it("session เบิกอย่างเดียว ต้องไม่มีคำว่า ยอดส่ง", () => {
    const result = buildWeighSessionSummary(makeSession({ items: [BORROW_ITEM] }));
    expect(result).not.toContain("ยอดส่ง");
  });

  it("session คืนอย่างเดียว ต้องไม่มีคำว่า ยอดส่ง", () => {
    const result = buildWeighSessionSummary(makeSession({ items: [RETURN_ITEM] }));
    expect(result).not.toContain("ยอดส่ง");
  });

  it("session คืนเสียอย่างเดียว ต้องไม่มีคำว่า ยอดส่ง", () => {
    const result = buildWeighSessionSummary(makeSession({ items: [BAD_RETURN_ITEM] }));
    expect(result).not.toContain("ยอดส่ง");
  });

  it("session หลาย type ต้องไม่มีคำว่า ยอดส่ง", () => {
    const result = buildWeighSessionSummary(makeSession({ items: [BORROW_ITEM, RETURN_ITEM] }));
    expect(result).not.toContain("ยอดส่ง");
  });
});

describe("buildWeighSessionSummary — section subtotals", () => {
  it("session เบิกอย่างเดียว แสดง รวมเบิก", () => {
    const result = buildWeighSessionSummary(makeSession({ items: [BORROW_ITEM] }));
    expect(result).toContain("รวมเบิก:");
    expect(result).toContain("รวมเบิก: 1,000.00 บาท");
    expect(result).not.toContain("รวมคืน:");
    expect(result).not.toContain("รวมเสีย:");
  });

  it("session คืนอย่างเดียว แสดง รวมคืน", () => {
    const result = buildWeighSessionSummary(makeSession({ items: [RETURN_ITEM] }));
    expect(result).toContain("รวมคืน:");
    expect(result).not.toContain("รวมเบิก:");
    expect(result).not.toContain("รวมเสีย:");
  });

  it("session คืนเสียอย่างเดียว แสดง รวมเสีย", () => {
    const result = buildWeighSessionSummary(makeSession({ items: [BAD_RETURN_ITEM] }));
    expect(result).toContain("รวมเสีย:");
    expect(result).not.toContain("รวมเบิก:");
    expect(result).not.toContain("รวมคืน:");
  });

  it("session มี เบิก+คืน แสดงทั้ง รวมเบิก และ รวมคืน แต่ไม่แสดงยอดส่ง", () => {
    const result = buildWeighSessionSummary(makeSession({ items: [BORROW_ITEM, RETURN_ITEM] }));
    expect(result).toContain("รวมเบิก:");
    expect(result).toContain("รวมคืน:");
    expect(result).not.toContain("ยอดส่ง");
  });

  it("เบิกเพิ่ม นับรวมใน section เบิก", () => {
    const result = buildWeighSessionSummary(makeSession({ items: [BORROW_ITEM, BORROW_EXTRA_ITEM] }));
    expect(result).toContain("เบิก");
    expect(result).toContain("รวมเบิก:");
    // both items appear under one เบิก section — numbered 1 and 2
    expect(result).toContain("1. ทุเรียน");
    expect(result).toContain("2. หมอนทอง");
  });
});

describe("buildWeighSessionSummary — category grouping (presentation only)", () => {
  const MUSHROOM_ITEM = {
    item_number: 3,
    product_name: "เห็ดนางฟ้า",
    price_per_unit: 60,
    quantity: 4,
    unit: "โล" as const,
    section: "",
    transaction_type: "เบิก" as const,
    pricing_mode: "unit" as const,
    basis_quantity: null,
    basis_unit: null,
    basis_price: null,
  };

  it("inserts a category heading for a single-category section without changing the subtotal", () => {
    const result = buildWeighSessionSummary(makeSession({ items: [BORROW_ITEM] }));
    expect(result).toContain("🥭 ทุเรียน");
    expect(result).toContain("1. ทุเรียน");
    expect(result).toContain("รวมเบิก: 1,000.00 บาท");
  });

  it("groups a mixed-category section under separate headings, ordered by the dictionary category order, with an unchanged section total", () => {
    // ทุเรียน (ท) and หมอนทอง (ท) are the same category as BORROW_ITEM;
    // เห็ดนางฟ้า is a different category (ห) and must get its own heading.
    const result = buildWeighSessionSummary(makeSession({ items: [MUSHROOM_ITEM, BORROW_ITEM] }));
    const durianHeadingIndex = result.indexOf("🥭 ทุเรียน");
    const mushroomHeadingIndex = result.indexOf("🍄 เห็ด");
    expect(durianHeadingIndex).toBeGreaterThan(-1);
    expect(mushroomHeadingIndex).toBeGreaterThan(-1);
    // ท (ทุเรียน) sorts before ห (เห็ด) in REPORT_CATEGORY_ORDER, so its
    // heading appears first even though the mushroom item was listed first.
    expect(durianHeadingIndex).toBeLessThan(mushroomHeadingIndex);
    // Section subtotal is untouched: 1,000 (ทุเรียน) + 240 (เห็ดนางฟ้า 4 × 60).
    expect(result).toContain("รวมเบิก: 1,240.00 บาท");
  });

  it("keeps same-category items in original relative order and numbering (stable sort)", () => {
    // ทุเรียน then หมอนทอง are both category ท — grouping must not reorder them.
    const result = buildWeighSessionSummary(makeSession({ items: [BORROW_ITEM, BORROW_EXTRA_ITEM] }));
    const durianLineIndex = result.indexOf("1. ทุเรียน");
    const homThongLineIndex = result.indexOf("2. หมอนทอง");
    expect(durianLineIndex).toBeGreaterThan(-1);
    expect(homThongLineIndex).toBeGreaterThan(durianLineIndex);
    // Only one category heading should appear for this all-ท section.
    expect(result.match(/🥭 ทุเรียน/g)?.length).toBe(1);
  });

  it("an unrecognized product still renders under ❓ ไม่จัดหมวด and still counts toward the subtotal", () => {
    const unknownItem = { ...BORROW_ITEM, product_name: "มะม่วงต่างดาว" };
    const result = buildWeighSessionSummary(makeSession({ items: [unknownItem] }));
    expect(result).toContain("❓ ไม่จัดหมวด");
    expect(result).toContain("รวมเบิก: 1,000.00 บาท");
  });

  it("a sub-satang item total cannot print one number in the lines and another in the section total", () => {
    // 0.5 โล × 0.25 บาท = 0.125 per line. Each line rounds to 0.13, so the
    // honest section total of three of them is 0.39. Summing the raw floats
    // instead gives 0.375 → 0.38, and the receipt would contradict itself:
    // three 0.13 lines under a 0.38 total.
    const items = Array.from({ length: 3 }, () => ({
      ...BORROW_ITEM,
      product_name: "หมอนทอง",
      quantity: 0.5,
      price_per_unit: 0.25,
    }));
    const result = buildWeighSessionSummary(makeSession({ items }));
    expect(result).toContain("รวมทุเรียน 0.39 บาท");
    expect(result).toContain("รวมเบิก: 0.39 บาท");
    expect(result).not.toContain("0.38");
  });

  it("an item's category does not depend on which other items share the message", () => {
    // `เพิ่ม` is a real prefix the alias layer can strip, but only when
    // authorized by a set of known names. Authorizing it from the message's
    // own items would make this item's category flip based on a sibling line.
    const prefixed = { ...BORROW_ITEM, product_name: "เพิ่มหมอนทอง" };
    const solo = buildWeighSessionSummary(makeSession({ items: [prefixed] }));
    const withSibling = buildWeighSessionSummary(makeSession({
      items: [prefixed, { ...BORROW_ITEM, item_number: 2, product_name: "หมอนทอง" }],
    }));
    expect(solo).toContain("❓ ไม่จัดหมวด");
    expect(withSibling).toContain("❓ ไม่จัดหมวด");
    expect(withSibling).toContain("🥭 ทุเรียน");
    // And no row may be totalled under one category but printed under none:
    // both items appear, and the two subtotals add up to the section total.
    // ทุเรียน sorts first, so the sibling leads and the prefixed name follows.
    expect(withSibling).toContain("2. หมอนทอง");
    expect(withSibling).toContain("1. เพิ่มหมอนทอง");
    expect(withSibling).toContain("รวมทุเรียน 1,000.00 บาท");
    expect(withSibling).toContain("รวมไม่จัดหมวด 1,000.00 บาท");
    expect(withSibling).toContain("รวมเบิก: 2,000.00 บาท");
  });

  it("falls back to the ungrouped rendering rather than losing an oversized receipt", () => {
    // This reply is delivered as one unsplit LINE message. Grouping must never
    // be the reason an operator gets no confirmation at all.
    const items = Array.from({ length: 400 }, (_, index) => ({
      ...BORROW_ITEM,
      product_name: index % 2 === 0 ? "ทุเรียน" : "เห็ดนางฟ้า",
    }));
    const result = buildWeighSessionSummary(makeSession({ items }));
    // The flat rendering of a document this size is itself over the limit —
    // that is pre-existing and out of scope here. What must hold is that
    // grouping is dropped rather than added on top of an already-large message,
    // and that the receipt still carries its totals.
    expect(result).not.toContain("🥭 ทุเรียน");
    expect(result).not.toContain("รวมทุเรียน");
    expect(result).toContain("รวมเบิก:");
    expect(countCodePoints(result))
      .toBeLessThan(countCodePoints(buildWeighSessionSummary(makeSession({ items: items.slice(0, 40) }))) * 10);
  });

  it("numbers a mixed-category section 1, 2, 3 reading downward", () => {
    // Numbering by the item's original position would print "2." above "1."
    // here, since เห็ด was typed first but sorts after ทุเรียน.
    const result = buildWeighSessionSummary(
      makeSession({ items: [MUSHROOM_ITEM, BORROW_ITEM, BORROW_EXTRA_ITEM] }),
    );
    const numbers = [...result.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    expect(numbers).toEqual([1, 2, 3]);
    // …and the durian pair, typed second and third, is what leads the section.
    expect(result.indexOf("1. ทุเรียน")).toBeLessThan(result.indexOf("3. เห็ดนางฟ้า"));
  });

  it("preserves original item numbers when category grouping changes print order", () => {
    const unknown16 = { ...BORROW_ITEM, item_number: 16, product_name: "ลูกพลุน" };
    const known19 = { ...BORROW_ITEM, item_number: 19, product_name: "ลูกพลับ" };
    const result = buildWeighSessionSummary(makeSession({ items: [unknown16, known19] }));
    expect(result).toContain("19. ลูกพลับ");
    expect(result).toContain("16. ลูกพลุน");
    expect(result.indexOf("19. ลูกพลับ")).toBeLessThan(result.indexOf("16. ลูกพลุน"));
    expect(result).not.toContain("1. ลูกพลับ");
  });

  it("keeps grouping for a document that still fits", () => {
    const items = Array.from({ length: 20 }, (_, index) => ({
      ...BORROW_ITEM,
      product_name: index % 2 === 0 ? "ทุเรียน" : "เห็ดนางฟ้า",
    }));
    const result = buildWeighSessionSummary(makeSession({ items }));
    expect(countCodePoints(result)).toBeLessThanOrEqual(LINE_MESSAGE_MAX_CODE_POINTS);
    expect(result).toContain("🥭 ทุเรียน");
    expect(result).toContain("🍄 เห็ด");
  });

  it("the printed category subtotals add up to the printed section subtotal", () => {
    // The invariant, asserted on the rendered message rather than on the
    // helper: not one satang may appear or disappear because of grouping. A
    // decimal quantity and an uncategorized row are both in the mix, and the
    // uncategorized money must be part of the total, never dropped.
    const items = [
      BORROW_ITEM,                                                    // ท  1,000.00
      MUSHROOM_ITEM,                                                  //  ห    240.00
      { ...BORROW_ITEM, product_name: "แก้วมังกร", quantity: 14.5, price_per_unit: 50 },
      { ...BORROW_ITEM, product_name: "สินค้าไม่มีในพจนานุกรม", quantity: 2.5, price_per_unit: 35 },
    ];
    const result = buildWeighSessionSummary(makeSession({ items }));

    const subtotals = [...result.matchAll(/^รวม(?!เบิก:|คืน:|เสีย:).*?([\d,]+\.\d{2}) บาท$/gm)]
      .map((match) => Math.round(Number(match[1]!.replace(/,/g, "")) * 100));
    const section = /^รวมเบิก: ([\d,]+\.\d{2}) บาท$/m.exec(result)![1]!;

    expect(subtotals).toHaveLength(4);
    expect(subtotals.reduce((a, b) => a + b, 0))
      .toBe(Math.round(Number(section.replace(/,/g, "")) * 100));
    // 14.5 × 50 and 2.5 × 35 are exact to the satang, not merely close.
    expect(result).toContain("รวมผลไม้ 725.00 บาท");
    expect(result).toContain("รวมไม่จัดหมวด 87.50 บาท");
  });
});

describe("buildWeighSessionSummary — price-basis rows", () => {
  it("shows the basis equation instead of an inconsistent qty × price_per_unit line", () => {
    const result = buildWeighSessionSummary(makeSession({ items: [BASIS_ITEM] }));

    // Must never print "32.00 หัว × 6.67" — that arithmetic doesn't multiply out.
    expect(result).not.toContain("× 6.67 ");
    // Must show the real basis and the correctly rounded total (32 × 20 / 3 = 213.33).
    expect(result).toContain("32.00 หัว × 20.00 บาท / 3.00 หัว = 213.33");
    expect(result).toContain("รวมเบิก: 213.33");
  });
});

describe("buildWeighSessionSummary — header", () => {
  it("แสดงชื่อ staff และวันที่ไทย", () => {
    const result = buildWeighSessionSummary(makeSession({ staff_name: "พี่ดำ", date: "2026-06-01" }));
    expect(result).toContain("บันทึกแล้ว ✅");
    expect(result).toContain("พี่ดำ");
    expect(result).toContain("2569"); // Buddhist era
  });

  it("session ที่ไม่มี items ยังแสดง header ได้", () => {
    const result = buildWeighSessionSummary(makeSession({ items: [] }));
    expect(result).toContain("บันทึกแล้ว ✅");
  });
});

describe("pushLineMessage — X-Line-Retry-Key and 409 handling", () => {
  it("transmits X-Line-Retry-Key header when retryKey is provided", async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      capturedHeaders = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      );
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await pushLineMessage("group-id", "hello", "retry-uuid-123");

    expect(capturedHeaders["X-Line-Retry-Key"]).toBe("retry-uuid-123");
  });

  it("does NOT transmit X-Line-Retry-Key when retryKey is omitted", async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      capturedHeaders = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      );
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await pushLineMessage("group-id", "hello");

    expect(capturedHeaders["X-Line-Retry-Key"]).toBeUndefined();
  });

  it("2xx returns { status: 'delivered' }", async () => {
    globalThis.fetch = (async () =>
      new Response("{}", { status: 200 })) as unknown as typeof fetch;

    const result = await pushLineMessage("group-id", "hello", "retry-key");
    expect(result).toEqual({ status: "delivered" });
  });

  it("409 with retry key returns { status: 'already_accepted' } and does not throw", async () => {
    globalThis.fetch = (async () =>
      new Response("{}", { status: 409 })) as unknown as typeof fetch;

    const result = await pushLineMessage("group-id", "hello", "retry-key");
    expect(result).toEqual({ status: "already_accepted" });
  });

  it("409 without retry key throws (not treated as already_accepted)", async () => {
    globalThis.fetch = (async () =>
      new Response("{}", { status: 409 })) as unknown as typeof fetch;

    await expect(pushLineMessage("group-id", "hello")).rejects.toThrow(
      "LINE push HTTP 409",
    );
  });

  it("400 remains a failure", async () => {
    globalThis.fetch = (async () =>
      new Response("{}", { status: 400 })) as unknown as typeof fetch;

    await expect(pushLineMessage("group-id", "hello", "retry-key")).rejects.toThrow(
      "LINE push HTTP 400",
    );
  });

  it("401 remains a failure", async () => {
    globalThis.fetch = (async () =>
      new Response("{}", { status: 401 })) as unknown as typeof fetch;

    await expect(pushLineMessage("group-id", "hello", "retry-key")).rejects.toThrow(
      "LINE push HTTP 401",
    );
  });

  it("500 remains a failure", async () => {
    globalThis.fetch = (async () =>
      new Response("{}", { status: 500 })) as unknown as typeof fetch;

    await expect(pushLineMessage("group-id", "hello", "retry-key")).rejects.toThrow(
      "LINE push HTTP 500",
    );
  });
});

describe("LINE API error logging", () => {
  it("logs reply response body and message metrics without exposing them in thrown errors", async () => {
    const sensitiveBody = '{"message":"sensitive LINE detail"}';
    globalThis.fetch = (async () =>
      new Response(sensitiveBody, { status: 401 })) as unknown as typeof fetch;
    const errorLog = spyOn(console, "error").mockImplementation(() => {});

    await expect(replyLineMessage("reply-token", "message")).rejects.toThrow(
      "LINE reply HTTP 401",
    );

    const logged = errorLog.mock.calls.flat().join(" ");
    expect(logged).toContain("authentication_error");
    expect(logged).toContain("reply");
    expect(logged).toContain("responseBody");
    expect(logged).toContain("messageCount");
    expect(logged).toContain("codePoints");
    expect(logged).toContain("utf8Bytes");
    expect(logged).toContain("sensitive LINE detail");

    let thrown: unknown;
    try {
      await replyLineMessage("reply-token", "message");
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).not.toContain(sensitiveBody);
    errorLog.mockRestore();
  });

  it("replyLineMessages sends multiple text objects and logs each message length", async () => {
    type CapturedReplyBody = { messages: Array<{ type: string; text: string }> };
    let capturedBody: CapturedReplyBody | null = null;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body)) as CapturedReplyBody;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const infoLog = spyOn(console, "log").mockImplementation(() => {});

    await replyLineMessages("reply-token", ["part one", "part two"]);

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.messages).toEqual([
      { type: "text", text: "part one" },
      { type: "text", text: "part two" },
    ]);

    const logged = infoLog.mock.calls.flat().join(" ");
    expect(logged).toContain("messageCount");
    expect(logged).toContain("codePoints");
    infoLog.mockRestore();
  });

  it("measureLineText counts Unicode code points and UTF-8 bytes", () => {
    expect(measureLineText("abc")).toEqual({ codePoints: 3, utf8Bytes: 3 });
    expect(measureLineText("👋")).toEqual({ codePoints: 1, utf8Bytes: 4 });
  });

  it("does not log or throw the LINE push response body", async () => {
    const sensitiveBody = '{"message":"recipient detail"}';
    globalThis.fetch = (async () =>
      new Response(sensitiveBody, { status: 429 })) as unknown as typeof fetch;
    const errorLog = spyOn(console, "error").mockImplementation(() => {});

    await expect(pushLineMessage("group-id", "message")).rejects.toThrow(
      "LINE push HTTP 429",
    );

    const logged = errorLog.mock.calls.flat().join(" ");
    expect(logged).toContain("rate_limit_error");
    expect(logged).toContain("push");
    expect(logged).not.toContain(sensitiveBody);
    expect(logged).not.toContain("recipient detail");
    errorLog.mockRestore();
  });
});

describe("LINE push retry metadata", () => {
  it("classifies 429 and exposes Retry-After without exposing the body", async () => {
    globalThis.fetch = (async () =>
      new Response('{"message":"private detail"}', {
        status: 429,
        headers: { "Retry-After": "7" },
      })) as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await pushLineMessage("group-id", "hello", "retry-key");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(LinePushError);
    expect(thrown).toMatchObject({
      httpStatus: 429,
      retryable: true,
      retryAfterMs: 7_000,
      message: "LINE push HTTP 429",
    });
  });

  it("parses an HTTP-date Retry-After value", () => {
    expect(parseRetryAfterMs(
      "Fri, 03 Jul 2026 00:00:12 GMT",
      Date.parse("2026-07-03T00:00:00.000Z"),
    )).toBe(12_000);
  });
});

describe("buildAdditionalSessionSummary — previous total line", () => {
  // 10 โล × 100 = 1000
  const ADD_ITEM = { ...BORROW_ITEM, transaction_type: "เบิก" as const };

  function additionalSession(
    declared: "เบิก" | "คืน" | "คืนเสีย",
    items = [ADD_ITEM],
  ) {
    return makeSession({
      session_kind: "additional",
      declared_transaction_type: declared,
      items: items.map((item) => ({ ...item, transaction_type: declared })),
    });
  }

  it("shows previous, batch, and cumulative totals in order", () => {
    const result = buildAdditionalSessionSummary(additionalSession("เบิก"), {
      cumulativeTotal: 1055,
      hasMatchingMain: true,
    });

    expect(result).toBe([
      "บันทึกรายการเบิกเพิ่มแล้ว ✅",
      "",
      "เพิ่ม 1 รายการ",
      "ยอดเดิมก่อนเพิ่ม: 55.00 บาท",
      "ยอดเพิ่ม: 1,000.00 บาท",
      "ยอดสะสมของวัน: 1,055.00 บาท",
    ].join("\n"));
  });

  it.each([
    ["เบิก", "เบิกเพิ่ม"],
    ["คืน", "ชั่งคืนเพิ่ม"],
    ["คืนเสีย", "คืนเสียเพิ่ม"],
  ] as const)("labels a %s addition as %s with the same line layout", (declared, label) => {
    const result = buildAdditionalSessionSummary(additionalSession(declared), {
      cumulativeTotal: 1500,
      hasMatchingMain: true,
    });

    expect(result).toContain(`บันทึกรายการ${label}แล้ว ✅\n\nเพิ่ม 1 รายการ`);
    expect(result).toContain("ยอดเดิมก่อนเพิ่ม: 500.00 บาท");
    expect(result).toContain("ยอดเพิ่ม: 1,000.00 บาท");
    expect(result).toContain("ยอดสะสมของวัน: 1,500.00 บาท");
  });

  it("clamps floating-point residue in the previous total to zero", () => {
    // First addition of the day: cumulative == batch total, but computed with
    // a tiny floating-point residue.
    const result = buildAdditionalSessionSummary(additionalSession("คืน"), {
      cumulativeTotal: 1000.0000000000001,
      hasMatchingMain: false,
    });

    expect(result).toContain("ยอดเดิมก่อนเพิ่ม: 0.00 บาท");
    expect(result).not.toContain("-0.00");
    expect(result).toContain("ยังไม่พบชุดหลัก");
  });

  it("formats fractional previous totals to 2 decimals", () => {
    const result = buildAdditionalSessionSummary(additionalSession("คืนเสีย"), {
      cumulativeTotal: 1012.345,
      hasMatchingMain: true,
    });

    expect(result).toContain("ยอดเดิมก่อนเพิ่ม: 12.35 บาท");
    expect(result).toContain("ยอดสะสมของวัน: 1,012.35 บาท");
  });
});
