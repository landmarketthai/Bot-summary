import { canonicalMarketLabel, REVIEWED_MARKET_LABELS } from "@/lib/market";
import { isQaMarketLabel } from "@/lib/sales/qa-scopes";

/** Reporting-only identity. Never changes a stored round, alias or fingerprint. */
export function morningBriefMarket(value: string | null | undefined, seller?: string | null): string {
  if (value?.normalize("NFC").trim() === "หนูเล็ก-พาซีโอ้") {
    return seller == null || seller.normalize("NFC").trim() === "หนูเล็ก" ? "พาซิโอ้ผัก" : "";
  }
  if (seller?.normalize("NFC").trim() === "หนูเล็ก"
    && ["พาซีโอ้", "พาซิโอ้", "พาสิโอ้"].includes(value?.normalize("NFC").trim() ?? "")) return "พาซิโอ้ผัก";
  const label = canonicalMarketLabel(value);
  if (isQaMarketLabel(label)) return "";
  // Bare Pasio has multiple businesses; unknown spellings are not fruit by default.
  return label !== "พาซิโอ้" && REVIEWED_MARKET_LABELS.includes(label) ? label : "";
}
