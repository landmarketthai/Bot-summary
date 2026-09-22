import { describe, expect, it } from "bun:test";
import {
  buildSettlementSheetEvidencePath,
  computeSha256,
  SETTLEMENT_SHEET_BUCKET,
  SettlementSheetEvidenceService,
} from "./evidence-service";
import { createFakeSettlementSheetClient } from "./test-support";
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

function input(overrides: Partial<Parameters<SettlementSheetEvidenceService["ingest"]>[0]> = {}) {
  return {
    rawMessageId: "raw-1",
    lineMessageId: "line-msg-1",
    sourceId: "g1",
    sourceType: "group",
    lineUserId: "submitter",
    context,
    ...overrides,
  };
}

describe("buildSettlementSheetEvidencePath", () => {
  it("builds the private storage path", () => {
    expect(buildSettlementSheetEvidencePath({
      businessDate: "2026-09-21",
      sourceId: "g1",
      lineMessageId: "line-msg-1",
    })).toBe("settlement-sheets/2026-09-21/g1/line-msg-1.jpg");
  });
});

describe("SettlementSheetEvidenceService.ingest", () => {
  it("uploads the image and records a new PROCESSING draft", async () => {
    const fake = createFakeSettlementSheetClient();
    const bytes = new Uint8Array([1, 2, 3]);
    const service = new SettlementSheetEvidenceService(fake.client, async () => ({
      bytes, mimeType: "image/jpeg",
    }));

    const result = await service.ingest(input());

    expect(result.kind).toBe("new");
    if (result.kind !== "new") throw new Error("expected new");
    expect(result.draft.status).toBe("PROCESSING");
    expect(result.draft.sha256).toBe(computeSha256(bytes));
    expect(result.draft.market_label).toBe("วัดทุ่งลานนา");
    expect(result.draft.business_date).toBe("2026-09-21");
    expect(fake.uploads).toEqual([{
      bucket: SETTLEMENT_SHEET_BUCKET,
      path: "settlement-sheets/2026-09-21/g1/line-msg-1.jpg",
      bytes: [1, 2, 3],
      contentType: "image/jpeg",
    }]);
    expect(fake.rawUpdates).toEqual([{ is_processed: true }]);
  });

  it("retry/idempotency: redelivering the same LINE message does not create a second row", async () => {
    const fake = createFakeSettlementSheetClient();
    const service = new SettlementSheetEvidenceService(fake.client, async () => ({
      bytes: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg",
    }));

    const first = await service.ingest(input());
    const second = await service.ingest(input());

    expect(first.kind).toBe("new");
    expect(second.kind).toBe("already_ingested");
    if (second.kind !== "already_ingested" || first.kind !== "new") throw new Error("unexpected kind");
    expect(second.draft.id).toBe(first.draft.id);
    expect(fake.drafts).toHaveLength(1);
    // Only the first ingest marks the raw message processed.
    expect(fake.rawUpdates).toHaveLength(1);
  });

  it("duplicate image: a forwarded copy with a different message id is flagged, not re-processed as new", async () => {
    const fake = createFakeSettlementSheetClient();
    const bytes = new Uint8Array([9, 9, 9]);
    const service = new SettlementSheetEvidenceService(fake.client, async () => ({
      bytes, mimeType: "image/jpeg",
    }));

    const first = await service.ingest(input({ lineMessageId: "line-msg-1" }));
    if (first.kind !== "new") throw new Error("expected new");
    // Simulate the original draft having already been processed and templated.
    fake.drafts.find((r) => r.id === first.draft.id)!.template_text = "PRIOR TEMPLATE";
    fake.drafts.find((r) => r.id === first.draft.id)!.status = "READY";

    const second = await service.ingest(input({ lineMessageId: "line-msg-2" }));

    expect(second.kind).toBe("duplicate_image");
    if (second.kind !== "duplicate_image") throw new Error("expected duplicate_image");
    expect(second.original.id).toBe(first.draft.id);
    expect(second.draft.status).toBe("DUPLICATE_IMAGE");
    expect(second.draft.template_text).toBe("PRIOR TEMPLATE");
    expect(fake.drafts).toHaveLength(2);
  });

  it("does not flag two DIFFERENT images (different bytes) sent in the same round as duplicates", async () => {
    const fake = createFakeSettlementSheetClient();
    let call = 0;
    const service = new SettlementSheetEvidenceService(fake.client, async () => {
      call += 1;
      return { bytes: new Uint8Array([call]), mimeType: "image/jpeg" };
    });

    const first = await service.ingest(input({ lineMessageId: "line-msg-1" }));
    const second = await service.ingest(input({ lineMessageId: "line-msg-2" }));

    expect(first.kind).toBe("new");
    expect(second.kind).toBe("new");
  });

  it("records a FAILED draft when the LINE download fails, and does not upload anything", async () => {
    const fake = createFakeSettlementSheetClient();
    const service = new SettlementSheetEvidenceService(fake.client, async () => {
      throw new Error("network error");
    });

    const result = await service.ingest(input());

    expect(result.kind).toBe("failed");
    expect(fake.uploads).toHaveLength(0);
    if (result.kind === "failed") {
      expect(result.draft?.status).toBe("FAILED");
      expect(result.reason).toBe("download_failed");
    }
  });

  it("records a FAILED draft when private storage upload fails", async () => {
    const fake = createFakeSettlementSheetClient({ storageError: "bucket unavailable" });
    const service = new SettlementSheetEvidenceService(fake.client, async () => ({
      bytes: new Uint8Array([4, 5, 6]), mimeType: "image/png",
    }));

    const result = await service.ingest(input());

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.draft?.status).toBe("FAILED");
      expect(result.reason).toBe("storage_failed");
    }
  });
});
