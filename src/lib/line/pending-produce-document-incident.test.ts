import { describe, expect, it } from "bun:test";
import type { PendingSession, PendingSessionService } from "./pending-session-service";
import { loadPlainTextProduceDocument, parsePlainTextProduceDocument } from "./pending-produce-document";

/**
 * Incident-shaped synthetic fixture, NOT a transcription of the 19 Nov 2026
 * 8,347-baht business record. It fixes the 56-item transport-order regression:
 * the webhook's accumulated snapshot was in a different order than the LINE
 * ingest ledger (35, 38, 36, 37, 39).
 */
describe("56-item LINE transport ordering parity", () => {
  it("parses the same canonical document at first close and in deferred finalization", async () => {
    const header = "วุธ-พาซีโอ้ผัก เบิก 19/11/2569";
    const closeText = "จบรายการเบิก";
    const boundary = Date.parse("2026-11-18T23:30:00Z");
    const numbers = Array.from({ length: 56 }, (_, i) => i + 1);
    const lineText = (number: number) => {
      if (number === 35 || number === 36) return String(number) + ".คะน้าเล็ก10บาท\n19กำ";
      if (number === 37 || number === 38) return String(number) + ".ผักกาดลุ้ย30บาท\n2หัว";
      return String(number) + ".มังคุด45บาท\n" + String(number) + "โล";
    };
    const transport = [...numbers.slice(0, 34), 35, 38, 36, 37, 39, ...numbers.slice(39)];
    const row = (id: string, ms: number, raw_text: string) => ({
      session_key: "group:1:user:1",
      session_generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      line_event_id: id,
      line_timestamp_ms: ms,
      raw_text,
    });
    const initialRows = [
      row("open", boundary - 2000, header),
      ...transport.map((n, i) => row("item-" + n, boundary - 1000 + i, lineText(n))),
    ];
    const closeRow = row("close", boundary, closeText);
    const pending = {
      session_key: "group:1:user:1",
      session_generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      plain_text_opened_line_event_id: "open",
      close_event_timestamp_ms: null,
      created_at: new Date(boundary - 3000).toISOString(),
      accumulated_text: [header, ...numbers.map(lineText)].join("\n"),
    } as unknown as PendingSession;
    let rows = initialRows;
    const service = {
      loadIngestRows: async () => [...rows],
      rebuildForFinalization: async () => { throw new Error("ingest opener must be authoritative"); },
    } as unknown as PendingSessionService;

    const preClose = await loadPlainTextProduceDocument(service, pending, boundary, closeRow);
    rows = [...initialRows, closeRow];
    const deferred = await loadPlainTextProduceDocument(
      service, { ...pending, close_event_timestamp_ms: boundary }, boundary,
    );

    expect(preClose).toBe(deferred);
    expect(preClose).not.toBe(pending.accumulated_text);
    const sourceNumbers = [...preClose.matchAll(/^(\d+)\./gm)].map((match) => Number(match[1]));
    expect(sourceNumbers).toEqual(transport);

    const parsedBefore = parsePlainTextProduceDocument(preClose, pending, boundary);
    const parsedAfter = parsePlainTextProduceDocument(
      deferred, { ...pending, close_event_timestamp_ms: boundary }, boundary,
    );
    expect(parsedBefore.items).toHaveLength(56);
    expect(parsedAfter.items).toEqual(parsedBefore.items);
    for (const product of ["คะน้าเล็ก", "ผักกาดลุ้ย"]) {
      expect(parsedAfter.items.filter((item) => item.product_name === product)).toHaveLength(2);
    }
  });

  it("does not reuse the initial document if an actual quantity changes", async () => {
    const raw = "วุธ-พาซีโอ้ผัก เบิก 19/11/2569\n1.คะน้าเล็ก10บาท\n19กำ";
    const changed = raw.replace("19กำ", "18กำ");
    const boundary = Date.parse("2026-11-18T23:30:00Z");
    const pending = { created_at: new Date(boundary).toISOString(), close_event_timestamp_ms: null } as PendingSession;
    const original = parsePlainTextProduceDocument(raw, pending, boundary);
    const corrected = parsePlainTextProduceDocument(changed, pending, boundary);
    expect(original.items).toHaveLength(1);
    expect(corrected.items).toHaveLength(1);
    expect(corrected.items[0].quantity).not.toBe(original.items[0].quantity);
  });
});
