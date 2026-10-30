/**
 * Durable operator alert state machine on a disposable local PostgreSQL 17.
 * No LINE/OCR/Storage provider is contacted.
 *
 *   ALLOW_DISPOSABLE_POSTGRES_TESTS=1 PGPASSWORD=postgres \
 *     bun test src/lib/slips/slip-ledger-alert.pg.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  ROOT,
  createSlipTestDb,
  probePg,
  type SlipTestDb,
} from "@/lib/slips/testing/pg-slip-harness";
import { join } from "node:path";

const pgAvailable = await probePg();
if (!pgAvailable && process.env.SLIP_INGEST_REQUIRE === "1") {
  throw new Error("SLIP_INGEST_REQUIRE=1 but PostgreSQL 17 harness unavailable");
}

const RECIPIENT = "a".repeat(64);
const ROTATED_RECIPIENT = "b".repeat(64);
let db: SlipTestDb;
let serial = 0;

type AlertClaim = {
  claimed: boolean;
  reason?: string;
  kind?: "incident" | "recovery";
  retry_key?: string;
  lease_token?: string;
  attempt?: number;
  incident_sequence?: number;
  health: Record<string, number | boolean | null>;
};

const parseJson = <T>(value: unknown): T =>
  (typeof value === "string" ? JSON.parse(value) : value) as T;

async function claim(recipient = RECIPIENT): Promise<AlertClaim> {
  const rows = await db.query<{ value: unknown }>(`
    SELECT public.claim_slip_ingest_health_alert(
      '${recipient}', 2160, 2160, 21600, 60
    ) AS value
  `);
  return parseJson<AlertClaim>(rows[0].value);
}

async function complete(
  c: AlertClaim,
  success: boolean,
  delay = 1,
  recipient = RECIPIENT,
): Promise<boolean> {
  return (await db.scalar(`
    SELECT public.complete_slip_ingest_health_alert(
      '${recipient}', '${c.lease_token}'::uuid, ${success}, ${delay},
      ${success ? "NULL" : "'simulated_line_failure'"}
    )
  `)) === "true";
}

async function receiveUnbound(ageSeconds: number, sourceId = "G-alert"): Promise<string> {
  serial += 1;
  const event = `alert-event-${serial}`;
  const message = `alert-message-${serial}`;
  const ts = Date.now() - ageSeconds * 1_000;
  await db.query(`
    SELECT public.receive_line_webhook_event(
      '${event}', 'destination', 'message', 'group', '${sourceId}', 'U-alert',
      '${message}', 'image', NULL, '{"timestamp":${ts}}'::jsonb
    );
    UPDATE public.slip_image_events
       SET received_at = now() - interval '${ageSeconds} seconds'
     WHERE line_message_id = '${message}';
  `);
  return message;
}

async function createBatch(sourceId = "G-alert"): Promise<string> {
  return (await db.query<{ id: string }>(`
    INSERT INTO public.slip_batches (
      source_id, source_type, sender_id, status, seller_name, market_name,
      slip_date, header_text, open_event_ts_ms
    ) VALUES (
      '${sourceId}', 'group', 'U-alert', 'collecting', 'operator', 'market',
      '19/10/2569', 'operator-market slip 19/10/2569',
      floor(extract(epoch FROM now() - interval '2 hours') * 1000)::bigint
    ) RETURNING id
  `))[0].id;
}

describe.skipIf(!pgAvailable)("durable slip ledger health alert on PostgreSQL 17", () => {
  beforeAll(async () => {
    db = await createSlipTestDb("slip_alert");
  }, 120_000);

  afterAll(async () => {
    if (db) await db.drop();
  }, 60_000);

  beforeEach(async () => {
    await db.query(`
      TRUNCATE public.slip_ingest_alert_states, public.slip_image_events,
        public.slip_checks, public.slip_evidences, public.slip_batches,
        public.line_webhook_event_queue, public.raw_messages CASCADE
    `);
  });

  test("migration is additive, service-role-only, and rollback is present", async () => {
    const migration = await Bun.file(join(
      ROOT, "supabase", "migrations", "20261019120000_slip_ingest_health_alert.sql",
    )).text();
    // A local re-apply must be harmless: rollout tooling may retry after an
    // uncertain client result, and CREATE OR REPLACE must preserve lockdown.
    await db.exec(migration);
    expect(await db.scalar(`SELECT to_regclass('public.slip_ingest_alert_states') IS NOT NULL`)).toBe("true");
    for (const signature of [
      "public.slip_ingest_alert_health(integer,integer)",
      "public.claim_slip_ingest_health_alert(text,integer,integer,integer,integer)",
      "public.complete_slip_ingest_health_alert(text,uuid,boolean,integer,text)",
    ]) {
      expect(await db.scalar(`SELECT has_function_privilege('service_role','${signature}','EXECUTE')`)).toBe("true");
      expect(await db.scalar(`SELECT has_function_privilege('anon','${signature}','EXECUTE')`)).toBe("false");
      expect(await db.scalar(`SELECT has_function_privilege('authenticated','${signature}','EXECUTE')`)).toBe("false");
    }
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(await db.scalar(`SELECT has_table_privilege('${role}','public.slip_ingest_alert_states','SELECT')`)).toBe("false");
    }
    for (const privilege of ["INSERT", "UPDATE", "DELETE"]) {
      expect(await db.scalar(`SELECT has_table_privilege('service_role','public.slip_ingest_alert_states','${privilege}')`)).toBe("false");
    }

    const rollback = await Bun.file(join(
      ROOT, "supabase", "rollback", "20261019120000_slip_ingest_health_alert.down.sql",
    )).text();
    expect(rollback).toContain("DROP FUNCTION IF EXISTS public.complete_slip_ingest_health_alert");
    expect(rollback).toContain("DROP TABLE IF EXISTS public.slip_ingest_alert_states");

    const rollbackDb = await createSlipTestDb("slip_alert_rollback");
    try {
      await rollbackDb.exec(rollback);
      expect(await rollbackDb.scalar(`SELECT to_regclass('public.slip_ingest_alert_states') IS NULL`)).toBe("true");
      expect(await rollbackDb.scalar(`SELECT to_regclass('public.slip_image_events') IS NOT NULL`)).toBe("true");
    } finally {
      await rollbackDb.drop();
    }
  });

  test("healthy and normal delays below 36 minutes do not claim", async () => {
    let result = await claim();
    expect(result).toMatchObject({ claimed: false, reason: "healthy" });

    await receiveUnbound(2159);
    const batchId = await createBatch("G-retry");
    const retryMessage = await receiveUnbound(2159, "G-retry");
    await db.query(`
      UPDATE public.slip_image_events
         SET batch_id = '${batchId}', state = 'retry_pending', next_retry_at = now() + interval '1 minute'
       WHERE line_message_id = '${retryMessage}'
    `);
    result = await claim();
    expect(result.claimed).toBe(false);
    expect(result.health.unbound_total).toBe(1);
    expect(result.health.unbound_stale).toBe(0);
    expect(result.health.retry_pending_total).toBe(1);
    expect(result.health.retry_stale).toBe(0);
    expect(result.health.unhealthy).toBe(false);
  });

  test("unresolved receipts older than seven days remain unhealthy, never report false recovery", async () => {
    const messageId = await receiveUnbound(8 * 24 * 60 * 60);
    const first = await claim();
    expect(first).toMatchObject({ claimed: true, kind: "incident" });
    expect(first.health.unbound_stale).toBe(1);
    expect(await complete(first, true)).toBe(true);
    const repeat = await claim();
    expect(repeat).toMatchObject({ claimed: false, reason: "throttled" });
    expect(repeat.health.unhealthy).toBe(true);
    await db.query(`UPDATE public.slip_image_events SET state='no_session' WHERE line_message_id='${messageId}'`);
    const recovered = await claim();
    expect(recovered).toMatchObject({ claimed: true, kind: "recovery" });
  });

  test("stale unbound receipt is claimed once across overlapping invocations", async () => {
    await receiveUnbound(2161);
    const results = await Promise.all([claim(), claim(), claim(), claim()]);
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    expect(results.filter((r) => r.claimed)[0]).toMatchObject({ kind: "incident", attempt: 1 });
    expect(results.filter((r) => !r.claimed).every((r) => r.reason === "leased")).toBe(true);
    expect(results[0].health.unbound_stale).toBe(1);
  });

  test("recipient rotation starts independent delivery state without weakening same-recipient dedupe", async () => {
    await receiveUnbound(2161);
    const [oldRecipient, rotatedRecipient] = await Promise.all([
      claim(RECIPIENT),
      claim(ROTATED_RECIPIENT),
    ]);
    expect(oldRecipient).toMatchObject({ claimed: true, kind: "incident", attempt: 1 });
    expect(rotatedRecipient).toMatchObject({ claimed: true, kind: "incident", attempt: 1 });
    expect(rotatedRecipient.retry_key).not.toBe(oldRecipient.retry_key);
    expect(await claim(RECIPIENT)).toMatchObject({ claimed: false, reason: "leased" });
    expect(await claim(ROTATED_RECIPIENT)).toMatchObject({ claimed: false, reason: "leased" });
  });

  test("LINE failure releases the lease and retains one stable retry key", async () => {
    await receiveUnbound(2161);
    const first = await claim();
    expect(await complete(first, false)).toBe(true);
    await db.query(`UPDATE public.slip_ingest_alert_states SET next_attempt_at = now() - interval '1 second'`);
    const retry = await claim();
    expect(retry.claimed).toBe(true);
    expect(retry.attempt).toBe(2);
    expect(retry.retry_key).toBe(first.retry_key);
    expect(retry.lease_token).not.toBe(first.lease_token);
  });

  test("accepted LINE push with lost DB ack converges through same-key 409, then recovery", async () => {
    const messageId = await receiveUnbound(2161);
    const acceptedButUnacked = await claim();
    expect(acceptedButUnacked).toMatchObject({ claimed: true, kind: "incident", attempt: 1 });

    // Simulate: LINE accepted the request, then the completion RPC timed out.
    await db.query(`UPDATE public.slip_ingest_alert_states SET lease_until = now() - interval '1 second'`);
    const line409Retry = await claim();
    expect(line409Retry).toMatchObject({ claimed: true, kind: "incident", attempt: 2 });
    expect(line409Retry.retry_key).toBe(acceptedButUnacked.retry_key);
    expect(await complete(line409Retry, true)).toBe(true); // route treats 409 as accepted

    await db.query(`UPDATE public.slip_image_events SET state='no_session' WHERE line_message_id='${messageId}'`);
    const recovery = await claim();
    expect(recovery).toMatchObject({ claimed: true, kind: "recovery", incident_sequence: 1 });
    expect(recovery.retry_key).not.toBe(acceptedButUnacked.retry_key);
  });

  test("SECURITY DEFINER rejects invalid identity and stores hostile error text only as data", async () => {
    let invalidCode: string | undefined;
    try {
      await db.sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE service_role");
        await tx.unsafe("SELECT public.claim_slip_ingest_health_alert('not-a-hash')");
      });
    } catch (error) {
      invalidCode = (error as { errno?: string }).errno;
    }
    expect(invalidCode).toBe("22023");

    await receiveUnbound(2161);
    const first = await claim();
    const hostile = "x'); DROP TABLE public.slip_ingest_alert_states; --";
    const escaped = hostile.replaceAll("'", "''");
    expect(await db.scalar(`SELECT public.complete_slip_ingest_health_alert(
      '${RECIPIENT}', '${first.lease_token}'::uuid, false, 1, '${escaped}'
    )`)).toBe("true");
    expect(await db.scalar(`SELECT to_regclass('public.slip_ingest_alert_states') IS NOT NULL`)).toBe("true");
    expect(await db.scalar(`SELECT last_error_code FROM public.slip_ingest_alert_states`)).toBe(hostile);
  });

  test("alert retry key older than 23 hours expires without attempting another LINE send", async () => {
    await receiveUnbound(2161);
    const first = await claim();
    expect(first).toMatchObject({ claimed: true, kind: "incident" });
    await db.query(`UPDATE public.slip_ingest_alert_states
      SET pending_created_at = now() - interval '23 hours 1 second',
          lease_until = now() - interval '1 second'`);
    const expired = await claim();
    expect(expired).toMatchObject({ claimed: false, reason: "retry_key_expired" });
    expect(await db.scalar(`SELECT pending_status FROM public.slip_ingest_alert_states`)).toBe("expired");
    const again = await claim();
    expect(again).toMatchObject({ claimed: false, reason: "retry_key_expired" });
  });

  test("sustained incident re-alerts only after cadence with a new retry key", async () => {
    await receiveUnbound(2161);
    const first = await claim();
    expect(await complete(first, true)).toBe(true);
    let result = await claim();
    expect(result).toMatchObject({ claimed: false, reason: "throttled" });

    await db.query(`UPDATE public.slip_ingest_alert_states SET last_incident_sent_at = now() - interval '6 hours 1 second'`);
    result = await claim();
    expect(result).toMatchObject({ claimed: true, kind: "incident", attempt: 1 });
    expect(result.retry_key).not.toBe(first.retry_key);
  });

  test("recovery notifies only after delivered incident and resets for a new incident", async () => {
    const firstMessage = await receiveUnbound(2161);
    const incident = await claim();
    expect(await complete(incident, true)).toBe(true);
    await db.query(`UPDATE public.slip_image_events SET state='no_session' WHERE line_message_id='${firstMessage}'`);

    const recovery = await claim();
    expect(recovery).toMatchObject({ claimed: true, kind: "recovery" });
    expect(recovery.retry_key).not.toBe(incident.retry_key);
    expect(await complete(recovery, true)).toBe(true);
    expect(await claim()).toMatchObject({ claimed: false, reason: "healthy", incident_sequence: 1 });

    await receiveUnbound(2161);
    const secondIncident = await claim();
    expect(secondIncident).toMatchObject({ claimed: true, kind: "incident", incident_sequence: 2 });
  });

  test("recovery is cancelled if health becomes unhealthy again, preventing false OK", async () => {
    const firstMessage = await receiveUnbound(2161);
    const incident = await claim();
    expect(await complete(incident, true)).toBe(true);
    await db.query(`UPDATE public.slip_image_events SET state='no_session' WHERE line_message_id='${firstMessage}'`);
    const recovery = await claim();
    expect(recovery.kind).toBe("recovery");
    // Simulate its delivery lease expiring before any completion was recorded.
    await db.query(`UPDATE public.slip_ingest_alert_states SET lease_until = now() - interval '1 second'`);
    await receiveUnbound(2161);
    const next = await claim();
    expect(next).toMatchObject({ claimed: true, kind: "incident", incident_sequence: 2 });
    expect(next.retry_key).not.toBe(recovery.retry_key);
  });

  test("queue-dead, permanent/late ingest failure and overdue OCR are actionable counters", async () => {
    const batchId = await createBatch();
    const queueDead = await receiveUnbound(10);
    const permanent = await receiveUnbound(10);
    const late = await receiveUnbound(10);
    const ocrPending = await receiveUnbound(10);
    await db.query(`
      UPDATE public.slip_image_events ev
         SET batch_id='${batchId}', state='received'
       WHERE ev.line_message_id='${queueDead}';
      UPDATE public.line_webhook_event_queue q
         SET status='stale', completed_at=now()
       FROM public.slip_image_events ev
       WHERE ev.raw_message_id=q.raw_message_id AND ev.line_message_id='${queueDead}';
      UPDATE public.slip_image_events
         SET batch_id='${batchId}', state='failed_permanent', resolved_at=now()
       WHERE line_message_id='${permanent}';
      UPDATE public.slip_image_events
         SET batch_id='${batchId}', state='late_after_finalize', resolved_at=now()
       WHERE line_message_id='${late}';
    `);

    const rawId = await db.scalar(`SELECT raw_message_id FROM public.slip_image_events WHERE line_message_id='${ocrPending}'`);
    const evidenceId = (await db.query<{ id: string }>(`
      INSERT INTO public.slip_evidences (
        raw_message_id, line_message_id, source_id, source_type, storage_path,
        mime_type, byte_size, sha256, status, batch_id, batch_index
      ) VALUES (
        '${rawId}', 'ocr-evidence-${serial}', 'G-alert', 'group', 'slips/mock.jpg',
        'image/jpeg', 4, repeat('a',64), 'RECEIVED', '${batchId}', 1
      ) RETURNING id
    `))[0].id;
    await db.query(`
      UPDATE public.slip_image_events
         SET state='attached', evidence_id='${evidenceId}', resolved_at=now() - interval '36 minutes 1 second'
       WHERE line_message_id='${ocrPending}';
      INSERT INTO public.slip_checks (
        evidence_id, status, slip_type, claim_token, lease_until, updated_at
      ) VALUES (
        '${evidenceId}', 'PROCESSING', 'UNKNOWN', 1,
        now() - interval '30 minutes', now() - interval '36 minutes 1 second'
      );
    `);

    const health = parseJson<Record<string, number | boolean | null>>(
      (await db.query<{ value: unknown }>(`SELECT public.slip_ingest_alert_health(2160,2160) AS value`))[0].value,
    );
    expect(health.unhealthy).toBe(true);
    expect(health.queue_dead).toBe(1);
    expect(health.failed_permanent_24h).toBe(1);
    expect(health.late_after_finalize_24h).toBe(1);
    expect(health.ocr_processing_overdue).toBe(1);
  });
});
