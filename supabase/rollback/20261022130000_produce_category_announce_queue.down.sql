-- Roll back only the review-announcement queue column. Candidates, rules and
-- decisions stay; a notifier from this release would fail its queue read, so
-- keep CATEGORY_REVIEW_NOTIFY_ENABLED off (or roll the app back first).

BEGIN;

DROP INDEX IF EXISTS public.produce_category_candidates_announce_queue_idx;
ALTER TABLE public.produce_category_candidates DROP COLUMN IF EXISTS needs_announcement;

COMMIT;
