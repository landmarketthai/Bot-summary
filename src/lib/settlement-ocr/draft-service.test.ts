process.env.LINE_CHANNEL_SECRET ??= "test-channel-secret";

import { describe, expect, it } from "bun:test";
import { SettlementSheetImageHandler } from "./draft-service";
import { SettlementSheetEvidenceService } from "./evidence-service";
import { createFakeSettlementSheetClient } from "./test-support";
import type {
  SettlementSheetExtraction,
  SettlementSheetExtractor,
} from "./types";
import type { GuidedJourneyContext } from "@/lib/line/guided-menu/journey";

const context: GuidedJourneyContext = {
  accountabilityRoundId: "round-1",
  sessionKey: "group:g1:user:submitter",
  sourceId: "g1",
  lineUserId: "submitter",
  sellerLabel: "กี้",
  marketLabel: "วัดทุ่งลานนา",
  marketLabelNormalized: "วัดทุ่งลานนา",
  businessDate: "2026-09-21",
  transactionType: "เบิก",
  sessionGeneration: "gen-1",
};

function money(value: number | null, confidence = 0.95) {
  return { value, confidence };
}

// The P0 real handwritten-sheet example: sales 5123, transfer 2123,
// expenses 200, cash_submitted 2800, labor 550, cash_remaining 2250.
// Both sheet-internal equations hold, and so does the existing-system
// equation once money_cash is correctly mapped to cash_remaining.
function baseExtraction(overrides: Partial<SettlementSheetExtraction> = {}): SettlementSheetExtraction {
  return {
    documentType: "SETTLEMENT_SHEET",
    documentTypeConfidence: 0.95,
    marketText: "วัดทุ่งลานนา",
    dateText: "21/9/69",
    staffText: "กี้",
    salesTotal: money(5123),
    transferAmount: money(2123),
    cashSubmitted: money(2800),
    expensesTotal: money(200),
    expenseItems: [],
    laborTotal: money(550),
    laborItems: [],
    cashRemaining: money(2250),
    ...overrides,
  };
}

function fakeExtractor(extraction: SettlementSheetExtraction | (() => SettlementSheetExtraction) | Error): SettlementSheetExtractor {
  return {
    async extract() {
      if (extraction instanceof Error) throw extraction;
      return typeof extraction === "function" ? extraction() : extraction;
    },
  };
}

function harness(extraction: SettlementSheetExtraction | (() => SettlementSheetExtraction) | Error) {
  // Storage download (draft-service reading the evidence back for OCR) — the
  // extractor is faked and ignores byte content, so any fixed bytes will do.
  const fake = createFakeSettlementSheetClient({ download: { bytes: new Uint8Array([1, 2, 3]) } });
  // LINE content download (evidence-service ingesting the incoming image) —
  // fixed bytes so two separate ingests of "the same photo" hash identically,
  // which is what the duplicate-image tests below rely on.
  const evidenceService = new SettlementSheetEvidenceService(fake.client, async () => ({
    bytes: new Uint8Array([7, 7, 7]),
    mimeType: "image/jpeg",
  }));
  const pushed: Array<{ to: string; text: string }> = [];
  const handler = new SettlementSheetImageHandler(fake.client, {
    evidenceService,
    extractor: fakeExtractor(extraction),
    pushMessage: async (to, text) => { pushed.push({ to, text }); },
    scheduleBackgroundTask: (task) => { void task(); },
  });
  return { fake, pushed, handler };
}

function inputFor(lineMessageId = "line-msg-1") {
  return {
    rawMessageId: "raw-1",
    lineMessageId,
    sourceId: "g1",
    sourceType: "group",
    lineUserId: "submitter",
    context,
  };
}

async function flush() {
  // Background tasks are fire-and-forget microtasks; let them settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("SettlementSheetImageHandler — valid sheet", () => {
  it("reaches READY and sends a template that round-trips through the confirm mechanism", async () => {
    const { fake, pushed, handler } = harness(baseExtraction());
    await handler.handleImage(inputFor());
    await flush();

    expect(fake.drafts[0].status).toBe("READY");
    expect(fake.drafts[0].arithmetic_ok).toBe(true);
    expect(pushed).toHaveLength(1);
    expect(pushed[0].to).toBe("g1");
    expect(pushed[0].text).toContain("ส่งยอด");
    expect(pushed[0].text).toContain("จบส่งยอด");
  });

  // P0 regression: money_cash in the emitted template MUST be cash_remaining
  // (2250), never cash_submitted (2800). See extraction-schema.ts.
  it("P0: template's เงินสด line is cash_remaining (2250), not cash_submitted (2800)", async () => {
    const { fake, handler } = harness(baseExtraction());
    await handler.handleImage(inputFor());
    await flush();

    expect(fake.drafts[0].template_text).toContain("เงินสด 2250");
    expect(fake.drafts[0].template_text).not.toContain("เงินสด 2800");
    expect(fake.drafts[0].arithmetic_ok).toBe(true);
    expect(fake.drafts[0].arithmetic_difference).toBe(0);
  });

  it("cash_submitted != money_cash: an inflated cash_submitted does not change the template's money_cash, but does fail cashOk", async () => {
    const { fake, handler } = harness(baseExtraction({ cashSubmitted: money(9999) }));
    await handler.handleImage(inputFor());
    await flush();

    expect(fake.drafts[0].template_text).toContain("เงินสด 2250");
    expect(fake.drafts[0].status).toBe("NEEDS_REVIEW");
    expect(fake.drafts[0].arithmetic_ok).toBe(false);
  });
});

describe("SettlementSheetImageHandler — ambiguous/crossed-out values require review", () => {
  it("a low-confidence field forces NEEDS_REVIEW even though a value was read", async () => {
    const { fake, pushed, handler } = harness(
      baseExtraction({ cashSubmitted: money(800, 0.2) }),
    );
    await handler.handleImage(inputFor());
    await flush();

    expect(fake.drafts[0].status).toBe("NEEDS_REVIEW");
    expect(pushed[0].text).toContain("ไม่ชัดเจน");
  });

  it("a missing required field forces NEEDS_REVIEW and is never treated as zero", async () => {
    const { fake, handler } = harness(baseExtraction({ laborTotal: money(null, 0) }));
    await handler.handleImage(inputFor());
    await flush();

    expect(fake.drafts[0].status).toBe("NEEDS_REVIEW");
    expect(fake.drafts[0].labor_total).toBeNull();
    // The template still offers 0 as an editable starting point, never a silent guess.
    expect(fake.drafts[0].template_text).toContain("ค่าแรง 0");
  });
});

describe("SettlementSheetImageHandler — arithmetic mismatch", () => {
  it("a missing sales total is financial uncertainty and cannot become READY", async () => {
    const { fake, handler } = harness(baseExtraction({ salesTotal: money(null, 0) }));
    await handler.handleImage(inputFor());
    await flush();

    expect(fake.drafts[0].status).toBe("NEEDS_REVIEW");
    expect(fake.drafts[0].sales_total).toBeNull();
  });
  it("stays NEEDS_REVIEW and reports the mismatch instead of inventing a correction", async () => {
    const { fake, pushed, handler } = harness(
      baseExtraction({ salesTotal: money(9999) }), // transfer+cash_remaining+expenses+labor = 5123
    );
    await handler.handleImage(inputFor());
    await flush();

    expect(fake.drafts[0].status).toBe("NEEDS_REVIEW");
    expect(fake.drafts[0].arithmetic_ok).toBe(false);
    expect(fake.drafts[0].arithmetic_difference).toBe(9999 - 5123);
    expect(pushed[0].text).toContain("ยอดไม่ตรงกัน");
  });
});

describe("SettlementSheetImageHandler — unrelated image is not hijacked", () => {
  it("a photo classified OTHER is recorded silently with no LINE reply", async () => {
    const { fake, pushed, handler } = harness(
      baseExtraction({ documentType: "OTHER", documentTypeConfidence: 0.9 }),
    );
    await handler.handleImage(inputFor());
    await flush();

    expect(fake.drafts[0].status).toBe("NOT_SETTLEMENT_SHEET");
    expect(pushed).toHaveLength(0);
  });

  it("a low document-type confidence is also treated as not-a-settlement-sheet", async () => {
    const { fake, pushed, handler } = harness(
      baseExtraction({ documentType: "SETTLEMENT_SHEET", documentTypeConfidence: 0.1 }),
    );
    await handler.handleImage(inputFor());
    await flush();

    expect(fake.drafts[0].status).toBe("NOT_SETTLEMENT_SHEET");
    expect(pushed).toHaveLength(0);
  });
});

describe("SettlementSheetImageHandler — extraction failure", () => {
  it("marks FAILED and tells the sender to retry, never silently drops it", async () => {
    const { fake, pushed, handler } = harness(new Error("provider timeout"));
    await handler.handleImage(inputFor());
    await flush();

    expect(fake.drafts[0].status).toBe("FAILED");
    expect(pushed).toHaveLength(1);
    expect(pushed[0].text).toContain("ไม่สำเร็จ");
  });
});

describe("SettlementSheetImageHandler — duplicate image replay", () => {
  it("a forwarded copy of an already-processed image is never re-OCR'd or re-drafted independently", async () => {
    const { fake, pushed, handler } = harness(baseExtraction());

    await handler.handleImage(inputFor("line-msg-1"));
    await flush();
    pushed.length = 0;

    await handler.handleImage(inputFor("line-msg-2"));
    await flush();

    expect(fake.drafts).toHaveLength(2);
    expect(fake.drafts[1].status).toBe("DUPLICATE_IMAGE");
    expect(pushed).toHaveLength(1);
    expect(pushed[0].text).toContain("เคยถูกส่งมาแล้ว");
  });

  it("retry/idempotency: the exact same LINE message redelivered sends no second reply", async () => {
    const { fake, pushed, handler } = harness(baseExtraction());

    await handler.handleImage(inputFor("line-msg-1"));
    await flush();
    pushed.length = 0;

    await handler.handleImage(inputFor("line-msg-1"));
    await flush();

    expect(fake.drafts).toHaveLength(1);
    expect(pushed).toHaveLength(0);
  });
});

describe("SettlementSheetImageHandler — background ownership", () => {
  it("does not process a draft under a different LINE owner or round", async () => {
    const { fake, pushed, handler } = harness(baseExtraction());
    await handler.handleImage(inputFor());
    await flush();
    pushed.length = 0;

    await handler.processDraft(String(fake.drafts[0].id), {
      ...context,
      lineUserId: "different-user",
      sessionKey: "group:g1:user:different-user",
    });

    expect(fake.drafts[0].status).toBe("READY");
    expect(pushed).toHaveLength(0);
  });
});
