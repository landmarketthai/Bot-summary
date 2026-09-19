import React from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { registerFonts } from "@/lib/pdf/fonts";
import { MorningBriefA4Doc } from "@/lib/pdf/MorningBriefA4Doc";
import type { MorningBriefReport } from "@/lib/summary/morning-brief";

export const MORNING_BRIEF_PDF_BUCKET = "morning-brief-pdfs";
export const MORNING_BRIEF_PDF_EXPIRES_SECONDS = 7 * 24 * 60 * 60;

type Supabase = SupabaseClient<Database>;

export interface MorningBriefPdfArtifact {
  bucket: string;
  path: string;
  filename: string;
  signedUrl: string;
  expiresInSeconds: number;
}

export function morningBriefPdfFilename(businessDate: string): string {
  return `morning-brief-${businessDate}.pdf`;
}

export function morningBriefPdfPath(businessDate: string): string {
  return `${businessDate}/${morningBriefPdfFilename(businessDate)}`;
}
export async function createMorningBriefPdfArtifact(
  supabase: Supabase,
  report: MorningBriefReport,
  generatedAt = new Date(),
): Promise<MorningBriefPdfArtifact> {
  registerFonts();
  const buffer = await renderToBuffer(
    <MorningBriefA4Doc report={report} generatedAt={generatedAt} />,
  );
  const path = morningBriefPdfPath(report.businessDate);
  const filename = morningBriefPdfFilename(report.businessDate);
  const bucket = supabase.storage.from(MORNING_BRIEF_PDF_BUCKET);

  const { error: uploadError } = await bucket.upload(path, new Uint8Array(buffer), {
    contentType: "application/pdf",
    cacheControl: "300",
    upsert: true,
  });
  if (uploadError) throw new Error(`morning brief PDF upload failed: ${uploadError.message}`);

  const { data, error: signedUrlError } = await bucket.createSignedUrl(
    path,
    MORNING_BRIEF_PDF_EXPIRES_SECONDS,
    { download: filename },
  );
  if (signedUrlError || !data?.signedUrl) {
    throw new Error(`morning brief PDF signed URL failed: ${signedUrlError?.message ?? "missing signed URL"}`);
  }

  return {
    bucket: MORNING_BRIEF_PDF_BUCKET,
    path,
    filename,
    signedUrl: data.signedUrl,
    expiresInSeconds: MORNING_BRIEF_PDF_EXPIRES_SECONDS,
  };
}

export function morningBriefPdfLineMessage(signedUrl: string): string {
  return [
    "📄 PDF สำหรับพิมพ์ A4 พร้อมแล้ว",
    `ดาวน์โหลด: ${signedUrl}`,
    "ลิงก์ใช้ได้ 7 วัน",
  ].join("\n");
}
