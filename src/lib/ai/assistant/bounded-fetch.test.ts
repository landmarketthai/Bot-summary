import { describe, expect, test } from "bun:test";
import { boundedJobFetch } from "./bounded-fetch";

function controllableFetch() {
  let inFlight = 0;
  let peak = 0;
  const pending: Array<() => void> = [];
  const aborted: string[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    const done = () => { inFlight -= 1; resolve(new Response("{}")); };
    pending.push(done);
    init?.signal?.addEventListener("abort", () => {
      inFlight -= 1;
      aborted.push(String(input));
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
  })) as typeof fetch;
  return { fetchImpl, release: () => pending.shift()?.(), peak: () => peak, inFlight: () => inFlight, aborted };
}

describe("bounded job fetch", () => {
  test("never has more than maxOutstanding requests in flight", async () => {
    const io = controllableFetch();
    const bounded = boundedJobFetch({ deadlineMs: Date.now() + 5_000, callTimeoutMs: 5_000, maxOutstanding: 2, fetchImpl: io.fetchImpl });
    const calls = Array.from({ length: 5 }, (_, i) => bounded(`https://db/${i}`));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(io.inFlight()).toBe(2);
    for (let i = 0; i < 5; i += 1) {
      io.release();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await Promise.all(calls);
    expect(io.peak()).toBe(2);
  });

  test("aborts in-flight requests at the job deadline and refuses new ones", async () => {
    const io = controllableFetch();
    const bounded = boundedJobFetch({ deadlineMs: Date.now() + 80, callTimeoutMs: 5_000, maxOutstanding: 4, fetchImpl: io.fetchImpl });
    const started = Date.now();
    await expect(bounded("https://db/slow")).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(500);
    expect(io.aborted).toEqual(["https://db/slow"]);
    await expect(bounded("https://db/late")).rejects.toMatchObject({ name: "AbortError" });
  });

  test("waiting calls are served in order and all end at the deadline", async () => {
    const io = controllableFetch();
    const bounded = boundedJobFetch({ deadlineMs: Date.now() + 150, callTimeoutMs: 5_000, maxOutstanding: 1, fetchImpl: io.fetchImpl });
    const order: string[] = [];
    const settle = (name: string, call: Promise<Response>) =>
      call.then(() => { order.push(`${name}:ok`); }, (error: unknown) => { order.push(`${name}:${(error as Error).name}`); });
    const all = Promise.all([settle("a", bounded("https://db/a")), settle("b", bounded("https://db/b")), settle("c", bounded("https://db/c"))]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    io.release(); // a finishes, b gets the slot
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(io.inFlight()).toBe(1);
    await all;
    // b and c both end at the same deadline; their relative order is not meaningful.
    expect(order[0]).toBe("a:ok");
    expect(order.slice(1).sort()).toEqual(["b:AbortError", "c:AbortError"]);
    expect(io.peak()).toBe(1);
  });
});
