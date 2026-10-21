import React from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { registerFonts } from "@/lib/pdf/fonts";
import { MorningBriefA4Doc } from "@/lib/pdf/MorningBriefA4Doc";
import type { MorningBriefReport, MorningBriefScope } from "@/lib/summary/morning-brief";

export const MORNING_BRIEF_PDF_BUCKET = "morning-brief-pdfs";
export const MORNING_BRIEF_PDF_EXPIRES_SECONDS = 7 * 24 * 60 * 60;
export const MORNING_BRIEF_REFERENCE_SCHEMA_VERSION = 1 as const;

type Supabase = SupabaseClient<Database>;

export interface MorningBriefReferenceData {
  schemaVersion: typeof MORNING_BRIEF_REFERENCE_SCHEMA_VERSION;
  businessDate: string;
  generatedAt: string;
  pdf: {
    bucket: string;
    path: string;
    filename: string;
  };
  report: MorningBriefReport;
}

export interface MorningBriefPdfArtifact {
  bucket: string;
  path: string;
  filename: string;
  referencePath: string;
  signedUrl: string;
  expiresInSeconds: number;
}

export function morningBriefPdfFilename(businessDate: string, reportScope?: MorningBriefScope): string {
  return `morning-brief-${reportScope ? `${reportScope}-` : ""}${businessDate}.pdf`;
}

export function morningBriefPdfPath(businessDate: string, reportScope?: MorningBriefScope): string {
  return `${businessDate}/${morningBriefPdfFilename(businessDate, reportScope)}`;
}

export function morningBriefReferencePath(businessDate: string, reportScope?: MorningBriefScope): string {
  return morningBriefPdfPath(businessDate, reportScope).replace(/\.pdf$/, ".ref.json");
}

export function buildMorningBriefReferenceData(
  report: MorningBriefReport,
  generatedAt: Date,
  pdf: Pick<MorningBriefPdfArtifact, "bucket" | "path" | "filename">,
): MorningBriefReferenceData {
  return {
    schemaVersion: MORNING_BRIEF_REFERENCE_SCHEMA_VERSION,
    businessDate: report.businessDate,
    generatedAt: generatedAt.toISOString(),
    pdf,
    report,
  };
}

export async function createMorningBriefPdfArtifact(
  supabase: Supabase,
  report: MorningBriefReport,
  generatedAt = new Date(),
): Promise<MorningBriefPdfArtifact> {
  if (report.readiness?.status === "not_ready") throw new Error(`morning brief not_ready: ${report.readiness.reasons.join(", ")}`);
  registerFonts();
  const buffer = await renderToBuffer(
    <MorningBriefA4Doc report={report} generatedAt={generatedAt} />,
  );
  const path = morningBriefPdfPath(report.businessDate, report.reportScope);
  const filename = morningBriefPdfFilename(report.businessDate, report.reportScope);
  const referencePath = morningBriefReferencePath(report.businessDate, report.reportScope);
  const bucket = supabase.storage.from(MORNING_BRIEF_PDF_BUCKET);

  const { error: uploadError } = await bucket.upload(path, new Uint8Array(buffer), {
    contentType: "application/pdf",
    cacheControl: "300",
    upsert: true,
  });
  if (uploadError) throw new Error(`morning brief PDF upload failed: ${uploadError.message}`);

  const referenceData = buildMorningBriefReferenceData(report, generatedAt, {
    bucket: MORNING_BRIEF_PDF_BUCKET,
    path,
    filename,
  });
  const referenceBytes = new TextEncoder().encode(JSON.stringify(referenceData));
  const { error: referenceUploadError } = await bucket.upload(referencePath, referenceBytes, {
    contentType: "application/json",
    cacheControl: "300",
    upsert: true,
  });
  if (referenceUploadError) {
    throw new Error(`morning brief reference upload failed: ${referenceUploadError.message}`);
  }

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
    referencePath,
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
