import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, SlipCheckStatus } from "@/types/database";
import {
  applyGlobalDuplicateExclusions,
  buildBatchSummaryMessage,
  finalizeSlipBatch,
  type EvidenceWithCheck,
} from "./batch-finalizer";
import { VERIFIED_SLIP_CHECK_STATUSES } from "./transaction-dedupe";

interface CheckRow {
  id: string;
  evidence_id: string;
  status: SlipCheckStatus;
  slip_type: "BANK_SLIP_QR";
  gross_amount: number | null;
  discount_amount: number | null;
  transfer_amount: number | null;
  paid_amount: number | null;
  transaction_time: string | null;
  reference_id: string | null;
  failure_reason: string | null;
}

interface GlobalRow {
  id: string;
  reference_id: string;
  created_at: string;
}

function evidence(
  overrides: Partial<EvidenceWithCheck> = {},
): EvidenceWithCheck {
  return {
    id: "evidence-current",
    checkId: "check-current",
    batchIndex: 1,
    checkStatus: "EXTRACTED",
    slipType: "BANK_SLIP_QR",
    transferAmount: 500,
    paidAmount: null,
    transactionTime: null,
    referenceId: "REF-001",
    failureReason: null,
    ...overrides,
  };
}

function check(
  id: string,
  status: SlipCheckStatus,
  referenceId: string,
  transferAmount: number | null,
): CheckRow {
  return {
    id,
    evidence_id: `evidence-${id}`,
    status,
    slip_type: "BANK_SLIP_QR",
    gross_amount: null,
    discount_amount: null,
    transfer_amount: transferAmount,
    paid_amount: null,
    transaction_time: null,
    reference_id: referenceId,
    failure_reason: status === "NEED_REVIEW" ? "missing_transfer_amount" : null,
  };
}

function globalRow(id: string, referenceId: string, createdAt: string): GlobalRow {
  return {
    id,
    reference_id: referenceId,
    created_at: createdAt,
  };
}

function makeFinalizationDatabase(
  checks: readonly CheckRow[],
  globalRows: readonly GlobalRow[],
) {
  const referenceQueries: string[][] = [];
  const statusQueries: string[][] = [];
  const statusUpdates: Array<Record<string, unknown>> = [];
  const evidenceRows = checks.map((row, index) => ({
    id: row.evidence_id,
    batch_index: index + 1,
  }));

  const database = {
    from(table: string) {
      if (table === "slip_batches") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: "batch-1",
                  source_id: "source-1",
                  summary_sent_at: null,
                  slip_date: null,
                  closing_at: null,
                  last_image_at: null,
                  seller_name: null,
                  market_name: null,
                },
                error: null,
              }),
            }),
          }),
          update: (values: Record<string, unknown>) => {
            statusUpdates.push(values);
            return {
              eq: async () => ({ data: null, error: null }),
            };
          },
        };
      }

      if (table === "slip_evidences") {
        return {
          select: () => ({
            eq: () => ({
              order: async () => ({ data: evidenceRows, error: null }),
            }),
          }),
        };
      }

      if (table === "slip_checks") {
        return {
          select: (columns: string) => {
            if (columns.includes("evidence_id")) {
              return {
                in: async (_column: string, evidenceIds: string[]) => ({
                  data: checks.filter((row) => evidenceIds.includes(row.evidence_id)),
                  error: null,
                }),
              };
            }

            let requestedReferences: string[] = [];
            const builder = {
              in(column: string, values: readonly string[]) {
                if (column === "reference_id") {
                  requestedReferences = [...values];
                  referenceQueries.push([...values]);
                }
                if (column === "status") statusQueries.push([...values]);
                return builder;
              },
              order() {
                return builder;
              },
              then(resolve: (value: unknown) => void) {
                resolve({
                  data: globalRows.filter((row) =>
                    requestedReferences.includes(row.reference_id)),
                  error: null,
                });
              },
            };
            return builder;
          },
        };
      }

      throw new Error(`unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient<Database>;

  return { database, referenceQueries, statusQueries, statusUpdates };
}

function finalStatusUpdate(updates: Array<Record<string, unknown>>) {
  return updates.find((update) => "success_count" in update);
}

describe("batch finalizer global slip dedupe", () => {
  test("finalizes EXTRACTED plus NEED_REVIEW while resolving only the verified check", async () => {
    const extracted = check("check-extracted", "EXTRACTED", "REF-EXTRACTED", 500);
    const needsReview = check("check-review", "NEED_REVIEW", "REF-REVIEW", null);
    const { database, referenceQueries, statusQueries, statusUpdates } =
      makeFinalizationDatabase(
        [extracted, needsReview],
        [globalRow(extracted.id, extracted.reference_id!, "2026-07-23T00:00:00Z")],
      );
    const messages: string[] = [];

    const result = await finalizeSlipBatch(
      database,
      "batch-1",
      async (message) => { messages.push(message); },
    );

    expect(result).toEqual({ delivered: true, persisted: true });
    expect(referenceQueries).toEqual([["REF-EXTRACTED"]]);
    expect(statusQueries).toEqual([[...VERIFIED_SLIP_CHECK_STATUSES]]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("รอตรวจมือ: 1 รูป");
    expect(messages[0]).toContain("#2 ไม่พบข้อมูลครบถ้วน");
    expect(finalStatusUpdate(statusUpdates)).toMatchObject({
      status: "review_needed",
      success_count: 1,
      failed_count: 1,
    });
  });

  test("excludes a terminal duplicate without letting NEED_REVIEW wedge finalization", async () => {
    const original = check("check-original", "EXTRACTED", "REF-DUP", 500);
    const duplicate = check("check-duplicate", "PARTIAL_EXTRACTED", "REF-DUP", 500);
    const needsReview = check("check-review", "NEED_REVIEW", "REF-REVIEW", null);
    const { database, referenceQueries, statusUpdates } = makeFinalizationDatabase(
      [original, duplicate, needsReview],
      [
        globalRow(original.id, original.reference_id!, "2026-07-23T00:00:00Z"),
        globalRow(duplicate.id, duplicate.reference_id!, "2026-07-23T00:01:00Z"),
      ],
    );
    const messages: string[] = [];

    const result = await finalizeSlipBatch(
      database,
      "batch-1",
      async (message) => { messages.push(message); },
    );

    expect(result).toEqual({ delivered: true, persisted: true });
    expect(referenceQueries).toEqual([["REF-DUP"]]);
    expect(messages[0]).toContain("#1 เช็คได้ 500 บาท");
    expect(messages[0]).toContain("#2 สลิปซ้ำ");
    expect(messages[0]).toContain("#3 ไม่พบข้อมูลครบถ้วน");
    expect(finalStatusUpdate(statusUpdates)).toMatchObject({
      status: "review_needed",
      success_count: 1,
      failed_count: 2,
    });
  });

  test("finalizes an all-non-terminal batch without invoking the global resolver", async () => {
    const checks = [
      check("check-review", "NEED_REVIEW", "REF-REVIEW", null),
      check("check-processing", "PROCESSING", "REF-PROCESSING", null),
      check("check-failed", "FAILED", "REF-FAILED", null),
    ];
    const { database, referenceQueries, statusQueries, statusUpdates } =
      makeFinalizationDatabase(checks, []);
    const messages: string[] = [];

    const result = await finalizeSlipBatch(
      database,
      "batch-1",
      async (message) => { messages.push(message); },
    );

    expect(result).toEqual({ delivered: true, persisted: true });
    expect(referenceQueries).toEqual([]);
    expect(statusQueries).toEqual([]);
    expect(messages).toHaveLength(1);
    expect(finalStatusUpdate(statusUpdates)).toMatchObject({
      status: "failed",
      success_count: 0,
      failed_count: 3,
    });
  });

  test("keeps EXTRACTED and PARTIAL_EXTRACTED original/duplicate behavior unchanged", async () => {
    const db = {
      from(table: string) {
        if (table !== "slip_checks") throw new Error(`unexpected table: ${table}`);
        const builder = {
          select: () => builder,
          in: () => builder,
          order: () => builder,
          then: (resolve: (value: unknown) => void) => resolve({
            data: [
              globalRow("check-original", "REF-001", "2026-07-23T00:00:00Z"),
              globalRow("check-current", "REF-001", "2026-07-23T00:01:00Z"),
            ],
            error: null,
          }),
        };
        return {
          select: builder.select,
        };
      },
    };

    const marked = await applyGlobalDuplicateExclusions(
      db as never,
      [
        evidence({ id: "original", checkId: "check-original", batchIndex: 1 }),
        evidence({
          id: "duplicate",
          checkId: "check-current",
          batchIndex: 2,
          checkStatus: "PARTIAL_EXTRACTED",
        }),
        evidence({
          id: "missing-reference",
          checkId: "check-no-reference",
          batchIndex: 3,
          referenceId: null,
          transferAmount: 100,
        }),
      ],
    );

    expect(marked[0].globallyDuplicate).toBe(false);
    expect(marked[1].globallyDuplicate).toBe(true);
    expect(marked[2].globallyDuplicate).toBe(false);

    const message = buildBatchSummaryMessage(marked);
    expect(message).toContain("อ่านครบ: 1 รูป");
    expect(message).toContain("รอตรวจมือ: 2 รูป");
    expect(message).toMatch(/500(?:[,.]0+)? บาท/);
    expect(message).toContain("ไม่พบรหัสอ้างอิง");
    expect(message).toContain("สลิปซ้ำ");
    expect(message).not.toContain("REF-001");
  });
});
