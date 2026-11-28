export const MAX_REVIEW_AI_CANDIDATES = 20;

export type ReviewAiCandidate = Readonly<{
  id: string;
  features: Readonly<{
    similarity: "none" | "weak" | "strong";
    sameCategory: boolean;
  }>;
}>;

export type ReviewAiCandidateInput = Readonly<{
  synthetic: true;
  allowedCandidateIds: readonly string[];
  candidates: readonly ReviewAiCandidate[];
}>;

export type ReviewAiCandidateOptions = Readonly<{
  enabled?: boolean;
  environment?: "synthetic" | "real";
  provider?: (input: ReviewAiCandidateInput) => unknown | Promise<unknown>;
  timeoutMs?: number;
}>;

export type ReviewAiCandidateResult = Readonly<{
  candidateId: string | null;
  needsHumanReview: true;
  source: "none" | "fallback" | "provider";
  reason: "invalid_input" | "invalid_options" | "prohibited_environment" |
    "disabled" | "no_provider" | "provider_error" | "invalid_result" | "selected";
}>;

// The caller owns catalog provenance and synthetic-data generation. IDs are opaque
// synthetic handles, never catalog names or a place to encode source records.
const ID = /^c_[a-f0-9]{32}$/;

function record(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) =>
    typeof key === "string" && (required.includes(key) || optional.includes(key)) &&
    "value" in Object.getOwnPropertyDescriptor(value, key)!
  );
}

function boundedList(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_REVIEW_AI_CANDIDATES) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) return false;
  }
  return true;
}

function parseInput(value: unknown): ReviewAiCandidateInput | null {
  if (!record(value, ["synthetic", "allowedCandidateIds", "candidates"]) || value.synthetic !== true) return null;
  const { allowedCandidateIds, candidates } = value;
  if (!boundedList(allowedCandidateIds) || !boundedList(candidates)) return null;
  const allowed = new Set<string>();
  for (const id of allowedCandidateIds) {
    if (typeof id !== "string" || !ID.test(id) || allowed.has(id)) return null;
    allowed.add(id);
  }
  const seen = new Set<string>();
  const snapshot: ReviewAiCandidate[] = [];
  for (const candidate of candidates) {
    if (!record(candidate, ["id", "features"]) || typeof candidate.id !== "string" ||
      !allowed.has(candidate.id) || seen.has(candidate.id) ||
      !record(candidate.features, ["similarity", "sameCategory"])) return null;
    const { similarity, sameCategory } = candidate.features;
    if ((similarity !== "none" && similarity !== "weak" && similarity !== "strong") || typeof sameCategory !== "boolean") return null;
    seen.add(candidate.id);
    snapshot.push(Object.freeze({ id: candidate.id, features: Object.freeze({ similarity, sameCategory }) }));
  }
  return Object.freeze({ synthetic: true, allowedCandidateIds: Object.freeze([...allowed]), candidates: Object.freeze(snapshot) });
}

function parseOptions(value: unknown): ReviewAiCandidateOptions | null {
  if (!record(value, [], ["enabled", "environment", "provider", "timeoutMs"])) return null;
  if (("enabled" in value && typeof value.enabled !== "boolean") ||
    ("environment" in value && value.environment !== "synthetic" && value.environment !== "real") ||
    ("provider" in value && typeof value.provider !== "function") ||
    ("timeoutMs" in value && (typeof value.timeoutMs !== "number" || !Number.isInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 1000))) return null;
  return { ...value } as ReviewAiCandidateOptions;
}

function result(candidateId: string | null, source: ReviewAiCandidateResult["source"], reason: ReviewAiCandidateResult["reason"]): ReviewAiCandidateResult {
  return Object.freeze({ candidateId, needsHumanReview: true, source, reason });
}

/** Candidate advice only: no I/O, environment reads, approvals, or state writes.
 * The optional injected provider is trusted executable code and must be synthetic-only.
 */
export async function selectReviewAiCandidate(input: unknown, options: unknown = {}): Promise<ReviewAiCandidateResult> {
  let parsed: ReviewAiCandidateInput | null;
  let config: ReviewAiCandidateOptions | null;
  try { parsed = parseInput(input); } catch { parsed = null; }
  if (!parsed) return result(null, "none", "invalid_input");
  try { config = parseOptions(options); } catch { config = null; }
  if (!config) return result(null, "none", "invalid_options");
  if (config.environment === "real" || (config.enabled === true && config.environment !== "synthetic")) {
    return result(null, "none", "prohibited_environment");
  }

  const score = (candidate: ReviewAiCandidate) =>
    ({ none: 0, weak: 2, strong: 4 }[candidate.features.similarity]) + Number(candidate.features.sameCategory);
  const ranked = [...parsed.candidates].sort((a, b) => score(b) - score(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const fallback = (reason: ReviewAiCandidateResult["reason"]) => result(ranked[0]?.id ?? null, "fallback", reason);
  if (config.enabled !== true) return fallback("disabled");
  if (!config.provider || ranked.length === 0) return fallback("no_provider");

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const provider = config.provider;
    const response = await Promise.race([
      Promise.resolve().then(() => provider(parsed)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), config.timeoutMs ?? 250); }),
    ]);
    if (!record(response, ["candidateId"]) ||
      (response.candidateId !== null && (typeof response.candidateId !== "string" || !parsed.candidates.some((candidate) => candidate.id === response.candidateId)))) {
      return fallback("invalid_result");
    }
    return result(response.candidateId as string | null, "provider", "selected");
  } catch {
    return fallback("provider_error");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
