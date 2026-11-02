import { canonicalMarketLabel, REVIEWED_MARKET_ALIASES, REVIEWED_MARKET_LABELS } from "@/lib/market";
import { normalizeStaffName } from "@/lib/ai/readonly-tools";
import type { ConversationTurn } from "./job-store";

const STAFF_REFERENCE = /(^|[\s,;]|แล้ว|และ|ส่วน|ของ|พี่|คุณ|น้อง)(?:เขา|เค้า|คน(?:นั้น|นี้|เดิม))(?=เบิก|คืน|มี|ส่ง|ขาย|ปิด|เงิน|ล่ะ|หละ|\s|[?？]|$)/gu;
const MARKET_REFERENCE = /()ตลาด(?:นั้น|นี้|เดิม)/gu;
const STAFF_NAME = /(?:^|[\s,;]|แล้ว|และ|ส่วน|ของ)(?:วันนี้|เมื่อวาน)?\s*(?:พี่|น้อง|คุณ|เจ๊|ป้า|ลุง|น้า)?\s*([ก-๙]{1,20}?)(?=เบิก|คืน|มีสลิป|ส่งสลิป|เงินขาด|เงินเกิน|ปิดเงิน|วันนี้|เมื่อวาน)/gu;
const NON_NAMES = new Set(["เขา", "เค้า", "คนนั้น", "คนนี้", "คนเดิม", "ใคร", "ทุกคน", "ทุกตลาด", "วันนี้", "เมื่อวาน"]);

export const AMBIGUOUS_STAFF_REPLY = "หมายถึงคนขายคนไหนครับ กรุณาระบุชื่อคนขาย";
export const AMBIGUOUS_MARKET_REPLY = "หมายถึงตลาดไหนครับ กรุณาระบุชื่อตลาด";

function unique(values: string[]): string | null {
  const subjects = [...new Set(values)];
  return subjects.length === 1 ? subjects[0]! : null;
}

function currentSubjects(question: string, kind: "staff" | "market"): string[] {
  if (kind === "staff") {
    return [...question.matchAll(STAFF_NAME)].flatMap(match => match[1]!.replace(/^(?:แล้ว|และ|ส่วน|ของ)/u, "").split(/กับ|และ|หรือ/u))
      .map(normalizeStaffName)
      .filter(name => !NON_NAMES.has(name));
  }
  // Longest spelling wins at a given position (พาซิโอ้ผัก is not พาซิโอ้).
  const spellings = [...REVIEWED_MARKET_LABELS, ...Object.keys(REVIEWED_MARKET_ALIASES)].sort((a, b) => b.length - a.length);
  let remaining = question;
  const subjects: string[] = [];
  for (const spelling of spellings) {
    if (!remaining.includes(spelling)) continue;
    subjects.push(canonicalMarketLabel(spelling));
    remaining = remaining.replaceAll(spelling, " ");
  }
  return subjects;
}

function previousSubjects(turn: ConversationTurn | undefined, kind: "staff" | "market"): string[] {
  const tools = turn?.context.tools;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap(tool => {
    if (!tool || typeof tool !== "object") return [];
    const args = (tool as { arguments?: Record<string, unknown> }).arguments;
    const value = args?.[kind];
    if (typeof value !== "string" || !value.trim()) return [];
    const subject = kind === "staff" ? normalizeStaffName(value) : canonicalMarketLabel(value);
    return NON_NAMES.has(subject) || /^(?:ตลาด)?(?:นั้น|นี้|เดิม)$/u.test(subject) ? [] : [subject];
  });
}

/** Resolve references only from explicit subjects or the latest scope-filtered turn, never answer prose. */
export function resolveAmbiguousSubject(
  question: string,
  turns: readonly ConversationTurn[],
): { question: string; clarification?: string } {
  let resolved = question.normalize("NFC");
  for (const [kind, reference, clarification] of [
    ["staff", STAFF_REFERENCE, AMBIGUOUS_STAFF_REPLY],
    ["market", MARKET_REFERENCE, AMBIGUOUS_MARKET_REPLY],
  ] as const) {
    if (!resolved.match(reference)) continue;
    const explicit = currentSubjects(resolved, kind);
    const subject = unique(explicit.length ? explicit : previousSubjects(turns.at(-1), kind));
    if (!subject) return { question, clarification };
    resolved = resolved.replace(reference, (_match, prefix: string) => prefix + subject);
  }
  return { question: resolved };
}
