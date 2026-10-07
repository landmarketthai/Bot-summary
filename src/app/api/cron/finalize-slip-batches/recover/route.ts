import type { NextRequest } from "next/server";
import { handleRecoverRequest } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (req: NextRequest) => handleRecoverRequest(req);
