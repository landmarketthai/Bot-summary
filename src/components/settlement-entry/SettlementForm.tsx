"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";

interface YodSong {
  เบิก:     number;
  คืน:      number;
  คืนเสีย:  number;
  /** null while the settlement verdict does not certify the ชั่งคืน. */
  ยอดส่ง:   number | null;
}

interface InitialValues {
  date:          string;
  market:        string;
  seller:        string;
  sourceId?:     string;
  moneyTransfer: number;
  moneyCash:     number;
  expenses:      number;
  labor:         number;
  notes:         string;
}

function fmtMoney(n: number): string {
  return n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const INPUT_CLS =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 " +
  "placeholder:text-slate-400 focus:border-[#06C755] focus:outline-none focus:ring-2 focus:ring-[#06C755]/20";

export function SettlementForm({ initial }: { initial?: Partial<InitialValues> }) {
  const [date,          setDate]          = useState(initial?.date          ?? "");
  const [market,        setMarket]        = useState(initial?.market        ?? "");
  const [seller,        setSeller]        = useState(initial?.seller        ?? "");
  const [moneyTransfer, setMoneyTransfer] = useState(initial?.moneyTransfer ?? 0);
  const [moneyCash,     setMoneyCash]     = useState(initial?.moneyCash     ?? 0);
  const [expenses,      setExpenses]      = useState(initial?.expenses      ?? 0);
  const [labor,         setLabor]         = useState(initial?.labor         ?? 0);
  const [notes,         setNotes]         = useState(initial?.notes         ?? "");
  const [yodSong,       setYodSong]       = useState<YodSong | null>(null);
  const [fetchError,    setFetchError]    = useState("");
  const [saveStatus,    setSaveStatus]    = useState<"idle" | "saved" | "error">("idle");
  const [saveMsg,       setSaveMsg]       = useState("");
  const [fetching,      startFetch]       = useTransition();
  const [saving,        startSave]        = useTransition();

  const ยอดขาย  = moneyTransfer + moneyCash + expenses + labor;
  // The API withholds ยอดส่ง (null) while a ชั่งคืน is unresolved: no ขาด/เกิน.
  const ขาดเกิน = yodSong?.ยอดส่ง != null ? ยอดขาย - yodSong.ยอดส่ง : null;

  const month = date ? date.slice(0, 7) : null;

  async function handleFetch() {
    if (!date) { setFetchError("กรุณาเลือกวันที่ก่อน"); return; }
    setFetchError("");
    startFetch(async () => {
      const params = new URLSearchParams({ date });
      if (market) params.set("market", market);
      if (seller) params.set("seller", seller);
      const res  = await fetch(`/api/settlement/yod-song?${params}`);
      const json = await res.json() as YodSong & { error?: string };
      if (!res.ok) { setFetchError(json.error ?? "เกิดข้อผิดพลาด"); return; }
      setYodSong(json);
    });
  }

  async function handleSave() {
    if (!date) { setSaveMsg("กรุณาเลือกวันที่"); setSaveStatus("error"); return; }
    setSaveMsg("");
    setSaveStatus("idle");
    const sourceId =
      initial?.sourceId &&
      date === initial.date &&
      market === initial.market &&
      seller === initial.seller
        ? initial.sourceId
        : undefined;

    startSave(async () => {
      const res = await fetch("/api/settlement", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settlement_date: date,
          settlement_time: "",
          staff_name:      seller,
          market_name:     market,
          money_transfer:  moneyTransfer,
          money_cash:      moneyCash,
          expenses,
          labor,
          notes,
          notify_line:     true,
          ...(sourceId ? { source_id: sourceId } : {}),
        }),
      });
      const json = await res.json() as {
        error?:          string;
        lineError?:      string | null;
        lineTargets?:    number;
        finalizeStatus?: string;
      };
      if (!res.ok) {
        setSaveMsg(json.error ?? "บันทึกไม่สำเร็จ");
        setSaveStatus("error");
      } else {
        if (json.finalizeStatus !== undefined) {
          // source_id path: finalizer result (LINE sent only when all evidence is ready)
          const msgs: Record<string, string> = {
            finalized:    "บันทึกสำเร็จ ส่งสรุปผลไปยัง LINE แล้ว",
            already_done: "บันทึกสำเร็จ (ส่ง LINE ไปแล้วก่อนหน้า)",
            not_ready:    "บันทึกสำเร็จ รอสลิปครบก่อนส่ง LINE",
            ambiguous:    "บันทึกสำเร็จ แต่ไม่ส่ง LINE เพราะพบรายการซ้ำซ้อน",
            failed:       "บันทึกสำเร็จ แต่ส่ง LINE ไม่สำเร็จ กรุณาตรวจสอบ",
          };
          setSaveMsg(msgs[json.finalizeStatus] ?? "บันทึกสำเร็จ");
        } else {
          // legacy path (no source_id): immediate LINE notification
          setSaveMsg(
            json.lineError
              ? "บันทึกสำเร็จ แต่ส่ง LINE ไม่สำเร็จ"
              : json.lineTargets === 0
                ? "บันทึกสำเร็จ แต่ไม่พบกลุ่ม LINE สำหรับรายการนี้"
                : "บันทึกสำเร็จและแจ้ง LINE แล้ว",
          );
        }
        setSaveStatus("saved");
      }
    });
  }

  return (
    <div className="space-y-5 max-w-lg pt-5">
      {/* Identity fields */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide">วันที่</label>
          <input
            type="date"
            value={date}
            onChange={e => { setDate(e.target.value); setYodSong(null); }}
            className={INPUT_CLS}
          />
        </div>

        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide">ตลาด</label>
          <input
            type="text"
            value={market}
            onChange={e => { setMarket(e.target.value); setYodSong(null); }}
            placeholder="ชื่อตลาด (ตรงกัน)"
            className={INPUT_CLS}
          />
        </div>

        <div className="col-span-2 space-y-1.5">
          <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide">คนขาย</label>
          <input
            type="text"
            value={seller}
            onChange={e => { setSeller(e.target.value); setYodSong(null); }}
            placeholder="ชื่อคนขาย (ตรงกัน)"
            className={INPUT_CLS}
          />
        </div>
      </div>

      {/* Divider */}
      <div className="border-t border-slate-100" />

      {/* Money fields */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide">เงินโอน</label>
          <input
            type="number"
            min={0}
            step="0.01"
            value={moneyTransfer || ""}
            placeholder="0"
            onChange={e => setMoneyTransfer(parseFloat(e.target.value) || 0)}
            className={INPUT_CLS + " text-right tabular-nums"}
          />
        </div>

        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide">เงินสด</label>
          <input
            type="number"
            min={0}
            step="0.01"
            value={moneyCash || ""}
            placeholder="0"
            onChange={e => setMoneyCash(parseFloat(e.target.value) || 0)}
            className={INPUT_CLS + " text-right tabular-nums"}
          />
        </div>

        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide">ค่าใช้จ่าย</label>
          <input
            type="number"
            min={0}
            step="0.01"
            value={expenses || ""}
            placeholder="0"
            onChange={e => setExpenses(parseFloat(e.target.value) || 0)}
            className={INPUT_CLS + " text-right tabular-nums"}
          />
        </div>

        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide">ค่าแรง</label>
          <input
            type="number"
            min={0}
            step="0.01"
            value={labor || ""}
            placeholder="0"
            onChange={e => setLabor(parseFloat(e.target.value) || 0)}
            className={INPUT_CLS + " text-right tabular-nums"}
          />
        </div>

        <div className="col-span-2 space-y-1.5">
          <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide">หมายเหตุ</label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="หมายเหตุ (ถ้ามี)"
            rows={2}
            className={INPUT_CLS + " resize-none"}
          />
        </div>
      </div>

      {/* Auto-calc summary */}
      <div className="rounded-xl bg-slate-50 border border-slate-100 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">ยอดขายรวม</span>
          <span className="text-lg font-bold tabular-nums text-slate-800">{fmtMoney(ยอดขาย)}</span>
        </div>

        <div className="border-t border-slate-200 pt-3 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <Button
              variant="secondary"
              size="sm"
              isLoading={fetching}
              onClick={handleFetch}
            >
              <svg className="size-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
              </svg>
              ดึงยอดส่งจากข้อมูล
            </Button>
            {fetchError && <p className="text-xs text-red-600">{fetchError}</p>}
          </div>

          {yodSong && (
            <div className="rounded-lg bg-white border border-slate-200 p-3 space-y-2.5">
              <div className="grid grid-cols-3 gap-2">
                {([ ["ยอดเบิก", fmtMoney(yodSong.เบิก), "text-emerald-700"],
                    ["ยอดคืน",  fmtMoney(yodSong.คืน),  "text-blue-600"],
                    ["ยอดคืนเสีย", fmtMoney(yodSong.คืนเสีย), "text-red-600"],
                ] as const).map(([label, value, color]) => (
                  <div key={label} className="space-y-0.5">
                    <p className="text-[11px] text-slate-400 font-medium">{label}</p>
                    <p className={`text-sm font-semibold tabular-nums ${color}`}>{value}</p>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between border-t border-slate-100 pt-2.5">
                <span className="text-xs text-slate-500">ยอดขายสุทธิ (เบิก−คืน−คืนเสีย)</span>
                <span className="text-sm font-bold tabular-nums text-slate-800">
                  {yodSong.ยอดส่ง == null ? "รอตรวจสอบ (ข้อมูลชั่งคืนยังไม่ครบ)" : fmtMoney(yodSong.ยอดส่ง)}
                </span>
              </div>
            </div>
          )}

          {ขาดเกิน != null && (
            <div className="flex items-center justify-between rounded-lg bg-white border border-slate-200 px-3 py-2.5">
              <span className="text-sm font-medium text-slate-600">ขาด / เกิน</span>
              <span className={`text-base font-bold tabular-nums ${
                ขาดเกิน === 0 ? "text-slate-400" :
                ขาดเกิน > 0   ? "text-emerald-600" : "text-red-600"
              }`}>
                {ขาดเกิน > 0 ? "+" : ""}{fmtMoney(ขาดเกิน)}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <Button isLoading={saving} onClick={handleSave}>
          <svg className="size-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
          </svg>
          บันทึก
        </Button>

        {month && (
          <Link
            href={`/financial-summary?month=${month}`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-700 transition-colors"
          >
            <svg className="size-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z" />
            </svg>
            ดูสรุปการเงิน
          </Link>
        )}

        {saveStatus !== "idle" && (
          <span className={`text-sm font-medium ${saveStatus === "saved" ? "text-emerald-600" : "text-red-600"}`}>
            {saveMsg}
          </span>
        )}
      </div>
    </div>
  );
}
