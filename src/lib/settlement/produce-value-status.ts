import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { canonicalMarketLabel, displayMarketName } from "@/lib/market";
import { runDailyClosePreflight } from "@/lib/produce/preflight-service";
import { PLAIN_TEXT_ROUND_ENFORCEMENT_FROM } from "@/lib/produce/plain-text-round-binding";
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

  // Reviewed aliases are one market: a row typed "ตลาด72" belongs to the
  // round the binding RPC filed under "เฉลิมฯ72".
  const market = canonicalMarketLabel(identity.marketName);
  const matches = preflight.rounds.filter((round) =>
    sameText(round.staffName, identity.staffName)
    && canonicalMarketLabel(round.marketName ?? "") === market,
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
  if (!round) {
    // Before plain-text rounds were enforced a business date legitimately has
    // no round to match; only day-level evidence can speak for it. From the
    // enforcement date on, produce without its round is never certified.
    if (preflight.businessDate >= PLAIN_TEXT_ROUND_ENFORCEMENT_FROM) return "blocked";
    const roundless: PreflightRound = {
      accountabilityRoundId: null,
      staffName: identity.staffName,
      marketName: identity.marketName,
      status: "ready",
      blockers: [],
      warnings: [],
    };
    return preflight.integrityIssues.some((issue) =>
      integrityIssueAffectsRound(issue, roundless, identity)) ? "blocked" : "complete";
  }
  if (preflight.integrityIssues.some((issue) =>
    integrityIssueAffectsRound(issue, round, identity))) {
    return "blocked";
  }
  if (round.status === "ready") return "complete";
  return round.status === "partial" ? "partial" : "blocked";
}

/** A day-level blocker that can reach rows no round owns in this market. */
function issueReachesUnboundMarket(issue: PreflightIssue, marketName: string): boolean {
  if (issue.severity !== "blocker" || issue.code === "unresolved_central_price") return false;
  if (issue.accountabilityRoundId) return false;
  if (issue.marketName) {
    return displayMarketName(issue.marketName, "") === displayMarketName(marketName, "");
  }
  const market = canonicalMarketLabel(marketName);
  if (issue.sourceMarketScope && issue.sourceMarketScope.length > 0 && market) {
    return issue.sourceMarketScope.includes(market);
  }
  return true;
}

/**
 * The same verdict for a scope with no seller — a White Sheet is one LINE
 * source + market + date. Every round its rows belong to must be complete on
 * its own identity; rows no round owns pass only when no blocker reaches the
 * market. One incomplete round makes the whole scope's money provisional.
 */
export function marketProduceValueStatus(
  preflight: DailyClosePreflightResult,
  marketName: string,
  rowRoundIds: readonly (string | null)[],
): SettlementProduceValueStatus {
  if (rowRoundIds.length === 0) return "missing";
  for (const id of new Set(rowRoundIds)) {
    let status: SettlementProduceValueStatus;
    if (!id) {
      // Round-less produce is legacy before enforcement, an anomaly after it.
      status = preflight.businessDate >= PLAIN_TEXT_ROUND_ENFORCEMENT_FROM
        || preflight.integrityIssues.some((issue) => issueReachesUnboundMarket(issue, marketName))
        ? "blocked"
        : "complete";
    } else {
      const round = preflight.rounds.find((row) => row.accountabilityRoundId === id);
      status = round
        ? settlementProduceValueStatus(preflight, {
            accountabilityRoundId: id,
            staffName: round.staffName ?? "",
            marketName: round.marketName ?? marketName,
          }, rowRoundIds.length)
        : "blocked";
    }
    if (status !== "complete") return status;
  }
  return "complete";
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

export type ProduceValueStatusResolver = (
  businessDate: string,
  identity: SettlementProduceIdentity,
  effectiveRowCount: number,
) => SettlementProduceValueStatus;

/**
 * P0: the settlement verdict for many (date, seller, market) groups — one
 * Daily Close preflight per business date. Legacy screens that net
 * withdrawal − return per seller/market (financial summary, report summary,
 * daily summary, ยอดส่ง preview) use this so they can never certify a ยอดส่ง
 * or ขาด/เกิน the settlement path itself would refuse. A date that is not a
 * real business date, or whose preflight fails, certifies nothing.
 */
export async function loadProduceValueStatusResolver(
  supabase: SupabaseClient<Database>,
  businessDates: Iterable<string>,
): Promise<ProduceValueStatusResolver> {
  const preflights = new Map<string, DailyClosePreflightResult | null>();
  // ponytail: sequential, one preflight per date; a month view is ~31 runs of
  // the same day-scoped scans. Batch the scans across dates if it gets slow.
  for (const date of new Set(businessDates)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    try {
      preflights.set(date, await runDailyClosePreflight(supabase, date));
    } catch {
      preflights.set(date, null);
    }
  }
  return (businessDate, identity, effectiveRowCount) => {
    const preflight = preflights.get(businessDate);
    return preflight
      ? settlementProduceValueStatus(preflight, identity, effectiveRowCount)
      : "blocked";
  };
}

/** reportGroupKey (date||market||seller) of every report group the verdict does not certify. */
export async function uncertifiedReportGroupKeys(
  supabase: SupabaseClient<Database>,
  groups: readonly { date: string; market: string; seller: string }[],
): Promise<string[]> {
  const marked = await markUncertifiedProduceNets(
    supabase,
    groups.map((group): { date: string; market: string; seller: string; produceNetStatus?: ProduceNetStatus } => group),
  );
  return marked
    .filter((group) => group.produceNetStatus === "return_incomplete")
    .map((group) => `${group.date}||${group.market}||${group.seller}`);
}

/** Why a legacy ยอดส่ง may not be shown as money. */
export type ProduceNetStatus = "trusted" | "returns_exceed_withdrawal" | "return_incomplete";

/**
 * Demote every (date, seller, market) net the settlement verdict does not
 * certify to "return_incomplete"; screens already hide ยอดส่ง and ขาด/เกิน for
 * any status other than "trusted".
 */
export async function markUncertifiedProduceNets<
  G extends { date: string; seller: string; market: string; produceNetStatus?: ProduceNetStatus },
>(supabase: SupabaseClient<Database>, groups: readonly G[]): Promise<G[]> {
  const verdict = await loadProduceValueStatusResolver(supabase, groups.map((group) => group.date));
  return groups.map((group) =>
    group.produceNetStatus === "returns_exceed_withdrawal"
    || verdict(group.date, { staffName: group.seller, marketName: group.market }, 1) === "complete"
      ? group
      : { ...group, produceNetStatus: "return_incomplete" as const });
}
