/**
 * Duplicate finalization end to end — cases A, B, J, K, L, M and N.
 *
 * The fake database models the three contracts that actually decide the
 * outcome, and models them the way Production does:
 *
 *   imported_sessions.session_hash is UNIQUE. The finalize RPC inserts it
 *   ON CONFLICT DO NOTHING and, for a MAIN session, a conflict means duplicate
 *   and NOTHING else is written. That single insert is the race protection, so
 *   the concurrency case here is a genuine test of the contract rather than of
 *   a mock.
 *
 *   bind_plain_text_accountability_round mints a round for a withdrawal, keyed
 *   `plaintext:<session_key>:<generation>`, BEFORE finalization decides.
 *
 *   cancel_duplicate_plain_text_round retires that round only when it provably
 *   holds nothing.
 */
import { describe, expect, it } from "bun:test";
import { finalizePendingGeneration } from "@/lib/line/pending-session-finalizer";
import { computeSessionHash } from "@/lib/line/session-dedup-service";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import { validateProduceEntry } from "./entry-validation";
import { getRuntimeEnvironment } from "@/lib/runtime-environment";
import type { PendingSession } from "@/lib/line/pending-session-service";

type Row = Record<string, unknown>;

const WITHDRAWAL = [
  "แทน-ราชพฤก เบิก 14/8/2569",
  "อะโวคาโด 50 บาท",
  "3 โล",
  "สับปะรด 50 บาท",
  "16 ลูก",
  "จบรายการเบิก",
].join("\n");

/** Same business withdrawal, other LINE group, tone-marked product spelling. */
const WITHDRAWAL_RESENT = WITHDRAWAL.replace("อะโวคาโด 50", "อะโวคาโด้ 50");

const RETURN_BY_OTHER_USER = [
  "แทน-ราชพฤก ชั่งคืน 14/8/2569",
  "อะโวคาโด 50 บาท",
  "1 โล",
  "จบรายการชั่งคืน",
].join("\n");

const RETURN_EXCEEDING_WITHDRAWAL = [
  "แทน-ราชพฤก ชั่งคืน 14/8/2569",
  "อะโวคาโด 50 บาท",
  "9 โล",
  "จบรายการชั่งคืน",
].join("\n");

class Query {
  private readonly filters: Array<(row: Row) => boolean> = [];

  constructor(
    private readonly db: FakeDatabase,
    private readonly table: string,
    private readonly mode: "select" | "insert" | "update" | "delete",
    private readonly payload?: Row | Row[],
  ) {}

  select = () => this;
  order = () => this;
  limit = () => this;
  not = () => this;
  eq(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value);
    return this;
  }
  is(column: string, value: unknown) {
    return this.eq(column, value);
  }
  in(column: string, values: unknown[]) {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }
  lte(column: string, value: unknown) {
    this.filters.push((row) => Number(row[column]) <= Number(value));
    return this;
  }
  async single() {
    const { data } = this.run();
    return { data: Array.isArray(data) ? data[0] ?? null : data, error: null };
  }
  maybeSingle = () => this.single();
  then<T>(resolve: (value: { data: Row[] | Row | null; error: null }) => T) {
    return Promise.resolve(this.run()).then(resolve);
  }

  private run(): { data: Row[] | Row | null; error: null } {
    const rows = this.db.rows(this.table);
    const matched = () => rows.filter((row) => this.filters.every((f) => f(row)));
    if (this.mode === "select") return { data: matched(), error: null };
    if (this.mode === "insert") {
      const payloads = Array.isArray(this.payload) ? this.payload : [this.payload ?? {}];
      return { data: payloads.map((p) => this.db.insert(this.table, p)), error: null };
    }
    if (this.mode === "update") {
      const updated = matched();
      for (const row of updated) Object.assign(row, this.payload);
      return { data: updated, error: null };
    }
    const removed = new Set(matched());
    this.db.replace(this.table, rows.filter((row) => !removed.has(row)));
    return { data: [...removed], error: null };
  }
}

let sequence = 0;

class FakeDatabase {
  private readonly tables = new Map<string, Row[]>();

  rows(table: string): Row[] {
    const existing = this.tables.get(table);
    if (existing) return existing;
    const created: Row[] = [];
    this.tables.set(table, created);
    return created;
  }

  replace(table: string, rows: Row[]): void {
    this.tables.set(table, rows);
  }

  insert(table: string, payload: Row): Row {
    const row = { ...payload };
    this.rows(table).push(row);
    return row;
  }

  from = (table: string) => ({
    select: () => new Query(this, table, "select"),
    insert: (payload: Row | Row[]) => new Query(this, table, "insert", payload),
    update: (payload: Row) => new Query(this, table, "update", payload),
    delete: () => new Query(this, table, "delete"),
  });

  /** Adds one plain-text pending generation ready to be finalized. */
  addPending(document: string, options: { sourceId: string; lineUserId: string }): PendingSession {
    sequence += 1;
    const generation = `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
    const sessionKey = `group:${options.sourceId}:user:${options.lineUserId}`;
    const closeEventId = `close-${sequence}`;
    this.insert("raw_messages", { id: `raw-${sequence}`, line_event_id: closeEventId });
    this.insert("pending_session_ingest", {
      session_key: sessionKey,
      session_generation: generation,
      line_event_id: `ingest-${sequence}`,
      line_timestamp_ms: 1_000,
      raw_text: document,
    });
    // The document reached the deferred finalizer, so it already went through
    // the close gate. อะโวคาโด้ is not an approved dictionary spelling, and the
    // operator confirmed that vocabulary review there; the finalizer only
    // re-checks it. Without this the resend is held, never classified.
    const review = validateProduceEntry({
      parsed: parseWeighSession(document),
      roundRows: [],
      roundBound: true,
    });
    if (review.reviews.length > 0) {
      this.insert("produce_entry_validation_reviews", {
        session_key: sessionKey,
        session_generation: generation,
        validation_digest: review.digest,
        confirmed_at: new Date().toISOString(),
      });
    }
    return this.insert("pending_sessions", {
      session_key: sessionKey,
      session_generation: generation,
      source_id: options.sourceId,
      line_user_id: options.lineUserId,
      accumulated_text: document,
      ingest_revision: 0,
      terminalized: false,
      close_event_timestamp_ms: 2_000,
      close_session_generation: generation,
      close_line_event_id: closeEventId,
      close_requested_at: new Date().toISOString(),
      close_deadline_at: new Date().toISOString(),
      next_attempt_at: new Date(0).toISOString(),
      expected_item_count: null,
      accountability_round_id: null,
      runtime_environment: getRuntimeEnvironment(),
      created_at: new Date().toISOString(),
    }) as unknown as PendingSession;
  }

  round(id: string): Row | undefined {
    return this.rows("accountability_rounds").find((row) => row.id === id);
  }

  rpc = async (name: string, args: Row) => {
    if (name === "bind_plain_text_accountability_round") return this.bind(args);
    if (name === "cancel_duplicate_plain_text_round") return this.cancelRound(args);
    if (name === "try_finalize_pending_generation") return this.finalize(args);
    throw new Error(`Unexpected RPC: ${name}`);
  };

  private creationKey(args: Row): string {
    return `plaintext:${args.p_session_key}:${args.p_session_generation}`;
  }

  private bind(args: Row) {
    const pending = this.rows("pending_sessions").find(
      (row) => row.session_key === args.p_session_key
        && row.session_generation === args.p_session_generation,
    );
    if (!pending) return { data: { outcome: "not_found" }, error: null };

    const creationKey = this.creationKey(args);
    if (args.p_is_new_round) {
      sequence += 1;
      const existing = this.rows("accountability_rounds")
        .find((row) => row.created_line_event_id === creationKey);
      const round = existing ?? this.insert("accountability_rounds", {
        id: `round-${sequence}`,
        status: "open",
        source_id: args.p_source_id,
        owner_line_user_id: args.p_line_user_id,
        business_date: args.p_business_date,
        seller_label: args.p_seller_label,
        market_label: args.p_market_label,
        created_line_event_id: creationKey,
      });
      pending.accountability_round_id = round.id;
      return {
        data: {
          outcome: "bound",
          accountability_round_id: round.id,
          market_label: round.market_label,
        },
        error: null,
      };
    }

    // Continuation: business identity only — never the creating LINE user.
    const candidates = this.rows("accountability_rounds").filter(
      (row) =>
        row.status === "open"
        && row.source_id === args.p_source_id
        && row.business_date === args.p_business_date
        && row.seller_label === args.p_seller_label
        && row.market_label === args.p_market_label
        && this.rows("produce_transactions").some(
          (item) => item.accountability_round_id === row.id
            && item.transaction_type === "เบิก",
        ),
    );
    if (candidates.length === 0) return { data: { outcome: "no_round" }, error: null };
    if (candidates.length > 1) return { data: { outcome: "ambiguous" }, error: null };
    pending.accountability_round_id = candidates[0].id;
    return {
      data: {
        outcome: "bound",
        accountability_round_id: candidates[0].id,
        market_label: candidates[0].market_label,
      },
      error: null,
    };
  }

  /** The migration's guard, transcribed. Refuses whenever the round holds anything. */
  private cancelRound(args: Row) {
    const creationKey = this.creationKey(args);
    const round = this.rows("accountability_rounds")
      .find((row) => row.created_line_event_id === creationKey);
    if (!round) return { data: { outcome: "no_round" }, error: null };
    if (round.status !== "open") {
      return { data: { outcome: "not_open", accountability_round_id: round.id }, error: null };
    }
    if (this.rows("produce_sessions").some((row) => row.accountability_round_id === round.id)) {
      return {
        data: { outcome: "has_produce_sessions", accountability_round_id: round.id },
        error: null,
      };
    }
    if (this.rows("produce_transactions").some((row) => row.accountability_round_id === round.id)) {
      return {
        data: { outcome: "has_transactions", accountability_round_id: round.id },
        error: null,
      };
    }
    if (this.rows("pending_sessions").some(
      (row) => row.accountability_round_id === round.id
        && !(row.session_key === args.p_session_key
          && row.session_generation === args.p_session_generation),
    )) {
      return {
        data: { outcome: "shared_with_other_generation", accountability_round_id: round.id },
        error: null,
      };
    }
    round.status = "cancelled";
    round.closed_line_event_id = `${creationKey}:duplicate`;
    return { data: { outcome: "cancelled", accountability_round_id: round.id }, error: null };
  }

  /** try_finalize_pending_generation, with the real duplicate ordering. */
  private finalize(args: Row) {
    const pending = this.rows("pending_sessions").find(
      (row) => row.session_key === args.p_session_key,
    )!;
    const payload = args.p_session as Row;
    const errors = (payload.validation_errors ?? []) as string[];
    if (errors.length > 0) {
      pending.terminalized = true;
      pending.finalization_status = "failed_closed";
      return { data: { status: "failed_closed", reason: "validation_failed" }, error: null };
    }

    const kind = (payload.session_kind as string) ?? "main";
    const hash = args.p_session_hash as string;
    const conflict = this.rows("imported_sessions").some((row) => row.session_hash === hash);
    if (!conflict) this.insert("imported_sessions", { session_hash: hash });
    if (conflict && kind === "main") {
      pending.terminalized = true;
      pending.finalization_status = "duplicate";
      return { data: { status: "duplicate" }, error: null };
    }

    sequence += 1;
    const sessionId = `produce-${sequence}`;
    this.insert("produce_sessions", {
      id: sessionId,
      session_date: payload.session_date,
      staff_name: payload.staff_name,
      session_title: payload.session_title,
      accountability_round_id: payload.accountability_round_id,
      voided_at: null,
    });
    for (const item of args.p_items as Row[]) {
      this.insert("produce_transactions", {
        session_id: sessionId,
        accountability_round_id: payload.accountability_round_id,
        product_name: item.product_name,
        unit: item.unit,
        quantity: item.quantity,
        price_per_unit: item.price_per_unit,
        transaction_type: item.transaction_type,
      });
    }
    pending.terminalized = true;
    pending.finalization_status = "finalized";
    return {
      data: { status: "finalized", session_id: sessionId, notification_id: "notify-1" },
      error: null,
    };
  }
}

async function finalize(db: FakeDatabase, snapshot: PendingSession) {
  const pushes: string[] = [];
  const result = await finalizePendingGeneration(
    db as never,
    snapshot,
    async (_target, message) => { pushes.push(message); },
  );
  return { result, pushes };
}

describe("exact business duplicate protection", () => {
  it("CASE A — the same withdrawal resent from the same source persists once", async () => {
    const db = new FakeDatabase();
    const identity = { sourceId: "C-first", lineUserId: "U-1" };

    const first = await finalize(db, db.addPending(WITHDRAWAL, identity));
    const second = await finalize(db, db.addPending(WITHDRAWAL, identity));

    expect(first.result.status).toBe("finalized");
    expect(second.result.status).toBe("duplicate");
    expect(db.rows("produce_sessions")).toHaveLength(1);
    expect(db.rows("produce_transactions")).toHaveLength(2);
  });

  it("CASE B — the same withdrawal from a DIFFERENT source persists once", async () => {
    // The แทน incident: rounds d5ae8a20 (group Cf3f0437…) and 0874d4f3
    // (group C629b6b6…) carried one 16-item withdrawal and both persisted.
    const db = new FakeDatabase();

    const first = await finalize(db, db.addPending(WITHDRAWAL, {
      sourceId: "Cf3f043700c19e2425ef643322ff1411a", lineUserId: "U-tan",
    }));
    const second = await finalize(db, db.addPending(WITHDRAWAL_RESENT, {
      sourceId: "C629b6b615240bd9c9c882af560d315e1", lineUserId: "U-tan",
    }));

    expect(first.result.status).toBe("finalized");
    expect(second.result.status).toBe("duplicate");
    expect(db.rows("produce_sessions")).toHaveLength(1);
    expect(db.rows("produce_transactions")).toHaveLength(2);
  });

  it("CASE J — concurrent identical finalizations persist one set", async () => {
    const db = new FakeDatabase();
    const a = db.addPending(WITHDRAWAL, { sourceId: "C-a", lineUserId: "U-a" });
    const b = db.addPending(WITHDRAWAL_RESENT, { sourceId: "C-b", lineUserId: "U-b" });

    const [first, second] = await Promise.all([finalize(db, a), finalize(db, b)]);

    const statuses = [first.result.status, second.result.status].sort();
    expect(statuses).toEqual(["duplicate", "finalized"]);
    expect(db.rows("produce_sessions")).toHaveLength(1);
    expect(db.rows("produce_transactions")).toHaveLength(2);
  });

  it("CASE C — one differing quantity is not a duplicate", async () => {
    const db = new FakeDatabase();
    await finalize(db, db.addPending(WITHDRAWAL, { sourceId: "C-a", lineUserId: "U-a" }));
    const second = await finalize(
      db,
      db.addPending(WITHDRAWAL.replace("3 โล", "4 โล"), { sourceId: "C-b", lineUserId: "U-b" }),
    );

    expect(second.result.status).toBe("finalized");
    expect(db.rows("produce_sessions")).toHaveLength(2);
  });

  it("tells the operator it was already recorded, and never to resend", async () => {
    const db = new FakeDatabase();
    const identity = { sourceId: "C-x", lineUserId: "U-x" };
    await finalize(db, db.addPending(WITHDRAWAL, identity));
    const second = await finalize(db, db.addPending(WITHDRAWAL, identity));

    expect(second.pushes).toEqual(["⚠️ พบรายการนี้ถูกบันทึกไว้แล้ว\nระบบไม่บันทึกซ้ำ"]);
    expect(second.pushes.join()).not.toContain("ส่งใหม่");
  });
});

describe("accountability round lifecycle on duplicate", () => {
  it("CASE K — a duplicate attempt leaves no empty open round", async () => {
    const db = new FakeDatabase();
    await finalize(db, db.addPending(WITHDRAWAL, { sourceId: "C-a", lineUserId: "U-a" }));
    await finalize(db, db.addPending(WITHDRAWAL_RESENT, { sourceId: "C-b", lineUserId: "U-b" }));

    const rounds = db.rows("accountability_rounds");
    expect(rounds).toHaveLength(2);
    const open = rounds.filter((round) => round.status === "open");
    expect(open).toHaveLength(1);
    // The surviving round is the one that actually holds produce.
    expect(db.rows("produce_transactions").every(
      (row) => row.accountability_round_id === open[0].id,
    )).toBe(true);
  });

  it("CASE L — the จิ๋ว pattern: duplicate finalization cancels its own empty round", async () => {
    // Production: fb919686 holds the real withdrawal/return/damaged return,
    // bfb2ea7b was left open with 0 sessions and 0 transactions by a duplicate
    // classified after its round had already been minted — by a DIFFERENT LINE
    // user, which is why the creator-scoped retry cleanup could not reach it.
    const db = new FakeDatabase();
    const legitimate = await finalize(db, db.addPending(WITHDRAWAL, {
      sourceId: "C4fa145d58f23a17e7e7b14315f334c6d", lineUserId: "U3f04f748",
    }));
    expect(legitimate.result.status).toBe("finalized");
    const legitimateRoundId = db.rows("produce_sessions")[0].accountability_round_id as string;

    const duplicate = await finalize(db, db.addPending(WITHDRAWAL_RESENT, {
      sourceId: "C4fa145d58f23a17e7e7b14315f334c6d", lineUserId: "U84e99900",
    }));
    expect(duplicate.result.status).toBe("duplicate");

    const orphan = db.rows("accountability_rounds")
      .find((round) => round.id !== legitimateRoundId)!;
    expect(orphan.status).toBe("cancelled");
    expect(db.round(legitimateRoundId)!.status).toBe("open");
  });

  it("never cancels a round that holds legitimate business data", async () => {
    const db = new FakeDatabase();
    const first = db.addPending(WITHDRAWAL, { sourceId: "C-a", lineUserId: "U-a" });
    await finalize(db, first);
    const roundId = db.rows("produce_sessions")[0].accountability_round_id as string;

    // Re-running the very generation that owns the real round must not retire it.
    const replay = await finalize(db, db.addPending(WITHDRAWAL, {
      sourceId: "C-a", lineUserId: "U-a",
    }));
    expect(replay.result.status).toBe("duplicate");
    expect(db.round(roundId)!.status).toBe("open");
  });
});

describe("what duplicate protection must not break", () => {
  it("CASE M — a cross-user return still binds the original withdrawal round", async () => {
    const db = new FakeDatabase();
    await finalize(db, db.addPending(WITHDRAWAL, {
      sourceId: "C-shared", lineUserId: "U-withdrawer",
    }));
    const roundId = db.rows("produce_sessions")[0].accountability_round_id as string;

    const returned = await finalize(db, db.addPending(RETURN_BY_OTHER_USER, {
      sourceId: "C-shared", lineUserId: "U-other-person",
    }));

    expect(returned.result.status).toBe("finalized");
    expect(db.rows("produce_sessions")[1].accountability_round_id).toBe(roundId);
  });

  it("CASE N — a return above the withdrawal finalizes (reconciled later, never refused)", async () => {
    const db = new FakeDatabase();
    await finalize(db, db.addPending(WITHDRAWAL, {
      sourceId: "C-shared", lineUserId: "U-withdrawer",
    }));

    const returned = await finalize(db, db.addPending(RETURN_EXCEEDING_WITHDRAWAL, {
      sourceId: "C-shared", lineUserId: "U-other-person",
    }));

    expect(returned.result.status).toBe("finalized");
    expect(db.rows("produce_sessions")).toHaveLength(2);
  });
});

describe("the fingerprint the finalizer actually sends", () => {
  it("is identical for the two แทน documents", () => {
    expect(computeSessionHash(parseWeighSession(WITHDRAWAL)))
      .toBe(computeSessionHash(parseWeighSession(WITHDRAWAL_RESENT)));
  });
});
