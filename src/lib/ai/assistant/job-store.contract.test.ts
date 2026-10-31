/**
 * One scenario suite, two stores: the in-memory test double and the REAL
 * SQL RPCs on PostgreSQL through SupabaseAssistantJobStore. The PostgreSQL
 * half runs when ALLOW_DISPOSABLE_POSTGRES_TESTS=1 (CI sets
 * AI_ASSISTANT_PG_REQUIRE=1 so it cannot be skipped silently):
 *
 *   ALLOW_DISPOSABLE_POSTGRES_TESTS=1 PGPASSWORD=postgres bun test src/lib/ai/assistant/job-store.contract.test.ts
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { SlipTestDb } from "@/lib/slips/testing/pg-slip-harness";
import { SupabaseAssistantJobStore, type AssistantJob, type AssistantJobRequest, type AssistantJobStore } from "./job-store";
import { MemoryAssistantJobStore } from "./testing/memory-job-store";
import { assistantRpcClient, createAssistantTestDb } from "./testing/pg-assistant-db";

interface Harness {
  name: string;
  store: AssistantJobStore;
  reset(): Promise<void>;
  job(id: string): Promise<AssistantJob>;
  expireLease(id: string): Promise<void>;
  makeAvailable(): Promise<void>;
  expireTurns(): Promise<void>;
}

const memory = new MemoryAssistantJobStore();
const harnesses: Harness[] = [{
  name: "memory",
  get store() { return memory; },
  async reset() {
    memory.jobs.clear();
    memory.turns.length = 0;
    memory.clockOffsetMs = 0;
  },
  async job(id) { return { ...memory.jobs.get(id)! }; },
  async expireLease(id) { memory.expireLease(id); },
  async makeAvailable() { memory.makeAvailable(); },
  async expireTurns() { for (const turn of memory.turns) turn.expiresAt = Date.now() - 1; },
}];

const db: SlipTestDb | null = await createAssistantTestDb();
if (db) {
  const pgStore = new SupabaseAssistantJobStore(assistantRpcClient(db));
  harnesses.push({
    name: "postgresql",
    store: pgStore,
    async reset() {
      await db.query("TRUNCATE public.ai_assistant_conversation_turns, public.ai_assistant_jobs, public.ai_assistant_user_grants");
    },
    async job(id) {
      const rows = await db.query<{ j: AssistantJob }>(`SELECT to_jsonb(j) AS j FROM public.ai_assistant_jobs j WHERE id = '${id}'`);
      const value = rows[0]!.j;
      return (typeof value === "string" ? JSON.parse(value) : value) as AssistantJob;
    },
    async expireLease(id) {
      await db.query(`UPDATE public.ai_assistant_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = '${id}'`);
    },
    async makeAvailable() {
      await db.query("UPDATE public.ai_assistant_jobs SET available_at = now() - interval '1 second' WHERE status = 'queued'");
    },
    async expireTurns() {
      await db.query("UPDATE public.ai_assistant_conversation_turns SET expires_at = now() - interval '1 second'");
    },
  });
}

afterAll(async () => { await db?.drop(); });

let seq = 0;
function request(overrides: Partial<AssistantJobRequest> = {}): AssistantJobRequest {
  seq += 1;
  return {
    lineEventId: `evt-${seq}-${Math.random().toString(36).slice(2)}`,
    rawMessageId: null,
    destination: "Ubot",
    sourceType: "group",
    sourceId: "Cgroup",
    lineUserId: "Uasker",
    question: "วันนี้ทุกตลาดขายได้เท่าไหร่?",
    askedBusinessDate: "2026-10-31",
    eventTimestampMs: 1_793_000_000_000 + seq,
    replyToken: "reply-token",
    replyTokenExpiresAt: new Date(Date.now() + 50_000).toISOString(),
    ...overrides,
  };
}

const claimOne = { limit: 1, leaseSeconds: 60, maxRunning: 10 };
const SCOPE = "a".repeat(64);
const OTHER_SCOPE = "b".repeat(64);

for (const h of harnesses) {
  describe(`assistant job store contract (${h.name})`, () => {
    beforeEach(async () => { await h.reset(); });

    test("enqueue is idempotent per LINE webhook event", async () => {
      const req = request();
      const first = await h.store.enqueue(req);
      const again = await h.store.enqueue({ ...req, question: "something else" });
      expect(first.outcome).toBe("queued");
      expect(again).toEqual({ outcome: "duplicate", jobId: first.jobId });
      expect((await h.job(first.jobId!)).question).toBe(req.question);
    });

    test("bounds outstanding jobs per conversation and the total backlog", async () => {
      for (let i = 0; i < 3; i += 1) expect((await h.store.enqueue(request())).outcome).toBe("queued");
      expect((await h.store.enqueue(request())).outcome).toBe("rate_limited");
      // Another user in the same group is not affected.
      expect((await h.store.enqueue(request({ lineUserId: "Uother" }))).outcome).toBe("queued");
      expect((await h.store.enqueue(request({ lineUserId: "Uthird" }), { maxBacklog: 4 })).outcome).toBe("queue_full");
    });

    test("claim caps live leases across claimers (bounded workers)", async () => {
      for (let i = 0; i < 5; i += 1) await h.store.enqueue(request({ lineUserId: `U${i}` }));
      const first = await h.store.claim("w1", { limit: 5, leaseSeconds: 60, maxRunning: 2 });
      const second = await h.store.claim("w2", { limit: 5, leaseSeconds: 60, maxRunning: 2 });
      expect(first).toHaveLength(2);
      expect(second).toHaveLength(0);
      expect(first.every((job) => job.status === "running" && job.attempts === 1 && job.lease_token)).toBe(true);
    });

    test("one conversation is answered in LINE order; the follow-up waits", async () => {
      const a = await h.store.enqueue(request({ question: "ทำไมรายการของพี่ปลายังปิดไม่ได้?" }));
      const b = await h.store.enqueue(request({ question: "แล้วของพี่ขวัญล่ะ?" }));
      const claimed = await h.store.claim("w1", { limit: 5, leaseSeconds: 60, maxRunning: 5 });
      expect(claimed.map((job) => job.id)).toEqual([a.jobId!]);
      await h.store.complete(a.jobId!, claimed[0]!.lease_token!, "completed");
      const next = await h.store.claim("w1", claimOne);
      expect(next.map((job) => job.id)).toEqual([b.jobId!]);
    });

    test("an expired lease is reclaimed and the old worker is fenced out", async () => {
      const { jobId } = await h.store.enqueue(request());
      const [first] = await h.store.claim("crashed", claimOne);
      await h.expireLease(jobId!);
      const [second] = await h.store.claim("recovery", claimOne);
      expect(second!.id).toBe(jobId!);
      expect(second!.attempts).toBe(2);
      expect(second!.lease_token).not.toBe(first!.lease_token);
      const stale = first!.lease_token!;
      expect(await h.store.recordAnswer(jobId!, stale, { answer: "x", kind: "answer", scopeKey: SCOPE })).toBe(false);
      expect(await h.store.setDelivery(jobId!, stale, ["pending"], "reply_started", "reply")).toBe(false);
      expect(await h.store.complete(jobId!, stale, "completed")).toBe(false);
      expect(await h.store.retry(jobId!, stale, 0, "provider_timeout")).toBe(false);
      expect(await h.store.recordAnswer(jobId!, second!.lease_token!, { answer: "ok", kind: "answer", scopeKey: SCOPE })).toBe(true);
    });

    test("retry waits out its backoff and keeps counting attempts", async () => {
      const { jobId } = await h.store.enqueue(request());
      const [job] = await h.store.claim("w", claimOne);
      expect(await h.store.retry(jobId!, job!.lease_token!, 60, "provider_http_503")).toBe(true);
      expect(await h.store.claim("w", claimOne)).toHaveLength(0);
      await h.makeAvailable();
      const [again] = await h.store.claim("w", claimOne);
      expect(again!.attempts).toBe(2);
      expect(again!.last_error_code).toBe("provider_http_503");
    });

    test("a job that keeps crashing is retired, not retried forever", async () => {
      const { jobId } = await h.store.enqueue(request({ maxAttempts: 1 }));
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const [job] = await h.store.claim("w", claimOne);
        expect(job!.attempts).toBe(attempt);
        await h.expireLease(jobId!);
      }
      expect(await h.store.claim("w", claimOne)).toHaveLength(0);
      const retired = await h.job(jobId!);
      expect(retired.status).toBe("failed");
      expect(retired.last_error_code).toBe("attempts_exhausted");
      expect(retired.reply_token).toBeNull();
    });

    test("delivery state is compare-and-set and a started reply forgets its token", async () => {
      const { jobId } = await h.store.enqueue(request());
      const [job] = await h.store.claim("w", claimOne);
      const lease = job!.lease_token!;
      expect(await h.store.setDelivery(jobId!, lease, ["push_started"], "delivered")).toBe(false);
      expect(await h.store.setDelivery(jobId!, lease, ["pending"], "reply_started", "reply")).toBe(true);
      const started = await h.job(jobId!);
      expect(started.reply_token).toBeNull();
      expect(started.delivery_channel).toBe("reply");
      expect(await h.store.setDelivery(jobId!, lease, ["pending"], "reply_started")).toBe(false);
      expect(await h.store.setDelivery(jobId!, lease, ["reply_started"], "delivered")).toBe(true);
      expect(await h.store.complete(jobId!, lease, "completed")).toBe(true);
      const done = await h.job(jobId!);
      expect(done.status).toBe("completed");
      expect(done.completed_at).not.toBeNull();
      expect(done.lease_token).toBeNull();
    });

    test("conversation memory is isolated per destination, chat and LINE user, ordered and bounded", async () => {
      const answer = async (overrides: Partial<AssistantJobRequest>, text: string) => {
        const { jobId } = await h.store.enqueue(request(overrides));
        const [job] = await h.store.claim("w", claimOne);
        expect(job!.id).toBe(jobId!);
        await h.store.recordAnswer(jobId!, job!.lease_token!, {
          answer: text,
          kind: "answer",
          turn: { businessDate: "2026-10-31", context: { tools: [{ tool: "get_pending_items", arguments: { staff: "ปลา" } }] } },
          maxTurns: 3,
          scopeKey: SCOPE,
        });
        await h.store.complete(jobId!, job!.lease_token!, "completed");
      };
      await answer({ question: "q1" }, "a1");
      await answer({ question: "q-other-user", lineUserId: "Uother" }, "secret of Uother");
      await answer({ question: "q-other-chat", sourceId: "Cother" }, "other chat");
      await answer({ question: "q2" }, "a2");
      await answer({ question: "q3" }, "a3");
      await answer({ question: "q4" }, "a4");
      // A notice is never remembered.
      const { jobId: noticeId } = await h.store.enqueue(request({ question: "q-notice" }));
      const [notice] = await h.store.claim("w", claimOne);
      await h.store.recordAnswer(noticeId!, notice!.lease_token!, { answer: "busy", kind: "notice", turn: { businessDate: "2026-10-31", context: {} } });
      await h.store.complete(noticeId!, notice!.lease_token!, "failed", "provider_timeout");

      const key = { destination: "Ubot", sourceId: "Cgroup", lineUserId: "Uasker" };
      const turns = await h.store.loadTurns(key, Number.MAX_SAFE_INTEGER, "00000000-0000-4000-8000-000000000000", SCOPE, 8);
      expect(turns.map((turn) => turn.question)).toEqual(["q2", "q3", "q4"]);
      expect(turns[0]!.context).toEqual({ tools: [{ tool: "get_pending_items", arguments: { staff: "ปลา" } }] });
      expect((await h.store.loadTurns({ ...key, lineUserId: "Uother" }, Number.MAX_SAFE_INTEGER, "00000000-0000-4000-8000-000000000000", SCOPE, 8)).map((t) => t.answer))
        .toEqual(["secret of Uother"]);
      expect(await h.store.loadTurns({ ...key, destination: "Uother-bot" }, Number.MAX_SAFE_INTEGER, "00000000-0000-4000-8000-000000000000", SCOPE, 8)).toEqual([]);
      // Only turns up to the question being answered.
      expect((await h.store.loadTurns(key, turns[1]!.eventTimestampMs - 1, "00000000-0000-4000-8000-000000000000", SCOPE, 8)).map((t) => t.question)).toEqual(["q2"]);
      await h.expireTurns();
      expect(await h.store.loadTurns(key, Number.MAX_SAFE_INTEGER, "00000000-0000-4000-8000-000000000000", SCOPE, 8)).toEqual([]);
    });

    test("P2-1: a late, older LINE event never runs beside the conversation's active job", async () => {
      const newer = await h.store.enqueue(request({ question: "newer", eventTimestampMs: 1_793_200_002_000 }));
      const [running] = await h.store.claim("w", claimOne);
      expect(running!.id).toBe(newer.jobId!);
      // The older event arrives after the newer one is already running.
      const older = await h.store.enqueue(request({ question: "older", eventTimestampMs: 1_793_200_001_000 }));
      expect(await h.store.claim("w2", { limit: 5, leaseSeconds: 60, maxRunning: 10 })).toHaveLength(0);
      await h.store.complete(newer.jobId!, running!.lease_token!, "completed");
      const [next] = await h.store.claim("w2", claimOne);
      expect(next!.id).toBe(older.jobId!);
    });

    test("P2-1: an expired active job is reclaimed before any other job of its conversation", async () => {
      const first = await h.store.enqueue(request({ eventTimestampMs: 1_793_200_005_000 }));
      const [running] = await h.store.claim("w", claimOne);
      await h.store.enqueue(request({ eventTimestampMs: 1_793_200_004_000 }));
      await h.expireLease(first.jobId!);
      const reclaimed = await h.store.claim("recovery", { limit: 5, leaseSeconds: 60, maxRunning: 10 });
      expect(reclaimed.map((job) => job.id)).toEqual([first.jobId!]);
      expect(running!.id).toBe(first.jobId!);
    });

    test("P1-C: memory is returned only for the access scope it was produced under", async () => {
      const { jobId } = await h.store.enqueue(request({ question: "ทำไมรายการของพี่ปลายังปิดไม่ได้?" }));
      const [job] = await h.store.claim("w", claimOne);
      await h.store.recordAnswer(jobId!, job!.lease_token!, { answer: "ปลา: คืนค้าง", kind: "answer", turn: { businessDate: "2026-10-31", context: {} }, scopeKey: SCOPE });
      await h.store.complete(jobId!, job!.lease_token!, "completed");
      const key = { destination: "Ubot", sourceId: "Cgroup", lineUserId: "Uasker" };
      const none = "00000000-0000-4000-8000-000000000000";
      expect(await h.store.loadTurns(key, Number.MAX_SAFE_INTEGER, none, SCOPE, 4)).toHaveLength(1);
      expect(await h.store.loadTurns(key, Number.MAX_SAFE_INTEGER, none, OTHER_SCOPE, 4)).toEqual([]);
    });

    test("P1-C: a data answer cannot be recorded without a scope key; a withheld answer forgets its turn", async () => {
      const { jobId } = await h.store.enqueue(request());
      const [job] = await h.store.claim("w", claimOne);
      await expect(h.store.recordAnswer(jobId!, job!.lease_token!, { answer: "x", kind: "answer" })).rejects.toThrow();
      expect(await h.store.recordAnswer(jobId!, job!.lease_token!, { answer: "ยอด 40,550.75", kind: "answer", turn: { businessDate: "2026-10-31", context: {} }, scopeKey: SCOPE, deliveryTarget: "private" })).toBe(true);
      expect((await h.job(jobId!))).toMatchObject({ answer_scope_key: SCOPE, delivery_target: "private" });
      expect(await h.store.withholdAnswer(jobId!, job!.lease_token!, "สิทธิ์เปลี่ยน")).toBe(true);
      expect(await h.job(jobId!)).toMatchObject({ answer_text: "สิทธิ์เปลี่ยน", answer_kind: "notice", answer_scope_key: null });
      const key = { destination: "Ubot", sourceId: "Cgroup", lineUserId: "Uasker" };
      expect(await h.store.loadTurns(key, Number.MAX_SAFE_INTEGER, "00000000-0000-4000-8000-000000000000", SCOPE, 4)).toEqual([]);
    });

    test("a follow-up sent in the same LINE millisecond still sees the previous turn, never its own", async () => {
      const sameMs = 1_793_100_000_000;
      const first = await h.store.enqueue(request({ question: "ทำไมรายการของพี่ปลายังปิดไม่ได้?", eventTimestampMs: sameMs }));
      const second = await h.store.enqueue(request({ question: "แล้วของพี่ขวัญล่ะ?", eventTimestampMs: sameMs }));
      const [job1] = await h.store.claim("w", claimOne);
      expect(job1!.id).toBe(first.jobId!);
      await h.store.recordAnswer(job1!.id, job1!.lease_token!, { answer: "ปลา: คืนค้าง", kind: "answer", turn: { businessDate: "2026-10-31", context: {} }, scopeKey: SCOPE });
      await h.store.complete(job1!.id, job1!.lease_token!, "completed");
      const [job2] = await h.store.claim("w", claimOne);
      expect(job2!.id).toBe(second.jobId!);
      const key = { destination: "Ubot", sourceId: "Cgroup", lineUserId: "Uasker" };
      expect((await h.store.loadTurns(key, sameMs, job2!.id, SCOPE, 4)).map((t) => t.question)).toEqual(["ทำไมรายการของพี่ปลายังปิดไม่ได้?"]);
      // A reclaimed job never sees its own earlier (recorded) turn.
      expect(await h.store.loadTurns(key, sameMs, job1!.id, SCOPE, 4)).toEqual([]);
    });
  });
}

if (db) {
  const store = new SupabaseAssistantJobStore(assistantRpcClient(db));
  describe("assistant job queue under concurrency (postgresql)", () => {
    beforeEach(async () => {
      await db.query("TRUNCATE public.ai_assistant_conversation_turns, public.ai_assistant_jobs");
    });

    test("concurrent redeliveries of one LINE event create exactly one job", async () => {
      const req = request();
      const outcomes = await Promise.all(Array.from({ length: 8 }, () => store.enqueue(req)));
      expect(outcomes.filter((o) => o.outcome === "queued")).toHaveLength(1);
      expect(new Set(outcomes.map((o) => o.jobId)).size).toBe(1);
      expect(await db.scalar("SELECT count(*) FROM public.ai_assistant_jobs")).toBe("1");
    });

    test("concurrent questions from one user respect the outstanding bound exactly", async () => {
      const outcomes = await Promise.all(Array.from({ length: 8 }, () => store.enqueue(request())));
      expect(outcomes.filter((o) => o.outcome === "queued")).toHaveLength(3);
      expect(outcomes.filter((o) => o.outcome === "rate_limited")).toHaveLength(5);
    });

    test("P2-2: the global backlog cap holds exactly under concurrent enqueues from different users", async () => {
      const outcomes = await Promise.all(Array.from({ length: 12 }, (_, i) =>
        store.enqueue(request({ lineUserId: `Ubacklog${i}` }), { maxBacklog: 5 })));
      expect(outcomes.filter((o) => o.outcome === "queued")).toHaveLength(5);
      expect(outcomes.filter((o) => o.outcome === "queue_full")).toHaveLength(7);
      expect(await db.scalar("SELECT count(*) FROM public.ai_assistant_jobs")).toBe("5");
    });

    test("P2-1: at most one running job per conversation is enforced by the database itself", async () => {
      const a = await store.enqueue(request({ lineUserId: "Uone", eventTimestampMs: 1_793_300_000_001 }));
      const b = await store.enqueue(request({ lineUserId: "Uone", eventTimestampMs: 1_793_300_000_002 }));
      await store.claim("w", { limit: 1, leaseSeconds: 60, maxRunning: 10 });
      await expect(db.query(`UPDATE public.ai_assistant_jobs SET status = 'running', lease_token = gen_random_uuid(), lease_expires_at = now() + interval '1 minute' WHERE id = '${b.jobId}'`))
        .rejects.toThrow();
      expect(a.outcome).toBe("queued");
    });

    test("parallel claimers never exceed maxRunning or double-claim a job", async () => {
      for (let i = 0; i < 12; i += 1) await store.enqueue(request({ lineUserId: `U${i}` }));
      const batches = await Promise.all(Array.from({ length: 6 }, (_, i) =>
        store.claim(`w${i}`, { limit: 4, leaseSeconds: 60, maxRunning: 3 })));
      const ids = batches.flat().map((job) => job.id);
      expect(ids).toHaveLength(3);
      expect(new Set(ids).size).toBe(3);
    });

    test("only the service role can execute the RPCs and nobody can read the tables directly", async () => {
      const rows = await db.query<{ role: string; fn: string; ok: boolean }>(`
        SELECT r.rolname AS role, p.proname AS fn, has_function_privilege(r.rolname, p.oid, 'EXECUTE') AS ok
          FROM pg_proc p CROSS JOIN pg_roles r
         WHERE p.pronamespace = 'public'::regnamespace
           AND (p.proname LIKE '%ai_assistant%')
           AND r.rolname IN ('anon', 'authenticated', 'service_role')`);
      const functions = new Set(rows.map((row) => row.fn));
      expect(functions.size).toBeGreaterThanOrEqual(12);
      expect(rows.length).toBe(functions.size * 3);
      for (const row of rows) expect(row.ok).toBe(row.role === "service_role");
      const tables = await db.query<{ ok: boolean }>(`
        SELECT has_table_privilege(r.rolname, c.oid, 'SELECT') AS ok
          FROM pg_class c CROSS JOIN pg_roles r
         WHERE c.relname IN ('ai_assistant_jobs', 'ai_assistant_conversation_turns', 'ai_assistant_user_grants', 'ai_assistant_group_policies')
           AND r.rolname IN ('anon', 'authenticated', 'service_role')`);
      expect(tables.every((row) => row.ok === false)).toBe(true);
    });

    test("stored error codes cannot carry provider text", async () => {
      const { jobId } = await store.enqueue(request());
      const [job] = await store.claim("w", claimOne);
      await expect(store.retry(jobId!, job!.lease_token!, 0, "OpenAI said: ดำ ขาด 500 บาท")).rejects.toThrow();
    });
  });
}
