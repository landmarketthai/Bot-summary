# @Botsummary Thai evaluation — measured results

Run at 2026-10-31T07:01:01.158Z · 24 questions · asked business date 2026-10-31 · fixture data only (no Production data).

## A. Deterministic backend rules

- Business date: 24/24 (100%)
- Follow-up detection: 24/24 (100%)
- Staff authorization decision (asker = ดำ, market ราชพฤกษ์): 24/24 (100%)

| id | date | follow-up | auth | observed |
|---|---|---|---|---|
| mvp-1 | ✓ | ✓ | ✓ | 2026-10-31 / followUp=false / tool_not_permitted |
| mvp-2 | ✓ | ✓ | ✓ | 2026-10-31 / followUp=false / allowed |
| mvp-3 | ✓ | ✓ | ✓ | 2026-10-31 / followUp=false / other_staff |
| mvp-4 | ✓ | ✓ | ✓ | 2026-10-31 / followUp=false / tool_not_permitted |
| mvp-5 | ✓ | ✓ | ✓ | 2026-10-31 / followUp=false / other_staff |
| mvp-6 | ✓ | ✓ | ✓ | 2026-10-31 / followUp=true / other_staff |
| use-1 | ✓ | ✓ | ✓ | 2026-10-31 / followUp=false / tool_not_permitted |
| use-2 | ✓ | ✓ | ✓ | 2026-10-31 / followUp=false / tool_not_permitted |
| use-3 | ✓ | ✓ | ✓ | 2026-10-31 / followUp=false / tool_not_permitted |
| use-4 | ✓ | ✓ | ✓ | 2026-10-31 / followUp=false / allowed |
| use-5 | ✓ | ✓ | ✓ | 2026-10-31 / followUp=false / tool_not_permitted |
| use-6 | ✓ | ✓ | ✓ | 2026-10-31 / followUp=false / tool_not_permitted |
| use-7 | ✓ | ✓ | ✓ | 2026-10-31 / followUp=false / tool_not_permitted |
| uat-10 | ✓ | ✓ | ✓ | 2026-10-31 / followUp=false / other_staff |
| uat-16 | ✓ | ✓ | ✓ | 2026-10-31 / followUp=true / allowed |
| uat-17 | ✓ | ✓ | ✓ | 2026-10-31 / followUp=false / no_tool |
| uat-18 | ✓ | ✓ | ✓ | 2026-10-31 / followUp=false / tool_not_permitted |
| add-1 | ✓ | ✓ | ✓ | 2026-10-30 / followUp=false / allowed |
| add-2 | ✓ | ✓ | ✓ | 2026-10-30 / followUp=true / other_staff |
| add-3 | ✓ | ✓ | ✓ | 2026-10-29 / followUp=false / tool_not_permitted |
| add-4 | ✓ | ✓ | ✓ | 2026-10-05 / followUp=false / tool_not_permitted |
| add-5 | ✓ | ✓ | ✓ | 2026-10-31 / followUp=false / tool_not_permitted |
| add-6 | ✓ | ✓ | ✓ | 2026-10-31 / followUp=false / allowed |
| add-7 | ✓ | ✓ | ✓ | 2026-10-31 / followUp=false / allowed |

## B. Pipeline harness with the scripted stand-in model (not GPT-6 Luna)

- Expected tool executed: 18/24 (75%)
- Answers withheld by the grounding check: 0

| id | tools executed | expected? |
|---|---|---|
| mvp-1 | get_daily_summary | ✓ |
| mvp-2 | get_staff_produce | ✓ |
| mvp-3 | get_slip_status | ✓ |
| mvp-4 | compare_daily_sales | ✓ |
| mvp-5 | get_pending_items | ✓ |
| mvp-6 | get_pending_items | ✓ |
| use-1 | get_daily_summary | ✓ |
| use-2 | - | ✗ |
| use-3 | - | ✗ |
| use-4 | get_pending_items | ✓ |
| use-5 | get_settlement_overview | ✗ |
| use-6 | get_settlement_overview | ✓ |
| use-7 | compare_daily_sales | ✓ |
| uat-10 | - | ✗ |
| uat-16 | get_pending_items | ✓ |
| uat-17 | - | ✓ |
| uat-18 | get_settlement_overview | ✗ |
| add-1 | get_staff_produce | ✓ |
| add-2 | get_staff_produce | ✓ |
| add-3 | get_daily_summary | ✓ |
| add-4 | get_daily_summary | ✓ |
| add-5 | get_white_sheet_status | ✓ |
| add-6 | - | ✗ |
| add-7 | get_slip_status | ✓ |

## C. Live model

Not run (pass --live with OPENAI_API_KEY to measure GPT-6 Luna on the fixture data).
