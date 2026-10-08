/**
 * Workflow status reads against a plain in-memory fake Supabase client.
 *
 * No mock.module: the client is injected. The fake really applies eq/in/or/
 * gte/lt filters, so an isolation test fails if the code forgets a filter, and
 * it records every call so the tests can also assert the filters themselves.
 */
import { describe, expect, test } from "bun:test";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import { buildProducePartialCapture } from "@/lib/produce/partial-capture";
import type { ProduceValidationResult } from "@/lib/produce/entry-validation";
import type { ConsultantScope } from "./types";
import {
  getLatestSubmissionStatus,
  getPendingSubmissions,
  getSubmissionDiagnosis,
  submissionReference,
} from "./workflow-status";

type Row = Record<string, unknown>;
interface Call { table: string; method: string; args: unknown[] }

class FakeDb {
  tables: Record<string, Row[]> = { pending_sessions: [], produce_sessions: [] };
  calls: Call[] = [];
  failTables = new Set<string>();

  from(table: string) {
    this.calls.push({ table, method: "from", args: [] });
    return new FakeQuery(this, table);
  }
}

class FakeQuery implements PromiseLike<{ data: Row[] | null; error: { message: string } | null }> {
  private predicates: Array<(row: Row) => boolean> = [];
  private orderBy: { column: string; ascending: boolean } | null = null;
  private max: number | null = null;

  constructor(private db: FakeDb, private table: string) {}

  private log(method: string, ...args: unknown[]) {
    this.db.calls.push({ table: this.table, method, args });
  }

  select(columns: string) { this.log("select", columns); return this; }
  eq(column: string, value: unknown) {
    this.log("eq", column, value);
    this.predicates.push((row) => row[column] === value);
    return this;
  }
  in(column: string, values: unknown[]) {
    this.log("in", column, values);
    this.predicates.push((row) => values.includes(row[column]));
    return this;
  }
  or(expression: string) {
    this.log("or", expression);
    const parts = expression.split(",").map((part) => {
      const [column, op, ...rest] = part.split(".");
      const value = rest.join(".");
      if (op === "eq") return (row: Row) => row[column!] === value;
      if (op === "is" && value === "null") return (row: Row) => row[column!] == null;
      throw new Error(`fake: unsupported or() part ${part}`);
    });
    this.predicates.push((row) => parts.some((part) => part(row)));
    return this;
  }
  gte(column: string, value: string) {
    this.log("gte", column, value);
    this.predicates.push((row) => Date.parse(String(row[column])) >= Date.parse(value));
    return this;
  }
  lt(column: string, value: string) {
    this.log("lt", column, value);
    this.predicates.push((row) => Date.parse(String(row[column])) < Date.parse(value));
    return this;
  }
  order(column: string, options: { ascending: boolean }) {
    this.log("order", column, options);
    this.orderBy = { column, ascending: options.ascending };
    return this;
  }
  limit(count: number) { this.log("limit", count); this.max = count; return this; }

  then<TResult1, TResult2 = never>(
    onfulfilled?: ((value: { data: Row[] | null; error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    const result = this.db.failTables.has(this.table)
      ? { data: null, error: { message: "permission denied for table pending_sessions (secret detail)" } }
      : { data: this.run(), error: null };
    return Promise.resolve(result).then(onfulfilled, onrejected);
  }

  private run(): Row[] {
    let rows = (this.db.tables[this.table] ?? []).filter((row) => this.predicates.every((predicate) => predicate(row)));
    if (this.orderBy) {
      const { column, ascending } = this.orderBy;
      rows = [...rows].sort((a, b) => (Date.parse(String(a[column])) - Date.parse(String(b[column]))) * (ascending ? 1 : -1));
    }
    if (this.max !== null) rows = rows.slice(0, this.max);
    return rows.map((row) => structuredClone(row));
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const client = (db: FakeDb) => db as any;

const NOW = Date.parse("2026-10-08T03:00:00.000Z"); // 10:00 Bangkok, the day after the incident
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const GROUP = "C-market-group";
const NOI = "U-noi";
const DAENG = "U-daeng";
const SUPERVISOR = "U-supervisor";

const ownScope = (lineUserId: string, staffLabel: string | null, sourceId = GROUP): ConsultantScope => ({
  kind: "own", lineUserId, sourceId, staffLabel, runtimeEnvironment: "production",
});
const supervisorScope: ConsultantScope = {
  kind: "supervisor", lineUserId: SUPERVISOR, sourceIds: [GROUP], staffLabel: "หัวหน้า", runtimeEnvironment: "production",
};

const CLEAN_VALIDATION: ProduceValidationResult = {
  status: "clean", blocking: [], reviews: [], advisories: [], reconciliation: [], digest: "",
};

function documentText(staff: string, market: string, kind: string, opts: { items: number; broken?: number }) {
  const lines = [`${staff}-${market} ${kind} 7/10/2569`];
  for (let n = 1; n <= opts.items; n += 1) {
    if (n === opts.broken) {
      lines.push(`${n}.กล้วยน้ำหว้า15บาม`, "8หวี");
      continue;
    }
    lines.push(`${n}.มะม่วง${20 + n}บาท`, "2โล");
  }
  return lines.join("\n");
}

function captureOf(text: string) {
  return JSON.parse(JSON.stringify(buildProducePartialCapture(parseWeighSession(text, null), CLEAN_VALIDATION)));
}

function pendingRow(overrides: Row & { session_key: string; line_user_id: string }): Row {
  return {
    session_generation: "gen-1",
    source_id: GROUP,
    created_at: minutesAgo(120),
    updated_at: minutesAgo(5),
    terminalized: false,
    finalization_status: "pending",
    finalization_error: null,
    finalized_produce_session_id: null,
    close_requested_at: null,
    close_event_timestamp_ms: null,
    close_refused_at: null,
    close_refused_session_generation: null,
    next_attempt_at: null,
    finalize_hold_until: null,
    finalize_confirmed_at: null,
    entry_origin: null,
    business_date: null,
    staff_label: null,
    market_label: null,
    initial_transaction_type: null,
    declared_transaction_type: null,
    runtime_environment: "production",
    accountability_round_id: null,
    ingest_revision: 10,
    partial_capture: null,
    partial_capture_revision: null,
    partial_capture_updated_at: null,
    accumulated_text: "",
    ...overrides,
  };
}

/** Production incident, business date 2026-10-07 (น้อย / ราชพฤกษ์ / ชั่งคืน). */
function incidentRow(): Row {
  const text = documentText("น้อย", "ราชพฤกษ์", "ชั่งคืน", { items: 24, broken: 22 });
  return pendingRow({
    session_key: `group:${GROUP}:user:${NOI}`,
    line_user_id: NOI,
    created_at: "2026-10-07T09:00:00.000Z",
    updated_at: "2026-10-07T10:05:00.000Z",
    terminalized: true,
    finalization_status: "failed_closed",
    finalization_error: {
      reason: "close_refused_unresolved",
      close_refused_reason: "entry_gate_refusal",
    },
    close_refused_at: "2026-10-07T09:34:00.000Z",
    close_refused_session_generation: "gen-1",
    // Parse-refused close stages the capture BEFORE round binding.
    accountability_round_id: null,
    ingest_revision: 25,
    partial_capture: captureOf(text),
    partial_capture_revision: 25,
    partial_capture_updated_at: "2026-10-07T09:33:00.000Z",
    accumulated_text: text,
  });
}

function hasNoEnglish(message: string) {
  expect(message).not.toMatch(/[A-Za-z]/);
}

describe("incident regression (2026-10-07 น้อย–ราชพฤกษ์ ชั่งคืน)", () => {
  test("fixture matches the incident shape", () => {
    const capture = incidentRow().partial_capture as { acceptedCount: number; issues: Array<{ itemNumber: number }> };
    expect(capture.acceptedCount).toBe(23);
    expect(capture.issues.map((issue) => issue.itemNumber)).toEqual([22]);
  });

  test("own query explains the failure honestly", async () => {
    const db = new FakeDb();
    db.tables.pending_sessions.push(incidentRow());
    const result = await getLatestSubmissionStatus(client(db), ownScope(NOI, "น้อย"), { now: NOW });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const evidence = result.submission;
    expect(evidence.persisted).toBe(false);
    expect(evidence.state).toBe("failed_terminal");
    expect(evidence.allowedActions).toEqual(["contact_admin_recovery"]);
    expect(evidence.canCorrectInPlace).toBe(false);
    expect(evidence.businessDate).toBe("2026-10-07");
    expect(evidence.staff).toBe("น้อย");
    expect(evidence.market).toBe("ราชพฤกษ์");
    expect(evidence.transactionKindThai).toBe("ชั่งคืน");
    expect(evidence.acceptedUnsavedCount).toBe(23);
    expect(evidence.savedItemCount).toBeNull();
    const blocker = evidence.blockers.find((entry) => entry.itemNumber === 22);
    expect(blocker).toBeDefined();
    expect(blocker!.productName).toBe("กล้วยน้ำหว้า");
    hasNoEnglish(blocker!.detailThai);
    expect(evidence.workerMessage).toBe(
      "รายการชั่งคืนของน้อย–ราชพฤกษ์ วันที่ 7 ต.ค. ยังบันทึกไม่สำเร็จครับ ระบบอ่านได้ 23 รายการ แต่ข้อ 22 ต้องแก้ และรอบเดิมปิดไปแล้ว ตอนนี้ไม่ควรส่งคำสั่งแก้ต่อในรอบเดิม กรุณาให้ผู้ดูแลตรวจและดำเนินการกู้รายการตามขั้นตอนที่ระบบรองรับครับ",
    );
    expect(evidence.workerMessage).not.toContain("บันทึกแล้ว");
    hasNoEnglish(evidence.workerMessage);

    // Nothing raw leaks to the caller.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("กล้วยน้ำหว้า15บาม");
    expect(serialized).not.toContain("unrecognized line");
    expect(serialized).not.toContain(`group:${GROUP}`);
    expect(serialized).not.toContain("gen-1");
    expect(evidence.reference).toBe(submissionReference(`group:${GROUP}:user:${NOI}`, "gen-1"));
  });

  test("diagnosis by item number finds the incident document", async () => {
    const db = new FakeDb();
    db.tables.pending_sessions.push(incidentRow());
    const result = await getSubmissionDiagnosis(client(db), ownScope(NOI, "น้อย"), {
      itemNumber: 22, businessDate: "2026-10-07", now: NOW,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.requestedItem).toEqual({ itemNumber: 22, status: "blocker" });
    expect(result.submission.state).toBe("failed_terminal");
  });

  test("incident is listed as unfinished", async () => {
    const db = new FakeDb();
    db.tables.pending_sessions.push(incidentRow());
    const result = await getPendingSubmissions(client(db), ownScope(NOI, "น้อย"), { now: NOW });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.submissions.map((entry) => entry.state)).toEqual(["failed_terminal"]);
  });
});

describe("lifecycle evidence", () => {
  test("partially parsed open draft → needs_correction in place", async () => {
    const text = documentText("แดง", "วิหาร", "เบิก", { items: 6, broken: 4 });
    const db = new FakeDb();
    db.tables.pending_sessions.push(pendingRow({
      session_key: `group:${GROUP}:user:${DAENG}`,
      line_user_id: DAENG,
      ingest_revision: 7,
      partial_capture: captureOf(text),
      partial_capture_revision: 7,
      partial_capture_updated_at: minutesAgo(5),
      accumulated_text: text,
    }));
    const result = await getLatestSubmissionStatus(client(db), ownScope(DAENG, "แดง"), { now: NOW });
    if (result.status !== "ok") throw new Error(result.status);
    expect(result.submission.state).toBe("needs_correction");
    expect(result.submission.persisted).toBe(false);
    expect(result.submission.acceptedUnsavedCount).toBe(5);
    expect(result.submission.transactionKindThai).toBe("เบิก");
    expect(result.submission.allowedActions).toEqual(["correct_item_in_open_draft", "remove_item_in_open_draft"]);
    expect(result.submission.canCorrectInPlace).toBe(true);
    expect(result.submission.workerMessage).toContain("แก้ข้อ 4");
    hasNoEnglish(result.submission.workerMessage);
  });

  test("stale snapshot (other revision) is ignored; header comes from a read-only parse", async () => {
    const text = documentText("แดง", "วิหาร", "เบิก", { items: 3 });
    const db = new FakeDb();
    db.tables.pending_sessions.push(pendingRow({
      session_key: `group:${GROUP}:user:${DAENG}`,
      line_user_id: DAENG,
      ingest_revision: 3,
      partial_capture: captureOf(documentText("แดง", "วิหาร", "เบิก", { items: 6, broken: 4 })),
      partial_capture_revision: 9,
      accumulated_text: text,
    }));
    const result = await getLatestSubmissionStatus(client(db), ownScope(DAENG, "แดง"), { now: NOW });
    if (result.status !== "ok") throw new Error(result.status);
    expect(result.submission.state).toBe("capturing");
    expect(result.submission.blockers).toEqual([]);
    expect(result.submission.market).toBe("วิหาร");
    expect(result.submission.businessDate).toBe("2026-10-07");
  });

  test("finalized with a proven produce session → persisted", async () => {
    const db = new FakeDb();
    const key = `group:${GROUP}:user:${NOI}`;
    db.tables.pending_sessions.push(pendingRow({
      session_key: key,
      line_user_id: NOI,
      terminalized: true,
      finalization_status: "finalized",
      finalized_produce_session_id: "ps-1",
      accumulated_text: documentText("น้อย", "ราชพฤกษ์", "ชั่งคืน", { items: 24 }),
    }));
    db.tables.produce_sessions.push({
      id: "ps-1", ingest_idempotency_key: `${key}:gen-1`, voided_at: null, replacement_session_id: null,
      total_items: 24, session_date: "2026-10-07", staff_name: "น้อย", session_title: "ราชพฤกษ์",
    });
    const result = await getLatestSubmissionStatus(client(db), ownScope(NOI, "น้อย"), { now: NOW });
    if (result.status !== "ok") throw new Error(result.status);
    expect(result.submission.state).toBe("finalized");
    expect(result.submission.persisted).toBe(true);
    expect(result.submission.savedItemCount).toBe(24);
    expect(result.submission.allowedActions).toEqual(["nothing_needed"]);
    expect(db.calls).toContainEqual({ table: "produce_sessions", method: "in", args: ["id", ["ps-1"]] });

    const pending = await getPendingSubmissions(client(db), ownScope(NOI, "น้อย"), { now: NOW });
    if (pending.status !== "ok") throw new Error(pending.status);
    expect(pending.submissions).toEqual([]);
  });

  test("finalized flag but produce session row missing → unknown, never finalized", async () => {
    const db = new FakeDb();
    db.tables.pending_sessions.push(pendingRow({
      session_key: `group:${GROUP}:user:${NOI}`,
      line_user_id: NOI,
      terminalized: true,
      finalization_status: "finalized",
      finalized_produce_session_id: "ps-gone",
    }));
    const result = await getLatestSubmissionStatus(client(db), ownScope(NOI, "น้อย"), { now: NOW });
    if (result.status !== "ok") throw new Error(result.status);
    expect(result.submission.state).toBe("unknown");
    expect(result.submission.persisted).toBe(false);
    expect(result.submission.savedItemCount).toBeNull();
    expect(result.submission.workerMessage).not.toContain("บันทึกแล้ว");
    expect(result.submission.workerMessage).toContain("ยังตรวจสอบสถานะ");
  });

  test("produce row written under another ingest identity does not prove this document", async () => {
    const db = new FakeDb();
    db.tables.pending_sessions.push(pendingRow({
      session_key: `group:${GROUP}:user:${NOI}`,
      line_user_id: NOI,
      terminalized: true,
      finalization_status: "finalized",
      finalized_produce_session_id: "ps-1",
    }));
    db.tables.produce_sessions.push({
      id: "ps-1", ingest_idempotency_key: "someone-else:gen-9", voided_at: null, replacement_session_id: null,
      total_items: 3, session_date: "2026-10-07", staff_name: "x", session_title: "y",
    });
    const result = await getLatestSubmissionStatus(client(db), ownScope(NOI, "น้อย"), { now: NOW });
    if (result.status !== "ok") throw new Error(result.status);
    expect(result.submission.state).toBe("unknown");
    expect(result.submission.persisted).toBe(false);
  });

  test("structured hold awaiting confirmation uses structured header columns", async () => {
    const db = new FakeDb();
    db.tables.pending_sessions.push(pendingRow({
      session_key: `group:${GROUP}:user:${NOI}`,
      line_user_id: NOI,
      entry_origin: "structured_menu",
      business_date: "2026-10-08",
      staff_label: "น้อย",
      market_label: "ราชพฤกษ์",
      initial_transaction_type: "คืนเสีย",
      close_requested_at: minutesAgo(1),
      close_event_timestamp_ms: NOW - 60_000,
      finalize_hold_until: new Date(NOW + 9 * 60_000).toISOString(),
    }));
    const result = await getLatestSubmissionStatus(client(db), ownScope(NOI, "น้อย"), { now: NOW });
    if (result.status !== "ok") throw new Error(result.status);
    expect(result.submission.state).toBe("awaiting_confirmation");
    expect(result.submission.allowedActions).toEqual(["confirm_review"]);
    expect(result.submission.transactionKindThai).toBe("คืนเสีย");
  });
});

describe("authorization inside the query", () => {
  function twoWorkerDb() {
    const db = new FakeDb();
    db.tables.pending_sessions.push(incidentRow());
    const daengText = documentText("แดง", "วิหาร", "เบิก", { items: 3 });
    db.tables.pending_sessions.push(pendingRow({
      session_key: `group:${GROUP}:user:${DAENG}`,
      line_user_id: DAENG,
      updated_at: "2026-10-07T10:05:20.000Z",
      accumulated_text: daengText,
    }));
    // Same user, different chat: must not appear for an own-scope ask in GROUP.
    db.tables.pending_sessions.push(pendingRow({
      session_key: `group:OTHER:user:${NOI}`,
      source_id: "OTHER",
      line_user_id: NOI,
      updated_at: minutesAgo(1),
      accumulated_text: documentText("น้อย", "ทรัพย์พัน", "เบิก", { items: 2 }),
    }));
    return db;
  }

  test("own scope never returns another user's row, and filters in the query", async () => {
    const db = twoWorkerDb();
    const result = await getPendingSubmissions(client(db), ownScope(NOI, "น้อย"), { now: NOW });
    if (result.status !== "ok") throw new Error(result.status);
    expect(result.submissions).toHaveLength(1);
    expect(result.submissions[0]!.staff).toBe("น้อย");
    expect(result.submissions[0]!.market).toBe("ราชพฤกษ์");
    expect(db.calls).toContainEqual({ table: "pending_sessions", method: "eq", args: ["line_user_id", NOI] });
    expect(db.calls).toContainEqual({ table: "pending_sessions", method: "eq", args: ["source_id", GROUP] });
    expect(db.calls).toContainEqual({ table: "pending_sessions", method: "limit", args: [20] });
  });

  test("two workers in one group are isolated by line_user_id", async () => {
    const db = twoWorkerDb();
    const noi = await getLatestSubmissionStatus(client(db), ownScope(NOI, "น้อย"), { now: NOW });
    const daeng = await getLatestSubmissionStatus(client(db), ownScope(DAENG, "แดง"), { now: NOW });
    if (noi.status !== "ok" || daeng.status !== "ok") throw new Error("expected ok");
    expect(noi.submission.staff).toBe("น้อย");
    expect(daeng.submission.staff).toBe("แดง");
    expect(noi.submission.reference).not.toBe(daeng.submission.reference);
  });

  test("non-supervisor asking about another worker is forbidden with no query", async () => {
    const db = twoWorkerDb();
    const result = await getLatestSubmissionStatus(client(db), ownScope(DAENG, "แดง"), { staff: "น้อย", now: NOW });
    expect(result).toEqual({ status: "forbidden" });
    expect(db.calls).toEqual([]);
    const diagnosis = await getSubmissionDiagnosis(client(db), ownScope(DAENG, null), { staff: "พี่น้อย", itemNumber: 22 });
    expect(diagnosis).toEqual({ status: "forbidden" });
    expect(db.calls).toEqual([]);
  });

  test("own name keeps the line_user_id filter", async () => {
    const db = twoWorkerDb();
    const result = await getLatestSubmissionStatus(client(db), ownScope(NOI, "น้อย"), { staff: "พี่น้อย", now: NOW });
    if (result.status !== "ok") throw new Error(result.status);
    expect(result.submission.staff).toBe("น้อย");
    expect(db.calls).toContainEqual({ table: "pending_sessions", method: "eq", args: ["line_user_id", NOI] });
  });

  test("supervisor can see น้อย's document in an allowlisted chat only", async () => {
    const db = twoWorkerDb();
    const result = await getLatestSubmissionStatus(client(db), supervisorScope, { staff: "น้อย", now: NOW });
    if (result.status !== "ok") throw new Error(result.status);
    expect(result.submission.staff).toBe("น้อย");
    expect(result.submission.market).toBe("ราชพฤกษ์");
    expect(result.submission.state).toBe("failed_terminal");
    expect(db.calls).toContainEqual({ table: "pending_sessions", method: "in", args: ["source_id", [GROUP]] });
    expect(db.calls.some((call) => call.method === "eq" && call.args[0] === "line_user_id")).toBe(false);
  });

  test("simultaneous documents from two workers → ambiguous candidates", async () => {
    const db = twoWorkerDb();
    const result = await getLatestSubmissionStatus(client(db), supervisorScope, { now: NOW });
    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") return;
    expect(result.reason).toBe("simultaneous_documents");
    expect(result.candidates.map((candidate) => candidate.staff).sort()).toEqual(["น้อย", "แดง"]);
  });

  test("item number present as an issue in two documents → clarification", async () => {
    const db = new FakeDb();
    db.tables.pending_sessions.push(incidentRow());
    const text = documentText("แดง", "วิหาร", "ชั่งคืน", { items: 24, broken: 22 });
    db.tables.pending_sessions.push(pendingRow({
      session_key: `group:${GROUP}:user:${DAENG}`,
      line_user_id: DAENG,
      updated_at: "2026-10-07T11:30:00.000Z",
      ingest_revision: 4,
      partial_capture: captureOf(text),
      partial_capture_revision: 4,
      partial_capture_updated_at: "2026-10-07T11:29:00.000Z",
      accumulated_text: text,
    }));
    const result = await getSubmissionDiagnosis(client(db), supervisorScope, { itemNumber: 22, now: NOW });
    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") return;
    expect(result.reason).toBe("item_in_multiple_documents");
    expect(result.candidates).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("กล้วยน้ำหว้า15บาม");
  });

  test("preview scope never sees production or legacy NULL rows", async () => {
    const db = new FakeDb();
    db.tables.pending_sessions.push(incidentRow());
    db.tables.pending_sessions.push({ ...incidentRow(), session_key: "legacy", runtime_environment: null });
    const preview: ConsultantScope = { ...ownScope(NOI, "น้อย"), runtimeEnvironment: "preview" };
    const result = await getLatestSubmissionStatus(client(db), preview, { now: NOW });
    expect(result).toEqual({ status: "none" });
    expect(db.calls).toContainEqual({ table: "pending_sessions", method: "eq", args: ["runtime_environment", "preview"] });

    const production = await getPendingSubmissions(client(db), ownScope(NOI, "น้อย"), { now: NOW });
    if (production.status !== "ok") throw new Error(production.status);
    expect(production.submissions).toHaveLength(2);
  });
});

describe("failure handling and freshness", () => {
  test("DB error → unavailable, no raw error text", async () => {
    const db = new FakeDb();
    db.tables.pending_sessions.push(incidentRow());
    db.failTables.add("pending_sessions");
    const result = await getLatestSubmissionStatus(client(db), ownScope(NOI, "น้อย"), { now: NOW });
    expect(result).toEqual({ status: "unavailable" });
    expect(JSON.stringify(result)).not.toContain("permission");
  });

  test("produce_sessions read error → unavailable, never finalized", async () => {
    const db = new FakeDb();
    db.tables.pending_sessions.push(pendingRow({
      session_key: `group:${GROUP}:user:${NOI}`,
      line_user_id: NOI,
      terminalized: true,
      finalization_status: "finalized",
      finalized_produce_session_id: "ps-1",
    }));
    db.failTables.add("produce_sessions");
    expect(await getLatestSubmissionStatus(client(db), ownScope(NOI, "น้อย"), { now: NOW }))
      .toEqual({ status: "unavailable" });
  });

  test("thrown client → unavailable", async () => {
    const throwing = { from() { throw new Error("socket hang up"); } };
    // The builder throws synchronously before await; treat like any read failure.
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getLatestSubmissionStatus(throwing as any, ownScope(NOI, "น้อย"), { now: NOW }).catch(() => ({ status: "threw" })),
    ).resolves.toEqual({ status: "unavailable" });
  });

  test("malformed arguments are refused before any query", async () => {
    const db = new FakeDb();
    expect(await getLatestSubmissionStatus(client(db), ownScope(NOI, "น้อย"), { businessDate: "7/10/2569" }))
      .toEqual({ status: "invalid_request", field: "businessDate" });
    expect(await getSubmissionDiagnosis(client(db), ownScope(NOI, "น้อย"), { itemNumber: 0 }))
      .toEqual({ status: "invalid_request", field: "itemNumber" });
    expect(db.calls).toEqual([]);
  });

  test("no rows → none", async () => {
    expect(await getLatestSubmissionStatus(client(new FakeDb()), ownScope(NOI, "น้อย"), { now: NOW }))
      .toEqual({ status: "none" });
  });

  test("every call re-reads: stale draft then fresh finalized", async () => {
    const db = new FakeDb();
    const key = `group:${GROUP}:user:${NOI}`;
    db.tables.pending_sessions.push(pendingRow({
      session_key: key,
      line_user_id: NOI,
      accumulated_text: documentText("น้อย", "ราชพฤกษ์", "ชั่งคืน", { items: 3 }),
    }));
    const first = await getLatestSubmissionStatus(client(db), ownScope(NOI, "น้อย"), { now: NOW });
    if (first.status !== "ok") throw new Error(first.status);
    expect(first.submission.state).toBe("capturing");

    Object.assign(db.tables.pending_sessions[0]!, {
      terminalized: true, finalization_status: "finalized", finalized_produce_session_id: "ps-9", updated_at: minutesAgo(0),
    });
    db.tables.produce_sessions.push({
      id: "ps-9", ingest_idempotency_key: `${key}:gen-1`, voided_at: null, replacement_session_id: null,
      total_items: 3, session_date: "2026-10-07", staff_name: "น้อย", session_title: "ราชพฤกษ์",
    });
    const second = await getLatestSubmissionStatus(client(db), ownScope(NOI, "น้อย"), { now: NOW });
    if (second.status !== "ok") throw new Error(second.status);
    expect(second.submission.state).toBe("finalized");
    expect(second.submission.persisted).toBe(true);
    expect(db.calls.filter((call) => call.table === "pending_sessions" && call.method === "from")).toHaveLength(2);
  });

  test("business date filter excludes other days and bounds the window", async () => {
    const db = new FakeDb();
    db.tables.pending_sessions.push(incidentRow());
    const result = await getLatestSubmissionStatus(client(db), ownScope(NOI, "น้อย"), { businessDate: "2026-10-06", now: NOW });
    expect(result).toEqual({ status: "none" });
    expect(db.calls.some((call) => call.method === "lt" && call.args[0] === "updated_at")).toBe(true);
  });
});
