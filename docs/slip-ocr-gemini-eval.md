# Slip OCR model evaluation: existing OpenAI model vs Gemini Flash

Status: tooling only. **No measurement has been run yet**; Production OCR is unchanged.

## What runs in Production today (code, origin/main 8a4cf4b)

- `CheckService` → `CascadingSlipExtractor` → `OpenAiSlipExtractor` (Responses API, `detail: "high"`, strict JSON schema).
- Model from env: `SLIP_EXTRACTION_MODEL_PRIMARY` ?? `SLIP_EXTRACTION_MODEL` ?? `gpt-6-luna`; optional `SLIP_EXTRACTION_MODEL_FALLBACK`
  is called when the primary read is not `EXTRACTED` with confidence ≥ 0.85, or on a retryable provider error.
  The values actually set in Vercel were not readable from this session.
- Raw model JSON → `parseSlipExtraction` (canonicalization) → `determineSlipCheckStatus` → batch `computeValidationFlags`
  (date, outlier, in-batch duplicate) + global reference dedupe.
- **No QR code is decoded or verified with a bank anywhere.** `BANK_SLIP_QR` is only the model's visual label.
  Every confirmed sale today is AI image extraction. QR-backed verification would be a separate, new control.

## Tooling (this PR)

- `src/lib/slips/gemini-extractor.ts`: `GeminiSlipExtractor`, same prompt, same schema, same `parseSlipExtraction`.
  Not imported by any Production code path.
- `src/lib/slips/ocr-eval.ts`: scoring with Production's status rule and batch guard, so "accepted" = "would be a
  confirmed sale".
- `scripts/slip-ocr-eval.ts`: `export` / `run` / `score`.

Safety gates (enforced in code):

| Step | Touches | Gate |
|---|---|---|
| `export` | READ-ONLY Supabase (`slip_batches`, `slip_evidences`, `slip_checks`, Storage download) | `SLIP_EVAL_PRODUCTION_READ_APPROVED=1` |
| `run` | sends local images to each named provider | provider listed in `SLIP_EVAL_PROVIDER_UPLOAD_APPROVED` |
| any | output folder | refused inside the repository (private images) |

Nothing writes to Supabase, `slip_checks`, settlement or LINE. Sender/receiver names and account tails are not exported.

## Procedure

1. Written approval for (a) reading Production slip images and (b) sending them to Google (Gemini API paid tier;
   Google's terms: paid-tier data is not used to improve products). Without (b) only the stored-result baseline can be scored.
2. Pick 100–200 already-finalized images across batches, covering: Thai Help Thai / G-Wallet, bank slip with and
   without QR, tilted, glare, missing date, out-of-period date, duplicate re-send, non-slip images.
3. `export` them to a folder outside the repo (also exports the result Production stored, as model `production:stored`).
4. A reviewer fills `label` for each image **from the image itself** (never from either model's output) and `tags`:
   `{ slipType, amount, dateVisible, referenceId, shouldAccept }`.
5. `run <dir> openai:<current model> gemini:gemini-3.8-flash [gemini:gemini-3.1-flash-lite] --runs 3`
   (extraction is nondeterministic; 3 runs per image is the minimum).
6. `report.md` gives per model, overall, per tag and per slip type: correct accept, **false accept**, review rate,
   unnecessary review, missing amount/date/reference, run-to-run consistency, p50/p95 latency, measured cost per image.

## Switch criteria (all must hold, on ≥ 150 labelled images × 3 runs)

1. Gemini false-accept count ≤ existing model, and zero false accepts with a wrong amount.
2. Human-review rate at least 5 points lower, or equal with lower cost.
3. Consistency ≥ existing model; no slip-type group (Thai Help Thai especially) worse on false accept.
4. Speed alone never qualifies.

## Rollout (only after the criteria hold)

1. Production shadow (separate PR): run Gemini after the primary read, store its result in a new append-only
   table, never in `slip_checks`; compare daily. Needs a migration and the provider approval above.
2. Gemini as the cascade fallback only, behind an env flag; primary unchanged.
3. Gemini as primary behind the same flag, one market first, with daily false-accept review.
Rollback at every stage: unset the env flag (no data migration; stored checks keep their provider).
