/**
 * All regex patterns for the weigh-session parser.
 *
 * Thai Unicode block U+0E00–U+0E7F covers letters, vowels, and tone marks.
 * Quantity lines use the trailing-dot format produced by scales: "38.1.โล".
 */

// Thai character class (letters + vowel signs + tone marks, all in U+0E00-U+0E7F)
const TH = "\\u0E00-\\u0E7F";
const UNIT = `${TH}A-Za-z`;
// Market labels may contain Latin suffixes used by real/test operations (e.g. "ทดสอบบอทUAT").
// Keep the character class bounded to human-readable label characters rather than \S.
const MARKET = `${TH}A-Za-z\\d\\sฯๆ().\\-/`;

export const RE = {
  // "18:53 เสือ <content>" — time separator can be colon or dot
  // Captures: [1]=time, [2]=sender, [3]=content
  TIME_PREFIX: /^(\d{1,2}[:.]\d{2})\s+(\S+)\s+([\s\S]*)$/,

  // Item line — dot after item number is optional per real examples:
  //   "1.หมอนทอง119บาท"  (with dot)
  //   "2หมอนทอง119บาท"   (no dot)
  //   "1. หมอนทอง 119 บาท" (typed with spaces around dot/name/price)
  // Optional whitespace after the dot so a typed, spaced-out item line matches
  // the same as the compact scale-output form. Lazy Thai match stops
  // naturally before the trailing digits+บาท.
  // Captures: [1]=item_number, [2]=product_name, [3]=price
  ITEM: new RegExp(`^(\\d+)\\.?\\s*([${TH}][${TH}\\s]*?)(\\d+(?:\\.\\d+)?)\\s*บาท\\s*$`),

  // Item line without an item number. Used for short correction messages.
  // Captures: [1]=product_name, [2]=price
  ITEM_NO_INDEX: new RegExp(`^([${TH}][${TH}\\s]*?)(\\d+(?:\\.\\d+)?)\\s*บาท\\s*$`),

  // Item line with a bundled price basis — "[qty][unit] for [price] บาท" —
  // parsed backwards from the final บาท token:
  //   "85ผักกาดขาว3หัว20บาท" → item 85, product "ผักกาดขาว", basis 3 หัว / 20 บาท
  //   "8เงาะ2.โล50บาท"       → same shape, scale's optional trailing dot before the unit
  // The unit token is any Thai-word run (no fixed whitelist — see units.ts),
  // so it naturally never matches a plain "<product>NNบาท" line (those have
  // only one digit run before บาท, not two).
  // Captures: [1]=item_number, [2]=product_name, [3]=basis_quantity, [4]=basis_unit, [5]=basis_price
  ITEM_WITH_BASIS: new RegExp(
    `^(\\d+)\\.?\\s*([${TH}][${TH}\\s]*?)(\\d+(?:\\.\\d+)?)\\.?\\s*([${UNIT}]+?)\\s*(\\d+(?:\\.\\d+)?)\\s*บาท\\s*$`,
  ),

  // Compact shop shorthand with the basis unit omitted from the header:
  //   "37ผักกาดสลัด3/20" → 3 of the quantity-line unit cost 20 baht.
  // The following quantity line supplies the missing basis unit, e.g. 15หัว.
  // Captures: [1]=item_number, [2]=product_name, [3]=basis_quantity, [4]=basis_price
  ITEM_WITH_BASIS_SHORTHAND: new RegExp(
    `^(\\d+)\\.?\\s*([${TH}][${TH}\\s]*?)(\\d+(?:\\.\\d+)?)\\s*/\\s*(\\d+(?:\\.\\d+)?)\\s*(?:บาท)?\\s*$`,
  ),

  // Item header split across lines: item number + product name, with no
  // price on the same line (the price arrives on the next line — see
  // PRICE_ONLY). Shape is identical to QUANTITY (digit run + Thai run) since
  // both come off a scale/typed message the same way; the parser tells them
  // apart by whether the trailing Thai token is a known unit (see units.ts).
  // Allows internal spaces in the name (unlike QUANTITY's unit token).
  // Captures: [1]=item_number, [2]=product_name
  ITEM_NAME_ONLY: new RegExp(`^(\\d+)\\.?\\s*([${TH}][${TH}\\s]*)$`),

  // Standalone price continuation line for an item whose name arrived on a
  // prior line with no price attached: "100บาท", "100 บาท". Matched against
  // punctuation-normalized content (see normalizeItemLinePunctuation), so
  // "100.บาท" / "100บาท." also match.
  // Captures: [1]=price
  PRICE_ONLY: /^(\d+(?:\.\d+)?)\s*บาท\s*$/,

  // Quantity with unit — trailing dot before unit is optional (scale output format):
  //   "38โล"  "18.5โล"  "38.1.โล"  "28.โล"
  //   "9ลูก"  "23.ลูก"  "6.ลูก"
  //   "13.กล่อง"  "20.แพค"  "5แพค"  "1แพ็ค"  "1แพ็ก"  "1เเพ็ค"
  //   "3กำ"  "2มัด"  "5ถุง"  "16หัว"  "4หวี"  "1เครือ"  "2เข่ง"  "3พวง"  "5ลัง"
  // The unit token is any Thai-word run — no fixed whitelist (see units.ts).
  // Known spellings normalize via the alias/conversion registry; unrecognized
  // units are stored as text. "บาท" itself is excluded so a bare price line
  // never gets misread as a quantity line (see parser.ts).
  // Captures: [1]=amount, [2]=unit
  QUANTITY: new RegExp(`^((?:\\d+(?:\\.\\d+)?|\\.\\d+))\\.?\\s*([${UNIT}]+)\\s*$`),

  // Full-line date (anchored to avoid false matches inside item lines):
  //   "25/5/69"   → short Buddhist year 2569 → Gregorian 2026
  //   "18/5/2568" → full Buddhist year  2568 → Gregorian 2025
  // Captures: [1]=day, [2]=month, [3]=year
  DATE_ONLY:    /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.]((?:25)?\d{2})\s*$/,
  DATE_IN_TEXT: /(\d{1,2})[\/\-.](\d{1,2})[\/\-.]((?:25)?\d{2})/,

  // Session title contains รายการชั่ง, เบิก, คืน, or คืนเสีย.
  // Also matches "พี่ดำ-วิหาร เบิก 26/5/2569" via the เบิก keyword.
  SESSION_START: /รายการชั่ง|เบิก|คืนเสีย|คืน|(?:^|\s)เสีย\s+\d{1,2}\/\d{1,2}\/\d{4}/,

  // All observed end markers start with จบรายการ
  SESSION_END: /^จบรายการ/,

  // "จบรายการ 18 รายการ" — guaranteed-completeness close form. Captures:
  // [1]=count. Bare "จบรายการ" (no count) remains quiet-window best-effort
  // only — see try_finalize_pending_generation in
  // 0032_pending_session_finalization_barrier.sql.
  SESSION_END_COUNT: /^จบรายการ\s+(\d+)\s*รายการ/,

  // Section / transaction-type header lines (matched against content after TIME_PREFIX strip):
  //   รายการชั่งเบิก  → เบิก
  //   รายการเบิกเพิ่ม  → เบิกเพิ่ม
  //   รายการชั่งคืน   → คืน
  //   คืนเสีย         → คืนเสีย
  TX_TYPE_BEIK_PHERM: /รายการเบิกเพิ่ม|เบิกเพิ่ม/,
  TX_TYPE_BEIK:       /รายการชั่งเบิก|รายการเบิก|เบิก/,
  TX_TYPE_KUEN_SIA:   /คืนเสีย/,
  TX_TYPE_KUEN:       /รายการชั่งคืน|รายการคืน|คืน/,

  // "พี่ดำ-วิหาร เบิก" or "พี่ดำ-วิหาร เบิกเพิ่ม 26/5/2569"
  // seller = before dash, market = between dash and tx-type keyword
  // Captures: [1]=seller, [2]=market, [3]=tx_type_keyword
  SELLER_MARKET: new RegExp(
    `^([${TH}\\s]+?)-([${MARKET}]+?)\\s+(เบิกเพิ่ม|เบิก|คืนเสีย|ชั่งคืน|คืน)`,
  ),

  // Additional-batch opener — full-line anchored, all parts explicit:
  //   "กี้-คลองเตย เบิกเพิ่ม 12/7/2569"
  //   "กี้-คลองเตย ชั่งคืนเพิ่ม 12/7/2569"
  //   "กี้-คลองเตย คืนเสียเพิ่ม 12/7/2569"
  // Captures: [1]=seller, [2]=market, [3]=additional type keyword, [4]=date
  ADDITIONAL_HEADER: new RegExp(
    `^([${TH}\\s]+?)-([${MARKET}]+?)\\s+(เบิกเพิ่ม|ชั่งคืนเพิ่ม|คืนเสียเพิ่ม)\\s+(\\d{1,2}[\\/\\-.]\\d{1,2}[\\/\\-.](?:25)?\\d{2})\\s*$`,
  ),

  // Additional-batch closer — full-line anchored, type must match the opener,
  // optional expected count: "จบรายการเบิกเพิ่ม" / "จบรายการชั่งคืนเพิ่ม 5 รายการ"
  // Captures: [1]=additional type keyword, [2]=expected count (optional)
  ADDITIONAL_END: /^จบรายการ(เบิกเพิ่ม|ชั่งคืนเพิ่ม|คืนเสียเพิ่ม)(?:\s+(\d+)\s*รายการ)?\s*$/,

  // Manual slip session open: "ส่งสลิปมือ 17/06/2569"
  // Anchored at ส่งสลิปมือ only — allows arbitrary prefix (e.g. sender name).
  // Captures: [1]=date string (DD/MM/YY or DD/MM/YYYY Buddhist)
  MANUAL_SLIP_OPEN: /ส่งสลิปมือ\s+(\d{1,2}\/\d{1,2}\/(?:25)?\d{2})/,

  // Manual slip session close: "จบสลิปมือ"
  MANUAL_SLIP_CLOSE: /^จบสลิปมือ\s*$/,
} as const;
