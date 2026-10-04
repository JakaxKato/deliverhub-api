import { execFileSync } from "node:child_process";
import { env } from "../src/config/env";

// Validate configuration before any migration or database side effect.
try {
  execFileSync(process.execPath, ["run", "db:migrate"], { stdio: "inherit" });
} catch (error) {
  console.error("Database migration failed; refusing to start:", error);
  process.exit(1);
}

// Seeding is a separate, explicit operator action in every environment.
const { app } = await import("../src/index");
Bun.serve({ port: env.PORT, fetch: app.fetch });
console.log(`NodeWave Backend Engine listening on port ${env.PORT}`);
