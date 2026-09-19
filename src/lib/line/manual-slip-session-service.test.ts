import { describe, expect, it } from "bun:test";
import { ManualSlipSessionService } from "./manual-slip-session-service";

// ── In-memory Supabase stub ───────────────────────────────────────────────────

type Row = Record<string, unknown>;

function makeDb(initial: Row[] = []) {
  const sessions: Row[] = [...initial];
  const entries:  Row[] = [];
  let idSeq = 0;

  function stubFor(table: string) {
    if (table === "manual_slip_sessions") return sessionStub();
    if (table === "manual_slip_entries")  return entryStub();
    throw new Error(`unknown table: ${table}`);
  }

  function sessionStub() {
    // Chainable filter — supports any depth of .eq() before .maybeSingle()
    function queryChain(filtered: Row[]) {
      return {
        eq(col: string, val: unknown) { return queryChain(filtered.filter(r => r[col] === val)); },
        async maybeSingle() { return { data: filtered[0] ?? null, error: null }; },
      };
    }

    return {
      select(_cols = "*") { return queryChain(sessions); },
      insert(payload: Row) {
        return {
          select() {
            return {
              async single() {
                const row = { id: `sess-${++idSeq}`, status: "open", opened_at: new Date().toISOString(), closed_at: null, ...payload };
                sessions.push(row);
                return { data: row, error: null };
              },
            };
          },
        };
      },
      update(patch: Row) {
        return {
          eq(col: string, val: unknown) {
            return {
              eq(col2: string, val2: unknown) {
                return {
                  select(_s: string) {
                    return {
                      async then(resolve: (v: unknown) => void) {
                        const idx = sessions.findIndex(r => r[col] === val && r[col2] === val2);
                        if (idx === -1) return resolve({ data: [], error: null });
                        Object.assign(sessions[idx], patch);
                        return resolve({ data: [sessions[idx]], error: null });
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
    };
  }

  function entryStub() {
    function chain(filtered: Row[]) {
      return {
        eq:    (col: string, val: unknown) => chain(filtered.filter(r => r[col] === val)),
        order: () => chain(filtered),
        limit: () => chain(filtered),
        async then(resolve: (v: unknown) => void) {
          return resolve({ data: filtered.slice(-1), error: null });
        },
      };
    }
    return {
      select() { return chain(entries); },
      upsert(rows: Row[], _opts: unknown) {
        return {
          async then(resolve: (v: unknown) => void) {
            for (const row of rows) {
              const exists = entries.some(
                e => e.line_message_id === row.line_message_id && e.sequence_no === row.sequence_no,
              );
              if (!exists) entries.push(row);
            }
            return resolve({ data: rows, error: null });
          },
        };
      },
    };
  }

  async function rpc(name: string, args: Record<string, unknown>) {
    if (name === "append_manual_slip_entries_atomic") {
      const session = sessions.find((row) => row.id === args.p_session_id);
      if (!session) return { data: null, error: { message: "session not found" } };
      if (session.status !== "open") return { data: null, error: { message: "session not open" } };
      const messageId = String(args.p_line_message_id);
      if (entries.some((row) => row.session_id === args.p_session_id && row.line_message_id === messageId)) {
        return { data: { inserted: 0, duplicate: true }, error: null };
      }
      const payload = args.p_entries as Array<{ raw_line: string; amount: number }>;
      const start = entries.filter((row) => row.session_id === args.p_session_id).length;
      payload.forEach((entry, index) => entries.push({
        session_id: args.p_session_id, sequence_no: start + index, raw_line: entry.raw_line,
        amount: entry.amount, line_message_id: messageId, line_user_id: args.p_line_user_id,
      }));
      return { data: { inserted: payload.length, duplicate: false }, error: null };
    }
    if (name === "close_manual_slip_session_atomic") {
      const session = sessions.find((row) => row.id === args.p_session_id);
      if (!session) return { data: null, error: { message: "session not found" } };
      const total = entries.filter((row) => row.session_id === args.p_session_id)
        .reduce((sum, row) => sum + Number(row.amount), 0);
      const already = session.status === "closed";
      if (!already) Object.assign(session, { status: "closed", closed_at: new Date().toISOString() });
      return { data: { total, already_closed: already }, error: null };
    }
    return { data: null, error: { message: `unknown rpc: ${name}` } };
  }

  return { from: stubFor, rpc, _sessions: sessions, _entries: entries };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ManualSlipSessionService", () => {
  it("opens a new session with market_key", async () => {
    const db  = makeDb();
    const svc = new ManualSlipSessionService(db as never);
    const res = await svc.openSession({
      sourceId: "grp1", businessDate: "2026-06-17",
      marketKey: "default", marketLabel: null,
      lineUserId: "u1", lineMessageId: "msg1",
    });
    expect(res.opened).toBe(true);
    expect(res.session?.source_id).toBe("grp1");
    expect(res.session?.market_key).toBe("default");
  });

  it("blocks duplicate open for same source_id + business_date + market_key", async () => {
    const existing = {
      id: "s1", source_id: "grp1", business_date: "2026-06-17", market_key: "default",
      status: "open", opened_at: new Date().toISOString(), closed_at: null,
    };
    const db  = makeDb([existing]);
    const svc = new ManualSlipSessionService(db as never);
    const res = await svc.openSession({
      sourceId: "grp1", businessDate: "2026-06-17",
      marketKey: "default", marketLabel: null,
      lineUserId: "u1", lineMessageId: "msg2",
    });
    expect(res.opened).toBe(false);
    expect(res.reason).toBe("same_market_exists");
  });

  it("also blocks duplicate for closed session (same date + market_key)", async () => {
    const existing = {
      id: "s1", source_id: "grp1", business_date: "2026-06-17", market_key: "default",
      status: "closed", opened_at: new Date().toISOString(), closed_at: new Date().toISOString(),
    };
    const db  = makeDb([existing]);
    const svc = new ManualSlipSessionService(db as never);
    const res = await svc.openSession({
      sourceId: "grp1", businessDate: "2026-06-17",
      marketKey: "default", marketLabel: null,
      lineUserId: "u1", lineMessageId: "msg3",
    });
    expect(res.opened).toBe(false);
    expect(res.reason).toBe("same_market_exists");
  });

  it("allows different market_key on same date", async () => {
    const existing = {
      id: "s1", source_id: "grp1", business_date: "2026-06-17", market_key: "หนูเล็ก",
      status: "closed", opened_at: new Date().toISOString(), closed_at: new Date().toISOString(),
    };
    const db  = makeDb([existing]);
    const svc = new ManualSlipSessionService(db as never);
    const res = await svc.openSession({
      sourceId: "grp1", businessDate: "2026-06-17",
      marketKey: "วัดทุ่ง", marketLabel: "วัดทุ่งลานนา",
      lineUserId: "u1", lineMessageId: "msg4",
    });
    expect(res.opened).toBe(true);
    expect(res.session?.market_key).toBe("วัดทุ่ง");
  });

  it("blocks opening a new market while another market session is open (other_market_open)", async () => {
    const existing = {
      id: "s1", source_id: "grp1", business_date: "2026-06-17", market_key: "หนูเล็ก",
      status: "open", opened_at: new Date().toISOString(), closed_at: null,
    };
    const db  = makeDb([existing]);
    const svc = new ManualSlipSessionService(db as never);
    const res = await svc.openSession({
      sourceId: "grp1", businessDate: "2026-06-17",
      marketKey: "วัดทุ่ง", marketLabel: "วัดทุ่งลานนา",
      lineUserId: "u1", lineMessageId: "msg5",
    });
    expect(res.opened).toBe(false);
    expect(res.reason).toBe("other_market_open");
    expect(res.session?.market_key).toBe("หนูเล็ก"); // returns the blocking session
  });

  it("appends entries with auto sequence_no", async () => {
    const db  = makeDb([{ id: "s1", source_id: "grp1", business_date: "2026-06-17", market_key: "default", status: "open" }]);
    const svc = new ManualSlipSessionService(db as never);

    await svc.appendEntries({
      sessionId: "s1",
      entries: [{ rawLine: "1. 100 บาท", amount: 100 }, { rawLine: "2. 300 บาท", amount: 300 }],
      lineMessageId: "msg-a",
      lineUserId: "u1",
    });

    expect(db._entries).toHaveLength(2);
    expect(db._entries[0].sequence_no).toBe(0);
    expect(db._entries[1].sequence_no).toBe(1);
  });

  it("is idempotent on re-delivered message (same line_message_id)", async () => {
    const db  = makeDb([{ id: "s1", source_id: "grp1", business_date: "2026-06-17", market_key: "default", status: "open" }]);
    const svc = new ManualSlipSessionService(db as never);

    const entries = [{ rawLine: "100 บาท", amount: 100 }];
    await svc.appendEntries({ sessionId: "s1", entries, lineMessageId: "msg-dup", lineUserId: null });
    await svc.appendEntries({ sessionId: "s1", entries, lineMessageId: "msg-dup", lineUserId: null });

    expect(db._entries).toHaveLength(1);
  });
});
