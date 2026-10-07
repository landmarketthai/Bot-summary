import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const SRC = join(ROOT, "src");
const TABLE = "white_sheet_review_turns";
const read = (path: string) => readFileSync(path, "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx|sql|json|mjs)$/u.test(name)) out.push(path);
  }
  return out;
}

describe(`${TABLE} is transient review state, never an official source`, () => {
  it("is referenced only by its own persistence module, the DB types, tests and the migration", () => {
    const allowed = new Set([
      "src/lib/white-sheet-reader/review-turns.ts",
      "src/types/database.ts",
      "src/lib/white-sheet-reader/test-review-database.ts",
    ]);
    const referencing = walk(SRC).filter((file) => read(file).includes(TABLE)).map((file) => relative(ROOT, file).replaceAll("\\", "/"));
    const unexpected = referencing.filter((file) => !allowed.has(file) && !/\.test\.tsx?$/u.test(file));
    expect(unexpected).toEqual([]);
  });
  it("is not touched by any official white-sheet, settlement, report, loader, API or dashboard code", () => {
    const official = walk(SRC).filter((file) => {
      const path = relative(ROOT, file).replaceAll("\\", "/");
      return !/\.test\.tsx?$/u.test(path) && !path.startsWith("src/lib/white-sheet-reader/")
        && !path.endsWith("src/types/database.ts");
    });
    for (const file of official) expect(read(file), file).not.toContain(TABLE);
    // No frontend route can reach it: nothing under src/app or src/components mentions it.
    expect(walk(join(SRC, "app")).concat(walk(join(SRC, "components"))).filter((file) => read(file).includes(TABLE))).toEqual([]);
  });
  it("only review-turns.ts writes to it, and only to this table", () => {
    const source = read(join(SRC, "lib", "white-sheet-reader", "review-turns.ts"));
    expect([...source.matchAll(/\.from\(([^)]*)\)/gu)].map((match) => match[1].trim())).toEqual(Array(4).fill("TABLE"));
    expect(source).toContain(`const TABLE = "${TABLE}"`);
    expect(source).not.toMatch(/\.(?:update|upsert|rpc|upload)\s*\(/u);
    for (const file of ["review-flow.ts", "reader.ts", "correction.ts", "schema.ts", "mode.ts"]) {
      const other = read(join(SRC, "lib", "white-sheet-reader", file));
      expect(other, file).not.toMatch(/\.(?:insert|update|delete|upsert|rpc|upload)\s*\(/u);
      expect(other, file).not.toMatch(/digital_white_sheet_cash_entries|settlement_|produce_sessions|produce_items|pending_sessions|white_sheet_lifecycle/u);
    }
  });
  it("the migration is the single schema change: backend-only, RLS on, no policy, append-only", () => {
    const migrations = join(ROOT, "supabase", "migrations");
    const files = readdirSync(migrations).filter((file) => read(join(migrations, file)).includes(TABLE));
    expect(files).toEqual(["20261007120000_white_sheet_review_turns.sql"]);
    const sql = read(join(migrations, files[0]));
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/u);
    expect(sql).toMatch(/REVOKE ALL ON TABLE public\.white_sheet_review_turns FROM PUBLIC, anon, authenticated/u);
    expect(sql).toMatch(/GRANT SELECT, INSERT, DELETE ON TABLE public\.white_sheet_review_turns TO service_role/u);
    expect(sql).not.toMatch(/CREATE POLICY/iu);
    expect(sql).not.toMatch(/GRANT[^;]*TO[^;]*(anon|authenticated|PUBLIC)/iu);
    expect(sql).toMatch(/BEFORE UPDATE ON public\.white_sheet_review_turns/u);
    // Only raw_messages is referenced by foreign keys; no official table is touched.
    expect([...sql.matchAll(/REFERENCES public\.([a-z_]+)/gu)].map((match) => match[1])).toEqual(Array(3).fill("raw_messages"));
    expect(sql).not.toMatch(/digital_white_sheet_cash_entries|settlement_|produce_sessions|ALTER TABLE public\.(?!white_sheet_review_turns)/u);
  });
});
