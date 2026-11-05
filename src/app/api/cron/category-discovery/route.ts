import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/server";
import { pushLineMessage, type LineApiMessage } from "@/lib/line/reply";
import { handleCategoryDiscovery } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const GET = (req: NextRequest) => handleCategoryDiscovery(req, {
  getClient: () => createServiceClient() as unknown as SupabaseClient,
  push: (to, messages, retryKey) => pushLineMessage(to, messages as LineApiMessage[], retryKey),
});
