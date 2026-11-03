/**
 * Versioned operational knowledge for the @Botsummary AI Consultant.
 *
 * Everything here describes what the system ACTUALLY does today. Each entry
 * names the code that proves it (`sourceRefs`), and knowledge.test.ts feeds
 * every example message to the real parser / command recognizer, so a
 * command the system stops understanding fails the build instead of being
 * quietly taught to workers.
 *
 * Rules for editing:
 *  - Never describe a command that no recognizer in the repo accepts.
 *  - `answerThai` is read by frontline workers: short lines, outcome first,
 *    one next step, polite "ครับ", no internal or English technical terms.
 *  - `caveats` carry the state-dependent limits the model must respect.
 *  - Bump CONSULTANT_KNOWLEDGE_VERSION whenever an entry changes.
 */

import type { ConsultantActionId } from "./types";

export const CONSULTANT_KNOWLEDGE_VERSION = "2026-10-08.1";

export type ConsultantKnowledgeTopicId =
  | "produce_withdrawal"
  | "produce_additional_batch"
  | "produce_return"
  | "produce_damaged_return"
  | "item_correction"
  | "item_deletion"
  | "wrong_product_name"
  | "close_submission"
  | "after_close_confirmation"
  | "cancel_open_draft"
  | "correct_finalized_document"
  | "recover_unsaved_messages"
  | "guided_menu"
  | "slip_transfer"
  | "slip_manual"
  | "settlement_close"
  | "white_sheet_entry"
  | "white_sheet_manual"
  | "white_sheet_vision_preview"
  | "common_replies"
  | "failed_round_recovery";

export interface KnowledgeEntry {
  id: ConsultantKnowledgeTopicId;
  titleThai: string;
  /** Thai phrases workers use. Matched deterministically, spaces ignored. */
  keywords: readonly string[];
  /** 2-6 short lines, joined with a newline. Safe to show a worker as-is. */
  answerThai: string;
  /** Exact message text a worker types (one string = one LINE message). */
  examples: readonly string[];
  /**
   * Proof of the behavior: `path` or `path#text`. `text` must literally occur
   * in the file (function, constant, regex or reply name), checked by tests.
   */
  sourceRefs: readonly string[];
  /** Limits that depend on state. Thai, for the consultant to respect. */
  caveats: readonly string[];
}

export interface ConsultantActionGuide {
  titleThai: string;
  howToThai: string;
  sourceRefs: readonly string[];
}

// ── Shared example messages ──────────────────────────────────────────────────
// Product names, prices and units are deliberately the same across the
// withdrawal, return and damaged-return examples: knowledge.test.ts runs the
// return examples against the withdrawal example and expects no warning.

const WITHDRAWAL_DOC = [
  "กี้-พาซิโอ้ เบิก 8/10/2569",
  "1. มังคุด 45 บาท",
  "10 โล",
  "2. กล้วยหอม 30 บาท",
  "8 หวี",
].join("\n");

const RETURN_DOC = [
  "กี้-พาซิโอ้ ชั่งคืน 8/10/2569",
  "1. มังคุด 45 บาท",
  "2 โล",
  "2. กล้วยหอม 30 บาท",
  "1 หวี",
].join("\n");

const DAMAGED_DOC = [
  "กี้-พาซิโอ้ คืนเสีย 8/10/2569",
  "1. มังคุด 45 บาท",
  "1 โล",
].join("\n");

const ADDITIONAL_DOC = [
  "กี้-พาซิโอ้ เบิกเพิ่ม 8/10/2569",
  "3. กล้วยหอม 30 บาท",
  "4 หวี",
].join("\n");

export const CONSULTANT_KNOWLEDGE: readonly KnowledgeEntry[] = [
  {
    id: "produce_withdrawal",
    titleThai: "เบิกสินค้า",
    keywords: [
      "เบิก", "เบิกของ", "เบิกสินค้า", "เบิกผัก", "เบิกผลไม้",
      "รายการเบิก", "ลงเบิก", "ส่งเบิก",
    ],
    answerThai: [
      "พิมพ์หัวรายการก่อน แล้วส่งสินค้าทีละข้อครับ",
      "หัวรายการ: ชื่อคนขาย-ตลาด เบิก วันที่ (ปี พ.ศ.)",
      "สินค้าแต่ละข้อ 2 บรรทัด: เลขข้อ ชื่อ ราคา บาท แล้วขึ้นบรรทัดใหม่ใส่จำนวนกับหน่วย",
      "ครบแล้วพิมพ์ “จบรายการเบิก”",
    ].join("\n"),
    examples: [WITHDRAWAL_DOC, "จบรายการเบิก"],
    sourceRefs: [
      "src/lib/parsers/weigh-session/regex.ts#SELLER_MARKET",
      "src/lib/parsers/weigh-session/regex.ts#TX_TYPE_BEIK",
      "src/lib/parsers/weigh-session/regex.ts#ITEM",
      "src/lib/parsers/weigh-session/main-closer.ts#MAIN_SESSION_EXPECTED_CLOSER",
      "src/lib/parsers/weigh-session/parser.test.ts",
    ],
    caveats: [
      "ถ้าเปิดรายการจากเมนู ไม่ต้องพิมพ์หัวรายการ ส่งสินค้าได้เลยแล้วกดจบรายการ",
      "ชื่อตลาดและชื่อคนขายต้องพิมพ์ให้เหมือนเดิมทุกครั้ง เพราะตอนชั่งคืนระบบใช้จับคู่กับรายการเบิก",
      "ถ้าชื่อสินค้าตอนเบิกพิมพ์ผิด ระบบไม่หยุดและไม่ถามพนักงาน จะบันทึกตามที่พิมพ์ จึงควรตรวจก่อนจบรายการ",
      "ถ้ามีการส่งรายการเบิกชุดเดิมซ้ำ ระบบจะไม่บันทึกซ้ำ",
    ],
  },
  {
    id: "produce_additional_batch",
    titleThai: "เบิกเพิ่ม ชั่งคืนเพิ่ม คืนเสียเพิ่ม",
    keywords: [
      "เบิกเพิ่ม", "ชั่งคืนเพิ่ม", "คืนเสียเพิ่ม", "ของเพิ่ม", "เพิ่มของ",
      "เพิ่มสินค้า", "ลืมใส่", "ตกหล่น", "เพิ่มรายการ",
    ],
    answerThai: [
      "ถ้ามีของเพิ่มหลังจากส่งรายการไปแล้ว ให้ส่งเป็นชุดเพิ่มครับ",
      "ใช้หัว “เบิกเพิ่ม” (หรือ “ชั่งคืนเพิ่ม” “คืนเสียเพิ่ม”) ตามด้วยวันที่",
      "ใส่เฉพาะสินค้าที่เพิ่มใหม่ อย่าส่งรายการเก่าซ้ำ",
      "ครบแล้วพิมพ์ “จบรายการเบิกเพิ่ม”",
    ].join("\n"),
    examples: [ADDITIONAL_DOC, "จบรายการเบิกเพิ่ม"],
    sourceRefs: [
      "src/lib/parsers/weigh-session/regex.ts#ADDITIONAL_HEADER",
      "src/lib/parsers/weigh-session/regex.ts#ADDITIONAL_END",
      "src/lib/parsers/weigh-session/parser.ts#ADDITIONAL_TYPE_MAP",
      "src/lib/line/pending-session-finalizer.ts#buildWithdrawalContainmentMessage",
    ],
    caveats: [
      "ปิดชุดเพิ่มด้วย “จบรายการชั่งคืนเพิ่ม” หรือ “จบรายการคืนเสียเพิ่ม” ให้ตรงกับหัว",
      "หัวชุดเพิ่มต้องมีวันที่เสมอ",
      "ถ้าส่งรายการเบิกชุดเต็มซ้ำและมีรายการทับกับที่บันทึกไว้ ระบบจะไม่บันทึกและบอกให้ส่งเฉพาะของที่เพิ่มด้วย “เบิกเพิ่ม”",
    ],
  },
  {
    id: "produce_return",
    titleThai: "ชั่งคืน",
    keywords: [
      "ชั่งคืน", "คืน", "คืนของ", "คืนสินค้า", "รายการคืน", "ส่งคืน",
      "คืนผัก", "ของคืน", "รับคืน",
    ],
    answerThai: [
      "ชั่งคืนพิมพ์เหมือนเบิก แต่ใช้หัว “ชั่งคืน” ครับ",
      "หัวรายการ: ชื่อคนขาย-ตลาด ชั่งคืน วันที่ (ปี พ.ศ.)",
      "ใช้ชื่อสินค้า ราคา และหน่วยให้ตรงกับที่เบิกไว้",
      "ครบแล้วพิมพ์ “จบรายการชั่งคืน”",
    ].join("\n"),
    examples: [RETURN_DOC, "จบรายการชั่งคืน"],
    sourceRefs: [
      "src/lib/parsers/weigh-session/regex.ts#TX_TYPE_KUEN",
      "src/lib/parsers/weigh-session/main-closer.ts#MAIN_SESSION_EXPECTED_CLOSER",
      "src/lib/produce/plain-text-round-binding.ts#NO_ROUND_REPLY",
      "src/lib/produce/plain-text-round-binding.ts#marketMismatchReply",
      "src/lib/produce/entry-validation.ts#price_not_withdrawn",
      "src/lib/produce/entry-validation-message.ts#buildPriceAdvisoryWarning",
    ],
    caveats: [
      "ต้องมีรายการเบิกของคนขาย ตลาด และวันที่เดียวกันที่บันทึกแล้วก่อน ถ้าไม่มีระบบจะไม่บันทึกและบอกให้บันทึกรายการเบิกก่อน",
      "ชื่อตลาดต้องตรงกับตอนเบิก ถ้าไม่ตรงระบบจะไม่บันทึกและบอกชื่อตลาดที่ถูก",
      "ถ้าราคาตอนชั่งคืนต่างจากตอนเบิก ระบบบันทึกตามราคาที่พิมพ์ แล้วแจ้งเตือนราคาแตกต่างหลังบันทึก",
      "ถ้าชื่อหรือหน่วยไม่ตรงกับที่เบิก ระบบยังบันทึกตามที่พิมพ์ แต่แจ้งให้ผู้ดูแลตรวจภายหลัง พนักงานจะไม่เห็นข้อความเตือน",
    ],
  },
  {
    id: "produce_damaged_return",
    titleThai: "คืนเสีย",
    keywords: [
      "คืนเสีย", "ของเสีย", "สินค้าเสีย", "ผักเสีย", "ผลไม้เสีย",
      "เน่า", "ช้ำ", "เสียหาย",
    ],
    answerThai: [
      "ของเสียส่งเป็นรายการคืนเสียแยกต่างหากครับ",
      "หัวรายการ: ชื่อคนขาย-ตลาด คืนเสีย วันที่ (ปี พ.ศ.)",
      "ส่งสินค้าเสียแบบเดียวกับชั่งคืน ชื่อ ราคา จำนวน หน่วย",
      "ครบแล้วพิมพ์ “จบรายการคืนเสีย”",
    ].join("\n"),
    examples: [DAMAGED_DOC, "จบรายการคืนเสีย"],
    sourceRefs: [
      "src/lib/parsers/weigh-session/regex.ts#TX_TYPE_KUEN_SIA",
      "src/lib/parsers/weigh-session/main-closer.ts#MAIN_SESSION_EXPECTED_CLOSER",
      "src/lib/produce/entry-validation.ts#damagedQuantity",
    ],
    caveats: [
      "ไม่ต้องรวมของเสียไปในรายการชั่งคืนปกติ ให้ส่งเป็นรายการคืนเสียของตัวเอง",
      "ต้องมีรายการเบิกที่บันทึกแล้วก่อน เหมือนชั่งคืน",
      "ปิดรายการต้องใช้ “จบรายการคืนเสีย” ถ้าใช้คำสั่งปิดของประเภทอื่น ระบบจะไม่ปิดและบอกคำสั่งที่ถูกต้อง",
    ],
  },
  {
    id: "item_correction",
    titleThai: "แก้ข้อที่ส่งผิดก่อนจบรายการ",
    keywords: [
      "แก้ข้อ", "แก้รายการ", "แก้ราคา", "แก้จำนวน", "แก้บรรทัด", "แก้เลข",
      "แก้ไขข้อ", "ผิดข้อ", "พิมพ์ผิด", "กรอกผิด", "ราคาผิด", "จำนวนผิด",
    ],
    answerThai: [
      "แก้ได้ตอนที่ยังไม่จบรายการครับ",
      "พิมพ์ “แก้ข้อ” ตามด้วยเลขข้อ เช่น “แก้ข้อ 2”",
      "แล้วส่งสินค้าข้อนั้นใหม่ให้ครบ ทั้งชื่อ ราคา จำนวน และหน่วย",
      "ข้ออื่นยังอยู่ครบ ไม่ต้องส่งใหม่",
      "แก้เสร็จแล้วพิมพ์คำสั่งจบรายการตามปกติ",
    ].join("\n"),
    examples: ["แก้ข้อ 2", "2. กล้วยหอม 35 บาท\n12 หวี"],
    sourceRefs: [
      "src/lib/parsers/weigh-session/draft-item-command.ts#CORRECT_ITEM",
      "src/lib/parsers/weigh-session/draft-item-command.ts#buildDraftItemActionReply",
      "src/lib/parsers/weigh-session/parser-correction.test.ts#explicit same-draft item correction",
      "src/lib/line/webhook-service.ts#findDraftItemCommand",
    ],
    caveats: [
      "ส่งรายการข้อใหม่ไม่ครบ ระบบจะไม่เปลี่ยนข้อเดิมและให้พิมพ์ “แก้ข้อ” ใหม่",
      "ถ้าไม่พบเลขข้อนั้น ระบบแจ้งว่าไม่พบและรายการเดิมไม่เปลี่ยน",
      "ถ้ามีเลขข้อซ้ำ ให้ใช้เลขข้อตามที่ระบบแสดงล่าสุด",
      "ใช้ได้เฉพาะรายการที่ยังไม่จบ ถ้าบันทึกไปแล้วดูหัวข้อแก้รายการที่ปิดแล้ว",
    ],
  },
  {
    id: "item_deletion",
    titleThai: "ลบข้อที่ส่งเกินก่อนจบรายการ",
    keywords: [
      "ลบข้อ", "ลบรายการ", "ลบบรรทัด", "ลบสินค้า", "เอาข้อออก",
      "ตัดข้อ", "ใส่เกิน", "ใส่ผิดข้อ", "ลบทิ้ง",
    ],
    answerThai: [
      "ลบได้ตอนที่ยังไม่จบรายการครับ",
      "พิมพ์ “ลบข้อ” ตามด้วยเลขข้อ เช่น “ลบข้อ 3”",
      "บอทจะตอบว่าลบแล้ว และข้ออื่นยังอยู่ครบ",
      "ลบเสร็จแล้วพิมพ์คำสั่งจบรายการตามปกติ",
    ].join("\n"),
    examples: ["ลบข้อ 3"],
    sourceRefs: [
      "src/lib/parsers/weigh-session/draft-item-command.ts#REMOVE_ITEM",
      "src/lib/parsers/weigh-session/draft-item-command.ts#buildDraftItemActionReply",
      "src/lib/parsers/weigh-session/parser-correction.test.ts#removes exactly one item",
    ],
    caveats: [
      "หลังลบ ข้อที่อยู่ถัดไปอาจถูกเรียงเลขใหม่ ให้ดูเลขล่าสุดที่บอทแสดงก่อนสั่งแก้หรือลบข้ออื่น",
      "ถ้าไม่พบเลขข้อนั้น ระบบแจ้งว่าไม่พบและรายการเดิมไม่เปลี่ยน",
      "ใช้ได้เฉพาะรายการที่ยังไม่จบ ถ้าบันทึกไปแล้วดูหัวข้อแก้รายการที่ปิดแล้ว",
    ],
  },
  {
    id: "wrong_product_name",
    titleThai: "พิมพ์ชื่อสินค้าผิด",
    keywords: [
      "ชื่อผัก", "ชื่อสินค้า", "ชื่อผลไม้", "ชื่อผิด", "พิมพ์ชื่อผิด",
      "สะกดผิด", "ชื่อสะกด", "ชื่อไม่ตรง", "ผักผิด", "ผลไม้ผิด",
    ],
    answerThai: [
      "ถ้ายังไม่จบรายการ แก้ได้เลยครับ",
      "พิมพ์ “แก้ข้อ” ตามด้วยเลขข้อที่ชื่อผิด แล้วส่งข้อนั้นใหม่ด้วยชื่อที่ถูก",
      "ชื่อตอนเบิกสำคัญ เพราะตอนชั่งคืนต้องใช้ชื่อเดียวกัน",
      "ถ้าจบรายการและบันทึกไปแล้ว ดูหัวข้อแก้รายการที่ปิดแล้ว หรือแจ้งผู้ดูแล",
    ].join("\n"),
    examples: ["แก้ข้อ 1", "1. มังคุด 45 บาท\n10 โล"],
    sourceRefs: [
      "src/lib/parsers/weigh-session/draft-item-command.ts#CORRECT_ITEM",
      "src/lib/parsers/weigh-session/parser-correction.test.ts#replaces a misspelled product",
      "src/lib/produce/entry-validation.ts#vocabularyExceptions",
      "src/lib/produce/product-vocabulary.ts#resolveApprovedProductName",
    ],
    caveats: [
      "ตอนเบิก ถ้าชื่อไม่ตรงกับชื่อมาตรฐาน ระบบไม่หยุดและไม่ถามพนักงาน แต่บันทึกตามที่พิมพ์และแจ้งผู้ดูแลตรวจภายหลัง จึงต้องสังเกตเองก่อนจบรายการ",
      "บางชื่อที่สะกดต่างกันเล็กน้อยและผู้ดูแลตรวจไว้แล้ว ระบบรวมให้เอง ไม่ต้องแก้",
      "ถ้าชื่อตอนชั่งคืนไม่ตรงกับตอนเบิก ระบบยังบันทึก แต่ยอดคงเหลือของสินค้านั้นอาจไม่ตรง ควรแก้ให้ตรงก่อนจบรายการ",
    ],
  },
  {
    id: "close_submission",
    titleThai: "จบรายการ",
    keywords: [
      "จบรายการ", "ปิดรายการ", "วิธีจบ", "จบเอกสาร", "ส่งจบ",
      "จบรายการเบิก", "จบรายการชั่งคืน", "จบรายการคืนเสีย", "ปิดรายการยังไง",
    ],
    answerThai: [
      "ส่งสินค้าครบทุกข้อแล้ว ให้พิมพ์คำสั่งจบรายการครับ",
      "เบิก: “จบรายการเบิก”  ชั่งคืน: “จบรายการชั่งคืน”  คืนเสีย: “จบรายการคืนเสีย”",
      "ต้องตรงกับประเภทในหัวรายการ ถ้าไม่ตรงบอทจะไม่ปิดและบอกคำสั่งที่ถูกให้",
      "ถ้าเปิดรายการจากเมนู พิมพ์ “จบรายการ” หรือกดปุ่มจบรายการ",
    ].join("\n"),
    examples: ["จบรายการเบิก", "จบรายการชั่งคืน", "จบรายการคืนเสีย", "จบรายการ"],
    sourceRefs: [
      "src/lib/parsers/weigh-session/main-closer.ts#mainCloserCompatibility",
      "src/lib/parsers/weigh-session/main-closer.ts#mainCloserRefusal",
      "src/lib/parsers/weigh-session/regex.ts#SESSION_END_COUNT",
      "src/lib/line/pending-produce-recovery.ts#incompleteCloserReply",
      "src/lib/line/guided-menu/ux-handler.ts#isExactGuidedCloseTrigger",
      "src/lib/line/webhook-service.ts#STRUCTURED_TEXT_CLOSE_REFUSED_REPLY",
    ],
    caveats: [
      "รายการที่เปิดจากเมนูปิดด้วยคำว่า “จบรายการ” คำเดียวเท่านั้น หรือกดปุ่ม จะปิดด้วย “จบรายการเบิก” ไม่ได้",
      "พิมพ์คำสั่งปิดไม่ครบ เช่น “จบราย” บอทจะไม่ปิดและบอกคำสั่งที่ครบให้",
      "มีรูปแบบ “จบรายการ 2 รายการ” (บอกจำนวนข้อ) อยู่จริง แต่ถ้าจำนวนไม่ตรงกับที่ระบบรับ ระบบจะรอแล้วไม่บันทึกเมื่อหมดเวลา จึงไม่แนะนำให้พนักงานใช้",
      "หลังพิมพ์จบรายการ ดูหัวข้อสิ่งที่เกิดหลังจบรายการ",
    ],
  },
  {
    id: "after_close_confirmation",
    titleThai: "หลังพิมพ์จบรายการ",
    keywords: [
      "จบรายการแล้ว", "หลังจบรายการ", "จบแล้วต้อง", "รับจบรายการ",
      "กำลังตรวจสอบ", "บันทึกแล้ว", "ยืนยันจบรายการ", "ยืนยันข้อ",
      "ต้องยืนยัน", "ขอให้ยืนยัน", "ตรวจสอบรายการ",
      "รอสักครู่", "ดูสถานะ", "ที่ต้องแก้",
    ],
    answerThai: [
      "หลังพิมพ์จบรายการ บอทจะตอบว่ารับจบรายการแล้วและกำลังตรวจสอบ รอสักครู่ครับ",
      "ถ้าไม่มีอะไรผิด บอทจะส่งสรุปที่ขึ้นว่า “บันทึกแล้ว” ถึงจะถือว่าบันทึกเรียบร้อย",
      "ถ้ามีข้อที่ต้องแก้หรือต้องยืนยัน บอทจะบอกว่าข้อไหน รายการอื่นยังอยู่ครบ",
      "ให้แก้หรือยืนยันตามที่บอทบอก แล้วพิมพ์จบรายการอีกครั้ง",
      "ยังไม่เห็น “บันทึกแล้ว” อย่าเพิ่งทำขั้นต่อไป",
    ].join("\n"),
    examples: ["ยืนยันข้อ 2", "จบรายการเบิก"],
    sourceRefs: [
      "src/lib/line/webhook-service.ts#PRODUCE_CLOSE_PENDING_REPLY",
      "src/lib/line/reply.ts#บันทึกแล้ว",
      "src/lib/produce/entry-validation-message.ts#buildBlockingValidationReply",
      "src/lib/produce/entry-validation-message.ts#buildPlainTextReviewValidationReply",
      "src/lib/parsers/weigh-session/draft-item-command.ts#CONFIRM_SUBUNIT",
      "src/lib/line/pending-session-finalizer.ts#buildReviewNotConfirmedMessage",
      "src/lib/line/guided-menu/ux-types.ts#produceFinalizing",
    ],
    caveats: [
      "ที่ระบบให้ยืนยันได้ตอนนี้คือสินค้าที่ใส่หน่วย ขีด หรือ กรัม ให้พิมพ์ “ยืนยันข้อ” ตามเลขข้อที่บอทบอก ถ้าไม่ถูกต้องให้ “แก้ข้อ” แล้วพิมพ์จบรายการอีกครั้ง",
      "ที่ต้องแก้ก่อนจบเกิดเมื่อหน่วยไม่รู้จัก หรืออ่านบรรทัดไม่ได้ ระบบจะเก็บข้อที่อ่านได้ไว้ แก้เฉพาะข้อที่บอกแล้วพิมพ์จบรายการอีกครั้ง",
      "รายการที่เปิดจากเมนู ให้กดปุ่มยืนยันที่บอทแสดงและกด “ดูสถานะ” เพื่อตรวจผล อย่าเพิ่งกรอกใบขาวจนกว่าจะขึ้นว่าบันทึกเรียบร้อย",
      "ถ้าบอทขอให้ยืนยันแล้วไม่ยืนยันจนหมดเวลา ระบบจะไม่บันทึกและแจ้งว่าหมดเวลารอการยืนยัน ให้แจ้งผู้ดูแล",
      "ราคาที่ต่างจากตอนเบิกไม่ทำให้ติด ระบบบันทึกแล้วแจ้งเตือนทีหลัง",
    ],
  },
  {
    id: "cancel_open_draft",
    titleThai: "ยกเลิกรายการที่เปิดผิด",
    keywords: [
      "ยกเลิกรายการ", "ยกเลิกเอกสาร", "เปิดผิด", "เปิดรายการผิด", "ทิ้งรายการ",
      "เริ่มใหม่", "ลบทั้งหมด", "ผิดตลาด", "ผิดวันที่", "ผิดคนขาย", "ยกเลิก",
    ],
    answerThai: [
      "ถ้าเปิดรายการผิดและยังไม่ได้จบรายการ พิมพ์ “ยกเลิกรายการ” ได้เลยครับ",
      "ระบบจะทิ้งรายการที่กำลังกรอก และยังไม่มีข้อมูลจากรายการนั้นถูกบันทึก",
      "แล้วเริ่มรายการใหม่ได้ทันที",
    ].join("\n"),
    examples: ["ยกเลิกรายการ"],
    sourceRefs: [
      "src/lib/produce/cancel-active-draft.ts#CANCEL_ACTIVE_DRAFT_COMMAND",
      "src/lib/produce/cancel-active-draft.ts#isExactCancelActiveDraftCommand",
      "src/lib/produce/cancel-active-draft.ts#CANCEL_ACTIVE_DRAFT_SUCCESS_REPLY",
      "supabase/migrations/20260818034244_produce_cancel_active_pending_draft.sql#close_in_progress",
      "src/lib/line/guided-menu/ux-handler.ts#isExactGuidedCancelTrigger",
    ],
    caveats: [
      "ใช้ได้เฉพาะตอนที่ยังไม่ได้พิมพ์จบรายการ หลังจบรายการและบอทรับแล้ว บอทจะตอบว่ายกเลิกไม่สำเร็จ",
      "ยกเลิกรายการที่บันทึกแล้วไม่ได้ ให้ดูหัวข้อแก้รายการที่ปิดแล้ว",
      "ยกเลิกได้เฉพาะรายการของตัวเอง คนอื่นในกลุ่มยกเลิกแทนไม่ได้",
      "คำว่า “ยกเลิก” หรือ “ออกจากเมนู” เป็นแค่การปิดเมนู ไม่ได้ยกเลิกรายการที่เปิดอยู่",
      "ถ้าบอทตอบว่ายังไม่เปิดใช้คำสั่งนี้ ให้กรอกรายการต่อหรือแจ้งผู้ดูแล",
    ],
  },
  {
    id: "correct_finalized_document",
    titleThai: "แก้รายการที่บันทึกแล้ว",
    keywords: [
      "แก้ไขรายการที่ปิดแล้ว", "รายการที่ปิดแล้ว", "บันทึกแล้วแก้", "แก้หลังบันทึก",
      "แก้หลังจบ", "จบไปแล้วแก้", "ปิดแล้วแก้", "แก้รายการเก่า", "แก้เอกสารเก่า",
      "จบแล้วแก้", "บันทึกไปแล้ว",
    ],
    answerThai: [
      "ถ้าบันทึกไปแล้วและต้องแก้ ให้เปิดหัวรายการเดิมให้ตรงทุกช่อง (คนขาย ตลาด วันที่ ประเภท) ครับ",
      "ยังไม่ต้องใส่สินค้า แล้วพิมพ์ “แก้ไขรายการที่ปิดแล้ว”",
      "บอทจะนำรายการเดิมมาใส่ให้ ให้แก้ด้วย “แก้ข้อ” หรือ “ลบข้อ”",
      "แก้เสร็จพิมพ์คำสั่งจบรายการประเภทเดิม ฉบับใหม่จะมาแทนฉบับเดิมเมื่อบันทึกสำเร็จ",
    ].join("\n"),
    examples: ["กี้-พาซิโอ้ เบิก 8/10/2569", "แก้ไขรายการที่ปิดแล้ว"],
    sourceRefs: [
      "src/lib/produce/replacement-draft.ts#REPLACE_FINALIZED_SESSION_COMMAND",
      "src/lib/produce/replacement-draft.ts#canStartReplacementFrom",
      "src/lib/produce/replacement-draft.ts#findReplacementCandidate",
      "src/lib/produce/replacement-draft.ts#replacementDraftCommandReply",
    ],
    caveats: [
      "ใช้ได้กับรายการที่พิมพ์ข้อความเอง ไม่ใช่รายการที่เปิดจากเมนู",
      "ต้องเปิดหัวรายการแล้วส่งคำสั่งนี้ก่อนพิมพ์สินค้า ถ้าพิมพ์สินค้าไปแล้วระบบจะไม่เริ่มให้",
      "ใช้ได้กับรายการที่มีประเภทเดียว (เบิกล้วน ชั่งคืนล้วน หรือคืนเสียล้วน)",
      "ถ้าไม่พบรายการเดิมที่ตรงกัน หรือพบหลายรายการ ระบบจะไม่เลือกให้ ต้องแจ้งผู้ดูแล",
      "หัวรายการต้องตรงกับรายการเดิมทุกช่อง ไม่เช่นนั้นระบบหาไม่เจอ",
    ],
  },
  {
    id: "recover_unsaved_messages",
    titleThai: "กู้ข้อความที่ยังไม่ถูกบันทึก",
    keywords: [
      "กู้รายการ", "กู้รายการล่าสุด", "กู้ข้อความ", "ข้อความค้าง",
      "ข้อความที่ยังไม่ถูกบันทึก", "ส่งก่อนหัว", "ก่อนเปิดหัว",
      "ส่งหลังปิด", "ส่งสินค้าก่อนเปิด",
    ],
    answerThai: [
      "ถ้าบอทแจ้งว่ามีข้อความที่ยังไม่ถูกบันทึก ข้อมูลยังเก็บไว้ ไม่ต้องพิมพ์ใหม่ครับ",
      "เกิดเมื่อส่งสินค้าก่อนเปิดหัวรายการ หรือส่งหลังปิดรายการไปแล้ว",
      "ให้เปิดหัวรายการใหม่ให้ถูกต้องก่อน",
      "แล้วพิมพ์ “กู้รายการล่าสุด” บอทจะใส่ข้อความที่เก็บไว้เข้ารายการให้",
    ].join("\n"),
    examples: ["กู้รายการล่าสุด"],
    sourceRefs: [
      "src/lib/line/pending-produce-recovery.ts#RECOVER_LATEST_COMMAND",
      "src/lib/line/pending-produce-recovery.ts#boundaryRejectReply",
      "src/lib/line/pending-produce-recovery.ts#recoverCommandReply",
      "src/lib/line/pending-produce-recovery.ts#canRecoverIntoSession",
    ],
    caveats: [
      "ต้องมีหัวรายการที่เปิดอยู่ และหัวต้องเข้ากับรายการเดิม (ตลาดและประเภท)",
      "ถ้ามีข้อความค้างหลายกลุ่ม ระบบไม่เลือกให้ ข้อมูลยังอยู่ ต้องแจ้งผู้ดูแล",
      "ข้อความที่เก็บไว้มีอายุจำกัด ควรทำทันทีที่บอทแจ้ง",
    ],
  },
  {
    id: "guided_menu",
    titleThai: "เมนูปุ่มกด",
    keywords: [
      "เมนู", "ปุ่ม", "กดปุ่ม", "เลือกคนขาย", "เปิดจากเมนู", "เมนูหมดอายุ",
      "ออกจากเมนู",
    ],
    answerThai: [
      "พิมพ์ “เมนู” เพื่อให้บอทแสดงปุ่มเลือกครับ",
      "เลือกประเภท (เบิก ชั่งคืน คืนเสีย) คนขาย ตลาด และวันที่ แล้วยืนยันเปิดรายการ",
      "จากนั้นส่งสินค้าได้เลย ไม่ต้องพิมพ์หัวรายการ",
      "ครบแล้วกด “จบรายการ” แล้วกด “ยืนยันจบรายการ”",
      "ต่อจากนั้นบอทจะพาไปกรอกใบขาว ส่งสลิป และปิดรอบ",
    ].join("\n"),
    examples: ["เมนู"],
    sourceRefs: [
      "src/lib/line/guided-menu/ux-types.ts#GUIDED_MENU_TRIGGER",
      "src/lib/line/guided-menu/ux-types.ts#GUIDED_MENU_COPY",
      "src/lib/line/guided-menu/ux-handler.ts#isExactGuidedMenuTrigger",
      "docs/guided-operations-end-to-end.md",
    ],
    caveats: [
      "บัญชีไลน์ที่ยังไม่ได้รับสิทธิ์จะใช้เมนูไม่ได้ บอทจะบอกให้ติดต่อผู้ดูแล",
      "ปุ่มมีอายุจำกัด ถ้าบอทบอกว่าเมนูหมดอายุ ให้พิมพ์ “เมนู” ใหม่",
      "ถ้ามีรายการเปิดค้างอยู่แล้ว เปิดรายการใหม่ไม่ได้ ต้องจบรายการเดิมก่อน",
      "ถ้าเมนูมีคนขายหรือตลาดไม่ครบ ให้แจ้งผู้ดูแล",
    ],
  },
  {
    id: "slip_transfer",
    titleThai: "ส่งสลิปเงินโอน",
    keywords: [
      "ส่งสลิป", "สลิป", "สลิปเงินโอน", "สลิปโอน", "จบสลิป", "เปิดชุดสลิป",
      "โอนเงิน", "รูปสลิป", "ชุดสลิป",
    ],
    answerThai: [
      "เปิดชุดสลิปด้วยข้อความหัวชุด: ชื่อคนขาย-ตลาด สลิปเงินโอน วันที่ ครับ",
      "บอทตอบว่าเปิดชุดสลิปแล้ว ให้ส่งรูปสลิปตามได้เลย",
      "ส่งครบแล้วพิมพ์ “จบสลิป”",
      "บอทจะตรวจสลิปทั้งหมดแล้วส่งสรุปให้ ใช้เวลาสักครู่",
    ].join("\n"),
    examples: ["กี้-พาซิโอ้ สลิปเงินโอน 8/10/2569", "จบสลิป"],
    sourceRefs: [
      "src/lib/slips/slip-session-service.ts#SLIP_OPEN_DASH_RE",
      "src/lib/slips/slip-session-service.ts#SLIP_CLOSE_RE",
      "src/lib/slips/slip-session-service.ts#parseSlipSessionHeader",
      "src/lib/line/webhook-service.ts#processSlipOpen",
      "src/lib/line/webhook-service.ts#processSlipClose",
      "src/lib/line/guided-menu/ux-types.ts#slipOpenWhiteSheetMissing",
    ],
    caveats: [
      "คำปิดชุดที่รับได้: “จบสลิป” “สรุปสลิป” “ปิดชุดสลิป” “จบชุดสลิป”",
      "ถ้ามีชุดสลิปเปิดค้างอยู่ เปิดชุดใหม่ไม่ได้ ต้องพิมพ์ “จบสลิป” ก่อน",
      "ถ้าเริ่มจากเมนู ต้องบันทึกใบขาวของรอบนั้นก่อนจึงเปิดชุดสลิปได้ และหัวชุดต้องตรงกับรอบที่เปิด",
      "สลิปที่บอทอ่านไม่ได้ ให้ใช้สลิปมือ",
      "สรุปสลิปไม่ได้มาทันที บอทตอบรับก่อนแล้วส่งสรุปตามมา",
    ],
  },
  {
    id: "slip_manual",
    titleThai: "สลิปมือ",
    keywords: [
      "สลิปมือ", "สลิปอ่านไม่ได้", "อ่านสลิปไม่ได้", "พิมพ์ยอดโอน", "ยอดสลิป",
      "จบสลิปมือ", "ส่งสลิปมือ",
    ],
    answerThai: [
      "สลิปที่บอทอ่านไม่ได้ ให้พิมพ์ยอดเองเป็นสลิปมือครับ",
      "เปิดด้วย “ส่งสลิปมือ” ตามด้วยวันที่ (จะใส่ชื่อตลาดนำหน้าก็ได้)",
      "ส่งยอดทีละบรรทัด เช่น “1. 100 บาท”",
      "ครบแล้วพิมพ์ “จบสลิปมือ” บอทจะบอกยอดรวม",
    ].join("\n"),
    examples: ["พาซิโอ้ ส่งสลิปมือ 8/10/2569", "1. 100 บาท\n2. 300 บาท", "จบสลิปมือ"],
    sourceRefs: [
      "src/lib/parsers/weigh-session/regex.ts#MANUAL_SLIP_OPEN",
      "src/lib/parsers/weigh-session/regex.ts#MANUAL_SLIP_CLOSE",
      "src/lib/parsers/manual-slip-amount.ts#parseManualSlipAmounts",
      "src/lib/line/webhook-service.ts#processManualSlipOpen",
    ],
    caveats: [
      "ถ้ามีสลิปมือของตลาดอื่นเปิดค้างอยู่ ต้องพิมพ์ “จบสลิปมือ” ก่อนเปิดตลาดใหม่",
      "สลิปมือที่ปิดแล้ว เปิดใหม่ในวันและตลาดเดิมไม่ได้",
      "วันที่ต้องเป็นรูปแบบวัน/เดือน/ปี พ.ศ. เช่น 8/10/2569",
    ],
  },
  {
    id: "settlement_close",
    titleThai: "ส่งยอดและปิดรอบ",
    keywords: [
      "ส่งยอด", "ปิดรอบ", "ยอดส่ง", "ส่งเงิน", "ยอดโอน", "สรุปยอดส่ง",
      "ปิดรอบยังไง", "จบส่งยอด",
    ],
    answerThai: [
      "หลังตรวจสลิปครบ ให้ส่งยอดส่งของรอบด้วยแบบฟอร์มที่บอทให้ แก้เฉพาะตัวเลขครับ",
      "แบบฟอร์มขึ้นต้นด้วย “ชื่อคนขาย ตลาด ส่งยอด วันที่” และจบด้วย “จบส่งยอด”",
      "ต้องมีครบ 4 บรรทัด: ยอดโอน เงินสด ค่าใช้จ่าย ค่าแรง ไม่มียอดใส่ 0",
      "เมื่อบอทบอกให้ปิดรอบ พิมพ์ “ปิดรอบ”",
    ].join("\n"),
    examples: [
      "กี้ พาซิโอ้ ส่งยอด 8/10/2569\nยอดโอน 1200\nเงินสด 800\nค่าใช้จ่าย 100\nค่าแรง 300\nจบส่งยอด",
      "ปิดรอบ",
    ],
    sourceRefs: [
      "src/lib/line/guided-menu/settlement-command.ts#parseGuidedSettlementCommand",
      "src/lib/line/guided-menu/journey-bridge.ts#isGuidedRoundCloseCommand",
      "src/lib/line/guided-menu/ux-types.ts#roundCloseCommand",
      "src/lib/line/guided-menu/ux-types.ts#ownershipUseTemplate",
    ],
    caveats: [
      "ให้คัดลอกแบบฟอร์มที่บอทส่งให้ ไม่ควรพิมพ์เอง เพราะฟอร์มที่ไม่ใช่ของรอบนี้อาจถูกปฏิเสธ",
      "ต้องจบรายการสินค้า กรอกใบขาว และปิดชุดสลิปให้เรียบร้อยก่อน ไม่เช่นนั้นบอทจะบอกว่าขั้นไหนยังไม่เสร็จ",
      "รอบที่ปิดและส่งสรุปไปแล้ว แก้ยอดผ่านไลน์ไม่ได้ ต้องติดต่อผู้ดูแล",
    ],
  },
  {
    id: "white_sheet_entry",
    titleThai: "ใบขาว",
    keywords: [
      "ใบขาว", "กรอกใบขาว", "ส่งใบขาว", "ปิดยอด", "จบปิดยอด", "ยอดขาย",
      "เงินให้เจ้า", "ค่าแรง", "ค่าขนม", "ค่าถุง",
    ],
    answerThai: [
      "ใบขาวคือยอดขายและค่าใช้จ่ายของตลาดในวันนั้น ส่งเป็นข้อความตามแบบฟอร์มครับ",
      "ถ้าเริ่มจากเมนู กดปุ่ม “กรอกใบขาว” แล้วคัดลอกแบบฟอร์มที่บอทให้ แก้เฉพาะตัวเลข",
      "แบบฟอร์มขึ้นต้นด้วย “ตลาด ปิดยอด วันที่” และจบด้วย “จบปิดยอด”",
      "ต้องมี ยอดขาย เงินให้เจ้า และเงินสด ส่วนค่าอื่นที่ไม่มีใส่ 0",
      "การส่งรูปใบขาวให้บอทอ่านเป็นแค่ตัวช่วยตรวจ ยังไม่บันทึก",
    ].join("\n"),
    examples: [
      "พาซิโอ้ ปิดยอด 8/10/2569\nยอดขาย 5000\nเงินให้เจ้า 3000\nค่าแรง 300\nค่าที่ 50\nค่าถุง 20\nค่าขนม 30\nค่าอื่น 0\nเงินสด 4850\nจบปิดยอด",
    ],
    sourceRefs: [
      "src/lib/line/white-sheet-close-command.ts#parseWhiteSheetCloseCommand",
      "src/lib/line/guided-menu/journey.ts#buildWhiteSheetTemplate",
      "src/lib/line/guided-menu/ux-types.ts#whiteSheetInstructions",
      "src/lib/line/guided-menu/ux-types.ts#whiteSheetFinalized",
    ],
    caveats: [
      "ใบขาวที่ถูกยืนยันแล้ว แก้ผ่านไลน์ไม่ได้ ต้องติดต่อผู้ดูแล",
      "ถ้าเริ่มจากเมนู ต้องจบรายการสินค้าให้เรียบร้อยก่อนจึงกรอกใบขาวได้",
      "ตัวเลขต้องเป็นจำนวนเงินไม่ติดลบ ทศนิยมไม่เกิน 2 ตำแหน่ง",
      "ห้ามมีบรรทัดอื่นที่ระบบไม่รู้จักในข้อความเดียวกัน ถ้ามีบอทจะบอกบรรทัดที่อ่านไม่ได้และยังไม่บันทึก",
    ],
  },
  {
    id: "white_sheet_manual",
    titleThai: "ใบขาวมือ",
    keywords: [
      "ใบขาวมือ", "ส่งใบขาวมือ", "จบใบขาวมือ", "ยกเลิกใบขาวมือ", "ใบขาวหลายข้อความ",
    ],
    answerThai: [
      "ใบขาวมือใช้ส่งค่าใช้จ่ายทีละข้อความครับ",
      "เปิดด้วย “ชื่อตลาด ส่งใบขาวมือ วันที่”",
      "ส่งค่าใช้จ่ายได้เลย เช่น “ค่าแรง 500”",
      "ครบแล้วพิมพ์ “จบใบขาวมือ” หรือถ้าไม่เอาพิมพ์ “ยกเลิกใบขาวมือ”",
    ].join("\n"),
    examples: [
      "พาซิโอ้ ส่งใบขาวมือ 8/10/2569",
      "ค่าแรง 500",
      "จบใบขาวมือ",
      "ยกเลิกใบขาวมือ",
    ],
    sourceRefs: [
      "src/lib/line/white-sheet-note-command.ts#parseWhiteSheetNoteCommand",
      "src/lib/line/white-sheet-note-command.ts#OPEN_RE",
      "src/lib/line/webhook-service.ts#WHITE_SHEET_NOTE_FINALIZED_REPLY",
    ],
    caveats: [
      "หัวข้อที่ใช้ได้: ค่าแรง ค่าที่ ค่าถุง ค่าขนม ค่าอื่น เงินสด ยอดขาย เงินให้เจ้า",
      "ต้องส่งอย่างน้อย 1 รายการก่อนจึงจะจบใบขาวมือได้",
      "ถ้ามีใบขาวมือเปิดค้างอยู่ ต้องจบหรือยกเลิกก่อนเปิดใบใหม่",
      "ใบขาวที่ถูกยืนยันแล้ว แก้ผ่านไลน์ไม่ได้ ต้องติดต่อผู้ดูแล",
    ],
  },
  {
    id: "white_sheet_vision_preview",
    titleThai: "ให้บอทอ่านรูปใบขาว (ตัวอย่างตรวจ)",
    keywords: [
      "อ่านใบขาว", "อ่านรูปใบขาว", "ถ่ายรูปใบขาว", "รูปใบขาว", "ส่งรูปใบขาว",
      "ใบขาวจากรูป", "จบใบขาว", "ยกเลิกอ่านใบขาว", "ผลอ่านใบขาว",
    ],
    answerThai: [
      "บอทอ่านรูปใบขาวให้ตรวจได้ แต่ยังไม่บันทึกลงระบบครับ",
      "พิมพ์ “@Botsummary อ่านใบขาว” แล้วส่งรูปใบขาวทีละใบ",
      "ถ้าบอทอ่านผิด พิมพ์แก้เป็นภาษาปกติ เช่น “ค่าแรง 300”",
      "ถูกแล้วพิมพ์ “ผ่าน” เพื่อไปใบถัดไป",
      "เสร็จแล้วพิมพ์ “@Botsummary จบใบขาว” หรือ “@Botsummary ยกเลิกอ่านใบขาว”",
    ].join("\n"),
    examples: [
      "@Botsummary อ่านใบขาว",
      "ผ่าน",
      "@Botsummary จบใบขาว",
      "@Botsummary ยกเลิกอ่านใบขาว",
    ],
    sourceRefs: [
      "docs/white-sheet-vision-preview.md",
      "src/lib/white-sheet-reader/mode.ts#whiteSheetReadCommand",
      "src/lib/white-sheet-reader/mode.ts#isWhiteSheetApproval",
      "src/lib/white-sheet-reader/reader.ts#PREVIEW_START_REPLY",
      "src/lib/white-sheet-reader/reader.ts#PREVIEW_DISCLAIMER",
      "src/lib/ai/line-command.ts#extractBotSummaryQuestion",
    ],
    caveats: [
      "ผลที่อ่านได้เป็นแค่ตัวอย่างให้ตรวจ ไม่ถูกบันทึก ต้องกรอกใบขาวจริงด้วยแบบฟอร์มปิดยอดหรือใบขาวมืออีกครั้ง",
      "ใช้ได้เฉพาะในกลุ่มไลน์ที่เปิดให้ใช้ ถ้าบอทตอบว่ายังไม่เปิดใช้งานในแชทนี้ ให้แจ้งผู้ดูแล",
      "ส่งได้ทีละ 1 ใบ และต้องผ่านหรือยกเลิกใบที่รอตรวจก่อนจึงส่งใบถัดไป",
      "ถ้าเงียบเกิน 10 นาทีโหมดจะหมดเวลา ต้องพิมพ์ “@Botsummary อ่านใบขาว” ใหม่",
      "ระหว่างอยู่ในโหมดนี้ ให้จบโหมดก่อนส่งสลิปหรือรูปอื่น",
    ],
  },
  {
    id: "common_replies",
    titleThai: "ข้อความที่บอทตอบ แปลว่าอะไร",
    keywords: [
      "บอทตอบ", "ข้อความที่บอทตอบ", "หมายความว่า", "แปลว่า", "ขึ้นว่า",
      "ตอบว่า", "ไม่บันทึกซ้ำ", "บันทึกไว้แล้ว", "ไม่พบรอบเบิก", "ตลาดไม่ตรง",
      "ชื่อตลาด", "คำสั่งปิดรายการไม่ครบ", "รับรายการแล้ว",
    ],
    answerThai: [
      "“รับจบรายการแล้ว กำลังตรวจสอบ” คือบอทรับคำสั่งแล้ว รอสักครู่ ยังไม่ใช่บันทึกเสร็จครับ",
      "“บันทึกแล้ว” พร้อมสรุปรายการ คือบันทึกเรียบร้อย",
      "“มีรายการที่ต้องแก้” คือยังไม่ได้จบ แก้ข้อที่บอกแล้วพิมพ์จบรายการอีกครั้ง",
      "“รับรายการแล้ว รายการอื่นเก็บไว้แล้ว” คือข้อที่อ่านได้เก็บไว้แล้ว ไม่ต้องส่งใหม่ แก้เฉพาะข้อที่บอก",
      "“พบรายการนี้ถูกบันทึกไว้แล้ว” คือมีข้อมูลนี้อยู่แล้ว ไม่ต้องส่งซ้ำ",
      "“ไม่พบรอบเบิก” หรือ “ตลาดไม่ตรง” คือยังไม่บันทึก ตรวจชื่อตลาดและวันที่ให้ตรงกับตอนเบิก แล้วส่งใหม่",
    ].join("\n"),
    examples: [],
    sourceRefs: [
      "src/lib/line/webhook-service.ts#PRODUCE_CLOSE_PENDING_REPLY",
      "src/lib/line/reply.ts#บันทึกแล้ว",
      "src/lib/produce/partial-capture.ts#buildPartialCaptureSavedReply",
      "src/lib/produce/partial-capture.ts#buildPartialCaptureReviewReply",
      "src/lib/line/pending-session-finalizer.ts#buildBusinessDuplicateMessage",
      "src/lib/produce/plain-text-round-binding.ts#NO_ROUND_REPLY",
      "src/lib/produce/plain-text-round-binding.ts#marketNearMatchReply",
    ],
    caveats: [
      "“คำสั่งปิดรายการไม่ครบ” คือพิมพ์คำปิดไม่ครบ ให้พิมพ์ตามที่บอทบอก ข้อมูลเดิมยังอยู่ครบ",
      "“มีรายการส่งเข้ามาเพิ่มพอดีตอนปิดรอบ” คือยังไม่ปิด ข้อมูลครบ ให้พิมพ์คำสั่งปิดอีกครั้ง",
      "“รายการเบิกชุดนี้มีรายการซ้ำกับชุดที่บันทึกไว้แล้ว” คือไม่ได้บันทึก ถ้ามีของเพิ่มให้ส่งเฉพาะของเพิ่มด้วย “เบิกเพิ่ม” ถ้ารายการเดิมผิดให้แจ้งผู้ดูแล",
      "“พบรายการเดิมที่ยังปิดไม่สมบูรณ์ ให้ทีมงานเคลียร์” คือต้องให้ผู้ดูแลจัดการรายการเดิมก่อน เริ่มรายการใหม่ไม่ได้",
      "“หมดเวลารอ” หรือ “จึงไม่บันทึกรายการ” ดูหัวข้อรอบปิดแล้วไม่บันทึก",
    ],
  },
  {
    id: "failed_round_recovery",
    titleThai: "รอบปิดแล้วแต่ไม่บันทึก",
    keywords: [
      "รายการหาย", "หายไป", "ไม่ขึ้นบันทึก", "ไม่ได้บันทึก", "ไม่บันทึก",
      "ปิดรอบแล้วไม่บันทึก", "บันทึกไม่สำเร็จ", "หมดเวลา", "ไม่ถูกบันทึก",
      "ข้อมูลหาย", "กู้ข้อมูล", "แจ้งผู้ดูแล", "ติดต่อผู้ดูแล", "เคลียร์รายการเดิม",
      "รายการค้าง", "ปิดไม่สมบูรณ์",
    ],
    answerThai: [
      "ถ้ารายการหาย หรือบอทบอกว่าไม่บันทึก อย่าเพิ่งพิมพ์ซ้ำทั้งหมดครับ",
      "อ่านข้อความล่าสุดของบอทก่อน ถ้าบอกให้แก้ข้อไหน ให้แก้ตามนั้น",
      "ถ้าพิมพ์จบรายการไปแล้วแต่ไม่ขึ้น “บันทึกแล้ว” (เช่น หมดเวลา หรือบอกว่าไม่บันทึกรายการ) ให้แจ้งผู้ดูแลทันที",
      "บอกผู้ดูแลว่า คนขาย ตลาด วันที่ ประเภทรายการ และเวลาที่พิมพ์จบรายการ",
      "พนักงานไม่ต้องกู้เอง ผู้ดูแลจะตรวจข้อความที่ระบบเก็บไว้ให้",
    ].join("\n"),
    examples: [],
    sourceRefs: [
      "src/lib/line/pending-session-finalizer.ts#buildReviewNotConfirmedMessage",
      "src/lib/line/pending-session-finalizer.ts#buildMissingItemsMessage",
      "src/lib/line/webhook-service.ts#STALE_PRODUCE_SESSION_REPLY",
      "src/lib/line/guided-menu/ux-types.ts#produceFinalizeFailed",
      "src/lib/produce/failed-session-recovery.ts#planFailedSessionRecovery",
      "scripts/produce-recovery-dry-run.ts",
    ],
    caveats: [
      "ไม่มีคำสั่งไลน์ให้พนักงานกู้รอบที่ปิดแล้วไม่บันทึก ต้องผ่านผู้ดูแลเท่านั้น",
      "ฝั่งผู้ดูแลมีเครื่องมือตรวจดูรอบที่ปิดแล้วไม่บันทึก (ดูอย่างเดียว ไม่แก้ข้อมูล) ว่าตามกฎปัจจุบันบันทึกได้หรือไม่ การบันทึกกลับยังไม่มีขั้นตอนอัตโนมัติ ผู้ดูแลต้องส่งต่อทีมพัฒนา อย่าสัญญากับพนักงานว่าจะกู้ได้แน่นอน",
      "ข้อความที่พนักงานส่งมาถูกเก็บไว้ ไม่ได้หายเพียงเพราะไม่ขึ้นบันทึกแล้ว แต่ก็ไม่ควรบอกว่าบันทึกแล้วจนกว่าจะเห็นข้อความ “บันทึกแล้ว”",
      "ข้อความที่ส่งก่อนเปิดหัวรายการหรือหลังปิดรายการ ผู้ส่งกู้เองได้ด้วย “กู้รายการล่าสุด” ดูหัวข้อกู้ข้อความที่ยังไม่ถูกบันทึก",
    ],
  },
];

/**
 * How a worker performs each next step the consultant may suggest. Every id in
 * ConsultantActionId has a guide; if the system has no worker-run command for
 * an action, the guide says so and points to the admin instead of inventing one.
 */
export const CONSULTANT_ACTION_GUIDES: Record<ConsultantActionId, ConsultantActionGuide> = {
  correct_item_in_open_draft: {
    titleThai: "แก้ข้อที่ผิดในรายการที่ยังไม่จบ",
    howToThai:
      "พิมพ์ “แก้ข้อ” ตามด้วยเลขข้อ เช่น “แก้ข้อ 2” แล้วส่งสินค้าข้อนั้นใหม่ให้ครบ ทั้งชื่อ ราคา จำนวน และหน่วย ข้ออื่นไม่ต้องส่งใหม่ เสร็จแล้วพิมพ์คำสั่งจบรายการอีกครั้ง",
    sourceRefs: [
      "src/lib/parsers/weigh-session/draft-item-command.ts#CORRECT_ITEM",
      "src/lib/parsers/weigh-session/draft-item-command.ts#buildDraftItemActionReply",
    ],
  },
  remove_item_in_open_draft: {
    titleThai: "ลบข้อที่ส่งเกินในรายการที่ยังไม่จบ",
    howToThai:
      "พิมพ์ “ลบข้อ” ตามด้วยเลขข้อ เช่น “ลบข้อ 3” ข้ออื่นยังอยู่ครบ เสร็จแล้วพิมพ์คำสั่งจบรายการอีกครั้ง",
    sourceRefs: [
      "src/lib/parsers/weigh-session/draft-item-command.ts#REMOVE_ITEM",
      "src/lib/parsers/weigh-session/draft-item-command.ts#buildDraftItemActionReply",
    ],
  },
  send_close_again: {
    titleThai: "ส่งคำสั่งจบรายการอีกครั้ง",
    howToThai:
      "พิมพ์คำสั่งจบรายการให้ตรงกับประเภทของรายการ คือ “จบรายการเบิก” “จบรายการชั่งคืน” หรือ “จบรายการคืนเสีย” ถ้ารายการเปิดจากเมนู ให้พิมพ์ “จบรายการ” หรือกดปุ่มจบรายการ ข้อมูลเดิมยังอยู่ครบ ไม่ต้องส่งสินค้าใหม่",
    sourceRefs: [
      "src/lib/parsers/weigh-session/main-closer.ts#MAIN_SESSION_EXPECTED_CLOSER",
      "src/lib/line/guided-menu/ux-handler.ts#isExactGuidedCloseTrigger",
    ],
  },
  confirm_review: {
    titleThai: "ยืนยันข้อที่บอทขอให้ตรวจ",
    howToThai:
      "ดูข้อที่บอทบอกให้ตรวจ ถ้าถูกต้อง พิมพ์ “ยืนยันข้อ” ตามเลขข้อที่บอทบอก (ใช้กับสินค้าที่ใส่หน่วยขีดหรือกรัม) แล้วพิมพ์คำสั่งจบรายการอีกครั้งเพื่อยืนยัน รายการที่เปิดจากเมนู ให้กดปุ่มยืนยันที่บอทแสดง ถ้าไม่ถูกต้อง ให้พิมพ์ “แก้ข้อ” ตามเลขข้อแล้วส่งข้อนั้นใหม่",
    sourceRefs: [
      "src/lib/parsers/weigh-session/draft-item-command.ts#CONFIRM_SUBUNIT",
      "src/lib/produce/entry-validation-message.ts#buildPlainTextReviewValidationReply",
      "src/lib/produce/entry-validation-message.ts#buildReviewValidationReply",
    ],
  },
  wait_for_finalization: {
    titleThai: "รอบอทบันทึกให้เสร็จ",
    howToThai:
      "รอสักครู่ แล้วดูว่าบอทส่งข้อความที่ขึ้นว่า “บันทึกแล้ว” หรือไม่ รายการที่เปิดจากเมนูให้กด “ดูสถานะ” อย่าเพิ่งกรอกใบขาวหรือทำขั้นต่อไปจนกว่าจะบันทึกเรียบร้อย ไม่ต้องส่งรายการซ้ำ ถ้ารอนานผิดปกติหรือบอทแจ้งว่าไม่บันทึก ให้แจ้งผู้ดูแล",
    sourceRefs: [
      "src/lib/line/webhook-service.ts#PRODUCE_CLOSE_PENDING_REPLY",
      "src/lib/line/guided-menu/ux-types.ts#produceFinalizing",
    ],
  },
  contact_admin_recovery: {
    titleThai: "แจ้งผู้ดูแลให้ช่วยกู้รายการ",
    howToThai:
      "ไม่มีคำสั่งให้พนักงานกู้เองสำหรับรอบที่ปิดแล้วไม่บันทึก ให้แจ้งผู้ดูแลทันที พร้อมบอก คนขาย ตลาด วันที่ ประเภทรายการ และเวลาที่พิมพ์จบรายการ อย่าพิมพ์รายการทั้งหมดซ้ำจนกว่าผู้ดูแลจะบอก ผู้ดูแลจะตรวจข้อความที่ระบบเก็บไว้ให้",
    sourceRefs: [
      "src/lib/produce/failed-session-recovery.ts#planFailedSessionRecovery",
      "scripts/produce-recovery-dry-run.ts",
      "src/lib/line/guided-menu/ux-types.ts#produceFinalizeFailed",
    ],
  },
  nothing_needed: {
    titleThai: "ไม่ต้องทำอะไรเพิ่ม",
    howToThai:
      "รายการนี้บันทึกเรียบร้อยแล้ว ไม่ต้องส่งซ้ำ ถ้าส่งซ้ำ บอทจะตอบว่าบันทึกไว้แล้วและไม่บันทึกซ้ำ ทำขั้นต่อไปของวันได้ตามปกติ",
    sourceRefs: [
      "src/lib/line/pending-session-finalizer.ts#buildBusinessDuplicateMessage",
      "src/lib/line/reply.ts#บันทึกแล้ว",
    ],
  },
  start_new_document: {
    titleThai: "เริ่มรายการใหม่",
    howToThai:
      "พิมพ์หัวรายการใหม่ คือ ชื่อคนขาย-ตลาด ประเภท (เบิก ชั่งคืน หรือคืนเสีย) และวันที่ แล้วส่งสินค้าตามปกติ หรือพิมพ์ “เมนู” เพื่อเปิดจากปุ่ม ถ้ายังมีรายการเก่าที่เปิดค้างและไม่ต้องการแล้ว พิมพ์ “ยกเลิกรายการ” ก่อน ถ้าบอทบอกให้ผู้ดูแลเคลียร์รายการเดิมก่อน ให้แจ้งผู้ดูแล",
    sourceRefs: [
      "src/lib/parsers/weigh-session/regex.ts#SELLER_MARKET",
      "src/lib/line/guided-menu/ux-types.ts#GUIDED_MENU_TRIGGER",
      "src/lib/produce/cancel-active-draft.ts#CANCEL_ACTIVE_DRAFT_COMMAND",
      "src/lib/line/webhook-service.ts#STALE_PRODUCE_SESSION_REPLY",
    ],
  },
};

// ── Deterministic lookup ─────────────────────────────────────────────────────

const MAX_MATCHES = 3;

/** NFC, lower-case, and no spaces, so "ชั่ง คืน" and "ชั่งคืน" are the same. */
function normalizeForMatch(value: string): string {
  return value.normalize("NFC").toLowerCase().replace(/[\s​-‍﻿]+/gu, "");
}

const NORMALIZED_KEYWORDS: ReadonlyMap<ConsultantKnowledgeTopicId, readonly string[]> = new Map(
  CONSULTANT_KNOWLEDGE.map((entry) => [
    entry.id,
    entry.keywords.map(normalizeForMatch).filter((keyword) => keyword.length > 0),
  ]),
);

const ENTRIES_BY_ID: ReadonlyMap<string, KnowledgeEntry> = new Map(
  CONSULTANT_KNOWLEDGE.map((entry) => [entry.id, entry]),
);

export function getKnowledge(id: string): KnowledgeEntry | undefined {
  return ENTRIES_BY_ID.get(id);
}

/**
 * Best matching topics for a worker's question, strongest first (max 3).
 *
 * Score = total length of the distinct keywords found in the question, so a
 * longer, more specific phrase ("คืนเสีย") outranks the shorter word it
 * contains ("คืน"). Ties keep the order of CONSULTANT_KNOWLEDGE. No model, no
 * network: the same question always returns the same topics.
 */
export function findKnowledge(question: string): KnowledgeEntry[] {
  const haystack = normalizeForMatch(question);
  if (!haystack) return [];

  const scored: Array<{ entry: KnowledgeEntry; score: number; order: number }> = [];
  CONSULTANT_KNOWLEDGE.forEach((entry, order) => {
    const keywords = NORMALIZED_KEYWORDS.get(entry.id) ?? [];
    let score = 0;
    for (const keyword of new Set(keywords)) {
      if (haystack.includes(keyword)) score += keyword.length;
    }
    if (score > 0) scored.push({ entry, score, order });
  });

  return scored
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, MAX_MATCHES)
    .map(({ entry }) => entry);
}
