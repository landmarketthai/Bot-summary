import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { NextRequest } from "next/server";
import type { GroupRow } from "@/components/financial-summary/FinancialTable";
import { FinancialSummaryDoc } from "@/lib/pdf/FinancialSummaryDoc";
import { registerFonts } from "@/lib/pdf/fonts";
import { fixtureClient } from "../../../../../scripts/release-uat-monthly";
import { assertMonthlyPdf, pdfTextRuns } from "../../../../../scripts/staging-session-month.mjs";

const octoberPdf = { month: "ตุลาคม 2569", firstDate: "1 ต.ค. 69", lastDate: "31 ต.ค. 69" };

let fake = fixtureClient(0);
let renderedGroups: GroupRow[] = [];
mock.module("@/lib/supabase/server", () => ({ createServiceClient: () => fake.client }));
const renderer = await import("@react-pdf/renderer");
const renderToBuffer = renderer.renderToBuffer;
mock.module("@react-pdf/renderer", () => ({ ...renderer,
  renderToBuffer: async (document: Parameters<typeof renderer.renderToBuffer>[0]) => {
    renderedGroups = (document.props as { groups: GroupRow[] }).groups;
    return renderToBuffer(document);
  },
}));
const { GET } = await import("./route");

for (const resolved of [false, true]) {
  test(`31-day financial PDF: ${resolved ? "resolved" : "unbound failed return"}, real local renderer, no network`, async () => {
    fake = fixtureClient(0, { resolved });
    const originalFetch = globalThis.fetch;
    let networkAttempts = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      // Yoga's installed WASM uses a data URL; reading embedded bytes opens no socket.
      if (url.protocol === "data:") return originalFetch(input, init);
      networkAttempts++; throw new Error("network forbidden");
    }) as typeof fetch;
    try {
      const start = performance.now();
      const response = await GET(new NextRequest("http://localhost/api/pdf/financial-summary?month=2026-10"));
      const pdf = Buffer.from(await response.arrayBuffer());
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/pdf");
      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
      expect(pdf.length).toBeGreaterThan(1000);
      expect(renderedGroups).toHaveLength(310);
      expect(renderedGroups.every((group) => group.produceNetStatus === (resolved ? "trusted" : "return_incomplete"))).toBe(true);
      expect(fake.queries.accountability_rounds).toBe(93);
      if (!resolved) expect(fake.queries.pending_session_ingest).toBe(31 * 13);
      expect(networkAttempts).toBe(0);
      // The host month gate decodes these same bytes: Thai text, exact rows, provisional marker.
      const sellers = ["ผู้ขาย0", "ผู้ขาย9"];
      const runs = pdfTextRuns(pdf);
      expect(runs.filter((value) => value === "ตรวจสอบ")).toHaveLength(resolved ? 0 : 310 * 2 + 2);
      expect(runs).toContain("รวม 310 กลุ่ม");
      if (resolved) {
        expect(runs).toContain("ผู้ขาย0");
        expect(() => assertMonthlyPdf(pdf, sellers, octoberPdf)).toThrow("Monthly PDF row not provisional: 1 ต.ค. 69 ผู้ขาย0");
      } else {
        // Production-like host gate verifies all 31×10 source identities, not
        // merely the first/last two rows. A certified middle row must not pass.
        const expectedRows = Array.from({ length: 31 }, (_, d) =>
          Array.from({ length: 10 }, (_, s) => [`${d + 1} ต.ค. 69`, `ผู้ขาย${s}`])).flat();
        assertMonthlyPdf(pdf, sellers, { ...octoberPdf, expectedRows });
        expect(() => assertMonthlyPdf(pdf, sellers, { ...octoberPdf,
          expectedRows: [...expectedRows, ['15 ต.ค. 69', 'ผู้ขายX']] }))
          .toThrow('Monthly PDF row missing or duplicated: 15 ต.ค. 69 ผู้ขายX');
        expect(() => assertMonthlyPdf(pdf, undefined, octoberPdf)).toThrow("Monthly PDF row missing or duplicated: 1 ต.ค. 69 ผู้ขาย๐");
        // Whole-cell match only: neither a prefix nor a longer label passes.
        expect(() => assertMonthlyPdf(pdf, ["ผู้ขาย", "ผู้ขาย9"], octoberPdf)).toThrow("Monthly PDF row missing or duplicated: 1 ต.ค. 69 ผู้ขาย");
        expect(() => assertMonthlyPdf(pdf, ["ผู้ขาย0", "ผู้ขาย90"], octoberPdf)).toThrow("Monthly PDF row missing or duplicated: 31 ต.ค. 69 ผู้ขาย90");
        expect(() => assertMonthlyPdf(pdf, sellers, { ...octoberPdf, lastDate: "1 ต.ค. 6" })).toThrow("Monthly PDF row missing");
        expect(() => assertMonthlyPdf(pdf, sellers)).toThrow("Monthly PDF text missing: สิงหาคม 2569");
        expect(() => assertMonthlyPdf(pdf.subarray(0, pdf.length - 40), sellers, octoberPdf)).toThrow();
        expect(() => assertMonthlyPdf(Buffer.from("%PDF-1.3\n%%EOF\n"), sellers, octoberPdf)).toThrow();
      }
      console.log(JSON.stringify({ monthlyPdf: resolved ? "resolved" : "pending", ms: performance.now() - start,
        bytes: pdf.length, groups: renderedGroups.length, queries: fake.queries,
        totalQueries: Object.values(fake.queries).reduce((a, b) => a + b, 0), networkAttempts }));
    } finally { globalThis.fetch = originalFetch; }
  }, 30_000);
}

// Independent cross-check of the in-house decoder: an external extractor
// (Xpdf/Poppler `pdftotext -layout`) reads the same route bytes. It may reorder
// Thai combining marks, so cells compare on spacing/mark-free skeletons.
const pdftotext = Bun.which("pdftotext");
const skeleton = (text: string) => text.replace(/[\sัิ-ฺ็-๎]/g, "");
const amount = String.raw`-?[\d,]+\.\d{2}`;
const rowTail = (status: string) => new RegExp(String.raw`(?:${amount}\s+){3}${status}(?:\s+${amount}){5}\s+${status}\s*$`);

function pdftotextLines(pdf: Buffer): string[] {
  const dir = mkdtempSync(join(tmpdir(), "financial-pdf-"));
  try {
    writeFileSync(join(dir, "report.pdf"), pdf);
    const out = spawnSync(pdftotext!, ["-layout", "-enc", "UTF-8", join(dir, "report.pdf"), "-"], { encoding: "utf8" });
    expect(out.status).toBe(0);
    return out.stdout.split(/\r?\n/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ponytail: skipped, not failed, where CI lacks pdftotext; the in-house decoder test above still runs.
test.skipIf(!pdftotext)("BLOCKED without pdftotext — independent extractor: every seller/date row of the route PDF", async () => {
  for (const resolved of [false, true]) {
    fake = fixtureClient(0, { resolved });
    const response = await GET(new NextRequest("http://localhost/api/pdf/financial-summary?month=2026-10"));
    expect(response.status).toBe(200);
    const lines = pdftotextLines(Buffer.from(await response.arrayBuffer()));
    const all = skeleton(lines.join(""));
    for (const heading of ["สรุปการเงิน", "ตุลาคม 2569"]) expect(all).toContain(skeleton(heading));
    // Pending: ยอดส่ง and ขาด/เกิน are ตรวจสอบ; resolved: both are amounts.
    const tail = rowTail(resolved ? amount : "ตรวจสอบ");
    for (let day = 1; day <= 31; day++) {
      for (let seller = 0; seller < 10; seller++) {
        const identity = skeleton(`${day} ต.ค. 69 ผู้ขาย${seller} ราชพฤกษ์`);
        const matches = lines.filter((line) => skeleton(line).startsWith(identity));
        expect(matches).toHaveLength(1);
        expect(matches[0]!).toMatch(tail);
      }
    }
    const footer = lines.filter((line) => skeleton(line).startsWith(skeleton("รวม 310 กลุ่ม")));
    expect(footer).toHaveLength(1);
    expect(footer[0]!).toMatch(tail);
    expect(lines.join("\n").match(/ตรวจสอบ/g)?.length ?? 0).toBe(resolved ? 0 : 310 * 2 + 2);
  }
}, 60_000);

// Real-renderer PDFs for the host gate's August defaults (1/31 ส.ค. 69, ผู้ขาย๐/๙).
// [date, seller, provisional, market]; other rows and the footer still show ตรวจสอบ.
async function augustPdf(rows: [string, string, boolean, string?][]) {
  registerFonts();
  const groups: GroupRow[] = rows.map(([date, seller, provisional, market = "ตลาดA 1"]) => ({ date, time: null, seller, market,
    เบิก: 1250, คืน: 10, คืนเสีย: 1, ยอดส่ง: 1239, produceNetStatus: provisional ? "return_incomplete" : "trusted" }));
  return renderToBuffer(createElement(FinancialSummaryDoc, { month: "2026-08", groups, settlements: [] }) as Parameters<typeof renderToBuffer>[0]);
}

test("monthly PDF gate binds ตรวจสอบ to ยอดส่ง and ขาด/เกิน of every protected seller/date row", async () => {
  const middle: [string, string, boolean] = ["2026-08-02", "ผู้ขาย1", true];
  const allExpected = [['1 ส.ค. 69', 'ผู้ขาย๐'], ['2 ส.ค. 69', 'ผู้ขาย1'], ['31 ส.ค. 69', 'ผู้ขาย๙']];
  assertMonthlyPdf(await augustPdf([["2026-08-01", "ผู้ขาย๐", true], middle, ["2026-08-31", "ผู้ขาย๙", true]]),
    undefined, { expectedRows: allExpected });
  const certifiedMiddle = await augustPdf([["2026-08-01", "ผู้ขาย๐", true],
    ["2026-08-02", "ผู้ขาย1", false], ["2026-08-31", "ผู้ขาย๙", true]]);
  // Old first/last-only gate could approve this; the host-style full source list MUST reject.
  assertMonthlyPdf(certifiedMiddle);
  expect(() => assertMonthlyPdf(certifiedMiddle, undefined, { expectedRows: allExpected }))
    .toThrow('Monthly PDF row not provisional: 2 ส.ค. 69 ผู้ขาย1');
  // Before row binding, each of these passed: ตรวจสอบ existed somewhere (another
  // row, the footer, even this row's market cell) and the date/seller pair matched.
  expect(pdfTextRuns(await augustPdf([["2026-08-01", "ผู้ขาย๐", false, "ตรวจสอบ"], middle, ["2026-08-31", "ผู้ขาย๙", true]])))
    .toContain("1,239.00");
  for (const [rows, error] of [
    [[["2026-08-01", "ผู้ขาย๐", false, "ตรวจสอบ"], middle, ["2026-08-31", "ผู้ขาย๙", true]], "Monthly PDF row not provisional: 1 ส.ค. 69 ผู้ขาย๐"],
    [[["2026-08-01", "ผู้ขาย๐", true], middle, ["2026-08-31", "ผู้ขาย๙", false]], "Monthly PDF row not provisional: 31 ส.ค. 69 ผู้ขาย๙"],
    // A provisional duplicate cannot cover a certified row of the same seller/date.
    [[["2026-08-01", "ผู้ขาย๐", true], ["2026-08-01", "ผู้ขาย๐", false, "ตลาดB"], ["2026-08-31", "ผู้ขาย๙", true]],
      "Monthly PDF row not provisional: 1 ส.ค. 69 ผู้ขาย๐"],
    // Exact first/last identity: 11 ≠ 1, ผู้ขาย๐๐ ≠ ผู้ขาย๐, ผู้ขาย๙ on 30 ≠ 31.
    [[["2026-08-11", "ผู้ขาย๐", true], ["2026-08-31", "ผู้ขาย๙", true]], "Monthly PDF row missing or duplicated: 1 ส.ค. 69 ผู้ขาย๐"],
    [[["2026-08-01", "ผู้ขาย๐๐", true], ["2026-08-31", "ผู้ขาย๙", true]], "Monthly PDF row missing or duplicated: 1 ส.ค. 69 ผู้ขาย๐"],
    [[["2026-08-01", "ผู้ขาย๐", true], ["2026-08-30", "ผู้ขาย๙", true], ["2026-08-31", "ผู้ขาย๘", true]],
      "Monthly PDF row missing or duplicated: 31 ส.ค. 69 ผู้ขาย๙"],
  ] as [[string, string, boolean, string?][], string][]) {
    const pdf = await augustPdf(rows);
    expect(() => assertMonthlyPdf(pdf)).toThrow(error);
  }
}, 30_000);
