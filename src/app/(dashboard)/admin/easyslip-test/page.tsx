import { notFound } from "next/navigation";
import { requireAdminActor } from "@/lib/auth/admin";
import { createClient } from "@/lib/supabase/server";
import { DashboardTopBar } from "@/components/dashboard/DashboardTopBar";
import { EasySlipTestForm } from "./test-form";

export const metadata = { title: "ทดสอบ EasySlip — Bot-summary" };

export default async function EasySlipTestPage() {
  try {
    await requireAdminActor(await createClient());
  } catch {
    notFound();
  }

  return (
    <>
      <DashboardTopBar title="ทดสอบ EasySlip (ไม่บันทึกยอด)" />
      <div className="mx-auto w-full max-w-3xl space-y-5 p-4 sm:p-6">
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
          <strong>โหมดทดสอบเท่านั้น:</strong> อัปโหลดภาพสลิปหนึ่งใบเพื่อตรวจสอบผ่าน EasySlip
          โดยไม่สร้างรายการสลิป ไม่เปลี่ยนยอดขาย ไม่บันทึกข้อมูลลงฐานข้อมูล Bot-summary
          และไม่ส่งข้อความ LINE ภาพจะถูกส่งให้ EasySlip เพื่อการตรวจสอบ
        </div>
        <EasySlipTestForm />
      </div>
    </>
  );
}
