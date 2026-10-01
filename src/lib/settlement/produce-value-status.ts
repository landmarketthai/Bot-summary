import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { canonicalMarketLabel, displayMarketName } from "@/lib/market";
import { runDailyClosePreflight } from "@/lib/produce/preflight-service";
import type {
  DailyClosePreflightResult,
  PreflightIssue,
  PreflightRound,
} from "@/lib/produce/daily-close-preflight";
import type { ProduceBucketPresence } from "@/lib/summary/transactions";

export type SettlementProduceValueStatus =
  | "complete"
  | "partial"
  | "blocked"
  | "invalid"
  | "missing";

export type ProduceComponentAvailability = "known" | "unknown";

export interface ProduceComponentProvenance {
  withdrawal: ProduceComponentAvailability;
  goodReturn: ProduceComponentAvailability;
  damagedReturn: ProduceComponentAvailability;
  net: ProduceComponentAvailability;
}

const ALL_KNOWN: ProduceComponentProvenance = {
  withdrawal: "known",
  goodReturn: "known",
  damagedReturn: "known",
  net: "known",
};

const ALL_UNKNOWN: ProduceComponentProvenance = {
  withdrawal: "unknown",
  goodReturn: "unknown",
  damagedReturn: "unknown",
  net: "unknown",
};

/**
 * Component-level availability. COMPLETE certifies missing buckets as known
 * zero. PARTIAL/BLOCKED only treat a bucket as known when effective rows exist.
 * Never infer known-ness from a numeric 0.
 */
export function produceComponentProvenance(
  status: SettlementProduceValueStatus,
  presence: ProduceBucketPresence,
): ProduceComponentProvenance {
  if (status === "complete") return ALL_KNOWN;
  if (status === "missing") return ALL_UNKNOWN;
  if (status === "invalid") {
    return {
      withdrawal: presence.เบิก ? "known" : "unknown",
      goodReturn: presence.คืน ? "known" : "unknown",
      damagedReturn: presence.คืนเสีย ? "known" : "unknown",
      net: "unknown",
    };
  }
  const withdrawal = presence.เบิก ? "known" : "unknown";
  const goodReturn = presence.คืน ? "known" : "unknown";
  const damagedReturn = presence.คืนเสีย ? "known" : "unknown";
  const net =
    withdrawal === "known" && goodReturn === "known" && damagedReturn === "known"
      ? "known"
      : "unknown";
  return { withdrawal, goodReturn, damagedReturn, net };
}

export interface SettlementProduceIdentity {
  accountabilityRoundId?: string | null;
  staffName: string;
  marketName: string;
}

function sameText(left: string | null, right: string): boolean {
  return (left ?? "").normalize("NFC").trim() === right.normalize("NFC").trim();
}

function matchingRound(
  preflight: DailyClosePreflightResult,
  identity: SettlementProduceIdentity,
): PreflightRound | null {
  if (identity.accountabilityRoundId) {
    return preflight.rounds.find(
      (round) => round.accountabilityRoundId === identity.accountabilityRoundId,
    ) ?? null;
  }

  const market = displayMarketName(identity.marketName, "");
  const matches = preflight.rounds.filter((round) =>
    sameText(round.staffName, identity.staffName)
    && displayMarketName(round.marketName ?? "", "") === market,
  );
  return matches.length === 1 ? matches[0]! : null;
}

function integrityIssueAffectsRound(
  issue: PreflightIssue,
  round: PreflightRound,
  identity: SettlementProduceIdentity,
): boolean {
  if (issue.severity !== "blocker") return false;
  // Central-price conflicts are already scoped through round.status=partial.
  // The day-level issue deliberately lacks identity and must not poison a round
  // that does not sell the disputed product.
  if (issue.code === "unresolved_central_price") return false;
  if (issue.accountabilityRoundId) {
    return issue.accountabilityRoundId === round.accountabilityRoundId;
  }
  if (issue.marketName) {
    if (displayMarketName(issue.marketName, "") !== displayMarketName(identity.marketName, "")) {
      return false;
    }
    return !issue.staffName || sameText(issue.staffName, identity.staffName);
  }
  if (issue.staffName) return sameText(issue.staffName, identity.staffName);
  // No parsed identity, but the evidence's own LINE source is a column the
  // preflight already resolved to the markets that group ran today. A refused
  // document from group A cannot belong to a market group A never worked, so
  // it must not block one. An unrecognisable market on this side is not proof
  // of exclusion and falls through to the day-wide rule below.
  const market = canonicalMarketLabel(identity.marketName);
  if (issue.sourceMarketScope && issue.sourceMarketScope.length > 0 && market) {
    return issue.sourceMarketScope.includes(market);
  }
  // Truly unattributed active failures can belong to any round and therefore
  // retain the preflight's intentional day-wide fail-closed behavior.
  return true;
}

/** Map the trusted Produce preflight verdict; never infer completeness from money. */
export function settlementProduceValueStatus(
  preflight: DailyClosePreflightResult,
  identity: SettlementProduceIdentity,
  effectiveRowCount: number,
): SettlementProduceValueStatus {
  if (effectiveRowCount === 0) return "missing";
  const round = matchingRound(preflight, identity);
  if (!round) return "blocked";
  if (preflight.integrityIssues.some((issue) =>
    integrityIssueAffectsRound(issue, round, identity))) {
    return "blocked";
  }
  if (round.status === "ready") return "complete";
  return round.status === "partial" ? "partial" : "blocked";
}

export async function loadSettlementProduceValueStatus(
  supabase: SupabaseClient<Database>,
  businessDate: string,
  identity: SettlementProduceIdentity,
  effectiveRowCount: number,
): Promise<SettlementProduceValueStatus> {
  const preflight = await runDailyClosePreflight(supabase, businessDate);
  return settlementProduceValueStatus(preflight, identity, effectiveRowCount);
}
