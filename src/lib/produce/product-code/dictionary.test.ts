/**
 * The dictionary has three copies — the approved CSV, the generated runtime
 * module, and the migration seed — and they are only safe while all three say
 * exactly the same thing. These tests are what makes that true, so a hand-edit
 * to any one of them fails here instead of in Production.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PRODUCT_CODE_COUNT,
  PRODUCT_CODE_ENABLED_COUNT,
  PRODUCT_CODE_ENTRIES,
} from "./dictionary";
import {
  isProductCodeToken,
  resolveItemLineProductCode,
  resolveProductCode,
} from "./resolver";

const HERE = import.meta.dir;
const BASE_MIGRATION = join(
  HERE, "..", "..", "..", "..",
  "supabase", "migrations", "20260813115826_produce_product_code_dictionary.sql",
);
const CLEANUP_MIGRATION = join(
  HERE, "..", "..", "..", "..",
  "supabase", "migrations", "20260818105651_produce_product_dictionary_cleanup.sql",
);
const KAEO_KHAMIN_MIGRATION = join(
  HERE, "..", "..", "..", "..",
  "supabase", "migrations", "20260824185542_produce_product_dictionary_add_kaeo_khamin_mango.sql",
);
const CHINESE_JUJUBE_MIGRATION = join(
  HERE, "..", "..", "..", "..",
  "supabase", "migrations", "20260901093000_produce_product_dictionary_add_chinese_jujube.sql",
);
const UNCLASSIFIED_FRUIT_MIGRATION = join(
  HERE, "..", "..", "..", "..",
  "supabase", "migrations", "20260908090000_produce_product_dictionary_add_unclassified_fruit.sql",
);
const FAH_LAN_MIGRATION = join(
  HERE, "..", "..", "..", "..",
  "supabase", "migrations", "20260827055728_produce_product_dictionary_add_fah_lan_mango.sql",
);

interface Row {
  code: string;
  categoryCode: string;
  category: string;
  canonicalName: string;
  enabled: boolean;
}

/** The approved CSV, read the same way the generator reads it. */
function csvRows(): Row[] {
  const text = readFileSync(join(HERE, "dictionary.csv"), "utf8").replace(/^﻿/, "");
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  expect(lines.shift()).toBe("code,category_code,category,canonical_name,active_dictionary");

  return lines.map((line) => {
    const [code, categoryCode, category, canonicalName, active] = line.split(",").map((p) => p.trim());
    return { code, categoryCode, category, canonicalName, enabled: active === "True" };
  });
}

/** Rows inserted by a migration's own `INSERT ... VALUES` block, in file order. */
function insertedRowsOf(migrationPath: string): Row[] {
  const sql = readFileSync(migrationPath, "utf8");
  return [...sql.matchAll(/^ {2}\('(.+?)', '(.+?)', '(.+?)', '(.+?)', (true|false)\)/gmu)].map(
    (m) => ({
      code: m[1],
      categoryCode: m[2],
      category: m[3],
      canonicalName: m[4],
      enabled: m[5] === "true",
    }),
  );
}

/**
 * The seed rows the base Production migration (20260813090000) actually
 * inserts, verbatim.
 */
function baseMigrationRows(): Row[] {
  return insertedRowsOf(BASE_MIGRATION);
}

/**
 * A migration applied ON TOP of the base seed: either new rows inserted at a
 * named position, or a canonical_name correction to an existing code (the
 * ONLY identity mutation allowed, and only because 20260818100000 proves it is
 * a spelling correction of the same product, not a repoint).
 *
 * Adding a future migration is: append one more entry here naming the file,
 * where its new rows land (the code they follow), and any renames it makes.
 */
interface AppliedMigration {
  file: string;
  /** New rows this migration inserts, spliced in immediately after this code. */
  insertAfterCode: string;
  /** code -> corrected canonicalName, applied to rows from earlier migrations. */
  renames?: Record<string, string>;
}

const APPLIED_MIGRATIONS: AppliedMigration[] = [
  {
    file: CLEANUP_MIGRATION,
    insertAfterCode: "ม62",
    renames: { "ม54": "ไซมัส" }, // ไซมัส
  },
  {
    file: KAEO_KHAMIN_MIGRATION,
    insertAfterCode: "ม71",
  },
  {
    file: FAH_LAN_MIGRATION,
    insertAfterCode: "ม72",
  },
  {
    file: CHINESE_JUJUBE_MIGRATION,
    insertAfterCode: "ม73",
  },
  {
    file: UNCLASSIFIED_FRUIT_MIGRATION,
    insertAfterCode: "ม74",
  },
];

/**
 * The dictionary state a Production database would actually have after every
 * migration applies, in order: start from the base seed, then for each later
 * migration apply its renames to the rows already accumulated and splice in
 * its own new rows at the named anchor. This is deliberately independent of
 * dictionary.csv / dictionary.ts — it reconstructs the DB's truth purely from
 * the migration files, so a hand-edit to the CSV or the generated module that
 * drifts from what the migrations actually do fails here.
 */
function migrationRows(): Row[] {
  let rows = baseMigrationRows();

  for (const migration of APPLIED_MIGRATIONS) {
    if (migration.renames) {
      const renames = migration.renames;
      rows = rows.map((row) => (renames[row.code] ? { ...row, canonicalName: renames[row.code] } : row));
    }

    const inserted = insertedRowsOf(migration.file);
    const anchor = rows.findIndex((row) => row.code === migration.insertAfterCode);
    if (anchor === -1) {
      throw new Error(`${migration.file}: insertAfterCode ${migration.insertAfterCode} not found`);
    }
    rows = [...rows.slice(0, anchor + 1), ...inserted, ...rows.slice(anchor + 1)];
  }

  return rows;
}

const moduleRows = (): Row[] =>
  PRODUCT_CODE_ENTRIES.map((e) => ({
    code: e.code,
    categoryCode: e.categoryCode,
    category: e.category,
    canonicalName: e.canonicalName,
    enabled: e.enabled,
  }));

describe("the approved dictionary is the source of truth", () => {
  it("carries exactly the 271 approved codes", () => {
    expect(PRODUCT_CODE_COUNT).toBe(271);
    expect(PRODUCT_CODE_ENABLED_COUNT).toBe(271);
    expect(PRODUCT_CODE_ENTRIES).toHaveLength(271);
    expect(csvRows()).toHaveLength(271);
  });

  it("matches the CSV row for row, in the approved order and numbering", () => {
    // Order matters: re-sorting the CSV would renumber the approved codes.
    expect(moduleRows()).toEqual(csvRows());
  });

  it("composes to the identical rows once every migration is applied in order", () => {
    // migrationRows() replays the base seed (20260813090000) plus every
    // migration layered on top of it (20260818100000's ม54 correction and its
    // nine new rows) — the actual sequence a Production database runs. That
    // composed result has to equal the approved CSV, or the migrations and the
    // CSV have drifted apart.
    expect(migrationRows()).toEqual(csvRows());
  });

  it("keeps the approved namespace ranges", () => {
    const counts = new Map<string, number>();
    for (const entry of PRODUCT_CODE_ENTRIES) {
      counts.set(entry.categoryCode, (counts.get(entry.categoryCode) ?? 0) + 1);
    }
    expect(Object.fromEntries(counts)).toEqual({
      ม: 80, ผ: 118, ป: 36, ท: 26, ห: 4, พ: 7,
    });
  });

  it("never issues one code twice", () => {
    const codes = PRODUCT_CODE_ENTRIES.map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("real mappings from the approved CSV resolve", () => {
  // One representative per namespace, plus the boundary codes of each range.
  const cases: Array<[string, string]> = [
    ["ม01", "กล้วยไข่"],
    ["ม02", "กล้วยน้ำว้า"],
    ["ม54", "ไซมัส"],
    ["ม62", "แอปเปิ้ล"],
    ["ม68", "องุ่นคิมสัน"],
    ["ม72", "มะม่วงแก้วขมิ้น"],
    ["ม73", "มะม่วงฟ้าลั่น"],
    ["ผ01", "ฝักกระเจี๊ยบ"],
    ["ผ07", "กระเทียมหัว"],
    ["ผ99", "ใบตั้งโอ๋"],
    ["ผ100", "ใบบัวบก"],
    ["ผ118", "ข้าวคั่ว"],
    ["ป01", "กะปิ"],
    ["ป36", "หอยเชลล์"],
    ["ท01", "ทุเรียน"],
    ["ท26", "ภูเขาไฟลูกค้าเคลม"],
    ["ห01", "เห็ดนางฟ้า"],
    ["ห04", "เห็ดออรินจิ"],
    ["พ01", "ผลไม้กล่อง"],
    ["พ07", "มะระถุง"],
  ];

  for (const [code, canonicalName] of cases) {
    it(`${code} → ${canonicalName}`, () => {
      expect(resolveProductCode(code)).toBe(canonicalName);
    });
  }

  it("resolves codes past two digits — ผ runs to ผ118", () => {
    expect(resolveProductCode("ผ100")).not.toBeNull();
    expect(resolveProductCode("ผ118")).not.toBeNull();
  });
});

describe("unregistered codes do not resolve", () => {
  // ม63-ม80 exist as of this extension, so ม81 — the code right past the new
  // boundary — is the genuinely unissued example, not ม74 or ม80.
  for (const code of ["ม99", "ม999", "ผ999", "ป99", "ท99", "ห99", "พ99", "ผ119", "ม81"]) {
    it(`${code} is unknown`, () => {
      expect(resolveProductCode(code)).toBeNull();
      expect(resolveItemLineProductCode(`${code} 50 บาท`)).toEqual({ kind: "unknown", code });
    });
  }
});

describe("code recognition is narrow", () => {
  it("recognizes only a namespace character followed by digits", () => {
    expect(isProductCodeToken("ม01")).toBe(true);
    expect(isProductCodeToken("ผ118")).toBe(true);
    expect(isProductCodeToken("กล้วยน้ำว้า")).toBe(false);
    expect(isProductCodeToken("มะม่วง")).toBe(false);
    expect(isProductCodeToken("ปลาหวานแดง")).toBe(false);
    expect(isProductCodeToken("ผักกาดขาว")).toBe(false);
    expect(isProductCodeToken("01")).toBe(false);
    expect(isProductCodeToken("ก01")).toBe(false);
  });

  it("leaves an ordinary product line completely alone", () => {
    for (const line of [
      "กล้วยน้ำว้า 35 บาท",
      "1.ปลาหวานแดง100บาท",
      "เสาวรส 50 บาท",
      "มะม่วงน้ำดอกไม้ 40 บาท",
      "85ผักกาดขาว3หัว20บาท",
    ]) {
      expect(resolveItemLineProductCode(line)).toEqual({ kind: "none", content: line });
    }
  });

  it("never touches a seller/market header, a date, or a closer", () => {
    for (const line of [
      "กี้-วัดทุ่งลานนา เบิก 13/8/2569",
      "มิ้น-ทรัพย์พันธ์2 ชั่งคืน 11/8/2569",
      "ผ่องศรี-ปากคลอง เบิกเพิ่ม 13/8/2569",
      "13/8/2569",
      "จบรายการเบิก",
      "รายการชั่งเบิก",
      // The adversarial one: a seller whose name really is a namespace
      // character plus digits. The dash is not whitespace, so the boundary
      // never matches and the header parses as a header.
      "ม1-ตลาด เบิก 13/8/2569",
      "ผ2-คลองเตย ชั่งคืน 13/8/2569",
    ]) {
      expect(resolveItemLineProductCode(line)).toEqual({ kind: "none", content: line });
    }
  });

  it("leaves the compact scale form untouched — a code needs a separator", () => {
    // "ม0150บาท" has no boundary between code and price and is genuinely
    // ambiguous, so it keeps reading exactly as it did before codes existed.
    expect(resolveItemLineProductCode("ม0150บาท")).toEqual({
      kind: "none",
      content: "ม0150บาท",
    });
  });

  it("rewrites only the product token, behind an optional item number", () => {
    expect(resolveItemLineProductCode("ม02 35 บาท")).toMatchObject({
      kind: "resolved",
      content: "กล้วยน้ำว้า 35 บาท",
      code: "ม02",
    });
    expect(resolveItemLineProductCode("1.ม02 35 บาท")).toMatchObject({
      kind: "resolved",
      content: "1.กล้วยน้ำว้า 35 บาท",
    });
    expect(resolveItemLineProductCode("85ผ51 3หัว20บาท")).toMatchObject({
      kind: "resolved",
      content: "85ผักกาดขาว 3หัว20บาท",
    });
  });
});

describe("20260818100000 dictionary cleanup — ม54 correction and ม63–ม68", () => {
  it("ม54 resolves to the corrected spelling ไซมัส", () => {
    expect(resolveProductCode("ม54")).toBe("ไซมัส");
  });

  const NEW_CODES: Array<[string, string]> = [
    ["ม63", "มะม่วงจิ้ว"],
    ["ม64", "ลูกพีชเล็ก"],
    ["ม65", "ลูกพีชใหญ่"],
    ["ม66", "ลูกไหนเขียว"],
    ["ม67", "ลูกไหนดำ"],
    ["ม68", "องุ่นคิมสัน"],
  ];

  for (const [code, canonicalName] of NEW_CODES) {
    it(`${code} → ${canonicalName}`, () => {
      expect(resolveProductCode(code)).toBe(canonicalName);
    });
  }

  describe("independence — the new rows are not a merge of an existing code", () => {
    it("the pre-existing ม42/ม43/ม44 codes still resolve to their own products", () => {
      expect(resolveProductCode("ม42")).toBe("ลูกพีช");
      expect(resolveProductCode("ม43")).toBe("ลูกไหน");
      expect(resolveProductCode("ม44")).toBe("ลูกไหนแดง");
    });

    it("small/large/color variants resolve to codes distinct from their base product's code", () => {
      expect(resolveProductCode("ม64")).not.toBe(resolveProductCode("ม42")); // ลูกพีชเล็ก !== ลูกพีช
      expect(resolveProductCode("ม65")).not.toBe(resolveProductCode("ม42")); // ลูกพีชใหญ่ !== ลูกพีช
      expect(resolveProductCode("ม66")).not.toBe(resolveProductCode("ม43")); // ลูกไหนเขียว !== ลูกไหน
      expect(resolveProductCode("ม67")).not.toBe(resolveProductCode("ม43")); // ลูกไหนดำ !== ลูกไหน
    });
  });

  it("no product code collision — the new codes each appear exactly once in the full set", () => {
    const codes = PRODUCT_CODE_ENTRIES.map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length); // full-set targeted re-check
    for (const code of ["ม63", "ม64", "ม65", "ม66", "ม67", "ม68"]) {
      expect(codes.filter((c) => c === code)).toHaveLength(1);
    }
  });
});

describe("dictionary cleanup extension — ม69–ม71 (ส้มแมนดาริน / องุ่นเคียวโฮ / ลิ้นจี่)", () => {
  const NEW_CODES: Array<[string, string]> = [
    ["ม69", "ส้มแมนดาริน"],
    ["ม70", "องุ่นเคียวโฮ"],
    ["ม71", "ลิ้นจี่"],
  ];

  for (const [code, canonicalName] of NEW_CODES) {
    it(`${code} → ${canonicalName}`, () => {
      expect(resolveProductCode(code)).toBe(canonicalName);
    });
  }

  it("ม31 still resolves to its unchanged canonical name มะม่วงเขียวมรกต", () => {
    // เขียวมรกต folds into this canonical name at the application layer
    // (src/lib/summary/remaining-fruit.ts PRODUCT_ALIASES), not by changing
    // the dictionary row itself — ม31 must be exactly as it was.
    expect(resolveProductCode("ม31")).toBe("มะม่วงเขียวมรกต");
  });

  it("no product code collision — ม69–ม71 each appear exactly once in the full set", () => {
    const codes = PRODUCT_CODE_ENTRIES.map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of ["ม69", "ม70", "ม71"]) {
      expect(codes.filter((c) => c === code)).toHaveLength(1);
    }
  });

  it("the composed migration-parity check still holds with the extended INSERT block", () => {
    // Verified, not assumed: insertedRowsOf() re-parses the migration file's
    // own VALUES block with the same regex the base suite relies on, so a
    // formatting slip in the new ม69-ม71 rows would fail here.
    expect(migrationRows()).toEqual(csvRows());
  });
});

describe("dictionary extension 20260824090000 — ม72 (มะม่วงแก้วขมิ้น)", () => {
  it("ม72 → มะม่วงแก้วขมิ้น", () => {
    expect(resolveProductCode("ม72")).toBe("มะม่วงแก้วขมิ้น");
  });

  describe("independence — a distinct mango, not a merge of an existing one", () => {
    it("the other mango codes it must never be confused with keep their own identities", () => {
      expect(resolveProductCode("ม63")).toBe("มะม่วงจิ้ว");
      expect(resolveProductCode("ม32")).toBe("มะม่วงงาช้าง");
      expect(resolveProductCode("ม35")).toBe("มหาชนก");
      expect(resolveProductCode("ม31")).toBe("มะม่วงเขียวมรกต");
      expect(resolveProductCode("ม33")).toBe("มะม่วงน้ำดอกไม้");
    });

    it("ม72 resolves to a name distinct from every other mango code", () => {
      const kaeoKhamin = resolveProductCode("ม72");
      for (const code of ["ม63", "ม32", "ม35", "ม31", "ม33", "ม34"]) {
        expect(resolveProductCode(code)).not.toBe(kaeoKhamin);
      }
    });
  });

  it("no alias silently folds มะม่วงแก้วขมิ้น into another mango", () => {
    // PRODUCT_ALIASES (src/lib/summary/remaining-fruit.ts) affects business
    // identity, not just report labels, and no repository or operator
    // evidence supports folding มะม่วงแก้วขมิ้น into any other mango — so this
    // migration deliberately adds none. This dictionary layer has no fuzzy
    // matching of its own: resolveProductCode is exact-code lookup only.
    expect(resolveProductCode("ม72")).toBe("มะม่วงแก้วขมิ้น");
    expect(resolveProductCode("ม72")).not.toBe(resolveProductCode("ม63")); // มะม่วงจิ้ว
    expect(resolveProductCode("ม72")).not.toBe(resolveProductCode("ม35")); // มหาชนก
  });

  it("no product code collision — ม72 appears exactly once in the full set", () => {
    const codes = PRODUCT_CODE_ENTRIES.map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.filter((c) => c === "ม72")).toHaveLength(1);
  });

  it("no pre-existing code changed by this extension", () => {
    expect(resolveProductCode("ม01")).toBe("กล้วยไข่");
    expect(resolveProductCode("ม54")).toBe("ไซมัส");
    expect(resolveProductCode("ม62")).toBe("แอปเปิ้ล");
    expect(resolveProductCode("ม71")).toBe("ลิ้นจี่");
  });

  it("the composed migration-parity check still holds with the new INSERT block", () => {
    // migrationRows() replays every migration file's own VALUES block in
    // order, including 20260824090000, and must still equal the approved CSV
    // — proving the PostgreSQL-side representation (what a real database
    // would end up with) matches the authoritative source.
    expect(migrationRows()).toEqual(csvRows());
  });
});

describe("dictionary extension 20260827090000 — ม73 (มะม่วงฟ้าลั่น)", () => {
  it("ม73 → มะม่วงฟ้าลั่น", () => {
    expect(resolveProductCode("ม73")).toBe("มะม่วงฟ้าลั่น");
  });

  describe("independence — a distinct mango, not a merge of an existing one", () => {
    it("the other mango codes it must never be confused with keep their own identities", () => {
      expect(resolveProductCode("ม72")).toBe("มะม่วงแก้วขมิ้น");
      expect(resolveProductCode("ม63")).toBe("มะม่วงจิ้ว");
      expect(resolveProductCode("ม32")).toBe("มะม่วงงาช้าง");
      expect(resolveProductCode("ม35")).toBe("มหาชนก");
      expect(resolveProductCode("ม31")).toBe("มะม่วงเขียวมรกต");
      expect(resolveProductCode("ม33")).toBe("มะม่วงน้ำดอกไม้");
    });

    it("ม73 resolves to a name distinct from every other mango code", () => {
      const fahLan = resolveProductCode("ม73");
      for (const code of ["ม72", "ม63", "ม32", "ม35", "ม31", "ม33", "ม34"]) {
        expect(resolveProductCode(code)).not.toBe(fahLan);
      }
    });
  });

  it("no alias silently folds มะม่วงฟ้าลั่น into another mango", () => {
    // PRODUCT_ALIASES (src/lib/summary/remaining-fruit.ts) affects business
    // identity, not just report labels. Short forms ฟ้าลั่น and มะม่วง would
    // collide with other products, and no operator evidence supports folding
    // มะม่วงฟ้าลั่น into any other mango — so this migration adds none.
    expect(resolveProductCode("ม73")).toBe("มะม่วงฟ้าลั่น");
    expect(resolveProductCode("ม73")).not.toBe(resolveProductCode("ม72")); // มะม่วงแก้วขมิ้น
    expect(resolveProductCode("ม73")).not.toBe(resolveProductCode("ม63")); // มะม่วงจิ้ว
    expect(resolveProductCode("ม73")).not.toBe(resolveProductCode("ม35")); // มหาชนก
  });

  it("no product code collision — ม73 appears exactly once in the full set", () => {
    const codes = PRODUCT_CODE_ENTRIES.map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.filter((c) => c === "ม73")).toHaveLength(1);
    expect(codes.filter((c) => c === "ม72")).toHaveLength(1);
  });

  it("no pre-existing code changed by this extension", () => {
    expect(resolveProductCode("ม01")).toBe("กล้วยไข่");
    expect(resolveProductCode("ม54")).toBe("ไซมัส");
    expect(resolveProductCode("ม62")).toBe("แอปเปิ้ล");
    expect(resolveProductCode("ม71")).toBe("ลิ้นจี่");
    expect(resolveProductCode("ม72")).toBe("มะม่วงแก้วขมิ้น");
  });

  it("the composed migration-parity check still holds with the new INSERT block", () => {
    expect(migrationRows()).toEqual(csvRows());
  });
});

describe("dictionary extension 20260901093000 — ม74 (พุทราจีน)", () => {
  it("ม74 → พุทราจีน", () => {
    expect(resolveProductCode("ม74")).toBe("พุทราจีน");
  });

  describe("independence — a distinct jujube, not a merge of an existing one", () => {
    it("the four existing jujube codes keep their own identities", () => {
      expect(resolveProductCode("ม25")).toBe("พุทรา");
      expect(resolveProductCode("ม26")).toBe("พุทราไทย");
      expect(resolveProductCode("ม27")).toBe("พุทรานม");
      expect(resolveProductCode("ม28")).toBe("พุทรานมสด");
    });

    it("ม74 resolves to a name distinct from every other jujube code", () => {
      const chineseJujube = resolveProductCode("ม74");
      for (const code of ["ม25", "ม26", "ม27", "ม28"]) {
        expect(resolveProductCode(code)).not.toBe(chineseJujube);
      }
    });
  });

  it("no alias silently folds พุทราจีน into another jujube", () => {
    // PRODUCT_ALIASES (src/lib/summary/remaining-fruit.ts) folds business
    // identity, not just report labels, so an alias there would merge this
    // product's stock and money with a different one. The short form พุทรา
    // would collide with ม25 outright.
    expect(resolveProductCode("ม74")).not.toBe(resolveProductCode("ม25")); // พุทรา
    expect(resolveProductCode("ม74")).not.toBe(resolveProductCode("ม26")); // พุทราไทย
    expect(resolveProductCode("ม74")).not.toBe(resolveProductCode("ม27")); // พุทรานม
    expect(resolveProductCode("ม74")).not.toBe(resolveProductCode("ม28")); // พุทรานมสด
  });

  it("no product code collision — ม74 appears exactly once in the full set", () => {
    const codes = PRODUCT_CODE_ENTRIES.map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.filter((c) => c === "ม74")).toHaveLength(1);
    expect(codes.filter((c) => c === "ม73")).toHaveLength(1);
  });

  it("ม74 was issued as the next code past ม73, not a reuse", () => {
    const mCodes = PRODUCT_CODE_ENTRIES
      .filter((e) => e.categoryCode === "ม")
      .map((e) => Number(e.code.slice(1)))
      .sort((a, b) => a - b);
    // The ม range has since been extended past ม74, so this asserts the
    // property that mattered when ม74 landed rather than pinning the max:
    // ม74 exists, and the range stays a gap-free 1..N. A gap would mean a
    // code was retired and ม74 should have reused it instead of extending.
    expect(mCodes).toContain(74);
    expect(mCodes).toEqual(Array.from({ length: mCodes.length }, (_, i) => i + 1));
  });

  it("no pre-existing code changed by this extension", () => {
    expect(resolveProductCode("ม01")).toBe("กล้วยไข่");
    expect(resolveProductCode("ม54")).toBe("ไซมัส");
    expect(resolveProductCode("ม62")).toBe("แอปเปิ้ล");
    expect(resolveProductCode("ม71")).toBe("ลิ้นจี่");
    expect(resolveProductCode("ม72")).toBe("มะม่วงแก้วขมิ้น");
    expect(resolveProductCode("ม73")).toBe("มะม่วงฟ้าลั่น");
  });

  it("the composed migration-parity check still holds with the new INSERT block", () => {
    expect(migrationRows()).toEqual(csvRows());
  });
});

describe("dictionary extension 20260908090000 — ม75–ม80 (six distinct ผลไม้)", () => {
  const NEW_CODES: Array<[string, string]> = [
    ["ม75", "มันแกว"],
    ["ม76", "องุ่นไร้ออส"],
    ["ม77", "แอปเปิ้ลแคระ"],
    ["ม78", "เมล่อนกล่อง"],
    ["ม79", "องุ่นลิ้นจี่"],
    ["ม80", "องุ่นจักรพรรดิ์"],
  ];

  for (const [code, canonicalName] of NEW_CODES) {
    it(`${code} → ${canonicalName}`, () => {
      expect(resolveProductCode(code)).toBe(canonicalName);
    });
  }

  describe("independence — six distinct products, not a merge of a lookalike", () => {
    it("the near-neighbour codes they must never fold into keep their own identities", () => {
      expect(resolveProductCode("ม62")).toBe("แอปเปิ้ล"); // vs ม77 แอปเปิ้ลแคระ
      expect(resolveProductCode("ม58")).toBe("องุ่นไร้เม็ด"); // vs ม76 องุ่นไร้ออส
      expect(resolveProductCode("ม71")).toBe("ลิ้นจี่"); // vs ม79 องุ่นลิ้นจี่
    });

    it("each new code resolves to a name distinct from its near neighbour", () => {
      expect(resolveProductCode("ม77")).not.toBe(resolveProductCode("ม62"));
      expect(resolveProductCode("ม76")).not.toBe(resolveProductCode("ม58"));
      expect(resolveProductCode("ม79")).not.toBe(resolveProductCode("ม71"));
    });

    it("the six resolve to six distinct canonical names", () => {
      const names = NEW_CODES.map(([code]) => resolveProductCode(code));
      expect(new Set(names).size).toBe(6);
      expect(names.every((name) => name !== null)).toBe(true);
    });
  });

  it("no product code collision — ม75–ม80 each appear exactly once in the full set", () => {
    const codes = PRODUCT_CODE_ENTRIES.map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const [code] of NEW_CODES) {
      expect(codes.filter((c) => c === code)).toHaveLength(1);
    }
  });

  it("ม75–ม80 are the next unused codes — contiguous 1..80, no reuse", () => {
    const mCodes = PRODUCT_CODE_ENTRIES
      .filter((e) => e.categoryCode === "ม")
      .map((e) => Number(e.code.slice(1)))
      .sort((a, b) => a - b);
    expect(mCodes).toHaveLength(80);
    expect(mCodes).toEqual(Array.from({ length: 80 }, (_, i) => i + 1));
  });

  it("no pre-existing code changed by this extension", () => {
    expect(resolveProductCode("ม01")).toBe("กล้วยไข่");
    expect(resolveProductCode("ม54")).toBe("ไซมัส");
    expect(resolveProductCode("ม68")).toBe("องุ่นคิมสัน");
    expect(resolveProductCode("ม74")).toBe("พุทราจีน");
  });

  it("the composed migration-parity check still holds with the new INSERT block", () => {
    expect(migrationRows()).toEqual(csvRows());
  });
});

describe("dictionary extension 20260908090000 — ม75–ม80 (unclassified fruit)", () => {
  const NEW_CODES: Array<[string, string]> = [
    ["ม75", "มันแกว"],
    ["ม76", "องุ่นไร้ออส"],
    ["ม77", "แอปเปิ้ลแคระ"],
    ["ม78", "เมล่อนกล่อง"],
    ["ม79", "องุ่นลิ้นจี่"],
    ["ม80", "องุ่นจักรพรรดิ์"],
  ];

  for (const [code, canonicalName] of NEW_CODES) {
    it(`${code} → ${canonicalName}`, () => {
      expect(resolveProductCode(code)).toBe(canonicalName);
    });
  }

  describe("independence — distinct products, not a merge of a lookalike code", () => {
    it("the near-neighbour codes keep their own identities", () => {
      expect(resolveProductCode("ม62")).toBe("แอปเปิ้ล");
      expect(resolveProductCode("ม58")).toBe("องุ่นไร้เม็ด");
      expect(resolveProductCode("ม71")).toBe("ลิ้นจี่");
      expect(resolveProductCode("ม68")).toBe("องุ่นคิมสัน");
    });

    it("each new code resolves to a name distinct from its lookalike", () => {
      expect(resolveProductCode("ม77")).not.toBe(resolveProductCode("ม62")); // แอปเปิ้ลแคระ !== แอปเปิ้ล
      expect(resolveProductCode("ม76")).not.toBe(resolveProductCode("ม58")); // องุ่นไร้ออส !== องุ่นไร้เม็ด
      expect(resolveProductCode("ม79")).not.toBe(resolveProductCode("ม71")); // องุ่นลิ้นจี่ !== ลิ้นจี่
    });
  });

  it("no product code collision — ม75–ม80 each appear exactly once in the full set", () => {
    const codes = PRODUCT_CODE_ENTRIES.map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of ["ม75", "ม76", "ม77", "ม78", "ม79", "ม80"]) {
      expect(codes.filter((c) => c === code)).toHaveLength(1);
    }
  });

  it("ม75–ม80 are the next unused codes, a contiguous 1..80, not a reuse", () => {
    const mCodes = PRODUCT_CODE_ENTRIES
      .filter((e) => e.categoryCode === "ม")
      .map((e) => Number(e.code.slice(1)))
      .sort((a, b) => a - b);
    expect(mCodes).toHaveLength(80);
    expect(mCodes[mCodes.length - 1]).toBe(80);
    // A gap would mean a code was retired and one of these should have reused it
    // instead of extending the range.
    expect(mCodes).toEqual(Array.from({ length: 80 }, (_, i) => i + 1));
  });

  it("no pre-existing code changed by this extension", () => {
    expect(resolveProductCode("ม01")).toBe("กล้วยไข่");
    expect(resolveProductCode("ม54")).toBe("ไซมัส");
    expect(resolveProductCode("ม62")).toBe("แอปเปิ้ล");
    expect(resolveProductCode("ม71")).toBe("ลิ้นจี่");
    expect(resolveProductCode("ม73")).toBe("มะม่วงฟ้าลั่น");
    expect(resolveProductCode("ม74")).toBe("พุทราจีน");
  });

  it("the composed migration-parity check still holds with the new INSERT block", () => {
    expect(migrationRows()).toEqual(csvRows());
  });
});
