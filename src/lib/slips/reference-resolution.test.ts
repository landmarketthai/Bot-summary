import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { aggregateGloballyAcceptedVerifiedTransfers } from "@/lib/reconciliation";
import { resolveGloballyAcceptedCheckIds } from "./transaction-dedupe";
import { ReferenceResolutionError, resolveSlipCheckReference } from "./reference-resolution";

interface FakeCheck {
  id: string;
  status: string;
  reference_id: string | null;
  failure_reason?: string | null;
  slip_type?: string;
  transaction_time?: string | null;
  transfer_amount?: number | null;
  paid_amount?: number | null;
  gross_amount?: number | null;
}

function makeFakeSupabase(checks: FakeCheck[]) {
  const auditRows: Array<{ check_id: string; reference_id: string; actor: string }> = [];

  const database = {
    from(table: string) {
      if (table === "slip_checks") {
        return {
          select: () => ({
            eq: (column: string, value: string) => ({
              maybeSingle: async () => ({
                data: checks.find((c) => (c as unknown as Record<string, unknown>)[column] === value) ?? null,
                error: null,
              }),
            }),
          }),
          update: (values: Partial<FakeCheck>) => {
            const filters: Array<{ column: string; value: unknown }> = [];
            const builder = {
              eq: (column: string, value: unknown) => {
                filters.push({ column, value });
                return builder;
              },
              is: (column: string, value: unknown) => {
                filters.push({ column, value });
                return builder;
              },
              select: () => ({
                maybeSingle: async () => {
                  const found = checks.find((c) =>
                    filters.every((f) => (c as unknown as Record<string, unknown>)[f.column] === f.value));
                  if (!found) return { data: null, error: null };
                  Object.assign(found, values);
                  return { data: { id: found.id, status: found.status, failure_reason: found.failure_reason ?? null }, error: null };
                },
              }),
            };
            return builder;
          },
        };
      }
      if (table === "slip_check_reference_resolutions") {
        return {
          insert: (values: { check_id: string; reference_id: string; actor: string }) => {
            auditRows.push(values);
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
  return { database: database as unknown as SupabaseClient<Database>, auditRows };
}

describe("resolveSlipCheckReference (BR-02 manual resolution)", () => {
  it("sets the reference id on a genuinely pending check and records an audit row", async () => {
    const { database, auditRows } = makeFakeSupabase([
      { id: "chk-1", status: "EXTRACTED", reference_id: null },
    ]);

    const result = await resolveSlipCheckReference(database, {
      checkId: "chk-1",
      referenceId: "REF-MANUAL",
      actor: "admin-1",
    });

    expect(result.referenceId).toBe("REF-MANUAL");
    expect(auditRows.map(({ check_id, reference_id, actor }) => ({ check_id, reference_id, actor }))).toEqual([
      { check_id: "chk-1", reference_id: "REF-MANUAL", actor: "admin-1" },
    ]);
  });

  it("allows admin to resolve a held missing-reference slip with enough evidence", async () => {
    const { database, auditRows } = makeFakeSupabase([
      { id: "held-1", status: "NEED_REVIEW", reference_id: null,
        failure_reason: "missing_transaction_reference_global", slip_type: "THAI_HELP_THAI",
        transaction_time: "2026-10-19T09:00:00Z", gross_amount: 100, paid_amount: 40 },
    ]);
    const r = await resolveSlipCheckReference(database, {
      checkId: "held-1", referenceId: "MANUAL-REF", actor: "admin-1",
    });
    expect(r.status).toBe("PARTIAL_EXTRACTED");
    expect(r.reviewReason).toBeNull();
    expect(auditRows).toHaveLength(1);
  });

  it("does not let admin resolve a held slip without transaction timestamp", async () => {
    const { database } = makeFakeSupabase([
      { id: "held-1", status: "NEED_REVIEW", reference_id: null,
        failure_reason: "missing_transaction_reference_global", slip_type: "THAI_HELP_THAI",
        transaction_time: null, gross_amount: 100 },
    ]);
    await expect(resolveSlipCheckReference(database, {
      checkId: "held-1", referenceId: "MANUAL-REF", actor: "admin-1",
    })).rejects.toBeInstanceOf(ReferenceResolutionError);
  });

  it("rejects a check that is not in a verified status", async () => {
    const { database } = makeFakeSupabase([
      { id: "chk-1", status: "PROCESSING", reference_id: null },
    ]);
    await expect(
      resolveSlipCheckReference(database, { checkId: "chk-1", referenceId: "REF-X", actor: "admin-1" }),
    ).rejects.toBeInstanceOf(ReferenceResolutionError);
  });

  it("rejects a check that already has a reference id", async () => {
    const { database } = makeFakeSupabase([
      { id: "chk-1", status: "EXTRACTED", reference_id: "REF-EXISTING" },
    ]);
    await expect(
      resolveSlipCheckReference(database, { checkId: "chk-1", referenceId: "REF-NEW", actor: "admin-1" }),
    ).rejects.toBeInstanceOf(ReferenceResolutionError);
  });

  it("rejects an empty supplied reference id", async () => {
    const { database } = makeFakeSupabase([
      { id: "chk-1", status: "EXTRACTED", reference_id: null },
    ]);
    await expect(
      resolveSlipCheckReference(database, { checkId: "chk-1", referenceId: "   ", actor: "admin-1" }),
    ).rejects.toBeInstanceOf(ReferenceResolutionError);
  });

  it("rejects a missing check id", async () => {
    const { database } = makeFakeSupabase([]);
    await expect(
      resolveSlipCheckReference(database, { checkId: "missing", referenceId: "REF-X", actor: "admin-1" }),
    ).rejects.toBeInstanceOf(ReferenceResolutionError);
  });
});

/**
 * Phase 7 scenarios A-F: proves manual resolution feeds the SAME global
 * dedupe logic (resolveGloballyAcceptedCheckIds / aggregateGloballyAccepted-
 * VerifiedTransfers) as an AI-extracted reference — no second, weaker
 * duplicate algorithm exists for manually supplied references.
 */
describe("BR-02 scenarios: manual resolution cannot make duplicate money count twice", () => {
  function makeGlobalWinnerSupabase(rows: Array<{ id: string; reference_id: string; created_at: string }>) {
    return {
      from(table: string) {
        if (table !== "slip_checks") throw new Error(`unexpected table: ${table}`);
        return {
          select: () => ({
            in: () => ({
              in: () => ({
                order: () => ({
                  order: async () => ({ data: rows, error: null }),
                }),
              }),
            }),
          }),
        };
      },
    } as unknown as SupabaseClient<Database>;
  }

  it("A: an original unique reference counts", async () => {
    const db = makeGlobalWinnerSupabase([
      { id: "c-a", reference_id: "REF-A", created_at: "2026-07-24T01:00:00Z" },
    ]);
    const winners = await resolveGloballyAcceptedCheckIds(db, ["REF-A"]);
    const result = aggregateGloballyAcceptedVerifiedTransfers(
      [{ id: "c-a", evidence_id: "ev-a", transfer_amount: 100, reference_id: "REF-A", created_at: "2026-07-24T01:00:00Z" }],
      new Map(),
      winners,
    );
    expect(result.attributedTotal).toBe(100);
  });

  it("B: a duplicate reference within the same group counts only once", async () => {
    const db = makeGlobalWinnerSupabase([
      { id: "c-first", reference_id: "REF-B", created_at: "2026-07-24T01:00:00Z" },
    ]);
    const winners = await resolveGloballyAcceptedCheckIds(db, ["REF-B"]);
    const result = aggregateGloballyAcceptedVerifiedTransfers(
      [
        { id: "c-first", evidence_id: "ev-a", transfer_amount: 100, reference_id: "REF-B", created_at: "2026-07-24T01:00:00Z" },
        { id: "c-second", evidence_id: "ev-a", transfer_amount: 100, reference_id: "REF-B", created_at: "2026-07-24T02:00:00Z" },
      ],
      new Map(),
      winners,
    );
    expect(result.attributedTotal).toBe(100);
  });

  it("C/D: a duplicate reference resolved for another group/market is excluded here", async () => {
    // The globally-earliest winner belongs to a check this scope never even
    // loaded (cross-group/cross-market) — resolveGloballyAcceptedCheckIds
    // still reports it as the sole winner id.
    const db = makeGlobalWinnerSupabase([
      { id: "c-other-group", reference_id: "REF-CD", created_at: "2026-07-24T00:00:00Z" },
    ]);
    const winners = await resolveGloballyAcceptedCheckIds(db, ["REF-CD"]);
    const result = aggregateGloballyAcceptedVerifiedTransfers(
      [{ id: "c-local", evidence_id: "ev-a", transfer_amount: 100, reference_id: "REF-CD", created_at: "2026-07-24T01:00:00Z" }],
      new Map(),
      winners,
    );
    expect(result.attributedTotal).toBe(0);
  });

  it("E: an unresolved (no-reference) check is pending and never auto-counted", () => {
    const result = aggregateGloballyAcceptedVerifiedTransfers(
      [{ id: "c-pending", evidence_id: "ev-a", transfer_amount: 100, reference_id: null, created_at: "2026-07-24T01:00:00Z" }],
      new Map(),
      new Set<string>(),
    );
    expect(result.attributedTotal).toBe(0);
    expect(result.pendingReferenceCount).toBe(1);
  });

  it("F: a manually supplied reference that duplicates an existing accepted check does not count twice", async () => {
    // The reviewer resolves c-pending with REF-F, but REF-F was already
    // accepted earlier on c-earlier — the SAME global dedupe run at load
    // time (not the resolution endpoint) must still pick c-earlier as the
    // sole winner.
    const db = makeGlobalWinnerSupabase([
      { id: "c-earlier", reference_id: "REF-F", created_at: "2026-07-24T00:00:00Z" },
    ]);
    const winners = await resolveGloballyAcceptedCheckIds(db, ["REF-F"]);
    const result = aggregateGloballyAcceptedVerifiedTransfers(
      [
        { id: "c-earlier", evidence_id: "ev-a", transfer_amount: 100, reference_id: "REF-F", created_at: "2026-07-24T00:00:00Z" },
        // c-pending's reference_id is now REF-F after manual resolution.
        { id: "c-pending", evidence_id: "ev-b", transfer_amount: 100, reference_id: "REF-F", created_at: "2026-07-24T01:00:00Z" },
      ],
      new Map(),
      winners,
    );
    // Only the earlier check's amount counts once — not 200.
    expect(result.attributedTotal).toBe(100);
  });
});
