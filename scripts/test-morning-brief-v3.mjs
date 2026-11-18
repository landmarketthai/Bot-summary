// Separate Bun processes prevent mock.module contamination between suites.
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

export function passedWithoutSkips(output) {
  return /\b[1-9]\d* pass\b/.test(output)
    && /\b0 fail\b/.test(output)
    && !/\b[1-9]\d* skip\b|\(skip\)/i.test(output);
}

const suites = {
  summary: [
    "src/lib/summary/morning-brief-v3.test.ts", "src/lib/summary/morning-brief-scope.test.ts",
    "src/lib/summary/morning-brief-service.test.ts", "src/lib/summary/morning-brief-pdf.test.tsx",
    "src/lib/summary/morning-brief.test.ts", "src/lib/summary/morning-brief-message.test.ts",
    "src/lib/summary/morning-sales-integrity.test.tsx", "src/lib/summary/daily-stock-cron.test.ts",
    "src/lib/produce/migration-order.test.ts", "src/lib/produce/migration-history-manifest.test.ts",
  ],
  route: ["src/app/api/cron/daily-morning-brief/route.test.ts"],
  line: ["src/lib/line/reply.test.ts"],
  pg: ["src/lib/summary/morning-brief-v3.pg.test.ts"],
};

const suite = process.argv[2];
if (suite === "--self-test") {
  assert(passedWithoutSkips("172 pass\n0 fail"));
  for (const output of ["0 pass\n19 skip\n0 fail", "17 pass\n1 skip\n0 fail",
    "17 pass\n0 fail\n(skip) setup", "17 pass\n1 fail", ""]) assert(!passedWithoutSkips(output));
  console.log("Bun result guard self-test passed");
} else {
  if (!Object.hasOwn(suites, suite)) throw new Error("Choose summary, route, line or pg");
  // PG launches many independent psql processes; bound each test to 30s rather
  // than Bun's 5s default, which is too short under Windows/CI process load.
  const result = spawnSync("bun", ["test", ...(suite === "pg" ? ["--timeout", "30000"] : []), ...suites[suite]], {
    encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, ...(suite === "pg" ? { REQUIRE_MORNING_BRIEF_POSTGRES: "1" } : {}) },
  });
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  process.stdout.write(output);
  if (result.error) console.error(result.error.message);
  if (result.status !== 0 || !passedWithoutSkips(output)) {
    console.error("Morning Brief gate failed: tests must execute, pass, and contain no skips.");
    process.exitCode = 1;
  }
}
