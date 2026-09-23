import { describe, expect, test } from "bun:test";
import {
  isIsoDate,
  parseStockSummaryTargets,
  previousBangkokBusinessDate,
  purchasePlanningRetryKey,
  resolveStockSummaryDate,
  stockSummaryPdfRetryKey,
  stockSummaryRetryKey,
} from "./daily-stock-cron";

/** Bangkok is UTC+7 with no DST, so a fixed offset is exact here. */
function bangkok(iso: string): number {
  return new Date(`${iso}+07:00`).getTime();
}

describe("previousBangkokBusinessDate", () => {
  test("08:00 Bangkok reports the day that just closed", () => {
    expect(previousBangkokBusinessDate(bangkok("2026-07-26T08:00:00"))).toBe("2026-07-25");
    expect(previousBangkokBusinessDate(bangkok("2026-07-27T08:00:00"))).toBe("2026-07-26");
  });

  test("is derived from the 04:00 business cutoff, not the calendar date", () => {
    // 03:59 still belongs to the previous business day, so the report shifts too.
    expect(previousBangkokBusinessDate(bangkok("2026-07-26T03:59:00"))).toBe("2026-07-24");
    // 04:00 rolls the business day over.
    expect(previousBangkokBusinessDate(bangkok("2026-07-26T04:00:00"))).toBe("2026-07-25");
    expect(previousBangkokBusinessDate(bangkok("2026-07-26T23:59:00"))).toBe("2026-07-25");
  });

  test("crosses month and year boundaries", () => {
    expect(previousBangkokBusinessDate(bangkok("2026-08-01T08:00:00"))).toBe("2026-07-31");
    expect(previousBangkokBusinessDate(bangkok("2026-03-01T08:00:00"))).toBe("2026-02-28");
    expect(previousBangkokBusinessDate(bangkok("2027-01-01T08:00:00"))).toBe("2026-12-31");
  });

  test("handles a leap day", () => {
    expect(previousBangkokBusinessDate(bangkok("2028-03-01T08:00:00"))).toBe("2028-02-29");
  });

  test("the whole 08:00 hour resolves to one date, so the scheduler is retry-safe", () => {
    const dates = new Set(
      ["08:00:00", "08:00:30", "08:05:00", "08:30:00", "08:59:59"].map((t) =>
        previousBangkokBusinessDate(bangkok(`2026-07-26T${t}`)),
      ),
    );
    expect([...dates]).toEqual(["2026-07-25"]);
  });
});

describe("resolveStockSummaryDate", () => {
  test("a scheduled run (no date param) reports the previous business date", () => {
    expect(resolveStockSummaryDate(null, bangkok("2026-07-26T08:00:00"))).toBe("2026-07-25");
    expect(resolveStockSummaryDate(null, bangkok("2026-07-27T08:00:00"))).toBe("2026-07-26");
  });

  test("an explicit ISO date is used verbatim and never shifted backwards", () => {
    expect(resolveStockSummaryDate("2026-07-25", bangkok("2026-07-26T08:00:00"))).toBe("2026-07-25");
    expect(resolveStockSummaryDate("2026-07-26", bangkok("2026-07-26T08:00:00"))).toBe("2026-07-26");
    // Even a far-off backfill date stays exactly as requested.
    expect(resolveStockSummaryDate("2026-01-01", bangkok("2026-07-26T08:00:00"))).toBe("2026-01-01");
  });

  test("a malformed date param falls back to the scheduled semantics", () => {
    expect(resolveStockSummaryDate("25/07/2569", bangkok("2026-07-26T08:00:00"))).toBe("2026-07-25");
    expect(resolveStockSummaryDate("", bangkok("2026-07-26T08:00:00"))).toBe("2026-07-25");
  });

  test("isIsoDate accepts only YYYY-MM-DD", () => {
    expect(isIsoDate("2026-07-25")).toBe(true);
    expect(isIsoDate("2026-7-25")).toBe(false);
    expect(isIsoDate("25/07/2569")).toBe(false);
  });
});

describe("stockSummaryRetryKey", () => {
  test("is deterministic for the same date, target and part", () => {
    const a = stockSummaryRetryKey("2026-07-25", "Cabc", 0);
    const b = stockSummaryRetryKey("2026-07-25", "Cabc", 0);
    expect(a).toBe(b);
  });

  test("differs by date, by target and by message part", () => {
    const base = stockSummaryRetryKey("2026-07-25", "Cabc", 0);
    expect(stockSummaryRetryKey("2026-07-26", "Cabc", 0)).not.toBe(base);
    expect(stockSummaryRetryKey("2026-07-25", "Cxyz", 0)).not.toBe(base);
    expect(stockSummaryRetryKey("2026-07-25", "Cabc", 1)).not.toBe(base);
  });

  test("is a well-formed RFC 4122 UUID", () => {
    expect(stockSummaryRetryKey("2026-07-25", "Cabc", 0)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("does not collide with the existing daily-summary key namespace", async () => {
    const { dailySummaryRetryKey } = await import("@/lib/line/daily-summary-cron");
    expect(stockSummaryRetryKey("2026-07-25", "Cabc", 0)).not.toBe(
      dailySummaryRetryKey("2026-07-25", "Cabc"),
    );
  });

  test("the scheduled PDF has its own deterministic retry namespace", () => {
    const pdf = stockSummaryPdfRetryKey("2026-07-25", "Cabc");
    expect(pdf).toBe(stockSummaryPdfRetryKey("2026-07-25", "Cabc"));
    expect(pdf).not.toBe(stockSummaryRetryKey("2026-07-25", "Cabc", 0));
    expect(pdf).not.toBe(stockSummaryPdfRetryKey("2026-07-26", "Cabc"));
  });
});

describe("purchasePlanningRetryKey", () => {
  test("is a stable LINE UUID separated by date, target, chunk and report", () => {
    const base = purchasePlanningRetryKey("2026-08-22", "Coperator", 0);
    expect(base).toBe(purchasePlanningRetryKey("2026-08-22", "Coperator", 0));
    expect(base).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(base).not.toBe(purchasePlanningRetryKey("2026-08-23", "Coperator", 0));
    expect(base).not.toBe(purchasePlanningRetryKey("2026-08-22", "Cother", 0));
    expect(base).not.toBe(purchasePlanningRetryKey("2026-08-22", "Coperator", 1));
    expect(base).not.toBe(stockSummaryRetryKey("2026-08-22", "Coperator", 0));
  });
});

describe("parseStockSummaryTargets", () => {
  test("returns no targets when unset or blank — delivery stays inactive", () => {
    expect(parseStockSummaryTargets(undefined)).toEqual([]);
    expect(parseStockSummaryTargets("")).toEqual([]);
    expect(parseStockSummaryTargets("   ")).toEqual([]);
    expect(parseStockSummaryTargets(",,")).toEqual([]);
  });

  test("splits on commas and whitespace and drops duplicates", () => {
    expect(parseStockSummaryTargets("Cabc, Cxyz")).toEqual(["Cabc", "Cxyz"]);
    expect(parseStockSummaryTargets("Cabc\nCxyz")).toEqual(["Cabc", "Cxyz"]);
    expect(parseStockSummaryTargets("Cabc,Cabc,Cxyz")).toEqual(["Cabc", "Cxyz"]);
  });
});

describe("scheduler configuration", () => {
  test("the daily-stock-summary GitHub Actions workflow is manual-only (Supabase Cron owns schedule)", async () => {
    const yaml = await Bun.file(
      `${import.meta.dir}/../../../.github/workflows/daily-stock-summary.yml`,
    ).text();

    // Automatic 08:00 Asia/Bangkok scheduling is owned by Supabase Cron.
    // GitHub keeps workflow_dispatch for manual / debug / emergency only.
    expect(yaml).toContain("workflow_dispatch:");
    expect(yaml).not.toMatch(/^\s*schedule:/m);
    expect(yaml).not.toMatch(/^\s*- cron:/m);
    expect(yaml).toContain("Supabase Cron");
    expect(yaml).toContain("/api/cron/daily-stock-summary");
    expect(yaml).toContain("Authorization: Bearer ${{ secrets.CRON_SECRET }}");
    // The report date must come from the route's own resolution, not the caller.
    expect(yaml).not.toContain("date=2026");
  });

  test("daily-stock-summary is NOT a vercel.json cron (Hobby plan firing is approximate)", async () => {
    const file = await import("../../../vercel.json", { with: { type: "json" } });
    const config = file.default as { crons?: Array<{ path: string; schedule: string }> };
    expect(config.crons?.find((c) => c.path === "/api/cron/daily-stock-summary")).toBeUndefined();
  });
});
