import { describe, expect, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { resolveApprovedProductName } from "@/lib/produce/product-vocabulary";
import { PRODUCT_CODE_ENTRIES } from "@/lib/produce/product-code/dictionary";
import { stockCategoryEntries, stockCategoryFor, UNCATEGORIZED } from "@/lib/summary/stock-categories";
import { CATEGORY_LABEL_TH } from "./labels";
import { dailyAlertDate, DQ_ALERT_MAX_ROWS, DQ_ALERT_MAX_TEXT, loadDailyLineAlert, materialDailyAlertReturn } from "./daily-line-alert";

const DATE = "2026-10-15";
type Issue = Database["public"]["Tables"]["data_quality_issues"]["Row"];
const issue = (patch: Partial<Issue> = {}) => ({
  id: "issue-private", category: "produce_return_exceeds_withdrawal", severity: "ADVISORY",
  status: "OPEN", business_date: DATE,
  technical_context: { withdrawn_quantity: 4, good_return_quantity: 5, damaged_quantity: 0, excess_quantity: 1, unit: "ลูก" },
  ...patch,
}) as Issue;
const item = (id: string, product_name = "แก้วมังกรแดง", session_date = DATE, voided_at: string | null = null) => ({
  id, product_name, created_at: "2026-10-16T19:00:00Z", produce_sessions: { session_date, voided_at },
});

/** Real PostgREST query builder, entirely injected HTTP transport; no DB or network. */
function fixture(options: {
  issues?: ReturnType<typeof issue>[]; items?: ReturnType<typeof item>[];
  fault?: "error" | "truncated" | "missing-count" | "duplicate" | "drift" | "scope";
  faultTable?: string;
} = {}) {
  const rows = { data_quality_issues: options.issues ?? [], produce_items: options.items ?? [] };
  const reads: URL[] = [];
  const before = JSON.stringify(rows);
  const client = createClient<Database>("https://fixture.invalid", "fixture-placeholder", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (async (input, init) => {
      const url = new URL(String(input));
      reads.push(url);
      expect(init?.method).toBe("GET");
      const table = url.pathname.split("/").at(-1)!;
      expect(["data_quality_issues", "produce_items"]).toContain(table);
      const q = url.searchParams;
      expect(new Headers(init?.headers).get("prefer")).toBe("count=exact");
      expect(q.get("order")).toBe("id.asc");
      expect(q.get("limit")).toBe("500");
      const failing = table === (options.faultTable ?? "produce_items");
      if (failing && options.fault === "error") return Response.json({ message: "secret-token raw-chat" }, { status: 500 });
      let filtered;
      if (table === "produce_items") {
        expect(q.get("select")).toBe("id,product_name,produce_sessions!inner(session_date,voided_at)");
        expect(q.get("produce_sessions.session_date")).toBe(`eq.${DATE}`);
        expect(q.get("produce_sessions.voided_at")).toBe("is.null");
        filtered = rows.produce_items.filter((r) => r.produce_sessions.session_date === DATE && r.produce_sessions.voided_at === null);
      } else {
        expect(q.get("business_date")).toBe(`eq.${DATE}`);
        expect(q.get("status")).toBe("eq.OPEN");
        expect(q.get("select")).not.toMatch(/summary_th|affected_refs|raw/);
        filtered = rows.data_quality_issues.filter((r) => r.business_date === DATE && r.status === "OPEN");
      }
      const cursor = q.get("id")?.slice(3) ?? "";
      filtered = filtered.filter((r) => r.id > cursor).sort((a, b) => a.id.localeCompare(b.id));
      let count = filtered.length;
      let data = filtered.slice(0, Number(q.get("limit")));
      if (failing && options.fault === "truncated") data = data.slice(0, 1);
      if (failing && options.fault === "duplicate" && data.length > 1) data = [data[0], data[0], ...data.slice(2)];
      if (failing && options.fault === "drift" && cursor) count++;
      if (failing && options.fault === "scope") data = [item("bad-scope", "ส้มจีน", "2026-10-14")];
      return Response.json(data, { headers: { "content-range": `0-${Math.max(0, data.length - 1)}/${failing && options.fault === "missing-count" ? "*" : count}` } });
    }) as typeof fetch },
  });
  return { client, reads, unchanged: () => expect(JSON.stringify(rows)).toBe(before) };
}

describe("daily LINE DQ read-only report", () => {
  test("strict dates and previous Bangkok business day use the 04:00 cutoff", () => {
    expect(dailyAlertDate(null, Date.parse("2026-10-16T03:59:00+07:00"))).toBe("2026-10-14");
    expect(dailyAlertDate(null, Date.parse("2026-10-16T04:00:00+07:00"))).toBe(DATE);
    expect(dailyAlertDate("2024-02-29")).toBe("2024-02-29");
    for (const invalid of ["", "2026-02-29", "2026-04-31", "2026-13-01", "2026-1-01", "2026-10-15T00:00:00Z", " 2026-10-15", "0000-01-01"]) {
      expect(() => dailyAlertDate(invalid)).toThrow("invalid_date");
    }
  });
  test("exact session day, nonvoid, known code versus missing code and section hints", async () => {
    const f = fixture({ items: [item("01"), item("02"), item("03", "ผลไม้กล่อง"), item("04", "ส้มจีน"),
      item("05", "หมอนทอง"), item("06", "ส้มจีน", "2026-10-14"), item("07", "ส้มจีน", DATE, "2026-10-16"),
      item("08", "กล้วยเล็บมือนาง"), item("09", "กล้วยเล็บมือนาง"), item("10", " ส้มจีน ")] });
    const result = await loadDailyLineAlert(f.client, DATE);
    expect(result.counts).toEqual({ critical: 0, actionRequired: 0, materialReturnExceeds: 0, selectedIssues: 0,
      unknownProductIssues: 0, produceItems: 8, anomalyItems: 7, anomalyNames: 4,
      uncategorizedItems: 5, uncategorizedNames: 3, missingCodeItems: 4, missingCodeNames: 2,
      approvedMissingCategoryItems: 3, approvedMissingCategoryNames: 2, omittedNames: 0 });
    expect(result.text).toContain("แก้วมังกรแดง: 2 รายการ; แนวทางหมวด: ผลไม้");
    expect(result.text).toContain("ส้มจีน: 2 รายการ; แนวทางหมวด: ผลไม้");
    expect(result.text).toContain("กล้วยเล็บมือนาง: 2 รายการ; แนวทางหมวด: ผลไม้");
    for (const name of ["ส้มจีน", "แก้วมังกรแดง", "กล้วยเล็บมือนาง"]) expect(result.text.split(`${name}:`)).toHaveLength(2);
    expect(result.text).not.toContain("หมอนทอง");
    expect(result.text).not.toContain("ไม่ส่ง LINE");
    expect(result.text).toContain("เป็นเรื่องปกติ");
    f.unchanged();
    expect(f.reads).toHaveLength(2);
  });
  test("categorized fruit with no approved code is still an anomaly", async () => {
    expect(stockCategoryFor("กล้วยเล็บมือนาง")).toBe("ผลไม้");
    expect(resolveApprovedProductName("กล้วยเล็บมือนาง")).toBeNull();
    const f = fixture({ items: [item("01", "กล้วยเล็บมือนาง")] });
    const result = await loadDailyLineAlert(f.client, DATE);
    expect(result.counts).toMatchObject({ anomalyItems: 1, anomalyNames: 1,
      uncategorizedItems: 0, uncategorizedNames: 0, missingCodeItems: 1, missingCodeNames: 1,
      approvedMissingCategoryItems: 0, approvedMissingCategoryNames: 0 });
    expect(result.text).toContain("ไม่มีรหัส / มีหมวดสต๊อกแล้ว: 1 รายการ / 1 ชื่อ");
    expect(result.text).toContain("กล้วยเล็บมือนาง: 1 รายการ; แนวทางหมวด: ผลไม้");
    expect(result.text).not.toContain("ไม่พบปัญหาตามเกณฑ์");
    f.unchanged();
  });
  test("OPEN high priority, material returns and unknown-product advisories; no severity escalation", async () => {
    const f = fixture({ issues: [issue({ id: "01" }), issue({ id: "02", severity: "CRITICAL" }),
      issue({ id: "03", severity: "ACTION_REQUIRED", category: "produce_no_return" }),
      issue({ id: "04", status: "RESOLVED", severity: "CRITICAL" }), issue({ id: "05", status: "IGNORED" }),
      issue({ id: "06", category: "produce_price_conflict" }), issue({ id: "07", business_date: "2026-10-14" }),
      issue({ id: "08", category: "produce_unknown_product", technical_context: null }),
      issue({ id: "09", category: "produce_unknown_product", status: "RESOLVED" }),
      issue({ id: "10", category: "produce_unknown_product", status: "IGNORED" }),
      issue({ id: "11", category: "produce_unknown_product", business_date: "2026-10-14" })] });
    const result = await loadDailyLineAlert(f.client, DATE);
    expect(result.counts).toMatchObject({ critical: 1, actionRequired: 1, materialReturnExceeds: 2, selectedIssues: 4, unknownProductIssues: 1 });
    expect(result.text).toContain(`${CATEGORY_LABEL_TH.produce_unknown_product}: 1 เคส`);
    expect(result.text).toContain("คง severity เดิม");
    expect(result.text).toContain("ยังไม่ได้สแกนใหม่");
    f.unchanged();
  });
  test("screens consistent material snapshots without escalating advisory", () => {
    for (const [withdrawn, good, excess, expected] of [[100, 110, 10, true], [4, 5, 1, true], [100, 109, 9, false], [0, 1, 1, true], [4, 5, 10, false], [-1, 5, 6, false], [NaN, 5, 1, false]] as const) {
      expect(materialDailyAlertReturn(issue({ technical_context: { withdrawn_quantity: withdrawn, good_return_quantity: good, damaged_quantity: 0, excess_quantity: excess, unit: "ลูก" } }))).toBe(expected);
    }
    expect(materialDailyAlertReturn(issue({ status: "RESOLVED" }))).toBe(false);
  });
  test("bounded names, safe text limit, no IDs, secrets, raw chat or free-form contexts", async () => {
    const sensitive = "C0123456789abcdef0123456789abcdef";
    const names = [sensitive, "Bearer secret-token", "api_key=private", "raw-chat\nmessage", "ผลไม้ก", "ผลไม้ข", "ผลไม้ค", "ผลไม้ง", "ผลไม้จ", "ผลไม้ฉ", "ผลไม้ช", "ผลไม้ซ"];
    const f = fixture({ items: names.map((name, i) => item(String(i).padStart(3, "0"), name)),
      issues: [issue({ severity: "CRITICAL", category: "produce_no_return", technical_context: { raw_text: sensitive, token: "secret-token" } })] });
    const result = await loadDailyLineAlert(f.client, DATE);
    expect(result.counts.omittedNames).toBe(7);
    expect(result.text).toContain("อีก 7 ชื่อไม่ได้แสดง");
    expect(result.text).toContain("[ปกปิดชื่อ]");
    expect(result.text.length).toBeLessThanOrEqual(DQ_ALERT_MAX_TEXT);
    for (const privateText of [sensitive, "secret-token", "api_key", "raw-chat", "issue-private"]) expect(JSON.stringify(result)).not.toContain(privateText);
    f.unchanged();
  });
  test("128 synthetic item lines include all three reported names and nine OPEN unknown-product advisories", async () => {
    const f = fixture({ items: [...Array.from({ length: 120 }, (_, i) => item(String(i).padStart(3, "0"), "หมอนทอง")),
      ...["ส้มจีน", "ส้มจีน", "แก้วมังกรแดง", "แก้วมังกรแดง", "แก้วมังกรแดง", "กล้วยเล็บมือนาง", "กล้วยเล็บมือนาง", "กล้วยเล็บมือนาง"]
        .map((name, i) => item(String(i + 120), name))],
    issues: [...Array.from({ length: 9 }, (_, i) => issue({ id: `unknown-${i}`, category: "produce_unknown_product",
      technical_context: { product_name: "กล้วยเล็บมือนาง" } })), issue({ id: "return" }),
      issue({ id: "critical", severity: "CRITICAL", category: "produce_price_conflict" }),
      issue({ id: "action", severity: "ACTION_REQUIRED", category: "produce_no_return" })] });
    const result = await loadDailyLineAlert(f.client, DATE);
    expect(result.counts).toMatchObject({ produceItems: 128, anomalyItems: 8, anomalyNames: 3,
      uncategorizedItems: 5, uncategorizedNames: 2, missingCodeItems: 5, missingCodeNames: 2,
      approvedMissingCategoryItems: 3, approvedMissingCategoryNames: 1,
      selectedIssues: 12, unknownProductIssues: 9, critical: 1, actionRequired: 1, materialReturnExceeds: 1 });
    for (const name of ["ส้มจีน", "แก้วมังกรแดง", "กล้วยเล็บมือนาง"]) expect(result.text).toContain(name);
    expect(result.text).toContain(`${CATEGORY_LABEL_TH.produce_unknown_product}: 9 เคส`);
    expect(result.text).toContain("สัญญาณคนละแหล่ง อาจซ้ำกัน ห้ามบวกเป็นจำนวนเหตุการณ์");
    expect(result.text.length).toBeLessThanOrEqual(DQ_ALERT_MAX_TEXT);
    f.unchanged();
  });
  test("each product group keeps its own top five and exact omissions under the text limit", async () => {
    const categorized = [stockCategoryEntries().map(([name]) => name).find((name) => !resolveApprovedProductName(name))!,
      ...Array.from({ length: 5 }, (_, i) => "ทุเรียน".padEnd(59, "ก") + String.fromCharCode(0x0e01 + i))];
    const approved = [...new Set(PRODUCT_CODE_ENTRIES.filter((e) => e.enabled && stockCategoryFor(e.canonicalName) === UNCATEGORIZED)
      .map((e) => e.canonicalName))].slice(0, 6);
    const unknown = Array.from({ length: 6 }, (_, i) => "ก".repeat(59) + String.fromCharCode(0x0e01 + i));
    expect(categorized).toHaveLength(6);
    expect(approved).toHaveLength(6);
    const f = fixture({ items: [...unknown, ...categorized, ...approved].flatMap((name, i) =>
      Array.from({ length: i < 6 ? 20 : 1 }, (_, j) => item(`${String(i).padStart(3, "0")}-${String(j).padStart(2, "0")}`, name))),
    issues: Object.keys(CATEGORY_LABEL_TH).map((category, i) => issue({ id: String(i).padStart(2, "0"), category, severity: "CRITICAL" })) });
    const result = await loadDailyLineAlert(f.client, DATE);
    expect(result.counts).toMatchObject({ anomalyItems: 132, anomalyNames: 18, missingCodeItems: 126, missingCodeNames: 12,
      uncategorizedItems: 126, uncategorizedNames: 12, approvedMissingCategoryItems: 6, approvedMissingCategoryNames: 6, omittedNames: 3 });
    expect(result.text.match(/อีก 1 ชื่อไม่ได้แสดง/g)).toHaveLength(3);
    for (const names of [unknown, categorized, approved]) {
      expect(names.filter((name) => result.text.includes(`${name}:`))).toHaveLength(5);
    }
    expect(result.text).toContain("เร่งด่วน 17");
    expect(result.text).toContain("คืนเกินมีนัยสำคัญ 1");
    expect(result.text.length).toBeLessThanOrEqual(DQ_ALERT_MAX_TEXT);
    f.unchanged();
  });
  test("both sources paginate beyond 500 and include the final page", async () => {
    const f = fixture({ items: Array.from({ length: 1001 }, (_, i) => item(String(i).padStart(5, "0"))),
      issues: Array.from({ length: 701 }, (_, i) => issue({ id: String(i).padStart(5, "0"), severity: "ACTION_REQUIRED" })) });
    const result = await loadDailyLineAlert(f.client, DATE);
    expect(result.counts.uncategorizedItems).toBe(1001);
    expect(result.counts.actionRequired).toBe(701);
    expect(f.reads).toHaveLength(5);
    f.unchanged();
  });
  test("unknown or incomplete pages fail closed on either source", async () => {
    for (const faultTable of ["produce_items", "data_quality_issues"]) {
      for (const fault of ["error", "truncated", "missing-count", "duplicate", "drift"] as const) {
        const f = fixture({ faultTable, fault,
          items: Array.from({ length: 501 }, (_, i) => item(String(i).padStart(5, "0"))),
          issues: Array.from({ length: 501 }, (_, i) => issue({ id: String(i).padStart(5, "0") })) });
        await expect(loadDailyLineAlert(f.client, DATE)).rejects.toThrow("daily_alert_read_incomplete");
        f.unchanged();
      }
    }
  });
  test("row bounds and invalid scope fail, genuine empty results are qualified", async () => {
    const over = fixture({ items: Array.from({ length: DQ_ALERT_MAX_ROWS + 1 }, (_, i) => item(String(i).padStart(6, "0"))) });
    await expect(loadDailyLineAlert(over.client, DATE)).rejects.toThrow("daily_alert_read_incomplete");
    await expect(loadDailyLineAlert(fixture({ items: [item("a")], fault: "scope" }).client, DATE)).rejects.toThrow("daily_alert_scope_unavailable");
    const empty = fixture();
    const result = await loadDailyLineAlert(empty.client, DATE);
    expect(result.counts.produceItems).toBe(0);
    expect(result.text).toContain("ไม่ใช่การยืนยันว่าข้อมูลทุกส่วนถูกต้อง");
    const invalid = fixture();
    await expect(loadDailyLineAlert(invalid.client, "2026-02-30")).rejects.toThrow("invalid_date");
    expect(invalid.reads).toHaveLength(0);
  });
  test("unknown material-return evidence fails instead of claiming zero qualifying cases", async () => {
    const f = fixture({ issues: [issue({ technical_context: { excess_quantity: 1 } })] });
    await expect(loadDailyLineAlert(f.client, DATE)).rejects.toThrow("daily_alert_return_snapshot_unavailable");
  });
});
