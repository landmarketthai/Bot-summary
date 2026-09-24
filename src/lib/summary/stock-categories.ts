/**
 * Explicit product → category mapping for the daily Stock report.
 *
 * Design rules (deliberate, do not relax without a business decision):
 *   1. Mapping is EXACT-MATCH on the canonical product name produced by
 *      normalizeProductName. No fuzzy matching, no edit-distance, no
 *      "starts with" guessing.
 *   2. The only substring rule is durian (see DURIAN_MARKER) because real
 *      production data contains compound forms such as ทุเรียนกล่อง /
 *      ทุเรียนแกะ that are unquestionably durian. ทุเรียนเทศ (soursop) is a
 *      different fruit and is excluded explicitly.
 *   3. Category is NEVER inferred from the market name. Markets such as
 *      "เฉลิม72 ผลไม้" sell items that are not fruit, so market-based
 *      inference would silently mis-file products.
 *   4. Anything unmapped falls into UNCATEGORIZED and stays VISIBLE in the
 *      report. Unknown products are a signal to extend this file, never
 *      something to hide.
 *
 * A handful of entries follow Thai wet-market convention rather than botany
 * (มะนาว / มะกรูด / แตงกวา / ฟักทอง / มะเขือเทศ / ข้าวโพด are sold in the
 * ผัก section). They are listed under ผัก on purpose; move them if the
 * business disagrees.
 */

export type StockCategory = "ทุเรียน" | "ผลไม้" | "ผัก" | "ไม่จัดหมวด";

export const STOCK_CATEGORY_ORDER: readonly StockCategory[] = [
  "ทุเรียน",
  "ผลไม้",
  "ผัก",
  "ไม่จัดหมวด",
];

export const STOCK_CATEGORY_EMOJI: Record<StockCategory, string> = {
  ทุเรียน: "🥭",
  ผลไม้: "🍉",
  ผัก: "🥬",
  ไม่จัดหมวด: "❓",
};

export const UNCATEGORIZED: StockCategory = "ไม่จัดหมวด";

/** Compound durian forms (ทุเรียนกล่อง, ทุเรียนแกะ, …) are still durian. */
const DURIAN_MARKER = "ทุเรียน";

/**
 * Names that contain DURIAN_MARKER but are NOT durian. ทุเรียนเทศ is soursop.
 * Every exclusion here must be a genuinely different species.
 */
const DURIAN_MARKER_EXCLUSIONS: ReadonlySet<string> = new Set([
  "ทุเรียนเทศ",
]);

const DURIAN: readonly string[] = [
  "ทุเรียน",
  "หมอนทอง",
  // A cracked หมอนทอง — unambiguously a durian, and sold as its own grade.
  // Classified here only; it stays a SEPARATE canonical product from หมอนทอง.
  "หมอนแตก",
  "ก้านยาว",
  "ชะนี",
  "พวงมณี",
  "กระดุม",
  "กระดุมทอง",
  "หลงลับแล",
  "หลินลับแล",
  "มูซังคิง",
  "หนามดำ",
  "ภูเขาไฟ",
];

const FRUIT: readonly string[] = [
  // มะม่วง and its commercial varieties
  "มะม่วง",
  "มหาชนก",
  "น้ำดอกไม้",
  "เขียวเสวย",
  "ฟ้าลั่น",
  "อกร่อง",
  "โชคอนันต์",
  "แรด",
  "เพชรบ้านลาด",
  // กล้วย
  "กล้วย",
  "กล้วยหอม",
  "กล้วยน้ำว้า",
  "กล้วยไข่",
  // ส้ม / citrus sold as fruit
  "ส้ม",
  "ส้มโอ",
  "ส้มเขียวหวาน",
  "ส้มจี๊ด",
  // everything else
  "กระท้อน",
  "แตงโม",
  "แตงไทย",
  "ลูกพลับ",
  "พลับ",
  "แก้วมังกร",
  "สับปะรด",
  "ลำไย",
  "ลิ้นจี่",
  "เงาะ",
  "มังคุด",
  "ลองกอง",
  "ลางสาด",
  // องุ่น varietals seen in real production output. Classification only —
  // these deliberately remain SEPARATE canonical products (องุ่นไชมัส and
  // องุ่นไซมัส are two spellings of Shine Muscat but are NOT aliased here).
  "องุ่น",
  "องุ่นเขียว",
  "องุ่นแดง",
  "องุ่นดำ",
  "องุ่นไข่ปลา",
  "องุ่นไซมัส",
  "องุ่นไชมัส",
  "องุ่นรวม",
  "องุ่นรวมแดงดำ",
  "องุ่นแม่มด",
  "เขียวมรกต",
  "ชมพู่",
  "ฝรั่ง",
  "มะพร้าว",
  "ขนุน",
  "จำปาดะ",
  "น้อยหน่า",
  "ละมุด",
  "พุทรา",
  "อะโวคาโด",
  "อินทผาลัม",
  "สตรอเบอร์รี่",
  "เมล่อน",
  "แคนตาลูป",
  "ทับทิม",
  "แอปเปิ้ล",
  // สาลี่หอม / สาลีหอม differ only by ่ and are the same pear, but they are
  // classified here, NOT merged — canonical identity is unchanged.
  "สาลี่",
  "สาลี่หอม",
  "สาลีหอม",
  "ส้มไต้หวัน",
  // Shortened avocado form seen in production. Classified as fruit; explicitly
  // NOT aliased to อะโวคาโด.
  "อะโว",
  "มะละกอ",
  "เสาวรส",
  "มะเฟือง",
  "มะยงชิด",
  "มะปราง",
  "ระกำ",
  "สละ",
  "มะขาม",
  "มะขามหวาน",
  "มะกอก",
  "มะยม",
  "ลูกตาล",
  "เชอร์รี่",
  "กีวี",
  "บลูเบอร์รี่",
  "ทุเรียนเทศ",
];

const VEGETABLE: readonly string[] = [
  // herbs
  "กระชาย",
  "กะเพรา",
  "โหระพา",
  "แมงลัก",
  "ใบมังลัก",
  "สะระแหน่",
  "ผักชี",
  "ผักชีฝรั่ง",
  "ผักชีลาว",
  "ต้นหอม",
  "ใบเตย",
  "ใบมะกรูด",
  "ตะไคร้",
  "ข่า",
  "ขิง",
  "ขมิ้น",
  "กุยช่าย",
  "ขึ้นฉ่าย",
  "ใบตั่งโอ้",
  "ตั้งโอ๋",
  // alliums / seasoning
  "หอมแดง",
  "หอมใหญ่",
  "กระเทียม",
  "พริก",
  "พริกขี้หนู",
  "พริกชี้ฟ้า",
  "พริกหยวก",
  // sold in the ผัก section by convention, botany notwithstanding
  "มะนาว",
  "มะกรูด",
  "แตงกวา",
  "แตงร้าน",
  "ฟักทอง",
  "ฟัก",
  "บวบ",
  "มะระ",
  "มะเขือ",
  "มะเขือเทศ",
  "มะเขือพวง",
  "มะเขือเปราะ",
  "ข้าวโพด",
  "ข้าวโพดหวาน",
  // leaf / stem / root
  "กะหล่ำปี",
  "กะหล่ำดอก",
  "บรอกโคลี",
  "ผักกาดขาว",
  "ผักกาดหอม",
  "ผักบุ้ง",
  "คะน้า",
  "กวางตุ้ง",
  "ตำลึง",
  "ผักหวาน",
  "ผักโขม",
  "ปวยเล้ง",
  "ชะอม",
  "สะตอ",
  "ดอกแค",
  "ถั่วฝักยาว",
  "ถั่วพู",
  "ถั่วงอก",
  "แครอท",
  "มันฝรั่ง",
  "มันเทศ",
  "เผือก",
  "หน่อไม้",
  "เห็ด",
  "เห็ดฟาง",
  "เห็ดนางฟ้า",

  // ── Forms observed in real production output ─────────────────────────────
  // Classification only. Misspellings and size/grade variants are listed here
  // so they leave ไม่จัดหมวด, but they deliberately remain SEPARATE canonical
  // products — nothing below is an alias and no product name is rewritten.
  // กวางตุ้ง varietals
  "กวางตุ้งจิ้ว",
  "กวางตุ้งยี่ปุ่น",
  "กวางตุ้งดอกเหลือง",
  "กวางตุ้งไทย",
  // brassica / leaf
  "บอคโครี่",
  "ดอกกะหล่ำ",
  "กะกล่ำปี",
  "ผักบุ้งจีน",
  "ผักบุ้งไทย",
  "ผักกาดลุ้ย",
  "ผักกาดลู้ย",
  "ผักกาดดอง",
  "สลัดคอตนิ่ม",
  "สลัดคอส",
  // คะน้า size/grade forms (written คน้า in production)
  "คน้าเลก",
  "คน้าเล็ก",
  "คน้าไหย่",
  "คน้าฮ้องกง",
  // herbs
  "ผักชีไทย",
  "ผักชีใบเลื่อย",
  "กระเพา",
  "กระเพาแดง",
  "ใบโหระพา",
  "ใบตั้งโอ้",
  "สาระแหน",
  "ใบกระเจียบ",
  "ฝักกระเจียบ",
  // alliums / seasoning
  "กระเทียมหัว",
  "กระเทียมกลีบใหย่",
  "หอมแขกเลก",
  "หอมแขกเล็ก",
  "หอมแขกใหย่",
  "หอมหัวใหย่",
  "ขิงแก่",
  "ขิงออ่น",
  "พริกสด",
  "พริกแห้ง",
  "พริกป่น",
  // fruiting vegetables
  "มะเขือเทสเลก",
  "มะเขือเทสเล็ก",
  "มะเขือเทสใหย่",
  "มะเขือเปาะ",
  "มะเขือเหลือง",
  "มะระขี้นก",
  "มะระลูก",
  "แตงกวาเล็ก",
  "ฟักออ่น",
  "บวบเหลี่ยม",
  "นำเต้า",
  "น้ำเต้า",
  "ถั่วแขก",
  "ข้าวโพดออ่น",
  "ข้าวโพดอ่อน",
  // roots
  "ไชยท้าว",
  "หัวไชเท้า",
  // preserved / prepared produce
  "หน่อไม้ดอง",
  "หน่อไม้ต้ม",
  // mushrooms
  "เหดแพค",
  "เห็ดแพครวม",
  "เหดออริจิ",
];

function buildMap(): ReadonlyMap<string, StockCategory> {
  const map = new Map<string, StockCategory>();
  const add = (names: readonly string[], category: StockCategory) => {
    for (const name of names) {
      const key = name.normalize("NFC");
      // First writer wins so an accidental duplicate never silently reassigns
      // a product to a different category.
      if (!map.has(key)) map.set(key, category);
    }
  };

  add(DURIAN, "ทุเรียน");
  add(FRUIT, "ผลไม้");
  add(VEGETABLE, "ผัก");
  return map;
}

const CATEGORY_BY_PRODUCT = buildMap();

/**
 * Resolve a canonical product name to its Stock category.
 * Unmapped products return UNCATEGORIZED — they stay in the report.
 */
export function stockCategoryFor(canonicalProductName: string): StockCategory {
  const name = canonicalProductName.normalize("NFC").trim();
  if (!name) return UNCATEGORIZED;

  const explicit = CATEGORY_BY_PRODUCT.get(name);
  if (explicit) return explicit;

  if (name.includes(DURIAN_MARKER) && !DURIAN_MARKER_EXCLUSIONS.has(name)) {
    return "ทุเรียน";
  }

  return UNCATEGORIZED;
}

/** Exposed for tests and for a future admin screen that audits the mapping. */
export function stockCategoryEntries(): Array<[string, StockCategory]> {
  return [...CATEGORY_BY_PRODUCT.entries()];
}
