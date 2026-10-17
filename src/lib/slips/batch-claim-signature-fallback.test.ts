import { describe, expect, it } from "bun:test";
import { finalizeClosingSlipBatches } from "@/lib/slips/batch-finalizer";

describe("claim_closing_slip_batch rollout safety", () => {
  it("retries with the 3-argument signature when code is deployed before the ledger migration", async () => {
    const rpcArgs: Array<Record<string, unknown>> = [];
    const supabase = {
      from: () => ({ select: () => ({ eq: async () => ({ data: [{ id: "b1", source_id: "s1" }], error: null }) }) }),
      rpc: async (_name: string, args: Record<string, unknown>) => {
        rpcArgs.push(args);
        if ("p_ingest_max_seconds" in args) {
          return { data: null, error: { code: "PGRST202", message: "Could not find the function in the schema cache" } };
        }
        return { data: [{ claimed_id: "b1", claimed_source_id: "s1", was_timeout: false }], error: null };
      },
    };
    const finalized: string[] = [];
    const count = await finalizeClosingSlipBatches(
      supabase as never,
      async () => {},
      10,
      120,
      async (_s, batchId) => { finalized.push(batchId); },
    );
    expect(count).toBe(1);
    expect(finalized).toEqual(["b1"]);
    expect(rpcArgs).toHaveLength(2);
    expect("p_ingest_max_seconds" in rpcArgs[1]).toBe(false);
  });
});
