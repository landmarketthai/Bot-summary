/**
 * The reviewed market registry has ONE source of truth, in two places.
 *
 * Postgres resolves market identity from `line_guided_menu_markets` /
 * `line_guided_menu_market_aliases`; the duplicate fingerprint resolves it from
 * `REVIEWED_MARKET_ALIASES`, because a hash input cannot depend on a database
 * round-trip. If those two ever disagree, an alias binds one round in SQL and
 * fingerprints as a different document in TypeScript — which is the exact class
 * of bug this phase exists to remove.
 *
 * So: parse the catalog migrations, and fail if the mirror has drifted.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REVIEWED_MARKET_ALIASES, REVIEWED_MARKET_LABELS } from "./market";

const MIGRATIONS = join(import.meta.dir, "..", "..", "supabase", "migrations");

function read(file: string): string {
  return readFileSync(join(MIGRATIONS, file), "utf8");
}

/** `('อ้างอิง', 'market_code', true)` rows out of a VALUES / INSERT block. */
function tuples(sql: string, block: RegExp): Array<[string, string]> {
  const section = sql.match(block)?.[0] ?? "";
  const rows: Array<[string, string]> = [];
  for (const match of section.matchAll(/\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*true\s*\)/g)) {
    rows.push([match[1], match[2]]);
  }
  return rows;
}

const CATALOG_0055 = read("20260730090006_guided_menu_seller_market_catalog.sql");
const GUARD = read("20260815213206_produce_market_identity_guard.sql");
const PASEO_VEGETABLE = read("20260930090100_paseo_vegetable_market_aliases.sql");

/** market_code -> canonical label, from both migrations. */
const seededMarkets = new Map<string, string>([
  ...tuples(CATALOG_0055, /INSERT INTO _gm55_markets VALUES[\s\S]*?;/).map(
    ([code, label]) => [code, label] as [string, string],
  ),
  ...tuples(GUARD, /INSERT INTO public\.line_guided_menu_markets[\s\S]*?;/).map(
    ([code, label]) => [code, label] as [string, string],
  ),
]);

/** alias label -> canonical label, from both migrations. */
const seededAliases = new Map<string, string>(
  [
    ...tuples(CATALOG_0055, /INSERT INTO _gm55_market_aliases VALUES[\s\S]*?;/),
    ...tuples(GUARD, /INSERT INTO public\.line_guided_menu_market_aliases[\s\S]*?;/),
    ...tuples(PASEO_VEGETABLE, /INSERT INTO public\.line_guided_menu_market_aliases[\s\S]*?;/),
  ].map(([alias, code]) => {
    const label = seededMarkets.get(code);
    if (!label) throw new Error(`alias ${alias} references unseeded market ${code}`);
    return [alias, label] as [string, string];
  }),
);

describe("reviewed market registry", () => {
  test("the migrations actually seed what this test thinks they do", () => {
    // A parse that silently matched nothing would make every assertion vacuous.
    expect(seededMarkets.size).toBeGreaterThanOrEqual(13);
    expect(seededAliases.size).toBeGreaterThanOrEqual(25);
    expect(seededMarkets.get("paseo")).toBe("พาซิโอ้");
    expect(seededAliases.get("พาซีโอ้")).toBe("พาซิโอ้");
    expect(seededAliases.get("พาสิโอ้")).toBe("พาซิโอ้");
    // The 0055 alias this phase must preserve.
    expect(seededAliases.get("ทุ่งลานนา")).toBe("วัดทุ่งลานนา");
  });

  test("the TypeScript alias mirror matches the seeded catalog exactly", () => {
    expect(Object.fromEntries([...seededAliases].sort()))
      .toEqual(Object.fromEntries([...Object.entries(REVIEWED_MARKET_ALIASES)].sort()));
  });

  test("the TypeScript canonical label list matches the seeded markets exactly", () => {
    expect([...REVIEWED_MARKET_LABELS].sort())
      .toEqual([...seededMarkets.values()].sort());
  });

  test("the guard migration adds no market alias beyond the reviewed two", () => {
    // Reviewed means reviewed. A future edit that slips an extra alias into the
    // migration has to change this number and be seen doing it.
    expect(tuples(GUARD, /INSERT INTO public\.line_guided_menu_market_aliases[\s\S]*?;/))
      .toEqual([
        ["พาซีโอ้", "paseo"],
        ["พาสิโอ้", "paseo"],
      ]);
  });

  test("the vegetable-market migration adds only contiguous ผัก spellings", () => {
    expect(tuples(PASEO_VEGETABLE, /INSERT INTO public\.line_guided_menu_market_aliases[\s\S]*?;/))
      .toEqual([
        ["พาซีโอ้ผัก", "paseo_vegetable"],
        ["ตลาดพาซิโอ้ผัก", "paseo_vegetable"],
      ]);
    expect(seededMarkets.get("paseo_vegetable")).toBe("พาซิโอ้ผัก");
  });
});
