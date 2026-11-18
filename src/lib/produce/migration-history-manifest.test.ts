import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const MANIFEST = join(ROOT, "supabase", "migration-history-manifest.json");

type LedgerDrift = {
  file: string;
  applied_version: string;
  applied_name: string;
  note: string;
};
type MigrationManifest = {
  source: string;
  production_ledger_max_version: string;
  production_ledger_max_version_note: string;
  migrations: string[];
  production_ledger_drift: LedgerDrift[];
};

/**
 * HISTORICAL_PRODUCTION_BASELINE = the migrations recorded in Production's
 * supabase_migrations.schema_migrations ledger. These are immutable: Production
 * has already run them, so their filenames and SQL must never change and their
 * versions must never be reused.
 *
 * PENDING_FORWARD_MIGRATIONS = migrations that exist in the repository but have
 * not been applied to Production yet. They are legitimate, not drift — but they
 * must sort strictly after PRODUCTION_LEDGER_MAX_VERSION so they can never
 * collide with, or silently sort before, an already-applied migration.
 *
 * The forward cutoff is the PRODUCTION LEDGER max, NOT the largest historical
 * repository filename. The two are not the same number: Production applied
 * 20260829090000_produce_pending_inactivity_lifecycle.sql under ledger version
 * 20260831045503 (see production_ledger_drift). A file such as
 * 20260901120000_x.sql sorts after the filename baseline but BEFORE the real
 * ledger max, so it would be ordered behind a migration Production has already
 * run. Only the ledger max is a safe forward boundary.
 */
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as MigrationManifest;
const HISTORICAL = [...manifest.migrations].sort();
const PRODUCTION_LEDGER_MAX_VERSION = manifest.production_ledger_max_version;
const HISTORICAL_FILENAME_CUTOFF = HISTORICAL[HISTORICAL.length - 1].split("_")[0];

function repoMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

// Version is the filename prefix before the first underscore: "0001" or
// "20260829090000". All are digit-only, so lexicographic order equals
// chronological order (any 4-digit legacy version sorts before any 14-digit
// timestamp version).
function versionOf(filename: string): string {
  return filename.split("_")[0];
}

// A candidate migration is forward-safe only if it sorts after everything
// Production has already applied.
function isForwardOfProduction(filename: string): boolean {
  return versionOf(filename) > PRODUCTION_LEDGER_MAX_VERSION;
}

const repoFiles = repoMigrationFiles();
const historicalSet = new Set(HISTORICAL);
const pendingForward = repoFiles.filter((file) => !historicalSet.has(file));

describe("Production migration-history baseline", () => {
  it("is exactly the 99 migrations in the recorded 2026-09-03 audit", () => {
    expect(HISTORICAL).toHaveLength(99);
    expect(new Set(HISTORICAL).size).toBe(99);
  });

  it("still exists in the repository under its exact reconciled filenames", () => {
    const present = repoFiles.filter((file) => historicalSet.has(file));
    expect(present).toEqual(HISTORICAL);
  });

  it("has one unique version per historical migration", () => {
    const versions = HISTORICAL.map(versionOf);
    expect(new Set(versions).size).toBe(HISTORICAL.length);
    expect(versions.every((version) => /^\d+$/.test(version))).toBe(true);
  });

  it("has no stale alternate filename for any historical version", () => {
    // A historical version may appear exactly once across the whole migrations
    // directory. A second file carrying the same version is a leftover
    // pre-reconciliation alias and would make Production history ambiguous.
    const byVersion = new Map<string, string[]>();
    for (const file of repoFiles) {
      const version = versionOf(file);
      byVersion.set(version, [...(byVersion.get(version) ?? []), file]);
    }

    const duplicated = [...byVersion.entries()].filter(([, files]) => files.length > 1);
    expect(duplicated).toEqual([]);

    for (const historical of HISTORICAL) {
      expect(byVersion.get(versionOf(historical))).toEqual([historical]);
    }
  });

  it("includes the applied #108 inactivity lifecycle migration", () => {
    expect(HISTORICAL).toContain("20260829090000_produce_pending_inactivity_lifecycle.sql");
    expect(HISTORICAL_FILENAME_CUTOFF).toBe("20260901093000");
    expect(HISTORICAL.slice(-3)).toEqual([
      "20260831120000_produce_close_validation_race.sql",
      "20260901090000_produce_finalizer_review_presentation.sql",
      "20260901093000_produce_product_dictionary_add_chinese_jujube.sql",
    ]);
  });
});

describe("Production ledger version drift", () => {
  // Production's ledger version for a migration normally equals the repository
  // filename prefix. The Supabase apply_migration operation stamps its own
  // version from the apply time instead, so four entries diverge. Production
  // history is authoritative and must never be hand-edited to match the
  // filename, so the divergence is recorded in the manifest.
  //
  // Scope of this regression, stated honestly: CI never queries Production, so
  // it CANNOT discover a new divergence on its own. What it does is pin the
  // recorded facts, so the manifest cannot be edited — or a drifting migration
  // reclassified — without a deliberate, reviewed change to this file. Learning
  // that Production drifted again still requires a human read-only audit.
  it("pins the recorded drift so the manifest cannot be edited unreviewed", () => {
    expect(manifest.production_ledger_drift).toEqual([
      {
        file: "20260829090000_produce_pending_inactivity_lifecycle.sql",
        applied_version: "20260831045503",
        applied_name: "produce_pending_inactivity_lifecycle",
        note: expect.any(String),
      },
      {
        file: "20260831120000_produce_close_validation_race.sql",
        applied_version: "20260901084806",
        applied_name: "produce_close_validation_race",
        note: expect.any(String),
      },
      {
        file: "20260901090000_produce_finalizer_review_presentation.sql",
        applied_version: "20260901084830",
        applied_name: "produce_finalizer_review_presentation",
        note: expect.any(String),
      },
      {
        file: "20260901093000_produce_product_dictionary_add_chinese_jujube.sql",
        applied_version: "20260902042836",
        applied_name: "produce_product_dictionary_add_chinese_jujube",
        note: expect.any(String),
      },
    ]);
  });

  it("only ever documents drift for a migration that is in the baseline", () => {
    for (const drift of manifest.production_ledger_drift) {
      expect(HISTORICAL).toContain(drift.file);
      expect(drift.applied_name).toBe(drift.file.replace(/^\d+_/, "").replace(/\.sql$/, ""));
      expect(/^\d+$/.test(drift.applied_version)).toBe(true);
    }
  });

  it("records a ledger max that covers every applied version, drifted or not", () => {
    expect(PRODUCTION_LEDGER_MAX_VERSION).toBe("20260902042836");
    expect(/^\d+$/.test(PRODUCTION_LEDGER_MAX_VERSION)).toBe(true);
    // The ledger max must be at least the largest historical filename,
    // otherwise the manifest is internally inconsistent.
    expect(PRODUCTION_LEDGER_MAX_VERSION >= HISTORICAL_FILENAME_CUTOFF).toBe(true);
    // And at least every recorded drifted applied_version.
    for (const drift of manifest.production_ledger_drift) {
      expect(PRODUCTION_LEDGER_MAX_VERSION >= drift.applied_version).toBe(true);
    }
  });
});

describe("Pending forward migrations", () => {
  it("are allowed, and are exactly the repo files outside the audited baseline", () => {
    // Every repo migration is either historical or pending-forward; nothing else
    // is possible, and a forward migration must never remove a historical one.
    expect([...pendingForward, ...HISTORICAL].sort()).toEqual(repoFiles);
  });

  it("all sort strictly after the Production ledger max", () => {
    for (const file of pendingForward) {
      expect(isForwardOfProduction(file)).toBe(true);
    }
  });

  // Deliberately NOT asserted: that pendingForward is empty. Production is
  // level with the repository today, but pinning that would make the suite fail
  // the moment someone adds a legitimate new forward migration — the exact thing
  // this classification exists to permit.

  it("rejects a file that clears the filename cutoff but not the ledger max", () => {
    // The exact hazard the ledger-max cutoff exists to catch: 20260901120000
    // sorts AFTER the largest historical filename (20260901093000) yet BEFORE
    // the version Production actually recorded (20260902042836), so it would be
    // ordered behind an already-applied migration.
    const backdated = "20260901120000_backdated_after_filename_but_before_ledger.sql";
    expect(versionOf(backdated) > HISTORICAL_FILENAME_CUTOFF).toBe(true);
    expect(isForwardOfProduction(backdated)).toBe(false);
  });

  it("accepts a genuine future migration above the ledger max", () => {
    expect(isForwardOfProduction("20260903000000_true_forward.sql")).toBe(true);
    expect(isForwardOfProduction("20270101000000_future_forward.sql")).toBe(true);
  });

  it("do not invalidate historical reconciliation when more are added", () => {
    // Simulate a future forward migration: the historical baseline assertions
    // must still hold unchanged.
    const withFutureForward = [...repoFiles, "20270101000000_future_forward.sql"].sort();
    const stillHistorical = withFutureForward.filter((file) => historicalSet.has(file));
    expect(stillHistorical).toEqual(HISTORICAL);
    expect(stillHistorical).toHaveLength(99);
  });
});
