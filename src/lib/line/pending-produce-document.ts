import { bangkokBusinessDateFromTimestamp } from "@/lib/business-date";
import {
  bangkokTimeFromTimestamp,
  parseWeighSession,
} from "@/lib/parsers/weigh-session/parser";
import { RE } from "@/lib/parsers/weigh-session/regex";
import type { PendingSession, PendingSessionService } from "./pending-session-service";

type IngestRow = {
  line_event_id: string;
  line_timestamp_ms: number;
  raw_text: string;
};

export function plainTextIngestDocument(
  openerLineEventId: string | null | undefined,
  ingestRows: Array<Pick<IngestRow, "line_event_id" | "raw_text">>,
): string {
  const opener = openerLineEventId
    ? ingestRows.find((row) => row.line_event_id === openerLineEventId)
    : undefined;
  const rows = opener
    ? [opener, ...ingestRows.filter((row) => row.line_event_id !== openerLineEventId)]
    : ingestRows;
  return rows.map((row) => row.raw_text).join("\n");
}

function hasHeaderInLedger(session: PendingSession, rows: IngestRow[]): boolean {
  const normalizeHeader = (line: string) => line
    .replace(/^\d{1,2}[:.]\d{2}\s+\S+\s+/, "")
    .trim()
    .replace(/\s+/g, " ");
  const expectedHeader = session.accumulated_text
    .split("\n")
    .find((line) => line.trim() !== "");
  if (!expectedHeader) return false;

  return rows.some((row) =>
    row.raw_text.split("\n").some((line) => {
      const normalized = normalizeHeader(line);
      return normalized === normalizeHeader(expectedHeader)
        && !RE.SESSION_END.test(normalized)
        && RE.SESSION_START.test(normalized);
    }),
  );
}

export async function loadPlainTextProduceDocument(
  service: PendingSessionService,
  session: PendingSession,
  eventTimestampMs: number,
  proposedClose?: IngestRow,
) {
  const boundary = session.close_event_timestamp_ms ?? eventTimestampMs;
  const rows = await service.loadIngestRows(session.session_key, session.session_generation, boundary);

  const opener = session.plain_text_opened_line_event_id;
  // Only drafts created before opener IDs were recorded use the legacy header lookup.
  if (opener && !rows.some((row) => row.line_event_id === opener)) {
    throw new Error("plain-text produce ingest is missing the recorded opener");
  }
  if (!opener && !hasHeaderInLedger(session, rows)) {
    return service.rebuildForFinalization(session, boundary);
  }

  // A retry after boundary creation confirms the existing document. Its text
  // only becomes business content if it is the first close and is admitted.
  if (
    session.close_event_timestamp_ms === null
    && proposedClose
    && !rows.some((row) => row.line_event_id === proposedClose.line_event_id)
  ) {
    rows.push(proposedClose);
    rows.sort((a, b) =>
      a.line_timestamp_ms - b.line_timestamp_ms
      || a.line_event_id.localeCompare(b.line_event_id),
    );
  }
  return plainTextIngestDocument(opener, rows);
}

export function parsePlainTextProduceDocument(
  document: string,
  session: PendingSession,
  eventTimestampMs: number,
) {
  const boundary = session.close_event_timestamp_ms ?? eventTimestampMs;
  return parseWeighSession(
    document,
    bangkokBusinessDateFromTimestamp(boundary),
    bangkokTimeFromTimestamp(Date.parse(session.created_at)),
  );
}
