/**
 * Test seam. Suites that exercise White Sheet arithmetic — not ชั่งคืน
 * integrity — run the real loaders with the produce returns certified, so their
 * fake databases need not model the Daily Close preflight. Return-integrity
 * behaviour is covered by tests that pass their own `returnIntegrity`.
 */
import {
  loadDigitalWhiteSheetCalculation as loadCalculation,
  type WhiteSheetLoadDeps,
} from "./load";
import { loadDigitalWhiteSheetPageModel as loadPageModel } from "./compose";
import { processWhiteSheetCloseCommand as processClose } from "@/lib/line/white-sheet-close-service";

export const CERTIFIED_RETURNS: WhiteSheetLoadDeps = { returnIntegrity: async () => "complete" };

export const loadDigitalWhiteSheetCalculation: typeof loadCalculation = (
  supabase, scope, cashInput, deps = CERTIFIED_RETURNS,
) => loadCalculation(supabase, scope, cashInput, deps);

export const loadDigitalWhiteSheetPageModel: typeof loadPageModel = (
  supabase, scope, deps = CERTIFIED_RETURNS,
) => loadPageModel(supabase, scope, deps);

export const processWhiteSheetCloseCommand: typeof processClose = (
  supabase, input, deps = CERTIFIED_RETURNS,
) => processClose(supabase, input, deps);
