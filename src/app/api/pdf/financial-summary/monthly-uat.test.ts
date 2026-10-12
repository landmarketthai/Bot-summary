import { expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";
import type { GroupRow } from "@/components/financial-summary/FinancialTable";
import { fixtureClient } from "../../../../../scripts/release-uat-monthly";

let fake = fixtureClient(0);
let renderedGroups: GroupRow[] = [];
mock.module("@/lib/supabase/server", () => ({ createServiceClient: () => fake.client }));
const renderer = await import("@react-pdf/renderer");
const renderToBuffer = renderer.renderToBuffer;
mock.module("@react-pdf/renderer", () => ({ ...renderer,
  renderToBuffer: async (document: Parameters<typeof renderer.renderToBuffer>[0]) => {
    renderedGroups = (document.props as { groups: GroupRow[] }).groups;
    return renderToBuffer(document);
  },
}));
const { GET } = await import("./route");

for (const resolved of [false, true]) {
  test(`31-day financial PDF: ${resolved ? "resolved" : "unbound failed return"}, real local renderer, no network`, async () => {
    fake = fixtureClient(0, { resolved });
    const originalFetch = globalThis.fetch;
    let networkAttempts = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      // Yoga's installed WASM uses a data URL; reading embedded bytes opens no socket.
      if (url.protocol === "data:") return originalFetch(input, init);
      networkAttempts++; throw new Error("network forbidden");
    }) as typeof fetch;
    try {
      const start = performance.now();
      const response = await GET(new NextRequest("http://localhost/api/pdf/financial-summary?month=2026-10"));
      const pdf = Buffer.from(await response.arrayBuffer());
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/pdf");
      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
      expect(pdf.length).toBeGreaterThan(1000);
      expect(renderedGroups).toHaveLength(310);
      expect(renderedGroups.every((group) => group.produceNetStatus === (resolved ? "trusted" : "return_incomplete"))).toBe(true);
      expect(fake.queries.accountability_rounds).toBe(93);
      if (!resolved) expect(fake.queries.pending_session_ingest).toBe(31 * 13);
      expect(networkAttempts).toBe(0);
      console.log(JSON.stringify({ monthlyPdf: resolved ? "resolved" : "pending", ms: performance.now() - start,
        bytes: pdf.length, groups: renderedGroups.length, queries: fake.queries,
        totalQueries: Object.values(fake.queries).reduce((a, b) => a + b, 0), networkAttempts }));
    } finally { globalThis.fetch = originalFetch; }
  }, 30_000);
}
