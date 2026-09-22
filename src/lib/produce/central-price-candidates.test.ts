import { describe, expect, test } from "bun:test";
import { SYSTEM_WITHDRAWAL_SEED_ACTOR } from "@/lib/white-sheet/pricing";
import {
  buildCentralPriceReview,
  unresolvedCentralPrices,
  type WithdrawalPriceRow,
} from "./central-price-candidates";

const DATE = "2026-08-13";

function withdrawal(overrides: Partial<WithdrawalPriceRow> = {}): WithdrawalPriceRow {
  return {
    accountabilityRoundId: "round-72",
    productName: "อะโวคาโด",
    unit: "โล",
    marketName: "ตลาด72",
    pricePerUnit: 50,
    basisQuantity: null,
    baseTransactionType: "เบิก",
    ...overrides,
  };
}

const seeded = (priceSatang: number) => ({ priceSatang, setBy: SYSTEM_WITHDRAWAL_SEED_ACTOR });
const approved = (priceSatang: number) => ({ priceSatang, setBy: "admin-uuid" });

describe("central price review", () => {
  test("one price with a seeded row is settled, not a conflict", () => {
    const review = buildCentralPriceReview(
      [withdrawal(), withdrawal()],
      DATE,
      new Map([["อะโวคาโด โล", seeded(5_000)]]),
    );
    expect(review).toHaveLength(1);
    expect(review[0].status).toBe("seeded");
    expect(review[0].candidates).toEqual([
      { priceSatang: 5_000, occurrenceCount: 2, affectedMarkets: ["ตลาด72"] },
    ]);
    expect(unresolvedCentralPrices(review)).toHaveLength(0);
  });

  test("cross-round 50 vs 70 stays separate and complete", () => {
    const review = buildCentralPriceReview(
      [
        withdrawal({ pricePerUnit: 50 }),
        withdrawal({ pricePerUnit: 50 }),
        withdrawal({ accountabilityRoundId: "round-expressway", pricePerUnit: 70, marketName: "เลียบด่วน" }),
      ],
      DATE,
      new Map([["อะโวคาโด โล", seeded(5_000)]]),
    );
    expect(review).toHaveLength(2);
    expect(review[0].status).not.toBe("unresolved");
    expect(review[0].candidates).toEqual([
      { priceSatang: 5_000, occurrenceCount: 2, affectedMarkets: ["ตลาด72"] },
    ]);
    expect(review[1].status).not.toBe("unresolved");
    expect(review[1].candidates).toEqual([
      { priceSatang: 7_000, occurrenceCount: 1, affectedMarkets: ["เลียบด่วน"] },
    ]);
    expect(review[0].approvedPriceSatang).toBe(5_000);
  });

  test("same-round variation stays advisory even when a legacy central row exists", () => {
    const rows = [withdrawal({ pricePerUnit: 50 }), withdrawal({ pricePerUnit: 70 })];
    const review = buildCentralPriceReview(rows, DATE, new Map([["อะโวคาโด โล", approved(5_000)]]));

    expect(review[0].status).toBe("unresolved");
    expect(review[0].approvedPriceSatang).toBe(5_000);
    expect(review[0].approvedBy).toBe("admin-uuid");
    // The withdrawal rows are inputs, never rewritten.
    expect(rows.map((row) => row.pricePerUnit)).toEqual([50, 70]);
  });

  test("a central display correction never overwrites or suppresses entered-price variation", () => {
    const rows50 = [withdrawal({ pricePerUnit: 50 })];
    const rows50And70 = [...rows50, withdrawal({ pricePerUnit: 70 })];

    expect(buildCentralPriceReview(rows50, DATE, new Map([
      ["อะโวคาโด โล", seeded(5_000)],
    ]))[0]).toMatchObject({ status: "seeded", approvedPriceSatang: 5_000 });
    expect(buildCentralPriceReview(rows50And70, DATE, new Map([
      ["อะโวคาโด โล", seeded(5_000)],
    ]))[0]).toMatchObject({ status: "unresolved", approvedPriceSatang: 5_000 });
    expect(buildCentralPriceReview(rows50And70, DATE, new Map([
      ["อะโวคาโด โล", approved(5_000)],
    ]))[0]).toMatchObject({ status: "unresolved", approvedPriceSatang: 5_000 });
    expect(buildCentralPriceReview(rows50And70, DATE, new Map([
      ["อะโวคาโด โล", approved(7_000)],
    ]))[0]).toMatchObject({ status: "unresolved", approvedPriceSatang: 7_000 });
    expect(rows50And70.map((row) => row.pricePerUnit)).toEqual([50, 70]);
  });

  test("no stored price at all is missing, not approved", () => {
    const review = buildCentralPriceReview([withdrawal()], DATE, new Map());
    expect(review[0].status).toBe("missing");
    expect(review[0].approvedPriceSatang).toBeNull();
  });

  test("the same product in two units is two identities, never a conflict", () => {
    const review = buildCentralPriceReview(
      [
        withdrawal({ productName: "ทุเรียน", unit: "โล", pricePerUnit: 120 }),
        withdrawal({ productName: "ทุเรียน", unit: "ลูก", pricePerUnit: 300 }),
      ],
      DATE,
      new Map([
        ["ทุเรียน โล", seeded(12_000)],
        ["ทุเรียน ลูก", seeded(30_000)],
      ]),
    );
    expect(review.map((item) => item.status)).toEqual(["seeded", "seeded"]);
  });

  test("returns and damage never contribute a candidate price", () => {
    const review = buildCentralPriceReview(
      [
        withdrawal({ pricePerUnit: 50 }),
        withdrawal({ pricePerUnit: 70, baseTransactionType: "คืน" }),
        withdrawal({ pricePerUnit: 90, baseTransactionType: "คืนเสีย" }),
      ],
      DATE,
      new Map([["อะโวคาโด โล", seeded(5_000)]]),
    );
    expect(review[0].candidates).toHaveLength(1);
    expect(review[0].status).toBe("seeded");
  });

  test("rows with no product, unit or price are not price evidence", () => {
    const review = buildCentralPriceReview(
      [
        withdrawal({ productName: null }),
        withdrawal({ unit: null }),
        withdrawal({ pricePerUnit: null }),
      ],
      DATE,
      new Map(),
    );
    expect(review).toHaveLength(0);
  });
});
