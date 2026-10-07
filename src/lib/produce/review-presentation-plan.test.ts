/**
 * What one LINE review message is entitled to authorize.
 *
 * Two rules decide it, and both exist because a review the operator never read
 * must never become confirmable:
 *
 *   - the WHOLE-review digest authorizes the entire exception set, so it may be
 *     marked delivered only when the message rendered every one of them;
 *   - each risky-subunit review carries its OWN digest, because #109 confirms
 *     those items individually with "ยืนยันข้อ N" — leaving them unmarked would
 *     make that command answer not_presented for an item on screen.
 *
 * The renderer drops exception blocks to fit the LINE budget, so "was in
 * result.reviews" and "was shown" are different questions.
 */
import { describe, expect, it } from "bun:test";
import {
  buildPlainTextReviewPresentation,
  buildPlainTextReviewPresentationPages,
} from "./entry-validation-message";
import {
  deliveredPresentationDigests,
  reviewPresentationDigests,
  type ProduceValidationSessionRef,
} from "./entry-validation-gate";
import { computeValidationDigest, type ProduceValidationResult } from "./entry-validation";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";

const REF: ProduceValidationSessionRef = {
  sessionKey: "group:test-market-1:user:test-staff-1",
  sessionGeneration: "44444444-4444-4444-8444-444444444444",
  accountabilityRoundId: "55555555-5555-4555-8555-555555555555",
  businessDate: "2017-01-01",
  marketLabel: "ตลาดทดสอบ",
  staffLabel: "ทดสอบ",
  lineUserId: "user-1",
};

const PARSED = parseWeighSession(
  ["ทดสอบ-ตลาดทดสอบ เบิก 1/1/2560", "1ผลไม้ทดสอบเอ100บาท", "2ถุง"].join("\n"),
);

function subunit(itemNumber: number, productName: string) {
  return {
    kind: "subunit_confirmation" as const,
    itemNumber,
    productName,
    enteredQuantity: 5,
    enteredUnit: "ขีด" as const,
    canonicalQuantity: 0.5,
    canonicalUnit: "โล",
  };
}

/** Unknown names no longer review; a second subunit item stands in for "another review". */
function vocabulary(itemNumber: number, productName: string) {
  return subunit(itemNumber, productName);
}

function resultOf(reviews: unknown[]): ProduceValidationResult {
  return {
    status: "review_required",
    digest: "d".repeat(64),
    reviews,
    blocking: [],
    advisories: [],
  } as unknown as ProduceValidationResult;
}

const itemDigestOf = (review: unknown) =>
  computeValidationDigest(PARSED, [], [review] as never, {
    sessionKey: REF.sessionKey,
    sessionGeneration: REF.sessionGeneration,
    accountabilityRoundId: REF.accountabilityRoundId,
  });

describe("a fully rendered message authorizes the whole review", () => {
  it("includes the whole digest when every exception was shown", () => {
    const result = resultOf([vocabulary(1, "ผลไม้ทดสอบเอ")]);
    const presentation = buildPlainTextReviewPresentation(result, "จบรายการ");

    expect(presentation.complete).toBe(true);
    expect(presentation.renderedReviews).toHaveLength(1);
    // The message really carries the exception detail, not a teaser.
    expect(presentation.text).toContain("ผลไม้ทดสอบเอ");

    expect(reviewPresentationDigests(REF, result, presentation, PARSED))
      .toContain(result.digest);
  });
});

describe("#109 — each rendered subunit item is authorized on its own", () => {
  it("adds one item digest per rendered subunit review", () => {
    const one = subunit(3, "ทุเรียนทดสอบ");
    const two = subunit(7, "มะม่วงทดสอบ");
    const result = resultOf([one, two]);
    const presentation = buildPlainTextReviewPresentation(result, "จบรายการ");

    expect(presentation.complete).toBe(true);
    const digests = reviewPresentationDigests(REF, result, presentation, PARSED);

    // Whole review + one digest per item, all distinct.
    expect(digests).toContain(result.digest);
    expect(digests).toContain(itemDigestOf(one));
    expect(digests).toContain(itemDigestOf(two));
    expect(new Set(digests).size).toBe(3);
  });

  it("gives each item a DIFFERENT digest, so one confirmation cannot cover another", () => {
    expect(itemDigestOf(subunit(3, "ทุเรียนทดสอบ")))
      .not.toBe(itemDigestOf(subunit(7, "มะม่วงทดสอบ")));
  });

  it("binds the item digest to the generation", () => {
    const review = subunit(3, "ทุเรียนทดสอบ");
    const other = computeValidationDigest(PARSED, [], [review] as never, {
      sessionKey: REF.sessionKey,
      sessionGeneration: "99999999-9999-4999-8999-999999999999",
      accountabilityRoundId: REF.accountabilityRoundId,
    });
    expect(itemDigestOf(review)).not.toBe(other);
  });

  it("changes the item digest when the item itself changes", () => {
    const before = itemDigestOf(subunit(3, "ทุเรียนทดสอบ"));
    const after = itemDigestOf({ ...subunit(3, "ทุเรียนทดสอบ"), enteredQuantity: 9 });
    expect(before).not.toBe(after);
  });

  it("emits no item digests when the parsed session is unavailable", () => {
    // Without `parsed` there is no way to compute an item digest, so the plan
    // must not guess one.
    const result = resultOf([subunit(3, "ทุเรียนทดสอบ")]);
    const presentation = buildPlainTextReviewPresentation(result, "จบรายการ");
    expect(reviewPresentationDigests(REF, result, presentation)).toEqual([result.digest]);
  });
});

describe("UNRENDERED IS NOT DELIVERED", () => {
  // A tight budget forces the renderer to drop exception blocks.
  const manyReviews = Array.from({ length: 8 }, (_, i) => subunit(i + 1, `สินค้าทดสอบ${i + 1}`));

  it("drops the whole digest when the message could not show every exception", () => {
    const result = resultOf(manyReviews);
    const full = buildPlainTextReviewPresentation(result, "จบรายการ");
    expect(full.complete).toBe(true);

    // Squeeze the budget until the renderer has to hide some.
    const truncated = buildPlainTextReviewPresentation(result, "จบรายการ", 700);
    expect(truncated.complete).toBe(false);
    expect(truncated.renderedReviews.length).toBeLessThan(manyReviews.length);

    const digests = reviewPresentationDigests(REF, result, truncated, PARSED);
    // The whole-review digest authorizes ALL of them — it must not ship.
    expect(digests).not.toContain(result.digest);
  });

  it("authorizes exactly the items whose detail was rendered, and no others", () => {
    const result = resultOf(manyReviews);
    const truncated = buildPlainTextReviewPresentation(result, "จบรายการ", 700);
    const digests = reviewPresentationDigests(REF, result, truncated, PARSED);

    for (const review of truncated.renderedReviews) {
      expect(digests).toContain(itemDigestOf(review));
    }
    const hidden = manyReviews.slice(truncated.renderedReviews.length);
    expect(hidden.length).toBeGreaterThan(0);
    for (const review of hidden) {
      expect(digests).not.toContain(itemDigestOf(review));
    }
  });

  it("a rendered item's detail really is in the text, and a hidden one's is not", () => {
    const result = resultOf(manyReviews);
    const truncated = buildPlainTextReviewPresentation(result, "จบรายการ", 700);
    const shown = truncated.renderedReviews[0] as ReturnType<typeof subunit>;
    const hidden = manyReviews[manyReviews.length - 1];

    expect(truncated.text).toContain(shown.productName);
    expect(truncated.text).not.toContain(hidden.productName);
  });
});

describe("no arbitrary cap — as many reviews as actually fit are shown", () => {
  it("renders ELEVEN non-subunit reviews in one message", () => {
    // The old MAX_LISTED_EXCEPTIONS = 10 hid the eleventh forever: every close
    // re-rendered the same first ten, so the whole digest — which needs every
    // exception shown — could never be delivered.
    const reviews = Array.from({ length: 11 }, (_, i) => vocabulary(i + 1, `สินค้าทดสอบ${i + 1}`));
    const result = resultOf(reviews);
    const { pages, complete } = buildPlainTextReviewPresentationPages(result, "จบรายการ");

    expect(pages).toHaveLength(1);
    expect(complete).toBe(true);
    expect(pages[0].renderedReviews).toHaveLength(11);
    expect(pages[0].text).toContain("สินค้าทดสอบ11");

    expect(deliveredPresentationDigests(REF, result, pages, complete, PARSED))
      .toContain(result.digest);
  });

  it("renders eleven SUBUNIT items, so the eleventh is confirmable too", () => {
    const reviews = Array.from({ length: 11 }, (_, i) => subunit(i + 1, `สินค้าทดสอบ${i + 1}`));
    const result = resultOf(reviews);
    const { pages, complete } = buildPlainTextReviewPresentationPages(result, "จบรายการ");

    expect(complete).toBe(true);
    const digests = deliveredPresentationDigests(REF, result, pages, complete, PARSED);
    expect(digests).toContain(itemDigestOf(reviews[10]));
    // whole + 11 items
    expect(digests).toHaveLength(12);
  });
});

describe("a set too large for one message paginates instead of stranding", () => {
  const many = Array.from({ length: 40 }, (_, i) => subunit(i + 1, `สินค้าทดสอบ${i + 1}`));

  it("splits across pages and still covers every review", () => {
    const result = resultOf(many);
    // A budget that forces several pages.
    const { pages, complete } = buildPlainTextReviewPresentationPages(result, "จบรายการ", 1200, 5);

    expect(pages.length).toBeGreaterThan(1);
    expect(complete).toBe(true);

    const shown = pages.flatMap((page) => page.renderedReviews);
    expect(shown).toHaveLength(many.length);
    // Pages are contiguous and in order — no review is skipped or repeated.
    expect(shown.map((r) => r.itemNumber)).toEqual(many.map((r) => r.itemNumber));
  });

  it("delivers the whole digest only once every page is accounted for", () => {
    const result = resultOf(many);
    const { pages, complete } = buildPlainTextReviewPresentationPages(result, "จบรายการ", 1200, 5);

    // Only the first page delivered: its items are authorized, the whole set is not.
    const partial = deliveredPresentationDigests(REF, result, [pages[0]], false, PARSED);
    expect(partial).not.toContain(result.digest);
    for (const review of pages[0].renderedReviews) {
      expect(partial).toContain(itemDigestOf(review));
    }
    // A review on a later page was NOT delivered.
    const later = pages[pages.length - 1].renderedReviews[0];
    expect(partial).not.toContain(itemDigestOf(later));

    // All pages delivered: the whole digest joins them.
    expect(deliveredPresentationDigests(REF, result, pages, complete, PARSED))
      .toContain(result.digest);
  });

  it("is deterministic — a retry produces the identical pagination", () => {
    const result = resultOf(many);
    const first = buildPlainTextReviewPresentationPages(result, "จบรายการ", 1200, 5);
    const second = buildPlainTextReviewPresentationPages(result, "จบรายการ", 1200, 5);
    expect(second.pages.map((p) => p.text)).toEqual(first.pages.map((p) => p.text));
  });
});

describe("a set beyond even the page budget keeps a finite correction path", () => {
  const huge = Array.from({ length: 60 }, (_, i) => vocabulary(i + 1, `สินค้าทดสอบ${i + 1}`));

  it("reports incomplete and never delivers the whole digest", () => {
    const result = resultOf(huge);
    const { pages, complete } = buildPlainTextReviewPresentationPages(result, "จบรายการ", 700, 2);

    expect(complete).toBe(false);
    expect(pages).toHaveLength(2);
    expect(deliveredPresentationDigests(REF, result, pages, complete, PARSED))
      .not.toContain(result.digest);
  });

  it("tells the operator to correct what they can see, which shrinks the set", () => {
    const result = resultOf(huge);
    const { pages } = buildPlainTextReviewPresentationPages(result, "จบรายการ", 700, 2);
    // The forward path for an over-large set is correction, not confirmation —
    // and correcting removes exceptions until the remainder fits.
    expect(pages[pages.length - 1].text).toContain("กรุณาแก้รายการข้างต้นก่อน");
  });

  it("progresses once the operator corrects enough of the set", () => {
    // Same session after fixing 56 of them: now everything fits and the whole
    // digest becomes deliverable. That is the finite path.
    const shrunk = resultOf(huge.slice(0, 4));
    const { pages, complete } = buildPlainTextReviewPresentationPages(shrunk, "จบรายการ", 1200, 2);
    expect(complete).toBe(true);
    expect(deliveredPresentationDigests(REF, shrunk, pages, complete, PARSED))
      .toContain(shrunk.digest);
  });
});
