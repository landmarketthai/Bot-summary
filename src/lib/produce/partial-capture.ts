import type { WeighSession, WeighSessionItem } from "@/lib/parsers/weigh-session/types";
import { occurrenceLetter } from "@/lib/parsers/weigh-session/draft-item-command";
import { exactLineTotalScaled, scaledToBaht } from "./exact-line-total";
import type {
  ProduceValidationException,
  ProduceValidationResult,
} from "./entry-validation";

export interface ProducePartialCaptureIssue {
  kind: "parse_error" | ProduceValidationException["kind"];
  itemNumber: number | null;
  /** Specific duplicate occurrence when the parser retained that evidence. */
  itemOccurrence?: number;
  detail: string;
}

export interface ProducePartialCaptureItem {
  item: WeighSessionItem;
  status: "accepted" | "needs_review";
  issueKinds: string[];
}

export interface ProducePartialCapture {
  version: 1;
  session: Pick<
    WeighSession,
    | "date"
    | "staff_name"
    | "sender_name"
    | "transaction_time"
    | "session_title"
    | "session_kind"
    | "declared_transaction_type"
  >;
  items: ProducePartialCaptureItem[];
  issues: ProducePartialCaptureIssue[];
  acceptedCount: number;
  reviewCount: number;
  /** Sum of every parsed line whose quantity/price can be calculated, even if identity still needs review. */
  readableAmount: number | null;
  readableAmountCount: number;
  uncalculatedAmountCount: number;
  /** Money visible on review lines whose numeric quantity/price are already trustworthy. */
  reviewReadableAmount: number | null;
  reviewReadableCount: number;
  /** Sum of lines whose product identity/validation is already accepted. */
  acceptedAmount: number | null;
}

function exceptionItemNumber(exception: ProduceValidationException): number | null {
  return "itemNumber" in exception ? exception.itemNumber : null;
}

function parseErrorItemNumber(detail: string): number | null {
  const explicit = detail.match(/(?:item\s*#|ข้อ\s*)(\d+)/i);
  if (explicit) return Number(explicit[1]);
  // Parser diagnostics often preserve the original source line inside quotes,
  // e.g. `unrecognized line: "2.มะเขือยาว 36..1 โล 30 บาท"`.
  const quotedLine = detail.match(/["']\s*(\d+)[.)]/);
  return quotedLine ? Number(quotedLine[1]) : null;
}

function exceptionDetail(exception: ProduceValidationException): string {
  switch (exception.kind) {
    case "unknown_product_vocabulary":
      return `ไม่พบชื่อสินค้า “${exception.productName}”`;
    case "unknown_unit":
      return `ไม่รู้จักหน่วย “${exception.unit}” ของ ${exception.productName}`;
    case "unit_not_withdrawn":
      return `${exception.productName} ใช้หน่วย ${exception.unit} แต่รายการเบิกใช้ ${exception.withdrawnUnits.join(", ")}`;
    case "duplicate_item_number":
      return `เลขข้อ ${exception.itemNumber} ซ้ำ ${exception.matchCount} รายการ`;
    case "item_number_gap":
      return `เลขข้อขาด: ${exception.missingItemNumbers.join(", ")}`;
    case "subunit_confirmation":
      return `${exception.productName} ต้องยืนยันการแปลง ${exception.enteredQuantity} ${exception.enteredUnit}`;
    case "product_not_withdrawn":
      return `${exception.productName} ไม่พบในรายการเบิกของรอบนี้`;
    case "return_exceeds_withdrawal":
      return `${exception.productName} คืนรวมเกินเบิก ${exception.excessQuantity} ${exception.unit}`;
    case "price_not_withdrawn":
      return `${exception.productName} ราคาที่คืน ${exception.enteredPrice} บาท ต่างจากราคาเบิก`;
  }
}

/**
 * Durable staging snapshot for a Produce draft that cannot finalize yet.
 *
 * `accepted` means the line itself is parseable and has no blocking/review
 * exception. It is NOT a finalized financial transaction: downstream reports
 * continue to read only produce_sessions/produce_items. This lets LINE tell the
 * operator which lines are safely retained without leaking a half-finished
 * document into Settlement.
 */
export function buildProducePartialCapture(
  parsed: WeighSession,
  validation: ProduceValidationResult,
  finalizationErrors: string[] = parsed.parse_errors,
): ProducePartialCapture {
  const issues: ProducePartialCaptureIssue[] = [];
  const failedTargets = [...(parsed.failed_item_targets ?? [])];
  const parseErrorItemNumbers = new Set(
    finalizationErrors.map(parseErrorItemNumber).filter((n): n is number => n !== null),
  );

  for (let exception of [...validation.blocking, ...validation.reviews]) {
    // A number missing only because its own source line failed to parse is
    // already reported by that parse error; one source line, one issue.
    if (exception.kind === "item_number_gap") {
      const missing = exception.missingItemNumbers.filter((n) => !parseErrorItemNumbers.has(n));
      if (missing.length === 0) continue;
      exception = { ...exception, missingItemNumbers: missing };
    }
    const itemNumber = exceptionItemNumber(exception);
    issues.push({
      kind: exception.kind,
      itemNumber,
      detail: exceptionDetail(exception),
    });
  }

  // Parse errors can describe an item that never made it into parsed.items.
  // Keep those as independent review issues so one malformed source line does
  // not erase the good lines that were already understood.
  for (const detail of finalizationErrors) {
    const targetIndex = failedTargets.findIndex((target) => target.parse_error === detail);
    const failedTarget = targetIndex >= 0 ? failedTargets.splice(targetIndex, 1)[0]! : null;
    const itemNumber = failedTarget?.item_number ?? parseErrorItemNumber(detail);
    issues.push({
      kind: "parse_error",
      itemNumber,
      ...(failedTarget ? { itemOccurrence: failedTarget.occurrence } : {}),
      detail,
    });
  }

  const items = parsed.items.map((item) => {
    const occurrence = item.item_occurrence ?? 1;
    const issueKinds = issues
      .filter((issue) =>
        issue.itemNumber === item.item_number
        && (issue.itemOccurrence === undefined || issue.itemOccurrence === occurrence))
      .map((issue) => issue.kind);
    const status = issueKinds.length > 0
      ? "needs_review" as const
      : "accepted" as const;
    return { item, status, issueKinds };
  });

  const lineTotal = ({ item }: ProducePartialCaptureItem) => exactLineTotalScaled({
    quantity: item.quantity,
    pricePerUnit: item.price_per_unit,
    basisQuantity: item.basis_quantity,
    basisPrice: item.basis_price,
  });
  const sumKnownTotals = (entries: ProducePartialCaptureItem[]): {
    amount: number | null;
    count: number;
  } => {
    const totals = entries
      .map((entry) => lineTotal(entry))
      .filter((total): total is bigint => total !== null);
    if (totals.length === 0) return { amount: null, count: 0 };
    return {
      amount: scaledToBaht(totals.reduce((sum, total) => sum + total, BigInt(0))),
      count: totals.length,
    };
  };

  const accepted = items.filter((entry) => entry.status === "accepted");
  const acceptedTotals = accepted.map((entry) => lineTotal(entry));
  const acceptedAmount = acceptedTotals.some((total) => total === null)
    ? null
    : scaledToBaht(acceptedTotals.reduce<bigint>((sum, total) => sum + total!, BigInt(0)));
  const readable = sumKnownTotals(items);
  const needsReview = items.filter((entry) => entry.status === "needs_review");
  const reviewReadable = sumKnownTotals(needsReview);

  return {
    version: 1,
    session: {
      date: parsed.date,
      staff_name: parsed.staff_name,
      sender_name: parsed.sender_name,
      transaction_time: parsed.transaction_time,
      session_title: parsed.session_title,
      session_kind: parsed.session_kind,
      declared_transaction_type: parsed.declared_transaction_type,
    },
    items,
    issues,
    acceptedCount: accepted.length,
    reviewCount: issues.length,
    readableAmount: readable.amount,
    readableAmountCount: readable.count,
    uncalculatedAmountCount: items.length - readable.count,
    reviewReadableAmount: reviewReadable.amount,
    reviewReadableCount: reviewReadable.count,
    acceptedAmount,
  };
}

function amountBaseLabel(items: ProducePartialCaptureItem[]): string {
  const types = new Set(items.map((entry) => entry.item.transaction_type));
  if (types.size === 1) {
    const [type] = [...types];
    if (type === "คืน") return "ยอดชั่งคืน";
    if (type === "คืนเสีย") return "ยอดคืนเสีย";
    if (type === "เบิก" || type === "เบิกเพิ่ม") return "ยอดเบิก";
  }
  return "ยอดรายการ";
}

function captureLabel(items: ProducePartialCaptureItem[]): string {
  const base = amountBaseLabel(items);
  if (base === "ยอดชั่งคืน") return "รายการชั่งคืน";
  if (base === "ยอดคืนเสีย") return "รายการคืนเสีย";
  if (base === "ยอดเบิก") return "รายการเบิก";
  return "รายการ";
}

function formatAmount(value: number): string {
  return value.toLocaleString("th-TH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatCompactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "?";
  return value.toLocaleString("th-TH", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  });
}

function linePriceText(item: WeighSessionItem): string {
  if (
    item.basis_quantity !== null
    && item.basis_quantity !== undefined
    && item.basis_price !== null
    && item.basis_price !== undefined
  ) {
    const basisUnit = item.basis_unit ?? item.unit;
    return `${formatCompactNumber(item.basis_price)} บาท/${formatCompactNumber(item.basis_quantity)} ${basisUnit}`;
  }
  return `${formatCompactNumber(item.price_per_unit)} บาท`;
}

function lineTotalText(item: WeighSessionItem): string {
  const total = exactLineTotalScaled({
    quantity: item.quantity,
    pricePerUnit: item.price_per_unit,
    basisQuantity: item.basis_quantity,
    basisPrice: item.basis_price,
  });
  return total === null ? "ยังคิดยอดไม่ได้" : `${formatAmount(scaledToBaht(total))} บาท`;
}

function reviewStatusLabel(entry: ProducePartialCaptureItem): string {
  if (entry.issueKinds.includes("unknown_product_vocabulary")) return "รอตรวจชื่อสินค้า";
  if (entry.issueKinds.includes("unknown_unit") || entry.issueKinds.includes("unit_not_withdrawn")) {
    return "รอตรวจหน่วย";
  }
  if (entry.issueKinds.includes("subunit_confirmation")) return "รอยืนยันจำนวน";
  return "รอตรวจ";
}

function knownOccurrences(capture: ProducePartialCapture, itemNumber: number): number[] {
  const occurrences = [
    ...capture.items
      .filter((entry) => entry.item.item_number === itemNumber)
      .map((entry) => entry.item.item_occurrence ?? 1),
    ...capture.issues
      .filter((issue) => issue.itemNumber === itemNumber && issue.itemOccurrence !== undefined)
      .map((issue) => issue.itemOccurrence!),
  ];
  return [...new Set(occurrences)].sort((left, right) => left - right);
}

function selectorForOccurrence(
  itemNumber: number,
  occurrence: number,
  capture: ProducePartialCapture,
): string {
  const known = knownOccurrences(capture, itemNumber);
  const letter = occurrenceLetter(occurrence);
  return (occurrence > 1 || known.length > 1) && letter
    ? `${itemNumber}${letter}`
    : String(itemNumber);
}

/** "52A"/"52B" when duplicate occurrence evidence exists, else just "52". */
function itemSelector(item: WeighSessionItem, capture: ProducePartialCapture): string {
  return selectorForOccurrence(item.item_number, item.item_occurrence ?? 1, capture);
}

function itemSummaryLine(entry: ProducePartialCaptureItem, capture: ProducePartialCapture): string {
  const item = entry.item;
  const review = entry.status === "needs_review" ? ` ⚠️ ${reviewStatusLabel(entry)}` : "";
  return `${itemSelector(item, capture)}. ${item.product_name} ${formatCompactNumber(item.quantity)} ${item.unit} × ${linePriceText(item)} = ${lineTotalText(item)}${review}`;
}

export function buildPartialCaptureSavedReply(capture: ProducePartialCapture): string {
  const label = captureLabel(capture.items);
  const orderedItems = [...capture.items].sort(
    (left, right) => left.item.item_number - right.item.item_number,
  );
  const lines = [
    `✅ รับ${label}แล้ว`,
    "",
    "รายการที่อ่านได้",
    ...orderedItems.map((entry) => itemSummaryLine(entry, capture)),
    "",
  ];

  if (capture.readableAmount !== null) {
    lines.push(`💰 ยอดจากรายการที่อ่านได้ทั้งหมด: ${formatAmount(capture.readableAmount)} บาท`);
  }
  if (capture.acceptedAmount !== null) {
    lines.push(`✅ ยอดที่ตรวจแล้ว: ${formatAmount(capture.acceptedAmount)} บาท`);
  }
  if (capture.reviewReadableAmount !== null && capture.reviewReadableCount > 0) {
    lines.push(
      `⚠️ รอตรวจ: ${formatAmount(capture.reviewReadableAmount)} บาท (${capture.reviewReadableCount} รายการ)`,
    );
  }
  if (capture.uncalculatedAmountCount > 0) {
    lines.push(`⚠️ อีก ${capture.uncalculatedAmountCount} รายการยังคิดยอดไม่ได้`);
  }
  lines.push(
    "",
    "รายการอื่นเก็บไว้แล้ว ไม่ต้องส่งใหม่",
    "ยอดขาด-เกินจะสรุปหลังแก้รายการที่รอตรวจเรียบร้อย",
  );
  return lines.join("\n");
}

function readableParseIssue(issue: ProducePartialCaptureIssue): string {
  const quoted = issue.detail.match(/"([^"]+)"/)?.[1];
  if (quoted) return quoted;
  return issue.detail;
}

function issueDetailForUser(issue: ProducePartialCaptureIssue): string {
  if (issue.kind === "parse_error") return "อ่านรายการนี้ไม่ชัด กรุณาส่งข้อนี้ใหม่";
  return issue.detail;
}

export function buildPartialCaptureReviewReply(capture: ProducePartialCapture): string {
  const itemNumbers = [...new Set(
    capture.issues.flatMap((issue) => issue.itemNumber === null ? [] : [issue.itemNumber]),
  )];
  const unnumbered = capture.issues.filter((issue) => issue.itemNumber === null);
  const reviewItemCount = itemNumbers.length + unnumbered.length;
  const lines = [`⚠️ มี ${reviewItemCount} รายการที่ต้องแก้`, ""];

  for (const itemNumber of itemNumbers.slice(0, 10)) {
    const allEntries = capture.items.filter((candidate) => candidate.item.item_number === itemNumber);
    const reviewEntries = allEntries.filter((entry) => entry.status === "needs_review");
    const issues = capture.issues.filter((issue) => issue.itemNumber === itemNumber);
    const specificIssues = new Map<number, ProducePartialCaptureIssue[]>();
    for (const issue of issues) {
      if (issue.itemOccurrence === undefined) continue;
      const group = specificIssues.get(issue.itemOccurrence) ?? [];
      group.push(issue);
      specificIssues.set(issue.itemOccurrence, group);
    }

    const renderedOccurrences = new Set<number>();
    for (const [occurrence, occurrenceIssues] of [...specificIssues.entries()].sort((a, b) => a[0] - b[0])) {
      const selector = selectorForOccurrence(itemNumber, occurrence, capture);
      const entry = allEntries.find((candidate) => (candidate.item.item_occurrence ?? 1) === occurrence);
      lines.push(`ข้อ ${selector}`);
      if (entry) {
        lines.push(
          `${entry.item.product_name} ${linePriceText(entry.item)}`,
          `${formatCompactNumber(entry.item.quantity)} ${entry.item.unit}`,
        );
      } else {
        const source = occurrenceIssues
          .map(readableParseIssue)
          .find((detail) => detail !== issueDetailForUser(occurrenceIssues[0]!));
        if (source) lines.push(source);
      }
      for (const detail of [...new Set(occurrenceIssues.map(issueDetailForUser))]) lines.push(detail);
      lines.push("");
      renderedOccurrences.add(occurrence);
    }

    for (const entry of reviewEntries) {
      const occurrence = entry.item.item_occurrence ?? 1;
      if (renderedOccurrences.has(occurrence)) continue;
      lines.push(
        `ข้อ ${itemSelector(entry.item, capture)}`,
        `${entry.item.product_name} ${linePriceText(entry.item)}`,
        `${formatCompactNumber(entry.item.quantity)} ${entry.item.unit}`,
      );
      renderedOccurrences.add(occurrence);
    }

    const wildcardIssues = issues.filter((issue) => issue.itemOccurrence === undefined);
    if (wildcardIssues.length > 0) {
      if (reviewEntries.length === 0 && specificIssues.size === 0) {
        lines.push(`ข้อ ${itemNumber}`);
        const source = wildcardIssues
          .map(readableParseIssue)
          .find((detail) => detail !== issueDetailForUser(wildcardIssues[0]!));
        if (source) lines.push(source);
      }
      for (const detail of [...new Set(wildcardIssues.map(issueDetailForUser))]) lines.push(detail);
      lines.push("");
    } else if (reviewEntries.some((entry) => !specificIssues.has(entry.item.item_occurrence ?? 1))) {
      lines.push("");
    }

    const selectors = knownOccurrences(capture, itemNumber)
      .map((occurrence) => selectorForOccurrence(itemNumber, occurrence, capture));
    if (selectors.length > 1 && reviewEntries.length + specificIssues.size > 1) {
      lines.push(`ระบุข้อด้วยตัวอักษร เช่น “แก้ข้อ ${selectors[0]}” หรือ “ลบข้อ ${selectors.at(-1)}”`, "");
    }
  }

  for (const issue of unnumbered.slice(0, Math.max(0, 10 - itemNumbers.length))) {
    lines.push(`• ${readableParseIssue(issue)}`, issueDetailForUser(issue), "");
  }

  if (reviewItemCount > 10) {
    lines.push(`…และอีก ${reviewItemCount - 10} รายการ`, "");
  }

  if (itemNumbers.length > 0) {
    const firstNumber = itemNumbers[0];
    const firstSpecificIssue = capture.issues.find((issue) =>
      issue.itemNumber === firstNumber && issue.itemOccurrence !== undefined);
    const firstEntry = capture.items.find((entry) =>
      entry.item.item_number === firstNumber && entry.status === "needs_review");
    const first = firstSpecificIssue?.itemOccurrence !== undefined
      ? selectorForOccurrence(firstNumber, firstSpecificIssue.itemOccurrence, capture)
      : firstEntry
        ? itemSelector(firstEntry.item, capture)
        : String(firstNumber);
    lines.push(
      "วิธีแก้",
      `พิมพ์ “แก้ข้อ ${first}” แล้วส่งเฉพาะข้อนั้นที่ถูกต้องใหม่`,
      "",
      "ตัวอย่าง",
      `แก้ข้อ ${first}`,
      `${firstNumber}.หอมแดง20บาท`,
      "4แพค",
      "",
      `ถ้าข้อ ${first} ไม่ต้องใช้ ให้พิมพ์ “ลบข้อ ${first}”`,
      "",
      "ตัวอย่างกรณีมีหลายข้อ สามารถส่งรวมในข้อความเดียวได้",
      "แก้ข้อ 2",
      "2.หอมแดง20บาท",
      "4แพค",
      "",
      "แก้ข้อ 5",
      "5.มะนาว20บาท",
      "3แพค",
      "",
      "ลบข้อ 8",
      "",
      "รายการอื่นไม่ต้องส่งซ้ำ",
    );
  } else {
    lines.push("แก้เฉพาะรายการที่แจ้ง แล้วปิดรายการอีกครั้ง", "รายการอื่นไม่ต้องส่งซ้ำ");
  }
  return lines.join("\n");
}
