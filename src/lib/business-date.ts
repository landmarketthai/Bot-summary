const BANGKOK_TIME_ZONE = "Asia/Bangkok";
const DEFAULT_CUTOFF_HOUR = 4;

function bangkokParts(timestamp: number): { year: number; month: number; day: number; hour: number } | null {
  if (!Number.isFinite(timestamp)) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BANGKOK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));

  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const day = Number(parts.find((p) => p.type === "day")?.value);
  const hour = Number(parts.find((p) => p.type === "hour")?.value);

  if (![year, month, day, hour].every(Number.isFinite)) return null;
  return { year, month, day, hour };
}

function isoDateFromParts(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

function previousIsoDate(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day) - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function bangkokBusinessDateFromTimestamp(
  timestamp: number | undefined,
  cutoffHour = DEFAULT_CUTOFF_HOUR,
): string | null {
  if (timestamp == null) return null;

  const parts = bangkokParts(timestamp);
  if (!parts) return null;

  if (parts.hour < cutoffHour) {
    return previousIsoDate(parts.year, parts.month, parts.day);
  }

  return isoDateFromParts(parts.year, parts.month, parts.day);
}

/**
 * How close to the 04:00 cutoff a clock may sit before it stops PROVING which
 * business day an undated document belongs to: an event at 03:59 is inserted
 * after 04:00, and a late return for yesterday arrives just after it.
 */
export const BUSINESS_DATE_CUTOFF_MARGIN_MS = 30 * 60 * 1000;

/**
 * Every business date a clock reading could belong to once the cutoff margin
 * is allowed for: one date normally, the two adjacent dates near 04:00.
 */
export function bangkokBusinessDatesNear(
  timestamp: number,
  marginMs = BUSINESS_DATE_CUTOFF_MARGIN_MS,
): string[] {
  const dates = new Set<string>();
  for (const ms of [timestamp - marginMs, timestamp + marginMs]) {
    const date = bangkokBusinessDateFromTimestamp(ms);
    if (date) dates.add(date);
  }
  return [...dates].sort();
}

export function bangkokBusinessDateNow(cutoffHour = DEFAULT_CUTOFF_HOUR): string {
  return bangkokBusinessDateFromTimestamp(Date.now(), cutoffHour) ?? new Date().toISOString().slice(0, 10);
}

export function bangkokCalendarDateFromTimestamp(timestamp: number | undefined): string | null {
  if (timestamp == null) return null;

  const parts = bangkokParts(timestamp);
  if (!parts) return null;

  return isoDateFromParts(parts.year, parts.month, parts.day);
}

export function previousBangkokCalendarDateFromTimestamp(timestamp: number | undefined): string | null {
  if (timestamp == null) return null;

  const parts = bangkokParts(timestamp);
  if (!parts) return null;

  return previousIsoDate(parts.year, parts.month, parts.day);
}

export function previousBangkokCalendarDateNow(): string {
  return previousBangkokCalendarDateFromTimestamp(Date.now())
    ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
