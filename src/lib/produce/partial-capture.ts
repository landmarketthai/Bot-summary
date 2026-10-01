import type { WeighSession, WeighSessionItem } from "@/lib/parsers/weigh-session/types";
import { exactLineTotalScaled, scaledToBaht } from "./exact-line-total";
import type {
  ProduceValidationException,
  ProduceValidationResult,
} from "./entry-validation";

export interface ProducePartialCaptureIssue {
  kind: "parse_error" | ProduceValidationException["kind"];
  itemNumber: number | null;
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
      return `ไม่พบสินค้า “${exception.productName}” ใน Dictionary`;
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
  const reviewItemNumbers = new Set<number>();
  const issues: ProducePartialCaptureIssue[] = [];

  for (const exception of [...validation.blocking, ...validation.reviews]) {
    const itemNumber = exceptionItemNumber(exception);
    if (itemNumber !== null) reviewItemNumbers.add(itemNumber);
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
    const itemNumber = parseErrorItemNumber(detail);
    if (itemNumber !== null) reviewItemNumbers.add(itemNumber);
    issues.push({ kind: "parse_error", itemNumber, detail });
  }

  const items = parsed.items.map((item) => {
    const issueKinds = issues
      .filter((issue) => issue.itemNumber === item.item_number)
      .map((issue) => issue.kind);
    const status = reviewItemNumbers.has(item.item_number)
      ? "needs_review" as const
      : "accepted" as const;
    return { item, status, issueKinds };
  });

  const accepted = items.filter((entry) => entry.status === "accepted");
  const totals = accepted.map(({ item }) => exactLineTotalScaled({
    quantity: item.quantity,
    pricePerUnit: item.price_per_unit,
    basisQuantity: item.basis_quantity,
    basisPrice: item.basis_price,
  }));
  const acceptedAmount = totals.some((total) => total === null)
    ? null
    : scaledToBaht(totals.reduce<bigint>((sum, total) => sum + total!, BigInt(0)));

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
    acceptedAmount,
  };
}

function amountLabel(items: ProducePartialCaptureItem[]): string {
  const accepted = items.filter((entry) => entry.status === "accepted");
  const types = new Set(accepted.map((entry) => entry.item.transaction_type));
  if (types.size === 1) {
    const [type] = [...types];
    if (type === "คืน") return "ยอดชั่งคืนที่ยืนยันแล้ว";
    if (type === "คืนเสีย") return "ยอดคืนเสียที่ยืนยันแล้ว";
    if (type === "เบิก" || type === "เบิกเพิ่ม") return "ยอดเบิกที่ยืนยันแล้ว";
  }
  return "ยอดรายการที่ยืนยันแล้ว";
}

function formatAmount(value: number): string {
  return value.toLocaleString("th-TH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function buildPartialCaptureSavedReply(capture: ProducePartialCapture): string {
  const lines = [
    `✅ บันทึกรายการที่ตรวจผ่านแล้ว ${capture.acceptedCount} รายการ`,
  ];
  if (capture.acceptedAmount !== null) {
    lines.push(`💰 ${amountLabel(capture.items)}: ${formatAmount(capture.acceptedAmount)} บาท`);
  }
  if (capture.reviewCount > 0) {
    lines.push(`⚠️ มี ${capture.reviewCount} จุดรอตรวจสอบ`);
  }
  lines.push(
    "รายการที่ผ่านแล้วถูกพักไว้อย่างถาวร ไม่ต้องส่งใหม่",
    "ยังไม่ส่งยอดเข้า Settlement จนกว่ารายการรอตรวจจะเรียบร้อย",
  );
  return lines.join("\n");
}

function readableParseIssue(issue: ProducePartialCaptureIssue): string {
  const quoted = issue.detail.match(/"([^"]+)"/)?.[1];
  if (quoted) return quoted;
  return issue.detail;
}

export function buildPartialCaptureReviewReply(capture: ProducePartialCapture): string {
  const lines = [`⚠️ กรุณาตรวจสอบ ${capture.reviewCount} จุด`];
  for (const issue of capture.issues.slice(0, 10)) {
    const prefix = issue.itemNumber === null ? "•" : `ข้อ ${issue.itemNumber} —`;
    lines.push(`${prefix} ${readableParseIssue(issue)}`);
  }
  if (capture.issues.length > 10) {
    lines.push(`…และอีก ${capture.issues.length - 10} จุด`);
  }
  const itemNumbers = [...new Set(
    capture.issues.flatMap((issue) => issue.itemNumber === null ? [] : [issue.itemNumber]),
  )];
  lines.push("");
  if (itemNumbers.length === 1) {
    lines.push(
      `ส่ง “แก้ข้อ ${itemNumbers[0]}”`,
      `แล้วส่งเฉพาะข้อ ${itemNumbers[0]} ที่ถูกต้องใหม่ พร้อมราคาและจำนวน`,
    );
  } else if (itemNumbers.length > 1) {
    lines.push(
      `แก้เฉพาะข้อที่แจ้ง: ${itemNumbers.map((number) => `“แก้ข้อ ${number}”`).join(", ")}`,
      "หลังแต่ละคำสั่ง ส่งเฉพาะข้อนั้นใหม่พร้อมราคาและจำนวน",
    );
  } else {
    lines.push("แก้เฉพาะจุดที่แจ้ง แล้วปิดรายการอีกครั้ง");
  }
  lines.push("รายการที่บันทึกไว้แล้วไม่ต้องส่งซ้ำ");
  return lines.join("\n");
}
