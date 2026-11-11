"use client";

import { useState, type FormEvent } from "react";

type TestResult = {
  status: "verified" | "duplicate" | "receiver_mismatch" | "not_found";
  amountBaht?: number | null;
  referenceId?: string | null;
  transferTime?: string | null;
  receiverName?: string | null;
  receiverAccountTail?: string | null;
  accountMatched?: boolean;
  isDuplicate?: boolean;
  persisted: false;
  countedAsRevenue: false;
};

const statusText: Record<TestResult["status"], string> = {
  verified: "ตรวจ QR ผ่าน และบัญชีผู้รับตรงกับบัญชีที่ผูกไว้",
  duplicate: "พบสลิปซ้ำ — ห้ามนับยอดซ้ำ",
  receiver_mismatch: "บัญชีผู้รับไม่ตรงกับบัญชีที่ผูกไว้",
  not_found: "EasySlip ไม่พบ QR ที่ตรวจสอบได้",
};

export function EasySlipTestForm() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState("");

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || busy) return;
    setBusy(true);
    setResult(null);
    setError("");
    try {
      if (file.size > 4 * 1024 * 1024) throw new Error("ไฟล์ต้องไม่เกิน 4 MB");
      const form = new FormData();
      form.append("image", file);
      const response = await fetch("/api/admin/easyslip-test", {
        method: "POST",
        body: form,
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = await response.json() as TestResult & { error?: string; reason?: string };
      if (!response.ok) throw new Error(data.reason ? `${data.error}: ${data.reason}` : data.error ?? "ตรวจสอบไม่สำเร็จ");
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "เกิดข้อผิดพลาด");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-lg font-semibold text-slate-900">อัปโหลดสลิปธนาคาร</h2>
      <p className="mt-1 text-sm text-slate-600">
        เลือกภาพ JPG / PNG / GIF / WebP ที่มี QR ชัดเจน ขนาดไม่เกิน 4 MB
      </p>
      <form onSubmit={verify} className="mt-5 space-y-4">
        <input
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setResult(null);
            setError("");
          }}
          className="block w-full rounded-lg border border-slate-200 p-3 text-sm"
          aria-label="เลือกรูปสลิป"
        />
        <button
          type="submit"
          disabled={!file || busy}
          className="rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "กำลังตรวจ EasySlip..." : "ตรวจสลิป (ไม่บันทึกยอด)"}
        </button>
      </form>
      {error && <p role="alert" className="mt-5 rounded-lg bg-red-50 p-4 text-sm text-red-800">{error}</p>}
      {result && (
        <div className="mt-5 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-800">
          <p className="font-semibold">{statusText[result.status]}</p>
          {result.amountBaht != null && <p>ยอดโอน: <strong>{result.amountBaht.toLocaleString("th-TH")} บาท</strong></p>}
          {result.receiverName && <p>ผู้รับ: {result.receiverName}</p>}
          {result.receiverAccountTail && <p>ท้ายบัญชีผู้รับ: {result.receiverAccountTail}</p>}
          {result.transferTime && <p>วันเวลา: {new Date(result.transferTime).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })}</p>}
          {result.referenceId && <p className="break-all">เลขอ้างอิง: {result.referenceId}</p>}
          <p className="border-t border-slate-200 pt-2 font-semibold text-amber-800">
            ไม่มีการบันทึกข้อมูลหรือเพิ่มยอดเงินใน Bot-summary
          </p>
        </div>
      )}
    </div>
  );
}
