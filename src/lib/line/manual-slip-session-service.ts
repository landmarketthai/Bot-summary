import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ManualSlipSessionRow } from "@/types/database";

type Supabase = SupabaseClient<Database>;

export type { ManualSlipSessionRow };

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
    const existing = await this.findSession(params.sourceId, params.businessDate, params.marketKey);
    if (existing) {
      return { opened: false, session: existing, reason: "same_market_exists" };
    }

    // Amount messages do not carry a market identity, so at most one manual
    // slip session may be open per LINE source at a time.
    const otherOpen = await this.findOpenSession(params.sourceId);
    if (otherOpen) {
      return { opened: false, session: otherOpen, reason: "other_market_open" };
    }

    const { data, error } = await this.supabase
      .from("manual_slip_sessions")
      .insert({
        source_id: params.sourceId,
        business_date: params.businessDate,
        market_key: params.marketKey,
        market_label: params.marketLabel,
        status: "open",
        opened_by_line_user_id: params.lineUserId,
        opened_line_message_id: params.lineMessageId,
        accountability_round_id: params.accountabilityRoundId ?? null,
      })
      .select()
      .single();

    if (error) throw new Error(`manual session open failed: ${error.message}`);
    return { opened: true, session: data };
  }

  async appendEntries(params: {
    sessionId: string;
    entries: Array<{ rawLine: string; amount: number }>;
    lineMessageId: string;
    lineUserId: string | null;
  }): Promise<void> {
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
    sessionId: string;
    lineUserId: string | null;
    lineMessageId: string;
  }): Promise<{ total: number; alreadyClosed: boolean }> {
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
