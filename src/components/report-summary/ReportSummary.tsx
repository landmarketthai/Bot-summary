"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import {
  buildReportGroups,
  type ReportGroup,
  type ReportRow,
  type SettlementMap,
} from "@/lib/summary/report";
import { formatThaiDate } from "@/lib/date";

export type { ReportRow, SettlementMap };

function fmtNum(n: number): string {
  const r = Math.round(n * 100) / 100;
  if (Number.isInteger(r)) return r.toString();
  return r.toFixed(2).replace(/0+$/, "");
}

const PROVISIONAL_TEXT = "รอตรวจสอบ (ข้อมูลชั่งคืนยังไม่ครบ)";

function fmtSummary(n: number): string {
  const r = Math.round(n * 100) / 100;
  return r.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}


function itemLine(r: ReportRow, i: number): string {
  const qty = r.quantity ?? 0;
  const unit = r.unit ?? "";
  const total = r.total_amount ?? 0;

  // price_per_unit is only a rounded display approximation for basis rows
  // (e.g. "3โล100บาท"); printing "qty x price_per_unit = total" would show an
  // equation that doesn't multiply out. Show the actual basis instead.
  const kindMark = r.session_kind === "additional" ? " [ชุดเพิ่ม]" : "";

  if (r.basis_quantity && r.basis_price != null) {
    const basisUnit = r.basis_unit ?? "";
    return `${i + 1}. ${r.product_name} ${fmtNum(qty)} ${unit} x ${fmtNum(r.basis_price)} บาท / ${fmtNum(r.basis_quantity)} ${basisUnit} = ${fmtNum(total)}${kindMark}`;
  }

  const price = r.price_per_unit ?? 0;
  return `${i + 1}. ${r.product_name} ${fmtNum(qty)} ${unit} x ${fmtNum(price)} = ${fmtNum(total)}${kindMark}`;
}

function generateText(g: ReportGroup): string {
  const dateStr = g.date !== "ไม่ระบุวันที่" ? formatThaiDate(g.date) : g.date;
  const lines: string[] = [];

  lines.push(`สรุป-${g.market} ${g.seller} วันที่ ${dateStr}`);
  lines.push("");

  let hadSection = false;

  if (g.เบิก.length > 0) {
    lines.push("เบิก");
    g.เบิก.forEach((r, i) => lines.push(itemLine(r, i)));
    lines.push("");
    hadSection = true;
  }

  if (g.คืน.length > 0) {
    lines.push("คืน");
    g.คืน.forEach((r, i) => lines.push(itemLine(r, i)));
    lines.push("");
    hadSection = true;
  }

  if (g.คืนเสีย.length > 0) {
    lines.push("คืนเสีย");
    g.คืนเสีย.forEach((r, i) => lines.push(itemLine(r, i)));
    lines.push("");
    hadSection = true;
  }

  if (!hadSection) lines.push("");

  lines.push("สรุปยอด");
  lines.push(`ยอดเบิก = ${fmtSummary(g.ยอดเบิก)}`);
  lines.push(`ยอดคืน = ${fmtSummary(g.ยอดคืน)}`);
  lines.push(`ยอดคืนเสีย = ${fmtSummary(g.ยอดคืนเสีย)}`);
  const money = (n: number) => (g.provisional ? PROVISIONAL_TEXT : fmtSummary(n));
  lines.push(`ยอดส่ง = ${money(g.ยอดส่ง)}`);
  lines.push(`ยอดโอน = ${fmtSummary(g.ยอดโอน)}`);
  lines.push(`เงินสดต้องส่งเจ๊ = ${money(g.เงินสดต้องส่งเจ๊)}`);
  lines.push(`ขาด/เกิน = ${money(g.ขาดเกิน)}`);

  return lines.join("\n");
}

function CopyButton({ text, label = "คัดลอก" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Button variant="secondary" size="sm" onClick={handleCopy}>
      {copied ? (
        <>
          <svg className="size-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
          </svg>
          คัดลอกแล้ว
        </>
      ) : (
        <>
          <svg className="size-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184" />
          </svg>
          {label}
        </>
      )}
    </Button>
  );
}

export function ReportSummary({
  rows,
  settlements,
  pdfUrl,
  uncertifiedKeys = [],
}: {
  rows: ReportRow[];
  settlements: SettlementMap;
  pdfUrl?: string;
  /** Server verdict: groups whose ชั่งคืน is not certified. */
  uncertifiedKeys?: string[];
}) {
  const printRef = useRef<HTMLDivElement>(null);
  const groups = buildReportGroups(rows, settlements, uncertifiedKeys);

  const allText = groups.map(generateText).join("\n\n");

  function handleDownload() {
    const blob = new Blob([allText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `รายงานสรุป-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handlePrint() {
    const content = printRef.current?.innerHTML ?? "";
    const win = window.open("", "_blank");
    if (!win) return;
    win.document.write(`<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="utf-8"/>
  <title>รายงานสรุป</title>
  <style>
    body { font-family: 'Sarabun', sans-serif; padding: 20px; font-size: 14px; }
    pre  { white-space: pre-wrap; font-family: inherit; font-size: 14px; margin: 0 0 24px; }
  </style>
</head>
<body>${content}</body>
</html>`);
    win.document.close();
    win.print();
  }

  if (groups.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-400">
        ไม่พบข้อมูล — เลือกวันที่ ตลาด หรือคนขาย
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <CopyButton text={allText} label={`คัดลอกทั้งหมด (${groups.length} กลุ่ม)`} />
        {pdfUrl && (
          <a
            href={pdfUrl}
            className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100 transition-colors"
          >
            <svg className="size-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m.75 12 3 3m0 0 3-3m-3 3v-6m-1.5-9H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
            </svg>
            Export PDF
          </a>
        )}
        <Button variant="secondary" size="sm" onClick={handleDownload}>
          <svg className="size-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
          </svg>
          ดาวน์โหลด TXT
        </Button>
        <Button variant="secondary" size="sm" onClick={handlePrint}>
          <svg className="size-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0 1 10.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0 .229 2.523a1.125 1.125 0 0 1-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0 0 21 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 0 0-1.913-.247M6.34 18H5.25A2.25 2.25 0 0 1 3 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.041 48.041 0 0 1 1.913-.247m10.5 0a48.536 48.536 0 0 0-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-.504.504-1.125 1.125v3.659M18 10.5h.008v.008H18V10.5Zm-3 0h.008v.008H15V10.5Z" />
          </svg>
          พิมพ์
        </Button>
      </div>

      <div ref={printRef} className="space-y-4">
        {groups.map((g) => {
          const text = generateText(g);
          return (
            <div
              key={`${g.date}||${g.market}||${g.seller}`}
              className="rounded-xl border border-slate-200 bg-white shadow-sm"
            >
              <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-2 border-b border-slate-100">
                <div className="text-sm font-semibold text-slate-700">
                  {g.market} · {g.seller} · {g.date !== "ไม่ระบุวันที่" ? formatThaiDate(g.date) : g.date}
                </div>
                <CopyButton text={text} />
              </div>
              <pre className="px-4 py-4 text-sm leading-relaxed text-slate-800 whitespace-pre-wrap font-[inherit] overflow-x-auto">
                {text}
              </pre>
            </div>
          );
        })}
      </div>
    </div>
  );
}
