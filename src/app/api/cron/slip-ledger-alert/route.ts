import type { NextRequest } from "next/server";
import { handleSlipLedgerAlert } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const GET = (req: NextRequest) => handleSlipLedgerAlert(req);
