import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LineApiMessage } from "@/lib/line/reply";
import type { MorningBriefScope } from "./morning-brief";

export interface BriefPayload {
  artifactPath: string;
  parts: { text: string; key: string; kind: "text" | "pdf"; message?: LineApiMessage }[];
}
export interface BriefDelivery {
  state: "pending" | "busy" | "accepted" | "needs_review";
  lease_token: string;
  payload: BriefPayload | null;
  next_part: number;
}
export function briefTargetKey(target: string): string {
  return createHash("sha256").update(target).digest("hex");
}
export async function briefDelivery(
  client: SupabaseClient, date: string, scope: MorningBriefScope, target: string,
  action: "claim" | "freeze" | "prepare" | "accept" | "release",
  claim?: BriefDelivery, payload?: BriefPayload, part?: number,
): Promise<BriefDelivery> {
  const { data, error } = await client.rpc("morning_brief_delivery", {
    p_date: date, p_scope: scope, p_target: briefTargetKey(target), p_action: action,
    p_token: claim?.lease_token ?? null, p_payload: payload ?? null, p_part: part ?? null,
  });
  if (error || !data || !["pending", "busy", "accepted", "needs_review"].includes(data.state)
    || (data.state === "pending" && (!data.lease_token || !Number.isInteger(data.next_part) || data.next_part < 0))) {
    throw new Error("morning brief delivery state unavailable");
  }
  return data as BriefDelivery;
}
