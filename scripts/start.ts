import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

try {
  execSync("bunx prisma migrate deploy", { stdio: "inherit" });
} catch (err) {
  console.error("❌ Migration failed:", err);
  process.exit(1);
}

try {
  const userCount = await prisma.user.count();
  if (userCount === 0) {
    console.log("🌱 Database is empty, running canonical seed...");
    execSync("bun prisma/seed.ts", { stdio: "inherit" });
  }
} finally {
  await prisma.$disconnect();
}

await import("../src/index");
