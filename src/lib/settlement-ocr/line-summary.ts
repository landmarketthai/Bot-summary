import type { ArithmeticCheck } from "@/lib/settlement-ocr/extraction-schema";
import { isFieldConfident } from "@/lib/settlement-ocr/extraction-schema";
import type { MoneyField, SettlementSheetExtraction } from "@/lib/settlement-ocr/types";

function fmtBaht(value: number | null): string {
  if (value === null) return "อ่านไม่ออก";
  return `${value.toLocaleString("th-TH", { maximumFractionDigits: 2 })} บาท`;
}

function fieldLine(label: string, field: MoneyField): string {
  const suffix = field.value !== null && !isFieldConfident(field) ? " (ไม่ชัดเจน — โปรดตรวจสอบ)" : "";
  return `${label} ${fmtBaht(field.value)}${suffix}`;
}

/**
 * The full draft reply: extracted fields (with per-field confidence
 * caveats), the arithmetic cross-check, and — when a template could be
 * built — the ready-to-edit-and-resend "ส่งยอด" command that is the entire
 * confirm/correct mechanism (see template.ts).
 */
export function buildSettlementSheetDraftSummary(input: {
  extraction: SettlementSheetExtraction;
  arithmetic: ArithmeticCheck;
  templateText: string | null;
  dateMismatch: boolean;
}): string {
  const { extraction, arithmetic, templateText, dateMismatch } = input;
  const lines: string[] = [
    "🟡 อ่านยอดจากรูปใบส่งยอดแล้ว",
    "",
    fieldLine("ยอดขาย (ตามที่เขียน)", extraction.salesTotal),
    fieldLine("เงินโอน", extraction.transferAmount),
    fieldLine("ส่งเงินสด (ข้อมูลอ้างอิง)", extraction.cashSubmitted),
    fieldLine("ค่าใช้จ่าย", extraction.expensesTotal),
    fieldLine("ค่าแรง", extraction.laborTotal),
    fieldLine("เหลือเงินสด (ใช้บันทึกเป็นเงินสด)", extraction.cashRemaining),
  ];

  if (dateMismatch) {
    lines.push("", "⚠️ วันที่ในรูปดูไม่ตรงกับรอบที่เปิดอยู่ กรุณาตรวจสอบก่อนยืนยัน");
  }

  if (arithmetic.ok === false) {
    lines.push("", "⚠️ ยอดไม่ตรงกัน");
    if (arithmetic.ledgerOk === false) {
      lines.push("ยอดขาย ไม่เท่ากับ เงินโอน + ส่งเงินสด + ค่าใช้จ่าย");
    }
    if (arithmetic.cashOk === false) {
      lines.push("ส่งเงินสด ไม่เท่ากับ เหลือเงินสด + ค่าแรง");
    }
    if (arithmetic.difference !== null) {
      const diff = arithmetic.difference;
      lines.push(
        `เงินโอน + เหลือเงินสด + ค่าใช้จ่าย + ค่าแรง = ${fmtBaht(arithmetic.expectedSales)}`,
        diff > 0
          ? `ยอดขายที่เขียนไว้มากกว่าผลรวม ${fmtBaht(Math.abs(diff))}`
          : `ยอดขายที่เขียนไว้น้อยกว่าผลรวม ${fmtBaht(Math.abs(diff))}`,
      );
    }
  }

  if (templateText) {
    lines.push(
      "",
      "ตรวจสอบตัวเลขด้านบนกับรูปอีกครั้ง หากถูกต้องหรือหลังแก้ไขแล้ว ส่งข้อความด้านล่างนี้กลับมาเพื่อบันทึก:",
      "",
      templateText,
      "",
      "ยังไม่มีการบันทึกยอดใด ๆ จนกว่าจะส่งข้อความด้านบนกลับมา",
    );
  } else {
    lines.push(
      "",
      "ไม่สามารถสร้างคำสั่งยืนยันอัตโนมัติได้ กรุณาพิมพ์คำสั่ง \"ส่งยอด\" ด้วยตนเอง",
    );
  }

  return lines.join("\n");
}

export function buildSettlementSheetDuplicateReply(templateText: string | null): string {
  const lines = [
    "🔁 รูปนี้เคยถูกส่งมาแล้วก่อนหน้านี้ ระบบไม่ได้อ่านซ้ำ",
  ];
  if (templateText) {
    lines.push("", "หากยังไม่ได้ยืนยัน ส่งข้อความนี้กลับมาเพื่อบันทึก:", "", templateText);
  }
  return lines.join("\n");
}

export const SETTLEMENT_SHEET_FAILED_REPLY =
  "อ่านรูปใบส่งยอดไม่สำเร็จ กรุณาลองส่งรูปใหม่อีกครั้ง หรือพิมพ์คำสั่ง \"ส่งยอด\" ด้วยตนเอง";
