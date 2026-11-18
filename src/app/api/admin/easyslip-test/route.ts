import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { EasySlipBankVerifier } from "@/lib/slips/easyslip-bank";
import { handleEasySlipTest } from "./handler";

export async function POST(req: NextRequest) {
  return handleEasySlipTest(req, await createClient(), new EasySlipBankVerifier());
}
