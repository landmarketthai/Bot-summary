import { describe, expect, test } from "bun:test";
import { produceSectionOf } from "./produce-section";

describe("produceSectionOf — explicit classification, never fruit by elimination", () => {
  test.each([
    // fish / dry goods (code table) and an unknown fish name
    ["กะปิ", "other"], ["กุ้งแห้ง", "other"], ["ขนมจีน", "other"], ["ปลากรอบ", "other"], ["ปลาทูเคม", "other"],
    // business-approved Morning Brief classification
    ["หมอน", "fruit"], ["ทุเรียน", "fruit"],
    ["กล้วยน้ำหว้า", "fruit"], ["ลูกพลุน", "fruit"], ["ลูกพรุน", "fruit"],
    ["ลูกไหนดำแดง", "fruit"], ["องุ่นมีเม็ด", "fruit"], ["กันจอง", "vegetable"],
    ["น้ำใบย่านาง", "other"], ["ปลาทูนึ่ง", "other"],
    // genuinely unknown names stay unclassified
    ["สินค้าใหม่ไม่รู้จัก", "other"],
    // the mixed รายการพิเศษ packs, one by one
    ["ขนุนแพ็ค", "fruit"], ["ผลไม้กล่อง", "fruit"], ["มะระถุง", "vegetable"], ["บวบหอมแพ็ค", "vegetable"],
    // ordinary fruit and vegetables, from the code table and the stock map
    ["มังคุด", "fruit"], ["เมล่อน", "fruit"], ["กะหล่ำปลี", "vegetable"], ["คะน้า", "vegetable"],
    ["ใบกุยช่าย", "vegetable"], ["เห็ดเข็มทอง", "vegetable"],
    // Read-only 30-day field audit: classification only, never identity merge.
    ["แก้วขมิ้น", "fruit"], ["ส้มสายน้ำผึ้ง", "fruit"], ["ส้มจีน", "fruit"],
    ["ฝรั่งแดงตำหนิ", "fruit"], ["ผลไม้กลอ่ง", "fruit"],
    ["มะเขือราชีนี", "vegetable"], ["มะเขือเทสราชีนี", "vegetable"],
    ["หน่อไม้ฝรั่ง", "vegetable"], ["กะหล่ำปลีม่วง", "vegetable"],
    ["พริกชีฟ้าแดง", "vegetable"], ["พริกชีฟ้าเขียว", "vegetable"],
    ["ต้นหอมยี่ปุ่น", "vegetable"], ["บอคเคอรี่", "vegetable"],
    ["มะเขือยาวมว่ง", "vegetable"], ["ใบโหรพา", "vegetable"],
    ["ขนมจีน", "other"], ["ปลาทูนึ่ง", "other"], ["เครื่องยาจีน", "other"],
  ] as const)("%s → %s", (name, section) => {
    expect(produceSectionOf(name)).toBe(section);
  });
});
