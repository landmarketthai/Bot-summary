import { beforeEach, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";
import { fixtureClient } from "../../../../../scripts/release-uat-monthly";

let fake = fixtureClient(0);
let networkAttempts = 0;
const originalFetch = globalThis.fetch;
beforeEach(() => { fake = fixtureClient(0); networkAttempts = 0; });
mock.module("@/lib/supabase/server", () => ({ createServiceClient: () => fake.client }));
const { GET } = await import("./route");

async function preview(scope = "&market=ราชพฤกษ์&seller=ผู้ขาย0") {
  globalThis.fetch = (() => { networkAttempts++; throw new Error("network forbidden"); }) as unknown as typeof fetch;
  try {
    const response = await GET(new NextRequest(`http://localhost/api/settlement/yod-song?date=2026-10-07${scope}`));
    expect(networkAttempts).toBe(0);
    return { response, body: await response.json() };
  } finally { globalThis.fetch = originalFetch; }
}

test("unbound retained return makes yod-song null, although withdrawal money exists", async () => {
  const { response, body } = await preview();
  expect(response.status).toBe(200);
  expect(body.เบิก).toBe(5000);
  expect(body.ยอดส่ง).toBeNull();
  expect(body.produceValueStatus).toBe("blocked");
});

test("only resolved evidence and ready rounds allow numeric yod-song", async () => {
  fake = fixtureClient(0, { resolved: true });
  const { body } = await preview();
  expect(body.ยอดส่ง).toBe(4000);
  expect(body.produceValueStatus).toBe("complete");
});

test("missing required evidence table fails closed", async () => {
  fake = fixtureClient(0, { missingEvidence: true });
  const { body } = await preview();
  expect(body.ยอดส่ง).toBeNull();
  expect(body.produceValueStatus).toBe("blocked");
});

test("missing seller or market cannot certify money", async () => {
  for (const scope of ["", "&seller=ผู้ขาย0", "&market=ราชพฤกษ์"]) {
    const { body } = await preview(scope);
    expect(body.ยอดส่ง).toBeNull();
    expect(body.produceValueStatus).toBe("blocked");
  }
});

test("a missing date is rejected before reading tables", async () => {
  const response = await GET(new NextRequest("http://localhost/api/settlement/yod-song"));
  expect(response.status).toBe(400);
  expect(fake.queries).toEqual({});
});
