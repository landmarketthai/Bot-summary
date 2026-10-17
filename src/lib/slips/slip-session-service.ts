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
      .select("id, image_count, header_text, seller_name, market_name, slip_date")
      .eq("source_id", sourceId)
      .in("status", ["collecting", "closing"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(`findActiveSession failed: ${error.message}`);
    if (!data) return null;

    return {
      batchId:    data.id,
      imageCount: data.image_count,
      headerText: data.header_text,
      sellerName: data.seller_name,
      marketName: data.market_name,
      slipDate:   data.slip_date,
    };
  }
}
