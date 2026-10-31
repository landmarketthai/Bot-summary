import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type Supabase = SupabaseClient<Database>;

/**
 * Display numbers (#N) for the images of one slip batch, in LINE send order.
 *
 * slip_evidences.batch_index is NOT that order: attach_evidence_to_slip_batch
 * hands out image_count + 1 when an image FINISHES download + storage, so an
 * image that needed a retry is numbered after images sent later, and an image
 * that never attached takes no number at all and shifts every later one. The
 * summary instead numbers every image the batch received by the LINE event
 * timestamp the ledger already uses for batch attribution, so #N is the N-th
 * image in the chat and missing images keep their place.
 */

/** Ledger states that are not part of the batch (same rule as received_total). */
const OUTSIDE_BATCH = new Set(["excluded_after_close", "excluded_not_slip"]);

export interface LedgerImage {
  lineMessageId: string;
  eventTsMs: number;
  state: string;
  /** False when the ledger time is a receipt-time fallback, not LINE's own timestamp. */
  lineTimestamp: boolean;
  imageSet?: { id: string; index: number } | null;
}

export interface MissingImage {
  sequence: number;
  state: string;
  /** False when LINE's own data does not confirm this position. */
  verified: boolean;
}

export interface ImageSequence {
  /** line_message_id -> 1-based position in LINE send order. */
  positions: Map<string, number>;
  /** line_message_ids whose position LINE's own data does not confirm. */
  unverified: Set<string>;
  /** Received images with no evidence in the batch, by position. */
  missing: MissingImage[];
  /** Some position could not be verified from LINE's own ordering data. */
  uncertain: boolean;
}

// LINE message ids are decimal strings: compare by length first, never as text alone.
const compareIds = (a: string, b: string) =>
  a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

const sameSet = (a: LedgerImage, b: LedgerImage) =>
  !!a.imageSet && !!b.imageSet && a.imageSet.id === b.imageSet.id;

export function sequenceBatchImages(
  images: readonly LedgerImage[],
  attachedLineMessageIds: ReadonlySet<string>,
): ImageSequence {
  const ordered = images
    .filter((image) => !OUTSIDE_BATCH.has(image.state))
    .sort((a, b) =>
      a.eventTsMs - b.eventTsMs
      || (sameSet(a, b) ? a.imageSet!.index - b.imageSet!.index : 0)
      || compareIds(a.lineMessageId, b.lineMessageId));

  const positions = new Map(ordered.map((image, i) => [image.lineMessageId, i + 1]));
  const unverified = new Set<string>();
  const markAll = () => ordered.forEach((image) => unverified.add(image.lineMessageId));

  // An image whose true place is unknown (receipt-time fallback, or evidence
  // with no ledger row at all) can shift every other number: none is confirmed.
  if (ordered.some((image) => !image.lineTimestamp)) markAll();
  if ([...attachedLineMessageIds].some((id) => !positions.has(id))) markAll();

  const lastIndexBySet = new Map<string, number>();
  const contradictedSets = new Set<string>();
  for (const [i, image] of ordered.entries()) {
    const previous = ordered[i - 1];
    // Same millisecond and no shared image set: only the message id orders them.
    if (previous && previous.eventTsMs === image.eventTsMs && !sameSet(previous, image)) {
      unverified.add(previous.lineMessageId);
      unverified.add(image.lineMessageId);
    }
    if (image.imageSet) {
      // LINE's own index inside a multi-image send must agree with the time order.
      const last = lastIndexBySet.get(image.imageSet.id);
      if (last !== undefined && image.imageSet.index <= last) contradictedSets.add(image.imageSet.id);
      lastIndexBySet.set(image.imageSet.id, image.imageSet.index);
    }
  }
  for (const image of ordered) {
    if (image.imageSet && contradictedSets.has(image.imageSet.id)) unverified.add(image.lineMessageId);
  }

  const missing = ordered.flatMap((image, i) =>
    image.state === "attached" && attachedLineMessageIds.has(image.lineMessageId)
      ? []
      : [{ sequence: i + 1, state: image.state, verified: !unverified.has(image.lineMessageId) }]);
  const uncertain = unverified.size > 0
    || [...attachedLineMessageIds].some((id) => !positions.has(id));

  return { positions, unverified, missing, uncertain };
}

/**
 * Reads the batch ledger and the LINE payloads it was captured from. Throws on
 * any read error: the caller must not number a summary from partial data.
 */
export async function loadImageSequence(
  supabase: Supabase,
  batchId: string,
  attachedLineMessageIds: ReadonlySet<string>,
): Promise<ImageSequence> {
  const { data, error } = await supabase
    .from("slip_image_events")
    .select("line_message_id, raw_message_id, event_ts_ms, state")
    .eq("batch_id", batchId);
  if (error) throw new Error(`slip image sequence: ${error.message}`);
  const rows = data ?? [];

  const payloads = new Map<string, unknown>();
  if (rows.length > 0) {
    const { data: raws, error: rawError } = await supabase
      .from("raw_messages")
      .select("id, payload")
      .in("id", rows.map((row) => row.raw_message_id));
    if (rawError) throw new Error(`slip image sequence payloads: ${rawError.message}`);
    for (const raw of raws ?? []) payloads.set(raw.id, raw.payload);
  }

  return sequenceBatchImages(rows.map((row) => {
    const payload = payloads.get(row.raw_message_id) as
      | { timestamp?: unknown; message?: { imageSet?: { id?: unknown; index?: unknown } } }
      | undefined;
    const set = payload?.message?.imageSet;
    return {
      lineMessageId: row.line_message_id,
      eventTsMs: Number(row.event_ts_ms),
      state: row.state,
      lineTimestamp: payload?.timestamp !== undefined && Number(payload.timestamp) === Number(row.event_ts_ms),
      imageSet: typeof set?.id === "string" && Number.isInteger(set.index)
        ? { id: set.id, index: set.index as number }
        : null,
    };
  }), attachedLineMessageIds);
}
