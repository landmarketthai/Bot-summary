-- Roll back the review RPCs only. Financial records are KEPT:
-- slip_check_approvals rows (reviewer, reason, amount) and
-- manual_slip_entries.reference_id stay in place, so nothing an operator
-- decided is lost. Revert the application code first; without it nothing
-- reads these, so money returns to the pre-approval rules (pending AI slips
-- excluded, manual entries counted as before).
--
-- Dropping the table/column is a separate, explicitly approved step after the
-- rows have been exported; it is intentionally not part of this file.

BEGIN;

DROP FUNCTION IF EXISTS public.review_slip_check(uuid, text, numeric, text, text);
DROP FUNCTION IF EXISTS public.revoke_slip_check_review(uuid, text, text);
DROP FUNCTION IF EXISTS public.assert_slip_check_round_open(uuid);

COMMIT;
