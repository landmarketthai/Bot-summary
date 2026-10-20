import { describe, expect, it } from "bun:test";
import { buildImageAccountingNotice } from "@/lib/slips/batch-finalizer";
import { SlipImageIngestionService, type SlipImageAccounting } from "@/lib/slips/image-ingestion";

function service(rpc: (name: string) => Promise<{ data: unknown; error: unknown }>) {
  const ingested: string[] = [];
  const scheduled: string[] = [];
  const svc = new SlipImageIngestionService(
    { rpc } as never,
    { ingest: async (input) => { ingested.push(input.lineMessageId); throw new Error("must not ingest"); } },
    (id) => scheduled.push(id),
  );
  return { svc, ingested, scheduled };
}

describe("SlipImageIngestionService", () => {
  it("falls back to the legacy path when the ledger RPCs are not deployed", async () => {
    const { svc, ingested } = service(async () => ({
      data: null,
      error: { code: "PGRST202", message: "Could not find the function in the schema cache" },
    }));
    expect((await svc.process("m1")).outcome).toBe("no_ledger");
    expect(ingested).toEqual([]);
  });

  it("falls back when a test double has no such rpc", async () => {
    const { svc } = service(async (name) => { throw new Error(`unexpected rpc: ${name}`); });
    expect((await svc.process("m1")).outcome).toBe("no_ledger");
  });

  it("does nothing when another worker owns the attempt", async () => {
    const { svc, ingested } = service(async () => ({ data: { claimed: false, reason: "locked" }, error: null }));
    expect((await svc.process("m1")).outcome).toBe("not_claimed");
    expect(ingested).toEqual([]);
  });

  it("maps resolved ledger rows to their durable outcome without re-ingesting", async () => {
    const { svc, ingested } = service(async () => ({
      data: { claimed: false, reason: "resolved", state: "attached" }, error: null,
    }));
    expect((await svc.process("m1")).outcome).toBe("already_attached");
    expect(ingested).toEqual([]);
  });

  it("records a thrown ingest as a retry, never as success", async () => {
    const calls: string[] = [];
    const rpc = async (name: string) => {
      calls.push(name);
      if (name === "begin_slip_image_attempt") {
        return { data: { claimed: true, raw_message_id: "r", batch_id: "b", source_id: "s", source_type: "group", event_ts_ms: 1, attempt: 1 }, error: null };
      }
      if (name === "fail_slip_image_event") return { data: { outcome: "retry_pending" }, error: null };
      return { data: null, error: null };
    };
    const stored = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }), rpc };
    const svc = new SlipImageIngestionService(
      stored as never,
      { ingest: async () => { throw new Error("boom"); } },
      () => { throw new Error("OCR must not be scheduled"); },
    );
    expect((await svc.process("m1")).outcome).toBe("retry_pending");
    expect(calls).toEqual(["begin_slip_image_attempt", "fail_slip_image_event"]);
  });
});

describe("cron redrive lanes (P1 #4)", () => {
  const ids = Array.from({ length: 25 }, (_, i) => `ev-${i + 1}`);
  const listing = (async (name: string) => {
    if (name !== "list_slip_ocr_redrive") throw new Error(`unexpected rpc ${name}`);
    return { data: ids, error: null };
  });

  it("healthy OCR: the lanes drain the whole fair list in one sweep", async () => {
    const { svc } = service(listing);
    let inFlight = 0;
    let peak = 0;
    const done: string[] = [];
    const count = await svc.redriveOcr(async (id) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      done.push(id);
    }, undefined, Date.now() + 40_000);
    expect(count).toBe(25);
    expect(new Set(done).size).toBe(25);
    expect(peak).toBe(10); // bounded concurrency: ocrLanes
  });

  it("slow OCR: lanes start no job that cannot finish; the guaranteed floor is one job per lane", async () => {
    const { svc } = service(listing);
    const started: string[] = [];
    // 30.3 s left: every lane may start one 30 s job, then less than 30 s remains.
    const count = await svc.redriveOcr(async (id) => {
      started.push(id);
      await new Promise((r) => setTimeout(r, 400));
    }, undefined, Date.now() + 30_300);
    expect(count).toBe(10);
    expect(started).toEqual(ids.slice(0, 10)); // list order (least-claimed first) is respected
  });
});

describe("buildImageAccountingNotice", () => {
  const base: SlipImageAccounting = {
    batch_id: "b", received_total: 25, attached: 25, waiting: 0, retry_pending: 0, queue_dead: 0,
    failed_permanent: 0, late_after_finalize: 0, excluded_after_close: 0, excluded_not_slip: 0,
    ocr_complete: 25, ocr_pending: 0, incomplete: 0, oldest_unresolved_age_seconds: null,
  };

  it("is silent when every received image is accounted for (existing output unchanged)", () => {
    expect(buildImageAccountingNotice(null)).toBeNull();
    expect(buildImageAccountingNotice(base)).toBeNull();
  });

  it("states the gap and refuses to present the partial sum as complete", () => {
    const notice = buildImageAccountingNotice({ ...base, attached: 19, incomplete: 6, failed_permanent: 4, waiting: 2 })!;
    expect(notice).toContain("ยอดนี้ยังไม่ครบ ห้ามใช้เป็นยอดรวมทั้งหมด");
    expect(notice).toContain("รับรูปจาก LINE: 25 รูป");
    expect(notice).toContain("เข้าชุดแล้ว: 19 รูป");
    expect(notice).toContain("ประมวลผลไม่สำเร็จ: 4 รูป");
    expect(notice).toContain("ยังประมวลผลไม่เสร็จ: 2 รูป");
  });
});
