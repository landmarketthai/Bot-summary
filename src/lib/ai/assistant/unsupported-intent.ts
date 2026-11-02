/**
 * Questions the read-only data cannot answer, recognised from the question
 * itself before any model call. Without this, a model that picks the nearest
 * tool (e.g. get_daily_summary for "กำไรวันนี้เท่าไหร่") gets its backend
 * figures rendered as if they answered a different question.
 *
 *   profit         profit / cost / loss: no authoritative cost data exists;
 *                  sales and cash results (เงินขาด/เกิน) are not profit
 *   forecast       future figures
 *   period_total   month / quarter / year totals (tools are per day, ≤ 7 days)
 *   stock_balance  cumulative inventory (stock tools report daily good returns)
 *   write          requests to change data (@Botsummary is read-only)
 */
export type UnsupportedIntent = "profit" | "forecast" | "period_total" | "stock_balance" | "write";

const WRITE_VERB = /^(?:ช่วย|รบกวน|กรุณา|ขอ)?\s*(?:แก้|ลบ|เพิ่ม|บันทึก|เปลี่ยน|อัปเดต|อัพเดท|อัปเดท)/u;
const WRITE_REQUEST = /(?:ให้|หน่อย|ด้วย|เป็น\s*[\d๐-๙])/u;
const WRITE_STATUS = /เสร็จ(?:แล้ว)?(?:หรือยัง|ไหม)|เรียบร้อย(?:แล้ว)?(?:หรือยัง|ไหม)/u;
const FORECAST = /พรุ่งนี้|มะรืน|สัปดาห์หน้า|อาทิตย์หน้า|เดือนหน้า|ปีหน้า|คาดการณ์|ทำนาย|พยากรณ์|จะขายได้/u;
const PERIOD_TOTAL = /ทั้งเดือน|เดือนนี้|เดือนที่แล้ว|เดือนก่อน|รายเดือน|ไตรมาส|ทั้งปี|ปีนี้|ปีที่แล้ว|รายปี|เดือน\s*(?:มกรา|กุมภา|มีนา|เมษา|พฤษภา|มิถุนา|กรกฎา|สิงหา|กันยา|ตุลา|พฤศจิกา|ธันวา)/u;
const PROFIT = /กำไร|ขาดทุน|ต้นทุน|มาร์จิ้น|margin|profit/iu;
/** A supported topic asked alongside profit ("ยอดขายกับกำไร"): answer it, state profit as unavailable. */
const SUPPORTED_TOPIC = /ยอดขาย|ขายได้|เงินขาด|เงินเกิน|ปิดเงิน|สลิป|เบิก|ชั่งคืน|คืนเสีย|สต๊อก|สต็อก|ของเหลือ|ใบขาว|ค้าง/u;

export const UNSUPPORTED_INTENT_REPLY: Record<UnsupportedIntent, string> = {
  profit:
    "ยังสรุปกำไรไม่ได้ครับ เพราะระบบยังไม่มีข้อมูลต้นทุนที่ครบถ้วน (ยอดขายและผลปิดเงินขาด/เกินไม่ใช่กำไร) ถามยอดขายหรือผลปิดเงินแยกได้ครับ",
  forecast:
    "@Botsummary คาดการณ์ยอดในอนาคตไม่ได้ครับ ตอบได้เฉพาะข้อมูลที่บันทึกแล้ว เช่น ยอดขายวันนี้หรือเมื่อวาน",
  period_total:
    "ยังสรุปยอดรวมทั้งเดือนหรือทั้งปีไม่ได้ครับ ระบบตอบได้เป็นรายวัน และเทียบย้อนหลังได้ไม่เกิน 7 วัน",
  stock_balance:
    "ยังสรุปสต๊อกสะสมหรือยอดคงเหลือทั้งเดือนไม่ได้ครับ ข้อมูลสต๊อกที่ตอบได้เป็นของชั่งคืนดีรายวันที่เหลือขายต่อ ไม่ใช่บัญชีสินค้าคงคลังต่อเนื่อง จึงนำยอดรายวันมารวมเป็นยอดสะสมไม่ได้",
  write:
    "@Botsummary เป็นโหมดอ่านข้อมูลอย่างเดียว แก้ไข ลบ หรือบันทึกข้อมูลให้ไม่ได้ครับ กรุณาทำผ่านขั้นตอนปกติหรือแจ้งแอดมิน",
};

/** Line put in front of a supported answer when profit was also asked. */
export const PROFIT_UNAVAILABLE_LINE = "ยังสรุปกำไรไม่ได้ เพราะระบบยังไม่มีข้อมูลต้นทุนที่ครบถ้วน ข้อมูลด้านล่างคือยอดขาย/ผลปิดเงิน ไม่ใช่กำไร";

export function classifyUnsupportedIntent(question: string): UnsupportedIntent | null {
  const q = question.normalize("NFC").trim();
  if (WRITE_VERB.test(q) && WRITE_REQUEST.test(q) && !WRITE_STATUS.test(q)) return "write";
  if (FORECAST.test(q)) return "forecast";
  if (PROFIT.test(q)) return "profit";
  if (/(?:สต๊อก|สต็อก|สต็อค|ของเหลือ|คงเหลือ)/u.test(q)
    && (PERIOD_TOTAL.test(q) || /สะสม|ยกมา|ยกไป/u.test(q))) return "stock_balance";
  if (PERIOD_TOTAL.test(q)) return "period_total";
  return null;
}

/** Profit asked together with a supported topic: the supported part is still answered. */
export function asksSupportedTopicToo(question: string): boolean {
  return SUPPORTED_TOPIC.test(question.normalize("NFC"));
}
