/**
 * LOCAL SMOKE TEST for the evaluation-only GeminiSlipExtractor (PR #193).
 * Sends ONLY synthetic slips rendered here (fake bank, fake names, fake
 * reference) — never a Production image. Hard cap: 5 API requests, no retries.
 * The API key is read from the environment and never printed.
 *
 *   bun --env-file=<.env.local> scripts/slip-gemini-smoke.ts [--model gemini-3.5-flash-lite]
 *   SLIP_SMOKE_OFFLINE=1 bun scripts/slip-gemini-smoke.ts   # fake provider, 0 requests
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { determineSlipCheckStatus, type SlipExtraction } from "../src/lib/slips/extraction-schema";
import { GeminiSlipExtractor, readGeminiOutputText, readProviderUsage } from "../src/lib/slips/gemini-extractor";
import { computeValidationFlags, parseBatchDate, selectEffectiveAmount } from "../src/lib/slips/validation-guard";

const MAX_REQUESTS = 5;
const BATCH_DATE = "29/10/2569";
const argModel = process.argv.indexOf("--model");
const model = argModel >= 0 ? process.argv[argModel + 1] : "gemini-3.5-flash-lite";
const offline = process.env.SLIP_SMOKE_OFFLINE === "1";
const apiKey = offline ? "offline-fake-key" : process.env.GEMINI_API_KEY;
// Defensive: never let anything key-shaped reach the terminal.
const scrub = (s: string) => (apiKey ? s.split(apiKey).join("[key]") : s).replace(/AIza[0-9A-Za-z_-]{20,}/g, "[key]");

console.log(`GEMINI_API_KEY: ${apiKey ? "present" : "MISSING"} | model: ${model} | mode: ${offline ? "offline (fake provider)" : "live"}`);
if (!apiKey) process.exit(1);

// ── request-capped, usage-capturing fetch ────────────────────────────────────
let requests = 0;
type LastCall = {
  status: number; ms: number; usage: ReturnType<typeof readProviderUsage>; error: string | null;
  rawTime?: unknown; rawType?: unknown;
};
let last: LastCall | null = null;
// `last` is assigned inside the fetch callback, which control-flow analysis can't see.
const lastCall = () => last as LastCall | null;
const realFetch = offline ? (fakeGemini as typeof fetch) : fetch;
const cappedFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  if (++requests > MAX_REQUESTS) throw new Error(`request cap ${MAX_REQUESTS} reached`);
  const start = performance.now();
  const res = await realFetch(url, init);
  const ms = Math.round(performance.now() - start);
  const body = await res.clone().text();
  let usage = null;
  // Model output BEFORE parseSlipExtraction, so model vs parser is decidable.
  let raw: Record<string, unknown> = {};
  try {
    const payload = JSON.parse(body);
    usage = readProviderUsage("gemini", payload);
    raw = JSON.parse(readGeminiOutputText(payload) ?? "{}");
  } catch { /* non-JSON error body or plain-text reply */ }
  last = {
    status: res.status, ms, usage, error: res.ok ? null : scrub(body).slice(0, 300),
    rawTime: raw.transaction_time, rawType: raw.slip_type,
  };
  return res;
}) as typeof fetch;

type Result = { name: string; pass: boolean; detail: string };
const results: Result[] = [];
const report = (name: string, pass: boolean, detail: string) => {
  results.push({ name, pass, detail });
  const l = last as typeof last;
  const meta = l ? ` | HTTP ${l.status} | ${l.ms} ms | tokens in/out ${l.usage?.inputTokens ?? "?"}/${l.usage?.outputTokens ?? "?"}` : "";
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${meta}\n      ${detail}${l?.error ? `\n      API error: ${l.error}` : ""}`);
};

// --only 3  runs just that step (e.g. re-check one image with a single request).
const argOnly = process.argv.indexOf("--only");
const only = argOnly >= 0 ? process.argv[argOnly + 1] : null;
const runs = (step: string) => only === null || only === step;
let currentCase = "";

// ── 1. connection: one short text request ────────────────────────────────────
last = null;
if (runs("1")) try {
  const res = await cappedFetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Reply with exactly: OK" }] }], generationConfig: { maxOutputTokens: 64 } }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = res.ok ? (((await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })
    .candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "") : "";
  report("1 connection (text)", res.ok && /OK/i.test(text), `reply: ${JSON.stringify(text.slice(0, 40))}`);
} catch (e) {
  report("1 connection (text)", false, scrub(e instanceof Error ? e.message : String(e)));
}

// ── 2-3. synthetic slips through the PR #193 adapter + Bot-summary rules ─────
interface Case {
  name: string; svg: string;
  expect: { slipType: SlipExtraction["slipType"]; amount: number; time: string; status: string };
}
const cases: Case[] = [
  {
    name: "2 synthetic bank slip (QR)",
    svg: bankSlipSvg(),
    expect: { slipType: "BANK_SLIP_QR", amount: 40, time: "2026-10-29T10:15:00.000Z", status: "EXTRACTED" },
  },
  {
    name: "3 synthetic ไทยช่วยไทย wallet receipt",
    svg: walletSlipSvg(),
    expect: { slipType: "THAI_HELP_THAI", amount: 100, time: "2026-10-29T10:49:00.000Z", status: "EXTRACTED" },
  },
];
const outDir = join(tmpdir(), "slip-gemini-smoke");
mkdirSync(outDir, { recursive: true });
const extractor = new GeminiSlipExtractor(apiKey, model, cappedFetch);

for (const c of cases) {
  if (!runs(c.name.slice(0, 1))) continue;
  currentCase = c.name.slice(0, 1);
  last = null;
  const png = await sharp(Buffer.from(c.svg)).png().toBuffer();
  writeFileSync(join(outDir, `${c.name.slice(0, 1)}.png`), png);
  try {
    const e = await extractor.extract({ bytes: new Uint8Array(png), mimeType: "image/png" });
    const status = determineSlipCheckStatus(e);
    const amount = selectEffectiveAmount(e.slipType, e.transferAmount, e.paidAmount, e.grossAmount, e.discountAmount);
    const [flags] = computeValidationFlags(
      [{ checkStatus: status, slipType: e.slipType, transferAmount: e.transferAmount, paidAmount: e.paidAmount,
        grossAmount: e.grossAmount, discountAmount: e.discountAmount, transactionTime: e.transactionTime, referenceId: e.referenceId }],
      parseBatchDate(BATCH_DATE),
    );
    const checks = {
      json: true, // parseSlipExtraction accepted the structured output
      type: e.slipType === c.expect.slipType,
      amount: amount === c.expect.amount,
      date: e.transactionTime === c.expect.time,
      status: status === c.expect.status,
      guard: !flags.flagged,
    };
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
    report(c.name, failed.length === 0,
      `type=${e.slipType} amount=${amount} time=${e.transactionTime} status=${status} guard=${flags.flagReasons.join("|") || "ok"}` +
      ` conf=${e.confidence}${failed.length ? ` | mismatched: ${failed.join(", ")}` : ""}` +
      `\n      raw model output: slip_type=${JSON.stringify(lastCall()?.rawType)}` +
      ` transaction_time=${JSON.stringify(lastCall()?.rawTime)}`);
  } catch (err) {
    report(c.name, false, scrub(err instanceof Error ? err.message : String(err)));
  }
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} PASS | API requests used: ${requests}/${MAX_REQUESTS} | synthetic images: ${outDir}`);
process.exit(passed === results.length ? 0 : 1);

// ── synthetic images (fake data only) ────────────────────────────────────────
function frame(body: string, h = 760): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="${h}">
<rect width="100%" height="100%" fill="#ffffff"/>
<style>text{font-family:Tahoma,'Leelawadee UI',sans-serif;fill:#222}</style>${body}</svg>`;
}
function fakeQr(x: number, y: number): string {
  let cells = "";
  for (let i = 0; i < 21; i++) for (let j = 0; j < 21; j++) {
    if (((i * 7 + j * 13) ^ (i * j)) % 3 === 0) cells += `<rect x="${x + j * 6}" y="${y + i * 6}" width="6" height="6" fill="#000"/>`;
  }
  return cells;
}
function bankSlipSvg(): string {
  return frame(`
<rect width="480" height="90" fill="#1e5aa8"/><text x="24" y="56" font-size="28" style="fill:#fff">ธนาคารทดสอบ</text>
<text x="24" y="140" font-size="26" font-weight="bold" style="fill:#1a7f37">โอนเงินสำเร็จ</text>
<text x="24" y="180" font-size="18">29 ต.ค. 69 17:15 น.</text>
<text x="24" y="240" font-size="16">จาก</text><text x="24" y="268" font-size="20">นาย ทดสอบ ระบบ</text>
<text x="24" y="292" font-size="16">xxx-x-x1111-x</text>
<text x="24" y="340" font-size="16">ไปยัง</text><text x="24" y="368" font-size="20">ร้าน ตัวอย่าง</text>
<text x="24" y="392" font-size="16">xxx-x-x2222-x</text>
<text x="24" y="450" font-size="16">จำนวนเงิน</text><text x="24" y="490" font-size="34" font-weight="bold">40.00 บาท</text>
<text x="24" y="540" font-size="16">ค่าธรรมเนียม 0.00 บาท</text>
<text x="24" y="580" font-size="16">เลขที่รายการ: TEST20261029A1715</text>
${fakeQr(330, 560)}<text x="330" y="700" font-size="12">สแกนตรวจสอบสลิป</text>`);
}
function walletSlipSvg(): string {
  return frame(`
<rect width="480" height="90" fill="#0f7b5f"/><text x="24" y="56" font-size="24" style="fill:#fff">แอปทดสอบ ร้านค้า</text>
<text x="24" y="140" font-size="24" font-weight="bold" style="fill:#1a7f37">รับเงินสำเร็จ</text>
<text x="24" y="190" font-size="40" font-weight="bold">100.00 บาท</text>
<text x="24" y="240" font-size="18">ไทยช่วยไทย พลัส (60/40)</text>
<text x="24" y="300" font-size="18">สิทธิโครงการฯ</text><text x="330" y="300" font-size="18">60.00 บาท</text>
<text x="24" y="340" font-size="18">G-Wallet</text><text x="330" y="340" font-size="18">40.00 บาท</text>
<text x="24" y="400" font-size="16">รับเงินจาก นาง ตัวอย่าง ทดลอง **0000</text>
<text x="24" y="450" font-size="16">วันที่ 29 ต.ค. 2569 เวลา 17:49 น.</text>
<text x="24" y="490" font-size="16">เลขที่อ้างอิง TESTW0001</text>`, 560);
}

// Offline stand-in: proves wiring, cap and parsing with zero network traffic.
async function fakeGemini(_url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const body = JSON.parse(String(init?.body ?? "{}"));
  const isImage = JSON.stringify(body).includes("inlineData");
  const isWallet = isImage && currentCase === "3";
  const out = !isImage ? "OK" : JSON.stringify(isWallet
    ? { slip_type: "THAI_HELP_THAI", gross_amount: 100, discount_amount: 60, paid_amount: 40, project_right_amount: 60,
        gwallet_amount: 40, headline_total_amount: 100, transfer_amount: null, reference_id: "TESTW0001",
        transaction_time: "วันที่ 29 ต.ค. 2569 เวลา 17:49 น.", sender_name: null, receiver_name: null, receiver_account_tail: null,
        payment_channel_text: "ไทยช่วยไทย พลัส (60/40)", confidence: 0.9 }
    : { slip_type: "BANK_SLIP_QR", gross_amount: null, discount_amount: null, paid_amount: null, project_right_amount: null,
        gwallet_amount: null, headline_total_amount: null, transfer_amount: 40, reference_id: "TEST20261029A1715",
        transaction_time: "29 ต.ค. 69 17:15", sender_name: "นาย ทดสอบ ระบบ", receiver_name: "ร้าน ตัวอย่าง",
        receiver_account_tail: "2222", payment_channel_text: null, confidence: 0.95 });
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: out }] } }],
    usageMetadata: { promptTokenCount: isImage ? 1500 : 8, candidatesTokenCount: 120, thoughtsTokenCount: 0 },
  }), { status: 200 });
}
