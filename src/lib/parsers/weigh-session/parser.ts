import { BaseParser, type ParseResult } from "@/lib/parsers/base";
import type { LineMessageEvent, LineTextMessage } from "@/lib/line/types";
import { getUserId } from "@/lib/line/verify";
import { logger } from "@/lib/logger";
import { computeItemHash } from "@/lib/line/session-dedup-service";
import {
  bangkokBusinessDateFromTimestamp,
  bangkokBusinessDateNow,
} from "@/lib/business-date";
import { seedCentralPricesFromPersistedWithdrawals } from "@/lib/white-sheet/seed-from-withdrawal";
import {
  UNKNOWN_PRODUCT_CODE_ERROR,
  resolveItemLineProductCode,
  unknownProductCodeError,
} from "@/lib/produce/product-code/resolver";
import { canonicalProduceProductIdentity } from "@/lib/produce/product-vocabulary";
import { RE } from "./regex";
import { conversionFactor, isKnownUnit, normalizeUnitAlias, resolveUnitQuantity } from "./units";
import type {
  DraftItemAction,
  WeighSession,
  WeighSessionItem,
  TransactionType,
  SessionKind,
  BaseTransactionType,
} from "./types";
import type { WeighSessionSeed } from "./seed";
import { parseDraftItemCommandLine } from "./draft-item-command";
import {
  baseMainTransactionType,
  mainCloserCompatibility,
} from "./main-closer";

// Additional-batch header keyword → the base transaction type its items store.
export const ADDITIONAL_TYPE_MAP: Record<string, BaseTransactionType> = {
  "เบิกเพิ่ม":   "เบิก",
  "ชั่งคืนเพิ่ม": "คืน",
  "คืนเสียเพิ่ม": "คืนเสีย",
};

// Base transaction type → additional-batch keyword (for replies/closers).
export const ADDITIONAL_TYPE_LABEL: Record<BaseTransactionType, string> = {
  "เบิก":   "เบิกเพิ่ม",
  "คืน":    "ชั่งคืนเพิ่ม",
  "คืนเสีย": "คืนเสียเพิ่ม",
};

// ── Pure parse function (exported for unit tests) ─────────────────────────────

export function parseWeighSession(
  text:         string,
  fallbackDate: string | null = null,
  fallbackTime: string | null = null,
  seed:         WeighSessionSeed | null = null,
): WeighSession {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // A seeded parse receives immutable session metadata from a typed command
  // instead of inferring it from a header. It starts in the item state, so the
  // header branch below never runs and no later text line can overwrite the
  // operator's declared session. With no seed every initial value, and every
  // branch, is exactly what it was before seeding existed.
  const seeded = seed !== null;

  let senderName:      string | null = seed?.sender_name ?? null;
  let txTime:          string | null = seed?.transaction_time ?? null;
  let staffName:       string | null = seed?.staff_name ?? null;
  let date:            string | null = seed?.date ?? null;
  let sessionTitle:    string | null = seed?.session_title ?? null;
  let currentSection                 = seed?.current_section ?? "main";
  let currentTxType: TransactionType = seed?.current_transaction_type ?? "เบิก";
  let state: "header" | "items"      = seeded ? "items" : "header";
  let sessionKind: SessionKind       = seed?.session_kind ?? "main";
  let declaredTxType: BaseTransactionType | null = seed?.declared_transaction_type ?? null;
  let additionalOpener: string | null = seed?.additional_opener ?? null;
  let mainSessionType: BaseTransactionType | null =
    seeded && sessionKind === "main" ? baseMainTransactionType(currentTxType) : null;
  let mainSegmentClosed = false;

  const items:       WeighSessionItem[]        = [];
  const parseErrors: string[]                  = [];
  const draftItemActions: DraftItemAction[]    = [];
  let   pendingItem: Partial<WeighSessionItem> | null = null;
  // Raw source lines that built the current pendingItem — surfaced in the
  // "no price line" error below so the user can find and resend it.
  let   pendingItemLines: string[]              = [];
  let activeCorrection: {
    action: DraftItemAction;
    targetIndex: number | null;
    targetItem: WeighSessionItem | null;
  } | null = null;

  const failActiveCorrection = (detail: string) => {
    if (!activeCorrection) {
      parseErrors.push(detail);
      return;
    }
    if (
      activeCorrection.action.status !== "target_not_found"
      && activeCorrection.action.status !== "ambiguous_target"
    ) {
      activeCorrection.action.status = "invalid_replacement";
      activeCorrection.action.detail = detail;
      parseErrors.push(`แก้ข้อ ${activeCorrection.action.item_number} ไม่สำเร็จ: ${detail}`);
    }
    activeCorrection = null;
  };

  const recordItemParseError = (detail: string) => {
    if (activeCorrection) failActiveCorrection(detail);
    else parseErrors.push(detail);
  };

  const commitParsedItem = (item: WeighSessionItem) => {
    if (!activeCorrection) {
      pushOrMergeItem(items, item);
      return;
    }

    const correction = activeCorrection;
    if (
      correction.action.status === "target_not_found"
      || correction.action.status === "ambiguous_target"
    ) {
      activeCorrection = null;
      return;
    }
    if (
      correction.targetIndex === null
      || correction.targetItem === null
      || item.item_number !== correction.action.item_number
    ) {
      failActiveCorrection(
        `รายการใหม่ต้องใช้เลขข้อ ${correction.action.item_number}`,
      );
      return;
    }
    if (!hasValidQuantity(item)) {
      failActiveCorrection("รายการใหม่ยังไม่มีจำนวนและหน่วยที่ใช้ได้");
      return;
    }
    if (!item.unit || !isKnownUnit(item.unit)) {
      failActiveCorrection(
        `หน่วย “${item.unit}” ไม่ถูกต้อง รายการเดิมจึงยังอยู่`,
      );
      return;
    }

    const replacement: WeighSessionItem = {
      ...item,
      item_number: correction.action.item_number,
      section: correction.targetItem.section,
      transaction_type: correction.targetItem.transaction_type,
    };
    items[correction.targetIndex] = replacement;
    correction.action.status = "applied";
    correction.action.replacement_item = { ...replacement };
    activeCorrection = null;
  };

  const closeCurrentPendingItem = () => {
    if (!pendingItem?.product_name) {
      pendingItem = null;
      pendingItemLines = [];
      return;
    }
    if (pendingItem.price_per_unit === undefined) {
      recordItemParseError(
        `item #${pendingItem.item_number} ${pendingItem.product_name} has no price line: `
        + `"${pendingItemLines.join(" ")}"`,
      );
    } else {
      const section = activeCorrection?.targetItem?.section ?? currentSection;
      const txType = activeCorrection?.targetItem?.transaction_type ?? currentTxType;
      commitParsedItem(finalize(pendingItem, section, txType));
    }
    pendingItem = null;
    pendingItemLines = [];
  };

  for (const line of lines) {
    const prefixMatch = line.match(RE.TIME_PREFIX);
    let   content: string;

    if (prefixMatch) {
      // Capture sender and time from first TIME_PREFIX occurrence. Seeded
      // sessions keep the typed identity/time: a LINE export prefix on an item
      // line must not restate who opened the session or when.
      if (!senderName && !seeded) {
        senderName = prefixMatch[2];
        txTime     = prefixMatch[1]; // "HH:MM" or "HH.MM"
      }
      content = prefixMatch[3].trim();
    } else {
      content = line;
    }

    // ── Date extraction ────────────────────────────────────────────────────
    if (!date && !prefixMatch) {
      const m = content.match(RE.DATE_ONLY);
      if (m) {
        date = parseBuddhistDate(m[1], m[2], m[3]);
        continue;
      }
    }
    if (!date) {
      const m = content.match(RE.DATE_IN_TEXT);
      if (m) date = parseBuddhistDate(m[1], m[2], m[3]);
    }

    // ── Explicit same-draft item correction/removal ───────────────────────
    const draftCommand = parseDraftItemCommandLine(content);
    if (draftCommand) {
      if (activeCorrection) {
        if (pendingItem) closeCurrentPendingItem();
        else failActiveCorrection("ยังไม่ได้ส่งรายการใหม่ให้ครบ");
      } else {
        closeCurrentPendingItem();
      }

      const matches = items
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => item.item_number === draftCommand.itemNumber);
      const status = matches.length === 0
        ? "target_not_found"
        : matches.length > 1
          ? "ambiguous_target"
          : draftCommand.kind === "remove"
            ? "applied"
            : "awaiting_replacement";
      const action: DraftItemAction = {
        kind: draftCommand.kind,
        item_number: draftCommand.itemNumber,
        status,
        match_count: matches.length,
        ...(matches.length === 1 ? { previous_item: { ...matches[0].item } } : {}),
      };
      draftItemActions.push(action);

      if (matches.length === 0) {
        parseErrors.push(`ไม่พบข้อ ${draftCommand.itemNumber} ในรายการที่กำลังกรอก`);
      } else if (matches.length > 1) {
        parseErrors.push(`เลขข้อ ${draftCommand.itemNumber} ซ้ำ จึงระบุรายการที่จะแก้ไม่ได้`);
      }

      if (draftCommand.kind === "remove") {
        if (matches.length === 1) items.splice(matches[0].index, 1);
      } else {
        activeCorrection = {
          action,
          targetIndex: matches.length === 1 ? matches[0].index : null,
          targetItem: matches.length === 1 ? { ...matches[0].item } : null,
        };
      }
      continue;
    }

    // ── Session end ────────────────────────────────────────────────────────
    if (RE.SESSION_END.test(content)) {
      if (pendingItem) closeCurrentPendingItem();
      else if (activeCorrection?.action.status === "awaiting_replacement") {
        failActiveCorrection("ยังไม่ได้ส่งรายการใหม่ให้ครบ");
      } else {
        activeCorrection = null;
      }
      // Closer/opener discipline: an additional batch must close with its own
      // matching จบรายการ<type>เพิ่ม closer, and additional closers are invalid
      // for main sessions.
      const additionalEnd = content.match(RE.ADDITIONAL_END);
      if (sessionKind === "additional") {
        if (!additionalEnd || additionalEnd[1] !== additionalOpener) {
          parseErrors.push(
            `wrong closer for additional session (expected จบรายการ${additionalOpener}): "${line}"`,
          );
        }
      } else if (additionalEnd) {
        parseErrors.push(`additional closer without an additional header: "${line}"`);
      } else if (mainSessionType) {
        const compatibility = mainCloserCompatibility(mainSessionType, content);
        if (compatibility && !compatibility.compatible) {
          recordItemParseError(
            `wrong closer for main session (expected ${compatibility.expectedCloser}): "${line}"`,
          );
        }
      }
      if (sessionKind === "main") mainSegmentClosed = true;
      currentSection = "main";
      continue;
    }

    // ── Header state: wait for session title ───────────────────────────────
    if (state === "header") {
      // A document may open on its first item instead of a header, so codes are
      // resolved here too. A real header line never matches: the pattern needs
      // digits immediately after a single namespace character, which "กี้-ตลาด
      // เบิก 13/8/2569" has nowhere.
      const headerCode = resolveItemLineProductCode(content);
      if (headerCode.kind === "unknown") {
        parseErrors.push(unknownProductCodeError(headerCode.code, line));
        continue;
      }
      // Accept both prefixed (LINE export) and bare (direct typed) header lines.
      const headerItem = parseItemLine(headerCode.content, nextItemNumber(items, pendingItem));
      if (headerItem === "orphan_basis") {
        parseErrors.push(`orphan basis line (no product name): "${line}"`);
        continue;
      }
      if (headerItem) {
        pendingItem = headerItem;
        pendingItemLines = [line];
        state = "items";
        continue;
      }

      // Additional-batch opener — must win over SELLER_MARKET (whose
      // alternation would also match เบิกเพิ่ม). Requires full anchored
      // "ชื่อ-ตลาด <type>เพิ่ม วันที่" — staff, market, type, and date are all
      // explicit, with no fallback to sender name or today.
      const addMatch = content.match(RE.ADDITIONAL_HEADER);
      if (addMatch) {
        staffName        = addMatch[1].trim();
        sessionTitle     = addMatch[2].trim();
        additionalOpener = addMatch[3];
        declaredTxType   = ADDITIONAL_TYPE_MAP[addMatch[3]];
        sessionKind      = "additional";
        currentTxType    = declaredTxType;
        const dm = addMatch[4].match(RE.DATE_IN_TEXT);
        if (dm) date = parseBuddhistDate(dm[1], dm[2], dm[3]);
        state = "items";
        continue;
      }

      // Try "พี่ดำ-วิหาร เบิก ..." format first
      const smMatch = content.match(RE.SELLER_MARKET);
      if (smMatch) {
        staffName    = smMatch[1].trim();
        sessionTitle = smMatch[2].trim();
        currentTxType = classifyTxType(smMatch[3] as TransactionType);
        mainSessionType = baseMainTransactionType(currentTxType);
        state = "items";
        continue;
      }

      // Fall back to traditional "รายการชั่งเบิก" etc.
      if (RE.SESSION_START.test(content)) {
        sessionTitle  = content;
        currentTxType = classifyTxType(content);
        mainSessionType = baseMainTransactionType(currentTxType);
        state         = "items";
      }
      continue;
    }

    // ── Items state ────────────────────────────────────────────────────────

    // Quantity, item, name-only header, price continuation, or tx-type
    // marker. Applies identically whether this line carries a LINE-export
    // "HH:MM sender" prefix or not — `content` is already prefix-stripped
    // above, and a prefixed continuation line (e.g. a price-only or
    // quantity-only line inside a pasted chat export) needs the same general
    // multiline handling as an unprefixed one. Previously this general logic
    // only ran for `!prefixMatch` lines, so a multiline item split across
    // TIME_PREFIX-prefixed lines was silently rejected line-by-line.
    {
      const qm = content.match(RE.QUANTITY);
      if (qm && qm[2] !== "บาท") {
        if (pendingItem?.product_name && pendingItem.price_per_unit !== undefined) {
          // Pending item already has a price and is awaiting quantity — this
          // is the only shape allowed to match ANY unit text (known or not),
          // matching prior behavior exactly. Never reached with an item that
          // still needs a price (see the branches below).
          applyQuantity(pendingItem, parseFloat(qm[1]), qm[2]);
          if (pendingItem.basis_unit && pendingItem.unit !== pendingItem.basis_unit) {
            const wasCorrection = activeCorrection !== null;
            recordItemParseError(
              `basis unit mismatch for item #${pendingItem.item_number} "${pendingItem.product_name}": ` +
              `basis is per ${pendingItem.basis_unit} but quantity line uses ${pendingItem.unit}`,
            );
            if (wasCorrection) {
              pendingItem = null;
              pendingItemLines = [];
              continue;
            }
          }
          const finalizedItem = finalize(pendingItem, currentSection, currentTxType);
          commitParsedItem(finalizedItem);
          pendingItem = null;
          pendingItemLines = [];
          continue;
        }
        if (isKnownUnit(qm[2])) {
          // A recognized unit with nothing (correctly) awaiting quantity —
          // either a genuine orphan, or the pending item is still missing
          // its own price. Never silently misattributed onto the wrong item.
          if (pendingItem?.product_name) {
            recordItemParseError(
              `item #${pendingItem.item_number} ${pendingItem.product_name} is missing a price line ` +
              `before its quantity: "${line}"`,
            );
            pendingItem = null;
            pendingItemLines = [];
          } else {
            recordItemParseError(`quantity with no preceding item: "${line}"`);
          }
          continue;
        }
        // Unknown unit with no item awaiting quantity — falls through to be
        // read as a name-only item header below (general multiline split).
      }

      // Standalone price line for an item whose name arrived with no price.
      const priceOnly = normalizeItemLinePunctuation(content).match(RE.PRICE_ONLY);
      if (priceOnly && pendingItem?.product_name && pendingItem.price_per_unit === undefined) {
        pendingItem.price_per_unit = parseFloat(priceOnly[1]);
        pendingItemLines.push(line);
        continue;
      }

      // Product Code resolution — the narrowest boundary that exists: the line
      // is already past the quantity and price-continuation branches, so what
      // remains is an item line, and only its leading product token is
      // rewritten. A code-shaped token with no registry entry never becomes a
      // literal product named "ม999"; it fails closed like any other parse
      // error, which is what stops the round from taking on junk identity.
      const codeResolution = resolveItemLineProductCode(content);
      if (codeResolution.kind === "unknown") {
        closeCurrentPendingItem();
        recordItemParseError(unknownProductCodeError(codeResolution.code, line));
        continue;
      }
      const itemContent = codeResolution.content;

      const parsedItem = parseItemLine(itemContent, nextItemNumber(items, pendingItem));
      if (parsedItem === "orphan_basis") {
        closeCurrentPendingItem();
        recordItemParseError(`orphan basis line (no product name): "${line}"`);
      } else if (parsedItem) {
        // A new single-line item header — with or without a LINE-export prefix.
        closeCurrentPendingItem();
        pendingItem = parsedItem;
        pendingItemLines = [line];
      } else {
        // General multiline split: product name arrives on its own line,
        // price and quantity follow on later lines. Never a special-case for
        // any specific product — any name whose trailing token isn't a known
        // unit word qualifies (see units.ts).
        const nameOnly = itemContent.match(RE.ITEM_NAME_ONLY);
        if (nameOnly && !isKnownUnit(nameOnly[2].trim())) {
          closeCurrentPendingItem();
          pendingItem = {
            item_number:    parseInt(nameOnly[1], 10),
            item_number_explicit: true,
            product_name:   nameOnly[2].trim(),
            quantity:       null,
            unit:           null,
            pricing_mode:   "unit",
            basis_quantity: null,
            basis_unit:     null,
            basis_price:    null,
            // price_per_unit intentionally omitted — awaiting a price line.
          };
          pendingItemLines = [line];
        } else if (content.length > 0) {
          // Non-item bare line → section / transaction-type marker
          closeCurrentPendingItem();
          const nextTxType = detectTxType(content);
          if (nextTxType && sessionKind === "additional") {
            // An additional batch carries exactly one declared type end-to-end.
            recordItemParseError(`section change not allowed in additional session: "${line}"`);
          } else if (nextTxType) {
            currentSection = content;
            currentTxType  = nextTxType;
            if (mainSegmentClosed) {
              mainSessionType = baseMainTransactionType(nextTxType);
              mainSegmentClosed = false;
            }
          } else {
            recordItemParseError(`unrecognized line: "${line}"`);
          }
        }
      }
      continue;
    }
  }

  // A correction may span LINE messages. End-of-document is not failure: the
  // next raw message can complete the replacement. The old item remains the
  // effective version until that happens.
  if (activeCorrection?.action.status === "awaiting_replacement") {
    const detail = pendingItem
      ? "รอจำนวนและหน่วยของรายการใหม่"
      : "รอรายการใหม่";
    activeCorrection.action.detail = detail;
    parseErrors.push(`แก้ข้อ ${activeCorrection.action.item_number}: ${detail}`);
  } else if (!activeCorrection) {
    closeCurrentPendingItem();
  }

  return {
    // Additional sessions must carry an explicit date — never fall back to
    // the event's business date (see ADDITIONAL_HEADER, which requires one).
    date:             sessionKind === "additional" ? date : (date ?? fallbackDate),
    staff_name:       staffName ?? senderName ?? "",
    sender_name:      senderName,
    transaction_time: txTime ?? fallbackTime ?? null,
    session_title:    sessionTitle,
    session_kind:     sessionKind,
    declared_transaction_type: declaredTxType,
    items,
    parse_errors:     parseErrors,
    draft_item_actions: draftItemActions,
  };
}

export function getWeighSessionFinalizationErrors(session: WeighSession): string[] {
  const errors = [...session.parse_errors];

  for (const item of session.items) {
    if (
      item.quantity === null ||
      !Number.isFinite(item.quantity) ||
      item.quantity <= 0 ||
      item.unit === null
    ) {
      errors.push(
        `item #${item.item_number} "${item.product_name}" has invalid quantity or unit`,
      );
    }
  }

  if (session.session_kind === "additional") {
    if (!session.staff_name) errors.push("additional session requires an explicit staff name");
    if (!session.session_title) errors.push("additional session requires an explicit market");
    if (!session.date) errors.push("additional session requires an explicit date");
    if (!session.declared_transaction_type) {
      errors.push("additional session requires a declared base transaction type");
    }

    const seen = new Set<number>();
    for (const item of session.items) {
      if (seen.has(item.item_number)) {
        errors.push(`duplicate item number #${item.item_number} in additional session`);
      }
      seen.add(item.item_number);
    }
  }

  return errors;
}

export function assertWeighSessionFinalizable(session: WeighSession): void {
  const errors = getWeighSessionFinalizationErrors(session);
  if (errors.length > 0) {
    throw new Error(`weigh session validation failed: ${errors.join("; ")}`);
  }
}

export function buildWeighSessionValidationReply(session: WeighSession): string {
  const invalidItemCount = session.items.filter(isIncompleteItem).length;
  const successCount     = session.items.length - invalidItemCount;
  const failCount        = session.parse_errors.length + invalidItemCount;

  const details = getWeighSessionFinalizationErrors(session).map((error) => {
    // An unregistered code is named explicitly rather than shown as a line the
    // bot "could not read" — the operator's next move is to check the code, not
    // to retype the line. Nothing about this row was saved.
    const unknownCode = error.match(UNKNOWN_PRODUCT_CODE_ERROR);
    if (unknownCode) {
      return `- ${unknownCode[2]} → ไม่พบรหัสสินค้า ${unknownCode[1]} ในทะเบียนรหัสสินค้า`;
    }

    const quotedLine = error.match(/"([^"]+)"/)?.[1];
    if (quotedLine) return `- ${quotedLine}`;

    const item = error.match(/^item #(\d+) "([^"]+)"/);
    if (item) return `- รายการ #${item[1]} ${item[2]}: จำนวนหรือหน่วยไม่ถูกต้อง`;

    return `- ${error}`;
  });

  return [
    "อ่านรายการไม่ครบ จึงยังไม่บันทึก",
    `อ่านสำเร็จ ${successCount} รายการ`,
    `อ่านไม่สำเร็จ ${failCount} รายการ`,
    "กรุณาตรวจสอบบรรทัดสินค้าและจำนวน แล้วส่งใหม่",
    ...details,
  ].join("\n");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Closes out whatever the parser currently has pending, at any point another
 * line would otherwise replace or discard it (a new item header, a section
 * marker, the session-end line, or end of input). An item with a price is
 * finalized as before; an item still awaiting its price is never silently
 * dropped or turned into a fake complete row — it becomes a parse error that
 * quotes its own source line(s) so the user can find and resend it.
 */
function applyQuantity(
  item: Partial<WeighSessionItem>,
  quantity: number,
  unit: string,
): void {
  // Only the measurement is converted. price_per_unit came off the item
  // header, where it is always quoted per the canonical selling unit — a
  // subunit quantity line (0.7ขีด) restates how much was weighed, never the
  // price basis. A price quoted per a different amount is its own grammar:
  // pricing_mode "basis" (see parseItemLine's ITEM_WITH_BASIS branch).
  const resolved = resolveUnitQuantity(quantity, unit);
  if (unit.trim() === "ขีด" || unit.trim() === "กรัม") {
    item.entered_quantity = quantity;
    item.entered_unit = unit.trim();
  }
  item.quantity  = resolved.quantity;
  item.unit      = resolved.unit;

  // The one place the retired rescaling still gets computed — as evidence, not
  // as the item's price. Every duplicate-detection fingerprint folds
  // price_per_unit in, so a message imported before the fix is reserved under
  // the OLD price; without this a resend of one would hash as a new document
  // and persist a second time. Never assigned to price_per_unit, never
  // persisted, never part of business content.
  const factor = conversionFactor(unit);
  if (item.basis_quantity == null && factor !== 1) {
    item.legacy_subunit_price_per_unit = Number((item.price_per_unit! / factor).toFixed(2));
  }
}

function finalize(
  p:       Partial<WeighSessionItem>,
  section: string,
  txType:  TransactionType,
): WeighSessionItem {
  return {
    item_number:      p.item_number!,
    product_name:     p.product_name!,
    price_per_unit:   p.price_per_unit!,
    quantity:         p.quantity ?? null,
    unit:             p.unit ? normalizeUnitAlias(p.unit) : null,
    section,
    transaction_type: txType,
    pricing_mode:     p.pricing_mode ?? "unit",
    basis_quantity:   p.basis_quantity ?? null,
    basis_unit:       p.basis_unit     ?? null,
    basis_price:      p.basis_price    ?? null,
    legacy_subunit_price_per_unit: p.legacy_subunit_price_per_unit,
    entered_quantity: p.entered_quantity,
    entered_unit: p.entered_unit,
    item_number_explicit: p.item_number_explicit,
  };
}

function pushOrMergeItem(items: WeighSessionItem[], item: WeighSessionItem): void {
  const existingIndex = findMergeCandidateIndex(items, item);

  if (existingIndex === -1) {
    items.push(item);
    return;
  }

  if (hasValidQuantity(item)) {
    items[existingIndex] = {
      ...item,
      item_number: items[existingIndex].item_number,
      // The kept number's provenance travels with it; the incoming line's
      // flag describes a number that is being discarded here.
      item_number_explicit: items[existingIndex].item_number_explicit,
      section: items[existingIndex].section,
      transaction_type: items[existingIndex].transaction_type,
    };
    return;
  }

  // Avoid appending repeated zero/null placeholders for the same product+price.
}

/**
 * Parses one item header line. Returns:
 *   - a partial item for a normal or basis-priced header
 *   - "orphan_basis" for a bare "<qty><unit><price>บาท" line with no product
 *     name (e.g. "3โล100บาท" alone) — the leading digit run reads as an
 *     item_number and the unit word as a "product name", which would create
 *     a phantom item; callers must record an explicit error instead.
 *   - null if the line isn't an item header at all
 */
function parseItemLine(
  content: string,
  fallbackItemNumber: number,
): Partial<WeighSessionItem> | "orphan_basis" | null {
  const normalizedContent = normalizeItemLinePunctuation(content);

  // Parsed backwards from the final บาท token: item_number, product_name,
  // then a bundled basis quantity/unit/price. Tried before the plain ITEM
  // pattern since it's the more specific shape (two digit runs, not one) —
  // a plain "<product>NNบาท" line (e.g. "102.ฝักกระเจียบ20บาท", which starts
  // with the unit word ฝัก) only has one digit run before บาท and so never
  // matches here.
  const withBasis = normalizedContent.match(RE.ITEM_WITH_BASIS);
  if (withBasis) {
    const resolved = resolveUnitQuantity(parseFloat(withBasis[3]), withBasis[4]);
    if (!Number.isFinite(resolved.quantity) || resolved.quantity <= 0) return null; // fail closed: zero/invalid basis quantity

    return {
      item_number:    parseInt(withBasis[1], 10),
      item_number_explicit: true,
      product_name:   withBasis[2].trim(),
      price_per_unit: Number((parseFloat(withBasis[5]) / resolved.quantity).toFixed(2)),
      quantity:       null,
      unit:           null,
      pricing_mode:   "basis",
      basis_quantity: resolved.quantity,
      basis_unit:     resolved.unit,
      basis_price:    parseFloat(withBasis[5]),
      ...(withBasis[4] === "ขีด" || withBasis[4] === "กรัม"
        ? { entered_quantity: parseFloat(withBasis[3]), entered_unit: withBasis[4] }
        : {}),
    };
  }

  const indexed = normalizedContent.match(RE.ITEM);
  if (indexed) {
    const productName = indexed[2].trim();
    // "<digits><unit word><digits>บาท" with the leading digits misread as an
    // item_number and the unit word as the product name — e.g. a standalone
    // "3โล100บาท" with nothing identifying an actual product. Never persist
    // this as a phantom item.
    if (isKnownUnit(productName)) return "orphan_basis";

    return {
      item_number:    parseInt(indexed[1], 10),
      item_number_explicit: true,
      product_name:   productName,
      price_per_unit: parseFloat(indexed[3]),
      quantity:       null,
      unit:           null,
      pricing_mode:   "unit",
      basis_quantity: null,
      basis_unit:     null,
      basis_price:    null,
    };
  }

  const unindexed = normalizedContent.match(RE.ITEM_NO_INDEX);
  if (unindexed) {
    return {
      item_number:    fallbackItemNumber,
      product_name:   unindexed[1].trim(),
      price_per_unit: parseFloat(unindexed[2]),
      quantity:       null,
      unit:           null,
      pricing_mode:   "unit",
      basis_quantity: null,
      basis_unit:     null,
      basis_price:    null,
    };
  }

  return null;
}

function normalizeItemLinePunctuation(content: string): string {
  return content
    .replace(/(\d)\.\s*บาท\.?\s*$/, "$1บาท")
    .replace(/บาท\.\s*$/, "บาท");
}

function nextItemNumber(
  items: WeighSessionItem[],
  pendingItem: Partial<WeighSessionItem> | null,
): number {
  const maxExisting = items.reduce((max, item) => Math.max(max, item.item_number), 0);
  return Math.max(maxExisting, pendingItem?.item_number ?? 0) + 1;
}

function findMergeCandidateIndex(items: WeighSessionItem[], item: WeighSessionItem): number {
  if (hasValidQuantity(item)) {
    const sameIndex = items.findIndex((existing) =>
      existing.item_number === item.item_number &&
      existing.transaction_type === item.transaction_type &&
      (isIncompleteItem(existing) || sameProductAndPrice(existing, item)),
    );
    if (sameIndex !== -1) return sameIndex;
  }

  return items.findIndex((existing) =>
    sameProductAndPrice(existing, item) &&
    existing.transaction_type === item.transaction_type &&
    isIncompleteItem(existing),
  );
}

function sameProductAndPrice(a: WeighSessionItem, b: WeighSessionItem): boolean {
  return normalizeProductName(a.product_name) === normalizeProductName(b.product_name)
    && a.price_per_unit === b.price_per_unit;
}

function normalizeProductName(name: string): string {
  return name.replace(/\s+/g, "").trim();
}

function isMissingQuantity(quantity: number | null): boolean {
  return quantity === null || quantity === 0;
}

function isIncompleteItem(item: WeighSessionItem): boolean {
  return isMissingQuantity(item.quantity) || item.unit === null;
}

function hasValidQuantity(item: WeighSessionItem): boolean {
  return item.quantity !== null && Number.isFinite(item.quantity) && item.quantity > 0 && item.unit !== null;
}

function classifyTxType(text: string): TransactionType {
  return detectTxType(text) ?? "เบิก"; // safe default for session headers
}

function detectTxType(text: string): TransactionType | null {
  if (RE.TX_TYPE_BEIK_PHERM.test(text)) return "เบิกเพิ่ม";
  if (RE.TX_TYPE_KUEN_SIA.test(text))   return "คืนเสีย";
  if (RE.TX_TYPE_KUEN.test(text))       return "คืน";
  if (RE.TX_TYPE_BEIK.test(text))       return "เบิก";
  return null;
}

/**
 * Converts a Thai Buddhist calendar date to an ISO 8601 string.
 * Accepts 2-digit short years (69 → 2569 BE) and 4-digit years (2568 BE).
 */
export function parseBuddhistDate(day: string, month: string, year: string): string {
  let buddhistYear = parseInt(year, 10);
  if (buddhistYear < 100) buddhistYear += 2500; // "69" → 2569
  const gregorianYear = buddhistYear - 543;
  return `${gregorianYear}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/** Converts a LINE event timestamp (ms) to Bangkok local time "HH:mm". */
export function bangkokTimeFromTimestamp(ts: number | undefined): string | null {
  if (ts == null || !Number.isFinite(ts)) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Bangkok",
    hour:     "2-digit",
    minute:   "2-digit",
    hour12:   false,
  }).formatToParts(new Date(ts));

  const h = parts.find((p) => p.type === "hour")?.value;
  const m = parts.find((p) => p.type === "minute")?.value;

  return h && m ? `${h}:${m}` : null;
}

// ── Parser class ──────────────────────────────────────────────────────────────

export class WeighSessionParser extends BaseParser {
  name           = "weigh-session";
  version        = "1.1.0";
  supportedTypes = ["text"];

  override canHandle(event: LineMessageEvent): boolean {
    if (event.message.type !== "text") return false;
    return RE.SESSION_START.test((event.message as LineTextMessage).text);
  }

  async parse(event: LineMessageEvent): Promise<ParseResult> {
    const text   = (event.message as LineTextMessage).text;
    const userId = getUserId(event.source);
    const parsed = parseWeighSession(
      text,
      bangkokBusinessDateFromTimestamp(event.timestamp),
      bangkokTimeFromTimestamp(event.timestamp),
    );

    const log = logger.child({
      parser: this.name,
      staff:  parsed.staff_name,
      items:  parsed.items.length,
    });

    if (parsed.parse_errors.length > 0) {
      log.warn("parse completed with unrecognized lines", { errors: parsed.parse_errors });
    } else {
      log.info("parse succeeded");
    }

    return {
      parserName:    this.name,
      parserVersion: this.version,
      data:          parsed as unknown as Record<string, unknown>,

      persist: async (supabase, rawMessageId) => {
        assertWeighSessionFinalizable(parsed);
        const persistedItems = parsed.items.map((item) => ({
          ...item,
          product_name: canonicalProduceProductIdentity(item.product_name, item.unit),
        }));
        const persistedParsed = { ...parsed, items: persistedItems };

        const { data: session, error: sessionErr } = await supabase
          .from("produce_sessions")
          .insert({
            raw_message_id:   rawMessageId,
            line_user_id:     userId,
            staff_name:       parsed.staff_name,
            sender_name:      parsed.sender_name   ?? undefined,
            transaction_time: parsed.transaction_time ?? undefined,
            session_date:     parsed.date          ?? undefined,
            session_title:    parsed.session_title ?? undefined,
            total_items:      parsed.items.length,
            parser_errors:    parsed.parse_errors.length > 0 ? parsed.parse_errors : null,
          })
          .select("id")
          .single();

        if (sessionErr) {
          throw new Error(`produce_session insert failed: ${sessionErr.message}`);
        }

        try {
          for (const item of persistedItems) {
            const { error: itemErr } = await supabase
              .from("produce_items")
              .insert({
                session_id:       session.id,
                item_number:      item.item_number,
                product_name:     item.product_name,
                price_per_unit:   item.price_per_unit,
                quantity:         item.quantity    ?? undefined,
                unit:             item.unit        ?? undefined,
                section:          item.section,
                transaction_type: item.transaction_type,
                item_hash:        computeItemHash(persistedParsed, item),
                basis_quantity:   item.basis_quantity ?? undefined,
                basis_unit:       item.basis_unit     ?? undefined,
                basis_price:      item.basis_price    ?? undefined,
              });

            if (itemErr) {
              throw new Error(`produce_item insert failed for ${item.product_name}: ${itemErr.message}`);
            }
          }
        } catch (err) {
          await supabase.from("produce_sessions").delete().eq("id", session.id);
          throw err;
        }

        // BR-01: seed central prices only after withdrawal rows are persisted.
        // Failures here leave the session intact (withdrawal already committed);
        // White Sheet fails closed on missing price until an admin intervenes.
        await seedCentralPricesFromPersistedWithdrawals(supabase, {
          businessDate: parsed.date ?? bangkokBusinessDateNow(),
          items: persistedItems,
        });
      },
    };
  }
}
