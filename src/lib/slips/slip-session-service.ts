import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { logger } from "@/lib/logger";

type Supabase = SupabaseClient<Database>;

export interface SlipSessionHeader {
  sellerName: string;
  marketName: string;
  slipDate: string | null;
  rawHeaderText: string;
  batchType: "TRANSFER_SLIPS";
}

export interface ActiveSlipSession {
  /** Present only when the database returned the ledger-era schema column. */
  ledgerSchemaPresent?: true;
  batchId:    string;
  imageCount: number;
  headerText: string | null;
  sellerName: string | null;
  marketName: string | null;
  slipDate:   string | null;
}

// "กี้-วัดทุ่งลานนา สลิปเงินโอน 9/6/2569"
const SLIP_OPEN_DASH_RE =
  /^(.+?)\s*-\s*(.+?)\s+สลิป(?:เงินโอน|โอนเงิน|เงิน)\s+(.+)$/;

// "กี้ วัดทุ่งลานนา สลิปเงินโอน 9/6/2569"
const SLIP_OPEN_SPACE_RE =
  /^(.+?)\s+(.+?)\s+สลิป(?:เงินโอน|โอนเงิน|เงิน)\s+(.+)$/;

export const SLIP_CLOSE_RE = /^(จบสลิป|สรุปสลิป|ปิดชุดสลิป|จบชุดสลิป)$/;

export function isSlipCloseCommand(text: string): boolean {
  return SLIP_CLOSE_RE.test(text.trim());
}

export function parseSlipSessionHeader(text: string): SlipSessionHeader | null {
  const trimmed = text.trim();

  const dashMatch = trimmed.match(SLIP_OPEN_DASH_RE);
  if (dashMatch) {
    return {
      sellerName:    dashMatch[1].trim(),
      marketName:    dashMatch[2].trim(),
      slipDate:      dashMatch[3].trim() || null,
      rawHeaderText: trimmed,
      batchType:     "TRANSFER_SLIPS",
    };
  }

  const spaceMatch = trimmed.match(SLIP_OPEN_SPACE_RE);
  if (spaceMatch) {
    return {
      sellerName:    spaceMatch[1].trim(),
      marketName:    spaceMatch[2].trim(),
      slipDate:      spaceMatch[3].trim() || null,
      rawHeaderText: trimmed,
      batchType:     "TRANSFER_SLIPS",
    };
  }

  return null;
}

/**
 * The application needs migration 20261017100000 (slip_batches.open_event_ts_ms
 * / close_event_ts_ms and the image ledger). Deployment order is migration
 * FIRST, application second; it is a hard prerequisite, not a soft fallback.
 *
 * Why not silently fall back to the legacy insert/update: a session opened
 * without its LINE time window runs with no ledger attribution and brings back
 * exactly the incident (images lost while the batch still looks complete). A
 * mis-ordered deploy must therefore fail LOUDLY and leave no half-state, so the
 * operator sees it immediately and applies the migration.
 *
 * Image ingestion on the same stale schema is unaffected and explicit: the
 * ledger RPCs are missing (42883/PGRST202), so each image takes the legacy
 * attach path and the finalizer reports a legacy (ledger-less) batch.
 */
export const SLIP_SCHEMA_NOT_READY_CODE = "slip_ledger_schema_missing";

export class SlipSchemaNotReadyError extends Error {
  readonly code = SLIP_SCHEMA_NOT_READY_CODE;
  constructor(detail: string) {
    super(
      `slip ledger migration 20261017100000 is not applied (${detail}); `
      + "apply it before deploying this application version",
    );
    this.name = "SlipSchemaNotReadyError";
  }
}

const LEDGER_COLUMNS = ["open_event_ts_ms", "close_event_ts_ms"];

/**
 * True only for "this column does not exist": Postgres 42703 or PostgREST
 * PGRST204 (schema cache), and only when the message names one of the ledger
 * columns, so an unrelated missing column is never misclassified.
 */
export function isSlipLedgerColumnMissing(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  if (!error) return false;
  if (error.code !== "42703" && error.code !== "PGRST204") return false;
  const message = error.message ?? "";
  return LEDGER_COLUMNS.some((column) => message.includes(column));
}

export interface SlipSessionIngestor {
  openSession(
    sourceId:    string,
    sourceType:  string,
    senderId:    string | null,
    header:      SlipSessionHeader,
    accountabilityRoundId?: string | null,
    /** LINE event timestamp (ms) of the open command; images sent earlier are not part of this session. */
    openEventTsMs?: number | null,
  ): Promise<{ opened: true; batchId: string } | { opened: false; existingBatchId: string }>;

  findActiveSession(sourceId: string): Promise<ActiveSlipSession | null>;
}

export class SlipSessionService implements SlipSessionIngestor {
  constructor(private readonly supabase: Supabase) {}

  async openSession(
    sourceId:   string,
    sourceType: string,
    senderId:   string | null,
    header:     SlipSessionHeader,
    accountabilityRoundId: string | null = null,
    openEventTsMs: number | null = null,
  ): Promise<{ opened: true; batchId: string } | { opened: false; existingBatchId: string }> {
    const log = logger.child({ sourceId });

    // Attempt INSERT directly — the unique partial index on (source_type, source_id)
    // WHERE status='collecting' enforces the one-open-session invariant atomically,
    // closing the check-then-insert race that a pre-flight findActiveSession would leave.
    const { data, error } = await this.supabase
      .from("slip_batches")
      .insert({
        source_id:   sourceId,
        source_type: sourceType,
        sender_id:   senderId,
        status:      "collecting",
        header_text: header.rawHeaderText,
        seller_name: header.sellerName,
        market_name: header.marketName,
        slip_date:   header.slipDate,
        batch_type:  header.batchType,
        image_count: 0,
        accountability_round_id: accountabilityRoundId,
        open_event_ts_ms: openEventTsMs,
      })
      .select("id")
      .single();

    if (error) {
      // PostgreSQL unique-violation: an open session already exists.
      if (error.code === "23505") {
        const existing = await this.findActiveSession(sourceId);
        if (existing) {
          log.info("slip session already open (unique constraint)", { existingBatchId: existing.batchId });
          return { opened: false, existingBatchId: existing.batchId };
        }
        // Constraint fired but session not found — transient race; caller will retry.
        throw new Error("openSession: unique constraint violated but no active session found");
      }
      if (isSlipLedgerColumnMissing(error)) {
        log.error("slip session NOT opened: ledger migration is not applied", {
          code: SLIP_SCHEMA_NOT_READY_CODE,
          dbCode: error.code,
          requiredMigration: "20261017100000_slip_image_ingestion_ledger",
        });
        throw new SlipSchemaNotReadyError(error.code ?? "unknown");
      }
      throw new Error(`openSession insert failed: ${error.message}`);
    }

    if (!data) throw new Error("openSession: no data returned");

    log.info("slip session opened", {
      batchId:    data.id,
      sellerName: header.sellerName,
      marketName: header.marketName,
      slipDate:   header.slipDate,
    });

    return { opened: true, batchId: data.id };
  }

  async findActiveSession(sourceId: string): Promise<ActiveSlipSession | null> {
    const { data, error } = await this.supabase
      .from("slip_batches")
      .select("*")
      .eq("source_id", sourceId)
      .in("status", ["collecting", "closing"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(`findActiveSession failed: ${error.message}`);
    if (!data) return null;

    return {
      ...(Object.prototype.hasOwnProperty.call(data, "open_event_ts_ms")
        ? { ledgerSchemaPresent: true as const } : {}),
      batchId:    data.id,
      imageCount: data.image_count,
      headerText: data.header_text,
      sellerName: data.seller_name,
      marketName: data.market_name,
      slipDate:   data.slip_date,
    };
  }
}
