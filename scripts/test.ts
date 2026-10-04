import { fileURLToPath } from "node:url";
import { IsolationError, createIsolatedDatabase, verifyMigrationsAndSeed } from "../tests/isolation";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--verify-migrations")) {
  console.error("Usage: bun scripts/test.ts [--verify-migrations]");
  process.exitCode = 1;
} else if (args[0] === "--verify-migrations") {
  // This mode never imports Hono or the unfinished business routes.
  let database: Awaited<ReturnType<typeof createIsolatedDatabase>> | undefined;
  try {
    database = await createIsolatedDatabase();
    await verifyMigrationsAndSeed(database);
    console.log("PASS: clean isolated migrations; five seeded accounts; second seed preserves all rows.");
  } catch (error) {
    console.error(error instanceof IsolationError ? error.message : "Isolated migration/seed verification failed (details withheld to protect credentials).");
    process.exitCode = 1;
  } finally {
    try {
      await database?.close();
    } catch (error) {
      console.error(error instanceof IsolationError ? error.message : "Test-schema cleanup failed (details withheld).");
      process.exitCode = 1;
    }
  }
} else {
  // The test file itself owns isolation, so plain `bun test` is equally safe.
  const child = Bun.spawn([process.execPath, "test", "tests/business-logic.test.ts", "--timeout", "30000"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await child.exited;
}
