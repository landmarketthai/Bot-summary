/**
 * Regressions for the independent review of PR #191, P2 findings that do not
 * need PostgreSQL (P2-1/P2-2 SQL cases live in job-store.contract.test.ts).
 */
import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { canonicalMarketLabel } from "@/lib/market";
import { FakeDatabase } from "@/lib/summary/test-fake-supabase";
import { getSlipStatusTool, getStaffSettlementTool, getWhiteSheetStatusTool } from "@/lib/ai/readonly-tools";
import { boundedJobFetch } from "./bounded-fetch";
import { MemoryAssistantJobStore } from "./testing/memory-job-store";
import { RecordingLineDelivery } from "./testing/recording-line";
import { runAssistantWorker } from "./worker";

const DATE = "2026-10-31";
const PASEO = canonicalMarketLabel("พาซิโอ้ผัก");
const RATCHA = canonicalMarketLabel("ราชพฤกษ์");

function client(db: FakeDatabase): SupabaseClient<Database> {
  return db as unknown as SupabaseClient<Database>;
}

/** A response whose headers arrive at once but whose body never finishes. */
function stalledBodyFetch() {
  let open = 0;
  let peak = 0;
  const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) => {
    open += 1;
    peak = Math.max(peak, open);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("[{"));
        init?.signal?.addEventListener("abort", () => {
          open -= 1;
          controller.error(new DOMException("aborted", "AbortError"));
        }, { once: true });
      },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  }) as typeof fetch;
  return { fetchImpl, peak: () => peak, open: () => open };
}

describe("P2-3: bounded I/O covers the response body, not just the headers", () => {
  test("a body that never finishes is cut at the job deadline", async () => {
    const io = stalledBodyFetch();
    const bounded = boundedJobFetch({ deadlineMs: Date.now() + 150, callTimeoutMs: 5_000, maxOutstanding: 2, fetchImpl: io.fetchImpl });
    const started = Date.now();
    await expect((async () => (await bounded("https://db/a")).text())()).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(io.open()).toBe(0);
  });

  test("an unread body still holds its I/O slot", async () => {
    const io = stalledBodyFetch();
    const bounded = boundedJobFetch({ deadlineMs: Date.now() + 200, callTimeoutMs: 5_000, maxOutstanding: 1, fetchImpl: io.fetchImpl });
    const first = bounded("https://db/1").then((response) => response.text()).catch(() => "aborted");
    const second = bounded("https://db/2").then((response) => response.text()).catch(() => "aborted");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(io.peak()).toBe(1);
    await Promise.all([first, second]);
    expect(io.peak()).toBe(1);
  });
});

describe("P2-4: no automatic push retry after the 24-hour retry-key window", () => {
  test("an ambiguous push older than the window is recorded uncertain, never re-pushed", async () => {
    const store = new MemoryAssistantJobStore();
    const line = new RecordingLineDelivery();
    const { jobId } = await store.enqueue({
      lineEventId: "evt-24h", rawMessageId: null, destination: "Ubot", sourceType: "group", sourceId: "Cgroup",
      lineUserId: "Uboss", question: "q", askedBusinessDate: DATE, eventTimestampMs: 1, replyToken: null, replyTokenExpiresAt: null,
    });
    // A previous attempt recorded the answer and started a push whose outcome is unknown, 25 h ago.
    const job = store.jobs.get(jobId!)!;
    Object.assign(job, {
      answer_text: "ยอดขาย", answer_kind: "notice", delivery_state: "push_started", delivery_channel: "push",
      push_started_at: new Date(Date.now() - 25 * 3_600_000).toISOString(),
    });
    await runAssistantWorker({
      store, answer: async () => ({ text: "x" }), delivery: line, pushFallbackEnabled: true, workerId: "w",
      budgetMs: 10_000, deliveryReserveMs: 2_000, temporaryErrorText: "t", revalidate: async () => "current",
    });
    expect(line.attempts).toHaveLength(0);
    expect(store.jobs.get(jobId!)).toMatchObject({ delivery_state: "uncertain", status: "completed" });
  });
});

describe("P2-5: slip and white-sheet filters apply before the row limit", () => {
  test("the asked seller's batch is found even behind many other sellers' batches", async () => {
    const others = Array.from({ length: 60 }, (_, i) => ({
      id: `o${i}`, seller_name: "ดำ", market_name: "ราชพฤกษ์", slip_date: DATE, status: "completed",
      image_count: 1, success_count: 1, failed_count: 0, first_image_at: "2026-10-31T03:00:00Z",
    }));
    const db = new FakeDatabase()
      .seed("slip_batches", [...others, {
        id: "target", seller_name: "เล็ก", market_name: "พาซิโอ้ผัก", slip_date: DATE, status: "review_needed",
        image_count: 2, success_count: 0, failed_count: 2, first_image_at: "2026-10-31T09:00:00Z",
      }])
      .seed("slip_evidences", [])
      .seed("slip_checks", []);
    const result = await getSlipStatusTool(client(db), DATE, { staff: "เล็ก", market: null });
    expect(result.found).toBe(true);
    expect(result.batches.map((batch) => batch.batchStatus)).toEqual(["review_needed"]);
    expect(result.partial).toBe(false);
  });

  test("the asked market's white sheet is found behind more than 100 other sheets", async () => {
    const sheet = (market: string, finalized: boolean) => ({
      business_date: DATE, market_label_normalized: market, finalized_at: finalized ? "2026-10-31T12:00:00Z" : null,
      white_sheet_sales: null, labor_entered: false, location_fee_entered: false, bag_entered: false,
      snack_entered: false, other_entered: false, actual_cash_submitted_entered: false,
    });
    const db = new FakeDatabase().seed("digital_white_sheet_cash_entries", [
      ...Array.from({ length: 120 }, () => sheet("ราชพฤกษ์", true)),
      sheet("พาซิโอ้ผัก", false),
    ]);
    const result = await getWhiteSheetStatusTool(client(db), DATE, "พาซิโอ้ผัก");
    expect(result.found).toBe(true);
    expect(result.sheets).toEqual([expect.objectContaining({ market: PASEO, finalized: false })]);
    expect(result.partial).toBe(false);
  });

  test("a scan that hits its hard cap says the result is partial", async () => {
    const many = Array.from({ length: 1_200 }, (_, i) => ({
      id: `b${i}`, seller_name: `s${i}`, market_name: "ราชพฤกษ์", slip_date: DATE, status: "completed",
      image_count: 1, success_count: 1, failed_count: 0, first_image_at: "2026-10-31T03:00:00Z",
    }));
    const db = new FakeDatabase().seed("slip_batches", many).seed("slip_evidences", []).seed("slip_checks", []);
    const result = await getSlipStatusTool(client(db), DATE, { staff: "ไม่มีคนนี้", market: null });
    expect(result.found).toBe(false);
    expect(result.partial).toBe(true);
  });
});

describe("P2-6: settlement existence flags and counters respect the market scope", () => {
  test("a staff member's rows in a market outside the scope are not even counted", async () => {
    const db = new FakeDatabase()
      .seed("produce_transactions", [{
        id: "p1", session_id: "s1", staff_name: "ขวัญ", market_name: "พาซิโอ้ผัก", product_name: "ผักกาด", quantity: 15,
        unit: "กก.", transaction_type: "เบิก", base_transaction_type: "เบิก", session_kind: "main", transaction_date: DATE,
        item_created_at: "2026-10-31T01:00:00Z", raw_message_id: "raw-1",
      }])
      .seed("raw_messages", [{ id: "raw-1", source_id: "Cpaseo" }]);
    const result = await getStaffSettlementTool(client(db), DATE, "ขวัญ", { markets: new Set([RATCHA]) });
    expect(result.found).toBe(false);
    expect(result.matchedProduceRows).toBe(0);
    expect(result.unresolvedSourceRows).toBe(0);
    expect(result.settlements).toEqual([]);
  });
});
