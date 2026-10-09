/**
 * P3 ↔ White Sheet page-model integration.
 *
 * Proves the read surface only: getSnapshot, formatProfitabilitySnapshot, and
 * the three explicit profitability states. Never records a snapshot, never
 * falls back to source/market/date, and never manufactures zero money.
 */
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DigitalWhiteSheetProfitability } from "@/components/white-sheet/DigitalWhiteSheetProfitability";
import {
  formatProfitabilitySnapshot,
  PROFITABILITY_INCOMPLETE_HEADING,
  PROFITABILITY_MONEY_UNPROVABLE,
  PROFITABILITY_NOT_CALCULATED_MESSAGE,
  PROFITABILITY_ROUND_UNBOUND_MESSAGE,
} from "@/lib/profitability/format";
import { PROFITABILITY_CALCULATION_VERSION } from "@/lib/profitability/types";
import type { Database } from "@/types/database";
import { stubManualSlipTables } from "@/lib/white-sheet/test-manual-slip-db";
import { loadDigitalWhiteSheetPageModel } from "./test-certified-returns";
import {
  requireTrustedWhiteSheetSummary,
  WhiteSheetHardStopError,
  WhiteSheetNotSubmittedError,
} from "./compose";

const SOURCE_ID = "group-p3-compose-1";
const MARKET_LABEL = "ตลาดพีสาม";
const BUSINESS_DATE = "2026-08-08";
const ROUND_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROUND_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SNAPSHOT_A = "11111111-1111-4111-8111-111111111111";
const SNAPSHOT_B = "22222222-2222-4222-8222-222222222222";
const INPUT_HASH = "a".repeat(64);

type CashEntryRow = Database["public"]["Tables"]["digital_white_sheet_cash_entries"]["Row"];
type RpcCall = { fn: string; args: Record<string, unknown> };

const CERTIFIED_PAYLOAD = {
  snapshot_id: SNAPSHOT_A,
  accountability_round_id: ROUND_A,
  revision: 1,
  calculation_version: PROFITABILITY_CALCULATION_VERSION,
  input_hash: INPUT_HASH,
  certification_state: "CERTIFIED",
  incomplete_reasons: [],
  superseded_by_snapshot_id: null,
  created_at: "2026-08-08T03:00:00+00:00",
  issued_quantity: "10.000000",
  good_return_quantity: "0.000000",
  damaged_quantity: "0.000000",
  sold_quantity: "10.000000",
  issued_cost_satang: "100000",
  good_return_cost_satang: "0",
  damage_loss_satang: "0",
  cogs_sold_satang: "100000",
  expected_money_satang: "150000",
  standard_margin_satang: "50000",
  approved_expenses_satang: "3000",
  approved_wages_satang: "5000",
  purchasing_expenses_satang: "2000",
  expected_operating_pl_satang: "40000",
  verified_transfers_satang: "10000",
  actual_cash_satang: "132000",
  shortage_overage_satang: "0",
  realized_pl_satang: "40000",
  lines: [],
  sources: [],
};

const INCOMPLETE_PAYLOAD = {
  ...CERTIFIED_PAYLOAD,
  revision: 2,
  certification_state: "INCOMPLETE",
  incomplete_reasons: [
    "purchasing_expenses_unattributable",
    "accountability_round_cancelled",
  ],
  purchasing_expenses_satang: null,
  expected_operating_pl_satang: null,
  realized_pl_satang: null,
  cogs_sold_satang: null,
  damage_loss_satang: null,
  standard_margin_satang: null,
  shortage_overage_satang: null,
};

const SUBMITTED_ENTRY: CashEntryRow = {
  id: "entry-1",
  source_id: SOURCE_ID,
  market_label_normalized: MARKET_LABEL,
  business_date: BUSINESS_DATE,
  labor: 50,
  location_fee: 0,
  bag: 0,
  snack: 0,
  other: 0,
  other_note: null,
  actual_cash_submitted: 450,
  white_sheet_sales: null,
  owner_cash: null,
  labor_entered: true,
  location_fee_entered: true,
  bag_entered: true,
  snack_entered: true,
  other_entered: true,
  actual_cash_submitted_entered: true,
  finalized_at: null,
  finalized_by: null,
  accountability_round_id: null,
  created_at: "2026-08-08T00:00:00Z",
  updated_at: "2026-08-08T00:00:00Z",
};

function makeDatabase(options?: {
  cashEntry?: CashEntryRow;
  duplicateMainSession?: boolean;
  snapshotsByRound?: Record<string, unknown | null>;
}) {
  const produceRows = [
    {
      id: "item-1",
      product_name: "มะม่วง",
      quantity: 10,
      unit: "โล",
      price_per_unit: 50,
      transaction_type: "เบิก",
      base_transaction_type: "เบิก",
      item_created_at: "2026-08-08T01:00:00Z",
      session_id: "main-session-1",
      transaction_date: BUSINESS_DATE,
      market_name: MARKET_LABEL,
      raw_message_id: "raw-1",
      basis_quantity: null,
      basis_price: null,
      session_kind: "main",
    },
    ...(options?.duplicateMainSession
      ? [
          {
            id: "item-2",
            product_name: "มะม่วง",
            quantity: 5,
            unit: "โล",
            price_per_unit: 50,
            transaction_type: "เบิก",
            base_transaction_type: "เบิก",
            item_created_at: "2026-08-08T02:00:00Z",
            session_id: "main-session-2",
            transaction_date: BUSINESS_DATE,
            market_name: MARKET_LABEL,
            raw_message_id: "raw-1",
            basis_quantity: null,
            basis_price: null,
            session_kind: "main",
          },
        ]
      : []),
  ];
  const rawMessages = [{ id: "raw-1", source_id: SOURCE_ID }];
  let storedEntry: CashEntryRow | undefined = options?.cashEntry;
  const rpcCalls: RpcCall[] = [];
  const tableMutations: string[] = [];
  const snapshotsByRound = options?.snapshotsByRound ?? {};

  const database = {
    from(table: string) {
      if (table === "produce_transactions") {
        const builder = {
          select: () => builder,
          eq: () => builder,
          is: () => builder,
          in: () => builder,
          order: () => builder,
          range: async () => ({
            data: produceRows,
            error: null,
            count: produceRows.length,
          }),
        };
        return builder;
      }
      if (table === "raw_messages") {
        return {
          select: () => ({
            in: async () => ({ data: rawMessages, error: null }),
          }),
        };
      }
      if (table === "slip_evidences") {
        // Thenable chain: when accountabilityRoundId is set, load.ts adds
        // .eq/.is after .lt before awaiting the query.
        const builder = {
          select: () => builder,
          eq: () => builder,
          gte: () => builder,
          lt: () => builder,
          is: () => builder,
          then: (
            resolve: (value: unknown) => unknown,
            reject?: (reason: unknown) => unknown,
          ) => Promise.resolve({ data: [], error: null }).then(resolve, reject),
        };
        return builder;
      }
      if (table === "central_selling_prices") {
        return {
          select: () => ({
            eq: async () => ({
              data: [{ product_key: "มะม่วง", unit_key: "โล", price_satang: 5000 }],
              error: null,
            }),
          }),
        };
      }
      if (table === "digital_white_sheet_cash_entries") {
        return {
          select: () => {
            const builder = {
              eq: () => builder,
              is: () => builder,
              maybeSingle: async () => ({ data: storedEntry ?? null, error: null }),
            };
            return builder;
          },
          upsert: (values: Partial<CashEntryRow>) => {
            tableMutations.push("digital_white_sheet_cash_entries:upsert");
            return {
              select: () => ({
                single: async () => {
                  storedEntry = {
                    id: storedEntry?.id ?? "entry-1",
                    created_at: storedEntry?.created_at ?? "2026-08-08T00:00:00Z",
                    ...values,
                  } as CashEntryRow;
                  return { data: storedEntry, error: null };
                },
              }),
            };
          },
          insert: () => {
            tableMutations.push("digital_white_sheet_cash_entries:insert");
            throw new Error("page load must not insert cash entries");
          },
          update: () => {
            tableMutations.push("digital_white_sheet_cash_entries:update");
            throw new Error("page load must not update cash entries");
          },
          delete: () => {
            tableMutations.push("digital_white_sheet_cash_entries:delete");
            throw new Error("page load must not delete cash entries");
          },
        };
      }
      for (const forbidden of [
        "inventory_movements",
        "inventory_movement_lines",
        "inventory_cost_movements",
        "inventory_cost_movement_lines",
        "settlement_entries",
        "profitability_snapshots",
      ]) {
        if (table === forbidden) {
          tableMutations.push(`${table}:touched`);
          throw new Error(`page load must not touch ${table}`);
        }
      }
      const manualSlip = stubManualSlipTables()(table);
      if (manualSlip) return manualSlip;
      throw new Error(`unexpected table: ${table}`);
    },
    rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      if (fn === "record_profitability_snapshot") {
        throw new Error("page load must never call record_profitability_snapshot");
      }
      if (fn === "get_profitability_snapshot") {
        const roundId = String(args.p_accountability_round_id);
        const data =
          Object.prototype.hasOwnProperty.call(snapshotsByRound, roundId)
            ? snapshotsByRound[roundId]
            : null;
        return Promise.resolve({ data: data ?? null, error: null });
      }
      throw new Error(`unexpected rpc: ${fn}`);
    },
  };

  return {
    client: database as unknown as SupabaseClient<Database>,
    rpcCalls,
    tableMutations,
  };
}

const BASE_SCOPE = {
  sourceId: SOURCE_ID,
  marketKey: "any-caller-key",
  marketLabel: MARKET_LABEL,
  businessDate: BUSINESS_DATE,
};

describe("loadDigitalWhiteSheetPageModel — P3 profitability read surface", () => {
  it("1. bound round + CERTIFIED snapshot → page model exposes exactly that snapshot", async () => {
    const { client, rpcCalls } = makeDatabase({
      cashEntry: { ...SUBMITTED_ENTRY, accountability_round_id: ROUND_A },
      snapshotsByRound: { [ROUND_A]: CERTIFIED_PAYLOAD },
    });

    const pageModel = await loadDigitalWhiteSheetPageModel(client, {
      ...BASE_SCOPE,
      accountabilityRoundId: ROUND_A,
    });

    expect(pageModel.profitability.state).toBe("available");
    if (pageModel.profitability.state !== "available") return;
    expect(pageModel.profitability.snapshot.snapshotId).toBe(SNAPSHOT_A);
    expect(pageModel.profitability.snapshot.accountabilityRoundId).toBe(ROUND_A);
    expect(pageModel.profitability.snapshot.certificationState).toBe("CERTIFIED");
    expect(pageModel.profitability.formatted).toBe(
      formatProfitabilitySnapshot(pageModel.profitability.snapshot),
    );
    expect(rpcCalls.map((c) => c.fn)).toEqual(["get_profitability_snapshot"]);
    expect(rpcCalls[0]!.args).toEqual({
      p_accountability_round_id: ROUND_A,
      p_revision: null,
    });
  });

  it("2. bound round + INCOMPLETE snapshot → INCOMPLETE and reasons remain visible", async () => {
    const { client } = makeDatabase({
      snapshotsByRound: { [ROUND_A]: INCOMPLETE_PAYLOAD },
    });

    const pageModel = await loadDigitalWhiteSheetPageModel(client, {
      ...BASE_SCOPE,
      accountabilityRoundId: ROUND_A,
    });

    expect(pageModel.profitability.state).toBe("available");
    if (pageModel.profitability.state !== "available") return;
    expect(pageModel.profitability.snapshot.certificationState).toBe("INCOMPLETE");
    expect(pageModel.profitability.snapshot.incompleteReasons).toEqual([
      "purchasing_expenses_unattributable",
      "accountability_round_cancelled",
    ]);
    expect(pageModel.profitability.formatted).toContain(PROFITABILITY_INCOMPLETE_HEADING);
    expect(pageModel.profitability.formatted).toContain("ยังระบุค่าใช้จ่ายในการซื้อไม่ได้");
    expect(pageModel.profitability.formatted).toContain("รอบความรับผิดชอบถูกยกเลิก");

    const html = renderToStaticMarkup(
      <DigitalWhiteSheetProfitability profitability={pageModel.profitability} />,
    );
    expect(html).toContain('data-certification-state="INCOMPLETE"');
    expect(html).toContain("ผลกำไร/ขาดทุนนี้ยังไม่ได้รับการรับรอง");
    expect(html).toContain(PROFITABILITY_INCOMPLETE_HEADING);
  });

  it("3. bound round + no snapshot → not_calculated and no write RPC", async () => {
    const { client, rpcCalls, tableMutations } = makeDatabase({
      snapshotsByRound: { [ROUND_A]: null },
    });

    const pageModel = await loadDigitalWhiteSheetPageModel(client, {
      ...BASE_SCOPE,
      accountabilityRoundId: ROUND_A,
    });

    expect(pageModel.profitability).toEqual({ state: "not_calculated" });
    expect(rpcCalls.map((c) => c.fn)).toEqual(["get_profitability_snapshot"]);
    expect(rpcCalls.some((c) => c.fn === "record_profitability_snapshot")).toBe(false);
    expect(tableMutations).toEqual([]);

    const html = renderToStaticMarkup(
      <DigitalWhiteSheetProfitability profitability={pageModel.profitability} />,
    );
    expect(html).toContain(PROFITABILITY_NOT_CALCULATED_MESSAGE);
    expect(html).toContain('data-profitability-state="not_calculated"');
  });

  it("4. legacy scope with accountabilityRoundId undefined → round_unbound, no UUID fallback", async () => {
    const { client, rpcCalls } = makeDatabase({
      snapshotsByRound: { [ROUND_A]: CERTIFIED_PAYLOAD },
    });

    const pageModel = await loadDigitalWhiteSheetPageModel(client, BASE_SCOPE);

    expect(pageModel.profitability).toEqual({ state: "round_unbound" });
    expect(rpcCalls).toEqual([]);

    const html = renderToStaticMarkup(
      <DigitalWhiteSheetProfitability profitability={pageModel.profitability} />,
    );
    expect(html).toContain(PROFITABILITY_ROUND_UNBOUND_MESSAGE);
  });

  it("5. scope with accountabilityRoundId null → round_unbound, no descriptive fallback", async () => {
    const { client, rpcCalls } = makeDatabase({
      snapshotsByRound: { [ROUND_A]: CERTIFIED_PAYLOAD },
    });

    const pageModel = await loadDigitalWhiteSheetPageModel(client, {
      ...BASE_SCOPE,
      accountabilityRoundId: null,
    });

    expect(pageModel.profitability).toEqual({ state: "round_unbound" });
    expect(rpcCalls).toEqual([]);
  });

  it("6. Round A and Round B with identical descriptive fields read only their own snapshot", async () => {
    const twinB = {
      ...CERTIFIED_PAYLOAD,
      snapshot_id: SNAPSHOT_B,
      accountability_round_id: ROUND_B,
      cogs_sold_satang: "777777",
      realized_pl_satang: "111111",
    };
    const { client, rpcCalls } = makeDatabase({
      snapshotsByRound: {
        [ROUND_A]: CERTIFIED_PAYLOAD,
        [ROUND_B]: twinB,
      },
    });

    const pageA = await loadDigitalWhiteSheetPageModel(client, {
      ...BASE_SCOPE,
      accountabilityRoundId: ROUND_A,
    });
    const pageB = await loadDigitalWhiteSheetPageModel(client, {
      ...BASE_SCOPE,
      accountabilityRoundId: ROUND_B,
    });

    expect(pageA.profitability.state).toBe("available");
    expect(pageB.profitability.state).toBe("available");
    if (pageA.profitability.state !== "available" || pageB.profitability.state !== "available") {
      return;
    }
    expect(pageA.profitability.snapshot.snapshotId).toBe(SNAPSHOT_A);
    expect(pageA.profitability.snapshot.cogsSoldSatang).toBe("100000");
    expect(pageB.profitability.snapshot.snapshotId).toBe(SNAPSHOT_B);
    expect(pageB.profitability.snapshot.cogsSoldSatang).toBe("777777");
    expect(pageA.profitability.snapshot.accountabilityRoundId).toBe(ROUND_A);
    expect(pageB.profitability.snapshot.accountabilityRoundId).toBe(ROUND_B);
    expect(rpcCalls.map((c) => c.args.p_accountability_round_id)).toEqual([ROUND_A, ROUND_B]);
  });

  it("7. NULL monetary field is never displayed/formatted as zero", async () => {
    const { client } = makeDatabase({
      snapshotsByRound: { [ROUND_A]: INCOMPLETE_PAYLOAD },
    });

    const pageModel = await loadDigitalWhiteSheetPageModel(client, {
      ...BASE_SCOPE,
      accountabilityRoundId: ROUND_A,
    });

    expect(pageModel.profitability.state).toBe("available");
    if (pageModel.profitability.state !== "available") return;
    expect(pageModel.profitability.snapshot.cogsSoldSatang).toBeNull();
    expect(pageModel.profitability.snapshot.purchasingExpensesSatang).toBeNull();
    expect(pageModel.profitability.formatted).toContain(PROFITABILITY_MONEY_UNPROVABLE);
    expect(pageModel.profitability.formatted).not.toMatch(/ต้นทุนสินค้าที่ขาย \(COGS\): 0\.00/);
    expect(pageModel.profitability.formatted).not.toMatch(
      /กำไร\/ขาดทุนที่เกิดขึ้นจริง: 0\.00/,
    );
  });

  it("8. cancelled-round INCOMPLETE snapshot remains INCOMPLETE", async () => {
    const cancelled = {
      ...INCOMPLETE_PAYLOAD,
      incomplete_reasons: ["accountability_round_cancelled"],
    };
    const { client } = makeDatabase({
      snapshotsByRound: { [ROUND_A]: cancelled },
    });

    const pageModel = await loadDigitalWhiteSheetPageModel(client, {
      ...BASE_SCOPE,
      accountabilityRoundId: ROUND_A,
    });

    expect(pageModel.profitability.state).toBe("available");
    if (pageModel.profitability.state !== "available") return;
    expect(pageModel.profitability.snapshot.certificationState).toBe("INCOMPLETE");
    expect(pageModel.profitability.snapshot.incompleteReasons).toContain(
      "accountability_round_cancelled",
    );
    expect(pageModel.profitability.formatted).toContain(PROFITABILITY_INCOMPLETE_HEADING);
  });

  it("9. existing White Sheet not-submitted behavior is unchanged", async () => {
    const { client } = makeDatabase();
    const pageModel = await loadDigitalWhiteSheetPageModel(client, BASE_SCOPE);

    expect(pageModel.entryStatus).toBe("not_submitted");
    expect(pageModel.summary.expectedSales).toBe(500);
    expect(pageModel.summary.actualCashSubmitted).toBe(0);
    expect(pageModel.profitability).toEqual({ state: "round_unbound" });
    expect(() => requireTrustedWhiteSheetSummary(pageModel)).toThrow(
      WhiteSheetNotSubmittedError,
    );
  });

  it("10. existing White Sheet hard-stop behavior is unchanged", async () => {
    const { client } = makeDatabase({
      cashEntry: SUBMITTED_ENTRY,
      duplicateMainSession: true,
      snapshotsByRound: { [ROUND_A]: CERTIFIED_PAYLOAD },
    });

    const pageModel = await loadDigitalWhiteSheetPageModel(client, {
      ...BASE_SCOPE,
      accountabilityRoundId: ROUND_A,
    });

    expect(pageModel.entryStatus).toBe("submitted");
    expect(() => requireTrustedWhiteSheetSummary(pageModel)).toThrow(WhiteSheetHardStopError);
    // P3 remains independently visible even when White Sheet is untrusted.
    expect(pageModel.profitability.state).toBe("available");
    if (pageModel.profitability.state !== "available") return;
    expect(pageModel.profitability.snapshot.certificationState).toBe("CERTIFIED");
  });

  it("11. page rendering performs no profitability write, inventory, cost, or settlement mutation", async () => {
    const { client, rpcCalls, tableMutations } = makeDatabase({
      cashEntry: { ...SUBMITTED_ENTRY, accountability_round_id: ROUND_A },
      snapshotsByRound: { [ROUND_A]: CERTIFIED_PAYLOAD },
    });

    await loadDigitalWhiteSheetPageModel(client, {
      ...BASE_SCOPE,
      accountabilityRoundId: ROUND_A,
    });

    expect(rpcCalls.every((c) => c.fn === "get_profitability_snapshot")).toBe(true);
    expect(rpcCalls.some((c) => c.fn === "record_profitability_snapshot")).toBe(false);
    expect(tableMutations).toEqual([]);
  });

  it("invalid non-UUID accountabilityRoundId is round_unbound without querying", async () => {
    const { client, rpcCalls } = makeDatabase({
      snapshotsByRound: { [ROUND_A]: CERTIFIED_PAYLOAD },
    });

    const pageModel = await loadDigitalWhiteSheetPageModel(client, {
      ...BASE_SCOPE,
      accountabilityRoundId: "not-a-uuid",
    });

    expect(pageModel.profitability).toEqual({ state: "round_unbound" });
    expect(rpcCalls).toEqual([]);
  });
});
