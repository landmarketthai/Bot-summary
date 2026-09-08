import { describe, expect, it } from "bun:test";

/**
 * Static contract tests for migration 0049 and the postback control-event rule.
 *
 * These run without a database so CI enforces the contract on every commit. The
 * behavioural proofs live in produce-structured-session.test.ts; what is checked
 * here is what the SQL and the webhook path are allowed to contain at all.
 */

const migration = new URL(
  "../../../supabase/migrations/0049_produce_structured_session_foundation.sql",
  import.meta.url,
);
const migration0048 = new URL(
  "../../../supabase/migrations/0048_pending_session_function_parity.sql",
  import.meta.url,
);
const finalizerPath = new URL("./pending-session-finalizer.ts", import.meta.url);
const webhookPath = new URL("./webhook-service.ts", import.meta.url);

const sql = await Bun.file(migration).text();

/** Executable SQL only — the header prose deliberately names what 0049 excludes. */
const code = sql
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

function functionBody(name: string): string {
  const start = code.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  expect(start).toBeGreaterThan(-1);
  const end = code.indexOf("$fn$;", start);
  expect(end).toBeGreaterThan(start);
  return code.slice(start, end);
}

const STRUCTURED_COLUMNS = [
  "entry_origin",
  "command_contract_version",
  "business_date",
  "transaction_time",
  "transaction_time_source",
  "staff_label",
  "market_label",
  "session_kind",
  "initial_transaction_type",
  "declared_transaction_type",
  "additional_opener",
  "opened_line_event_id",
];

// ── 1/2. No default, no backfill ──────────────────────────────────────────────

describe("0049 schema — historical rows stay legacy", () => {
  it("adds every frozen field to pending_sessions", () => {
    for (const column of STRUCTURED_COLUMNS) {
      expect(code).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    }
  });

  it("adds no DEFAULT and no NOT NULL to any structured column", () => {
    const alter = code.slice(
      code.indexOf("ALTER TABLE public.pending_sessions"),
      code.indexOf("COMMENT ON COLUMN"),
    );
    expect(alter).not.toMatch(/DEFAULT/i);
    expect(alter).not.toMatch(/NOT NULL/i);
  });

  it("never backfills or otherwise writes historical rows", () => {
    expect(code).not.toMatch(/UPDATE\s+public\.pending_sessions\s+SET\s+entry_origin/i);
    // The only UPDATE/INSERT statements are inside the RPC bodies, which act on
    // one session key at a time; no migration-time DML touches existing rows.
    const migrationTime = code
      .replace(/CREATE OR REPLACE FUNCTION[\s\S]*?\$fn\$;/g, "<function>");
    expect(migrationTime).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|TRUNCATE)\s/mi);
  });

  it("asserts after the fact that no row became structured", () => {
    expect(code).toContain("FROM public.pending_sessions WHERE entry_origin IS NOT NULL");
    expect(sql).toContain("structured origin must never be backfilled");
  });
});

// ── 3/6. Completeness and main/additional pairing are database-enforced ───────

describe("0049 schema — completeness is a CHECK, not a convention", () => {
  it("enforces all-or-nothing structured metadata", () => {
    expect(code).toContain("CONSTRAINT pending_sessions_structured_metadata_complete");
    const constraint = code.slice(
      code.indexOf("pending_sessions_structured_metadata_complete"),
      code.indexOf("pending_sessions_structured_session_kind"),
    );
    // Both arms must mention every frozen field, so a partial row cannot exist.
    for (const column of STRUCTURED_COLUMNS) {
      expect(constraint).toContain(column);
    }
  });

  it("pairs session_kind with the additional-only fields", () => {
    const pair = code.slice(
      code.indexOf("pending_sessions_structured_additional_pair"),
      code.indexOf("pending_sessions_structured_declared_type"),
    );
    expect(pair).toContain("session_kind = 'main'");
    expect(pair).toContain("declared_transaction_type IS NULL");
    expect(pair).toContain("session_kind = 'additional'");
    expect(pair).toContain("declared_transaction_type IS NOT NULL");
    expect(pair).toContain("additional_opener IS NOT NULL");
    // An additional batch's initial type is its declared type, enforced by CHECK.
    expect(pair).toContain("initial_transaction_type = declared_transaction_type");
  });

  it("requires initial_transaction_type for both kinds, with no default", () => {
    const complete = code.slice(
      code.indexOf("pending_sessions_structured_metadata_complete"),
      code.indexOf("pending_sessions_structured_session_kind"),
    );
    expect(complete).toContain("initial_transaction_type  IS NULL");
    expect(complete).toContain("initial_transaction_type  IS NOT NULL");
    expect(code).toContain("CONSTRAINT pending_sessions_structured_initial_type");
    // A main session must be able to be คืน / คืนเสีย, so the domain is the full
    // base set and there is no main-only เบิก assumption anywhere in the DDL.
    const domain = code.slice(
      code.indexOf("pending_sessions_structured_initial_type"),
      code.indexOf("pending_sessions_structured_time_source"),
    );
    expect(domain).toContain("'เบิก'");
    expect(domain).toContain("'คืน'");
    expect(domain).toContain("'คืนเสีย'");
  });

  it("constrains every typed domain", () => {
    for (const constraint of [
      "pending_sessions_entry_origin_domain",
      "pending_sessions_structured_session_kind",
      "pending_sessions_structured_declared_type",
      "pending_sessions_structured_initial_type",
      "pending_sessions_structured_additional_opener",
      "pending_sessions_structured_time_source",
      "pending_sessions_structured_transaction_time_format",
      "pending_sessions_structured_contract_version",
    ]) {
      expect(code).toContain(constraint);
    }
  });
});

// ── 4/5. Open/rotate contract ─────────────────────────────────────────────────

describe("0049 RPC — atomic open or rotate", () => {
  const body = functionBody("open_or_rotate_produce_structured_session");

  it("locks the session key before reading it", () => {
    expect(body).toContain("pg_advisory_xact_lock(hashtext(p_session_key))");
    expect(body).toContain("FOR UPDATE");
    expect(body.indexOf("pg_advisory_xact_lock"))
      .toBeLessThan(body.indexOf("FOR UPDATE"));
  });

  it("checks idempotent redelivery before any mutation", () => {
    const idempotent = body.indexOf("'duplicate_open_event'");
    const update = body.indexOf("UPDATE public.pending_sessions");
    const insert = body.indexOf("INSERT INTO public.pending_sessions");
    expect(idempotent).toBeGreaterThan(-1);
    expect(idempotent).toBeLessThan(update);
    expect(idempotent).toBeLessThan(insert);
  });

  it("validates ownership and the expected generation before rotating", () => {
    const ownership = body.indexOf("'ownership_conflict'");
    const generation = body.indexOf("'generation_conflict'");
    const update = body.indexOf("UPDATE public.pending_sessions");
    expect(ownership).toBeLessThan(update);
    expect(generation).toBeLessThan(update);
    expect(body).toContain("p_expected_session_generation");
  });

  it("validates source and user ownership BEFORE the redelivery shortcut", () => {
    // A duplicate open event presented by the wrong source or user is not a
    // retry of this session and must not be answered with its generation.
    const sourceCheck = body.indexOf("'source_mismatch'");
    const userCheck = body.indexOf("'user_mismatch'");
    const idempotent = body.indexOf("'duplicate_open_event'");
    expect(sourceCheck).toBeGreaterThan(-1);
    expect(userCheck).toBeGreaterThan(-1);
    expect(sourceCheck).toBeLessThan(idempotent);
    expect(userCheck).toBeLessThan(idempotent);
  });

  it("derives the canonical session key and refuses any other", () => {
    // Same construction as getPendingSessionKey in verify.ts.
    expect(body).toContain("'group:' || v_source || ':user:' || v_user");
    expect(body).toContain("'room:'  || v_source || ':user:' || v_user");
    expect(body).toContain("'dm:' || v_user");
    expect(body).toContain("session_key does not match the canonical key for this source");
    expect(body).toContain("a user source must have source_id equal to line_user_id");
    // Derivation happens before the lock, so a mismatched key never even reads.
    expect(body.indexOf("v_expected_key :="))
      .toBeLessThan(body.indexOf("pg_advisory_xact_lock"));
  });

  it("requires initial_transaction_type and pairs it with the declared type", () => {
    expect(body).toContain("initial_transaction_type is required for every structured session");
    expect(body).toContain("p_initial_transaction_type IS DISTINCT FROM p_declared_transaction_type");
    // Written on both the rotate and the first-open path.
    expect(body).toContain("initial_transaction_type  = p_initial_transaction_type");
    expect(body).toContain("p_initial_transaction_type, p_declared_transaction_type");
  });

  it("fails closed without a line user id", () => {
    expect(body).toContain("line_user_id is required for a structured session command");
  });

  it("clears every previous-generation structured field on rotation", () => {
    const update = body.slice(body.indexOf("UPDATE public.pending_sessions"));
    for (const column of STRUCTURED_COLUMNS) {
      expect(update).toContain(`${column}  `.trimEnd().split(" ")[0]);
    }
    // Generation-scoped state that must not survive a rotation.
    for (const column of [
      "close_event_timestamp_ms  = NULL",
      "close_requested_at        = NULL",
      "close_line_event_id       = NULL",
      "close_session_generation  = NULL",
      "close_deadline_at         = NULL",
      "expected_item_count       = NULL",
      "accumulated_text          = ''",
    ]) {
      expect(update).toContain(column);
    }
    expect(update).toContain("session_generation        = v_generation");
  });

  it("returns a discriminated result", () => {
    for (const outcome of ["'opened'", "'rotated'", "'idempotent'", "'ownership_conflict'", "'generation_conflict'"]) {
      expect(body).toContain(outcome);
    }
    expect(body).toContain("'outcome',");
  });
});

// ── 8/9. Postback control events touch no ledger ──────────────────────────────

describe("0049 — postback OPEN and CLOSE are control events", () => {
  it("open creates no admission row, no ingest row and no synthetic text", () => {
    const body = functionBody("open_or_rotate_produce_structured_session");
    expect(body).not.toContain("INSERT INTO public.pending_session_admission");
    expect(body).not.toContain("INSERT INTO public.pending_session_ingest");
    // accumulated_text is emptied, never seeded with a generated Thai header.
    expect(body).toContain("accumulated_text          = ''");
    expect(body).not.toMatch(/accumulated_text\s*=\s*'[^']+'/);
  });

  it("close creates no admission row, no ingest row and no synthetic text", () => {
    const body = functionBody("close_produce_structured_session");
    expect(body).not.toContain("INSERT INTO public.pending_session_admission");
    expect(body).not.toContain("INSERT INTO public.pending_session_ingest");
    expect(body).not.toContain("accumulated_text");
  });

  it("close sets the immutable boundary from real postback evidence", () => {
    const body = functionBody("close_produce_structured_session");
    expect(body).toContain("close_event_timestamp_ms = p_line_timestamp_ms");
    expect(body).toContain("close_line_event_id      = btrim(p_close_line_event_id)");
    // A repeat close is a status request; the first boundary never moves.
    expect(body).toContain("'close_already_requested'");
    const repeat = body.indexOf("'close_already_requested'");
    const update = body.indexOf("UPDATE public.pending_sessions");
    expect(repeat).toBeLessThan(update);
  });

  it("refuses to close a legacy row", () => {
    expect(functionBody("close_produce_structured_session")).toContain("'not_structured'");
  });
});

// ── 10. raw_messages keeps genuine postback evidence ──────────────────────────

describe("0049 — postback raw_messages evidence", () => {
  it("stores event_type from the event and message_type NULL when there is no message", async () => {
    const source = await Bun.file(webhookPath).text();
    expect(source).toContain("event_type:   event.type");
    expect(source).toContain("message_type: (message?.type ?? null)");
    // A postback event carries no `message`, so message_type resolves to NULL
    // and raw_text stays null — proven by the same two expressions.
    expect(source).toContain('raw_text:     message && "text" in message');
  });

  it("never converts a postback into a synthetic Thai message", async () => {
    const commands = await Bun.file(
      new URL("./produce-session-commands.ts", import.meta.url),
    ).text();
    // The command service builds typed commands, never message text to re-parse.
    expect(commands).not.toContain("parseWeighSession");
    // Its executable code contains no Thai characters at all, so it cannot
    // fabricate operator text for a postback to be parsed as if typed. (The
    // doc comments quote Thai examples; those ship nothing.)
    const executable = commands
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    expect(executable).not.toMatch(/[฀-๿]/);
  });
});

// ── 11/12. Readiness escape hatch ─────────────────────────────────────────────

describe("0049 — legacy_accumulated is restricted to legacy rows", () => {
  const body = functionBody("check_pending_close_ready");

  it("guards the compatibility branch with entry_origin IS NULL", () => {
    const branch = body.slice(
      body.indexOf("IF v_session.entry_origin IS NULL"),
      body.indexOf("'legacy_accumulated'"),
    );
    expect(branch).toContain("v_admission_count = 0");
    expect(branch).toContain("btrim(v_session.accumulated_text) <> ''");
    expect(body).toContain("v_session.entry_origin IS NULL");
  });

  it("leaves the legacy branch otherwise identical to the 0048 baseline", async () => {
    const baseline = await Bun.file(migration0048).text();
    // Same readiness predicate, same reasons, same result keys.
    for (const fragment of [
      "(v_admission_count = v_ingest_count AND v_straggler_count = 0 AND v_admission_count > 0)",
      "'no_admissions'",
      "'awaiting_ingest'",
      "'stragglers'",
      "'legacy_accumulated'",
      ") >= 3",
    ]) {
      expect(baseline).toContain(fragment);
      expect(sql).toContain(fragment);
    }
  });

  it("keeps check_pending_close_ready SECURITY INVOKER", () => {
    expect(code).toContain("check_pending_close_ready must remain SECURITY INVOKER");
    expect(body).not.toMatch(/SECURITY DEFINER/);
  });
});

// ── 18/19. Privilege model ────────────────────────────────────────────────────

describe("0049 — privilege model", () => {
  it("makes the open/rotate RPC the only SECURITY DEFINER function", () => {
    // DDL clauses only — assertion strings mentioning the words don't count.
    const definers = [...code.matchAll(/^SECURITY DEFINER$/gm)];
    expect(definers).toHaveLength(1);
    expect(functionBody("open_or_rotate_produce_structured_session"))
      .toContain("SECURITY DEFINER");
    expect(functionBody("close_produce_structured_session"))
      .not.toMatch(/^SECURITY DEFINER$/m);
    expect(functionBody("check_pending_close_ready"))
      .not.toMatch(/^SECURITY DEFINER$/m);
  });

  it("pins a safe search_path on the definer function", () => {
    const body = functionBody("open_or_rotate_produce_structured_session");
    expect(body).toContain("SET search_path = public");
    expect(code).toContain("must pin search_path");
  });

  it("schema-qualifies every table it touches", () => {
    const body = functionBody("open_or_rotate_produce_structured_session");
    // Every reference to a pending-session table must carry the public schema.
    for (const table of [
      "pending_sessions", "pending_session_ingest", "pending_session_admission",
    ]) {
      const bare = new RegExp(`(?<!public\\.)\\b${table}\\b`, "g");
      const hits = [...body.matchAll(bare)]
        // %ROWTYPE and column references are fine; only statement targets matter.
        .filter((m) => !body.slice(Math.max(0, m.index! - 8), m.index!).includes("public."));
      expect(hits).toEqual([]);
    }
    expect(body).toContain("public.pending_sessions");
  });

  it("revokes PUBLIC, anon and authenticated and grants only service_role", () => {
    for (const fn of [
      "open_or_rotate_produce_structured_session",
      "close_produce_structured_session",
      "check_pending_close_ready",
    ]) {
      expect(code).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}[\\s\\S]{0,300}?FROM PUBLIC;`));
      expect(code).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}[\\s\\S]{0,300}?FROM anon, authenticated;`));
      expect(code).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}[\\s\\S]{0,300}?TO service_role;`));
    }
    expect(code).not.toMatch(/GRANT EXECUTE[^;]*TO (anon|authenticated|PUBLIC)/);
  });

  it("exposes no generic privileged write surface", () => {
    const body = functionBody("open_or_rotate_produce_structured_session");
    // One table, one session key. No produce tables, no dynamic SQL, no delete.
    expect(body).not.toContain("produce_sessions");
    expect(body).not.toContain("produce_items");
    expect(body).not.toMatch(/EXECUTE\s+format/i);
    expect(body).not.toMatch(/\bDELETE\b/);
    expect(body).toContain("WHERE session_key = p_session_key");
  });

  it("does not harden or rewrite the rest of the Produce RPC family", () => {
    for (const sibling of [
      "append_pending_session",
      "admit_pending_session_event",
      "register_pending_session_ingest",
      "claim_pending_close_finalize",
      "try_finalize_pending_generation",
    ]) {
      expect(code).not.toContain(`CREATE OR REPLACE FUNCTION public.${sibling}`);
    }
  });
});

// ── 20. No cancel, no hard delete, no menu surface ────────────────────────────

describe("0049 — deliberately out of scope", () => {
  it("adds no cancel command and no hard-delete surface", () => {
    expect(code).not.toMatch(/cancel/i);
    expect(code).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    expect(code).not.toMatch(/^\s*DELETE\s+FROM/mi);
  });

  it("ships no Guided Menu surface", () => {
    for (const forbidden of [
      "line_operator_identities",
      "line_menu_states",
      "quick_reply",
      "flex_message",
      "liff",
    ]) {
      expect(code.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("does not touch reserved 0042, 0044 or 0048 territory", () => {
    expect(code).not.toMatch(/\\i\s|\\ir\s/);
    expect(code).not.toContain("CREATE OR REPLACE FUNCTION public.register_pending_session_ingest");
    expect(code).not.toContain("supabase_migrations");
  });
});

// ── 13/14. Structured finalization ────────────────────────────────────────────

describe("0049 — structured finalization path", () => {
  it("selects the structured path only from database-enforced metadata", async () => {
    const source = await Bun.file(finalizerPath).text();
    expect(source).toContain("const seed = buildSeedFromStructuredMetadata(");
    expect(source).toContain("if (seed) {");
  });

  it("keeps active subunit confirmation on the structured frozen seed", async () => {
    const source = await Bun.file(new URL("./webhook-service.ts", import.meta.url)).text();
    const branch = source.slice(
      source.indexOf("const subunitConfirm = parseSubunitConfirmCommandLine"),
      source.indexOf("if (subunitConfirm) {", source.indexOf("const subunitConfirm")) + 2500,
    );
    expect(branch).toContain("buildSeedFromStructuredMetadata(structured)");
    expect(branch).toContain("structured.business_date ?? bangkokToday()");
    expect(branch).toContain("structured.market_label ?? null");
    expect(branch).toContain("structured.staff_label ?? null");
    expect(branch.indexOf("if (expired)")).toBeLessThan(branch.indexOf("confirmProduceSubunitReview"));
  });

  it("consumes only the admitted set through the close boundary", async () => {
    const source = await Bun.file(finalizerPath).text();
    const seedBranch = source.slice(
      source.indexOf("if (seed) {"),
      source.indexOf("} else if (hasHeaderInLedger("),
    );
    // Both ledgers are loaded and intersected — not the ingest ledger alone.
    expect(seedBranch).toContain("service.loadAdmissionRows(");
    expect(seedBranch).toContain("buildAdmittedStructuredText(");
    expect(seedBranch).toContain("admissionRows,");
    expect(seedBranch).toContain("ingestRows,");
    expect(seedBranch).toContain("snapshot.accumulated_text,");
    // No header authority, no reconstruction, no synthesis in the seeded branch.
    expect(seedBranch).not.toContain("hasHeaderInLedger");
    expect(seedBranch).not.toContain("rebuildForFinalization");
    expect(source).toContain("loadIngestRows");
  });

  it("fails closed rather than parsing an unadmitted or mismatched row", async () => {
    const source = await Bun.file(finalizerPath).text();
    const helper = source.slice(
      source.indexOf("export function buildAdmittedStructuredText("),
      source.indexOf("// Day context for the addition reply"),
    );
    for (const guard of [
      "was never admitted",
      "has no matching ingest row",
      "timestamp conflict",
      "duplicate admission event",
      "duplicate ingest event",
      "has no ingest text",
    ]) {
      expect(helper).toContain(guard);
    }
    // It throws; the caller's catch records a reconstruction error and leaves
    // finalText at the structured row's empty accumulated_text.
    expect(helper).toMatch(/throw new Error/);
    expect(source).toContain("reconstructionErrors.push(");
  });

  it("changes nothing about the legacy admitted-set handling", async () => {
    const source = await Bun.file(finalizerPath).text();
    const legacyBranch = source.slice(
      source.indexOf("} else if (hasHeaderInLedger("),
      source.indexOf("} catch (error) {"),
    );
    // The legacy/plain-text path now delegates ledger composition to the
    // extracted plainTextIngestDocument helper (shared with กู้รายการล่าสุด
    // recovery so both paths order the ledger identically). The contract
    // this test protects is unchanged by that extraction: the legacy branch
    // must never reach for the structured admitted-set machinery, and
    // whatever it delegates to must still compose strictly from ingest
    // rows' raw_text.
    expect(legacyBranch).toContain("plainTextIngestDocument(");
    expect(legacyBranch).not.toContain("buildAdmittedStructuredText");
    expect(legacyBranch).not.toContain("loadAdmissionRows");

    const helperStart = source.indexOf("export function plainTextIngestDocument(");
    expect(helperStart).toBeGreaterThan(-1);
    const helperEnd = source.indexOf("\nfunction hasHeaderInLedger(", helperStart);
    expect(helperEnd).toBeGreaterThan(helperStart);
    const helperBody = source.slice(helperStart, helperEnd);
    expect(helperBody).toContain("ingestRows.map((row) => row.raw_text).join");
    expect(helperBody).not.toContain("buildAdmittedStructuredText");
    expect(helperBody).not.toContain("loadAdmissionRows");
  });

  it("seeds the parser instead of reconstructing a header", async () => {
    const source = await Bun.file(finalizerPath).text();
    expect(source).toContain("parseWeighSession(finalText, bangkokBusinessDateNow(), fallbackTime, seed)");
  });

  it("hashes and persists the canonicalized business identity while retaining compatibility hashes", async () => {
    const source = await Bun.file(finalizerPath).text();
    expect(source).toContain("const persistedParsed: WeighSession = { ...parsed, items: persistedItems }");
    expect(source).toContain("item_hash: computeItemHash(persistedParsed, item)");
    expect(source).toContain("const businessFingerprint = computeSessionHash(persistedParsed)");
    expect(source).toContain("computeSessionHash(parsed)");
  });

  it("keeps the legacy branch intact", async () => {
    const source = await Bun.file(finalizerPath).text();
    expect(source).toContain("} else if (hasHeaderInLedger(snapshot, ingestRows)) {");
    expect(source).toContain("finalText = await service.rebuildForFinalization(snapshot, closeTimestamp);");
  });
});

// ── B2/B3. Command-service guards run before any I/O ──────────────────────────

describe("0049 — command guards precede every read and write", () => {
  const commandsPath = new URL("./produce-session-commands.ts", import.meta.url);

  it("validates the append command before the lookup and the RPC", async () => {
    const source = await Bun.file(commandsPath).text();
    const append = source.slice(source.indexOf("private async append("));
    const guard = append.indexOf("validateAppendCommand(command)");
    const lookup = append.indexOf("this.pending.lookup(");
    const rpc = append.indexOf("this.pending.append(");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(lookup);
    expect(guard).toBeLessThan(rpc);
  });

  it("validates the source binding before dispatching any command", async () => {
    const source = await Bun.file(commandsPath).text();
    const execute = source.slice(
      source.indexOf("async execute("),
      source.indexOf("private async open("),
    );
    expect(execute).toContain("validateCommandSource(source)");
    expect(execute.indexOf("validateCommandSource(source)"))
      .toBeLessThan(execute.indexOf("switch (command.kind)"));
  });

  it("rejects blank text, blank ids and non-integer timestamps", async () => {
    const source = await Bun.file(commandsPath).text();
    const validator = source.slice(
      source.indexOf("function validateAppendCommand("),
      source.indexOf("export function validateCommandSource("),
    );
    expect(validator).toContain('command.text.trim() === ""');
    expect(validator).toContain("Number.isSafeInteger(command.lineTimestampMs)");
    expect(validator).toContain("command.lineEventId?.trim()");
    expect(validator).toContain("expectedSessionGeneration");
  });
});

// ── 7 (webhook side) / 15. Legacy text flow unchanged ─────────────────────────

describe("0049 — legacy text flow", () => {
  it("refuses a text header on a structured row before append/admit/ingest", async () => {
    const source = await Bun.file(webhookPath).text();
    const guard = source.indexOf("text header refused for structured produce session");
    const replace = source.indexOf("pendingService.openPlainTextGeneration({");
    const append = source.indexOf("pendingService.append(");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(replace);
    expect(guard).toBeLessThan(append);
    expect(source).toContain("entry_origin != null");
  });

  it("keeps structured guards while plain-text open becomes one atomic RPC", async () => {
    const source = await Bun.file(webhookPath).text();
    expect(source).toContain("requiresFreshPendingGeneration(pending.accumulated_text, incomingHeader)");
    expect(source).toContain("pendingService.openPlainTextGeneration({");
    expect(source).not.toContain("await pendingService.admit(sessionKey, eventId, event.timestamp);");
    expect(source).not.toContain("await pendingService.registerIngest(sessionKey, eventId, event.timestamp, text);");
  });
});
