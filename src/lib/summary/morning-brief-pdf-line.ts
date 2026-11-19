import type { LineApiMessage } from "@/lib/line/reply";
import { formatThaiDate } from "@/lib/date";
import type { MorningBriefScope } from "./morning-brief";
import { MORNING_BRIEF_PDF_BUCKET, type MorningBriefPdfArtifact } from "./morning-brief-pdf";

export function buildMorningBriefPdfFlexMessage(artifact: MorningBriefPdfArtifact, businessDate: string, scope: MorningBriefScope) {
  const invalidUrl = "invalid morning brief PDF signed URL";
  let configured: URL;
  let signed: URL;
  try {
    configured = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
    signed = new URL(artifact.signedUrl);
  } catch {
    throw new Error(invalidUrl);
  }

  const objectPath = artifact.path.split("/").map(encodeURIComponent).join("/");
  const expectedPath = `/storage/v1/object/sign/${MORNING_BRIEF_PDF_BUCKET}/${objectPath}`;
  const base = `${signed.origin}${signed.pathname}`;
  const query = signed.search.slice(1).split("&");
  const token = query.find((param) => param.startsWith("token="));
  // Comparing the raw URL also rejects userinfo, fragments and normalized path aliases.
  if (configured.protocol !== "https:" || configured.username || configured.password
    || signed.protocol !== "https:" || signed.origin !== configured.origin
    || artifact.bucket !== MORNING_BRIEF_PDF_BUCKET || signed.pathname !== expectedPath
    || artifact.signedUrl !== `${base}${signed.search}`
    || query.length !== 2 || !token || !signed.searchParams.get("token")?.trim()
    || !query.some((param) => param.startsWith("download="))
    || !artifact.filename || signed.searchParams.get("download") !== artifact.filename) {
    throw new Error(invalidUrl);
  }

  const button = (label: string, uri: string) => ({
    type: "button",
    style: label === "ดาวน์โหลด PDF" ? "primary" : "secondary",
    height: "sm",
    action: { type: "uri", label, uri },
  } as const);
  const title = `รายงาน${scope === "fruit" ? "ผลไม้" : "ผัก"} PDF (A4)`;
  const dateLabel = formatThaiDate(businessDate);
  return {
    type: "flex",
    altText: `${title} — ${dateLabel}`,
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: title, weight: "bold", wrap: true },
          { type: "text", text: dateLabel, size: "sm", wrap: true },
          { type: "text", text: "ลิงก์ใช้ได้ 7 วัน", size: "sm", margin: "sm" },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          button("เปิด PDF", `${base}?${token}&openExternalBrowser=1`),
          button("ดาวน์โหลด PDF", `${artifact.signedUrl}&openExternalBrowser=1`),
        ],
      },
    },
  } as const satisfies LineApiMessage;
}
