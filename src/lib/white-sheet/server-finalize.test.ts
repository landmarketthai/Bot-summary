import { expect, mock, test } from "bun:test";
import type { DigitalWhiteSheetPageModel } from "./compose";
import { RETURN_EVIDENCE_INCOMPLETE_WARNING_PREFIX } from "./warnings";

// Keep the real trust guard; fake only the loaded page model and persistence boundary.
const compose = await import("./compose");
let warnings = [RETURN_EVIDENCE_INCOMPLETE_WARNING_PREFIX];
let finalizeCalls = 0;
let networkAttempts = 0;
mock.module("server-only", () => ({}));
mock.module("@/lib/supabase/server", () => ({ createServiceClient: () => ({}) }));
mock.module("./compose", () => ({ ...compose,
  loadDigitalWhiteSheetPageModel: async () => ({ entryStatus: "submitted", summary: { warnings } }) as DigitalWhiteSheetPageModel,
}));
const persist = await import("./persist");
mock.module("./persist", () => ({ ...persist, finalizeWhiteSheetCashEntry: async () => {
  finalizeCalls++; return { status: "finalized" };
} }));
const { finalizeServerWhiteSheetCashEntry } = await import("./server");
const identity = { sourceId: "Cuat", marketLabelNormalized: "ราชพฤกษ์", businessDate: "2026-10-07" };

test("return hard stop blocks finalize before persistence; a trusted read can finalize", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => { networkAttempts++; throw new Error("network forbidden"); }) as unknown as typeof fetch;
  try {
    await expect(finalizeServerWhiteSheetCashEntry(identity, "uat-admin")).rejects.toBeInstanceOf(compose.WhiteSheetHardStopError);
    expect(finalizeCalls).toBe(0);
    warnings = [];
    expect((await finalizeServerWhiteSheetCashEntry(identity, "uat-admin")).status).toBe("finalized");
    expect(finalizeCalls).toBe(1);
    expect(networkAttempts).toBe(0);
  } finally { globalThis.fetch = originalFetch; }
});
