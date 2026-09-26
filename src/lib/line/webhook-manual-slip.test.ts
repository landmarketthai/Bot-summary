import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { WebhookService } from "./webhook-service";
import type { LineMessageEvent } from "./types";
import type { Database } from "@/types/database";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(text: string, replyToken = "tok1", messageId = "msg1"): LineMessageEvent {
  return {
    type:           "message",
    webhookEventId: `evt-${messageId}`,
    timestamp:      Date.now(),
    replyToken,
    source:         { type: "user", userId: "u1" },
    message:        { type: "text", id: messageId, text },
  } as unknown as LineMessageEvent;
}

type Row = Record<string, unknown>;

function makeSupabase() {
  const sessions: Row[] = [];
  const entries:  Row[] = [];
  let idSeq = 0;

  function sessionStub() {
    // Supports any depth of .eq() chains before .maybeSingle()
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
              single() {
                const row = { id: `sess-${++idSeq}`, status: "open", market_key: "default", market_label: null, ...payload };
                sessions.push(row);
                return Promise.resolve({ data: row, error: null });
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
                  select(_s = "") {
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
          // Return all matches (not just last) so closeSession total sums correctly.
          return resolve({ data: filtered, error: null });
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

  function nullStub() {
    const noop: unknown = new Proxy({}, { get: () => noop });
    return {
      select() { return { eq() { return { eq() { return { async maybeSingle() { return { data: null, error: null }; } }; } }; } }; },
      insert() { return { select() { return { single() { return Promise.resolve({ data: { id: "noop" }, error: null }); } }; } }; },
      update() { return noop; },
    };
  }

  return {
    from(table: string) {
      if (table === "raw_messages") {
        return {
          insert() {
            return {
              select() {
                return {
                  single() { return Promise.resolve({ data: { id: `raw-${++idSeq}` }, error: null }); },
                };
              },
            };
          },
        };
      }
      if (table === "manual_slip_sessions") return sessionStub();
      if (table === "manual_slip_entries")  return entryStub();
      if (table === "pending_sessions") {
        return { select() { return { eq() { return { async maybeSingle() { return { data: null, error: null }; } }; } }; } };
      }
      return nullStub();
    },
    async rpc(name: string, args: Record<string, unknown>) {
      if (name === "append_manual_slip_entries_atomic") {
        const session = sessions.find((row) => row.id === args.p_session_id);
        if (!session || session.status !== "open") return { data: null, error: { message: "manual_slip_session_not_open" } };
        if (entries.some((row) => row.session_id === args.p_session_id && row.line_message_id === args.p_line_message_id)) {
          return { data: { inserted: 0, duplicate: true }, error: null };
        }
        const payload = args.p_entries as Array<{ raw_line: string; amount: number }>;
        const current = entries.filter((row) => row.session_id === args.p_session_id);
        let sequence = current.reduce((max, row) => Math.max(max, Number(row.sequence_no)), -1) + 1;
        for (const item of payload) entries.push({ session_id: args.p_session_id, sequence_no: sequence++, raw_line: item.raw_line, amount: item.amount, line_message_id: args.p_line_message_id, line_user_id: args.p_line_user_id });
        return { data: { inserted: payload.length, duplicate: false }, error: null };
      }
      if (name === "close_manual_slip_session_atomic") {
        const session = sessions.find((row) => row.id === args.p_session_id);
        if (!session) return { data: null, error: { message: "manual_slip_session_not_found" } };
        const total = entries.filter((row) => row.session_id === args.p_session_id).reduce((sum, row) => sum + Number(row.amount), 0);
        if (session.status === "closed") return { data: { total, already_closed: true }, error: null };
        session.status = "closed";
        session.closed_at = new Date().toISOString();
        session.closed_by_line_user_id = args.p_line_user_id;
        session.closed_line_message_id = args.p_line_message_id;
        return { data: { total, already_closed: false }, error: null };
      }
      return { data: null, error: { message: "unexpected rpc: " + name } };
    },
    _sessions: sessions,
    _entries:  entries,
  };
}

function makeService(db: ReturnType<typeof makeSupabase>, replies: string[] = []) {
  return new WebhookService(db as unknown as SupabaseClient<Database>, {
    replyMessage: async (_tok, text) => { replies.push(text); },
    scheduleBackgroundTask: () => {},
  });
}

// ── Tests: Case A — sender-name prefix before open command ───────────────────

describe("manual slip open with prefix (Case A)", () => {
  it("opens session when text is 'หนูเล็ก-หน้าเซเวน ส่งสลิปมือ 18/6/2569'", async () => {
    const db      = makeSupabase();
    const replies: string[] = [];
    const svc     = makeService(db, replies);
    const event   = makeEvent("หนูเล็ก-หน้าเซเวน ส่งสลิปมือ 18/6/2569");

    const [res] = await svc.processEvents([event], "dest");

    expect(res.status).toBe("saved");
    expect(db._sessions).toHaveLength(1);
    expect(db._sessions[0].business_date).toBe("2026-06-18");
    expect(db._sessions[0].market_key).toBe("หนูเล็ก-หน้าเซเวน");
    expect(db._sessions[0].market_label).toBe("หนูเล็ก-หน้าเซเวน");
    expect(replies[0]).toMatch(/เปิดสลิปมือ/);
  });

  it("no-label command uses market_key='default'", async () => {
    const db      = makeSupabase();
    const svc     = makeService(db);
    await svc.processEvents([makeEvent("ส่งสลิปมือ 18/6/2569")], "dest");
    expect(db._sessions[0].market_key).toBe("default");
    expect(db._sessions[0].market_label).toBeNull();
  });
});

// ── Tests: Case B — compact amount format ────────────────────────────────────

describe("manual slip compact amount lines (Case B)", () => {
  it("appends entries from compact lines '1.90' and '2.160'", async () => {
    const db      = makeSupabase();
    const replies: string[] = [];
    const svc     = makeService(db, replies);

    await svc.processEvents([makeEvent("ส่งสลิปมือ 18/6/2569", "tok0", "msg0")], "dest");
    const sessionId = db._sessions[0].id as string;

    await svc.processEvents([makeEvent("1.90\n2.160", "tok1", "msg1")], "dest");

    const sessionEntries = db._entries.filter(e => e.session_id === sessionId);
    expect(sessionEntries).toHaveLength(2);
    expect(sessionEntries.map(e => e.amount)).toEqual([90, 160]);
    expect(replies[1]).toMatch(/2 รายการ/);
  });
});

// ── Tests: Case C — multiline batch in one message ───────────────────────────

describe("manual slip multiline batch (Case C)", () => {
  it("opens, adds entries, closes in one message — replies with summary", async () => {
    const db      = makeSupabase();
    const replies: string[] = [];
    const svc     = makeService(db, replies);
    const text    = "หนูเล็ก-หน้าเซเวน ส่งสลิปมือ 18/6/2569\n1.90\n2.160\nจบสลิปมือ";

    const [res] = await svc.processEvents([makeEvent(text)], "dest");

    expect(res.status).toBe("saved");
    expect(db._sessions[0].status).toBe("closed");
    expect(db._entries).toHaveLength(2);
    expect(db._entries.map(e => e.amount)).toEqual([90, 160]);
    expect(replies[0]).toMatch(/จบสลิปมือ/);
    expect(replies[0]).toMatch(/250/);
  });

  it("multiline open+amounts without close leaves session open", async () => {
    const db      = makeSupabase();
    const replies: string[] = [];
    const svc     = makeService(db, replies);

    await svc.processEvents([makeEvent("ส่งสลิปมือ 18/6/2569\n1.90\n2.160")], "dest");

    expect(db._sessions[0].status).toBe("open");
    expect(db._entries).toHaveLength(2);
    expect(replies[0]).toMatch(/2 รายการ/);
  });

  it("never silently fails — always sends a reply", async () => {
    const db      = makeSupabase();
    const replies: string[] = [];
    const svc     = makeService(db, replies);

    await svc.processEvents([makeEvent("หนูเล็ก-หน้าเซเวน ส่งสลิปมือ 18/6/2569\n1.90\n2.160\nจบสลิปมือ")], "dest");

    expect(replies).toHaveLength(1);
    expect(replies[0].length).toBeGreaterThan(0);
  });
});

// ── Tests: market-key separation ─────────────────────────────────────────────

describe("market-key separation", () => {
  it("two different market labels on same date both open and close", async () => {
    const db      = makeSupabase();
    const replies: string[] = [];
    const svc     = makeService(db, replies);

    // Open and close หนูเล็ก
    await svc.processEvents([makeEvent("หนูเล็ก ส่งสลิปมือ 18/6/2569\n1.90\nจบสลิปมือ", "tok1", "msg1")], "dest");
    expect(db._sessions[0].status).toBe("closed");
    expect(db._sessions[0].market_key).toBe("หนูเล็ก");

    // Open and close วัดทุ่ง on the same date
    await svc.processEvents([makeEvent("วัดทุ่ง ส่งสลิปมือ 18/6/2569\n2.160\nจบสลิปมือ", "tok2", "msg2")], "dest");
    expect(db._sessions).toHaveLength(2);
    expect(db._sessions[1].status).toBe("closed");
    expect(db._sessions[1].market_key).toBe("วัดทุ่ง");
    expect(replies[1]).toMatch(/160/);
  });

  it("duplicate open same market with no entries returns clear reply", async () => {
    const db      = makeSupabase();
    const replies: string[] = [];
    const svc     = makeService(db, replies);

    await svc.processEvents([makeEvent("หนูเล็ก ส่งสลิปมือ 18/6/2569", "tok1", "msg1")], "dest");
    await svc.processEvents([makeEvent("หนูเล็ก ส่งสลิปมือ 18/6/2569", "tok2", "msg2")], "dest");

    expect(db._sessions).toHaveLength(1); // no second session
    expect(replies[1]).toMatch(/อยู่แล้ว/);
  });

  it("same market already open + batch reuses session and closes it", async () => {
    const db      = makeSupabase();
    const replies: string[] = [];
    const svc     = makeService(db, replies);

    // First: open with no amounts (stuck session)
    await svc.processEvents([makeEvent("หนูเล็ก ส่งสลิปมือ 18/6/2569", "tok1", "msg1")], "dest");
    expect(db._sessions[0].status).toBe("open");

    // Second: same market with amounts + close — should reuse and close
    await svc.processEvents([makeEvent("หนูเล็ก ส่งสลิปมือ 18/6/2569\n1.90\n2.160\nจบสลิปมือ", "tok2", "msg2")], "dest");

    expect(db._sessions).toHaveLength(1); // still only one session
    expect(db._sessions[0].status).toBe("closed");
    expect(db._entries).toHaveLength(2);
    expect(replies[1]).toMatch(/จบสลิปมือ/);
    expect(replies[1]).toMatch(/250/);
  });

  it("opening a different market while one is open is blocked", async () => {
    const db      = makeSupabase();
    const replies: string[] = [];
    const svc     = makeService(db, replies);

    await svc.processEvents([makeEvent("หนูเล็ก ส่งสลิปมือ 18/6/2569", "tok1", "msg1")], "dest");
    await svc.processEvents([makeEvent("วัดทุ่ง ส่งสลิปมือ 18/6/2569", "tok2", "msg2")], "dest");

    expect(db._sessions).toHaveLength(1); // วัดทุ่ง was blocked
    expect(replies[1]).toMatch(/หนูเล็ก/);
    expect(replies[1]).toMatch(/ยังไม่จบ/);
  });

  it("redelivery does not duplicate entries", async () => {
    const db      = makeSupabase();
    const replies: string[] = [];
    const svc     = makeService(db, replies);
    const event   = makeEvent("ส่งสลิปมือ 18/6/2569", "tok1", "msg1");
    const dup     = makeEvent("ส่งสลิปมือ 18/6/2569", "tok2", "msg2");

    await svc.processEvents([event, dup], "dest");

    expect(db._sessions).toHaveLength(1);
  });
});
