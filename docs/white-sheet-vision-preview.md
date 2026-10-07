# Read-only white-sheet vision MVP

Implementation and verification report, 7 October 2026.

## Review location and merge status

Worktree: `C:\GitHub\Bot-summary\tmp\white-sheet-vision-preview`.
Branch: `codex/white-sheet-vision-preview`, based on `feat/ai-analyst-local-poc`
at `9b6ae3c`. Changes are local and uncommitted. The original checkout's
unrelated working changes were preserved. No Production deployment, migration,
fake Production LINE event, or Production business-data write was performed.

The feature and its safety regression tests pass, but this is **not a clean
release recommendation**: eight broader regression failures also reproduce on
the untouched analyst baseline. Resolve or explicitly review those failures
before merging for release. Review this patch against the analyst branch; the
original checkout was on a different branch without that analyst implementation.

## Files changed

| File | Purpose |
| --- | --- |
| `.env.example` | Documents the separate fail-closed White Sheet Vision kill switch. |
| `src/lib/white-sheet-reader/schema.ts` | Strict extraction schema, local validation, uncertainty masking. |
| `src/lib/white-sheet-reader/reader.ts` | Dedicated vision prompt, bounded image extraction, deterministic Thai rendering and safe replies. |
| `src/lib/white-sheet-reader/mode.ts` | Reconstruct temporary mode from existing ordered webhook context using reads only. |
| `src/lib/white-sheet-reader/reader.test.ts` | Extraction, validation, rendering and mutation-boundary tests. |
| `src/lib/line/webhook-white-sheet-reader.test.ts` | Command, durable ordering, isolation, retry and routing safety tests. |
| `src/lib/line/webhook-service.ts` | Intercept commands before analyst Q&A and preview images before writing image handlers. |
| `src/lib/ai/openai-analyst.ts` | Optional strict `text.format` support in the existing Responses wrapper. |
| `src/lib/line/content.ts` | Optional bounded streaming download and timeout; existing callers retain their defaults. |
| `src/lib/line/content.test.ts` | Declared/streamed oversize and bounded download checks. |
| `src/lib/line/webhook-image.test.ts` | Repair a stale missing-queue RPC test double. |
| `src/lib/line/webhook-image-batch.test.ts` | Same test-double repair. |
| `src/lib/line/webhook-settlement-sheet-image.test.ts` | Same test-double repair. |
| `scripts/white-sheet-preview-smoke.ts` | Local real-image OpenAI smoke; no database or LINE event submission. |
| `docs/white-sheet-vision-preview.md` | This report. |

No dependency, lockfile, migration, official calculation, settlement or
white-sheet finalization changes.

## Exact user flow

The existing analyst must be enabled with `BOT_SUMMARY_ANALYST_ENABLED=true`,
the preview kill switch must be enabled with `BOT_SUMMARY_WHITE_SHEET_READER_ENABLED=true`,
and the group must be in `BOT_SUMMARY_ANALYST_LINE_SOURCE_IDS`. A LINE group
user ID is required. Existing bot-mention metadata is supported. Turning off the
reader kill switch restores normal image routing without disabling analyst Q&A.

1. The user sends `@Botsummary อ่านใบขาว`.
2. The bot replies:

   ```text
   เปิดโหมดอ่านใบขาวแล้วครับ
   ส่งรูปใบขาวมา 1 รูปได้เลย ภายใน 10 นาที
   ระบบจะอ่านให้ตรวจสอบก่อน และยังไม่บันทึกลงระบบ
   ถ้าจะส่งสลิปหรือรูปอื่น พิมพ์ @Botsummary ยกเลิกอ่านใบขาว ก่อนครับ
   ```

3. That user sends one LINE-hosted image in the same group within ten minutes.
   The bot downloads it, validates its size/type, extracts structured data,
   validates and masks uncertainty, then replies with a Thai preview.
4. The first image consumes the command, including an unsuccessful reading or
   unsupported image. Additional images are intercepted with a one-image reminder
   until the original ten-minute window expires, the user rearms with a new read
   command, or cancels. This prevents a retry from becoming writing OCR/slip input.
5. `@Botsummary ยกเลิกอ่านใบขาว` returns that user's images to normal handling.
   A new read command rearms one image. Existing analyst questions still use Q&A.

Outside preview ownership, normal image/slip routing remains in place. Explicit
preview takes priority over an existing slip batch without modifying that batch.
The preview always ends with:

```text
ข้อมูลนี้ยังไม่ได้บันทึกลงระบบ เป็นเพียงผลอ่านจากภาพครับ
```

Unknown documents receive exactly this first sentence, followed by that disclaimer:

```text
ยังยืนยันไม่ได้ว่ารูปนี้เป็นใบขาวครับ ลองถ่ายให้เห็นแบบฟอร์มทั้งแผ่นแล้วส่งใหม่ได้เลย
```

## State and Vercel safety

There is no new session table and no process-memory session. Start/cancel commands
join the existing source-serialized durable webhook queue. Mode is reconstructed
with SELECTs over `line_webhook_event_queue` and `raw_messages`, scoped to bot
destination, group and user, ordered by `receive_order`, and bounded by the current
image's queue position. Future events cannot retroactively arm an older image.

The mode lasts ten minutes from the command's event timestamp. A prior image in
that window establishes consumed mode. LINE duplicate detection and existing
receive/claim/complete queue bookkeeping remain responsible for redelivery.
Separate webhook instances use the same durable history, so Vercel restarts do
not lose mode. Missing ordering, lookup errors, unprocessed active command stamps,
older delayed images or context overflow fail closed before writing image handlers.

The only persisted activity is the existing raw webhook audit, processed markers
and queue bookkeeping. No extracted values, model response or rendered preview
are added to those rows, Storage, business tables or settlement data. The reader
and renderer have no database client; the mode module performs reads only.

## JSON schema and validation

The canonical executable JSON schema is exported as
`WHITE_SHEET_PREVIEW_JSON_SCHEMA` in `src/lib/white-sheet-reader/schema.ts` and
is sent unchanged as strict Responses `text.format`. Its complete JSON can be
printed locally without credentials or network access:

```powershell
bun -e 'import { WHITE_SHEET_PREVIEW_JSON_SCHEMA as schema } from "./src/lib/white-sheet-reader/schema"; console.log(JSON.stringify(schema, null, 2));'
```

All of these properties are required; additional properties are forbidden both
at the root and in expense objects:

```typescript
{
  documentType: "white_sheet" | "unknown",
  market: string | null,
  dateRaw: string | null,
  dateIso: string | null,
  sellerNames: string[],
  salesAmountBaht: number | null,
  transferAmountBaht: number | null,
  cashSentAmountBaht: number | null,
  laborAmountBaht: number | null,
  remainingCashAmountBaht: number | null,
  expenses: { labelRaw: string | null, amountBaht: number | null, confidence: number }[],
  lowConfidenceFields: string[],
  overallConfidence: number,
  notes: string[]
}
```

Numbers must be finite; confidence is 0–1; money is nonnegative and bounded by
`Number.MAX_SAFE_INTEGER / 100`. No coercions are accepted. ISO dates must be real
calendar dates in `YYYY-MM-DD`, within 1900–2200, with a raw date present. Names
are trimmed and deduplicated. Strings reject blanks, controls and bidi overrides.
Bounds: eight sellers, twenty expenses, eight notes, 80-character names/raw labels,
160-character notes. Uncertainty paths are an enum of the top-level fields and
zero-based expense cells; nonexistent expense indexes are rejected.

Flagged guesses are masked to null/empty names before display. Low-confidence
expense rows without a specific uncertain cell mask both cells. A clearly read
amount can survive an uncertain label. Uncertain cells display `อ่านไม่ชัด`;
confirmed absent fields display `ไม่พบ`. Either date uncertainty flag makes the
displayed date uncertain. Unknown/under-0.8 document identity is rejected; an
empty reading receives a safe retry. The renderer computes no business totals.

## Prompt and provider boundary

The complete prompt is `WHITE_SHEET_VISION_PROMPT` in `reader.ts`. It requires
the printed Thai form, including the signature-area labels; warehouse/CCTV
photos, bank slips, receipts and arbitrary white-background images are unknown.
It handles crossed-out/overwritten text, preserves visible raw labels, separates
each expense row and every money field, and forbids invented values, canonical
name mapping, missing-cash inference and business formulas. Text in the image is
data, never instructions. Ambiguous readings become null plus a Thai note.
Month abbreviations are copied without expansion; Buddhist full years are
converted only when unambiguous, and a short year does not imply a century.

The existing Responses wrapper is reused with model `gpt-6-luna`, high-detail
image input, `store:false`, reasoning `none`, 2,400 output tokens, strict schema,
no tools, and a 20-second request timeout. Only the image, instructions and
schema reach the model; no database credentials or service-role keys do.
See the [official Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses).

Downloads have a ten-second timeout and a 10 MiB streamed-body limit. JPEG, PNG
and WebP MIME types must match their file signatures. External URLs and multi-image
sets are refused in this MVP. Download/provider/schema/refusal failures produce a
safe Thai retry and never fall through into writing OCR. Preview errors do not
log bytes, extracted values, provider responses or credentials. The final LINE
message comes from deterministic rendering, with ordinary Thai review labels,
existing LINE chunking and the disclaimer last.

## Verification

| Check | Result |
| --- | --- |
| Focused preview, webhook and content tests | **70 pass, 0 fail**, 3 files (including the separate reader kill-switch regression). |
| Analyst, slip, settlement OCR, image and preview safety regression | **532 pass, 0 fail**, 43 files. |
| Broader related non-Postgres regression | **1,822 pass, 8 fail**, 125 files. |
| Same failing files on untouched analyst baseline | **86 pass, same 8 fail**, 6 files. |
| TypeScript, incremental disabled | Pass. |
| ESLint on affected TypeScript files | 0 errors; one pre-existing unused `replyMessage` warning in `webhook-service.ts`. |
| Next.js 16.3.4 production build | Pass, all 43 pages generated. |
| `git diff --check` | Pass. |
| Real user-supplied positive form smoke | Pass for document classification and safe preview; uncertainty remains. |
| Real warehouse/CCTV negative smoke | Pass: `unknown` and exact rejection sentence. |

Focused check:

```powershell
bun test src/lib/white-sheet-reader/reader.test.ts src/lib/line/webhook-white-sheet-reader.test.ts src/lib/line/content.test.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

The safety and broader test selections and results are recorded in the ignored
local evidence logs `.tmp-preview-safety-regression-tests.log` and
`.tmp-preview-regression-tests.log`. Baseline comparison is in
`.tmp-preview-baseline-tests.log`. No PostgreSQL integration or migration tests
were run. The build used process-local loopback Supabase URL and placeholder
keys, without connecting to Production.

Baseline failures (not caused by this patch):

| File | Failing case(s) |
| --- | --- |
| `src/lib/line/finalizer-authoritative-document.test.ts` | Live master data adds a hard block: expects `failed_closed`, receives `finalized`. |
| `src/lib/line/produce-close-gap-reconcile-race.test.ts` | Snapshot re-read source ordering assertion. |
| `src/lib/line/reply.test.ts` | Original item numbers when category print order changes. |
| `src/lib/line/webhook-one-shot-bypass.test.ts` | Quantity invariant with price advisory: expects `failed_closed`, receives `finalized`. |
| `src/lib/line/webhook-review-presentation.test.ts` | Review-presentation source assertion. |
| `src/lib/white-sheet/withdrawal-central-price-seed.test.ts` | B/C read-only loads, E conflicting-price withdrawal, I admin-corrected price: three price expectation failures. |

These involve existing business rules and were left outside the requested
read-only preview scope. The untouched analyst checkout was clean after the
baseline test run.

## Real image UAT and limitations

Positive input was only the user's supplied handwritten form:
`C:\Users\User\AppData\Local\Temp\codex-clipboard-0689a175-bed8-4a3a-b02e-cfeecd99a6a9.png`.
No unrelated workspace JPG was used as a positive sample. The final result was
`white_sheet`, with sales 7,170, transfer 865 and cash sent 1,640. Market, date and
sellers were uncertain, as were expense labels; three expense amounts were
400, 25 and 40, with the fourth uncertain. These were surfaced for manual review.
This confirms safe classification/rendering on one form, not full OCR accuracy.

The warehouse/CCTV image `C:\GitHub\Bot-summary\tmp\evidence_review\source0_0.jpg`
was used only as a negative test. The final result was `unknown`, all scalar
readings null and arrays empty, with the exact user-requested rejection sentence.
The local smoke calls used only the OpenAI key; no database client or LINE events.
Inputs and local extraction logs were not added to tracked files.

To smoke another real sample, set only `OPENAI_API_KEY` in the process and run:

```powershell
bun run scripts/white-sheet-preview-smoke.ts <real-image-path> white_sheet
bun run scripts/white-sheet-preview-smoke.ts <negative-image-path> unknown
```

Remaining limits: vision uncertainty needs human checking; negative money is
refused for review rather than interpreted; one image per command; ten-minute
absolute expiry; 10 MiB and twenty-expense limits. Context scanning caps at 200
queued group events per ten minutes and fails closed above that ceiling. A lookup
failure in an enabled/allowed group can therefore suppress a normal image with
the safe retry instead of risking a business write. High-traffic groups need a
review of that ceiling before rollout. The existing queue infrastructure and
analyst configuration must already be present. No new runtime infrastructure or
migration was introduced.

**Production deployment: not performed.** Deployment remains pending code review
and resolution/review of the baseline failures.
