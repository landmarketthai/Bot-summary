import { describe, it, expect } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WeighSession, WeighSessionItem } from "@/lib/parsers/weigh-session/types";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import {
  runProduceCloseGate,
  runProduceFinalizeGate,
  confirmProduceSubunitReview,
  ProduceValidationGateError,
  type ProduceValidationSessionRef,
} from "./entry-validation-gate";
import type { RoundMasterRow } from "./entry-validation";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

const ROUND = "11111111-1111-4111-8111-111111111111";
const OTHER_ROUND = "22222222-2222-4222-8222-222222222222";

const REF: ProduceValidationSessionRef = {
  sessionKey: "group:G1",
  sessionGeneration: "9f1c0b5e-2a44-4d7e-8c31-6b0e2f5a7d13",
  accountabilityRoundId: ROUND,
  businessDate: "2026-08-09",
  marketLabel: "วัดทุ่งลานนา",
  staffLabel: "กี้",
  lineUserId: "U-typist",
};

interface ReviewRow {
  session_key: string;
  session_generation: string;
  accountability_round_id: string | null;
  validation_digest: string;
  exceptions: unknown;
  presented_by_line_user_id: string;
  presented_line_event_id: string;
  confirmed_at: string | null;
  confirmed_by_line_user_id: string | null;
  confirmed_line_event_id: string | null;
}

/**
 * Enough of PostgREST to exercise the gate: the round-scoped master read and
 * the two review RPCs, with the same uniqueness and append-only semantics the
 * migration enforces. Real PostgreSQL coverage lives in the .pg.test.ts file.
 */
class FakeDb {
  readonly reviews: ReviewRow[] = [];
  readonly masterQueries: Array<string | null> = [];
  masterError: string | null = null;
  masterRowOverride: RoundMasterRow[] | null = null;

  constructor(private readonly rowsByRound: Record<string, RoundMasterRow[]> = {}) {}

  client(): AnyClient {
    return {
      from: (table: string) => this.from(table),
      rpc: (name: string, params: Record<string, unknown>) => this.rpc(name, params),
    } as unknown as AnyClient;
  }

  private from(table: string) {
    if (table === "produce_transactions") {
      let roundId: string | null = null;
      const builder = {
        select: () => builder,
        eq: (_column: string, value: string) => {
          roundId = value;
          return builder;
        },
        limit: () => {
          this.masterQueries.push(roundId);
          if (this.masterError) return Promise.resolve({ data: null, error: { message: this.masterError } });
          const rows = this.masterRowOverride ?? this.rowsByRound[roundId ?? ""] ?? [];
          return Promise.resolve({ data: rows, error: null });
        },
      };
      return builder;
    }

    if (table === "produce_entry_validation_reviews") {
      const filters: Record<string, string> = {};
      const builder = {
        select: () => builder,
        eq: (column: string, value: string) => {
          filters[column] = String(value);
          return builder;
        },
        maybeSingle: () => {
          const row = this.reviews.find(
            (candidate) =>
              candidate.session_key === filters.session_key &&
              candidate.session_generation === filters.session_generation &&
              candidate.validation_digest === filters.validation_digest,
          );
          return Promise.resolve({ data: row ?? null, error: null });
        },
      };
      return builder;
    }

    throw new Error(`unexpected table ${table}`);
  }

  private rpc(name: string, params: Record<string, unknown>) {
    if (name === "record_produce_validation_review") {
      const existing = this.find(params);
      if (existing) {
        return Promise.resolve({
          data: {
            confirmed: existing.confirmed_at !== null,
            presented_line_event_id: existing.presented_line_event_id,
          },
          error: null,
        });
      }
      const row: ReviewRow = {
        session_key: String(params.p_session_key),
        session_generation: String(params.p_session_generation),
        accountability_round_id: (params.p_accountability_round_id as string | null) ?? null,
        validation_digest: String(params.p_validation_digest),
        exceptions: params.p_exceptions,
        presented_by_line_user_id: String(params.p_line_user_id),
        presented_line_event_id: String(params.p_line_event_id),
        confirmed_at: null,
        confirmed_by_line_user_id: null,
        confirmed_line_event_id: null,
      };
      this.reviews.push(row);
      return Promise.resolve({
        data: { confirmed: false, presented_line_event_id: row.presented_line_event_id },
        error: null,
      });
    }

    if (name === "confirm_produce_validation_review") {
      const row = this.find(params);
      if (!row) return Promise.resolve({ data: { status: "not_found" }, error: null });
      if (row.confirmed_at) {
        return Promise.resolve({ data: { status: "already_confirmed" }, error: null });
      }
      row.confirmed_at = new Date().toISOString();
      row.confirmed_by_line_user_id = String(params.p_line_user_id);
      row.confirmed_line_event_id = String(params.p_line_event_id);
      return Promise.resolve({ data: { status: "confirmed" }, error: null });
    }

    throw new Error(`unexpected rpc ${name}`);
  }

  private find(params: Record<string, unknown>): ReviewRow | undefined {
    return this.reviews.find(
      (row) =>
        row.session_key === String(params.p_session_key) &&
        row.session_generation === String(params.p_session_generation) &&
        row.validation_digest === String(params.p_validation_digest),
    );
  }
}

function item(overrides: Partial<WeighSessionItem> & { product_name: string }): WeighSessionItem {
  return {
    item_number: 1,
    price_per_unit: 100,
    quantity: 1,
    unit: "โล",
    section: "main",
    transaction_type: "เบิก",
    pricing_mode: "unit",
    basis_quantity: null,
    basis_unit: null,
    basis_price: null,
    ...overrides,
  };
}

function session(items: WeighSessionItem[]): WeighSession {
  return {
    date: "2026-08-09",
    staff_name: "กี้",
    sender_name: null,
    transaction_time: "18:00",
    session_title: "วัดทุ่งลานนา",
    session_kind: "main",
    declared_transaction_type: null,
    items: items.map((entry, index) => ({ ...entry, item_number: index + 1 })),
    parse_errors: [],
  };
}

const withdrawal: RoundMasterRow[] = [
  {
    product_name: "อะโวคาโด",
    unit: "โล",
    quantity: 10,
    price_per_unit: 100,
    transaction_type: "เบิก",
  },
];

describe("per-item subunit confirmations", () => {
  it("holds each item until its own confirmation is recorded", async () => {
    const parsed = session([
      item({ product_name: "องุ่น", pricing_mode: "basis", basis_quantity: 0.3, basis_unit: "โล", basis_price: 30, entered_quantity: 300, entered_unit: "กรัม", quantity: 0.3 }),
      item({ product_name: "มะม่วง", pricing_mode: "basis", basis_quantity: 0.2, basis_unit: "โล", basis_price: 20, entered_quantity: 2, entered_unit: "ขีด", quantity: 0.2 }),
    ]);
    const db = new FakeDb();
    const first = await runProduceCloseGate(db.client(), REF, parsed, "E1");
    expect(first.decision).toBe("review_presented");
    expect(db.reviews.length).toBe(3); // whole review + one row per item
    expect(await confirmProduceSubunitReview(db.client(), REF, parsed, 1, "C1")).toBe("confirmed");
    const second = await runProduceCloseGate(db.client(), REF, parsed, "E2");
    expect(second.decision).toBe("review_presented");
  });
});

const priceChange = (price = 120) =>
  session([
    item({ product_name: "อะโวคาโด", quantity: 4, price_per_unit: price, transaction_type: "คืน" }),
  ]);

/** A basis-priced line entered in กรัม: the one remaining review_required kind. */
const riskySubunit = (enteredQuantity = 300) =>
  session([
    item({
      product_name: "องุ่น",
      pricing_mode: "basis",
      basis_quantity: 1,
      basis_unit: "โล",
      basis_price: 100,
      entered_quantity: enteredQuantity,
      entered_unit: "กรัม",
      quantity: enteredQuantity / 1000,
    }),
  ]);

describe("close gate", () => {
  it("lets a clean round through without writing a review", async () => {
    const db = new FakeDb({ [ROUND]: withdrawal });
    const gate = await runProduceCloseGate(
      db.client(),
      REF,
      session([item({ product_name: "อะโวคาโด", quantity: 4, transaction_type: "คืน" })]),
      "E1",
    );
    expect(gate.decision).toBe("proceed");
    expect(db.reviews).toHaveLength(0);
  });

  it("refuses a blocking exception and records nothing to acknowledge", async () => {
    const db = new FakeDb({ [ROUND]: withdrawal });
    const gate = await runProduceCloseGate(
      db.client(),
      REF,
      session([item({ product_name: "อะโวคาโด", quantity: 4, unit: "โลก", transaction_type: "คืน" })]),
      "E1",
    );
    expect(gate.decision).toBe("blocked");
    expect(db.reviews).toHaveLength(0);
  });

  it("lets a price mismatch through on the first press without recording a review", async () => {
    const db = new FakeDb({ [ROUND]: withdrawal });
    const gate = await runProduceCloseGate(db.client(), REF, priceChange(), "E1");
    expect(gate.decision).toBe("proceed");
    expect(gate.result.reviews).toEqual([]);
    expect(gate.result.advisories).toMatchObject([
      { kind: "price_not_withdrawn", enteredPrice: 120, withdrawnPrices: [100] },
    ]);
    expect(db.reviews).toHaveLength(0);
  });

  // Unknown product names are advisory now (Production 2026-10-03), so the
  // remaining review_required kind — a risky subunit conversion — carries the
  // review lifecycle: present once, require its own confirmation, never let a
  // duplicate delivery or a bare second close stand in for that confirmation.
  it("treats a duplicate delivery of the presenting event as a duplicate, not an acknowledgement", async () => {
    const db = new FakeDb({ [ROUND]: withdrawal });
    await runProduceCloseGate(db.client(), REF, riskySubunit(), "E1");
    const replay = await runProduceCloseGate(db.client(), REF, riskySubunit(), "E1");

    expect(replay.decision).toBe("review_presented");
    const rowsAfterFirst = db.reviews.length;
    expect(rowsAfterFirst).toBeGreaterThan(0);
    await runProduceCloseGate(db.client(), REF, riskySubunit(), "E1");
    expect(db.reviews).toHaveLength(rowsAfterFirst);
    expect(db.reviews.every((row) => row.confirmed_at === null)).toBe(true);
  });

  it("is idempotent when the acknowledging event is delivered twice", async () => {
    const db = new FakeDb({ [ROUND]: withdrawal });
    await runProduceCloseGate(db.client(), REF, riskySubunit(), "E1");
    expect(await confirmProduceSubunitReview(db.client(), REF, riskySubunit(), 1, "C1")).toBe("confirmed");
    const first = await runProduceCloseGate(db.client(), REF, riskySubunit(), "E2");
    expect(first.decision).toBe("proceed");
    const snapshot = db.reviews.map((row) => ({ ...row }));

    const replay = await runProduceCloseGate(db.client(), REF, riskySubunit(), "E2");
    expect(replay.decision).toBe("proceed");
    expect(db.reviews).toEqual(snapshot);
  });

  it("does not let an acknowledgement carry over to changed content", async () => {
    const db = new FakeDb({ [ROUND]: [] });
    await runProduceCloseGate(db.client(), REF, riskySubunit(), "E1");
    await confirmProduceSubunitReview(db.client(), REF, riskySubunit(), 1, "C1");
    const rowsBefore = db.reviews.length;

    const changed = await runProduceCloseGate(db.client(), REF, riskySubunit(400), "E3");
    expect(changed.decision).toBe("review_presented");
    expect(db.reviews.length).toBeGreaterThan(rowsBefore);
    expect(db.reviews.slice(rowsBefore).every((row) => row.confirmed_at === null)).toBe(true);
  });

  it("never writes the entered price back to the withdrawal price", async () => {
    const db = new FakeDb({ [ROUND]: withdrawal });
    const parsed = priceChange(120);
    const gate = await runProduceCloseGate(db.client(), REF, parsed, "E1");

    expect(gate.decision).toBe("proceed");
    expect(parsed.items[0].price_per_unit).toBe(120);
    expect(withdrawal[0].price_per_unit).toBe(100);
    expect(gate.result.advisories[0]).toMatchObject({ enteredPrice: 120, withdrawnPrices: [100] });
    expect(db.reviews).toHaveLength(0);
  });
});

describe("round scoping", () => {
  it("reads the master of this session's round and no other", async () => {
    const db = new FakeDb({ [ROUND]: withdrawal, [OTHER_ROUND]: withdrawal });
    await runProduceCloseGate(
      db.client(),
      REF,
      session([item({ product_name: "อะโวคาโด", quantity: 4, transaction_type: "คืน" })]),
      "E1",
    );
    expect(db.masterQueries).toEqual([ROUND]);
  });

  it("does not borrow a withdrawal from an identical-looking other round", async () => {
    const db = new FakeDb({ [OTHER_ROUND]: withdrawal });
    const gate = await runProduceCloseGate(
      db.client(),
      REF,
      session([item({ product_name: "อะโวคาโด", quantity: 4, transaction_type: "คืน" })]),
      "E1",
    );
    expect(gate.decision).toBe("proceed");
    expect(gate.result.advisories).toContainEqual(expect.objectContaining({
      kind: "product_not_withdrawn",
      productName: "อะโวคาโด",
    }));
    expect(db.masterQueries).toEqual([ROUND]);
  });

  it("skips the master read entirely for an unbound legacy session", async () => {
    const db = new FakeDb({ [ROUND]: withdrawal });
    const gate = await runProduceCloseGate(
      db.client(),
      { ...REF, accountabilityRoundId: null },
      session([item({ product_name: "อะโวคาโด", quantity: 4, transaction_type: "คืน" })]),
      "E1",
    );
    expect(db.masterQueries).toEqual([]);
    expect(gate.decision).toBe("proceed");
  });
});

describe("fail closed", () => {
  it("raises rather than validating against a master it could not read", async () => {
    const db = new FakeDb({ [ROUND]: withdrawal });
    db.masterError = "connection reset";
    await expect(
      runProduceCloseGate(db.client(), REF, priceChange(), "E1"),
    ).rejects.toBeInstanceOf(ProduceValidationGateError);
  });

  it("raises rather than validating against a truncated master", async () => {
    const db = new FakeDb();
    db.masterRowOverride = Array.from({ length: 2000 }, () => withdrawal[0]);
    await expect(
      runProduceCloseGate(db.client(), REF, priceChange(), "E1"),
    ).rejects.toBeInstanceOf(ProduceValidationGateError);
  });

  it("refuses to record a review with no identifiable data-entry actor", async () => {
    const db = new FakeDb({ [ROUND]: withdrawal });
    await expect(
      runProduceCloseGate(db.client(), { ...REF, lineUserId: null }, riskySubunit(), "E1"),
    ).rejects.toBeInstanceOf(ProduceValidationGateError);
  });
});

describe("finalize gate", () => {
  it("lets a price advisory finalize without acknowledgement", async () => {
    const db = new FakeDb({ [ROUND]: withdrawal });
    const gate = await runProduceFinalizeGate(db.client(), REF, priceChange());
    expect(gate.decision).toBe("proceed");
    expect(gate.result.advisories).toHaveLength(1);
    expect(db.reviews).toHaveLength(0);
  });

  it("holds an unconfirmed risky subunit, then lets the confirmed session finalize", async () => {
    const db = new FakeDb({ [ROUND]: [] });
    await runProduceCloseGate(db.client(), REF, riskySubunit(), "E1");
    expect((await runProduceFinalizeGate(db.client(), REF, riskySubunit())).decision)
      .toBe("review_presented");

    await confirmProduceSubunitReview(db.client(), REF, riskySubunit(), 1, "C1");
    const gate = await runProduceFinalizeGate(db.client(), REF, riskySubunit());
    expect(gate.decision).toBe("proceed");
  });

  it("never presents or acknowledges anything of its own", async () => {
    const db = new FakeDb({ [ROUND]: withdrawal });
    const gate = await runProduceFinalizeGate(db.client(), REF, priceChange());
    expect(gate.decision).toBe("proceed");
    expect(db.reviews).toHaveLength(0);
  });

  it("keeps a measured return when its withdrawal later disappears, but flags it for reconciliation", async () => {
    const db = new FakeDb({ [ROUND]: withdrawal });
    // produce_transactions excludes voided sessions, so the master simply
    // stops containing the withdrawal. The measured return remains evidence;
    // downstream financial integrity owns the reconciliation hold.
    db.masterRowOverride = [];
    const gate = await runProduceFinalizeGate(db.client(), REF, priceChange());
    expect(gate.decision).toBe("proceed");
    expect(gate.result.advisories).toContainEqual(expect.objectContaining({
      kind: "product_not_withdrawn",
    }));
  });
});

// ── Product vocabulary guard at withdrawal intake ────────────────────────────

/** A withdrawal whose product name is not an approved dictionary spelling. */
const suspiciousWithdrawal = (name = "มะม่วงเขียวรกต") =>
  session([item({ product_name: name, transaction_type: "เบิก", quantity: 8 })]);

describe("unknown product vocabulary", () => {
  it("proceeds on the first close and keeps the entered name as an advisory", async () => {
    const db = new FakeDb({ [ROUND]: [] });
    const parsed = suspiciousWithdrawal();
    const gate = await runProduceCloseGate(db.client(), REF, parsed, "E1");

    expect(gate.decision).toBe("proceed");
    expect(gate.result.status).toBe("clean");
    expect(gate.result.reviews).toEqual([]);
    expect(gate.result.advisories).toContainEqual(expect.objectContaining({
      kind: "unknown_product_vocabulary",
      severity: "advisory",
      productName: "มะม่วงเขียวรกต",
    }));
    expect(parsed.items[0].product_name).toBe("มะม่วงเขียวรกต");
    expect(db.reviews).toHaveLength(0);
  });

  it("does not require a second close for a genuinely new product", async () => {
    const db = new FakeDb({ [ROUND]: [] });
    const newProduct = suspiciousWithdrawal("ฝรั่งสายพันธุ์ใหม่");

    const gate = await runProduceCloseGate(db.client(), REF, newProduct, "E1");

    expect(gate.decision).toBe("proceed");
    expect(gate.result.advisories).toContainEqual(expect.objectContaining({
      kind: "unknown_product_vocabulary",
      productName: "ฝรั่งสายพันธุ์ใหม่",
    }));
    expect(newProduct.items[0].product_name).toBe("ฝรั่งสายพันธุ์ใหม่");
    expect(db.reviews).toHaveLength(0);
  });

  it("drops the advisory once the operator corrects to an approved spelling", async () => {
    const db = new FakeDb({ [ROUND]: [] });
    const corrected = suspiciousWithdrawal("มะม่วงเขียวมรกต");
    const gate = await runProduceFinalizeGate(db.client(), REF, corrected);
    expect(gate.decision).toBe("proceed");
    expect(gate.result.status).toBe("clean");
    expect(gate.result.advisories.map((entry) => entry.kind))
      .not.toContain("unknown_product_vocabulary");
  });

  it("keeps multiple unknown names as advisories without holding the document", async () => {
    const db = new FakeDb({ [ROUND]: [] });
    const mixed = session([
      item({ product_name: "มะม่วงเขียวรกต", transaction_type: "เบิก", quantity: 2 }),
      item({ product_name: "อินมผรัม", transaction_type: "เบิก", quantity: 3 }),
    ]);
    const gate = await runProduceCloseGate(db.client(), REF, mixed, "E1");
    expect(gate.decision).toBe("proceed");
    expect(gate.result.status).toBe("clean");
    expect(gate.result.advisories.filter((entry) => entry.kind === "unknown_product_vocabulary"))
      .toHaveLength(2);
    expect(db.reviews).toHaveLength(0);
  });
});

// ── Internal item-number gaps cannot be closed or finalized ───────────────────
//
// The 2 SEP incident: a resent list skipped item #5 and closed anyway, taking
// a whole priced line with it. Both gates check `status === "blocked"` before
// any present/confirm path, so a gap can never reach the review flow — these
// pin that ordering rather than trusting it.

describe("item-number gap at the close boundary", () => {
  const gapped = () => parseWeighSession(
    [
      "ดำ-ตลาด เบิก 2/9/69",
      "1.องุ่นดำ100บาท", "10โล",
      "2.อินมผรัม50บาท", "5โล",
      "4.องุ่นดำ20บาท", "4โล",
    ].join("\n"),
    "2026-09-02",
  );

  it("refuses the close and records nothing to confirm later", async () => {
    const db = new FakeDb({ [ROUND]: [] });
    const gate = await runProduceCloseGate(db.client(), REF, gapped(), "E1");
    expect(gate.decision).toBe("blocked");
    expect(gate.result.blocking.map((entry) => entry.kind)).toContain("item_number_gap");
    // Nothing was presented, so no digest exists for a second press to confirm.
    expect(db.reviews).toHaveLength(0);
  });

  it("stays blocked on a second “จบรายการ” — the button cannot wave it through", async () => {
    const db = new FakeDb({ [ROUND]: [] });
    await runProduceCloseGate(db.client(), REF, gapped(), "E1");
    const second = await runProduceCloseGate(db.client(), REF, gapped(), "E2");
    expect(second.decision).toBe("blocked");
    expect(db.reviews).toHaveLength(0);
  });

  it("refuses to finalize", async () => {
    const db = new FakeDb({ [ROUND]: [] });
    const gate = await runProduceFinalizeGate(db.client(), REF, gapped());
    expect(gate.decision).toBe("blocked");
  });

  it("proceeds normally once the missing line is supplied", async () => {
    const db = new FakeDb({ [ROUND]: [] });
    const repaired = parseWeighSession(
      [
        "ดำ-ตลาด เบิก 2/9/69",
        "1.องุ่นดำ100บาท", "10โล",
        "2.อินมผรัม50บาท", "5โล",
        "3.แอปเปิ้ล10บาท", "84ลูก",
        "4.องุ่นดำ20บาท", "4โล",
      ].join("\n"),
      "2026-09-02",
    );
    const gate = await runProduceFinalizeGate(db.client(), REF, repaired);
    expect(gate.result.blocking.map((entry) => entry.kind)).not.toContain("item_number_gap");
  });
});
