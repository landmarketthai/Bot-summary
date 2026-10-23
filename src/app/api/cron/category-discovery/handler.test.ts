import { afterEach, describe, expect, test } from "bun:test";
import { handleCategoryDiscovery } from "./handler";

const saved = process.env.CRON_SECRET;
afterEach(() => { process.env.CRON_SECRET = saved; });

const deps = (getClient: () => never) => ({ getClient, push: async () => { throw new Error("must not push"); } });

describe("category discovery cron", () => {
  test("rejects a missing or wrong secret without touching the database", async () => {
    process.env.CRON_SECRET = "s3cret";
    const res = await handleCategoryDiscovery(new Request("http://x", { headers: { authorization: "Bearer nope" } }),
      deps(() => { throw new Error("must not connect"); }));
    expect(res.status).toBe(401);
  });

  test("10. a discovery failure is contained to this route", async () => {
    process.env.CRON_SECRET = "s3cret";
    const res = await handleCategoryDiscovery(new Request("http://x", { headers: { authorization: "Bearer s3cret" } }),
      deps(() => { throw new Error("db down"); }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "category discovery failed" });
  });

  test("requeue accepts only `blocked` and a configured review group", async () => {
    process.env.CRON_SECRET = "s3cret";
    const savedGroups = process.env.CATEGORY_REVIEW_LINE_GROUP_IDS;
    process.env.CATEGORY_REVIEW_LINE_GROUP_IDS = "C-review";
    try {
      for (const query of ["?requeue=all", "?requeue=blocked&group=C-operations"]) {
        const res = await handleCategoryDiscovery(new Request(`http://x/${query}`, { headers: { authorization: "Bearer s3cret" } }),
          deps(() => { throw new Error("must not connect"); }));
        expect(res.status).toBe(400);
      }
      const calls: unknown[] = [];
      const client = {
        rpc: async (name: string, args: unknown) => { calls.push([name, args]); throw new Error("stop after requeue"); },
      };
      await handleCategoryDiscovery(new Request("http://x/?requeue=blocked&group=C-review", { headers: { authorization: "Bearer s3cret" } }),
        deps(() => client as never));
      expect(calls).toEqual([["requeue_produce_category_deliveries", { p_group_id: "C-review" }]]);
    } finally {
      process.env.CATEGORY_REVIEW_LINE_GROUP_IDS = savedGroups;
    }
  });
});
