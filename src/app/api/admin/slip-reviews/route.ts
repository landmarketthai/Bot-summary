import { NextRequest } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { handleSlipReviewRequest } from "./handler";

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  return handleSlipReviewRequest(req, supabase, createServiceClient());
}
