import { describe, expect, it } from "bun:test";
import { tryFinalizeSettlement as tryFinalizeSettlementImpl } from "./settlement-finalizer";
import { buildFinalSettlementMessage } from "./line/settlement-message";

type FinalizeArgs = Parameters<typeof tryFinalizeSettlementImpl>;
function tryFinalizeSettlement(
  supabase: FinalizeArgs[0],
  sourceId: FinalizeArgs[1],
  businessDate: FinalizeArgs[2],
  push?: FinalizeArgs[3],
  accountabilityRoundId?: FinalizeArgs[4],
) {
  return tryFinalizeSettlementImpl(
    supabase,
    sourceId,
    businessDate,
    push,
    accountabilityRoundId,
    async () => "complete",
  );
}

// ── Stub helpers ──────────────────────────────────────────────────────────────

interface StubFin {
  existing?:       object | null;   // returned by SELECT (status/message_sent_at re-fetch)
  insertRow?:      object | null;   // INSERT result; null = duplicate key conflict
  claimRow?:       object | null;   // UPDATE WHERE status IN (pending,failed) result
  staleClaimRow?:  object | null;   // UPDATE stale sending reclaim result
  updateError?:    string | null;   // error for status UPDATE (sent/failed)
  upsertOptions?:  Array<{ onConflict?: string }>;
}

// Builds a chainable stub for settlement_finalizations.
// UPDATE calls are dispatched by call-order:
//   1st → claimRow (pending/failed claim)
//   2nd → staleClaimRow (stale sending reclaim)
//   3rd+ → status update (sent/failed), optionally errors
function makeFinStub(fin: StubFin) {
  let updateCalls = 0;

  // Generic chainable: all filter/select methods return self; terminates with
  // { data, error } on .maybeSingle()/.single() or direct await via .then().
  function makeChain(resolve: () => Promise<{ data: object | null; error: { message: string } | null }>): Record<string, unknown> {
    const c: Record<string, unknown> = {};
    const self = () => c;
    c["eq"]     = self;
    c["in"]     = self;
    c["is"]     = self;
    c["lte"]    = self;
    c["select"] = () => ({ maybeSingle: resolve, single: resolve });
    c["then"]   = (fn: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      resolve().then(fn, rej);
    return c;
  }

  return {
    select: (): unknown => {
      const s: Record<string, unknown> = {};
      s["eq"]          = () => s;
      s["maybeSingle"] = async () => ({ data: fin.existing ?? null, error: null });
      return s;
    },
    insert: () => ({
      select: () => ({
        maybeSingle: async () => ({
          data:  fin.insertRow ?? null,
          error: fin.insertRow ? null : { message: "duplicate key value violates unique constraint" },
        }),
      }),
    }),
    update: () => {
      updateCalls++;
      const n = updateCalls;
      return makeChain(async () => {
        if (n === 1) return { data: fin.claimRow ?? null, error: null };
        if (n === 2) return { data: fin.staleClaimRow ?? null, error: null };
        // 3rd+: status update (sent/failed)
        return { data: null, error: fin.updateError ? { message: fin.updateError } : null };
      });
    },
    upsert: (_row: unknown, options: { onConflict?: string }) => {
      fin.upsertOptions?.push(options);
      return Promise.resolve({ data: null, error: null });
    },
  };
}

interface DbCfg {
  fin?:              StubFin;
  entries?:          object[];
  sessions?:         { open: boolean };
  batches?:          { active: number };
  slipBatches?:      Array<{ status: string; summary_sent_at: string | null }>;
  unbatchedEvIds?:   string[];     // IDs for unbatched evidences
  processingChecks?: boolean;      // whether unbatched checks are PROCESSING
  incompleteSessions?: Array<{ id: string; raw_message_id: string }>;
  incompleteSessionSourceMatch?: boolean;
  failedClosedPendingSessions?: Array<{ close_event_timestamp_ms: number }>;
}

function makeDb(cfg: DbCfg = {}) {
  const finStub   = makeFinStub(cfg.fin ?? { insertRow: { id: "fin-1", line_retry_key: "rkey-1", status: "sending" } });
  const entries   = cfg.entries   ?? [readyEntry];
  const sess      = cfg.sessions  ?? { open: false };
  const batches   = cfg.batches   ?? { active: 0 };
  const unbEvIds  = cfg.unbatchedEvIds ?? [];
  const procChecks = cfg.processingChecks ?? false;

  return {
    from(table: string) {
      if (table === "settlement_finalizations") return finStub;

      if (table === "settlement_entries") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                data:  entries,
                error: null,
                then(resolve: (v: { data: object[]; error: null }) => void) {
                  return resolve({ data: entries, error: null });
                },
              }),
            }),
          }),
        };
      }

      if (table === "manual_slip_sessions") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: sess.open ? { id: "open-sess" } : null,
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        };
      }

      if (table === "slip_batches") {
        const rows = cfg.slipBatches ?? Array.from({ length: batches.active }, () => ({ status: "processing", summary_sent_at: null }));
        return {
          select: () => ({
            eq: () => ({
              in: (_col: string, statuses: string[]) => ({
                is: (_col2: string, value: null) => ({
                  gte: () => ({
                    lt: () => ({
                      limit: async () => ({
                        data: rows
                          .filter((r) => statuses.includes(r.status) && r.summary_sent_at === value)
                          .map((_, i) => ({ id: `b${i + 1}` })),
                        error: null,
                      }),
                    }),
                  }),
                }),
              }),
            }),
          }),
        };
      }

      if (table === "slip_evidences") {
        return {
          select: () => ({
            eq: () => ({
              gte: () => ({
                lt: () => ({
                  is: async () => ({
                    data: unbEvIds.map(id => ({ id })),
                    error: null,
                  }),
                }),
              }),
              // also handle .gte().lt() chain (for computeAiVerifiedTotal inside reconcile)
              lt: async () => ({ data: [], error: null }),
            }),
          }),
        };
      }

      if (table === "slip_checks") {
        return {
          select: () => ({
            in: () => ({
              eq: () => ({
                limit: async () => ({
                  data: procChecks ? [{ id: "chk-1" }] : [],
                  error: null,
                }),
              }),
              in: () => ({
                not: async () => ({ data: [], error: null }),
              }),
            }),
          }),
        };
      }

      if (table === "manual_slip_entries") {
        return { select: () => ({ in: async () => ({ data: [], error: null }) }) };
      }

      if (table === "transfer_reconciliations") {
        return {
          upsert: (row: unknown) => ({
            select: () => ({ single: async () => ({ data: row, error: null }) }),
          }),
        };
      }

      if (table === "produce_sessions") {
        return {
          select: () => ({
            eq: () => ({
              not: async () => ({
                data: cfg.incompleteSessions ?? [],
                error: null,
              }),
            }),
          }),
        };
      }

      if (table === "pending_sessions") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  not: async () => ({
                    data: cfg.failedClosedPendingSessions ?? [],
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        };
      }

      if (table === "raw_messages") {
        return {
          select: () => ({
            in: () => ({
              eq: async () => ({
                data: cfg.incompleteSessionSourceMatch ? [{ id: "raw-1" }] : [],
                error: null,
              }),
            }),
          }),
        };
      }

      if (table === "produce_transactions") {
        const chain = (): object => ({ eq: () => chain(), in: async () => ({ data: [], error: null }) });
        return { select: () => chain() };
      }

      throw new Error(`unexpected table in stub: ${table}`);
    },
  };
}

const readyEntry = {
  money_transfer: 1000,
  money_cash:     500,
  expenses:       50,
  labor:          100,
  staff_name:     "มีน",
  market_name:    "ตลาด",
  notes:          "",
};

const noopPush = async () => {};

// ── Readiness tests ───────────────────────────────────────────────────────────

describe("tryFinalizeSettlement — readiness", () => {
  it("returns not_ready when no settlement entry exists", async () => {
    const db = makeDb({ entries: [] });
    expect(await tryFinalizeSettlement(db as never, "grp1", "2026-06-17", noopPush)).toBe("not_ready");
  });

  it("returns not_ready when a manual slip session is open", async () => {
    const db = makeDb({ sessions: { open: true } });
    expect(await tryFinalizeSettlement(db as never, "grp1", "2026-06-17", noopPush)).toBe("not_ready");
  });

  it("returns not_ready and never sends รายการส่งเงิน ✅ when a produce session for this source/date has parser errors", async () => {
    const db = makeDb({
      incompleteSessions: [{ id: "sess-1", raw_message_id: "raw-1" }],
      incompleteSessionSourceMatch: true,
    });
    const pushed: string[] = [];
    const result = await tryFinalizeSettlement(db as never, "grp1", "2026-06-17", async (_to, text) => {
      pushed.push(text);
    });
    expect(result).toBe("not_ready");
    expect(pushed).toHaveLength(0);
  });

  // Reproduces the gap flagged in review: a session that fails closed
  // (try_finalize_pending_generation returning failed_closed) writes ZERO rows
  // to produce_sessions/produce_items, so the parser_errors check above can
  // never see it — only pending_sessions itself records the failed attempt.
  // Without a gate reading pending_sessions, settlement would silently ignore
  // the failed attempt and finalize off whatever data already existed.
  it("returns not_ready and never sends รายการส่งเงิน ✅ when a pending session for this source/date failed closed with zero produce writes", async () => {
    const closeTimestampMs = Date.parse("2026-06-17T12:00:00+07:00"); // Bangkok noon → business date 2026-06-17
    const db = makeDb({
      failedClosedPendingSessions: [{ close_event_timestamp_ms: closeTimestampMs }],
    });
    const pushed: string[] = [];
    const result = await tryFinalizeSettlement(db as never, "grp1", "2026-06-17", async (_to, text) => {
      pushed.push(text);
    });
    expect(result).toBe("not_ready");
    expect(pushed).toHaveLength(0);
  });

  it("returns not_ready when a slip batch is still active", async () => {
    const db = makeDb({ batches: { active: 1 } });
    expect(await tryFinalizeSettlement(db as never, "grp1", "2026-06-17", noopPush)).toBe("not_ready");
  });

  it("returns not_ready while a review_needed slip batch summary is still unsent (permanent LINE failure)", async () => {
    const db = makeDb({ slipBatches: [{ status: "review_needed", summary_sent_at: null }] });
    const pushed: string[] = [];
    const result = await tryFinalizeSettlement(db as never, "grp1", "2026-06-17", async (_to, text) => {
      pushed.push(text);
    });
    expect(result).toBe("not_ready");
    expect(pushed).toHaveLength(0);
  });

  it("finalizes when review_needed/completed/failed slip batches already sent their summary", async () => {
    const sentAt = "2026-06-17T05:00:00.000Z";
    const db = makeDb({
      slipBatches: [
        { status: "review_needed", summary_sent_at: sentAt },
        { status: "completed", summary_sent_at: sentAt },
        { status: "failed", summary_sent_at: sentAt },
      ],
    });
    expect(await tryFinalizeSettlement(db as never, "grp1", "2026-06-17", noopPush)).toBe("finalized");
  });

  it("returns not_ready when an unbatched slip_check is PROCESSING", async () => {
    const db = makeDb({ unbatchedEvIds: ["ev-1"], processingChecks: true });
    expect(await tryFinalizeSettlement(db as never, "grp1", "2026-06-17", noopPush)).toBe("not_ready");
  });

  it("proceeds when unbatched evidences exist but none are PROCESSING", async () => {
    const db = makeDb({ unbatchedEvIds: ["ev-1"], processingChecks: false });
    const pushed: string[] = [];
    const result = await tryFinalizeSettlement(db as never, "grp1", "2026-06-17", async () => { pushed.push("sent"); });
    expect(result).toBe("finalized");
    expect(pushed).toHaveLength(1);
  });

  it("returns ambiguous when multiple settlement entries exist", async () => {
    const db = makeDb({ entries: [readyEntry, readyEntry] });
    expect(await tryFinalizeSettlement(db as never, "grp1", "2026-06-17", noopPush)).toBe("ambiguous");
  });

  it("finalizes and pushes when all conditions are met", async () => {
    const pushed: Array<{ to: string; text: string; key: string }> = [];
    const result = await tryFinalizeSettlement(makeDb() as never, "grp1", "2026-06-17", async (to, text, key) => {
      pushed.push({ to, text, key: key ?? "" });
    });
    expect(result).toBe("finalized");
    expect(pushed).toHaveLength(1);
    expect(pushed[0].to).toBe("grp1");
    expect(pushed[0].text).toContain("ยืนยันแล้ว");
    expect(pushed[0].text).toContain("ตรวจสลิปโอน");
  });
});

// ── Idempotency / retry-safety ────────────────────────────────────────────────

describe("tryFinalizeSettlement — idempotency", () => {
  it("returns already_done when existing row has message_sent_at set", async () => {
    const db = makeDb({
      fin: {
        existing:  { status: "sent", message_sent_at: "2026-06-17T10:00:00Z" },
        insertRow: null,
        claimRow:  null,
      },
    });
    const pushed: string[] = [];
    expect(await tryFinalizeSettlement(db as never, "grp1", "2026-06-17", async () => { pushed.push("X"); })).toBe("already_done");
    expect(pushed).toHaveLength(0);
  });

  it("retries when existing row has message_sent_at null (failed row)", async () => {
    // INSERT conflicts, pending/failed claim succeeds → retries, sends
    const db = makeDb({
      fin: {
        insertRow: null,
        claimRow:  { id: "fin-2", line_retry_key: "rkey-2", status: "sending" },
      },
    });
    const pushed: string[] = [];
    expect(await tryFinalizeSettlement(db as never, "grp1", "2026-06-17", async () => { pushed.push("X"); })).toBe("finalized");
    expect(pushed).toHaveLength(1);
  });

  it("reclaims stale sending row and retries with existing line_retry_key", async () => {
    // INSERT conflicts, pending/failed claim returns null (row is sending, not pending/failed)
    // stale reclaim succeeds → uses the SAME line_retry_key from the row
    const db = makeDb({
      fin: {
        insertRow:     null,
        claimRow:      null,
        staleClaimRow: { id: "fin-stale", line_retry_key: "stale-key-xyz", status: "sending" },
      },
    });
    const capturedKeys: string[] = [];
    const result = await tryFinalizeSettlement(db as never, "grp1", "2026-06-17", async (_to, _text, key) => {
      capturedKeys.push(key ?? "no-key");
    });
    expect(result).toBe("finalized");
    expect(capturedKeys).toHaveLength(1);
    expect(capturedKeys[0]).toBe("stale-key-xyz");
  });

  it("returns not_ready when sending row is not yet stale (concurrent worker)", async () => {
    // INSERT conflicts, pending/failed claim → null, stale reclaim → null
    // re-fetch shows status=sending (not yet stale)
    const db = makeDb({
      fin: {
        existing:      { status: "sending", message_sent_at: null },
        insertRow:     null,
        claimRow:      null,
        staleClaimRow: null,
      },
    });
    expect(await tryFinalizeSettlement(db as never, "grp1", "2026-06-17", noopPush)).toBe("not_ready");
  });

  it("uses stable line_retry_key from INSERT row", async () => {
    const db = makeDb({
      fin: { insertRow: { id: "fin-3", line_retry_key: "stable-uuid-abc", status: "sending" } },
    });
    let capturedKey = "";
    await tryFinalizeSettlement(db as never, "grp1", "2026-06-17", async (_to, _text, key) => { capturedKey = key ?? ""; });
    expect(capturedKey).toBe("stable-uuid-abc");
  });

  it("returns failed and allows retry when LINE push throws", async () => {
    const result = await tryFinalizeSettlement(makeDb() as never, "grp1", "2026-06-17", async () => {
      throw new Error("LINE push network error");
    });
    expect(result).toBe("failed");
  });

  it("returns finalized when LINE returns already_accepted (409 dedup)", async () => {
    const result = await tryFinalizeSettlement(makeDb() as never, "grp1", "2026-06-17", async () => ({ status: "already_accepted" }));
    expect(result).toBe("finalized");
  });
});

// ── DB update failure after LINE success ──────────────────────────────────────

describe("tryFinalizeSettlement — DB update failure recovery", () => {
  it("returns finalized but logs error when sent-status DB update fails", async () => {
    const db = makeDb({
      fin: {
        insertRow:   { id: "fin-4", line_retry_key: "rkey-4", status: "sending" },
        updateError: "connection lost",  // 3rd UPDATE (status=sent) fails
      },
    });
    // Should still return finalized — LINE accepted the message
    const result = await tryFinalizeSettlement(db as never, "grp1", "2026-06-17", noopPush);
    expect(result).toBe("finalized");
  });

  it("stale reclaim after DB-update failure uses same retry key and marks sent", async () => {
    // Simulates: row stuck in sending because first run's DB update failed.
    // A later trigger sees a stale sending row → reclaims → LINE returns 409 → marks sent.
    const db = makeDb({
      fin: {
        insertRow:     null,
        claimRow:      null,
        staleClaimRow: { id: "fin-s", line_retry_key: "stable-rkey", status: "sending" },
      },
    });
    let capturedKey = "";
    const result = await tryFinalizeSettlement(db as never, "grp1", "2026-06-17", async (_to, _text, key) => {
      capturedKey = key ?? "";
      return { status: "already_accepted" };
    });
    expect(result).toBe("finalized");
    expect(capturedKey).toBe("stable-rkey");
  });
});

// ── Ambiguous protection ───────────────────────────────────────────────────────

describe("tryFinalizeSettlement — ambiguous protection", () => {
  it("already sent + multiple settlement entries => already_done, no LINE", async () => {
    const db = makeDb({
      fin: {
        existing: { status: "sent", message_sent_at: "2026-06-17T10:00:00Z" },
      },
      entries: [readyEntry, readyEntry],
    });
    const pushed: string[] = [];
    expect(await tryFinalizeSettlement(db as never, "grp1", "2026-06-17", async () => { pushed.push("X"); })).toBe("already_done");
    expect(pushed).toHaveLength(0);
  });

  it("no prior row + multiple entries => ambiguous, no LINE", async () => {
    const upsertOptions: Array<{ onConflict?: string }> = [];
    const db = makeDb({ fin: { existing: null, upsertOptions }, entries: [readyEntry, readyEntry] });
    const pushed: string[] = [];
    expect(await tryFinalizeSettlement(db as never, "grp1", "2026-06-17", async () => { pushed.push("X"); })).toBe("ambiguous");
    expect(upsertOptions).toEqual([{ onConflict: "source_id,business_date,accountability_round_id" }]);
    expect(pushed).toHaveLength(0);
  });
});

// ── Legacy guard ──────────────────────────────────────────────────────────────

describe("tryFinalizeSettlement — legacy guard", () => {
  it("returns not_ready when called with empty source_id (route never calls it without source_id)", async () => {
    const db = makeDb({ entries: [] });
    expect(await tryFinalizeSettlement(db as never, "", "2026-06-17", noopPush)).toBe("not_ready");
  });
});

// ── Message content ───────────────────────────────────────────────────────────

describe("buildFinalSettlementMessage — content", () => {
  const baseInput = {
    date:       "2026-06-17",
    staffName:  "มีน",
    marketName: "วัดทุ่ง",
    transactions: { เบิก: 10000, คืน: 1000, คืนเสีย: 500, ยอดส่ง: 8500 },
    produceValueStatus: "complete" as const,
    producePresence: { เบิก: true, คืน: true, คืนเสีย: true },
    settlement: {
      ยอดโอน:           3000,
      เงินสด:           4000,
      ค่าใช้จ่าย:       200,
      ค่าแรง:           500,
      ยอดขาย:           7700,
      ขาดเกิน:          -800,
      เงินสดต้องส่งเจ๊:  4800,
    },
    reconciliation: {
      ai_verified_total:        2800,
      manual_slip_total:         200,
      checked_slip_total:       3000,
      submitted_transfer_total: 3000,
      difference:                  0,
      matched:                  true,
    },
    notes: "ทดสอบ",
  };

  it("includes all required sales and reconciliation fields", () => {
    const msg = buildFinalSettlementMessage(baseInput);
    expect(msg).toContain("รายการส่งเงิน ✅ (ยืนยันแล้ว)");
    expect(msg).toContain("มีน — วัดทุ่ง");
    expect(msg).toContain("ยอดขายสุทธิที่คำนวณได้: 8,500.00 บาท");
    expect(msg).toContain("ยอดเบิก: 10,000.00 บาท");
    expect(msg).toContain("ยอดชั่งคืน: 1,000.00 บาท");
    expect(msg).toContain("ยอดคืนเสีย: 500.00 บาท");
    expect(msg).not.toContain("ยังไม่ยืนยัน");
    expect(msg).toContain("เงินโอน: 3,000.00 บาท");
    expect(msg).toContain("เงินสด: 4,000.00 บาท");
    expect(msg).toContain("ค่าใช้จ่าย: 200.00 บาท");
    expect(msg).toContain("ค่าแรง: 500.00 บาท");
    expect(msg).toContain("ยอดขายจากรายการส่งเงิน: 7,700.00 บาท");
    expect(msg).toContain("ผลตรวจ: ขาด 800.00 บาท");
    expect(msg).toContain("เงินสดที่ควรเหลือส่งเจ๊: 4,800.00 บาท");
    expect(msg).toContain("— ตรวจสลิปโอน —");
    expect(msg).toContain("ยอดสลิป AI: 2,800.00 บาท");
    expect(msg).toContain("ยอดสลิปมือ: 200.00 บาท");
    expect(msg).toContain("ยอดสลิปรวม: 3,000.00 บาท");
    expect(msg).toContain("ยอดโอนที่แจ้ง: 3,000.00 บาท");
    expect(msg).toContain("ผลตรวจสลิป: ตรงกัน");
    expect(msg).toContain("หมายเหตุ: ทดสอบ");
  });

  it("shows transfer underage (slips < submitted)", () => {
    const msg = buildFinalSettlementMessage({
      ...baseInput,
      reconciliation: { ...baseInput.reconciliation, difference: -100, matched: false },
    });
    expect(msg).toContain("ผลตรวจสลิป: ขาด 100.00 บาท");
  });

  it("shows transfer overage (slips > submitted)", () => {
    const msg = buildFinalSettlementMessage({
      ...baseInput,
      reconciliation: { ...baseInput.reconciliation, difference: 50, matched: false },
    });
    expect(msg).toContain("ผลตรวจสลิป: เกิน 50.00 บาท");
  });

  it("AI-only totals", () => {
    const msg = buildFinalSettlementMessage({
      ...baseInput,
      reconciliation: { ai_verified_total: 1000, manual_slip_total: 0, checked_slip_total: 1000, submitted_transfer_total: 1000, difference: 0, matched: true },
    });
    expect(msg).toContain("ยอดสลิป AI: 1,000.00 บาท");
    expect(msg).toContain("ยอดสลิปมือ: 0.00 บาท");
    expect(msg).toContain("ผลตรวจสลิป: ตรงกัน");
  });

  it("manual-only totals", () => {
    const msg = buildFinalSettlementMessage({
      ...baseInput,
      reconciliation: { ai_verified_total: 0, manual_slip_total: 500, checked_slip_total: 500, submitted_transfer_total: 500, difference: 0, matched: true },
    });
    expect(msg).toContain("ยอดสลิป AI: 0.00 บาท");
    expect(msg).toContain("ยอดสลิปมือ: 500.00 บาท");
    expect(msg).toContain("ผลตรวจสลิป: ตรงกัน");
  });

  it("mixed AI + manual totals", () => {
    const msg = buildFinalSettlementMessage({
      ...baseInput,
      reconciliation: { ai_verified_total: 400, manual_slip_total: 300, checked_slip_total: 700, submitted_transfer_total: 700, difference: 0, matched: true },
    });
    expect(msg).toContain("ยอดสลิป AI: 400.00 บาท");
    expect(msg).toContain("ยอดสลิปมือ: 300.00 บาท");
    expect(msg).toContain("ยอดสลิปรวม: 700.00 บาท");
    expect(msg).toContain("ผลตรวจสลิป: ตรงกัน");
  });
});
