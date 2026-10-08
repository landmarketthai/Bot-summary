import { describe, expect, test } from "bun:test";
import { claimsSaved, guardConsultantAnswer, isStatusQuestion } from "./answer";

describe("saved-claim detection", () => {
  test.each([
    "บันทึกแล้วครับ", "บันทึก แล้ว", "บันทึก​แล้ว", "บันทึกไปแล้ว", "บันทึกให้แล้ว",
    "บันทึกเข้าระบบแล้ว", "บันทึกครบแล้ว", "เซฟแล้ว", "เข้าระบบแล้ว", "สำเร็จแล้ว",
    "เรียบร้อยแล้ว", "รายการเข้าแล้ว", "สถานะ “บันทึกแล้ว”",
  ])("flags %p", (text) => expect(claimsSaved(text)).toBe(true));

  test.each([
    "ยังบันทึกไม่สำเร็จครับ", "ยังไม่ได้บันทึกครับ", "ยังไม่บันทึก", "ไม่ได้บันทึกเพิ่ม",
    "รายการชั่งคืนของน้อย–ราชพฤกษ์ วันที่ 7 ต.ค. ยังบันทึกไม่สำเร็จครับ ระบบอ่านได้ 23 รายการ",
  ])("does not flag %p", (text) => expect(claimsSaved(text)).toBe(false));

  test("how-to answers may quote the bot's own message", () => {
    expect(claimsSaved("รอข้อความ “บันทึกแล้ว” จากบอท", true)).toBe(false);
  });
});

describe("guardConsultantAnswer", () => {
  const failed = { status: "ok", submission: { persisted: false }, suggestedReply: "ยังบันทึกไม่สำเร็จครับ" };
  const saved = { status: "ok", submission: { persisted: true }, suggestedReply: "บันทึกเรียบร้อยแล้วครับ" };

  test("an unproven saved claim is replaced by the deterministic reply", () => {
    expect(guardConsultantAnswer("บันทึกให้แล้วครับ", [failed])).toBe("ยังบันทึกไม่สำเร็จครับ");
  });

  test("internal status names never reach the worker", () => {
    expect(guardConsultantAnswer("สถานะ failed_closed ครับ", [failed])).toBe("ยังบันทึกไม่สำเร็จครับ");
  });

  test("only the last document's proof counts", () => {
    expect(guardConsultantAnswer("บันทึกแล้วครับ", [saved, failed])).toBe("ยังบันทึกไม่สำเร็จครับ");
    expect(guardConsultantAnswer("บันทึกแล้ว 12 รายการครับ", [failed, saved])).toBe("บันทึกแล้ว 12 รายการครับ");
  });
});

describe("status vs how-to routing", () => {
  test.each([
    "เมื่อกี้รายการผมเข้าหรือยัง", "ผมส่งชั่งคืนสำเร็จไหม", "ตอนนี้รายการผมเป็นยังไง", "วันนี้มีอะไรค้าง",
    "รายการล่าสุดติดอะไรอยู่", "ทำไมข้อ 22 ไม่ผ่าน", "ผมต้องแก้อะไร", "ต้องส่งใหม่ทั้งหมดไหม",
    "ช่วยดูรายการที่ค้างหน่อย", "ตอนนี้ต้องทำยังไงต่อ", "ทำไมรายการชั่งคืนของน้อยยังไม่เข้า",
    "ส่งรายการแล้วทำไมยังไม่ขึ้น",
  ])("status: %p", (question) => expect(isStatusQuestion(question)).toBe(true));

  test.each([
    "เบิกของต้องพิมพ์ยังไง", "ชั่งคืนต้องทำยังไง", "ถ้าพิมพ์ชื่อผักผิดต้องแก้ยังไง", "ส่งสลิปยังไง",
    "ใบขาวใช้ยังไง", "จบรายการแล้วต้องทำอะไรต่อ", "กู้รายการล่าสุดทำยังไง",
  ])("how-to: %p", (question) => expect(isStatusQuestion(question)).toBe(false));
});
