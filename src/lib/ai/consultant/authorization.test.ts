import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  authorizeStaffQuery,
  normalizeStaffName,
  resolveConsultantScope,
} from "./authorization";
import type { ConsultantScope } from "./types";

function identities(rows: Record<string, { staff_label: string; active: boolean }>) {
  return {
    from: () => {
      let id = "";
      const chain = {
        select: () => chain,
        eq: (_column: string, value: string) => { id = value; return chain; },
        maybeSingle: async () => ({ data: rows[id] ?? null, error: null }),
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

const options = {
  allowedSourceIds: new Set(["Cmgmt", "Cworkers", "Uboss"]),
  managementSourceIds: new Set(["Cmgmt"]),
  supervisorIds: new Set(["Uboss"]),
  runtimeEnvironment: "production" as const,
};

describe("consultant scope resolution", () => {
  test("worker scope is own rows in the asking chat with the trusted label", async () => {
    const result = await resolveConsultantScope(
      identities({ Unoi: { staff_label: "น้อย", active: true } }),
      { sourceId: "Cworkers", lineUserId: "Unoi", sourceType: "group" },
      options,
    );
    expect(result).toEqual({
      ok: true,
      scope: { kind: "own", lineUserId: "Unoi", sourceId: "Cworkers", staffLabel: "น้อย", runtimeEnvironment: "production" },
    });
  });

  test("inactive identity mapping gives no name shortcut", async () => {
    const result = await resolveConsultantScope(
      identities({ Unoi: { staff_label: "น้อย", active: false } }),
      { sourceId: "Cworkers", lineUserId: "Unoi", sourceType: "group" },
      options,
    );
    expect(result.ok && result.scope.staffLabel).toBeNull();
  });

  test("chat outside both allowlists is refused before any lookup", async () => {
    const result = await resolveConsultantScope(
      identities({}),
      { sourceId: "Cunknown", lineUserId: "Unoi", sourceType: "group" },
      options,
    );
    expect(result).toEqual({ ok: false, reason: "source_not_allowed" });
  });

  test("supervisor in a worker group sees only that group", async () => {
    const result = await resolveConsultantScope(
      identities({}),
      { sourceId: "Cworkers", lineUserId: "Uboss", sourceType: "group" },
      options,
    );
    expect(result.ok && result.scope.kind === "supervisor" && result.scope.sourceIds).toEqual(["Cworkers"]);
  });

  test("supervisor in a management chat or DM sees every allowlisted chat", async () => {
    for (const [sourceId, sourceType] of [["Cmgmt", "group"], ["Uboss", "user"]] as const) {
      const result = await resolveConsultantScope(
        identities({}),
        { sourceId, lineUserId: "Uboss", sourceType },
        options,
      );
      expect(result.ok && result.scope.kind === "supervisor" && [...result.scope.sourceIds].sort())
        .toEqual(["Cmgmt", "Cworkers", "Uboss"]);
    }
  });
});

describe("staff name authorization", () => {
  const own = (staffLabel: string | null): ConsultantScope => ({
    kind: "own", lineUserId: "U", sourceId: "C", staffLabel, runtimeEnvironment: "production",
  });

  test("a polite prefix alone is never stripped to an empty name", () => {
    expect(normalizeStaffName("พี่")).toBe("พี่");
    expect(normalizeStaffName("พี่ น้อย")).toBe("น้อย");
    expect(normalizeStaffName("น้อย​")).toBe("น้อย");
  });

  test("worker may name themself, never someone else", () => {
    expect(authorizeStaffQuery(own("น้อย"), "พี่น้อย")).toBe("self");
    expect(authorizeStaffQuery(own("น้อย"), "แดง")).toBe("denied");
    expect(authorizeStaffQuery(own(null), "น้อย")).toBe("denied");
    expect(authorizeStaffQuery(own("น้อย"), "พี่")).toBe("denied");
  });
});
