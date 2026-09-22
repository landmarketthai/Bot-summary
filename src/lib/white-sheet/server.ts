import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import {
  loadDigitalWhiteSheetSummary,
  type DigitalWhiteSheetCashInput,
  type DigitalWhiteSheetScope,
} from "./load";
import {
  finalizeWhiteSheetCashEntry,
  loadWhiteSheetCashEntry,
  reopenWhiteSheetCashEntry,
  saveWhiteSheetCashEntry,
  type WhiteSheetCashEntryIdentity,
  type WhiteSheetCashEntryInput,
  type WhiteSheetCashEntryState,
} from "./persist";
import {
  loadDigitalWhiteSheetPageModel,
  type DigitalWhiteSheetPageModel,
} from "./compose";
import {
  getCentralPrice,
  getCentralPriceHistory,
  loadCentralPriceDetailsForDate,
  setCentralPrice,
  type CentralPriceCorrection,
  type CentralPriceIdentity,
  type CentralPriceRecord,
} from "./pricing";
import { fetchSalesProduceRows } from "@/lib/sales/load";
import {
  buildCentralPriceReview,
  type CentralPriceReviewItem,
} from "@/lib/produce/central-price-candidates";
import type { DigitalWhiteSheetSummary } from "./types";

/**
 * Existing server/report code can call this boundary without exposing a mock
 * fixture or creating a new Production-facing route.
 */
export async function loadServerDigitalWhiteSheetSummary(
  scope: DigitalWhiteSheetScope,
  cashInput: DigitalWhiteSheetCashInput,
): Promise<DigitalWhiteSheetSummary> {
  return loadDigitalWhiteSheetSummary(createServiceClient(), scope, cashInput);
}

export async function loadServerWhiteSheetCashEntry(
  identity: WhiteSheetCashEntryIdentity,
): Promise<WhiteSheetCashEntryState> {
  return loadWhiteSheetCashEntry(createServiceClient(), identity);
}

export async function saveServerWhiteSheetCashEntry(
  input: WhiteSheetCashEntryInput,
): Promise<WhiteSheetCashEntryState> {
  return saveWhiteSheetCashEntry(createServiceClient(), input);
}

export async function loadServerDigitalWhiteSheetPageModel(
  scope: DigitalWhiteSheetScope,
): Promise<DigitalWhiteSheetPageModel> {
  return loadDigitalWhiteSheetPageModel(createServiceClient(), scope);
}

/**
 * BR-06 admin-only lifecycle transitions. Callers (API routes) must call
 * requireAdminActor() against a request-scoped session client BEFORE calling
 * these — the actor id passed here is trusted as already-authorized.
 */
export async function finalizeServerWhiteSheetCashEntry(
  identity: WhiteSheetCashEntryIdentity,
  actorId: string,
): Promise<WhiteSheetCashEntryState> {
  return finalizeWhiteSheetCashEntry(createServiceClient(), identity, actorId);
}

export async function reopenServerWhiteSheetCashEntry(
  identity: WhiteSheetCashEntryIdentity,
  actorId: string,
  reason: string,
): Promise<WhiteSheetCashEntryState> {
  return reopenWhiteSheetCashEntry(createServiceClient(), identity, actorId, reason);
}

/** Central price reads are not privileged — any authenticated session may read. */
export async function getServerCentralPrice(
  identity: CentralPriceIdentity,
): Promise<CentralPriceRecord | null> {
  return getCentralPrice(createServiceClient(), identity);
}

export async function getServerCentralPriceHistory(
  identity: CentralPriceIdentity,
): Promise<CentralPriceCorrection[]> {
  return getCentralPriceHistory(createServiceClient(), identity);
}

/**
 * Every priced identity of a business date, with its candidate prices and
 * whether an administrator has decided it yet.
 *
 * Read-only, and deliberately not privileged: seeing that อะโวคาโด was entered
 * at both 50 and 70 บาท is exactly the information the shop needs before anyone
 * can decide. Only the POST that SETS a price requires an admin actor.
 */
export async function loadServerCentralPriceReview(
  businessDate: string,
): Promise<CentralPriceReviewItem[]> {
  const supabase = createServiceClient();
  const [rows, stored] = await Promise.all([
    fetchSalesProduceRows(supabase, businessDate),
    loadCentralPriceDetailsForDate(supabase, businessDate),
  ]);

  return buildCentralPriceReview(
    rows.map((row) => ({
      productName: row.product_name,
      unit: row.unit,
      marketName: row.market_name,
      pricePerUnit: row.price_per_unit === null ? null : Number(row.price_per_unit),
      basisQuantity: row.basis_quantity === null ? null : Number(row.basis_quantity),
      baseTransactionType: row.base_transaction_type,
      accountabilityRoundId: row.accountability_round_id,
    })),
    businessDate,
    stored,
  );
}

/** BR-01/BR-04 admin-only. Caller must call requireAdminActor() first. */
export async function setServerCentralPrice(input: {
  identity: CentralPriceIdentity;
  priceBaht: number;
  actor: string;
  reason?: string | null;
}): Promise<CentralPriceRecord> {
  return setCentralPrice(createServiceClient(), input);
}
