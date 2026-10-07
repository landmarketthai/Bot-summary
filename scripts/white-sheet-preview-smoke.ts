import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { extractWhiteSheetPreview, renderWhiteSheetPreview, PREVIEW_MAX_IMAGE_BYTES } from "../src/lib/white-sheet-reader/reader";

const [path, expectedType] = process.argv.slice(2);
if (!path || !["white_sheet", "unknown"].includes(expectedType)) {
  throw new Error("Usage: bun run scripts/white-sheet-preview-smoke.ts <real-image-path> <white_sheet|unknown>");
}
if (statSync(path).size > PREVIEW_MAX_IMAGE_BYTES) throw new Error("Image too large");
const mimeType = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" } as Record<string, string>)[extname(path).toLowerCase()];
const extraction = await extractWhiteSheetPreview({ bytes: readFileSync(path), mimeType });
const messages = renderWhiteSheetPreview(extraction);
console.log(JSON.stringify({ extraction, messages }, null, 2));
if (extraction.documentType !== expectedType
  || (expectedType === "white_sheet" && !messages[0].startsWith("อ่านใบขาวแล้ว (รอตรวจ)"))) {
  throw new Error(`Unexpected document classification: ${extraction.documentType}`);
}
