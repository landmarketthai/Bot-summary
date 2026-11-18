# Executive Morning Brief — Activation Plan

> Historical plan. For the V3 delivery ledger, exact retry window, staged SQL,
> rollback and backfill review, use [Morning Brief V3](morning-brief-v3/README.md).

Status as of this writing: **the Morning Brief is built but fully inert.**
Nothing in this document has been done. It exists so a human can execute the
cutover deliberately, one step at a time, instead of it happening by
accident.

## What exists today

- `src/lib/summary/morning-brief.ts` — pure bounded summaries derived from
  Purchase Planning and Sales contracts.
- `src/lib/summary/morning-brief-service.ts` — `loadMorningBriefReport`,
  which calls the existing Purchase Planning, Sales, and authoritative House
  Stock readers and does not recompute any business rule.
- `src/lib/summary/morning-brief-message.ts` — `buildMorningBriefMessages`,
  the short LINE rendering.
- `src/app/api/cron/daily-morning-brief/route.ts` — the cron entry point.
  Gated exactly like every existing report route: `CRON_SECRET` auth,
  `MORNING_BRIEF_LINE_TARGETS` env var (unset ⇒ no-op), `?debug=1` preview.
- `.github/workflows/daily-morning-brief.yml` — `workflow_dispatch` only, no
  schedule. Exists for manual/debug calls during UAT.

None of this changes what currently gets sent to anyone. `vercel.json` was
not touched (`crons: []`, unchanged). No Supabase Cron entry was created or
modified. No existing route, job, or workflow was edited, disabled, or
rescheduled.

## What currently sends morning messages

All of the following are report **cron routes** in this codebase. Each one's
own file header documents the same thing: automatic scheduling for it is
owned by **Supabase Cron**, configured outside this repository (dashboard /
SQL, not a checked-in migration), and delivery is separately gated by that
route's own `*_LINE_TARGETS` env var.

| Report | Route | Targets env var |
|---|---|---|
| Purchase Planning | `/api/cron/daily-purchase-planning` | `STOCK_SUMMARY_LINE_TARGETS` |
| Sales summary (P1) | `/api/cron/daily-sales-summary` | `SALES_SUMMARY_LINE_TARGETS` |
| Stock / good-return (P0) | `/api/cron/daily-stock-summary` | `STOCK_SUMMARY_LINE_TARGETS` |
| Raw per-source daily summary | `/api/cron/daily-summary` | (source-derived, no single env gate — verify live status before touching) |

Whether each of these is *actually* wired to a live Supabase Cron schedule
today (vs. shipped-but-not-scheduled) is **not visible from this repository**
and must be confirmed directly in the Supabase project before step 4 below.
Do not assume "the route exists" means "it fires on a schedule."

The on-demand LINE commands (`สรุปสินค้าขายดี`, `สรุปยอดขาย`, `สรุปคงเหลือ`,
`ตรวจความพร้อม`, the settlement close command, etc.) are **not** cron jobs —
they run only when someone sends the command. Nothing in this plan touches
them; they stay callable exactly as they are today, before and after cutover.

## Cutover steps, in order

Each step is independently reversible. Do not skip ahead — in particular,
do not do step 4 before steps 1–3 have been live and observed for at least a
few real business days.

1. **Configure the target list.**
   Set `MORNING_BRIEF_LINE_TARGETS` (Vercel env, Production) to the LINE
   ID(s) that should receive the brief — almost certainly the owner
   (P'Krai / Je), not the per-market operator groups that receive the
   detailed reports today.

2. **Preview before sending anything.**
   Manually trigger `.github/workflows/daily-morning-brief.yml`
   (`workflow_dispatch`, `debug: true`, optionally a specific `date`) and read
   the returned `messages` array. Confirm:
   - the purchase decisions match what `สรุปสินค้าขายดี` reports for the same
     date;
   - the verified sales amount and unresolved count match `สรุปยอดขาย`;
   - the compact House Stock count and value match `สรุปคงเหลือ`.

3. **Add the Supabase Cron entry.**
   Once previews look right for a few different days (a normal day, a
   mismatch day, a day with unresolved purchase items), add a Supabase Cron
   schedule calling `GET /api/cron/daily-morning-brief` with the
   `Authorization: Bearer <CRON_SECRET>` header — same mechanism as the
   existing report crons above. Pick a time after the underlying data is
   expected to be settled for the previous business date (the existing
   reports use 08:00–08:15 Asia/Bangkok; a few minutes after the latest of
   those is a safe starting point). This step **is** a live production cron
   change — get sign-off before doing it, and do it as its own deliberate
   action, separate from this task.

4. **Only after step 3 has been live and trusted, retire the old spam.**
   "Retire" means turning off the *delivery* of the reports the Morning
   Brief is meant to replace for the same recipient, not deleting any
   report:
   - Unset (or narrow) that recipient's entries in
     `STOCK_SUMMARY_LINE_TARGETS` / `SALES_SUMMARY_LINE_TARGETS`, and/or
     disable the corresponding Supabase Cron schedule(s) for them — do this
     one report at a time, watching for a day, not all at once.
   - Do **not** touch the per-market operator groups' own detailed reports
     if they still rely on them for operational (not executive) purposes —
     this plan only removes the *owner's* duplicate copies once the Brief is
     proven to cover the same ground.
   - Never remove the underlying report code, routes, or on-demand commands.
     "Detailed reports stay available on demand" is a hard requirement, not
     a temporary state during migration.

## Rollback

At any point before step 4, rollback is simply: unset
`MORNING_BRIEF_LINE_TARGETS` (or remove the Supabase Cron entry added in
step 3). Nothing else in the system depends on the Morning Brief existing.

After step 4, rollback additionally means restoring whichever
`*_LINE_TARGETS` entries / Supabase Cron schedules were narrowed or disabled,
in the same one-at-a-time, deliberate manner they were removed.
