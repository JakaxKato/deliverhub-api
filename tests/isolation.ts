import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const backendDirectory = fileURLToPath(new URL("../", import.meta.url));
const schemaPattern = /^nodewave_test_[a-f0-9]{32}$/;

/** Only this error's deliberately credential-free messages may be displayed by the runner. */
export class IsolationError extends Error {}

/** Subprocess output can contain connection credentials; never forward it on failure. */
async function privateCommand(args: string[], label: string): Promise<void> {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: backendDirectory,
    env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: "true" },
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 90_000);
  try {
    const [code] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (timedOut) throw new IsolationError(`${label} timed out after 90 seconds (output withheld).`);
    if (code !== 0) throw new IsolationError(`${label} failed with exit code ${code} (output withheld).`);
  } finally {
    clearTimeout(timer);
  }
}

export interface IsolatedDatabase {
  readonly schema: string;
  readonly prisma: PrismaClient;
  seed(): Promise<void>;
  assertIsolated(): void;
  close(): Promise<void>;
}

/** No application module may be imported until this has replaced DATABASE_URL. */
export async function createIsolatedDatabase(): Promise<IsolatedDatabase> {
  let base: URL;
  try {
    base = new URL(process.env.DATABASE_URL ?? "");
    if (
      !["postgres:", "postgresql:"].includes(base.protocol) ||
      !base.hostname ||
      base.pathname.length < 2
    ) throw new Error();
  } catch {
    throw new IsolationError("Set DATABASE_URL to an available PostgreSQL database; its value is never logged.");
  }

  // Remove driver options that could override the schema's search path.
  base.searchParams.delete("options");
  base.searchParams.delete("schema");
  base.searchParams.set("connect_timeout", "10");
  const schema = `nodewave_test_${randomBytes(16).toString("hex")}`;
  if (!schemaPattern.test(schema)) throw new IsolationError("Invalid generated test schema.");
  const target = new URL(base);
  target.searchParams.set("schema", schema);
  const targetUrl = target.toString();
  const administration = new PrismaClient({ datasources: { db: { url: base.toString() } } });
  let created = false;
  let closed = false;
  let prisma: PrismaClient | undefined;
  const assertIsolated = () => {
    if (
      closed ||
      !created ||
      !schemaPattern.test(schema) ||
      process.env.DATABASE_URL !== targetUrl ||
      new URL(targetUrl).searchParams.get("schema") !== schema
    ) throw new IsolationError("Refusing database operation outside this process's owned test schema.");
  };
  const close = async () => {
    if (closed) return;
    // The identifier originates only from randomBytes, never from a URL or an environment marker.
    if (!schemaPattern.test(schema)) throw new IsolationError("Refusing unsafe test-schema cleanup.");
    try {
      await prisma?.$disconnect();
      if (created) {
        await administration.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
        const remaining = await administration.$queryRaw<Array<{ present: boolean }>>`
          SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = ${schema}) AS present
        `;
        if (remaining[0]?.present !== false) throw new IsolationError("Owned test schema was not removed.");
      }
      closed = true;
    } catch {
      throw new IsolationError(`Test-schema cleanup failed for ${schema}; no application schema was targeted.`);
    } finally {
      await administration.$disconnect();
    }
  };

  try {
    await administration.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    created = true;
    process.env.DATABASE_URL = targetUrl;
    process.env.NODE_ENV = "test";
    process.env.JWT_SECRET = randomBytes(48).toString("hex");
    process.env.JWT_EXPIRES_IN = "1h";
    process.env.JWT_ISSUER = "nodewave-integration";
    process.env.JWT_AUDIENCE = "nodewave-integration-client";
    process.env.CORS_ORIGIN = "http://localhost:5173";
    process.env.PORT = "4000";
    process.env.SEED_PASSWORD = `Test-${randomBytes(24).toString("hex")}`;
    process.env.ALLOW_PRODUCTION_SEED = "false";
    assertIsolated();
    await privateCommand(["x", "prisma", "migrate", "deploy", "--schema", "prisma/schema.prisma"], "Isolated migration deploy");
    prisma = new PrismaClient({ datasources: { db: { url: targetUrl } } });
    const actual = await prisma.$queryRaw<Array<{ schema: string }>>`SELECT current_schema() AS schema`;
    if (actual[0]?.schema !== schema) throw new IsolationError("Prisma did not select the isolated test schema.");
    return {
      schema,
      prisma,
      assertIsolated,
      seed: async () => {
        assertIsolated();
        // Executes the real additive main(), with its own pool disconnected on exit.
        await privateCommand(["prisma/seed.ts"], "Isolated additive seed");
      },
      close,
    };
  } catch (error) {
    await close();
    // Raw Prisma errors may echo their datasource; expose only controlled diagnostics.
    if (error instanceof IsolationError) throw error;
    throw new IsolationError("Isolated PostgreSQL setup failed. Check server availability and CREATE SCHEMA privileges; credentials are withheld.");
  }
}

export const seededEmails = [
  "pm@nodewave.id",
  "uiux@nodewave.id",
  "fe@nodewave.id",
  "be@nodewave.id",
  "client@acmecorp.com",
] as const;

async function snapshot(prisma: PrismaClient): Promise<string> {
  const rows = await Promise.all([
    prisma.user.findMany({ orderBy: { id: "asc" } }),
    prisma.project.findMany({ orderBy: { id: "asc" } }),
    prisma.projectMember.findMany({ orderBy: { id: "asc" } }),
    prisma.task.findMany({ orderBy: { id: "asc" } }),
    prisma.taskDependency.findMany({ orderBy: { id: "asc" } }),
    prisma.taskAttachment.findMany({ orderBy: { id: "asc" } }),
    prisma.auditLog.findMany({ orderBy: { id: "asc" } }),
    prisma.session.findMany({ orderBy: { jti: "asc" } }),
  ]);
  return JSON.stringify(rows);
}

/** Verifies clean migrations and that running the real seed twice never resets existing rows. */
export async function verifyMigrationsAndSeed(database: IsolatedDatabase): Promise<void> {
  database.assertIsolated();
  const prisma = database.prisma;
  const migrations = await prisma.$queryRaw<Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>>`
    SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name
  `;
  if (
    !migrations.some((row) => row.migration_name === "0001_init") ||
    !migrations.some((row) => row.migration_name === "0002_security") ||
    migrations.some((row) => !row.finished_at || row.rolled_back_at)
  ) throw new IsolationError("Clean-schema migration history is incomplete.");
  if (await prisma.user.count() !== 0) throw new IsolationError("The new schema was not empty before seeding.");
  await database.seed();
  const users = await prisma.user.findMany({ where: { email: { in: [...seededEmails] } } });
  if (users.length !== 5 || await prisma.user.count() !== 5) throw new IsolationError("Expected exactly five seeded accounts.");
  const pm = users.find((user) => user.role === "PM");
  const member = users.find((user) => user.role === "MEMBER");
  if (!pm || !member) throw new IsolationError("Seed roles are incomplete.");
  // An additive sentinel lives outside the canonical project and survives the second seed.
  const project = await prisma.project.create({
    data: { key: "TEST-SEED", name: "Preserve additive test data", members: { create: { userId: member.id } } },
  });
  const task = await prisma.task.create({
    data: {
      taskCode: "TEST-SEED-001", projectId: project.id, creatorId: pm.id,
      assigneeId: member.id, department: member.department, title: "Keep my version and status",
      version: 9, status: "IN_PROGRESS",
    },
  });
  await prisma.auditLog.create({
    data: { projectId: project.id, taskId: task.id, userId: pm.id, action: "TEST_SENTINEL" },
  });
  const before = await snapshot(prisma);
  await database.seed();
  if (await snapshot(prisma) !== before) throw new IsolationError("The second seed changed existing data.");
}
