import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { FakeDatabase, type Row } from "@/lib/summary/test-fake-supabase";

/**
 * In-memory stand-in for the webhook ledger, the ordered queue and white_sheet_review_turns.
 * It enforces the same constraints as the migration (primary key, one applied child per
 * parent, snapshot-iff-applied, append-only) so tests exercise the real concurrency guard.
 * Test support only.
 */
export class ReviewDatabase extends FakeDatabase {
  readonly writes: string[] = [];
  private turnSeq = 0;
  /** Simulate a failing write to white_sheet_review_turns. */
  failTurnInserts = false;
  /** Make every base insert report a unique violation that no stored row explains. */
  conflictOnBase = false;
  /** Runs before an insert reaches the table: lets a test interleave a concurrent worker. */
  beforeTurnInsert: ((payload: Row) => Promise<void> | void) | null = null;

  override noteWrite(table: string) { this.writes.push(table); super.noteWrite(table); }
  override insert(table: string, payload: Row, mode: "select" | "insert" | "update" | "upsert" | "delete") {
    this.writes.push(table);
    return super.insert(table, payload, mode);
  }

  turns(): Row[] { return this.rows("white_sheet_review_turns"); }

  private insertTurn(payload: Row): { data: null; error: { code: string; message: string } | null } {
    this.writes.push("white_sheet_review_turns");
    if (this.failTurnInserts) return { data: null, error: { code: "XX000", message: "write failed" } };
    const rows = this.turns();
    const duplicateKey = (message: string) => ({ data: null, error: { code: "23505", message } });
    if (this.conflictOnBase && payload.kind === "base") return duplicateKey("unexplained unique violation");
    if (rows.some((row) => row.raw_message_id === payload.raw_message_id)) return duplicateKey("pkey");
    if (payload.kind === "approval" && payload.outcome === "applied" && rows.some((row) =>
      row.kind === "approval" && row.outcome === "applied" && row.sheet_image_raw_id === payload.sheet_image_raw_id)) {
      return duplicateKey("one_accepted_approval_per_sheet");
    }
    const transition = (kind: unknown) => kind === "turn" || kind === "approval";
    if (transition(payload.kind) && payload.outcome === "applied" && rows.some((row) =>
      transition(row.kind) && row.outcome === "applied" && row.sheet_image_raw_id === payload.sheet_image_raw_id
      && row.parent_raw_message_id === payload.parent_raw_message_id)) return duplicateKey("one_applied_transition_per_parent");
    const violates = (payload.outcome === "applied") !== (payload.snapshot !== null && payload.snapshot !== undefined)
      || (payload.kind === "base") !== (payload.raw_message_id === payload.sheet_image_raw_id)
      || (payload.kind === "base" && payload.parent_raw_message_id !== null && payload.parent_raw_message_id !== undefined)
      || (payload.kind !== "base" && payload.outcome === "applied" && !payload.parent_raw_message_id);
    if (violates) return { data: null, error: { code: "23514", message: "check violation" } };
    rows.push({ ...payload, snapshot: payload.snapshot ?? null, parent_raw_message_id: payload.parent_raw_message_id ?? null,
      turn_seq: ++this.turnSeq, created_at: new Date().toISOString() });
    return { data: null, error: null };
  }

  override from(table: string) {
    const base = super.from(table);
    if (table !== "white_sheet_review_turns") return base;
    return {
      ...base,
      insert: ((payload: Row) => ({
        then: (ok?: (value: unknown) => unknown, bad?: (reason: unknown) => unknown) =>
          Promise.resolve(this.beforeTurnInsert?.(payload)).then(() => this.insertTurn(payload)).then(ok, bad),
      })) as unknown as typeof base.insert,
    };
  }

  private queueRpc(name: string, args?: Row) {
    this.rpcCalls.push(name);
    if (name === "receive_line_webhook_event") {
      const existing = this.rows("raw_messages").find((row) => row.line_event_id === args?.p_line_event_id);
      if (existing) return Promise.resolve({ data: { raw_message_id: existing.id, duplicate: true }, error: null });
      const row = this.insert("raw_messages", {
        line_event_id: args?.p_line_event_id, destination: args?.p_destination,
        source_type: args?.p_source_type, source_id: args?.p_source_id, user_id: args?.p_user_id,
        message_id: args?.p_message_id, message_type: args?.p_message_type,
        raw_text: args?.p_raw_text, payload: args?.p_payload,
      }, "insert");
      this.rows("line_webhook_event_queue").push({ raw_message_id: row.id, line_event_id: row.line_event_id,
        source_id: row.source_id, receive_order: this.rows("line_webhook_event_queue").length + 1,
        received_at: new Date().toISOString(), status: "pending", claim_token: "claim", queue_id: row.id });
      return Promise.resolve({ data: { raw_message_id: row.id, duplicate: false }, error: null });
    }
    if (name === "claim_line_webhook_event") {
      const key = (queued: Row) => {
        const payload = this.rows("raw_messages").find((raw) => raw.id === queued.raw_message_id)?.payload as { timestamp?: unknown } | undefined;
        const ts = payload?.timestamp;
        const numeric = typeof ts === "number" || (typeof ts === "string" && /^[0-9]+$/u.test(ts));
        return [numeric ? Number(ts) : Math.floor(Date.parse(String(queued.received_at))), Number(queued.receive_order)];
      };
      const row = this.rows("line_webhook_event_queue")
        .filter((queued) => queued.source_id === args?.p_source_id && queued.status === "pending")
        .sort((a, b) => key(a)[0] - key(b)[0] || key(a)[1] - key(b)[1])[0];
      if (row) row.status = "processing";
      return Promise.resolve({ data: row ?? null, error: null });
    }
    if (name === "complete_line_webhook_event") {
      const row = this.rows("line_webhook_event_queue").find((row) => row.raw_message_id === args?.p_raw_message_id);
      if (row) row.status = args?.p_status;
      return Promise.resolve({ data: true, error: null });
    }
    throw new Error(`Unexpected business RPC: ${name}`);
  }
  client() { return { from: this.from.bind(this), rpc: this.queueRpc.bind(this) } as unknown as SupabaseClient<Database>; }

  /** Tables written by the White Sheet review flow itself (everything else would be a business write). */
  readonly allowedReviewWrites = ["raw_messages", "white_sheet_review_turns"];
  onlyReviewLedgerWrites(): boolean {
    return this.writes.every((table) => this.allowedReviewWrites.includes(table))
      && this.rpcCalls.every((name) => /^(receive|claim|complete)_line_webhook_event$/u.test(name));
  }
}
