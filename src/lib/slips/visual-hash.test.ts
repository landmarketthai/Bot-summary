import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { computeSlipVisualHashes, visualHashDistance } from "./visual-hash";

const sample = `<svg width="360" height="640" xmlns="http://www.w3.org/2000/svg">
  <rect width="360" height="640" fill="white"/>
  <rect x="18" y="30" width="324" height="60" fill="#dadada"/>
  <rect x="35" y="135" width="290" height="6" fill="#363636"/>
  <rect x="35" y="167" width="190" height="8" fill="#555555"/>
  <rect x="35" y="216" width="265" height="42" fill="#f4f4f4"/>
  <text x="50" y="246" font-size="27" fill="#111111">100.00 THB</text>
  <rect x="35" y="311" width="110" height="8" fill="#444444"/>
  <rect x="35" y="339" width="230" height="8" fill="#777777"/>
  <rect x="35" y="410" width="290" height="10" fill="#444444"/>
  <rect x="35" y="445" width="155" height="7" fill="#777777"/>
  <rect x="35" y="530" width="290" height="32" fill="#aaaaaa"/>
</svg>`;

describe("receipt visual fingerprint", () => {
  test("same receipt re-encoded as JPEG produces a near-match", async () => {
    const png = await sharp(Buffer.from(sample)).png().toBuffer();
    const jpeg = await sharp(png).jpeg({ quality: 80 }).toBuffer();
    const a = await computeSlipVisualHashes(png);
    const b = await computeSlipVisualHashes(jpeg);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    const close = Math.min(visualHashDistance(a!.full, b!.full), visualHashDistance(a!.center, b!.center));
    expect(close).toBeLessThanOrEqual(6);
  });

  test("small 2% border crop matches one projection", async () => {
    const png = await sharp(Buffer.from(sample)).png().toBuffer();
    const cropped = await sharp(png).extract({ left: 7, top: 12, width: 346, height: 616 }).jpeg({ quality: 82 }).toBuffer();
    const a = (await computeSlipVisualHashes(png))!;
    const b = (await computeSlipVisualHashes(cropped))!;
    const close = Math.min(visualHashDistance(a.full,b.full),visualHashDistance(a.center,b.center));
    expect(close).toBeLessThanOrEqual(6);
  });

  test("corrupt bytes return null, invalid hash is rejected", async () => {
    expect(await computeSlipVisualHashes(new Uint8Array([1,2,3]))).toBeNull();
    expect(() => visualHashDistance("not-a-hash", "0000000000000000")).toThrow();
  });
});
