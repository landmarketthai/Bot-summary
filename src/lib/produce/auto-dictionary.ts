import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProduceValidationReview } from "./entry-validation";
import { boundedEditDistance } from "@/lib/parsers/weigh-session/units";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

export interface AutoDictionarySessionRef {
  sessionKey: string;
  sessionGeneration: string;
  businessDate: string | null;
}

export interface AutoDictionaryObservation {
  productName: string;
  status: "existing" | "observing" | "needs_review" | "promoted" | "alias" | "rejected";
  productCode: string | null;
  distinctSessions: number | null;
  distinctDays: number | null;
  reason: string | null;
}

interface CategoryHint {
  code: "ม" | "ผ" | "ป" | "ท" | "ห";
  name: string;
}

const FRUIT_PREFIXES = [
  "กล้วย", "แก้วมังกร", "เงาะ", "แตงไทย", "แตงโม", "ทับทิม", "น้อยหน่า",
  "ฝรั่ง", "พีช", "พุทรา", "มะกอก", "มะพร้าว", "มะม่วง", "มะละกอ", "มังคุด",
  "ลองกอง", "ลำไย", "ส้ม", "สละ", "สับปะรด", "สาลี่", "องุ่น",
  "อะโวคาโด", "อินทผลัม", "แอปเปิ้ล", "เมล่อน", "ไซมัส",
];

const VEGETABLE_PREFIXES = [
  "กระชาย", "กระเทียม", "กะเพรา", "กะหล่ำ", "กวางตุ้ง", "ขมิ้น", "ข้าวโพดอ่อน",
  "ขิง", "คะน้า", "แครอท", "ชะอม", "ดอกแค", "ดอกขจร", "ต้นหอม", "ตำลึง", "แตงกวา", "แตงร้าน",
  "แตงล้าน", "ถั่วแขก", "ถั่วงอก", "ถั่วฝักยาว", "ถั่วพู", "ถั่วลันเตา", "น้ำเต้า", "บวบ", "บรอกโคลี", "ผัก", "ฟัก", "มะเขือ", "มะระ",
  "มันฝรั่ง", "ยอดมะพร้าว", "ยอดฟักแม้ว", "สายบัว", "หน่อไม้", "หอมแดง", "หอมหัวใหญ่", "หอมใหญ่", "หัวไชเท้า", "หัวปลี",
  "ใบเตย", "ใบชะพลู", "ใบมะกรูด", "ใบกะเพรา", "พริก",
];
const DRY_PREFIXES = ["ปลา", "กะปิ", "กุ้งแห้ง", "ขนมจีน", "หอย"];

export function inferAutoDictionaryCategory(rawName: string): CategoryHint | null {
  const name = rawName.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!name) return null;
  if (name.startsWith("ทุเรียนเทศ")) return { code: "ม", name: "ผลไม้" };
  if (name.startsWith("ทุเรียน") || name.startsWith("หมอนทอง") || name.startsWith("ก้านยาว")) {
    return { code: "ท", name: "ทุเรียน" };
  }
  if (name.startsWith("เห็ด")) return { code: "ห", name: "เห็ด" };
  if (DRY_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return { code: "ป", name: "ปลา / อาหารแห้ง / ของแห้ง" };
  }
  if (FRUIT_PREFIXES.some((prefix) => name.startsWith(prefix))) return { code: "ม", name: "ผลไม้" };
  if (VEGETABLE_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return { code: "ผ", name: "ผัก / สมุนไพร / เครื่องประกอบอาหาร" };
  }
  return null;
}

function normalizeCandidateName(name: string): string {
  return name.normalize("NFC").replace(/\s+/g, " ").trim();
}

export async function observeAutoDictionaryReviews(
  supabase: AnyClient,
  ref: AutoDictionarySessionRef,
  reviews: readonly ProduceValidationReview[],
): Promise<AutoDictionaryObservation[]> {
  if (!ref.businessDate) return [];
  const unknowns = reviews.filter((review) => review.kind === "unknown_product_vocabulary");
  const runtimeDictionary = await loadRuntimeDictionaryEntries(supabase);
  const results: AutoDictionaryObservation[] = [];
  for (const review of unknowns) {
    const normalizedName = normalizeCandidateName(review.productName);
    if (!normalizedName) continue;
    if (!runtimeDictionary.trustworthy) {
      results.push({ productName: normalizedName, status: "needs_review", productCode: null, distinctSessions: null, distinctDays: null, reason: "automation_unavailable" });
      continue;
    }
    const category = inferAutoDictionaryCategory(normalizedName);
    const similarProductCode = review.suggestions[0]?.productCode
      ?? nearestRuntimeProductCode(normalizedName, runtimeDictionary.entries);
    let data: unknown = null;
    let error: { message: string } | null = null;
    try {
      const response = await supabase.rpc("observe_produce_dictionary_candidate", {
      p_normalized_name: normalizedName,
      p_raw_name: review.productName,
      p_session_key: ref.sessionKey,
      p_session_generation: ref.sessionGeneration,
      p_business_date: ref.businessDate,
      p_category_code: category?.code ?? null,
      p_category_name: category?.name ?? null,
      p_similar_product_code: similarProductCode,
      });
      data = response.data;
      error = response.error;
    } catch (caught) {
      error = { message: caught instanceof Error ? caught.message : "automation unavailable" };
    }
    if (error) {
      results.push({ productName: normalizedName, status: "needs_review", productCode: null, distinctSessions: null, distinctDays: null, reason: "automation_unavailable" });
      continue;
    }
    const row = (data ?? {}) as Record<string, unknown>;
    results.push({
      productName: normalizedName,
      status: String(row.status ?? "observing") as AutoDictionaryObservation["status"],
      productCode: typeof row.product_code === "string" ? row.product_code : null,
      distinctSessions: typeof row.distinct_sessions === "number" ? row.distinct_sessions : null,
      distinctDays: typeof row.distinct_days === "number" ? row.distinct_days : null,
      reason: typeof row.reason === "string" ? row.reason : null,
    });
  }
  return results;
}

interface RuntimeDictionaryEntry { productCode: string; canonicalName: string }
interface RuntimeDictionarySnapshot {
  entries: RuntimeDictionaryEntry[];
  trustworthy: boolean;
}

const RUNTIME_DICTIONARY_ROW_LIMIT = 5000;

async function loadRuntimeDictionaryEntries(supabase: AnyClient): Promise<RuntimeDictionarySnapshot> {
  try {
    const response = await supabase.from("produce_product_codes").select("product_code,canonical_name").eq("code_enabled", true).limit(RUNTIME_DICTIONARY_ROW_LIMIT);
    if (response.error || !Array.isArray(response.data) || response.data.length >= RUNTIME_DICTIONARY_ROW_LIMIT) {
      return { entries: [], trustworthy: false };
    }
    const entries = response.data.map((row: { product_code?: string | null; canonical_name?: string | null }) => ({
      productCode: row.product_code ?? "", canonicalName: normalizeCandidateName(row.canonical_name ?? ""),
    }));
    if (entries.some((row: RuntimeDictionaryEntry) => !row.productCode || !row.canonicalName)) {
      return { entries: [], trustworthy: false };
    }
    return { entries, trustworthy: true };
  } catch { return { entries: [], trustworthy: false }; }
}

function nearestRuntimeProductCode(name: string, entries: readonly RuntimeDictionaryEntry[]): string | null {
  let best: { code: string; distance: number } | null = null;
  for (const entry of entries) {
    if (entry.canonicalName === name) continue;
    const distance = boundedEditDistance(name, entry.canonicalName, 2);
    if (distance === null) continue;
    if (!best || distance < best.distance || (distance === best.distance && entry.productCode < best.code)) best = { code: entry.productCode, distance };
  }
  return best?.code ?? null;
}

export async function loadRuntimeApprovedProductNames(
  supabase: AnyClient,
): Promise<ReadonlySet<string>> {
  let data: Array<{ canonical_name?: string | null }> | null = null;
  try {
    const response = await supabase
      .from("produce_product_codes")
      .select("canonical_name")
      .eq("code_enabled", true)
      .limit(5000);
    if (response.error) return new Set();
    data = response.data as Array<{ canonical_name?: string | null }> | null;
  } catch {
    return new Set();
  }
  return new Set(
    (data ?? [])
      .map((row: { canonical_name?: string | null }) => row.canonical_name?.normalize("NFC").replace(/\s+/g, " ").trim())
      .filter((name: string | undefined): name is string => Boolean(name)),
  );
}
