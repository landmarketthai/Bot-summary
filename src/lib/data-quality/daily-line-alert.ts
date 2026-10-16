import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { resolveApprovedProductName } from "@/lib/produce/product-vocabulary";
import { normalizeProductName } from "@/lib/summary/remaining-fruit";
import { stockCategoryFor, UNCATEGORIZED } from "@/lib/summary/stock-categories";
import { produceSectionOf, PRODUCE_SECTION_LABEL } from "@/lib/summary/produce-section";
import { previousBangkokBusinessDate } from "@/lib/summary/daily-stock-cron";
import { CATEGORY_LABEL_TH } from "./labels";
import type { DataQualityCategory } from "./severity";

export const DQ_ALERT_PAGE_SIZE = 500;
export const DQ_ALERT_MAX_ROWS = 20_000;
export const DQ_ALERT_MAX_TEXT = 4500;
type Issue = Pick<Database["public"]["Tables"]["data_quality_issues"]["Row"],
  "id" | "category" | "severity" | "status" | "business_date" | "technical_context">;
type Item = { id: string; product_name: string; produce_sessions: { session_date: string; voided_at: string | null } };
type Page<T> = { data: T[] | null; count: number | null; error: unknown };

export function isDailyAlertDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= "0001-01-01"
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export function dailyAlertDate(value: string | null, now = Date.now()): string {
  const date = value === null ? previousBangkokBusinessDate(now) : value;
  if (!isDailyAlertDate(date)) throw new Error("invalid_date");
  return date;
}

/** Exact remaining counts plus ordered keyset pages detect server caps and count drift. */
async function readComplete<T extends { id: string }>(read: (cursor: string | null) => PromiseLike<Page<T>>): Promise<T[]> {
  const rows: T[] = [];
  let total: number | null = null;
  for (;;) {
    const cursor = rows.at(-1)?.id ?? null;
    const { data, count, error } = await read(cursor);
    if (error || !Array.isArray(data) || !Number.isSafeInteger(count) || count === null || count < 0
      || count + rows.length > DQ_ALERT_MAX_ROWS
      || (total !== null && count + rows.length !== total)
      || data.length !== Math.min(count, DQ_ALERT_PAGE_SIZE)
      || data.some((row, i) => typeof row.id !== "string" || row.id <= (i ? data[i - 1].id : cursor ?? ""))) {
      throw new Error("daily_alert_read_incomplete");
    }
    total = count + rows.length;
    rows.push(...data);
    if (rows.length === total) return rows;
  }
}

function returnSnapshot(issue: Issue): number[] | null {
  const ctx = issue.technical_context;
  if (!ctx || typeof ctx !== "object" || Array.isArray(ctx)) return null;
  const quantities = [ctx.withdrawn_quantity, ctx.good_return_quantity, ctx.damaged_quantity, ctx.excess_quantity];
  if (!quantities.every((n) => typeof n === "number" && n >= 0 && Number.isSafeInteger(Math.round(n * 1000)))
    || typeof ctx.unit !== "string" || !/^[ก-๙]{1,16}$/u.test(ctx.unit)) return null;
  const [withdrawn, good, damaged, excess] = quantities as number[];
  return Math.abs(good + damaged - withdrawn - excess) <= 1e-9 ? quantities as number[] : null;
}

/** Screening from a consistent numeric snapshot only; never changes the recorded severity. */
export function materialDailyAlertReturn(issue: Issue): boolean {
  if (issue.category !== "produce_return_exceeds_withdrawal" || issue.status !== "OPEN") return false;
  const snapshot = returnSnapshot(issue);
  if (!snapshot) return false;
  const [withdrawn, , , excess] = snapshot;
  return excess >= 10 || (excess >= 1 && excess >= withdrawn * 0.25);
}

// Only short Thai product labels leave this reader. Arbitrary context and chat never do.
function productLabel(name: string): string {
  return /^[ก-๙]+(?:[ ก-๙]*[ก-๙])?$/u.test(name) && name.length <= 60 ? name : "[ปกปิดชื่อ]";
}

export interface DailyLineAlert {
  businessDate: string;
  counts: {
    critical: number; actionRequired: number; materialReturnExceeds: number; selectedIssues: number;
    unknownProductIssues: number; produceItems: number; anomalyItems: number; anomalyNames: number;
    uncategorizedItems: number; uncategorizedNames: number; missingCodeItems: number; missingCodeNames: number;
    approvedMissingCategoryItems: number; approvedMissingCategoryNames: number; omittedNames: number;
  };
  text: string;
}

/** SELECT only. Does not scan/upsert issues, read raw_messages, or correct source data. */
export async function loadDailyLineAlert(
  supabase: SupabaseClient<Database>, businessDate = dailyAlertDate(null),
): Promise<DailyLineAlert> {
  if (!isDailyAlertDate(businessDate)) throw new Error("invalid_date");
  const [issues, items] = await Promise.all([
    readComplete<Issue>((cursor) => {
      let q = supabase.from("data_quality_issues")
        .select("id,category,severity,status,business_date,technical_context", { count: "exact" })
        .eq("business_date", businessDate).eq("status", "OPEN").order("id").limit(DQ_ALERT_PAGE_SIZE);
      if (cursor) q = q.gt("id", cursor);
      return q;
    }),
    readComplete<Item>(async (cursor) => {
      let q = supabase.from("produce_items")
        .select("id,product_name,produce_sessions!inner(session_date,voided_at)", { count: "exact" })
        .eq("produce_sessions.session_date", businessDate).is("produce_sessions.voided_at", null)
        .order("id").limit(DQ_ALERT_PAGE_SIZE);
      if (cursor) q = q.gt("id", cursor);
      // Generated Relationships is empty; PostgREST resolves the existing session FK.
      return await q as unknown as Page<Item>;
    }),
  ]);
  if (issues.some((i) => i.business_date !== businessDate || i.status !== "OPEN"
      || !["CRITICAL", "ACTION_REQUIRED", "ADVISORY"].includes(i.severity) || typeof i.category !== "string")
    || items.some((i) => typeof i.product_name !== "string" || !i.product_name.trim() || i.product_name.length > 200
      || i.produce_sessions?.session_date !== businessDate || i.produce_sessions.voided_at !== null)) {
    throw new Error("daily_alert_scope_unavailable");
  }
  if (issues.some((i) => i.category === "produce_return_exceeds_withdrawal" && !returnSnapshot(i))) {
    throw new Error("daily_alert_return_snapshot_unavailable");
  }
  const selected = issues.filter((i) => i.severity === "CRITICAL" || i.severity === "ACTION_REQUIRED"
    || i.category === "produce_unknown_product" || materialDailyAlertReturn(i));
  const names = new Map<string, number>();
  for (const item of items) {
    const name = normalizeProductName(item.product_name);
    names.set(name, (names.get(name) ?? 0) + 1);
  }
  const products = [...names].map(([name, count]) => ({ name, count,
    uncategorized: stockCategoryFor(name) === UNCATEGORIZED, missingCode: resolveApprovedProductName(name) === null,
  })).filter((p) => p.uncategorized || p.missingCode).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const uncategorized = products.filter((p) => p.uncategorized);
  const missingCode = products.filter((p) => p.missingCode);
  const approvedMissingCategory = uncategorized.filter((p) => !p.missingCode);
  const itemCount = (rows: typeof products) => rows.reduce((sum, p) => sum + p.count, 0);
  // Disjoint display groups keep low-frequency categorized missing-code names visible.
  const groups = [
    { label: "ไม่มีรหัส / สต๊อกไม่จัดหมวด", products: missingCode.filter((p) => p.uncategorized) },
    { label: "ไม่มีรหัส / มีหมวดสต๊อกแล้ว", products: missingCode.filter((p) => !p.uncategorized) },
    { label: "มีรหัสแล้วแต่ขาดหมวดสต๊อก", products: approvedMissingCategory },
  ];
  const counts = {
    critical: selected.filter((i) => i.severity === "CRITICAL").length,
    actionRequired: selected.filter((i) => i.severity === "ACTION_REQUIRED").length,
    materialReturnExceeds: selected.filter(materialDailyAlertReturn).length,
    selectedIssues: selected.length, unknownProductIssues: selected.filter((i) => i.category === "produce_unknown_product").length,
    produceItems: items.length, anomalyItems: itemCount(products), anomalyNames: products.length,
    uncategorizedItems: itemCount(uncategorized), uncategorizedNames: uncategorized.length,
    missingCodeItems: itemCount(missingCode), missingCodeNames: missingCode.length,
    approvedMissingCategoryItems: itemCount(approvedMissingCategory), approvedMissingCategoryNames: approvedMissingCategory.length,
    omittedNames: groups.reduce((sum, g) => sum + Math.max(0, g.products.length - 5), 0),
  };
  const categories = new Map<string, number>();
  for (const issue of selected) {
    const label = Object.hasOwn(CATEGORY_LABEL_TH, issue.category)
      ? CATEGORY_LABEL_TH[issue.category as DataQualityCategory] : "ปัญหาข้อมูลที่ต้องตรวจสอบ";
    categories.set(label, (categories.get(label) ?? 0) + 1);
  }
  const categoryRows = [...categories].sort(([a], [b]) => a.localeCompare(b));
  const text = [
    `แจ้งตรวจคุณภาพข้อมูลประจำวัน ${businessDate}`,
    `เคสเปิดอยู่: เร่งด่วน ${counts.critical} | ต้องตรวจสอบ ${counts.actionRequired} | คืนเกินมีนัยสำคัญ ${counts.materialReturnExceeds}`,
    `เคสสินค้านอกรายการ ${counts.unknownProductIssues} เคส (รวม ADVISORY; คง severity เดิม)`,
    `รวมเคสเข้าเกณฑ์ ${counts.selectedIssues} เคส (กลุ่มเคสอาจซ้อนกัน นับแต่ละเคสครั้งเดียว)`,
    ...categoryRows.slice(0, 10).map(([label, count]) => `• ${label}: ${count} เคส`),
    categoryRows.length > 10 ? `อีก ${categoryRows.length - 10} ประเภทไม่ได้แสดง` : "",
    "คืนเกิน: ≥10 หน่วย หรือ ≥1 หน่วยและ ≥25% ของยอดเบิก; คัดจาก snapshot ยังไม่ยืนยันสาเหตุ และคง severity เดิม",
    "เคส DQ กับรายการสินค้าเป็นสัญญาณคนละแหล่ง อาจซ้ำกัน ห้ามบวกเป็นจำนวนเหตุการณ์",
    `สินค้าไม่มีรหัสหรือไม่จัดหมวด (ไม่นับซ้ำ): ${counts.anomalyItems} รายการ / ${counts.anomalyNames} ชื่อ จาก ${counts.produceItems} รายการในวันที่เลือก`,
    `สต๊อกไม่จัดหมวด: ${counts.uncategorizedItems} รายการ / ${counts.uncategorizedNames} ชื่อ`,
    `ไม่มีรหัสสินค้าที่อนุมัติ (ทุกหมวดสต๊อก): ${counts.missingCodeItems} รายการ / ${counts.missingCodeNames} ชื่อ`,
    `มีรหัสแล้วแต่ขาดหมวดสต๊อก: ${counts.approvedMissingCategoryItems} รายการ / ${counts.approvedMissingCategoryNames} ชื่อ`,
    ...groups.filter((g) => g.products.length).flatMap((g) => [
      `${g.label}: ${itemCount(g.products)} รายการ / ${g.products.length} ชื่อ (สูงสุด 5 ชื่อ)`,
      ...g.products.slice(0, 5).map(({ name, count }) => `• ${productLabel(name)}: ${count} รายการ; แนวทางหมวด: ${PRODUCE_SECTION_LABEL[produceSectionOf(name)]}`),
      g.products.length > 5 ? `อีก ${g.products.length - 5} ชื่อไม่ได้แสดงในกลุ่มนี้` : "",
    ]),
    !selected.length && !products.length ? "ไม่พบปัญหาตามเกณฑ์ในข้อมูลที่อ่านครบ ไม่ใช่การยืนยันว่าข้อมูลทุกส่วนถูกต้อง" : "",
    "อ่านตามวันที่เอกสารจากรายการที่ไม่ถูกยกเลิก; เคสอ้างอิงเฉพาะที่มีอยู่ในกล่องคุณภาพข้อมูล ยังไม่ได้สแกนใหม่",
    "ให้ผู้ดูแลตรวจหลักฐานและทะเบียนสินค้า/หมวดสต๊อกก่อนแก้ไข ไม่แก้ชื่อ ยอด หรือระดับความรุนแรงอัตโนมัติ",
    "สถานะยังไม่ประมวลผลของบรรทัดแชตเป็นเรื่องปกติ ไม่ใช้เป็นสัญญาณผิดพลาด",
  ].filter(Boolean).join("\n");
  if (text.length > DQ_ALERT_MAX_TEXT) throw new Error("daily_alert_message_limit");
  return { businessDate, counts, text };
}
