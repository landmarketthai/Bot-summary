import type { MorningBriefScope } from "./morning-brief";

/** Existing cron slots with five minutes for asynchronous arrival. UTC+7 has no DST. */
export function morningBriefSlotMinute(scope: MorningBriefScope, now: number): number | null {
  const local = new Date(now + 7 * 3600_000);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  if (scope === "fruit") return minute >= 600 && minute < 605 ? 600 : null;
  const slot = Math.floor(minute / 30) * 30;
  return slot >= 840 && slot <= 1080 && minute - slot < 5 ? slot : null;
}

export function morningBriefSlot(scope: MorningBriefScope, now: number): boolean {
  return morningBriefSlotMinute(scope, now) !== null;
}
