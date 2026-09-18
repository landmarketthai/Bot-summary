import type { DataQualityCategory } from "./severity";

/** Thai display labels for the admin list. Presentation only — never used for logic. */
export const CATEGORY_LABEL_TH: Record<DataQualityCategory, string> = {
  produce_no_return:                 "ไม่พบรายการชั่งคืน",
  produce_stale_failed_session:      "รายการค้าง/บันทึกไม่สำเร็จ",
  produce_price_conflict:            "ราคากลางขัดแย้ง",
  produce_duplicate_round_review:    "รอบซ้ำ (ตรวจสอบแล้ว)",
  produce_duplicate_round_ambiguous: "รอบซ้ำ (ยังพิสูจน์ไม่ได้)",
  produce_unattributable:            "รายการไม่ผูกกับรอบ",
  produce_possible_duplicate:        "อาจมีรายการเบิกซ้ำ",
  produce_duplicate_persistence:     "รายการเบิกซ้ำแน่นอน",
  produce_lifecycle_ambiguity:       "สถานะเอกสารพิสูจน์ไม่ได้",
  financial_reconciliation_mismatch: "ยอดโอน/สลิปไม่ตรงกัน",
  financial_evidence_incomplete:     "หลักฐานการเงินไม่ครบ",
  financial_settlement_mismatch:     "ปิดยอดการเงินไม่ตรงกัน",
  house_stock_unsend_close_after_finalize: "ยกเลิกส่งคำสั่งจบสต๊อกหลังปิดรายการแล้ว",
};

export const STATUS_LABEL_TH: Record<"OPEN" | "RESOLVED" | "IGNORED", string> = {
  OPEN:     "เปิดอยู่",
  RESOLVED: "แก้ไขแล้ว",
  IGNORED:  "เพิกเฉย",
};
