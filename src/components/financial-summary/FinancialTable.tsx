"use client";

import { useState, useRef } from "react";
import { calculateSettlementTotals } from "@/lib/summary/transactions";
import { displayMarketName } from "@/lib/market";

export interface GroupRow {
  date:     string;
  time:     string | null;
  seller:   string;
  market:   string;
  sourceId?: string | null;
  เบิก:     number;
  คืน:      number;
  คืนเสีย:  number;
  ยอดส่ง:   number;
  produceNetStatus?: "trusted" | "returns_exceed_withdrawal";
}

export interface SettlementEntry {
  settlement_date: string;
  settlement_time: string;
  staff_name:      string;
  market_name:     string;
  money_transfer:  number;
  money_cash:      number;
  expenses:        number;
  labor:           number;
}

interface CellState {
  money_transfer: number;
  money_cash:     number;
  expenses:       number;
  labor:          number;
}

type SaveState = "idle" | "saving" | "saved" | "error";

function gk(date: string, time: string | null, seller: string, market: string) {
  return `${date}||${time ?? ""}||${seller}||${market}`;
}

function fmtNum(n: number, dec = 2): string {
  return n.toLocaleString("th-TH", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function produceNetTrusted(group: GroupRow): boolean {
  return group.produceNetStatus !== "returns_exceed_withdrawal";
}

const NET_REVIEW_TEXT = "ต้องตรวจสอบ";

function fmtDate(d: string): string {
  return new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short", year: "2-digit" })
    .format(new Date(d + "T00:00:00"));
}

const TH = "px-3 py-2.5 text-left text-[0.6875rem] font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap";
const TD = "px-3 py-2.5 text-sm tabular-nums";

const INPUT_COMMON =
  "rounded-md border bg-transparent px-2 text-right text-sm tabular-nums " +
  "outline-none transition-colors hover:border-slate-300";

const INPUT_STATE: Record<SaveState, string> = {
  idle:   "border-slate-200 focus:border-[#06C755] focus:bg-white focus:ring-1 focus:ring-[#06C755]/20",
  saving: "border-amber-300 focus:border-amber-400 focus:ring-1 focus:ring-amber-200/30",
  saved:  "border-emerald-300 focus:border-emerald-400 focus:bg-white focus:ring-1 focus:ring-emerald-200/30",
  error:  "border-red-300 focus:border-red-400 focus:bg-white focus:ring-1 focus:ring-red-200/30",
};

function desktopInputCls(state: SaveState): string {
  return `${INPUT_COMMON} w-24 h-7 ${INPUT_STATE[state]}`;
}
function mobileInputCls(state: SaveState): string {
  return `${INPUT_COMMON} w-full h-9 ${INPUT_STATE[state]}`;
}

function SaveIcon({ state }: { state: SaveState }) {
  const wrap = "w-4 shrink-0 inline-flex items-center justify-center";
  if (state === "idle") return <span className={wrap} aria-hidden="true" />;
  if (state === "saving") return (
    <span className={wrap} aria-label="กำลังบันทึก">
      <svg className="size-3.5 animate-spin text-amber-500" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
    </span>
  );
  if (state === "saved") return (
    <span className={wrap} aria-label="บันทึกแล้ว">
      <svg className="size-3.5 text-emerald-500" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
      </svg>
    </span>
  );
  return (
    <span className={wrap} aria-label="บันทึกไม่สำเร็จ" title="บันทึกไม่สำเร็จ">
      <svg className="size-3.5 text-red-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9.303 3.376c.866 1.5-.217 3.374-1.948 3.374H4.645c-1.73 0-2.813-1.874-1.948-3.374l7.303-12.748c.866-1.5 3.032-1.5 3.898 0l7.303 12.748ZM12 15.75h.007v.008H12v-.008Z" />
      </svg>
    </span>
  );
}

function DiffCell({ value }: { value: number }) {
  if (value === 0) return <td className={`${TD} text-right text-slate-400`}>0</td>;
  if (value > 0)   return <td className={`${TD} text-right font-semibold text-emerald-700`}>+{fmtNum(value)}</td>;
  return <td className={`${TD} text-right font-semibold text-red-600`}>{fmtNum(value)}</td>;
}

export function FinancialTable({
  groups,
  initialSettlements,
}: {
  groups:              GroupRow[];
  initialSettlements:  SettlementEntry[];
}) {
  const [cells, setCells] = useState<Map<string, CellState>>(() => {
    const m = new Map<string, CellState>();
    for (const s of initialSettlements) {
      m.set(gk(s.settlement_date, s.settlement_time || null, s.staff_name, displayMarketName(s.market_name, "")), {
        money_transfer: s.money_transfer,
        money_cash:     s.money_cash,
        expenses:       s.expenses,
        labor:          s.labor,
      });
    }
    return m;
  });

  const [saveStates, setSaveStates] = useState<Map<string, SaveState>>(new Map());
  const savingKeys = useRef<Set<string>>(new Set());

  function getCell(key: string): CellState {
    return cells.get(key) ?? { money_transfer: 0, money_cash: 0, expenses: 0, labor: 0 };
  }

  function handleChange(key: string, field: keyof CellState, raw: string) {
    const value = parseFloat(raw) || 0;
    setCells(prev => {
      const cur = prev.get(key) ?? { money_transfer: 0, money_cash: 0, expenses: 0, labor: 0 };
      return new Map(prev).set(key, { ...cur, [field]: value });
    });
  }

  async function handleBlur(group: GroupRow, key: string) {
    if (savingKeys.current.has(key)) return;
    savingKeys.current.add(key);
    setSaveStates(prev => new Map(prev).set(key, "saving"));
    const cur = cells.get(key) ?? { money_transfer: 0, money_cash: 0, expenses: 0, labor: 0 };
    try {
      const res = await fetch("/api/settlement", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settlement_date: group.date,
          settlement_time: group.time ?? "",
          staff_name:      group.seller,
          market_name:     group.market,
          money_transfer:  cur.money_transfer,
          money_cash:      cur.money_cash,
          expenses:        cur.expenses,
          labor:           cur.labor,
          ...(group.sourceId ? { source_id: group.sourceId } : {}),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSaveStates(prev => new Map(prev).set(key, "saved"));
      setTimeout(() => {
        setSaveStates(prev => {
          const m = new Map(prev);
          if (m.get(key) === "saved") m.set(key, "idle");
          return m;
        });
      }, 2000);
    } catch (err) {
      console.error("settlement save failed", err);
      setSaveStates(prev => new Map(prev).set(key, "error"));
    } finally {
      savingKeys.current.delete(key);
    }
  }

  let grandเบิก = 0, grandคืน = 0, grandคืนเสีย = 0, grandยอดส่ง = 0,
      grandโอน = 0, grandสด = 0, grandExpenses = 0, grandLabor = 0;
  let untrustedNetCount = 0;
  for (const g of groups) {
    const c = getCell(gk(g.date, g.time, g.seller, g.market));
    grandเบิก    += g.เบิก;
    grandคืน     += g.คืน;
    grandคืนเสีย += g.คืนเสีย;
    if (produceNetTrusted(g)) grandยอดส่ง += g.ยอดส่ง;
    else untrustedNetCount += 1;
    grandโอน     += c.money_transfer;
    grandสด      += c.money_cash;
    grandExpenses += c.expenses;
    grandLabor += c.labor;
  }
  const grandSettlement = calculateSettlementTotals({
    ยอดส่ง: grandยอดส่ง,
    money_transfer: grandโอน,
    money_cash: grandสด,
    expenses: grandExpenses,
    labor: grandLabor,
  });
  const grandยอดขาย = grandSettlement.ยอดขาย;
  const grandขาดเกิน = untrustedNetCount === 0 ? grandSettlement.ขาดเกิน : null;

  return (
    <div className="space-y-4">
      {/* Grand totals bar */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        {[
          { label: "เบิกรวม",    value: grandเบิก,    cls: "text-emerald-700", bg: "bg-emerald-50" },
          { label: "คืนรวม",     value: grandคืน,     cls: "text-blue-700",   bg: "bg-blue-50" },
          { label: "คืนเสียรวม", value: grandคืนเสีย, cls: "text-red-600",    bg: "bg-red-50" },
          { label: "ยอดส่งรวม",  value: untrustedNetCount === 0 ? grandยอดส่ง : null,  cls: "text-slate-800",  bg: "bg-slate-50" },
          { label: "ยอดขายรวม",  value: grandยอดขาย,  cls: "text-slate-800",  bg: "bg-slate-50" },
        ].map(({ label, value, cls, bg }) => (
          <div key={label} className={`rounded-lg ${bg} px-3 py-2.5 text-center`}>
            <div className="text-[0.6875rem] font-medium text-slate-500 uppercase tracking-wide">{label}</div>
            <div className={`mt-1 text-xl font-bold tabular-nums leading-tight ${cls}`}>{value === null ? NET_REVIEW_TEXT : fmtNum(value)}</div>
          </div>
        ))}
      </div>

      {/* Mobile card list — visible only on small screens */}
      {groups.length === 0 ? (
        <div className="flex sm:hidden items-center justify-center py-10">
          <p className="text-sm text-slate-400">ไม่มีข้อมูลในเดือนนี้</p>
        </div>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white shadow-sm sm:hidden">
          {groups.map((g) => {
            const k = gk(g.date, g.time, g.seller, g.market);
            const c = getCell(k);
            const netTrusted = produceNetTrusted(g);
            const settlement = calculateSettlementTotals({
              ยอดส่ง: g.ยอดส่ง,
              money_transfer: c.money_transfer,
              money_cash: c.money_cash,
              expenses: c.expenses,
              labor: c.labor,
            });
            const saveState = saveStates.get(k) ?? "idle";

            return (
              <li key={k} className="px-4 py-3 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-800 truncate">{g.seller}</p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {fmtDate(g.date)}{g.time ? ` · ${g.time}` : ""} · {g.market}
                    </p>
                  </div>
                  {!netTrusted ? (
                    <span className="text-xs font-semibold text-amber-700 shrink-0">{NET_REVIEW_TEXT}</span>
                  ) : settlement.ขาดเกิน === 0 ? (
                    <span className="text-xs font-medium text-slate-400 tabular-nums shrink-0">±0</span>
                  ) : settlement.ขาดเกิน > 0 ? (
                    <span className="text-xs font-semibold text-emerald-700 tabular-nums shrink-0">
                      +{fmtNum(settlement.ขาดเกิน)}
                    </span>
                  ) : (
                    <span className="text-xs font-semibold text-red-600 tabular-nums shrink-0">
                      {fmtNum(settlement.ขาดเกิน)}
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-1.5">
                  <div className="rounded-md bg-slate-50 px-2.5 py-1.5">
                    <p className="text-[10px] text-slate-400 uppercase tracking-wide">ยอดส่ง</p>
                    <p className="text-sm font-semibold text-slate-700 tabular-nums">{netTrusted ? fmtNum(g.ยอดส่ง) : NET_REVIEW_TEXT}</p>
                  </div>
                  <div className="rounded-md bg-slate-50 px-2.5 py-1.5">
                    <p className="text-[10px] text-slate-400 uppercase tracking-wide">ยอดขาย</p>
                    <p className="text-sm font-semibold text-slate-700 tabular-nums">{fmtNum(settlement.ยอดขาย)}</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <span className="block text-[10px] text-slate-400 uppercase tracking-wide mb-1">เงินโอน</span>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={c.money_transfer || ""}
                      placeholder="0"
                      aria-label="เงินโอน"
                      className={mobileInputCls(saveState)}
                      onChange={e => handleChange(k, "money_transfer", e.target.value)}
                      onBlur={() => handleBlur(g, k)}
                    />
                  </div>
                  <div>
                    <span className="block text-[10px] text-slate-400 uppercase tracking-wide mb-1">เงินสด</span>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={c.money_cash || ""}
                      placeholder="0"
                      aria-label="เงินสด"
                      className={mobileInputCls(saveState)}
                      onChange={e => handleChange(k, "money_cash", e.target.value)}
                      onBlur={() => handleBlur(g, k)}
                    />
                  </div>
                  <div>
                    <span className="block text-[10px] text-slate-400 uppercase tracking-wide mb-1">ค่าใช้จ่าย</span>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={c.expenses || ""}
                      placeholder="0"
                      aria-label="ค่าใช้จ่าย"
                      className={mobileInputCls(saveState)}
                      onChange={e => handleChange(k, "expenses", e.target.value)}
                      onBlur={() => handleBlur(g, k)}
                    />
                  </div>
                  <div>
                    <span className="block text-[10px] text-slate-400 uppercase tracking-wide mb-1">ค่าแรง</span>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={c.labor || ""}
                      placeholder="0"
                      aria-label="ค่าแรง"
                      className={mobileInputCls(saveState)}
                      onChange={e => handleChange(k, "labor", e.target.value)}
                      onBlur={() => handleBlur(g, k)}
                    />
                  </div>
                  <div className="col-span-2 flex justify-end">
                    <SaveIcon state={saveState} />
                  </div>
                </div>

                {saveState === "error" && (
                  <p className="text-xs text-red-500">บันทึกไม่สำเร็จ กรุณาลองใหม่</p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Desktop table — hidden on small screens */}
      <div className="hidden sm:block overflow-x-auto rounded-xl border border-slate-200 shadow-sm">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              <th className={TH}>วันที่</th>
              <th className={TH}>เวลา</th>
              <th className={TH}>คนขาย</th>
              <th className={TH}>ตลาด</th>
              <th className={`${TH} text-right text-emerald-600`}>เบิก</th>
              <th className={`${TH} text-right text-blue-600`}>คืน</th>
              <th className={`${TH} text-right text-red-500`}>คืนเสีย</th>
              <th className={`${TH} text-right`}>ยอดส่ง</th>
              <th className={`${TH} text-right text-indigo-600`}>เงินโอน</th>
              <th className={`${TH} text-right text-amber-600`}>เงินสด</th>
              <th className={`${TH} text-right text-orange-600`}>ค่าใช้จ่าย</th>
              <th className={`${TH} text-right text-pink-600`}>ค่าแรง</th>
              <th className={`${TH} text-right`}>ยอดขาย</th>
              <th className={`${TH} text-right`}>ขาด/เกิน</th>
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 ? (
              <tr>
                <td colSpan={14} className="px-3 py-10 text-center text-sm text-slate-400">
                  ไม่มีข้อมูลในเดือนนี้
                </td>
              </tr>
            ) : (
              groups.map((g, i) => {
                const k       = gk(g.date, g.time, g.seller, g.market);
                const c       = getCell(k);
                const netTrusted = produceNetTrusted(g);
            const settlement = calculateSettlementTotals({
                  ยอดส่ง: g.ยอดส่ง,
                  money_transfer: c.money_transfer,
                  money_cash: c.money_cash,
                  expenses: c.expenses,
                  labor: c.labor,
                });
                const ยอดขาย  = settlement.ยอดขาย;
                const ขาดเกิน = settlement.ขาดเกิน;
                const saveState = saveStates.get(k) ?? "idle";

                return (
                  <tr
                    key={k}
                    className={`border-b border-slate-100 transition-colors hover:bg-[#06C755]/5 ${
                      i % 2 === 0 ? "bg-white" : "bg-slate-50/40"
                    }`}
                  >
                    <td className={`${TD} whitespace-nowrap font-medium text-slate-700`}>
                      {fmtDate(g.date)}
                    </td>
                    <td className={`${TD} whitespace-nowrap text-slate-500`}>
                      {g.time ?? <span className="text-slate-300">—</span>}
                    </td>
                    <td className={`${TD} whitespace-nowrap text-slate-700`}>{g.seller}</td>
                    <td className={`${TD} text-slate-600`}>{g.market}</td>
                    <td className={`${TD} text-right text-emerald-700`}>
                      {g.เบิก > 0 ? fmtNum(g.เบิก) : <span className="text-slate-300">—</span>}
                    </td>
                    <td className={`${TD} text-right text-blue-700`}>
                      {fmtNum(g.คืน)}
                    </td>
                    <td className={`${TD} text-right text-red-600`}>
                      {fmtNum(g.คืนเสีย)}
                    </td>
                    <td className={`${TD} text-right font-semibold text-slate-800`}>
                      {netTrusted ? fmtNum(g.ยอดส่ง) : NET_REVIEW_TEXT}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={c.money_transfer || ""}
                        placeholder="0"
                        aria-label="เงินโอน"
                        className={desktopInputCls(saveState)}
                        onChange={e => handleChange(k, "money_transfer", e.target.value)}
                        onBlur={() => handleBlur(g, k)}
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={c.money_cash || ""}
                        placeholder="0"
                        aria-label="เงินสด"
                        className={desktopInputCls(saveState)}
                        onChange={e => handleChange(k, "money_cash", e.target.value)}
                        onBlur={() => handleBlur(g, k)}
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={c.expenses || ""}
                        placeholder="0"
                        aria-label="ค่าใช้จ่าย"
                        className={desktopInputCls(saveState)}
                        onChange={e => handleChange(k, "expenses", e.target.value)}
                        onBlur={() => handleBlur(g, k)}
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="inline-flex items-center gap-1 justify-end">
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          value={c.labor || ""}
                          placeholder="0"
                          aria-label="ค่าแรง"
                          className={desktopInputCls(saveState)}
                          onChange={e => handleChange(k, "labor", e.target.value)}
                          onBlur={() => handleBlur(g, k)}
                        />
                        <SaveIcon state={saveState} />
                      </div>
                    </td>
                    <td className={`${TD} text-right font-semibold text-slate-800`}>
                      {fmtNum(ยอดขาย)}
                    </td>
                    {netTrusted
                      ? <DiffCell value={ขาดเกิน} />
                      : <td className={`${TD} text-right font-semibold text-amber-700`}>{NET_REVIEW_TEXT}</td>}

                  </tr>
                );
              })
            )}
          </tbody>
          {groups.length > 0 && (
            <tfoot className="border-t-2 border-slate-200 bg-slate-50">
              <tr>
                <td colSpan={4} className={`${TD} font-bold text-slate-700`}>
                  รวม {groups.length} กลุ่ม
                </td>
                <td className={`${TD} text-right font-bold text-emerald-800`}>{fmtNum(grandเบิก)}</td>
                <td className={`${TD} text-right font-bold text-blue-800`}>{fmtNum(grandคืน)}</td>
                <td className={`${TD} text-right font-bold text-red-700`}>{fmtNum(grandคืนเสีย)}</td>
                <td className={`${TD} text-right font-bold text-slate-800`}>{untrustedNetCount === 0 ? fmtNum(grandยอดส่ง) : NET_REVIEW_TEXT}</td>
                <td className={`${TD} text-right font-bold text-indigo-800`}>{fmtNum(grandโอน)}</td>
                <td className={`${TD} text-right font-bold text-amber-700`}>{fmtNum(grandสด)}</td>
                <td className={`${TD} text-right font-bold text-orange-700`}>{fmtNum(grandExpenses)}</td>
                <td className={`${TD} text-right font-bold text-pink-700`}>{fmtNum(grandLabor)}</td>
                <td className={`${TD} text-right font-bold text-slate-800`}>{fmtNum(grandยอดขาย)}</td>
                {grandขาดเกิน === null
                  ? <td className={`${TD} text-right font-bold text-amber-700`}>{NET_REVIEW_TEXT}</td>
                  : <DiffCell value={grandขาดเกิน} />}

              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <p className="text-xs text-slate-400 leading-relaxed">
        * ยอดส่ง = เบิก − คืน − คืนเสีย &nbsp;·&nbsp; ยอดขาย = เงินโอน + เงินสด + ค่าใช้จ่าย + ค่าแรง &nbsp;·&nbsp;
        ขาด/เกิน = ยอดขาย − ยอดส่ง &nbsp;·&nbsp; กรอกเงินโอน/เงินสด/ค่าใช้จ่าย/ค่าแรง แล้วคลิกออกเพื่อบันทึก
      </p>
    </div>
  );
}
