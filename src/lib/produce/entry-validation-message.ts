/**
 * P4A — operator-facing Thai text for the produce entry validation gate.
 *
 * Exception details are capped to fit LINE. Blocked drafts also show compact,
 * unconfirmed document totals so the operator can check the source document.
 */

import { formatQuantity } from "@/lib/summary/remaining-fruit";
import type { WeighSession } from "@/lib/parsers/weigh-session/types";
import { exactLineTotalScaled, scaledToBaht } from "./exact-line-total";
import {
  countCodePoints,
  LINE_TEXT_MESSAGE_HARD_MAX_CODE_POINTS,
} from "@/lib/summary/line-chunking";
import type {
  ProduceValidationAdvisory,
  ProduceValidationException,
  ProduceValidationReview,
  ProduceValidationResult,
} from "./entry-validation";

/** Beyond this the reply summarizes the remainder instead of listing it. */
const MAX_LISTED_EXCEPTIONS = 10;
const ADVISORY_SEPARATOR = "\n\n";
const PRICE_ADVISORY_SUMMARY_TRUNCATED_NOTICE = "…สรุปรายการถูกย่อเพื่อแสดงคำเตือนราคา";
const GENERIC_SUMMARY_TRUNCATED_NOTICE = "…สรุปรายการถูกย่อเนื่องจากข้อความยาวเกินกำหนด";

function formatPrice(value: number): string {
  return Number.isInteger(value) ? value.toString() : value.toFixed(2);
}

function describe(exception: ProduceValidationException): string[] {
  switch (exception.kind) {
    case "subunit_confirmation":
      return [
        `${exception.productName}`,
        `   กรอก: ${formatQuantity(exception.enteredQuantity)} ${exception.enteredUnit}`,
        `   ระบบแปลงเป็น: ${formatQuantity(exception.canonicalQuantity)} ${exception.canonicalUnit}`,
        `   กรุณาส่ง “ยืนยันข้อ ${exception.itemNumber}” หรือ “แก้ข้อ ${exception.itemNumber}”`,
      ];
    case "unknown_unit":
      return [
        `${exception.productName}`,
        `   หน่วยที่ส่ง: ${exception.unit} — ระบบไม่รู้จักหน่วยนี้`,
        ...(exception.suggestion ? [`   น่าจะเป็น: ${exception.suggestion}`] : []),
      ];
    case "price_not_withdrawn":
      return [
        `${exception.productName} — ${formatQuantity(exception.quantity)} ${exception.unit}`,
        `   ราคาที่ส่ง: ${formatPrice(exception.enteredPrice)} บาท/${exception.unit}`,
        `   ราคาที่พบในรายการเบิก: ${exception.withdrawnPrices.map(formatPrice).join(", ")} บาท/${exception.unit}`,
      ];
  }
}

function numberedBlocks(
  exceptions: ProduceValidationException[],
  maxListed = MAX_LISTED_EXCEPTIONS,
): string[] {
  const listed = exceptions.slice(0, maxListed);
  const lines: string[] = [];
  listed.forEach((exception) => {
    const [head, ...rest] = describe(exception);
    const label = "itemNumber" in exception
      ? `ข้อ ${exception.itemNumber} — ${head}`
      : `• ${head}`;
    lines.push(label, ...rest);
  });
  const hidden = exceptions.length - listed.length;
  if (hidden > 0) lines.push(`และอีก ${hidden} รายการ`);
  return lines;
}

function correctionGuidance(exceptions: ProduceValidationException[]): string[] {
  const itemNumbers = [...new Set(
    exceptions.flatMap((exception) => "itemNumber" in exception ? [exception.itemNumber] : []),
  )].slice(0, MAX_LISTED_EXCEPTIONS);
  if (itemNumbers.length === 1) {
    return [
      `ส่ง “แก้ข้อ ${itemNumbers[0]}”`,
      `แล้วส่งข้อ ${itemNumbers[0]} ที่ถูกต้องใหม่ พร้อมราคาและจำนวน`,
    ];
  }
  // Every remaining blocker names its item, so this is the multi-item case.
  return [
    `แก้ทีละข้อ: ${itemNumbers.map((number) => `“แก้ข้อ ${number}”`).join(", ")}`,
    "หลังแต่ละคำสั่ง ส่งรายการข้อนั้นใหม่พร้อมราคาและจำนวน",
  ];
}

// Only price differences are shown after save. Missing withdrawals, unit
// mismatches and returns above the withdrawal are internal reconciliation
// (data_quality_issues), never operator-facing.
function renderPriceAdvisoryWarning(
  advisories: ProduceValidationAdvisory[],
  listedCount: number,
): string {
  const listed = advisories.slice(0, listedCount);
  const lines = [
    `⚠️ พบ ${advisories.length} รายการที่ราคาแตกต่างจากตอนเบิก`,
    ...listed.map((advisory) =>
      `• ${advisory.productName} — เบิก ${advisory.withdrawnPrices.map(formatPrice).join(", ")} บาท/${advisory.unit} → ชั่งคืน ${formatPrice(advisory.enteredPrice)} บาท/${advisory.unit}`),
  ];
  const hidden = advisories.length - listed.length;
  if (hidden > 0) lines.push(`…และอีก ${hidden} รายการที่ราคาแตกต่าง`);
  lines.push("", "ระบบบันทึกตามราคาที่กรอกไว้แล้ว");
  return lines.join("\n");
}

/** Price differences are visible after save, never framed as a refusal. */
export function buildPriceAdvisoryWarning(
  advisories: ProduceValidationAdvisory[],
): string {
  if (advisories.length === 0) return "";
  return renderPriceAdvisoryWarning(
    advisories,
    Math.min(advisories.length, MAX_LISTED_EXCEPTIONS),
  );
}

function warningWithinBudget(
  advisories: ProduceValidationAdvisory[],
  maxCodePoints: number,
): string {
  for (
    let listed = Math.min(advisories.length, MAX_LISTED_EXCEPTIONS);
    listed >= 0;
    listed -= 1
  ) {
    const warning = renderPriceAdvisoryWarning(advisories, listed);
    if (countCodePoints(warning) <= maxCodePoints) return warning;
  }
  throw new Error("price advisory cannot fit within the LINE text limit");
}

function truncateSummary(
  summary: string,
  maxCodePoints: number,
  notice: string,
): string {
  if (countCodePoints(summary) <= maxCodePoints) return summary;
  const suffix = `\n${notice}`;
  const bodyBudget = maxCodePoints - countCodePoints(suffix);
  const prefix = [...summary].slice(0, Math.max(0, bodyBudget)).join("");
  const lineBoundary = prefix.lastIndexOf("\n");
  const body = (lineBoundary > 0 ? prefix.slice(0, lineBoundary) : prefix).trimEnd();
  return `${body}${suffix}`;
}

/** Build the one durable success notification without crossing LINE's hard limit. */
export function buildPriceAdvisoryNotification(
  summary: string,
  advisories: ProduceValidationAdvisory[],
  maxCodePoints = LINE_TEXT_MESSAGE_HARD_MAX_CODE_POINTS,
): string {
  if (advisories.length === 0) {
    return truncateSummary(summary, maxCodePoints, GENERIC_SUMMARY_TRUNCATED_NOTICE);
  }

  const fullWarning = buildPriceAdvisoryWarning(advisories);
  const full = `${summary}${ADVISORY_SEPARATOR}${fullWarning}`;
  if (countCodePoints(full) <= maxCodePoints) return full;

  const compactWarning = renderPriceAdvisoryWarning(advisories, 0);
  const summaryBudget = maxCodePoints
    - countCodePoints(ADVISORY_SEPARATOR)
    - countCodePoints(compactWarning);
  const safeSummary = truncateSummary(
    summary,
    summaryBudget,
    PRICE_ADVISORY_SUMMARY_TRUNCATED_NOTICE,
  );
  const warningBudget = maxCodePoints
    - countCodePoints(safeSummary)
    - countCodePoints(ADVISORY_SEPARATOR);
  const warning = warningWithinBudget(advisories, warningBudget);
  return `${safeSummary}${ADVISORY_SEPARATOR}${warning}`;
}

function draftValueLines(session: WeighSession): string[] {
  if (!session.items.length) return [];
  const lines = ["ยอดจากรายการที่อ่านได้ — ยังไม่บันทึก/ยังไม่ยืนยัน"];
  for (const [label, types] of [
    ["เบิก", ["เบิก", "เบิกเพิ่ม"]],
    ["ชั่งคืน", ["คืน"]],
    ["คืนเสีย", ["คืนเสีย"]],
  ] as const) {
    const items = session.items.filter((item) => (types as readonly string[]).includes(item.transaction_type));
    if (!items.length) continue;
    const totals = items.map((item) => exactLineTotalScaled({
      quantity: item.quantity,
      pricePerUnit: item.price_per_unit,
      basisQuantity: item.basis_quantity,
      basisPrice: item.basis_price,
    }));
    const amount = totals.some((total) => total === null)
      ? "ยังคำนวณครบไม่ได้"
      : `${scaledToBaht(totals.reduce<bigint>((sum, total) => sum + total!, BigInt(0))).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บาท`;
    lines.push(`${label} ${items.length} รายการ: ${amount}`);
  }
  return [...lines, "ใช้ตรวจเอกสารเบื้องต้น ยังไม่ใช่ยอดขายหรือยอดเงินขาดที่ยืนยันแล้ว", ""];
}

/** Nothing was written; totals describe the draft only, never final sales. */
export function buildBlockingValidationReply(
  result: ProduceValidationResult,
  maxCodePoints = LINE_TEXT_MESSAGE_HARD_MAX_CODE_POINTS,
  session?: WeighSession,
): string {
  const preview = session ? draftValueLines(session) : [];
  const actionBlock = [
    "รายการอื่นยังอยู่ครบ ไม่ต้องยกเลิก",
    ...correctionGuidance(result.blocking),
    'แล้วส่งข้อความ "จบรายการ" อีกครั้ง',
  ];
  for (
    let listed = Math.min(result.blocking.length, MAX_LISTED_EXCEPTIONS);
    listed >= 0;
    listed -= 1
  ) {
    const reply = [
      `⛔ พบ ${result.blocking.length} รายการที่ต้องแก้ไขก่อนจบรายการ`,
      "",
      ...preview,
      ...numberedBlocks(result.blocking, listed),
      "",
      ...actionBlock,
    ].join("\n");
    if (countCodePoints(reply) <= maxCodePoints) return reply;
  }
  throw new Error("blocking validation actions cannot fit within the LINE text limit");
}

function reviewHeadline(result: ProduceValidationResult): string {
  return `⚠️ พบ ${result.reviews.length} ชื่อสินค้าที่ต้องตรวจสอบ`;
}

function reviewCorrectionGuidance(result: ProduceValidationResult): string[] {
  const subunitNumbers = [...new Set(result.reviews
    .filter((review) => review.kind === "subunit_confirmation")
    .map((review) => review.itemNumber))];
  if (subunitNumbers.length > 0) {
    return [
      `ยืนยันทีละข้อ: ${subunitNumbers.map((number) => `“ยืนยันข้อ ${number}”`).join(", ")}`,
      "ถ้าจะแก้ ให้ส่ง “แก้ข้อ <เลขข้อ>” แล้วส่งรายการใหม่",
    ];
  }
  const itemNumbers = [...new Set(result.reviews.map((review) => review.itemNumber))];
  if (itemNumbers.length === 1) {
    return [
      `ส่ง “แก้ข้อ ${itemNumbers[0]}”`,
      `แล้วส่งข้อ ${itemNumbers[0]} ใหม่ พร้อมราคาและจำนวน`,
    ];
  }
  return [
    "ส่งคำสั่ง “แก้ข้อ <เลขข้อ>” ทีละข้อ",
    "แล้วส่งข้อนั้นใหม่ พร้อมราคาและจำนวน",
  ];
}

function reviewActionBlock(
  result: ProduceValidationResult,
  confirmationInstruction: string,
): string[] {
  const subject = result.reviews.length === 1 ? "ชื่อนี้" : "ชื่อเหล่านี้";
  return [
    `✅ ถ้า${subject}ถูกต้องและต้องการบันทึกตามที่พิมพ์`,
    confirmationInstruction,
    "",
    "✏️ ถ้าต้องการแก้ชื่อ",
    ...reviewCorrectionGuidance(result),
    "",
    "รายการอื่นยังอยู่ครบ ไม่ต้องเริ่มใหม่",
  ];
}

/**
 * A rendered review message, plus EXACTLY which reviews its text actually
 * shows.
 *
 * The two are separate because the renderer drops exception blocks to fit the
 * LINE text budget. A review whose detail was truncated away was never
 * presented to anyone, so it must not be marked delivered and must not become
 * confirmable — an unrendered review is not a delivered review.
 */
export interface ProduceReviewPresentation {
  text: string;
  /** The reviews whose detail this exact text contains, in listed order. */
  renderedReviews: ProduceValidationReview[];
  /** True only when every review in the set was rendered. */
  complete: boolean;
}

/** How many LINE messages one review presentation may occupy. */
export const REVIEW_PRESENTATION_MAX_MESSAGES = 5;

/** Told to the operator when the set is too large to show in one presentation. */
const REVIEW_REMAINDER_INSTRUCTION = [
  "",
  "รายการที่เหลือยังแสดงไม่หมดในข้อความเดียว",
  "กรุณาแก้รายการข้างต้นก่อน แล้วปิดรายการอีกครั้งเพื่อดูรายการที่เหลือ",
];

function renderReviewPage(
  result: ProduceValidationResult,
  reviews: ProduceValidationReview[],
  tail: string[],
): string {
  return [
    reviewHeadline(result),
    "",
    ...numberedBlocks(reviews, reviews.length),
    ...tail,
  ].join("\n");
}

/**
 * The whole review set, split across as many LINE messages as it needs.
 *
 * There is deliberately NO arbitrary item cap here. The only real boundary is
 * LINE's code-point limit, and capping at ten stranded any session with more
 * than ten exceptions: every close re-rendered the same first ten, the eleventh
 * stayed hidden forever, and because the whole-review digest may only be
 * delivered once EVERY exception has been shown, the session could never become
 * confirmable. Pagination gives that set a finite path again.
 *
 * A set too large even for `maxMessages` pages is reported incomplete, and its
 * final page tells the operator to correct what they can see. Correcting
 * shrinks the set, so the remainder becomes reachable — the path stays finite
 * without ever authorizing something nobody read.
 */
export function buildPlainTextReviewPresentationPages(
  result: ProduceValidationResult,
  closeCommand: string,
  maxCodePoints = LINE_TEXT_MESSAGE_HARD_MAX_CODE_POINTS,
  maxMessages = REVIEW_PRESENTATION_MAX_MESSAGES,
): { pages: ProduceReviewPresentation[]; complete: boolean } {
  const actionBlock = ["", ...reviewActionBlock(result, `ส่ง “${closeCommand.trim()}” อีกครั้ง`)];
  const pages: ProduceReviewPresentation[] = [];
  let index = 0;

  while (index < result.reviews.length && pages.length < maxMessages) {
    const remainingPages = maxMessages - pages.length;
    let taken: ProduceValidationReview[] = [];

    for (let count = 1; index + count <= result.reviews.length; count += 1) {
      const candidate = result.reviews.slice(index, index + count);
      const finishesSet = index + count === result.reviews.length;
      // The action block rides on the page that completes the set; the
      // remainder notice rides on the last page we are allowed to send.
      const tail = finishesSet
        ? actionBlock
        : (remainingPages === 1 ? REVIEW_REMAINDER_INSTRUCTION : []);
      if (countCodePoints(renderReviewPage(result, candidate, tail)) > maxCodePoints) break;
      taken = candidate;
    }

    if (taken.length === 0) {
      // A single exception that cannot fit alone. Nothing can be shown safely,
      // so nothing may be authorized.
      throw new Error("product review actions cannot fit within the LINE text limit");
    }

    const finishesSet = index + taken.length === result.reviews.length;
    const lastAllowed = remainingPages === 1;
    const tail = finishesSet ? actionBlock : (lastAllowed ? REVIEW_REMAINDER_INSTRUCTION : []);
    pages.push({
      text: renderReviewPage(result, taken, tail),
      renderedReviews: taken,
      complete: finishesSet,
    });
    index += taken.length;
  }

  return { pages, complete: index >= result.reviews.length };
}

function buildReviewPresentationWithinBudget(
  result: ProduceValidationResult,
  confirmationInstruction: string,
  maxCodePoints: number,
): ProduceReviewPresentation {
  const actionBlock = reviewActionBlock(result, confirmationInstruction);
  // No arbitrary cap: start from the whole set and shed only what LINE's own
  // limit forces.
  for (let listed = result.reviews.length; listed >= 0; listed -= 1) {
    const reply = [
      reviewHeadline(result),
      "",
      ...numberedBlocks(result.reviews, listed),
      "",
      ...actionBlock,
    ].join("\n");
    if (countCodePoints(reply) <= maxCodePoints) {
      const renderedReviews = result.reviews.slice(0, listed);
      return {
        text: reply,
        renderedReviews,
        complete: renderedReviews.length === result.reviews.length,
      };
    }
  }
  throw new Error("product review actions cannot fit within the LINE text limit");
}

function buildReviewReplyWithinBudget(
  result: ProduceValidationResult,
  confirmationInstruction: string,
  maxCodePoints: number,
): string {
  return buildReviewPresentationWithinBudget(
    result,
    confirmationInstruction,
    maxCodePoints,
  ).text;
}

/**
 * A withdrawal product name outside the approved dictionary needs one human
 * confirmation before finalization.
 */
export function buildReviewValidationReply(
  result: ProduceValidationResult,
  maxCodePoints = LINE_TEXT_MESSAGE_HARD_MAX_CODE_POINTS,
): string {
  return buildReviewReplyWithinBudget(
    result,
    'กด “ยืนยัน” เพื่อบันทึกและจบรายการ',
    maxCodePoints,
  );
}

/**
 * Same content, plain-text acknowledgement.
 *
 * The plain-text flow has no ยืนยัน button; its second press is a second
 * "จบรายการ…" message, which carries a different LINE event id and so cannot be
 * satisfied by a duplicate delivery of the first one.
 */
export function buildPlainTextReviewValidationReply(
  result: ProduceValidationResult,
  closeCommand: string,
  maxCodePoints = LINE_TEXT_MESSAGE_HARD_MAX_CODE_POINTS,
): string {
  return buildReviewReplyWithinBudget(
    result,
    `ส่ง “${closeCommand.trim()}” อีกครั้ง`,
    maxCodePoints,
  );
}

/**
 * The same plain-text message, with the record of which reviews it actually
 * shows. Use this wherever the message is about to become delivery PROOF:
 * only a review this text really rendered may be marked presented.
 */
export function buildPlainTextReviewPresentation(
  result: ProduceValidationResult,
  closeCommand: string,
  maxCodePoints = LINE_TEXT_MESSAGE_HARD_MAX_CODE_POINTS,
): ProduceReviewPresentation {
  return buildReviewPresentationWithinBudget(
    result,
    `ส่ง “${closeCommand.trim()}” อีกครั้ง`,
    maxCodePoints,
  );
}

/** One-line form for a session held because its review was never acknowledged. */
export function buildUnconfirmedReviewReply(result?: ProduceValidationResult): string {
  const subject = result?.reviews.length
    ? "ชื่อสินค้าที่ไม่ตรงกับรายการมาตรฐาน"
    : "รายการที่ต้องตรวจสอบ";
  return [
    `ยังบันทึกไม่ได้ ${subject}ยังไม่ได้รับการยืนยัน`,
    'กรุณากด "จบรายการ" อีกครั้งเพื่อดูรายการที่ต้องตรวจ',
  ].join("\n");
}
