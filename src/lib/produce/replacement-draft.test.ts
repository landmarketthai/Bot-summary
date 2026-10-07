import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import { PendingSessionService, type PendingSession } from "@/lib/line/pending-session-service";
import {
  REPLACE_FINALIZED_SESSION_COMMAND,
  buildReplacementSeedText,
  canStartReplacementFrom,
  findReplacementCandidate,
  isExactReplaceFinalizedSessionCommand,
  renderReplacementItemLines,
  replacementDraftCommandReply,
  startFinalizedSessionReplacementDraft,
  type ReplacementCandidateItemRow,
  type StartReplacementResult,
} from "./replacement-draft";

// ── command matching ─────────────────────────────────────────────────────────

describe("isExactReplaceFinalizedSessionCommand", () => {
  it("matches only the exact trigger phrase", () => {
    expect(isExactReplaceFinalizedSessionCommand(REPLACE_FINALIZED_SESSION_COMMAND)).toBe(true);
    expect(isExactReplaceFinalizedSessionCommand(`  ${REPLACE_FINALIZED_SESSION_COMMAND}  `)).toBe(true);
    expect(isExactReplaceFinalizedSessionCommand(`${REPLACE_FINALIZED_SESSION_COMMAND} 1`)).toBe(false);
    expect(isExactReplaceFinalizedSessionCommand("แก้ข้อ 1")).toBe(false);
  });
});

// ── canStartReplacementFrom ──────────────────────────────────────────────────

function basePending(overrides: Partial<PendingSession> = {}): PendingSession {
  return {
    id: "p1",
    session_key: "user:U1",
    source_id: "U1",
    accumulated_text: "กี้-ตลาดทดสอบ เบิก 24/8/2569",
    latest_reply_token: null,
    line_user_id: "U1",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    session_generation: "gen-1",
    close_event_timestamp_ms: null,
    close_requested_at: null,
    close_line_event_id: null,
    close_finalize_started_at: null,
    terminalized: false,
    next_attempt_at: null,
    close_deadline_at: null,
    close_session_generation: null,
    expected_item_count: null,
    ingest_revision: 0,
    entry_origin: null,
    replaces_produce_session_id: null,
    ...overrides,
  };
}

describe("canStartReplacementFrom", () => {
  it("allows a fresh plain-text draft with no replacement target yet", () => {
    expect(canStartReplacementFrom(basePending())).toBe(true);
  });

  it("refuses when there is no session", () => {
    expect(canStartReplacementFrom(null)).toBe(false);
  });

  it("refuses a structured (guided-menu) session", () => {
    expect(canStartReplacementFrom(basePending({ entry_origin: "guided_menu" }))).toBe(false);
  });

  it("refuses a session already closing", () => {
    expect(canStartReplacementFrom(basePending({ close_event_timestamp_ms: 1000 }))).toBe(false);
  });

  it("refuses a terminalized session", () => {
    expect(canStartReplacementFrom(basePending({ terminalized: true }))).toBe(false);
  });

  it("refuses a draft that is already replacing something", () => {
    expect(
      canStartReplacementFrom(basePending({ replaces_produce_session_id: "predecessor-1" })),
    ).toBe(false);
  });

  it("allows a header-only draft with no item lines typed yet", () => {
    expect(
      canStartReplacementFrom(basePending({ accumulated_text: "กี้-ตลาดทดสอบ เบิก 24/8/2569" })),
    ).toBe(true);
  });

  it("refuses a draft where the operator already typed at least one item line", () => {
    expect(
      canStartReplacementFrom(basePending({
        accumulated_text: [
          "กี้-ตลาดทดสอบ เบิก 24/8/2569",
          "1. มังคุด 45 บาท",
          "10 โล",
        ].join("\n"),
      })),
    ).toBe(false);
  });
});

// ── seed rendering, roundtripped through the REAL parser ────────────────────

function row(overrides: Partial<ReplacementCandidateItemRow> = {}): ReplacementCandidateItemRow {
  return {
    session_id: "predecessor-1",
    item_number: 1,
    product_name: "มังคุด",
    price_per_unit: 45,
    quantity: 10,
    unit: "โล",
    section: "main",
    transaction_type: "เบิก",
    basis_quantity: null,
    basis_unit: null,
    basis_price: null,
    pricing_mode: "unit",
    ...overrides,
  };
}

describe("renderReplacementItemLines / buildReplacementSeedText", () => {
  it("renders a plain unit-priced item as item+price then quantity+unit", () => {
    expect(renderReplacementItemLines(row())).toEqual([
      "1. มังคุด 45 บาท",
      "10 โล",
    ]);
  });

  it("renders a basis-priced item as one bundled line", () => {
    const basis = row({
      item_number: 85,
      product_name: "ผักกาดขาว",
      pricing_mode: "basis",
      basis_quantity: 3,
      basis_unit: "หัว",
      basis_price: 20,
      price_per_unit: null,
      quantity: null,
      unit: null,
    });
    expect(renderReplacementItemLines(basis)).toEqual(["85. ผักกาดขาว 3 หัว 20 บาท"]);
  });

  it("re-parses a seeded 30-item document back to the exact same effective items", () => {
    const rows = Array.from({ length: 30 }, (_, index) =>
      row({ item_number: index + 1, quantity: index + 1 }));
    const seedText = buildReplacementSeedText(rows);
    const document = [
      "กี้-ตลาดทดสอบ เบิก 24/8/2569",
      seedText,
      "จบรายการเบิก",
    ].join("\n");

    const parsed = parseWeighSession(document);
    expect(parsed.parse_errors).toEqual([]);
    expect(parsed.items).toHaveLength(30);
    expect(parsed.items.map((item) => item.quantity)).toEqual(
      Array.from({ length: 30 }, (_, index) => index + 1),
    );
  });

  it("a seeded document still accepts the EXISTING แก้ข้อ N grammar for a quantity correction", () => {
    const rows = Array.from({ length: 30 }, (_, index) =>
      row({ item_number: index + 1, quantity: index + 1 }));
    const seedText = buildReplacementSeedText(rows);
    const document = [
      "กี้-ตลาดทดสอบ เบิก 24/8/2569",
      seedText,
      "แก้ข้อ 17",
      "17. มังคุด 45 บาท",
      "99 โล",
      "จบรายการเบิก",
    ].join("\n");

    const parsed = parseWeighSession(document);
    expect(parsed.parse_errors).toEqual([]);
    expect(parsed.items).toHaveLength(30);
    expect(parsed.items.find((item) => item.item_number === 17)?.quantity).toBe(99);
  });

  it("a seeded document still accepts ลบข้อ N to remove one item", () => {
    const rows = Array.from({ length: 5 }, (_, index) =>
      row({ item_number: index + 1, quantity: index + 1 }));
    const seedText = buildReplacementSeedText(rows);
    const document = [
      "กี้-ตลาดทดสอบ เบิก 24/8/2569",
      seedText,
      "ลบข้อ 3",
      "จบรายการเบิก",
    ].join("\n");

    const parsed = parseWeighSession(document);
    expect(parsed.parse_errors).toEqual([]);
    // Removal renumbers the rest sequentially; typed numbers stay as audit.
    expect(parsed.items.map((item) => item.item_number)).toEqual([1, 2, 3, 4]);
    expect(parsed.items.map((item) => item.original_item_number)).toEqual([undefined, undefined, 4, 5]);
  });
});

// ── findReplacementCandidate ─────────────────────────────────────────────────

function makeFakeSupabase(rows: Array<Record<string, unknown>>) {
  const database = {
    from(table: string) {
      if (table !== "produce_transactions") throw new Error(`unexpected table: ${table}`);
      const filters: Array<{ column: string; value: unknown }> = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const builder: any = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filters.push({ column, value });
          return builder;
        },
        then: (onFulfilled?: ((value: { data: unknown; error: null }) => unknown) | null) => {
          const matched = rows.filter((r) => filters.every((f) => r[f.column] === f.value));
          return Promise.resolve({ data: matched, error: null }).then(onFulfilled ?? undefined);
        },
      };
      return builder;
    },
  };
  return database as unknown as SupabaseClient<Database>;
}

const HEADER = { type: "เบิก" as const, staff: "กี้", market: "ตลาดทดสอบ", date: "2026-08-24" };

describe("findReplacementCandidate", () => {
  it("refuses (none) when no header field is known", async () => {
    const supabase = makeFakeSupabase([]);
    expect(await findReplacementCandidate(supabase, { type: null, staff: null, market: null, date: null }))
      .toEqual({ kind: "none" });
  });

  it("finds exactly one candidate session matching date+staff+market+type", async () => {
    const supabase = makeFakeSupabase([
      { session_id: "s1", item_number: 1, base_transaction_type: "เบิก", transaction_date: "2026-08-24", staff_name: "กี้", market_name: "ตลาดทดสอบ", product_name: "มังคุด", price_per_unit: 45, quantity: 10, unit: "โล", section: "main", transaction_type: "เบิก", basis_quantity: null, basis_unit: null, basis_price: null, pricing_mode: "unit" },
      { session_id: "s1", item_number: 2, base_transaction_type: "เบิก", transaction_date: "2026-08-24", staff_name: "กี้", market_name: "ตลาดทดสอบ", product_name: "ส้ม", price_per_unit: 30, quantity: 5, unit: "โล", section: "main", transaction_type: "เบิก", basis_quantity: null, basis_unit: null, basis_price: null, pricing_mode: "unit" },
    ]);
    const result = await findReplacementCandidate(supabase, HEADER);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.sessionId).toBe("s1");
      expect(result.items.map((r) => r.item_number)).toEqual([1, 2]);
    }
  });

  it("refuses (none) when zero sessions match", async () => {
    const supabase = makeFakeSupabase([]);
    expect((await findReplacementCandidate(supabase, HEADER)).kind).toBe("none");
  });

  it("refuses (ambiguous) when more than one session matches the same identity", async () => {
    const makeRow = (sessionId: string) => ({
      session_id: sessionId, item_number: 1, base_transaction_type: "เบิก",
      transaction_date: HEADER.date, staff_name: HEADER.staff, market_name: HEADER.market,
      product_name: "มังคุด", price_per_unit: 45, quantity: 10, unit: "โล",
      section: "main", transaction_type: "เบิก", basis_quantity: null,
      basis_unit: null, basis_price: null, pricing_mode: "unit",
    });
    const supabase = makeFakeSupabase([makeRow("s1"), makeRow("s2")]);
    const result = await findReplacementCandidate(supabase, HEADER);
    expect(result).toEqual({ kind: "ambiguous", count: 2 });
  });

  it("excludes a session that mixes base transaction types under one document (unsupported, fails closed)", async () => {
    const common = { transaction_date: HEADER.date, staff_name: HEADER.staff, market_name: HEADER.market };
    const supabase = makeFakeSupabase([
      { session_id: "s1", item_number: 1, base_transaction_type: "เบิก", product_name: "มังคุด", price_per_unit: 45, quantity: 10, unit: "โล", section: "main", transaction_type: "เบิก", basis_quantity: null, basis_unit: null, basis_price: null, pricing_mode: "unit", ...common },
      { session_id: "s1", item_number: 2, base_transaction_type: "คืน", product_name: "ส้ม", price_per_unit: 30, quantity: 5, unit: "โล", section: "main", transaction_type: "คืน", basis_quantity: null, basis_unit: null, basis_price: null, pricing_mode: "unit", ...common },
    ]);
    expect((await findReplacementCandidate(supabase, HEADER)).kind).toBe("none");
  });
});

// ── reply copy: one branch per status, never a silent success reply ────────

describe("replacementDraftCommandReply", () => {
  const cases: StartReplacementResult[] = [
    { status: "no_header" },
    { status: "already_replacing" },
    { status: "none" },
    { status: "ambiguous", count: 2 },
    { status: "stamp_refused", reason: "target_not_replaceable" },
    { status: "stamp_refused", reason: "generation_conflict" },
  ];

  it("returns non-empty, distinguishable Thai text for every refusal status", () => {
    const seen = new Set<string>();
    for (const result of cases) {
      const reply = replacementDraftCommandReply(result);
      expect(reply.length).toBeGreaterThan(0);
      expect(seen.has(reply)).toBe(false);
      seen.add(reply);
    }
  });

  it("the success reply names the item count and points at the correction commands", () => {
    const reply = replacementDraftCommandReply({
      status: "started",
      session: basePending(),
      predecessorSessionId: "predecessor-1",
      itemCount: 30,
    });
    expect(reply).toContain("30");
    expect(reply).toContain("แก้ข้อ");
    expect(reply).toContain("ลบข้อ");
  });
});

// ── orchestration ────────────────────────────────────────────────────────────

function makeOrchestrationSupabase(options: {
  candidateRows: Array<Record<string, unknown>>;
  stampResult: { stamped: boolean; reason: string };
}) {
  const database = {
    from(table: string) {
      if (table !== "produce_transactions") throw new Error(`unexpected table: ${table}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        then: (onFulfilled?: ((value: { data: unknown; error: null }) => unknown) | null) =>
          Promise.resolve({ data: options.candidateRows, error: null }).then(onFulfilled ?? undefined),
      };
      return builder;
    },
    rpc(name: string) {
      if (name !== "stamp_pending_session_replacement_target") {
        throw new Error(`unexpected rpc: ${name}`);
      }
      return Promise.resolve({ data: options.stampResult, error: null });
    },
  };
  return database as unknown as SupabaseClient<Database>;
}

function makeFakeService(sessionAfterAppend: PendingSession) {
  return {
    append: async () => sessionAfterAppend,
  } as unknown as PendingSessionService;
}

const CANDIDATE_ROWS = [
  { session_id: "predecessor-1", item_number: 1, base_transaction_type: "เบิก", product_name: "มังคุด", price_per_unit: 45, quantity: 10, unit: "โล", section: "main", transaction_type: "เบิก", basis_quantity: null, basis_unit: null, basis_price: null, pricing_mode: "unit" },
];

describe("startFinalizedSessionReplacementDraft", () => {
  it("refuses when the draft cannot start a replacement (no session)", async () => {
    const supabase = makeOrchestrationSupabase({ candidateRows: [], stampResult: { stamped: true, reason: "stamped" } });
    const result = await startFinalizedSessionReplacementDraft(
      supabase, makeFakeService(basePending()), null, 1000,
    );
    expect(result).toEqual({ status: "no_header" });
  });

  it("refuses (already_replacing) when the draft already targets a predecessor", async () => {
    const supabase = makeOrchestrationSupabase({ candidateRows: [], stampResult: { stamped: true, reason: "stamped" } });
    const pending = basePending({ replaces_produce_session_id: "predecessor-1" });
    const result = await startFinalizedSessionReplacementDraft(
      supabase, makeFakeService(pending), pending, 1000,
    );
    expect(result).toEqual({ status: "already_replacing" });
  });

  it("refuses (none) when no finalized session matches the open header", async () => {
    const supabase = makeOrchestrationSupabase({ candidateRows: [], stampResult: { stamped: true, reason: "stamped" } });
    const pending = basePending();
    const result = await startFinalizedSessionReplacementDraft(
      supabase, makeFakeService(pending), pending, 1000,
    );
    expect(result).toEqual({ status: "none" });
  });

  it("propagates a stamp refusal (predecessor already superseded) without appending anything", async () => {
    let appended = false;
    const supabase = makeOrchestrationSupabase({
      candidateRows: CANDIDATE_ROWS,
      stampResult: { stamped: false, reason: "target_not_replaceable" },
    });
    const service = {
      append: async () => {
        appended = true;
        return basePending();
      },
    } as unknown as PendingSessionService;

    const pending = basePending();
    const result = await startFinalizedSessionReplacementDraft(supabase, service, pending, 1000);
    expect(result).toEqual({ status: "stamp_refused", reason: "target_not_replaceable" });
    expect(appended).toBe(false);
  });

  it("on success: stamps then seeds the draft with the predecessor's effective items", async () => {
    const seededSession = basePending({ replaces_produce_session_id: "predecessor-1" });
    const supabase = makeOrchestrationSupabase({
      candidateRows: CANDIDATE_ROWS,
      stampResult: { stamped: true, reason: "stamped" },
    });
    const pending = basePending();
    const result = await startFinalizedSessionReplacementDraft(
      supabase, makeFakeService(seededSession), pending, 1000,
    );
    expect(result).toEqual({
      status: "started",
      session: seededSession,
      predecessorSessionId: "predecessor-1",
      itemCount: 1,
    });
  });
});
