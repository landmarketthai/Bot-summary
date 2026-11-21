/**
 * Guided Menu Slice 2 UX handler.
 * Opens menu on exact "เมนู", consumes opaque gpm1 tokens, never opens sessions.
 * Adapted to corrected Slice 1 create/consume/record contracts.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { MENU_TOKEN_PREFIX, parseMenuToken } from "./menu-token";
import { GuidedMenuStateService } from "./menu-state-service";
import type {
  CreateMenuStateInput,
  GuidedMenuSeller,
  GuidedMenuSellerMarket,
  MenuActionType,
  MenuDateMode,
  MenuPayload,
  MenuPayloadByAction,
  MenuSourceType,
  MenuTransactionTypeCode,
} from "./menu-state-types";
import { MENU_SOURCE_TYPES, MENU_TRANSACTION_TYPE_CODES } from "./menu-state-types";
import { resolveGuidedMenuDate } from "./dates";
import {
  findGuidedMenuMarket,
  type GuidedMenuMarketOption,
} from "./markets";
import { GuidedSessionOpener } from "./session-opener";
import {
  GuidedSessionCaptureService,
  type GuidedCaptureFinalizeOutcome,
  type GuidedCaptureRefusal,
} from "./session-capture";
import {
  GuidedJourneyService,
  buildSlipHeaderTemplate,
  buildWhiteSheetTemplate,
  thaiDateFromIso,
  type GuidedJourneyContext,
  type GuidedJourneyState,
} from "./journey";
import {
  GuidedRoundService,
  GUIDED_ROUND_BLOCKER_LABEL,
  summarizeSlipStatuses,
} from "./round-close";
import { buildSettlementTemplate } from "./settlement-command";
import { buildWeighSessionSummary } from "@/lib/line/reply";
import { buildWeighSessionValidationReply } from "@/lib/parsers/weigh-session/parser";
import {
  buildDraftItemActionReply,
  latestDraftItemAction,
} from "@/lib/parsers/weigh-session/draft-item-command";
import {
  assertGuidedMenuMessageLimits,
  bindQuickReply,
  buildCancelledMessage,
  buildCaptureAckMessage,
  buildCapturedItemsMessages,
  buildConfirmPreviewMessage,
  buildRoundStatusMessage,
  buildSettlementTemplateMessages,
  buildSlipInstructionMessages,
  buildStageControlFlexMessage,
  buildWhiteSheetTemplateMessages,
  buildFinalizeConfirmedMessage,
  buildFinalizeNotReadyMessage,
  buildMenuDismissedSessionOpenMessage,
  buildNoOpenSessionMessage,
  buildPlainTextMessage,
  buildSessionActionConflictMessage,
  type BoundTokenButton,
  buildDateSelectMessage,
  buildNoActiveSellerMarketsMessage,
  buildNoActiveSellersMessage,
  buildSellerSelectMessages,
  buildSellerUnavailableMessage,
  buildInvalidMenuMessage,
  buildMarketSelectMessage,
  buildMarketUnavailableMessage,
  buildSessionAlreadyOpenMessage,
  buildSessionOpenConflictMessage,
  buildSessionOpenedMessage,
  buildTransactionTypeMessage,
  buildUnmappedMessage,
} from "./messages";
import {
  GUIDED_MENU_COPY,
  GUIDED_MENU_TRIGGER,
  LINE_REPLY_MESSAGE_MAX,
  SELLERS_PER_MESSAGE,
  type GuidedMenuIdentity,
  type GuidedMenuLineMessage,
  type GuidedMenuUxResult,
  type LineFlexMessage,
  type LineQuickReply,
} from "./ux-types";

export function isExactGuidedMenuTrigger(text: string): boolean {
  return text.trim() === GUIDED_MENU_TRIGGER;
}

/** Exact plain-text close for the guided requestClose contract. */
export function isExactGuidedCloseTrigger(text: string): boolean {
  return text.trim() === "จบรายการ";
}

/**
 * Exact plain-text equivalents of the "ออกจากเมนู" / cancel Flex button.
 * Must be intercepted before pending-session append: typed control text is
 * never produce data, even when no button was pressed.
 */
export function isExactGuidedCancelTrigger(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === "ยกเลิก" || trimmed === "ออกจากเมนู";
}

/** True when postback data carries a well-formed opaque gpm1 token. */
export function isGuidedMenuPostbackData(data: string): boolean {
  return parseMenuToken(data).ok;
}

/**
 * True when postback data looks like Guided Menu (`gpm1:` prefix).
 * Malformed candidates must fail closed with the invalid-menu reply —
 * they must not fall through as "unrelated" postbacks.
 */
export function isGuidedMenuPostbackCandidate(data: string): boolean {
  return typeof data === "string" && data.startsWith(MENU_TOKEN_PREFIX);
}

function asSourceType(value: string): MenuSourceType | null {
  return (MENU_SOURCE_TYPES as readonly string[]).includes(value)
    ? (value as MenuSourceType)
    : null;
}

function asTx(value: unknown): MenuTransactionTypeCode | null {
  return typeof value === "string" &&
    (MENU_TRANSACTION_TYPE_CODES as readonly string[]).includes(value)
    ? (value as MenuTransactionTypeCode)
    : null;
}

function isCancelPayload(payload: MenuPayload): boolean {
  return payload.intent === "cancel";
}

function resultEnvelope(
  screen: GuidedMenuUxResult["screen"],
  messages: GuidedMenuLineMessage[],
  extra: Record<string, unknown> = {},
): GuidedMenuUxResult {
  assertGuidedMenuMessageLimits(messages);
  return {
    screen,
    messages,
    result: {
      v: 1,
      screen,
      messages,
      ...extra,
    },
    confirmPlaceholder: screen === "confirm_placeholder",
  };
}

function restoreFromResult(result: Record<string, unknown> | null): GuidedMenuUxResult | null {
  if (!result || typeof result !== "object") return null;
  if (result.v !== 1 || typeof result.screen !== "string") return null;
  if (!Array.isArray(result.messages)) return null;
  const messages = result.messages as GuidedMenuLineMessage[];
  try {
    assertGuidedMenuMessageLimits(messages);
  } catch {
    return null;
  }
  return {
    screen: result.screen as GuidedMenuUxResult["screen"],
    messages,
    result,
    confirmPlaceholder: result.screen === "confirm_placeholder",
  };
}

type CreateToken = <A extends MenuActionType>(input: {
  actionType: A;
  payload: MenuPayloadByAction[A];
}) => Promise<string>;

export class GuidedMenuUxHandler {
  private readonly state: GuidedMenuStateService;
  private readonly opener: GuidedSessionOpener;
  private readonly capture: GuidedSessionCaptureService;
  private readonly journey: GuidedJourneyService;
  private readonly rounds: GuidedRoundService;

  constructor(
    supabase: SupabaseClient,
    options: {
      stateService?: GuidedMenuStateService;
      sessionOpener?: GuidedSessionOpener;
      captureService?: GuidedSessionCaptureService;
      journeyService?: GuidedJourneyService;
      roundService?: GuidedRoundService;
    } = {},
  ) {
    this.state = options.stateService ?? new GuidedMenuStateService(supabase);
    this.opener = options.sessionOpener ?? new GuidedSessionOpener(supabase);
    this.capture =
      options.captureService ?? new GuidedSessionCaptureService(supabase);
    this.journey = options.journeyService ?? new GuidedJourneyService(supabase);
    this.rounds =
      options.roundService ??
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new GuidedRoundService(supabase as any);
  }

  async openMenu(input: {
    identity: GuidedMenuIdentity;
  }): Promise<GuidedMenuUxResult> {
    const operator = await this.state.resolveOperator(input.identity.lineUserId);
    if (operator.status !== "mapped") {
      return resultEnvelope("unmapped", [buildUnmappedMessage()]);
    }
    const journey = await this.resolveJourney(input.identity);
    if (journey.stage !== "idle") {
      return this.renderActiveJourneyMenu(input.identity, journey);
    }
    if (
      journey.reason === "ownership_conflict"
      || journey.reason === "session_key_mismatch"
      || journey.reason === "missing_session_key"
    ) {
      return resultEnvelope("invalid", [buildInvalidMenuMessage()], {
        reason: journey.reason,
      });
    }
    return this.buildTransactionTypeScreen(input.identity);
  }

  /** Plain-text "จบรายการ" for the operator's active guided round. */
  async handleTextCloseRequest(input: {
    identity: GuidedMenuIdentity;
    lineEventId: string;
    lineTimestampMs: number;
  }): Promise<GuidedMenuUxResult> {
    return this.requestClose(input);
  }

  /**
   * Plain-text "ยกเลิก" / "ออกจากเมนู" — the typed equivalent of the cancel
   * Flex button. Dismisses the menu only: there is no authoritative
   * cancel-open-session contract, so an open round is never voided and the
   * text itself is never appended as produce data (see dispatchConsumed's
   * menu_root cancel branch, which this mirrors for typed input).
   */
  async handleTextCancelRequest(input: {
    identity: GuidedMenuIdentity;
  }): Promise<GuidedMenuUxResult> {
    const open = await this.capture.snapshot(input.identity);
    if (open.status === "ok") {
      return resultEnvelope("session_menu_dismissed", [
        buildMenuDismissedSessionOpenMessage(),
      ]);
    }
    return resultEnvelope("cancelled", [buildCancelledMessage()]);
  }

  /**
   * After a captured item append, acknowledge with text + Quick Reply.
   * A line the parser could not read gets correction details instead of the
   * saved-count receipt — same detail text and hint `renderCaptureStatus`
   * shows on ดูรายการ, just surfaced immediately instead of on next look.
   */
  async renderCaptureAcknowledgement(input: {
    identity: GuidedMenuIdentity;
    preferDraftItemAction?: boolean;
  }): Promise<GuidedMenuUxResult | null> {
    const snapshot = await this.capture.snapshot(input.identity);
    if (snapshot.status !== "ok" || snapshot.closeRequested) return null;
    const controls = await this.buildCaptureStageControls(input.identity);
    if (!controls) return null;
    const draftAction = input.preferDraftItemAction
      ? latestDraftItemAction(snapshot.parsed)
      : null;
    const hasParseErrors = snapshot.parsed.parse_errors.length > 0;
    const ackBase = draftAction
      ? buildPlainTextMessage(buildDraftItemActionReply(draftAction))
      : hasParseErrors
      ? buildPlainTextMessage(
          [
            buildWeighSessionValidationReply(snapshot.parsed),
            "",
            GUIDED_MENU_COPY.correctionHint,
          ].join("\n"),
        )
      : buildCaptureAckMessage(snapshot.parsed.items.length);
    const ack = controls.quickReply
      ? { ...ackBase, quickReply: controls.quickReply }
      : ackBase;
    return resultEnvelope(
      "session_status",
      [ack],
      {
        item_count: snapshot.parsed.items.length,
        capture_ack: true,
        parse_error_count: snapshot.parsed.parse_errors.length,
      },
    );
  }

  async handlePostback(input: {
    wireToken: string;
    lineEventId: string;
    identity: GuidedMenuIdentity;
    lineTimestampMs: number;
  }): Promise<GuidedMenuUxResult> {
    if (!isGuidedMenuPostbackData(input.wireToken)) {
      return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
    }

    const consumed = await this.state.consumeState({
      wireToken: input.wireToken,
      lineEventId: input.lineEventId,
      lineUserId: input.identity.lineUserId,
      sourceType: input.identity.sourceType,
      sourceId: input.identity.sourceId,
      sessionKey: input.identity.sessionKey,
    });

    if (consumed.status === "invalid_or_expired") {
      return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
    }

    if (consumed.status === "already_consumed") {
      // Different-event: no action/payload/result disclosure — generic refuse.
      return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
    }

    if (consumed.status === "replay") {
      const restored = restoreFromResult(consumed.result);
      if (restored) return restored;
      return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
    }

    // status === "consumed"
    const outcome = await this.dispatchConsumed({
      actionType: consumed.actionType,
      payload: consumed.payload,
      identity: input.identity,
      lineEventId: input.lineEventId,
      lineTimestampMs: input.lineTimestampMs,
    });

    const recorded = await this.state.recordResult({
      wireToken: input.wireToken,
      consumedLineEventId: input.lineEventId,
      lineUserId: input.identity.lineUserId,
      sourceType: input.identity.sourceType,
      sourceId: input.identity.sourceId,
      sessionKey: input.identity.sessionKey,
      result: outcome.result,
    });

    if (recorded.status === "replay") {
      const restored = restoreFromResult(recorded.result);
      if (restored) return restored;
    }
    if (
      recorded.status === "result_conflict" ||
      recorded.status === "invalid_or_expired"
    ) {
      return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
    }

    return outcome;
  }

  private async dispatchConsumed(input: {
    actionType: MenuActionType;
    payload: MenuPayload;
    identity: GuidedMenuIdentity;
    lineEventId: string;
    lineTimestampMs: number;
  }): Promise<GuidedMenuUxResult> {
    // Re-check operator on every navigation step (inactive mid-flow → refuse).
    const operator = await this.state.resolveOperator(input.identity.lineUserId);
    if (operator.status !== "mapped") {
      return resultEnvelope("unmapped", [buildUnmappedMessage()]);
    }

    if (input.actionType === "menu_root") {
      if (isCancelPayload(input.payload)) {
        // Dismissing the menu never voids an open round — there is no
        // authoritative cancel-open-session contract to call. Say so plainly
        // rather than let "ยกเลิกแล้ว" read as a cancelled round.
        const open = await this.capture.snapshot(input.identity);
        if (open.status === "ok") {
          return resultEnvelope("session_menu_dismissed", [
            buildMenuDismissedSessionOpenMessage(),
          ]);
        }
        return resultEnvelope("cancelled", [buildCancelledMessage()]);
      }
      return this.buildTransactionTypeScreen(input.identity);
    }

    if (input.actionType === "view_status") {
      return this.viewStatus(input.identity);
    }

    if (input.actionType === "request_close") {
      return this.requestClose(input);
    }

    if (input.actionType === "confirm_finalize") {
      return this.confirmFinalize(input);
    }

    if (input.actionType === "choose_transaction_type") {
      const tx = asTx(input.payload.transaction_type);
      if (!tx) {
        return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
      }
      return this.buildSellerScreen(input.identity, tx);
    }

    if (input.actionType === "choose_seller") {
      const tx = asTx(input.payload.transaction_type);
      const sellerCode = input.payload.seller_code?.trim();
      if (!tx || !sellerCode) {
        return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
      }
      const selection = await this.state.loadActiveSellerMarkets(sellerCode);
      if (!selection.seller) {
        return resultEnvelope("seller_unavailable", [
          buildSellerUnavailableMessage(),
        ]);
      }
      if (selection.markets.length === 0) {
        return resultEnvelope("no_seller_markets", [
          buildNoActiveSellerMarketsMessage(),
        ]);
      }
      return this.buildMarketScreen(
        input.identity,
        tx,
        selection.seller,
        selection.markets,
      );
    }

    if (input.actionType === "choose_market") {
      const tx = asTx(input.payload.transaction_type);
      const sellerCode = input.payload.seller_code?.trim();
      const marketCode = input.payload.market_code?.trim();
      if (!tx || !sellerCode || !marketCode) {
        return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
      }
      const selection = await this.state.loadActiveSellerMarkets(sellerCode);
      if (!selection.seller) {
        return resultEnvelope("seller_unavailable", [
          buildSellerUnavailableMessage(),
        ]);
      }
      const market = findGuidedMenuMarket(
        selection.markets.map((row) => ({
          code: row.marketCode,
          label: row.marketLabel,
        })),
        marketCode,
      );
      if (!market) {
        return resultEnvelope("market_unavailable", [
          buildMarketUnavailableMessage(),
        ]);
      }
      return this.buildDateScreen(input.identity, tx, selection.seller, market);
    }

    if (input.actionType === "choose_date") {
      const tx = asTx(input.payload.transaction_type);
      const sellerCode = input.payload.seller_code?.trim();
      const marketCode = input.payload.market_code?.trim();
      const dateMode = input.payload.date_mode;
      if (
        !tx ||
        !sellerCode ||
        !marketCode ||
        (dateMode !== "today" && dateMode !== "yesterday")
      ) {
        return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
      }
      const selection = await this.state.loadActiveSellerMarkets(sellerCode);
      if (!selection.seller) {
        return resultEnvelope("seller_unavailable", [
          buildSellerUnavailableMessage(),
        ]);
      }
      const market = findGuidedMenuMarket(
        selection.markets.map((row) => ({
          code: row.marketCode,
          label: row.marketLabel,
        })),
        marketCode,
      );
      if (!market) {
        return resultEnvelope("market_unavailable", [
          buildMarketUnavailableMessage(),
        ]);
      }
      return this.buildConfirmScreen(
        input.identity,
        tx,
        selection.seller,
        market,
        dateMode,
        input.lineTimestampMs,
      );
    }

    if (input.actionType === "confirm_open") {
      return this.confirmOpen({
        payload: input.payload,
        identity: input.identity,
        lineEventId: input.lineEventId,
        lineTimestampMs: input.lineTimestampMs,
      });
    }

    return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
  }

  /**
   * Slice 3A — the confirm boundary now opens a REAL structured session.
   *
   * Every selection is re-validated against the live catalog at press time,
   * not trusted from the token payload: the operator, the transaction type,
   * the seller, the market, the seller→market assignment and the business
   * date are all re-derived here. A stale button whose assignment was revoked
   * after the token was minted therefore refuses instead of opening.
   */
  private async confirmOpen(input: {
    payload: MenuPayload;
    identity: GuidedMenuIdentity;
    lineEventId: string;
    lineTimestampMs: number;
  }): Promise<GuidedMenuUxResult> {
    const tx = asTx(input.payload.transaction_type);
    const sellerCode = input.payload.seller_code?.trim();
    const marketCode = input.payload.market_code?.trim();
    const dateMode = input.payload.date_mode;
    if (
      !tx ||
      !sellerCode ||
      !marketCode ||
      (dateMode !== "today" && dateMode !== "yesterday")
    ) {
      return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
    }

    const selection = await this.state.loadActiveSellerMarkets(sellerCode);
    if (!selection.seller) {
      return resultEnvelope("seller_unavailable", [
        buildSellerUnavailableMessage(),
      ]);
    }
    const assignment = selection.markets.find(
      (row) => row.marketCode === marketCode,
    );
    if (!assignment) {
      return resultEnvelope("market_unavailable", [
        buildMarketUnavailableMessage(),
      ]);
    }

    // The date is resolved from the LINE event timestamp against the Bangkok
    // calendar at press time — never carried as a label in the token.
    const resolved = resolveGuidedMenuDate(dateMode, input.lineTimestampMs);
    if (!resolved) {
      return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
    }

    let accountabilityRoundId: string | null = null;
    if (tx !== "withdraw") {
      const journey = await this.resolveJourney(input.identity);
      if (journey.stage === "idle" || !journey.context.accountabilityRoundId) {
        return resultEnvelope(
          "session_open_conflict",
          [buildSessionOpenConflictMessage()],
          { opened: false, recorded: false, reason: "missing_accountability_round" },
        );
      }
      accountabilityRoundId = journey.context.accountabilityRoundId;
    }

    const opened = await this.opener.open({
      identity: input.identity,
      transactionType: tx,
      sellerLabel: selection.seller.label,
      marketLabel: assignment.marketLabel,
      businessDateIso: resolved.iso,
      lineEventId: input.lineEventId,
      lineTimestampMs: input.lineTimestampMs,
      accountabilityRoundId,
    });

    if (opened.status === "already_open") {
      return resultEnvelope(
        "session_already_open",
        [buildSessionAlreadyOpenMessage()],
        { opened: false, recorded: false, reason: "session_already_open" },
      );
    }
    // Someone else in this group already owns this market and date, or ownership
    // could not be established. Refused before open_or_rotate — zero writes.
    if (opened.status === "round_owned") {
      const message = buildPlainTextMessage(
        opened.reason === "other_operator"
          ? GUIDED_MENU_COPY.sessionRoundOwnedByOther
          : opened.reason === "ambiguous"
            ? GUIDED_MENU_COPY.ownershipAmbiguous
            : GUIDED_MENU_COPY.ownershipUnknown,
      );
      return resultEnvelope("session_already_open", [message], {
        opened: false,
        recorded: false,
        reason: `round_owned_${opened.reason}`,
      });
    }
    if (opened.status !== "opened") {
      return resultEnvelope(
        "session_open_conflict",
        [buildSessionOpenConflictMessage()],
        { opened: false, recorded: false, reason: opened.reason },
      );
    }

    const controls = await this.buildCaptureStageControls(input.identity);
    const openedBase = buildSessionOpenedMessage({
      transactionType: tx,
      sellerLabel: selection.seller.label,
      marketLabel: assignment.marketLabel,
      dateThaiShort: resolved.thaiShort,
      instructions: [
        GUIDED_MENU_COPY.sendItemsHint,
        GUIDED_MENU_COPY.closeWhenDoneHint,
      ],
    });
    const openedMessage = controls?.quickReply
      ? { ...openedBase, quickReply: controls.quickReply }
      : openedBase;

    return resultEnvelope(
      "session_opened",
      [openedMessage],
      {
        opened: true,
        transaction_type: tx,
        seller_code: selection.seller.sellerCode,
        market_code: assignment.marketCode,
        business_date_iso: resolved.iso,
        session_key: opened.sessionKey,
        session_generation: opened.sessionGeneration,
        open_outcome: opened.outcome,
      },
    );
  }

  // ── Slice 3B — guided capture, review and finalize ──────────────────────

  private async resolveJourney(
    identity: GuidedMenuIdentity,
  ): Promise<GuidedJourneyState> {
    try {
      return await this.journey.resolve(identity);
    } catch {
      return { stage: "idle", reason: "lookup_failed" };
    }
  }

  private async renderActiveJourneyMenu(
    identity: GuidedMenuIdentity,
    journey: Exclude<GuidedJourneyState, { stage: "idle" }>,
  ): Promise<GuidedMenuUxResult> {
    if (journey.stage === "capture" || journey.stage === "awaiting_confirm") {
      return this.renderCaptureStatus(identity, journey.stage);
    }
    return this.viewStatus(identity);
  }

  /**
   * Action buttons for an open round. Built fresh on every screen so each is
   * a single-use token bound to this operator, source and session key.
   */
  private async buildSessionActionButtons(
    identity: GuidedMenuIdentity,
    include: { close: boolean; confirm: boolean },
  ): Promise<BoundTokenButton[] | undefined> {
    try {
      const create = this.createTokenFn(identity);
      const buttons: BoundTokenButton[] = [];
      buttons.push({
        label: "ดูรายการ",
        actionType: "view_status",
        payload: {},
        wireToken: await create({ actionType: "view_status", payload: {} }),
      });
      if (include.close) {
        buttons.push({
          label: "จบรายการ",
          actionType: "request_close",
          payload: {},
          wireToken: await create({ actionType: "request_close", payload: {} }),
        });
      }
      if (include.confirm) {
        buttons.push({
          label: "ยืนยันจบรายการ",
          actionType: "confirm_finalize",
          payload: {},
          wireToken: await create({
            actionType: "confirm_finalize",
            payload: {},
          }),
        });
      }
      buttons.push({
        // Never labelled "ยกเลิกรายการ": this button dismisses the guided
        // controls and leaves the produce session open, which is a different
        // thing from abandoning the draft. A cancel contract does now exist
        // (see src/lib/produce/cancel-active-draft.ts), but it stays a TYPED
        // command deliberately, so a stray button press can never discard a
        // document in progress — and this button set is rendered both before
        // and after the close boundary (include.confirm), so nothing here may
        // promise the draft is still cancellable.
        label: "ออกจากเมนู",
        actionType: "menu_root",
        payload: { intent: "cancel" },
        wireToken: await create({
          actionType: "menu_root",
          payload: { intent: "cancel" },
        }),
      });
      return buttons;
    } catch {
      return undefined;
    }
  }

  private async buildCaptureStageControls(identity: GuidedMenuIdentity) {
    const buttons = await this.buildSessionActionButtons(identity, {
      close: true,
      confirm: false,
    });
    // Transient capture-stage controls: Quick Reply only, no persistent Flex.
    return this.wrapStageControls(buttons, "จัดการรายการ", false);
  }

  private async buildConfirmStageControls(identity: GuidedMenuIdentity) {
    const buttons = await this.buildSessionActionButtons(identity, {
      close: false,
      confirm: true,
    });
    return this.wrapStageControls(buttons, "ยืนยันจบรายการ");
  }

  /**
   * Routine/transient controls stay Quick Reply only (`includeFlex: false`);
   * a persistent Flex card is reserved for selection screens and the one
   * close-confirmation / white-sheet-transition moment (default `true`).
   */
  private wrapStageControls(
    buttons: BoundTokenButton[] | undefined,
    title: string,
    includeFlex = true,
  ): { flex?: LineFlexMessage; quickReply?: LineQuickReply } | undefined {
    if (!buttons || buttons.length === 0) return undefined;
    const quickReply = bindQuickReply(buttons);
    return {
      flex: includeFlex
        ? buildStageControlFlexMessage({
            title,
            bodyLines: ["กดปุ่มด้านล่างเพื่อดำเนินการต่อ"],
            buttons,
          })
        : undefined,
      quickReply,
    };
  }

  private async buildJourneyActionButtons(
    identity: GuidedMenuIdentity,
    labels: readonly string[],
  ): Promise<BoundTokenButton[] | undefined> {
    try {
      const create = this.createTokenFn(identity);
      const buttons: BoundTokenButton[] = [];
      for (const label of labels) {
        buttons.push({
          label,
          actionType: "view_status",
          payload: {},
          wireToken: await create({ actionType: "view_status", payload: {} }),
        });
      }
      buttons.push({
        label: "ออกจากเมนู",
        actionType: "menu_root",
        payload: { intent: "cancel" },
        wireToken: await create({
          actionType: "menu_root",
          payload: { intent: "cancel" },
        }),
      });
      return buttons;
    } catch {
      return undefined;
    }
  }

  private async buildJourneyStageControls(
    identity: GuidedMenuIdentity,
    labels: readonly string[],
    title: string,
    includeFlex = true,
  ) {
    const buttons = await this.buildJourneyActionButtons(identity, labels);
    return this.wrapStageControls(buttons, title, includeFlex);
  }

  /** Map a capture refusal onto operator copy without leaking internals. */
  private refusalEnvelope(reason: GuidedCaptureRefusal): GuidedMenuUxResult {
    if (reason === "no_open_session" || reason === "not_structured" || reason === "terminalized") {
      return resultEnvelope("no_open_session", [buildNoOpenSessionMessage()], {
        reason,
      });
    }
    // ownership/session-key mismatches disclose nothing beyond the generic
    // invalid-menu copy — a stranger must not learn a round exists.
    return resultEnvelope("invalid", [buildInvalidMenuMessage()], { reason });
  }

  /**
   * Slices 3B/3C/3D — one journey-status action, rendered for wherever the
   * operator actually is.
   *
   * The stage is re-derived server-side from authoritative state on every
   * press (GuidedJourneyService), never carried in the token, so a button
   * minted at an earlier stage always renders the CURRENT stage. This action
   * is read-only, which is why sharing one action type across stages is safe.
   */
  private async viewStatus(
    identity: GuidedMenuIdentity,
  ): Promise<GuidedMenuUxResult> {
    let journey;
    try {
      journey = await this.journey.resolve(identity);
    } catch {
      return resultEnvelope("no_open_session", [buildNoOpenSessionMessage()], {
        reason: "lookup_failed",
      });
    }
    if (journey.stage === "idle") {
      // Identity failures disclose nothing; everything else is "no round yet",
      // but the specific reason is kept in the recorded result for operators
      // support and for the replay envelope.
      const opaque =
        journey.reason === "ownership_conflict" ||
        journey.reason === "session_key_mismatch" ||
        journey.reason === "missing_session_key";
      return opaque
        ? resultEnvelope("invalid", [buildInvalidMenuMessage()], {
            reason: journey.reason,
          })
        : resultEnvelope("no_open_session", [buildNoOpenSessionMessage()], {
            reason: journey.reason,
          });
    }

    if (journey.stage === "capture" || journey.stage === "awaiting_confirm") {
      return this.renderCaptureStatus(identity, journey.stage);
    }
    // The produce outcome is re-read from the authoritative row on every press,
    // so "ดูสถานะ" is how a pending finalization becomes a real answer.
    if (journey.stage === "finalizing" || journey.stage === "finalize_failed") {
      return this.renderProduceOutcome(identity);
    }
    if (journey.stage === "white_sheet") {
      return this.renderWhiteSheetStage(identity, journey.context);
    }
    if (journey.stage === "slips") {
      return this.renderSlipStage(identity, journey.context);
    }
    return this.renderRoundStatus(
      identity,
      journey.context,
      journey.whiteSheet.status !== "not_submitted",
    );
  }

  /**
   * Slice 3D — read-only reconciliation with the remaining blockers spelled out.
   *
   * 3D.1: when the round has no settlement yet, the one step that used to
   * require the Dashboard is handed over right here as a copyable template, so
   * the operator never leaves LINE. The template is generated but nothing is
   * written — the settlement is only recorded when they send it back.
   */
  private async renderRoundStatus(
    identity: GuidedMenuIdentity,
    context: GuidedJourneyContext,
    whiteSheetSubmitted: boolean,
  ): Promise<GuidedMenuUxResult> {
    const report = await this.rounds.report(context, whiteSheetSubmitted);
    const dateThaiShort =
      thaiDateFromIso(context.businessDate) ?? context.businessDate;

    const needsSettlement = report.blockers.includes("settlement_missing");
    const template = needsSettlement ? buildSettlementTemplate(context) : null;
    // Never label a view_status button "ปิดรอบ" — closing stays the exact
    // text command. Ready-to-close still shows ตรวจยอด plus the instruction.
    const stageLabels = template
      ? (["กรอกยอดส่ง", "ตรวจยอด"] as const)
      : (["ตรวจยอด"] as const);
    // Routine reconcile/settlement status: Quick Reply only, no persistent Flex.
    const controls = await this.buildJourneyStageControls(
      identity,
      stageLabels,
      "จัดการรอบขาย",
      false,
    );

    const nextStepLine = template
      ? "กรอกแบบฟอร์มยอดส่งด้านล่าง แก้เฉพาะตัวเลข แล้วส่งกลับมา"
      : report.blockers.length === 0
        ? `พิมพ์ "${GUIDED_MENU_COPY.roundCloseCommand}" เพื่อปิดรอบ`
        : `แก้ไขแล้วพิมพ์ "${GUIDED_MENU_COPY.roundCloseCommand}" อีกครั้ง`;

    const status = buildRoundStatusMessage({
      sellerLabel: context.sellerLabel,
      marketLabel: context.marketLabel,
      dateThaiShort,
      totals: report.totals,
      slipCounts: summarizeSlipStatuses(report.slips),
      blockerLines: [
        ...report.blockers.map((b) => GUIDED_ROUND_BLOCKER_LABEL[b]),
        nextStepLine,
      ],
      closed: false,
      quickReply: controls?.quickReply,
    });

    const messages: GuidedMenuLineMessage[] = [status];
    if (template) {
      messages.push(
        ...buildSettlementTemplateMessages({
          template,
          sellerLabel: context.sellerLabel,
          marketLabel: context.marketLabel,
          dateThaiShort,
          quickReply: controls?.quickReply,
          stageControl: controls?.flex,
        }),
      );
    } else if (controls?.flex) {
      messages.push(controls.flex);
    }

    return resultEnvelope(
      template ? "settlement_template" : "round_status",
      messages,
      {
        stage: "reconcile",
        blockers: report.blockers,
        difference: report.totals.difference,
        settlement_template: template !== null,
      },
    );
  }

  private async renderCaptureStatus(
    identity: GuidedMenuIdentity,
    stage: "capture" | "awaiting_confirm",
  ): Promise<GuidedMenuUxResult> {
    const snapshot = await this.capture.snapshot(identity);
    if (snapshot.status !== "ok") return this.refusalEnvelope(snapshot.reason);

    const closeRequested = snapshot.closeRequested;
    const controls = closeRequested
      ? await this.buildConfirmStageControls(identity)
      : await this.buildCaptureStageControls(identity);
    const summary =
      snapshot.parsed.items.length > 0
        ? buildWeighSessionSummary(snapshot.parsed)
        : GUIDED_MENU_COPY.noCapturedItems;

    return resultEnvelope(
      "session_status",
      buildCapturedItemsMessages({
        summary: [summary, "", GUIDED_MENU_COPY.correctionHint].join("\n"),
        stageControl: controls?.flex,
        quickReply: controls?.quickReply,
        maxMessages: LINE_REPLY_MESSAGE_MAX,
      }),
      {
        item_count: snapshot.parsed.items.length,
        parse_error_count: snapshot.parsed.parse_errors.length,
        close_requested: closeRequested,
      },
    );
  }

  /** Slice 3C — hand the operator a ready-to-edit White Sheet closing command. */
  private async renderWhiteSheetStage(
    identity: GuidedMenuIdentity,
    context: GuidedJourneyContext,
  ): Promise<GuidedMenuUxResult> {
    const template = buildWhiteSheetTemplate(context);
    const dateThaiShort = thaiDateFromIso(context.businessDate);
    if (!template || !dateThaiShort) {
      return resultEnvelope("invalid", [buildInvalidMenuMessage()], {
        reason: "invalid_business_date",
      });
    }
    // Routine white-sheet-stage revisits: Quick Reply only. The template
    // message itself already carries the "form"; the one persistent Flex
    // card for this stage is sent once, at the finalize-confirmed transition
    // (see confirmFinalize / renderProduceOutcome's "confirmed" branch).
    const controls = await this.buildJourneyStageControls(
      identity,
      ["กรอกใบขาว", "ดูสถานะ"],
      "กรอกใบขาว",
      false,
    );
    return resultEnvelope(
      "white_sheet_template",
      buildWhiteSheetTemplateMessages({
        template,
        sellerLabel: context.sellerLabel,
        marketLabel: context.marketLabel,
        dateThaiShort,
        quickReply: controls?.quickReply,
        stageControl: controls?.flex,
      }),
      {
        stage: "white_sheet",
        market_label_normalized: context.marketLabelNormalized,
        business_date: context.businessDate,
      },
    );
  }

  /** Slice 3D — hand the operator the existing slip batch header. */
  private async renderSlipStage(
    identity: GuidedMenuIdentity,
    context: GuidedJourneyContext,
  ): Promise<GuidedMenuUxResult> {
    const header = buildSlipHeaderTemplate(context);
    const dateThaiShort = thaiDateFromIso(context.businessDate);
    if (!header || !dateThaiShort) {
      return resultEnvelope("invalid", [buildInvalidMenuMessage()], {
        reason: "invalid_business_date",
      });
    }
    // Routine slip-stage navigation: Quick Reply only, no persistent Flex.
    const controls = await this.buildJourneyStageControls(
      identity,
      ["ตรวจยอด", "ดูสถานะ"],
      "ส่งสลิป",
      false,
    );
    return resultEnvelope(
      "slip_instructions",
      buildSlipInstructionMessages({
        header,
        sellerLabel: context.sellerLabel,
        marketLabel: context.marketLabel,
        dateThaiShort,
        quickReply: controls?.quickReply,
        stageControl: controls?.flex,
      }),
      { stage: "slips", business_date: context.businessDate },
    );
  }

  private async requestClose(input: {
    identity: GuidedMenuIdentity;
    lineEventId: string;
    lineTimestampMs: number;
  }): Promise<GuidedMenuUxResult> {
    const outcome = await this.capture.requestClose({
      identity: input.identity,
      lineEventId: input.lineEventId,
      lineTimestampMs: input.lineTimestampMs,
    });
    if (outcome.status === "refused") return this.refusalEnvelope(outcome.reason);
    if (outcome.status === "conflict") {
      return resultEnvelope(
        "session_action_conflict",
        [buildSessionActionConflictMessage()],
        { reason: outcome.reason },
      );
    }

    // The round cannot finalize, so NO close boundary was created. The operator
    // stays in capture: "จบรายการ" is offered again and a corrected item line is
    // still an ordinary append — no administrator, no reopen contract.
    // P4A confirmable review. The round stays open until the operator corrects
    // the line or acknowledges exactly this exception set.
    if (outcome.status === "review_required") {
      const controls = await this.buildCaptureStageControls(input.identity);
      return resultEnvelope(
        "session_validation_review",
        buildCapturedItemsMessages({
          summary: outcome.detail,
          stageControl: controls?.flex,
          quickReply: controls?.quickReply,
          maxMessages: LINE_REPLY_MESSAGE_MAX,
        }),
        { close_reason: "review_required", close_requested: false, saved: false },
      );
    }

    if (outcome.status === "validation_failed") {
      const controls = await this.buildCaptureStageControls(input.identity);
      return resultEnvelope(
        "session_validation_failed",
        buildCapturedItemsMessages({
          summary: outcome.detail ?? [
            GUIDED_MENU_COPY.produceCloseValidationFailed,
            "",
            buildWeighSessionValidationReply(outcome.parsed),
          ].join("\n"),
          stageControl: controls?.flex,
          quickReply: controls?.quickReply,
          maxMessages: LINE_REPLY_MESSAGE_MAX,
        }),
        {
          close_reason: "validation_failed",
          close_requested: false,
          error_count: outcome.errors.length,
          saved: false,
        },
      );
    }

    const controls = await this.buildConfirmStageControls(input.identity);
    const summary =
      outcome.parsed.items.length > 0
        ? buildWeighSessionSummary(outcome.parsed)
        : GUIDED_MENU_COPY.noCapturedItems;

    return resultEnvelope(
      "session_close_requested",
      buildCapturedItemsMessages({
        summary: [summary, "", GUIDED_MENU_COPY.closeRequested].join("\n"),
        stageControl: controls?.flex,
        quickReply: controls?.quickReply,
        maxMessages: LINE_REPLY_MESSAGE_MAX,
      }),
      {
        close_reason: outcome.reason,
        item_count: outcome.parsed.items.length,
      },
    );
  }

  private async confirmFinalize(input: {
    identity: GuidedMenuIdentity;
    lineEventId: string;
    lineTimestampMs: number;
  }): Promise<GuidedMenuUxResult> {
    const outcome = await this.capture.confirmFinalize({
      identity: input.identity,
      lineEventId: input.lineEventId,
      lineTimestampMs: input.lineTimestampMs,
    });
    if (outcome.status === "refused") return this.refusalEnvelope(outcome.reason);
    if (outcome.status === "not_ready") {
      const controls = await this.buildConfirmStageControls(input.identity);
      const message = buildFinalizeNotReadyMessage();
      return resultEnvelope(
        "session_finalize_not_ready",
        controls?.flex ? [message, controls.flex] : [message],
        { reason: "not_ready", detail: outcome.detail ?? null },
      );
    }
    if (outcome.status === "conflict") {
      return resultEnvelope(
        "session_action_conflict",
        [buildSessionActionConflictMessage()],
        { reason: outcome.reason },
      );
    }

    // P4A confirmable review. Nothing was released; pressing "ยืนยัน" again
    // acknowledges exactly the set shown here.
    if (outcome.status === "review_required") {
      const controls = await this.buildConfirmStageControls(input.identity);
      return resultEnvelope(
        "session_validation_review",
        buildCapturedItemsMessages({
          summary: outcome.detail,
          stageControl: controls?.flex,
          quickReply: controls?.quickReply,
          maxMessages: LINE_REPLY_MESSAGE_MAX,
        }),
        { produce_finalization: null, saved: false, reason: "review_required" },
      );
    }

    // Releasing the hold is not the same as having produce rows. Only an
    // explicitly successful finalization status earns the White Sheet handoff.
    if (outcome.status !== "confirmed") {
      return this.renderUnfinishedProduce(input.identity, outcome);
    }

    const controls = await this.buildJourneyStageControls(
      input.identity,
      ["กรอกใบขาว", "ดูสถานะ"],
      "กรอกใบขาว",
    );
    return resultEnvelope(
      "session_finalize_confirmed",
      buildFinalizeConfirmedMessage({
        summary:
          outcome.parsed.items.length > 0
            ? buildWeighSessionSummary(outcome.parsed)
            : GUIDED_MENU_COPY.noCapturedItems,
        maxMessages: LINE_REPLY_MESSAGE_MAX,
        quickReply: controls?.quickReply,
        stageControl: controls?.flex,
      }),
      {
        confirm_reason: outcome.reason,
        produce_finalization: outcome.produce,
        item_count: outcome.parsed.items.length,
        next_step: "white_sheet",
      },
    );
  }

  /**
   * Everything short of a proven produce write.
   *
   * `validation_failed` refused before the confirm RPC; `finalizing` released
   * the hold but has no result yet; `finalize_failed` is terminal without a
   * successful status. None of them offer "กรอกใบขาว", and the failure copy says
   * plainly that the item list was not saved. The validation detail comes from
   * the existing `buildWeighSessionValidationReply`, so no internal error text
   * reaches LINE, and no cancel or reopen RPC is invented — recovery is an
   * administrator opening a fresh round.
   */
  private async renderUnfinishedProduce(
    identity: GuidedMenuIdentity,
    outcome: Extract<
      GuidedCaptureFinalizeOutcome,
      { status: "finalizing" | "finalize_failed" | "validation_failed" }
    >,
  ): Promise<GuidedMenuUxResult> {
    // Finalizing/failed status is a transient poll target ("ดูสถานะ"), never a
    // persistent Flex card — see message-economy rule in the UX spec.
    const controls = await this.buildJourneyStageControls(
      identity,
      ["ดูสถานะ"],
      "สถานะรายการ",
      false,
    );

    if (outcome.status === "finalizing") {
      const base = buildPlainTextMessage(GUIDED_MENU_COPY.produceFinalizing);
      const message = controls?.quickReply
        ? { ...base, quickReply: controls.quickReply }
        : base;
      return resultEnvelope(
        "session_finalizing",
        [message],
        { produce_finalization: "pending", saved: false },
      );
    }

    // The P4A gate supplies its own operator-facing detail; everything else
    // falls back to the parse-level reply, so no internal text reaches LINE.
    const detail =
      ("detail" in outcome && outcome.detail) || buildWeighSessionValidationReply(outcome.parsed);
    const screen =
      outcome.status === "validation_failed"
        ? ("session_validation_failed" as const)
        : ("session_finalize_failed" as const);
    const heading =
      outcome.status === "validation_failed"
        ? GUIDED_MENU_COPY.produceValidationFailed
        : GUIDED_MENU_COPY.produceFinalizeFailed;

    const messages = buildCapturedItemsMessages({
      summary: [heading, "", detail].join("\n"),
      stageControl: controls?.flex,
      quickReply: controls?.quickReply,
      maxMessages: LINE_REPLY_MESSAGE_MAX,
    });
    return resultEnvelope(screen, messages, {
      produce_finalization: outcome.status === "validation_failed" ? null : "failed",
      saved: false,
      error_count: outcome.errors.length,
    });
  }

  /** "ดูสถานะ" for a round whose hold is released — re-reads the real row. */
  private async renderProduceOutcome(
    identity: GuidedMenuIdentity,
  ): Promise<GuidedMenuUxResult> {
    const outcome = await this.capture.produceOutcome(identity);
    if (outcome.status === "refused") return this.refusalEnvelope(outcome.reason);
    if (outcome.status === "confirmed") {
      const controls = await this.buildJourneyStageControls(
        identity,
        ["กรอกใบขาว", "ดูสถานะ"],
        "กรอกใบขาว",
      );
      return resultEnvelope(
        "session_finalize_confirmed",
        buildFinalizeConfirmedMessage({
          summary:
            outcome.parsed.items.length > 0
              ? buildWeighSessionSummary(outcome.parsed)
              : GUIDED_MENU_COPY.noCapturedItems,
          maxMessages: LINE_REPLY_MESSAGE_MAX,
          quickReply: controls?.quickReply,
          stageControl: controls?.flex,
        }),
        {
          confirm_reason: outcome.reason,
          produce_finalization: outcome.produce,
          next_step: "white_sheet",
        },
      );
    }
    if (
      outcome.status === "finalizing" ||
      outcome.status === "finalize_failed" ||
      outcome.status === "validation_failed"
    ) {
      return this.renderUnfinishedProduce(identity, outcome);
    }
    return resultEnvelope(
      "session_action_conflict",
      [buildSessionActionConflictMessage()],
      { reason: "unexpected_produce_outcome" },
    );
  }

  private createTokenFn(identity: GuidedMenuIdentity): CreateToken {
    return async ({ actionType, payload }) => {
      const created = await this.state.createState({
        actionType,
        lineUserId: identity.lineUserId,
        sourceType: identity.sourceType,
        sourceId: identity.sourceId,
        sessionKey: identity.sessionKey,
        payload,
      } as CreateMenuStateInput);
      if (created.status !== "created") {
        throw new Error("guided menu state create refused");
      }
      return created.wireToken;
    };
  }

  private async buildTransactionTypeScreen(
    identity: GuidedMenuIdentity,
  ): Promise<GuidedMenuUxResult> {
    try {
      const create = this.createTokenFn(identity);
      const [withdraw, ret, damaged] = await Promise.all([
        create({
          actionType: "choose_transaction_type",
          payload: { transaction_type: "withdraw" },
        }),
        create({
          actionType: "choose_transaction_type",
          payload: { transaction_type: "return" },
        }),
        create({
          actionType: "choose_transaction_type",
          payload: { transaction_type: "damaged_return" },
        }),
      ]);
      const message = buildTransactionTypeMessage({
        withdraw,
        return: ret,
        damagedReturn: damaged,
      });
      return resultEnvelope("transaction_type", [message]);
    } catch {
      return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
    }
  }

  private async buildSellerScreen(
    identity: GuidedMenuIdentity,
    transactionType: MenuTransactionTypeCode,
  ): Promise<GuidedMenuUxResult> {
    const sellers = await this.state.listActiveSellers();
    if (sellers.length === 0) {
      return resultEnvelope("no_sellers", [buildNoActiveSellersMessage()]);
    }
    if (sellers.length > SELLERS_PER_MESSAGE * LINE_REPLY_MESSAGE_MAX) {
      return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
    }
    try {
      const create = this.createTokenFn(identity);
      const [sellerEntries, backToken, cancelToken] = await Promise.all([
        Promise.all(
          sellers.map(async (seller) => [
            seller.sellerCode,
            await create({
              actionType: "choose_seller",
              payload: {
                transaction_type: transactionType,
                seller_code: seller.sellerCode,
              },
            }),
          ] as const),
        ),
        create({ actionType: "menu_root", payload: {} }),
        create({ actionType: "menu_root", payload: { intent: "cancel" } }),
      ]);
      const sellerTokens = new Map(sellerEntries);
      const messages = buildSellerSelectMessages({
        transactionType,
        sellers,
        sellerTokens,
        backToken,
        cancelToken,
      });
      return resultEnvelope("seller", messages, {
        transaction_type: transactionType,
      });
    } catch {
      return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
    }
  }

  private async buildMarketScreen(
    identity: GuidedMenuIdentity,
    transactionType: MenuTransactionTypeCode,
    seller: GuidedMenuSeller,
    assignments: GuidedMenuSellerMarket[],
  ): Promise<GuidedMenuUxResult> {
    const markets = assignments.map((row) => ({
      code: row.marketCode,
      label: row.marketLabel,
    }));
    if (markets.length === 0) {
      return resultEnvelope("no_seller_markets", [
        buildNoActiveSellerMarketsMessage(),
      ]);
    }
    try {
      const create = this.createTokenFn(identity);
      const marketTokens = new Map<string, string>();
      for (const market of markets) {
        const token = await create({
          actionType: "choose_market",
          payload: {
            transaction_type: transactionType,
            seller_code: seller.sellerCode,
            market_code: market.code,
          },
        });
        marketTokens.set(market.code, token);
      }
      const [backToken, cancelToken] = await Promise.all([
        create({
          actionType: "choose_transaction_type",
          payload: { transaction_type: transactionType },
        }),
        create({ actionType: "menu_root", payload: { intent: "cancel" } }),
      ]);
      const message = buildMarketSelectMessage({
        transactionType,
        sellerLabel: seller.label,
        markets,
        marketTokens,
        backToken,
        cancelToken,
      });
      return resultEnvelope("market", [message], {
        transaction_type: transactionType,
        seller_code: seller.sellerCode,
      });
    } catch {
      return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
    }
  }

  private async buildDateScreen(
    identity: GuidedMenuIdentity,
    transactionType: MenuTransactionTypeCode,
    seller: GuidedMenuSeller,
    market: GuidedMenuMarketOption,
  ): Promise<GuidedMenuUxResult> {
    try {
      const create = this.createTokenFn(identity);
      const base = {
        transaction_type: transactionType,
        seller_code: seller.sellerCode,
        market_code: market.code,
      };
      const [todayToken, yesterdayToken, backToken, cancelToken] =
        await Promise.all([
          create({
            actionType: "choose_date",
            payload: { ...base, date_mode: "today" },
          }),
          create({
            actionType: "choose_date",
            payload: { ...base, date_mode: "yesterday" },
          }),
          create({
            actionType: "choose_seller",
            payload: {
              transaction_type: transactionType,
              seller_code: seller.sellerCode,
            },
          }),
          create({ actionType: "menu_root", payload: { intent: "cancel" } }),
        ]);
      const message = buildDateSelectMessage({
        transactionType,
        sellerLabel: seller.label,
        marketLabel: market.label,
        todayToken,
        yesterdayToken,
        backToken,
        cancelToken,
      });
      return resultEnvelope("date", [message], base);
    } catch {
      return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
    }
  }

  private async buildConfirmScreen(
    identity: GuidedMenuIdentity,
    transactionType: MenuTransactionTypeCode,
    seller: GuidedMenuSeller,
    market: GuidedMenuMarketOption,
    dateMode: Extract<MenuDateMode, "today" | "yesterday">,
    lineTimestampMs: number,
  ): Promise<GuidedMenuUxResult> {
    const resolved = resolveGuidedMenuDate(dateMode, lineTimestampMs);
    if (!resolved) {
      return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
    }

    try {
      const create = this.createTokenFn(identity);
      const selection: MenuPayloadByAction["confirm_open"] = {
        transaction_type: transactionType,
        seller_code: seller.sellerCode,
        market_code: market.code,
        date_mode: dateMode,
      };
      const [confirmToken, backToken, cancelToken] = await Promise.all([
        create({ actionType: "confirm_open", payload: selection }),
        create({
          actionType: "choose_market",
          payload: {
            transaction_type: transactionType,
            seller_code: seller.sellerCode,
            market_code: market.code,
          },
        }),
        create({ actionType: "menu_root", payload: { intent: "cancel" } }),
      ]);

      const message = buildConfirmPreviewMessage({
        transactionType,
        sellerLabel: seller.label,
        marketLabel: market.label,
        dateThaiShort: resolved.thaiShort,
        confirmToken,
        backToken,
        cancelToken,
      });

      return resultEnvelope("confirm", [message], {
        transaction_type: transactionType,
        seller_code: seller.sellerCode,
        market_code: market.code,
        date_mode: dateMode,
        business_date_iso: resolved.iso,
      });
    } catch {
      return resultEnvelope("invalid", [buildInvalidMenuMessage()]);
    }
  }
}

export function buildGuidedMenuIdentity(input: {
  lineUserId: string | null | undefined;
  sourceType: string;
  sourceId: string;
  sessionKey: string | null;
}): GuidedMenuIdentity | null {
  const lineUserId = (input.lineUserId ?? "").trim();
  if (!lineUserId) return null;
  const sourceType = asSourceType(input.sourceType);
  if (!sourceType) return null;
  const sourceId = input.sourceId.trim();
  if (!sourceId || sourceId === "unknown") return null;
  return {
    lineUserId,
    sourceType,
    sourceId,
    sessionKey: input.sessionKey,
  };
}
