import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ManualSlipSessionRow } from "@/types/database";

type Supabase = SupabaseClient<Database>;

export type { ManualSlipSessionRow };

/**
 * LINE reply for a manual-slip write the database refused on purpose
 * (20261103120000): the round/day is already settled, or financial writes
 * are paused for maintenance. null = some other failure.
 */
export function manualSlipRefusalReply(errorMessage: string): string | null {
  if (errorMessage.includes("manual_slip_scope_settled")) {
    return "ส่งยอดวันนี้/รอบนี้แล้ว ไม่รับสลิปมือเพิ่ม กรุณาแจ้งผู้ดูแลเพื่อตรวจสอบ";
  }
  if (errorMessage.includes("financial_maintenance")) {
    return "ระบบการเงินปิดปรับปรุงชั่วคราว ยังไม่รับสลิปมือ กรุณาส่งใหม่ภายหลัง";
  }
  return null;
}

export class ManualSlipSessionService {
  constructor(private readonly supabase: Supabase) {}

  async findSession(sourceId: string, businessDate: string, marketKey: string): Promise<ManualSlipSessionRow | null> {
    const { data, error } = await this.supabase
      .from("manual_slip_sessions")
      .select("*")
      .eq("source_id", sourceId)
      .eq("business_date", businessDate)
      .eq("market_key", marketKey)
      .maybeSingle();
    if (error) throw new Error(`manual session lookup failed: ${error.message}`);
    return data;
  }

  // Returns the single open session for this source, if any.
  async findOpenSession(sourceId: string): Promise<ManualSlipSessionRow | null> {
    const { data, error } = await this.supabase
      .from("manual_slip_sessions")
      .select("*")
      .eq("source_id", sourceId)
      .eq("status", "open")
      .maybeSingle();
    if (error) throw new Error(`open manual session lookup failed: ${error.message}`);
    return data;
  }

  async openSession(params: {
    sourceId:       string;
    businessDate:   string;
    marketKey:      string;
    marketLabel:    string | null;
    lineUserId:     string | null;
    lineMessageId:  string;
    accountabilityRoundId?: string | null;
  }): Promise<{
    opened:  boolean;
    session: ManualSlipSessionRow | null;
    reason?: "same_market_exists" | "other_market_open";
  }> {
    // 1. Same market + date already has a session (open or closed)?
    const existing = await this.findSession(params.sourceId, params.businessDate, params.marketKey);
    if (existing) {
      return { opened: false, session: existing, reason: "same_market_exists" };
    }

    // 2. Any other session currently open for this source (different market / date)?
    //    Enforce max-one-open-at-a-time rule to avoid ambiguous amount routing.
    const otherOpen = await this.findOpenSession(params.sourceId);
    if (otherOpen) {
      return { opened: false, session: otherOpen, reason: "other_market_open" };
    }

    // 3. All clear — create new session.
    const { data, error } = await this.supabase
      .from("manual_slip_sessions")
      .insert({
        source_id:               params.sourceId,
        business_date:           params.businessDate,
        market_key:              params.marketKey,
        market_label:            params.marketLabel,
        status:                  "open",
        opened_by_line_user_id:  params.lineUserId,
        opened_line_message_id:  params.lineMessageId,
        accountability_round_id: params.accountabilityRoundId ?? null,
      })
      .select()
      .single();

    if (error) throw new Error(`manual session open failed: ${error.message}`);
    return { opened: true, session: data };
  }

  async appendEntries(params: {
    sessionId:      string;
    entries:        Array<{ rawLine: string; amount: number }>;
    lineMessageId:  string;
    lineUserId:     string | null;
  }): Promise<void> {
    // Append is serialized in the database against the parent session row so a
    // closed session can never gain entries excluded from the close total. The
    // RPC also enforces line_message_id idempotency for LINE re-delivery.
    const payload = params.entries.map((entry) => ({
      raw_line: entry.rawLine,
      amount: entry.amount,
    }));

    const { error } = await this.supabase.rpc("append_manual_slip_entries_atomic", {
      p_session_id: params.sessionId,
      p_entries: payload,
      p_line_message_id: params.lineMessageId,
      p_line_user_id: params.lineUserId,
    });

    if (error) throw new Error(`manual entry append failed: ${error.message}`);
  }

  async closeSession(params: {
    sessionId:      string;
    lineUserId:     string | null;
    lineMessageId:  string;
  }): Promise<{ total: number; alreadyClosed: boolean }> {
    // Close is serialized against the same session row as append: the total is
    // summed and the status flipped under one lock, so a concurrent late append
    // is either included before close or rejected after it — never lost.
    const { data, error } = await this.supabase.rpc("close_manual_slip_session_atomic", {
      p_session_id: params.sessionId,
      p_line_user_id: params.lineUserId,
      p_line_message_id: params.lineMessageId,
    });

    if (error) throw new Error(`manual session close failed: ${error.message}`);
    const result = data as { total?: number | string; already_closed?: boolean } | null;
    if (!result || result.total === undefined) {
      throw new Error("manual session close failed: RPC returned no total");
    }

    return {
      total: Number(result.total),
      alreadyClosed: result.already_closed === true,
    };
  }
}
