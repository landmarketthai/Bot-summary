import { RE } from "./regex";
import type { BaseTransactionType, TransactionType } from "./types";
import { boundedEditDistance } from "./units";

const MAIN_CLOSER_TYPES: ReadonlyArray<{
  closer: string;
  types: readonly BaseTransactionType[];
}> = [
  { closer: "จบรายการเบิก", types: ["เบิก"] },
  { closer: "จบรายการชั่งเบิก", types: ["เบิก"] },
  { closer: "จบรายการชั่งคืน", types: ["คืน"] },
  { closer: "จบรายการคืน", types: ["คืน"] },
  { closer: "จบรายการคืนเสีย", types: ["คืนเสีย"] },
  { closer: "จบรายการชั่งคืนและคืนเสีย", types: ["คืน"] },
];

const GENERIC_MAIN_CLOSER = /^จบรายการ(?:\s+(\d+)\s*รายการ)?\s*$/;

/** Only repair the command prefix; the transaction suffix must match exactly. */
export function normalizeProduceCloser(rawLine: string): string {
  const line = rawLine.trim();
  if (!line.startsWith("จบ")) return rawLine;
  for (const { closer } of MAIN_CLOSER_TYPES) {
    const suffix = closer.slice("จบรายการ".length);
    if (!line.endsWith(suffix)) continue;
    const prefix = line.slice(0, -suffix.length);
    if (boundedEditDistance(prefix, "จบรายการ", 1) !== null) return closer;
  }
  return rawLine;
}

export function unclearProduceCloser(text: string): boolean {
  return text.split("\n").some((line) => /^จบ\S*(?:รายการ|รายกา|ชั่ง|เบิก|คืน)/.test(line.trim())
    && !RE.SESSION_END.test(normalizeProduceCloser(line)));
}

export const MAIN_SESSION_LABEL: Record<BaseTransactionType, string> = {
  "เบิก": "รายการเบิก",
  "คืน": "รายการชั่งคืน",
  "คืนเสีย": "รายการคืนเสีย",
};

export const MAIN_SESSION_EXPECTED_CLOSER: Record<BaseTransactionType, string> = {
  "เบิก": "จบรายการเบิก",
  "คืน": "จบรายการชั่งคืน",
  "คืนเสีย": "จบรายการคืนเสีย",
};

export function baseMainTransactionType(type: TransactionType): BaseTransactionType {
  return type === "เบิกเพิ่ม" ? "เบิก" : type;
}

export interface MainCloserCompatibility {
  compatible: boolean;
  expectedCloser: string;
}

/** Generic recognition stays separate; this answers whether a recognized close may close this type. */
export function mainCloserCompatibility(
  activeType: BaseTransactionType,
  rawLine: string,
): MainCloserCompatibility | null {
  const prefix = rawLine.trim().match(RE.TIME_PREFIX);
  const line = normalizeProduceCloser((prefix?.[3] ?? rawLine).trim());
  if (!RE.SESSION_END.test(line)) return null;

  const expectedCloser = MAIN_SESSION_EXPECTED_CLOSER[activeType];
  if (GENERIC_MAIN_CLOSER.test(line)) return { compatible: true, expectedCloser };

  const definition = MAIN_CLOSER_TYPES.find(({ closer }) => closer === line);
  return {
    compatible: definition?.types.includes(activeType) ?? false,
    expectedCloser,
  };
}

/** Reads the main type declared by the document's opening header. */
export function mainSessionTypeFromText(text: string): BaseTransactionType | null {
  for (const rawLine of text.split("\n")) {
    const prefix = rawLine.trim().match(RE.TIME_PREFIX);
    const line = (prefix?.[3] ?? rawLine).trim();
    if (RE.ADDITIONAL_HEADER.test(line)) return null;
    if (!line || RE.SESSION_END.test(line)) continue;

    const sellerMarket = line.match(RE.SELLER_MARKET);
    const header = sellerMarket?.[3] ?? (RE.SESSION_START.test(line) ? line : null);
    if (!header) continue;

    if (RE.TX_TYPE_KUEN_SIA.test(header)) return "คืนเสีย";
    if (RE.TX_TYPE_KUEN.test(header)) return "คืน";
    if (RE.TX_TYPE_BEIK.test(header)) return "เบิก";
  }
  return null;
}

export function mainCloserRefusal(
  sessionText: string,
  closeText: string,
): { activeType: BaseTransactionType; message: string } | null {
  const activeType = mainSessionTypeFromText(sessionText);
  if (!activeType) return null;

  for (const line of closeText.split("\n")) {
    const compatibility = mainCloserCompatibility(activeType, line);
    if (compatibility && !compatibility.compatible) {
      return {
        activeType,
        message:
          `⚠️ ตอนนี้กำลังบันทึก${MAIN_SESSION_LABEL[activeType]}\n` +
          `กรุณาปิดด้วย “${compatibility.expectedCloser}”`,
      };
    }
  }
  return null;
}
