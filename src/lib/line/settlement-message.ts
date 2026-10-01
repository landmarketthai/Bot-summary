import { formatThaiDate } from "@/lib/date";
import { displayMarketName } from "@/lib/market";
import type {
  ProduceBucketPresence,
  SettlementTotals,
  TransactionTotals,
} from "@/lib/summary/transactions";
import type { ReconciliationResult } from "@/lib/reconciliation";
import {
  produceComponentProvenance,
  type ProduceComponentAvailability,
  type SettlementProduceValueStatus,
} from "@/lib/settlement/produce-value-status";

function fmt(n: number): string {
  return n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const UNKNOWN_PRODUCE = "⚠️ ยังยืนยันไม่ได้";
const UNCONFIRMED_MARK = " ⚠️ ยังไม่ยืนยัน";
const UNCONFIRMED_FOOTER = "⚠️ ยอดจากรายการเบิก/คืนยังมีข้อมูลที่ต้องตรวจสอบ";
const INVALID_NET_FOOTER = "⚠️ ยอดคืนรวมมากกว่ายอดเบิก — อาจมีรายการเบิกตกหล่น ต้องตรวจสอบก่อนสรุปการเงิน";
const UNKNOWN_FINANCIAL = "⚠️ ยังยืนยันไม่ได้";

export interface SettlementLineMessageInput {
  date: string;
  staffName: string;
  marketName: string;
  transactions: TransactionTotals;
  produceValueStatus: SettlementProduceValueStatus;
  producePresence: ProduceBucketPresence;
  settlement: SettlementTotals;
  notes?: string;
}

export function buildSettlementLineMessage(input: SettlementLineMessageInput): string {
  const market = displayMarketName(input.marketName, "");
  const title = market ? `${input.staffName} — ${market}` : input.staffName;
  const diff = input.settlement.ขาดเกิน;
  const diffLine = input.produceValueStatus === "invalid"
    ? `ผลตรวจ: ${UNKNOWN_FINANCIAL}`
    :
    diff === 0
      ? "ผลตรวจ: ยอดตรงกัน"
      : diff > 0
        ? `ผลตรวจ: เกิน ${fmt(diff)} บาท`
        : `ผลตรวจ: ขาด ${fmt(Math.abs(diff))} บาท`;

  const lines = [
    "รายการส่งเงิน ✅",
    "",
    `${title} — ${formatThaiDate(input.date)}`,
    "",
    ...buildProduceValueLines(
      input.transactions,
      input.produceValueStatus,
      input.producePresence,
    ),
    ...unconfirmedProduceFooter(input.produceValueStatus),
    `เงินโอน: ${fmt(input.settlement.ยอดโอน)} บาท`,
    `เงินสด: ${fmt(input.settlement.เงินสด)} บาท`,
    `ค่าใช้จ่าย: ${fmt(input.settlement.ค่าใช้จ่าย)} บาท`,
    `ค่าแรง: ${fmt(input.settlement.ค่าแรง)} บาท`,
    `ยอดขายจากรายการส่งเงิน: ${fmt(input.settlement.ยอดขาย)} บาท`,
    diffLine,
    input.produceValueStatus === "invalid"
      ? `เงินสดที่ควรเหลือส่งเจ๊: ${UNKNOWN_FINANCIAL}`
      : `เงินสดที่ควรเหลือส่งเจ๊: ${fmt(input.settlement.เงินสดต้องส่งเจ๊)} บาท`,
  ];

  if (input.notes?.trim()) {
    lines.push("", `หมายเหตุ: ${input.notes.trim()}`);
  }

  return lines.join("\n");
}

export interface FinalSettlementMessageInput {
  date:           string;
  staffName:      string;
  marketName:     string;
  transactions:   TransactionTotals;
  produceValueStatus: SettlementProduceValueStatus;
  producePresence: ProduceBucketPresence;
  settlement:     SettlementTotals;
  reconciliation: ReconciliationResult;
  notes?:         string;
}

export function buildFinalSettlementMessage(input: FinalSettlementMessageInput): string {
  const market = displayMarketName(input.marketName, "");
  const title  = market ? `${input.staffName} — ${market}` : input.staffName;
  const s      = input.settlement;
  const r      = input.reconciliation;

  const salesDiffLine = input.produceValueStatus === "invalid"
    ? `ผลตรวจ: ${UNKNOWN_FINANCIAL}`
    :
    s.ขาดเกิน === 0
      ? "ผลตรวจ: ยอดตรงกัน"
      : s.ขาดเกิน > 0
        ? `ผลตรวจ: เกิน ${fmt(s.ขาดเกิน)} บาท`
        : `ผลตรวจ: ขาด ${fmt(Math.abs(s.ขาดเกิน))} บาท`;

  const slipDiffLine =
    r.difference === 0
      ? "ผลตรวจสลิป: ตรงกัน"
      : r.difference > 0
        ? `ผลตรวจสลิป: เกิน ${fmt(r.difference)} บาท`
        : `ผลตรวจสลิป: ขาด ${fmt(Math.abs(r.difference))} บาท`;

  const lines = [
    "รายการส่งเงิน ✅ (ยืนยันแล้ว)",
    "",
    `${title} — ${formatThaiDate(input.date)}`,
    "",
    ...buildProduceValueLines(
      input.transactions,
      input.produceValueStatus,
      input.producePresence,
    ),
    ...unconfirmedProduceFooter(input.produceValueStatus),
    `เงินโอน: ${fmt(s.ยอดโอน)} บาท`,
    `เงินสด: ${fmt(s.เงินสด)} บาท`,
    `ค่าใช้จ่าย: ${fmt(s.ค่าใช้จ่าย)} บาท`,
    `ค่าแรง: ${fmt(s.ค่าแรง)} บาท`,
    `ยอดขายจากรายการส่งเงิน: ${fmt(s.ยอดขาย)} บาท`,
    salesDiffLine,
    input.produceValueStatus === "invalid"
      ? `เงินสดที่ควรเหลือส่งเจ๊: ${UNKNOWN_FINANCIAL}`
      : `เงินสดที่ควรเหลือส่งเจ๊: ${fmt(s.เงินสดต้องส่งเจ๊)} บาท`,
    "",
    "— ตรวจสลิปโอน —",
    `ยอดสลิป AI: ${fmt(r.ai_verified_total)} บาท`,
    `ยอดสลิปมือ: ${fmt(r.manual_slip_total)} บาท`,
    `ยอดสลิปรวม: ${fmt(r.checked_slip_total)} บาท`,
    `ยอดโอนที่แจ้ง: ${fmt(r.submitted_transfer_total)} บาท`,
    slipDiffLine,
  ];

  if (input.notes?.trim()) {
    lines.push("", `หมายเหตุ: ${input.notes.trim()}`);
  }

  return lines.join("\n");
}

function formatProduceComponent(
  label: string,
  amount: number,
  availability: ProduceComponentAvailability,
  unconfirmed: boolean,
): string {
  if (availability === "unknown") return `${label}: ${UNKNOWN_PRODUCE}`;
  return `${label}: ${fmt(amount)} บาท${unconfirmed ? UNCONFIRMED_MARK : ""}`;
}

function buildProduceValueLines(
  transactions: TransactionTotals,
  status: SettlementProduceValueStatus,
  presence: ProduceBucketPresence,
): string[] {
  const provenance = produceComponentProvenance(status, presence);
  const unconfirmed = status !== "complete";
  return [
    formatProduceComponent("ยอดเบิก", transactions.เบิก, provenance.withdrawal, unconfirmed),
    formatProduceComponent("ยอดชั่งคืน", transactions.คืน, provenance.goodReturn, unconfirmed),
    formatProduceComponent("ยอดคืนเสีย", transactions.คืนเสีย, provenance.damagedReturn, unconfirmed),
    "",
    formatProduceComponent(
      "ยอดขายสุทธิที่คำนวณได้",
      transactions.ยอดส่ง,
      provenance.net,
      unconfirmed,
    ),
  ];
}

function unconfirmedProduceFooter(status: SettlementProduceValueStatus): string[] {
  if (status === "complete") return [];
  return ["", status === "invalid" ? INVALID_NET_FOOTER : UNCONFIRMED_FOOTER];
}
