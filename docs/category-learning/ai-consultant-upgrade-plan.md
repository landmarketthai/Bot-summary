# AI Consultant upgrade plan (follow-up, separate PR)

Not part of the category-dictionary PR. Builds on PR #174
(`feat/ai-consultant-phase1-3`, open, unmerged, 23 files / ~9.6k lines) and the
current read-only analyst on `main` (`src/lib/ai/openai-analyst.ts`,
`readonly-analyst.ts`, 9 read-only tools, model from `BOT_SUMMARY_ANALYST_MODEL`).

## Audit notes

- PR #174 already has the right shape: identity from the signed LINE event,
  per-chat allowlists, deterministic facts + LLM phrasing, an answer guard, and
  a deterministic fallback when the model fails. Reuse it; do not fork it.
- PR #174 and this PR both edit `src/lib/line/webhook-service.ts` (postback
  branch here, text routing there). Expect a small, mechanical rebase.
- Model choice is already an env var; keep that and add per-tool overrides only
  if a tool needs a different model.

## Additions (all read-only tools for the model)

| Tool | Deterministic source | LLM role |
|---|---|---|
| `explain_product_category(name)` | `approvedCategoryFor` / dictionary / stock map + the matching rule or decision row | phrase *why* a name is in a category |
| `list_category_candidates(status)` | `produce_category_candidates` (evidence, suggestion, confidence) | summarise for an admin |
| `suggest_category(name)` | `suggestCategory` result first | only when the deterministic suggestion is `low`, offer a reasoned guess labelled "ข้อเสนอจาก AI" — written to a new `ai_suggestion` column, never to rules |
| `diagnose_data_quality_issue(id)` | `data_quality_issues` + labels/severity | explain cause and next step |
| analytics tools | existing `readonly-tools` | unchanged |

## Hard limits

- The model has no write tool. Rules change only through the authenticated
  LINE postback in this PR. An AI suggestion is evidence on a card, never a decision.
- No tool returns or edits money, quantities, product codes or identity.
- Deterministic rules first; the LLM runs only where text must be interpreted.
- Timeout + deterministic fallback on every call; nothing on the Produce
  ingestion or daily-close path awaits the model.
- Admin-only tools (`list_category_candidates`) require the same
  `CATEGORY_REVIEW_ADMIN_LINE_USER_IDS` check as postbacks.

## Order

1. Merge this PR; let the review loop run in the test group.
2. Rebase PR #174 on it; land Phase 1–3 as reviewed.
3. Add `explain_product_category` + `diagnose_data_quality_issue` (read-only).
4. Add `ai_suggestion` evidence for low-confidence candidates, behind a flag.
