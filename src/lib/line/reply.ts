import { logger } from "@/lib/logger";
import { formatThaiDate } from "@/lib/date";
import type { WeighSession, WeighSessionItem } from "@/lib/parsers/weigh-session/types";
import { ADDITIONAL_TYPE_LABEL } from "@/lib/parsers/weigh-session/parser";
import { produceCategoryTotals, resolveProduceCategory } from "@/lib/summary/produce-category-totals";
import { LINE_MESSAGE_MAX_CODE_POINTS, countCodePoints } from "@/lib/summary/line-chunking";
import { exactLineTotalScaled, scaledToBaht } from "@/lib/produce/exact-line-total";
import type { TransactionBucket } from "@/lib/summary/transactions";

export function measureLineText(text: string): { codePoints: number; utf8Bytes: number } {
  return {
    codePoints: [...text].length,
    utf8Bytes: new TextEncoder().encode(text).length,
  };
}

function logLineTextMetrics(
  operation: "reply" | "push",
  texts: string[],
): Array<{ index: number; codePoints: number; utf8Bytes: number }> {
  return texts.map((text, index) => ({ index, ...measureLineText(text) }));
}

/** Outbound LINE Messaging API message objects (text / flex / template / …). */
export type LineApiMessage = Record<string, unknown> & { type: string };

async function postLineReply(
  replyToken: string,
  messages: LineApiMessage[],
  textMetrics?: string[],
): Promise<void> {
  logger.info("LINE reply sending", {
    operation: "reply",
    messageCount: messages.length,
    messageTypes: messages.map((m) => m.type),
    ...(textMetrics
      ? { messages: logLineTextMetrics("reply", textMetrics) }
      : {}),
  });

  let res: Response;
  try {
    res = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ replyToken, messages }),
    });
  } catch {
    logger.error("LINE API request failed", {
      operation: "reply",
      category: "network_error",
      messageCount: messages.length,
      ...(textMetrics
        ? { messages: logLineTextMetrics("reply", textMetrics) }
        : {}),
    });
    throw new Error("LINE reply network error");
  }

  if (!res.ok) {
    const responseBody = await res.text();
    logger.error("LINE API request failed", {
      operation: "reply",
      status: res.status,
      category: lineHttpErrorCategory(res.status),
      responseBody,
      messageCount: messages.length,
      ...(textMetrics
        ? { messages: logLineTextMetrics("reply", textMetrics) }
        : {}),
    });
    throw new Error(`LINE reply HTTP ${res.status}`);
  }
}

export async function replyLineMessages(replyToken: string, texts: string[]): Promise<void> {
  const messages = texts.map((text) => ({ type: "text" as const, text }));
  await postLineReply(replyToken, messages, texts);
}

export async function replyLineMessage(replyToken: string, text: string): Promise<void> {
  await replyLineMessages(replyToken, [text]);
}

/**
 * Reply with typed LINE API message objects (Flex / template / text).
 * Webhook Guided Menu uses this exclusively — never push.
 */
export async function replyLineApiMessages(
  replyToken: string,
  messages: LineApiMessage[],
): Promise<void> {
  if (messages.length < 1 || messages.length > 5) {
    throw new Error(`LINE reply allows 1–5 messages, got ${messages.length}`);
  }
  await postLineReply(replyToken, messages);
}

export type PushResult = { status: "delivered" | "already_accepted" };

export class LinePushError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number | null,
    public readonly retryable: boolean,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "LinePushError";
  }
}

export function parseRetryAfterMs(
  value: string | null,
  nowMs = Date.now(),
): number | null {
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }

  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return null;
  return Math.max(0, retryAt - nowMs);
}

// LINE Messaging API supports X-Line-Retry-Key for push idempotency.
// Passing the same UUID on a retry causes LINE to return 409 without
// re-delivering if the original request was already processed — safe for
// both definite rejections (message was never sent) and ambiguous failures
// (network error where delivery status is unknown).
//
// Returns:
//   { status: "delivered" }       — HTTP 2xx, message delivered now
//   { status: "already_accepted" } — HTTP 409 + retryKey, idempotent re-send
// Throws on any other non-2xx status or network error.
export async function pushLineMessage(to: string, text: string, retryKey?: string): Promise<PushResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  };
  if (retryKey) headers["X-Line-Retry-Key"] = retryKey;

  let res: Response;
  try {
    res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers,
      body: JSON.stringify({
        to,
        messages: [{ type: "text", text }],
      }),
    });
  } catch {
    logger.error("LINE API request failed", {
      operation: "push",
      category: "network_error",
    });
    throw new LinePushError("LINE push network error", null, true);
  }

  if (res.ok) {
    return { status: "delivered" };
  }

  // 409 with a retry key: LINE already accepted a previous request with the
  // same key — idempotent delivery, treat as success.
  // 409 without a retry key is an unrelated conflict — fail normally.
  if (res.status === 409 && retryKey) {
    logger.warn("LINE push 409 — already accepted (retry key match)", {
      operation: "push",
      retryKey,
    });
    return { status: "already_accepted" };
  }

  const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
  const retryable = res.status === 429 || res.status >= 500;
  logger.error("LINE API request failed", {
    operation: "push",
    status: res.status,
    category: lineHttpErrorCategory(res.status),
    retryAfterMs,
  });
  throw new LinePushError(
    `LINE push HTTP ${res.status}`,
    res.status,
    retryable,
    retryAfterMs,
  );
}

function lineHttpErrorCategory(status: number): string {
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "server_error";
  if (status >= 400) return "client_error";
  return "http_error";
}

function fmt(n: number): string {
  return n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Basis rows (e.g. "3โล100บาท") total round(qty * basis_price / basis_quantity, 2),
// never (qty * price_per_unit) — price_per_unit is only a rounded display
// approximation for those rows and multiplying it back out reintroduces
// the rounding error.
export function weighItemTotal(item: WeighSessionItem): number {
  return scaledToBaht(weighItemTotalScaled(item));
}

/**
 * The same line total, kept at the exact 1e5 scale so callers can AGGREGATE
 * before rounding. This is what keeps LINE in step with PostgreSQL: the
 * database does not round a unit row, so summing rounded unit rows would drift
 * from it whenever their sub-satang parts carry.
 */
export function weighItemTotalScaled(item: WeighSessionItem): bigint {
  return exactLineTotalScaled({
    quantity: item.quantity,
    pricePerUnit: item.price_per_unit,
    basisQuantity: item.basis_quantity,
    basisPrice: item.basis_price,
  }) ?? BigInt(0);
}

/**
 * A whole session's total, aggregated exactly and rounded once.
 *
 * Use this — never `items.reduce((s, i) => s + weighItemTotal(i), 0)` — anywhere
 * the result is compared against a SUM taken from produce_transactions. The
 * database does not round a unit row, so summing rounded rows drifts from it as
 * soon as any row carries a sub-satang part (3.5 โล × 8.29 บาท = 29.015 is
 * ordinary data, not an edge case).
 */
export function weighSessionTotal(items: readonly WeighSessionItem[]): number {
  return scaledToBaht(items.reduce(
    (acc, item) => acc + weighItemTotalScaled(item),
    BigInt(0),
  ));
}

export function buildWeighSessionSummary(session: WeighSession): string {
  type Item = typeof session.items[number];

  const borrowItems: Item[]    = [];
  const returnItems: Item[]    = [];
  const badReturnItems: Item[] = [];

  for (const item of session.items) {
    if (item.transaction_type === "เบิก" || item.transaction_type === "เบิกเพิ่ม") {
      borrowItems.push(item);
    } else if (item.transaction_type === "คืน") {
      returnItems.push(item);
    } else if (item.transaction_type === "คืนเสีย") {
      badReturnItems.push(item);
    }
  }

  const lineTotal = weighItemTotal;

  // Aggregate at the exact scale, round once at the end. Summing the rounded
  // per-row baht values would diverge from produce_transactions, which sums
  // unrounded unit rows.
  const sumItems = (items: Item[]) =>
    scaledToBaht(items.reduce((acc, it) => acc + weighItemTotalScaled(it), BigInt(0)));

  const borrowTotal    = sumItems(borrowItems);
  const returnTotal    = sumItems(returnItems);
  const badReturnTotal = sumItems(badReturnItems);

  const itemLine = (item: Item): string => {
    const qty   = item.quantity ?? 0;
    const unit  = item.unit ? ` ${item.unit}` : "";
    const total = lineTotal(item);

    // Basis rows show the real basis instead of a "qty × price_per_unit"
    // equation that wouldn't multiply out correctly:
    //   32 หัว × 20 บาท / 3 หัว = 213.33
    if (item.basis_quantity && item.basis_price != null) {
      const basisUnit = item.basis_unit ? ` ${item.basis_unit}` : "";
      return `${item.item_number}. ${item.product_name} ${fmt(qty)}${unit} × ${fmt(item.basis_price)} บาท / ${fmt(item.basis_quantity)}${basisUnit} = ${fmt(total)}`;
    }

    const price = item.price_per_unit ?? 0;
    return `${item.item_number}. ${item.product_name} ${fmt(qty)}${unit} × ${fmt(price)} = ${fmt(total)}`;
  };

  // Category is presentation only, derived at output time from the approved
  // Product Code Dictionary (see product-code/category.ts) — it never changes
  // what the operator typed, never changes an item's own line text or the
  // section subtotal, and never reorders items across a shared category
  // (Array.prototype.sort is stable, so same-category items keep their
  // original relative order and therefore their original numbering).
  /**
   * Category is presentation only, derived at output time from the approved
   * Product Code Dictionary (product-code/category.ts). It never changes what
   * the operator typed and never enters any business identity.
   *
   * Two deliberate properties:
   *
   * Every printed number in a section — each item line, each category subtotal
   * and the section subtotal — comes from ONE integer-satang sum of the same
   * per-item totals. Leaving the section subtotal on the older float reduce
   * let a section print item lines of 0.13 + 0.13 + 0.13, a category subtotal
   * of 0.39, and a section subtotal of 0.38 in the same receipt.
   *
   * An item's category depends only on that item's own name. `knownNames` is
   * deliberately NOT passed: it authorizes normalizeProductName's `เพิ่ม`
   * prefix strip, which would make a literal `เพิ่มหมอนทอง` classify as
   * ทุเรียน or ไม่จัดหมวด depending on whether some OTHER line in the same
   * message happens to be `หมอนทอง`. The day-wide 08:00 report has genuine
   * day-wide context and may resolve such a name further; an instant reply
   * has only this message, so it stays pure rather than guessing from
   * whatever else was typed alongside.
   */
  const buildSection = (
    label: string,
    subtotalLabel: string,
    items: Item[],
    bucket: TransactionBucket,
  ): string[] => {
    if (items.length === 0) return [];

    const breakdown = produceCategoryTotals(items.map((it) => ({
      product_name: it.product_name,
      transaction_type: it.transaction_type,
      total_amount: weighItemTotal(it),
    })));

    const body: string[] = [];
    // Preserve the operator's original item_number across category grouping.
    // The same number is used by validation/correction commands, so
    // renumbering by print order makes the final receipt contradict the draft.
    for (const entry of breakdown[bucket].categories) {
      body.push(entry.heading);
      for (const item of items) {
        // Same pure, single-argument call the totals used — see the coupling
        // note on produceCategoryTotals. Diverging here once made an item
        // count toward a subtotal while printing under no category at all.
        if (resolveProduceCategory(item.product_name) !== entry.id) continue;
        body.push(itemLine(item));
      }
      body.push(`รวม${entry.label} ${fmt(entry.totalSatang / 100)} บาท`);
    }

    return [
      label,
      ...body,
      `${subtotalLabel}: ${fmt(breakdown[bucket].totalSatang / 100)} บาท`,
    ];
  };

  /** The pre-category rendering, kept as the fallback for an oversized message. */
  const buildFlatSection = (
    label: string,
    subtotalLabel: string,
    items: Item[],
    total: number,
  ): string[] =>
    items.length === 0 ? [] : [label, ...items.map(itemLine), `${subtotalLabel}: ${fmt(total)} บาท`];

  const dateLabel = session.date ? formatThaiDate(session.date) : "";
  const lines: string[] = [
    "บันทึกแล้ว ✅",
    "",
    `${session.staff_name}${dateLabel ? ` — ${dateLabel}` : ""}`,
  ];

  const assemble = (sections: string[][]): string => {
    const out = [...lines];
    for (const section of sections.filter((s) => s.length > 0)) out.push("", ...section);
    return out.join("\n");
  };

  const grouped = assemble([
    buildSection("เบิก",    "รวมเบิก", borrowItems,    "เบิก"),
    buildSection("ชั่งคืน", "รวมคืน",  returnItems,    "คืน"),
    buildSection("คืนเสีย", "รวมเสีย", badReturnItems, "คืนเสีย"),
  ]);
  // Grouping adds a heading and a subtotal line per category, and this reply is
  // delivered as ONE unsplit LINE message, so grouping must never be the reason
  // a receipt stops fitting. Past the cap it drops back to the exact pre-feature
  // rendering — readability is the optional part, the receipt is not.
  //
  // This buys back only what grouping costs. A document large enough to overflow
  // the FLAT rendering too (~90+ items) still fails delivery, exactly as it did
  // before this feature; nothing here splits the message. That ceiling is
  // pre-existing and deliberately left alone.
  if (countCodePoints(grouped) <= LINE_MESSAGE_MAX_CODE_POINTS) return grouped;

  return assemble([
    buildFlatSection("เบิก",    "รวมเบิก", borrowItems,    borrowTotal),
    buildFlatSection("ชั่งคืน", "รวมคืน",  returnItems,    returnTotal),
    buildFlatSection("คืนเสีย", "รวมเสีย", badReturnItems, badReturnTotal),
  ]);
}

export interface AdditionalSessionDayContext {
  /** Day total for the same date + staff + market + base transaction type,
   *  INCLUDING this addition. */
  cumulativeTotal:  number;
  /** Whether any main-kind session already exists for the same grouping key. */
  hasMatchingMain:  boolean;
}

// Reply for an append-only additional batch. Deliberately never claims the
// original session was modified — the addition is its own session.
export function buildAdditionalSessionSummary(
  session: WeighSession,
  day: AdditionalSessionDayContext,
): string {
  const label = session.declared_transaction_type
    ? ADDITIONAL_TYPE_LABEL[session.declared_transaction_type]
    : "เพิ่ม";
  // Exact aggregation: this is differenced against a DB-sourced cumulative
  // total below, so it must sum the way produce_transactions does.
  const batchTotal = weighSessionTotal(session.items);

  // Previous day total before this addition; clamp floating-point residue.
  let previousTotal = round2(day.cumulativeTotal - batchTotal);
  if (Math.abs(previousTotal) < 0.005) previousTotal = 0;

  const lines = [
    `บันทึกรายการ${label}แล้ว ✅`,
    "",
    `เพิ่ม ${session.items.length} รายการ`,
    `ยอดเดิมก่อนเพิ่ม: ${fmt(previousTotal)} บาท`,
    `ยอดเพิ่ม: ${fmt(batchTotal)} บาท`,
    `ยอดสะสมของวัน: ${fmt(day.cumulativeTotal)} บาท`,
  ];

  if (!day.hasMatchingMain) {
    lines.push(
      "ยังไม่พบชุดหลักของวันนี้ รายการนี้ถูกบันทึกแยกไว้ และจะรวมยอดตามวันที่ คนขาย และตลาดเดียวกัน",
    );
  }

  return lines.join("\n");
}
