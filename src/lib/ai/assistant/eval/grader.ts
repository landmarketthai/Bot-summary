/**
 * Answer-level grading for the @Botsummary evaluation.
 *
 * Text is compared after NFC, Thai→Arabic digits, removing thousands
 * separators between digits and removing all whitespace (Thai spacing is
 * not consistent). Matching is deliberately strict substring matching: a
 * paraphrase that drops an authoritative figure fails.
 */
import type { AnswerEvalCase } from "./answer-eval-set";

export type EvalErrorCategory =
  | "provider_error"
  | "timeout"
  | "refused_unexpectedly"
  | "answered_unexpectedly"
  | "missing_fact"
  | "forbidden_content"
  | "hallucinated_figure"
  | "not_run_budget";

export interface EvalError {
  category: EvalErrorCategory;
  detail: string;
}

export function normalizeForGrading(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[๐-๙]/gu, (digit) => String("๐๑๒๓๔๕๖๗๘๙".indexOf(digit)))
    .replace(/(?<=\d),(?=\d{3})/gu, "")
    .replace(/\s+/gu, "")
    .toLowerCase();
}

/** Amounts written as "<number> บาท", in satang (absolute). */
export function moneyMentionsSatang(text: string): number[] {
  const normalized = text.normalize("NFC").replace(/[๐-๙]/gu, (digit) => String("๐๑๒๓๔๕๖๗๘๙".indexOf(digit)));
  return [...normalized.matchAll(/(-?\d[\d,]*(?:\.\d+)?)\s*บาท/gu)]
    .map((match) => Math.abs(Math.round(Number(match[1]!.replace(/,/g, "")) * 100)))
    .filter(Number.isFinite);
}

export function gradeAnswer(
  testCase: AnswerEvalCase,
  answer: { text: string; kind: "answer" | "notice" },
  authoritativeMoneySatang: ReadonlySet<number>,
): EvalError[] {
  const errors: EvalError[] = [];
  const text = normalizeForGrading(answer.text);
  const { expect } = testCase;

  if (expect.kind && expect.kind !== answer.kind) {
    errors.push({
      category: expect.kind === "answer" ? "refused_unexpectedly" : "answered_unexpectedly",
      detail: `expected ${expect.kind}, got ${answer.kind}`,
    });
  }
  for (const fact of expect.mustInclude ?? []) {
    if (!text.includes(normalizeForGrading(fact))) errors.push({ category: "missing_fact", detail: fact });
  }
  for (const group of expect.mustIncludeAny ?? []) {
    if (!group.some((fact) => text.includes(normalizeForGrading(fact)))) {
      errors.push({ category: "missing_fact", detail: `one of: ${group.join(" | ")}` });
    }
  }
  for (const fact of expect.mustNotInclude ?? []) {
    if (text.includes(normalizeForGrading(fact))) errors.push({ category: "forbidden_content", detail: fact });
  }
  for (const satang of moneyMentionsSatang(answer.text)) {
    if (!authoritativeMoneySatang.has(satang)) {
      errors.push({ category: "hallucinated_figure", detail: `${(satang / 100).toFixed(2)} บาท is not an authoritative value` });
    }
  }
  return errors;
}
