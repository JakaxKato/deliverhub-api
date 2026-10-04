import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { createIsolatedDatabase, seededEmails, verifyMigrationsAndSeed } from "./isolation";
import {
  type Actor, type Actors, assertClientSafe, createHarness, denied, invalid,
  permissions, query, success,
} from "./fixtures";

// This must precede every application/config/seed import, including under plain `bun test`.
const database = await createIsolatedDatabase();
let applicationPrisma: (typeof import("../src/db/prisma"))["prisma"] | undefined;
afterAll(async () => {
  try {
    await applicationPrisma?.$disconnect();
  } finally {
    await database.close();
  }
}, 30_000);
const runtime = await (async () => {
  try {
    const { app } = await import("../src/index");
    const { prisma } = await import("../src/db/prisma");
    applicationPrisma = prisma;
    const schema = await prisma.$queryRaw<Array<{ schema: string }>>`SELECT current_schema() AS schema`;
    if (schema[0]?.schema !== database.schema) throw new Error("Application Prisma is not isolated.");
    return { ...createHarness(app, prisma), rawRequest: (path: string, init: RequestInit) => app.request(path, init) };
  } catch {
    await applicationPrisma?.$disconnect();
    await database.close();
    throw new Error("Application import failed after isolation; check route compilation/configuration (credentials withheld).");
  }
})();
const prisma = database.prisma;
const { request, rawRequest, login, extraActor, fixture } = runtime;
let actors: Actors;

beforeAll(async () => {
  await verifyMigrationsAndSeed(database);
  const [pm, uiux, fe, be, client] = await Promise.all(seededEmails.map((email) => login(email)));
  if (!pm || !uiux || !fe || !be || !client) throw new Error("Incomplete seeded login fixtures.");
  actors = { pm, uiux, fe, be, client, outsider: await extraActor(), otherClient: await extraActor("CLIENT") };
}, 180_000);

async function auditCount(taskId: string): Promise<number> {
  return prisma.auditLog.count({ where: { taskId } });
}
async function current(taskId: string) {
  return prisma.task.findUniqueOrThrow({ where: { id: taskId } });
}
function assertOmittedKeys(value: unknown, keys: readonly string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item) => assertOmittedKeys(item, keys));
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      expect(keys.includes(key) ? key : undefined).toBeUndefined();
      assertOmittedKeys(item, keys);
    }
  }
}
function assertClientDTO(value: unknown, forbiddenValues: string[] = []): void {
  assertClientSafe(value, forbiddenValues);
  assertOmittedKeys(value, ["permissions", "password", "sessions", "token", "jti"]);
}
function invalidWithEvidence(result: Awaited<ReturnType<typeof request>>, expectedStatus: number, context: string): void {
  if (result.response.status !== expectedStatus) {
    const data = result.body.data;
    let fileUrl: string | undefined;
    if (typeof data?.fileUrl === "string") {
      try {
        const url = new URL(data.fileUrl);
        url.username = "";
        url.password = "";
        url.search = "";
        fileUrl = url.toString();
      } catch {
        fileUrl = "[invalid URL omitted]";
      }
    }
    console.error("HTTP assertion evidence:", JSON.stringify({
      context, expectedStatus, actualStatus: result.response.status,
      body: { success: result.body.success, error: result.body.error, message: result.body.message, ...(fileUrl ? { data: { fileUrl } } : {}) },
    }));
  }
  invalid(result, expectedStatus);
}
function transitionDenied(result: Awaited<ReturnType<typeof request>>): void {
  expect([400, 403, 422]).toContain(result.response.status);
  expect(result.body.success).toBe(false);
}
function assertConflict(result: Awaited<ReturnType<typeof request>>, taskId?: string): any {
  invalid(result, 409);
  expect(result.body.error).toBe("Conflict");
  const latestData = (result.body as typeof result.body & { latestData: any }).latestData;
  expect(latestData).toBeDefined();
  if (taskId) expect(latestData.id).toBe(taskId);
  permissions(latestData);
  assertOmittedKeys(latestData, ["password", "sessions", "token", "jti"]);
  for (const actor of Object.values(actors)) expect(JSON.stringify(latestData)).not.toContain(actor.user.password);
  return latestData;
}
function pair(results: Awaited<ReturnType<typeof request>>[]) {
  expect(results.map((result) => result.response.status).sort()).toEqual([200, 409]);
  for (const result of results) {
    expect(result.body.success).toBe(result.response.status === 200);
    if (result.response.status === 409) assertConflict(result);
  }
}

// Fixtures are always additive: no deleteMany, truncation, seed reset, or canonical task mutation.
describe("Password authentication and database-backed sessions", () => {
  it("logs in all five additive seeded accounts without leaking password hashes", async () => {
    for (const email of seededEmails) {
      const result = await request("POST", "/api/auth/login", undefined, { email, password: process.env.SEED_PASSWORD });
      success(result);
      expect(result.body.data.user.email).toBe(email);
      expect(result.body.data.user).not.toHaveProperty("password");
      const claims = jwt.decode(result.body.data.token) as jwt.JwtPayload;
      expect(typeof claims.jti).toBe("string");
      const session = await prisma.session.findUniqueOrThrow({ where: { jti: claims.jti! } });
      expect(session.userId).toBe(result.body.data.user.id);
      expect(session.revokedAt).toBeNull();
      expect(session.expiresAt.getTime()).toBe(claims.exp! * 1000);
    }
  });

  for (const path of ["quick-login", "seeded-users"]) {
    it(`disables ${path} in test mode for anonymous and authenticated callers`, async () => {
      const before = await prisma.session.count();
      for (const actor of [undefined, actors.pm]) {
        for (const method of ["GET", "POST", "DELETE"]) {
          const result = await request(method, `/api/auth/${path}`, actor, method === "POST" ? { email: actors.pm.user.email } : undefined);
          invalid(result, 404);
        }
      }
      expect(await prisma.session.count()).toBe(before);
    });
  }

  it("publicly registers only MEMBER, normalizes email, and issues a usable session", async () => {
    const email = `${randomUUID()}@integration.invalid`;
    const result = await request("POST", "/api/auth/register", undefined, {
      email: `  ${email.toUpperCase()}  `, password: process.env.SEED_PASSWORD,
      name: "New member", department: "BACKEND",
    });
    success(result, 201);
    expect(result.body.data.user).toMatchObject({ email, role: "MEMBER", department: "BACKEND" });
    expect(result.body.data.user).not.toHaveProperty("password");
    const actor = await login(email);
    success(await request("GET", "/api/auth/me", actor));
    expect(await prisma.projectMember.count({ where: { userId: actor.user.id } })).toBe(0);
  });

  for (const override of [{ role: "PM" }, { role: "CLIENT" }, { department: "PRODUCT" }, { department: "CLIENT" }, { deletedAt: new Date().toISOString() }]) {
    it(`rejects registration escalation ${JSON.stringify(override)}`, async () => {
      const email = `${randomUUID()}@integration.invalid`;
      invalid(await request("POST", "/api/auth/register", undefined, {
        email, password: process.env.SEED_PASSWORD, name: "Escalation", department: "FRONTEND", ...override,
      }));
      expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    });
  }

  it("accepts explicit MEMBER registration and rejects duplicate email", async () => {
    const body = {
      email: `${randomUUID()}@integration.invalid`, password: process.env.SEED_PASSWORD,
      name: "Explicit member", department: "UIUX", role: "MEMBER",
    };
    success(await request("POST", "/api/auth/register", undefined, body), 201);
    invalid(await request("POST", "/api/auth/register", undefined, body), 409);
  });

  it("uses indistinguishable invalid-password and nonexistent-account responses", async () => {
    const wrong = await request("POST", "/api/auth/login", undefined, { email: actors.pm.user.email, password: "wrong-password" });
    const unknown = await request("POST", "/api/auth/login", undefined, { email: `${randomUUID()}@integration.invalid`, password: "wrong-password" });
    invalid(wrong, 401);
    invalid(unknown, 401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it("rejects bcrypt-truncated passwords by UTF-8 byte length", async () => {
    for (const password of ["x".repeat(73), "界".repeat(25)]) {
      invalid(await request("POST", "/api/auth/register", undefined, {
        email: `${randomUUID()}@integration.invalid`, password, name: "Long password", department: "FRONTEND",
      }));
      invalid(await request("POST", "/api/auth/login", undefined, { email: actors.pm.user.email, password }));
    }
  });

  it("revokes only the current jti on logout and rejects reuse of that token", async () => {
    const first = await login(actors.fe.user.email);
    const second = await login(actors.fe.user.email);
    const firstClaims = jwt.decode(first.token) as jwt.JwtPayload;
    const secondClaims = jwt.decode(second.token) as jwt.JwtPayload;
    expect(firstClaims.jti).not.toBe(secondClaims.jti);
    success(await request("POST", "/api/auth/logout", first), 204);
    expect((await prisma.session.findUniqueOrThrow({ where: { jti: firstClaims.jti! } })).revokedAt).not.toBeNull();
    invalid(await request("GET", "/api/auth/me", first), 401);
    invalid(await request("POST", "/api/auth/logout", first), 401);
    invalid(await request("GET", "/api/tasks", first), 401);
    success(await request("GET", "/api/auth/me", second));
  });

  it("rejects correctly signed tokens without an active database session", async () => {
    const token = jwt.sign({}, process.env.JWT_SECRET!, {
      algorithm: "HS256", subject: actors.pm.user.id, jwtid: randomUUID(), expiresIn: "1h",
      issuer: process.env.JWT_ISSUER, audience: process.env.JWT_AUDIENCE,
    });
    invalid(await request("GET", "/api/projects", { ...actors.pm, token }), 401);
  });

  it("rejects expired sessions, tampered tokens, and missing Authorization", async () => {
    const actor = await extraActor();
    const claims = jwt.decode(actor.token) as jwt.JwtPayload;
    await prisma.session.update({ where: { jti: claims.jti! }, data: { expiresAt: new Date(0) } });
    invalid(await request("GET", "/api/auth/me", actor), 401);
    invalid(await request("GET", "/api/auth/me", { ...actors.pm, token: `${actors.pm.token.slice(0, -8)}tampered` }), 401);
    invalid(await request("GET", "/api/tasks"), 401);
  });

  it("resolves actor role from the database rather than trusting an old token", async () => {
    const actor = await extraActor("PM");
    await prisma.user.update({ where: { id: actor.user.id }, data: { role: "MEMBER", department: "FRONTEND" } });
    denied(await request("POST", "/api/projects", actor, { key: "ROLE-TEST", name: "Must be rejected" }));
  });

  for (const change of ["demotion", "logout"] as const) {
    it(`transaction guard rejects a captured actor after ${change} without task/audit writes`, async () => {
      const { assertActiveActor } = await import("../src/utils/authorization.helper");
      const { loadActiveActor, verifyAccessToken } = await import("../src/utils/session.helper");
      const actor = await extraActor("PM");
      const f = await fixture(actors, { members: [actors.pm, actors.fe, actor] });
      const task = await f.task({ version: 7 });
      // Capture precisely what authentication middleware passes to a queued mutation.
      const captured = await loadActiveActor(prisma, verifyAccessToken(actor.token));
      expect(captured.role).toBe("PM");
      await prisma.$transaction((tx) => assertActiveActor(tx, captured));
      const before = await f.state();
      if (change === "demotion") {
        await prisma.user.update({ where: { id: actor.user.id }, data: { role: "MEMBER", department: "FRONTEND" } });
      } else {
        success(await request("POST", "/api/auth/logout", actor), 204);
        expect((await prisma.session.findUniqueOrThrow({ where: { jti: captured.sessionId } })).revokedAt).not.toBeNull();
      }
      let reachedBusinessWrite = false;
      const mutation = prisma.$transaction(async (tx) => {
        await assertActiveActor(tx, captured);
        reachedBusinessWrite = true;
        await tx.task.update({ where: { id: task.id }, data: { title: "Must not commit", version: { increment: 1 } } });
        await tx.auditLog.create({ data: {
          projectId: f.project.id, taskId: task.id, userId: actor.user.id, action: "TEST_UNAUTHORIZED_MUTATION",
        } });
      }, { isolationLevel: "Serializable" });
      await expect(Promise.resolve(mutation)).rejects.toMatchObject({ status: 401 });
      expect(reachedBusinessWrite).toBe(false);
      expect(await f.state()).toEqual(before);
    });
  }
});

describe("Actor-scoped project and task access", () => {
  it("allows members only in active memberships, both scoped and unscoped", async () => {
    const own = await fixture(actors);
    const foreign = await fixture(actors, { members: [actors.pm, actors.be] });
    const accessible = await own.task();
    const inaccessible = await foreign.task({ assigneeId: actors.fe.user.id });
    for (const path of [`/api/projects/${foreign.project.id}`, `/api/projects/${foreign.project.id}/metrics`, `/api/tasks/${inaccessible.id}`]) {
      denied(await request("GET", path, actors.fe));
    }
    denied(await request("GET", `/api/tasks?projectId=${foreign.project.id}`, actors.fe));
    success(await request("GET", `/api/projects/${own.project.id}`, actors.fe));
    success(await request("GET", `/api/tasks/${accessible.id}`, actors.fe));
    const projects = await request("GET", "/api/projects?rows=100", actors.fe);
    success(projects);
    expect(projects.body.data.map((row: any) => row.id)).toContain(own.project.id);
    expect(projects.body.data.map((row: any) => row.id)).not.toContain(foreign.project.id);
    const tasks = await request("GET", "/api/tasks?rows=100", actors.fe);
    success(tasks);
    expect(tasks.body.data.map((row: any) => row.id)).toContain(accessible.id);
    expect(tasks.body.data.map((row: any) => row.id)).not.toContain(inaccessible.id);
    // Being an assignee alone does not grant project access.
    denied(await request("PATCH", `/api/tasks/${inaccessible.id}/status`, actors.fe, { version: inaccessible.version, status: "IN_PROGRESS" }));
  });

  it("does not grant same-department outsiders project or task access", async () => {
    const f = await fixture(actors);
    const task = await f.task({ assigneeId: actors.outsider.user.id });
    denied(await request("GET", `/api/projects/${f.project.id}`, actors.outsider));
    denied(await request("GET", `/api/tasks/${task.id}`, actors.outsider));
    denied(await request("POST", `/api/tasks/${task.id}/attachments`, actors.outsider, {
      version: task.version, fileName: "denied.txt", fileUrl: "https://example.com/denied.txt",
    }));
  });

  it("treats soft-deleted memberships as absent in every read/mutation path", async () => {
    const f = await fixture(actors);
    const task = await f.task();
    await prisma.projectMember.update({
      where: { projectId_userId: { projectId: f.project.id, userId: actors.fe.user.id } }, data: { deletedAt: new Date() },
    });
    for (const path of [`/api/projects/${f.project.id}`, `/api/projects/${f.project.id}/metrics`, `/api/tasks/${task.id}`, `/api/audit?projectId=${f.project.id}`]) {
      denied(await request("GET", path, actors.fe));
    }
    denied(await request("PATCH", `/api/tasks/${task.id}/status`, actors.fe, { version: task.version, status: "IN_PROGRESS" }));
    const list = await request("GET", query("/api/projects", { filters: { id: f.project.id } }), actors.fe);
    success(list);
    expect(list.body.data).toEqual([]);
  });

  it("scopes CLIENT by clientId and visibility, never by project membership", async () => {
    const own = await fixture(actors);
    const foreign = await fixture(actors, { client: actors.otherClient, members: [actors.pm, actors.client] });
    const visible = await own.task();
    const internal = await own.task({ isClientVisible: false });
    const foreignTask = await foreign.task();
    success(await request("GET", `/api/projects/${own.project.id}`, actors.client));
    success(await request("GET", `/api/tasks/${visible.id}`, actors.client));
    denied(await request("GET", `/api/tasks/${internal.id}`, actors.client));
    for (const path of [`/api/projects/${foreign.project.id}`, `/api/projects/${foreign.project.id}/metrics`, `/api/tasks/${foreignTask.id}`, `/api/tasks?projectId=${foreign.project.id}`]) {
      denied(await request("GET", path, actors.client));
    }
    const projects = await request("GET", "/api/projects?rows=100", actors.client);
    success(projects);
    expect(projects.body.data.map((row: any) => row.id)).not.toContain(foreign.project.id);
    const tasks = await request("GET", "/api/tasks?rows=100", actors.client);
    success(tasks);
    expect(tasks.body.data.map((row: any) => row.id)).not.toContain(internal.id);
    expect(tasks.body.data.map((row: any) => row.id)).not.toContain(foreignTask.id);
  });

  it("allows only PM project/task creation and rejects nonmember or deleted assignees", async () => {
    const f = await fixture(actors);
    for (const actor of [actors.fe, actors.client]) {
      denied(await request("POST", "/api/projects", actor, { key: `P${randomUUID().slice(0, 7)}`, name: "Forbidden project" }));
      denied(await request("POST", "/api/tasks", actor, { projectId: f.project.id, title: "Forbidden task", department: "FRONTEND" }));
    }
    for (const assigneeId of [actors.outsider.user.id, actors.client.user.id]) {
      const before = await f.state();
      invalid(await request("POST", "/api/tasks", actors.pm, {
        projectId: f.project.id, title: "Invalid assignment", department: "FRONTEND", assigneeId,
      }));
      expect(await f.state()).toEqual(before);
    }
  });
});

describe("PM project updates and soft membership lifecycle", () => {
  async function state(f: Awaited<ReturnType<typeof fixture>>) {
    return {
      ...await f.state(),
      members: await prisma.projectMember.findMany({ where: { projectId: f.project.id }, orderBy: { id: "asc" } }),
    };
  }
  async function memberProject() {
    const member = await extraActor();
    const f = await fixture(actors, { members: [actors.pm, actors.be, member] });
    const initial = await f.task({ assigneeId: member.user.id, version: 4 });
    const membership = await prisma.projectMember.update({
      where: { projectId_userId: { projectId: f.project.id, userId: member.user.id } },
      // A fixed historical assignment avoids timing-based assertions on reactivation.
      data: { assignedAt: new Date("2000-01-01T00:00:00Z") },
    });
    const added = await request("POST", `/api/tasks/${initial.id}/attachments`, member, {
      version: initial.version, fileName: "member-proof.txt", fileUrl: "https://example.com/member-proof.txt", fileType: "text/plain",
    });
    success(added, 201);
    return { f, member, membership, task: await current(initial.id), attachmentId: added.body.data.id as string };
  }

  it("PM updates project fields without task version and audits each changed field", async () => {
    const f = await fixture(actors);
    const original = await prisma.project.update({ where: { id: f.project.id }, data: { description: "Original project brief" } });
    const task = await f.task({ version: 7 });
    const before = await state(f);
    const payload = { name: `Updated project ${randomUUID()}`, description: "Updated project brief", clientId: actors.otherClient.user.id };
    const updated = await request("PUT", `/api/projects/${f.project.id}`, actors.pm, payload);
    success(updated);
    expect(updated.body.data).toMatchObject({ id: f.project.id, ...payload });
    assertOmittedKeys(updated.body, ["password", "sessions", "token", "jti"]);
    const after = await state(f);
    expect(after.project).toMatchObject(payload);
    expect(after.members).toEqual(before.members);
    expect(after.tasks).toEqual(before.tasks);
    expect(after.edges).toEqual(before.edges);
    expect(after.attachments).toEqual(before.attachments);
    expect(after.audits).toHaveLength(3);
    for (const [column, oldValue, newValue] of [
      ["name", original.name, payload.name], ["description", original.description, payload.description],
      ["clientId", original.clientId, payload.clientId],
    ] as const) {
      const logs = after.audits.filter((log) => log.changedColumn === column);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ projectId: f.project.id, taskId: null, userId: actors.pm.user.id, oldValue, newValue });
    }
    denied(await request("GET", `/api/projects/${f.project.id}`, actors.client));
    denied(await request("GET", `/api/tasks/${task.id}`, actors.client));
    for (const path of [`/api/projects/${f.project.id}`, `/api/tasks/${task.id}`]) {
      const visible = await request("GET", path, actors.otherClient);
      success(visible);
      assertClientDTO(visible.body);
    }
  });

  it("PM can clear nullable description/clientId without changing omitted memberships", async () => {
    const f = await fixture(actors);
    await prisma.project.update({ where: { id: f.project.id }, data: { description: "Brief to clear" } });
    const before = await state(f);
    success(await request("PUT", `/api/projects/${f.project.id}`, actors.pm, { description: null, clientId: null }));
    const after = await state(f);
    expect(after.project).toMatchObject({ name: before.project!.name, description: null, clientId: null });
    expect(after.members).toEqual(before.members);
    expect(after.audits.map((log) => log.changedColumn).sort()).toEqual(["clientId", "description"]);
    denied(await request("GET", `/api/projects/${f.project.id}`, actors.client));
  });

  for (const role of ["MEMBER", "CLIENT"] as const) {
    it(`${role} cannot PUT an accessible project or change its memberships`, async () => {
      const f = await fixture(actors);
      const actor = role === "MEMBER" ? actors.fe : actors.client;
      success(await request("GET", `/api/projects/${f.project.id}`, actor));
      const before = await state(f);
      invalidWithEvidence(await request("PUT", `/api/projects/${f.project.id}`, actor, {
        name: "Unauthorized project change", description: null, clientId: actors.otherClient.user.id,
        memberIds: [actors.pm.user.id],
      }), 403, `project PUT forbidden for ${role}`);
      expect(await state(f)).toEqual(before);
    });
  }

  it("invalid clients/members, duplicates and non-contract payloads leave project/members/audit unchanged", async () => {
    const f = await fixture(actors);
    const deletedClient = await extraActor("CLIENT");
    const deletedMember = await extraActor();
    await prisma.user.update({ where: { id: deletedClient.user.id }, data: { deletedAt: new Date() } });
    await prisma.user.update({ where: { id: deletedMember.user.id }, data: { deletedAt: new Date() } });
    const before = await state(f);
    const invalidFields: Record<string, unknown>[] = [
      { clientId: actors.fe.user.id }, { clientId: actors.pm.user.id }, { clientId: randomUUID() },
      { clientId: deletedClient.user.id }, { clientId: "not-a-uuid" },
      { memberIds: [actors.pm.user.id, actors.client.user.id] },
      { memberIds: [actors.pm.user.id, deletedMember.user.id] }, { memberIds: [actors.pm.user.id, randomUUID()] },
      { memberIds: [actors.pm.user.id, actors.pm.user.id] }, { memberIds: [actors.pm.user.id, actors.fe.user.id, actors.fe.user.id] },
      { memberIds: ["not-a-uuid"] }, { memberIds: null }, { memberIds: actors.fe.user.id },
      { name: 123 }, { description: 123 }, { version: 1 },
    ];
    for (const [index, fields] of invalidFields.entries()) {
      invalidWithEvidence(await request("PUT", `/api/projects/${f.project.id}`, actors.pm, {
        name: "Validation must not partially commit", description: "Neither should this description", ...fields,
      }), 400, `project PUT invalid references/payload case ${index}`);
      expect(await state(f)).toEqual(before);
    }
  });

  it("removing a member retains its soft-deleted row and denies project/task/audit/attachment access", async () => {
    const { f, member, membership, task, attachmentId } = await memberProject();
    for (const path of [`/api/projects/${f.project.id}`, `/api/tasks/${task.id}`, `/api/audit?projectId=${f.project.id}`]) {
      success(await request("GET", path, member));
    }
    const before = await state(f);
    success(await request("PUT", `/api/projects/${f.project.id}`, actors.pm, { memberIds: [actors.pm.user.id, actors.be.user.id] }));
    const removed = await prisma.projectMember.findUniqueOrThrow({ where: { id: membership.id } });
    expect(removed).toMatchObject({ id: membership.id, projectId: f.project.id, userId: member.user.id, assignedAt: membership.assignedAt });
    expect(removed.deletedAt).not.toBeNull();
    expect(await prisma.projectMember.count({ where: { projectId: f.project.id, userId: member.user.id } })).toBe(1);
    const after = await state(f);
    expect(after.members).toHaveLength(before.members.length);
    expect(after.tasks).toEqual(before.tasks);
    expect(after.attachments).toEqual(before.attachments);
    const removals = after.audits.filter((log) => log.action === "MEMBER_REMOVED");
    expect(removals).toHaveLength(1);
    expect(removals[0]).toMatchObject({ projectId: f.project.id, userId: actors.pm.user.id, taskId: null });
    expect(JSON.stringify(removals[0])).toContain(member.user.id);
    success(await request("GET", "/api/auth/me", member));
    const project = await request("GET", `/api/projects/${f.project.id}`, actors.pm);
    success(project);
    expect(project.body.data.members.map((row: any) => row.userId)).not.toContain(member.user.id);
    for (const path of [
      `/api/projects/${f.project.id}`, `/api/projects/${f.project.id}/metrics`, `/api/tasks/${task.id}`,
      `/api/tasks?projectId=${f.project.id}`, `/api/audit?projectId=${f.project.id}`, `/api/audit?taskId=${task.id}`,
      `/api/audit/standup-summary/${f.project.id}`,
    ]) invalidWithEvidence(await request("GET", path, member), 404, `removed member access: ${path}`);
    for (const path of ["/api/projects?rows=100", "/api/tasks?rows=100", "/api/audit?rows=100"]) {
      const list = await request("GET", path, member);
      success(list);
      expect(list.body.data).toEqual([]);
      expect(list.body.meta?.total).toBe(0);
    }
    invalidWithEvidence(await request("PATCH", `/api/tasks/${task.id}/status`, member, {
      version: task.version, status: "IN_PROGRESS",
    }), 404, "removed member task status");
    invalidWithEvidence(await request("POST", `/api/tasks/${task.id}/attachments`, member, {
      version: task.version, fileName: "denied.txt", fileUrl: "https://example.com/denied.txt",
    }), 404, "removed member attachment add");
    invalidWithEvidence(await request("DELETE", `/api/tasks/${task.id}/attachments/${attachmentId}`, member, {
      version: task.version,
    }), 404, "removed member attachment delete");
    expect(await state(f)).toEqual(after);
  });

  it("re-adding a member reactivates the same composite row with a fresh assignment and login access", async () => {
    const { f, member, membership, task, attachmentId } = await memberProject();
    const kept = await prisma.projectMember.findMany({ where: { projectId: f.project.id, userId: { not: member.user.id } }, orderBy: { id: "asc" } });
    success(await request("PUT", `/api/projects/${f.project.id}`, actors.pm, { memberIds: [actors.pm.user.id, actors.be.user.id] }));
    const removed = await prisma.projectMember.findUniqueOrThrow({ where: { id: membership.id } });
    expect(removed.deletedAt).not.toBeNull();
    const freshLogin = await login(member.user.email);
    expect((jwt.decode(freshLogin.token) as jwt.JwtPayload).jti).not.toBe((jwt.decode(member.token) as jwt.JwtPayload).jti);
    invalid(await request("GET", `/api/projects/${f.project.id}`, freshLogin), 404);
    success(await request("PUT", `/api/projects/${f.project.id}`, actors.pm, {
      memberIds: [actors.pm.user.id, actors.be.user.id, member.user.id],
    }));
    const readded = await prisma.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId: f.project.id, userId: member.user.id } },
    });
    expect(readded.id).toBe(membership.id);
    expect(readded.deletedAt).toBeNull();
    expect(readded.assignedAt.getTime()).toBeGreaterThan(membership.assignedAt.getTime());
    expect(readded.assignedAt.getTime()).toBeGreaterThanOrEqual(removed.deletedAt!.getTime());
    expect(await prisma.projectMember.count({ where: { projectId: f.project.id, userId: member.user.id } })).toBe(1);
    expect(await prisma.projectMember.findMany({ where: { projectId: f.project.id, userId: { not: member.user.id } }, orderBy: { id: "asc" } })).toEqual(kept);
    const additions = await prisma.auditLog.findMany({ where: { projectId: f.project.id, action: "MEMBER_ADDED" } });
    expect(additions).toHaveLength(1);
    expect(JSON.stringify(additions[0])).toContain(member.user.id);
    expect(await prisma.auditLog.count({ where: { projectId: f.project.id, action: "MEMBER_REMOVED" } })).toBe(1);
    for (const path of [
      `/api/projects/${f.project.id}`, `/api/projects/${f.project.id}/metrics`, `/api/tasks/${task.id}`,
      `/api/tasks?projectId=${f.project.id}`, `/api/audit?projectId=${f.project.id}`, `/api/audit/standup-summary/${f.project.id}`,
    ]) success(await request("GET", path, freshLogin));
    const me = await request("GET", "/api/auth/me", freshLogin);
    success(me);
    expect(me.body.data.projectMemberships.some((row: any) => row.id === membership.id && row.projectId === f.project.id)).toBe(true);
    const added = await request("POST", `/api/tasks/${task.id}/attachments`, freshLogin, {
      version: task.version, fileName: "restored.txt", fileUrl: "https://example.com/restored.txt", fileType: "text/plain",
    });
    success(added, 201);
    success(await request("DELETE", `/api/tasks/${task.id}/attachments/${attachmentId}`, freshLogin, { version: task.version + 1 }));
    expect((await prisma.taskAttachment.findUniqueOrThrow({ where: { id: attachmentId } })).deletedAt).not.toBeNull();
    expect((await current(task.id)).version).toBe(task.version + 2);
  });

  for (const action of ["MEMBER_ADDED", "MEMBER_REMOVED"]) {
    it(`${action} audit rejection rolls back project fields and all membership writes`, async () => {
      const removedMember = await extraActor();
      const returningMember = await extraActor();
      const newMember = await extraActor();
      const f = await fixture(actors, { members: [actors.pm, actors.be, removedMember] });
      await f.task({ assigneeId: removedMember.user.id });
      const historical = await prisma.projectMember.create({ data: {
        projectId: f.project.id, userId: returningMember.user.id,
        assignedAt: new Date("2000-01-01T00:00:00Z"), deletedAt: new Date("2026-01-01T00:00:00Z"),
      } });
      const before = await state(f);
      const payload = {
        name: `Atomic project update ${randomUUID()}`, description: "Must commit with membership changes", clientId: actors.otherClient.user.id,
        memberIds: [actors.pm.user.id, actors.be.user.id, returningMember.user.id, newMember.user.id],
      };
      await rejectAuditForProject(f.project.id, async () => {
        invalidWithEvidence(await request("PUT", `/api/projects/${f.project.id}`, actors.pm, payload), 500, `project update ${action} rollback`);
        expect(await state(f)).toEqual(before);
      }, { action });
      success(await request("PUT", `/api/projects/${f.project.id}`, actors.pm, payload));
      const after = await state(f);
      expect(after.project).toMatchObject({ name: payload.name, description: payload.description, clientId: payload.clientId });
      expect(after.tasks).toEqual(before.tasks);
      expect(after.members).toHaveLength(before.members.length + 1);
      const restored = after.members.find((row) => row.userId === returningMember.user.id)!;
      expect(restored.id).toBe(historical.id);
      expect(restored.deletedAt).toBeNull();
      expect(restored.assignedAt.getTime()).toBeGreaterThan(historical.assignedAt.getTime());
      expect(after.members.find((row) => row.userId === removedMember.user.id)!.deletedAt).not.toBeNull();
      expect(after.members.find((row) => row.userId === newMember.user.id)!.deletedAt).toBeNull();
      expect(after.audits.filter((log) => log.action === "MEMBER_ADDED")).toHaveLength(2);
      expect(after.audits.filter((log) => log.action === "MEMBER_REMOVED")).toHaveLength(1);
      for (const column of ["name", "description", "clientId"]) expect(after.audits.filter((log) => log.changedColumn === column)).toHaveLength(1);
    });
  }
});

describe("Seven explicit task permissions and executor-only transitions", () => {
  it("returns seven internal permission booleans and omits CLIENT permissions on detail/list", async () => {
    const f = await fixture(actors);
    const task = await f.task();
    for (const actor of [actors.pm, actors.fe, actors.be, actors.client]) {
      const detail = await request("GET", `/api/tasks/${task.id}`, actor);
      const list = await request("GET", `/api/tasks?projectId=${f.project.id}`, actor);
      success(detail);
      success(list);
      if (actor.user.role === "CLIENT") {
        assertClientDTO(detail.body);
        assertClientDTO(list.body);
      } else {
        expect(permissions(detail.body.data)).toEqual(permissions(list.body.data[0]));
      }
    }
  });

  it("PM can edit/manage/delete but can never start or complete execution", async () => {
    const f = await fixture(actors);
    // Even PM-as-assignee is not a MEMBER executor.
    const task = await f.task({ status: "IN_PROGRESS", assigneeId: actors.pm.user.id });
    const result = await request("GET", `/api/tasks/${task.id}`, actors.pm);
    success(result);
    expect(permissions(result.body.data)).toMatchObject({
      canEdit: true, canStart: false, canComplete: false, canManageDependencies: true, canDelete: true,
    });
    const before = await f.state();
    transitionDenied(await request("PATCH", `/api/tasks/${task.id}/status`, actors.pm, { version: task.version, status: "DONE" }));
    expect(await f.state()).toEqual(before);
  });

  it("only the assigned MEMBER can start TODO and then finish IN_PROGRESS", async () => {
    const f = await fixture(actors);
    const task = await f.task();
    const detail = await request("GET", `/api/tasks/${task.id}`, actors.fe);
    success(detail);
    expect(permissions(detail.body.data)).toMatchObject({
      canEdit: false, canStart: true, canComplete: false, canChangeStatus: true,
      canManageDependencies: false, canAttach: true, canDelete: false,
    });
    for (const actor of [actors.pm, actors.be, actors.client]) {
      transitionDenied(await request("PATCH", `/api/tasks/${task.id}/status`, actor, { version: task.version, status: "IN_PROGRESS" }));
    }
    transitionDenied(await request("PATCH", `/api/tasks/${task.id}/status`, actors.fe, { version: task.version, status: "DONE" }));
    const started = await request("PATCH", `/api/tasks/${task.id}/status`, actors.fe, { version: task.version, status: "IN_PROGRESS" });
    success(started);
    expect(started.body.data.version).toBe(task.version + 1);
    const progress = await request("GET", `/api/tasks/${task.id}`, actors.fe);
    expect(permissions(progress.body.data)).toMatchObject({ canStart: false, canComplete: true });
    for (const actor of [actors.pm, actors.be, actors.client]) {
      transitionDenied(await request("PATCH", `/api/tasks/${task.id}/status`, actor, { version: task.version + 1, status: "DONE" }));
    }
    const done = await request("PATCH", `/api/tasks/${task.id}/status`, actors.fe, { version: task.version + 1, status: "DONE" });
    success(done);
    expect(done.body.data.status).toBe("DONE");
    expect((await current(task.id)).version).toBe(task.version + 2);
    expect(await auditCount(task.id)).toBe(2);
  });

  it("denies DONE to a non-assignee MEMBER in the SAME department", async () => {
    const peer = await extraActor();
    const f = await fixture(actors, { members: [actors.pm, actors.fe, peer] });
    const task = await f.task({ status: "IN_PROGRESS", department: "FRONTEND", assigneeId: actors.fe.user.id });
    expect(peer.user.department).toBe(actors.fe.user.department);
    expect(peer.user.id).not.toBe(task.assigneeId);
    const detail = await request("GET", `/api/tasks/${task.id}`, peer);
    success(detail);
    expect(permissions(detail.body.data)).toMatchObject({ canStart: false, canComplete: false });
    const before = await f.state();
    transitionDenied(await request("PATCH", `/api/tasks/${task.id}/status`, peer, { version: task.version, status: "DONE" }));
    expect(await f.state()).toEqual(before);
  });

  it("denies DONE on an unassigned IN_PROGRESS task even to same-department members", async () => {
    const f = await fixture(actors);
    const task = await f.task({ status: "IN_PROGRESS", assigneeId: null, department: "FRONTEND" });
    const detail = await request("GET", `/api/tasks/${task.id}`, actors.fe);
    success(detail);
    expect(permissions(detail.body.data)).toMatchObject({ canStart: false, canComplete: false });
    const before = await f.state();
    for (const actor of [actors.fe, actors.pm]) {
      transitionDenied(await request("PATCH", `/api/tasks/${task.id}/status`, actor, { version: task.version, status: "DONE" }));
      expect(await f.state()).toEqual(before);
    }
  });

  it("denies PM TODO-to-DONE bypass and TODO-to-IN_PROGRESS, even when PM is assignee", async () => {
    for (const assignee of [actors.fe, actors.pm]) {
      const f = await fixture(actors);
      const task = await f.task({ status: "TODO", assigneeId: assignee.user.id });
      const before = await f.state();
      for (const status of ["DONE", "IN_PROGRESS"]) {
        transitionDenied(await request("PATCH", `/api/tasks/${task.id}/status`, actors.pm, { version: task.version, status }));
        expect(await f.state()).toEqual(before);
      }
    }
  });

  for (const initialStatus of ["BLOCKED", "IN_PROGRESS", "DONE"] as const) {
    it(`assigned MEMBER cannot start ${initialStatus}: only TODO can start`, async () => {
      const f = await fixture(actors);
      const task = await f.task({ status: initialStatus });
      const detail = await request("GET", `/api/tasks/${task.id}`, actors.fe);
      success(detail);
      expect(permissions(detail.body.data).canStart).toBe(false);
      const before = await f.state();
      transitionDenied(await request("PATCH", `/api/tasks/${task.id}/status`, actors.fe, { version: task.version, status: "IN_PROGRESS" }));
      expect(await f.state()).toEqual(before);
    });
  }

  for (const initialStatus of ["BLOCKED", "DONE"] as const) {
    it(`assigned MEMBER cannot complete ${initialStatus}: only IN_PROGRESS can finish`, async () => {
      const f = await fixture(actors);
      const task = await f.task({ status: initialStatus });
      const detail = await request("GET", `/api/tasks/${task.id}`, actors.fe);
      success(detail);
      expect(permissions(detail.body.data).canComplete).toBe(false);
      const before = await f.state();
      transitionDenied(await request("PATCH", `/api/tasks/${task.id}/status`, actors.fe, { version: task.version, status: "DONE" }));
      expect(await f.state()).toEqual(before);
    });
  }

  it("incomplete prerequisites disable start/complete and reject bypass", async () => {
    const f = await fixture(actors);
    const prerequisite = await f.task({ isClientVisible: false });
    const task = await f.task({ status: "BLOCKED" });
    await prisma.taskDependency.create({ data: { taskId: task.id, prerequisiteTaskId: prerequisite.id } });
    const detail = await request("GET", `/api/tasks/${task.id}`, actors.fe);
    success(detail);
    expect(permissions(detail.body.data)).toMatchObject({ canStart: false, canComplete: false });
    const before = await f.state();
    transitionDenied(await request("PATCH", `/api/tasks/${task.id}/status`, actors.fe, { version: task.version, status: "IN_PROGRESS" }));
    expect(await f.state()).toEqual(before);
  });

  it("CLIENT DTO omits permissions and every mutation is denied", async () => {
    const f = await fixture(actors);
    const task = await f.task();
    const prerequisite = await f.task({ status: "DONE" });
    await prisma.taskDependency.create({ data: { taskId: task.id, prerequisiteTaskId: prerequisite.id } });
    const attachment = await prisma.taskAttachment.create({ data: {
      taskId: task.id, uploaderId: actors.fe.user.id, fileName: "no-delete.txt", fileUrl: "https://example.com/no-delete.txt",
    } });
    const detail = await request("GET", `/api/tasks/${task.id}`, actors.client);
    success(detail);
    assertClientDTO(detail.body);
    const before = await f.state();
    for (const [method, path, body] of [
      ["PUT", `/api/tasks/${task.id}`, { version: task.version, title: "Denied" }],
      ["PATCH", `/api/tasks/${task.id}/status`, { version: task.version, status: "IN_PROGRESS" }],
      ["POST", `/api/tasks/${task.id}/dependencies`, { version: task.version, prerequisiteTaskId: prerequisite.id }],
      ["DELETE", `/api/tasks/${task.id}/dependencies/${prerequisite.id}`, { version: task.version }],
      ["DELETE", `/api/tasks/${task.id}/attachments/${attachment.id}`, { version: task.version }],
      ["POST", `/api/tasks/${task.id}/attachments`, { version: task.version, fileName: "x.txt", fileUrl: "https://example.com/x.txt" }],
      ["DELETE", `/api/tasks/${task.id}`, { version: task.version }],
    ] as const) denied(await request(method, path, actors.client, body));
    expect(await f.state()).toEqual(before);
  });

  it("MEMBER cannot edit details, manage dependencies, or delete", async () => {
    const f = await fixture(actors);
    const task = await f.task();
    const prerequisite = await f.task({ status: "DONE" });
    await prisma.taskDependency.create({ data: { taskId: task.id, prerequisiteTaskId: prerequisite.id } });
    const before = await f.state();
    denied(await request("PUT", `/api/tasks/${task.id}`, actors.fe, { version: task.version, title: "No edit" }));
    denied(await request("POST", `/api/tasks/${task.id}/dependencies`, actors.fe, { version: task.version, prerequisiteTaskId: prerequisite.id }));
    denied(await request("DELETE", `/api/tasks/${task.id}/dependencies/${prerequisite.id}`, actors.fe, { version: task.version }));
    denied(await request("DELETE", `/api/tasks/${task.id}`, actors.fe, { version: task.version }));
    expect(await f.state()).toEqual(before);
  });
});

type Mutation = "details" | "status" | "dependency add" | "dependency delete" | "attachment add" | "attachment delete" | "task delete";
const mutations: Mutation[] = ["details", "status", "dependency add", "dependency delete", "attachment add", "attachment delete", "task delete"];
async function mutationFixture(kind: Mutation) {
  const f = await fixture(actors);
  const task = await f.task({ version: 4 });
  const prerequisite = await f.task({ status: "DONE" });
  let method = "PUT";
  let path = `/api/tasks/${task.id}`;
  let actor = actors.pm;
  let body: Record<string, unknown> = { title: "Version-controlled detail" };
  let expected = 200;
  if (kind === "status") {
    method = "PATCH"; path += "/status"; actor = actors.fe; body = { status: "IN_PROGRESS" };
  } else if (kind === "dependency add") {
    method = "POST"; path += "/dependencies"; body = { prerequisiteTaskId: prerequisite.id };
  } else if (kind === "dependency delete") {
    await prisma.taskDependency.create({ data: { taskId: task.id, prerequisiteTaskId: prerequisite.id } });
    method = "DELETE"; path += `/dependencies/${prerequisite.id}`; body = {};
  } else if (kind === "attachment add") {
    method = "POST"; path += "/attachments"; actor = actors.fe;
    body = { fileName: "proof.txt", fileUrl: "https://example.com/proof.txt", fileType: "text/plain" }; expected = 201;
  } else if (kind === "attachment delete") {
    const attachment = await prisma.taskAttachment.create({
      data: { taskId: task.id, uploaderId: actors.fe.user.id, fileName: "proof.txt", fileUrl: "https://example.com/proof.txt" },
    });
    method = "DELETE"; path += `/attachments/${attachment.id}`; actor = actors.fe; body = {};
  } else if (kind === "task delete") {
    method = "DELETE"; body = {};
  }
  return { f, task, prerequisite, method, path, actor, body, expected };
}

describe("Resolve task access before parsing mutation payloads", () => {
  for (const resource of ["missing", "deleted task", "deleted project", "inaccessible"] as const) {
    for (const kind of mutations) {
      it(`${kind} returns 404 for ${resource} before missing/invalid/malformed payload validation`, async () => {
        const m = await mutationFixture(kind);
        let path = m.path;
        let actor: Actor = m.actor;
        if (resource === "missing") {
          path = path.replace(`/api/tasks/${m.task.id}`, `/api/tasks/${randomUUID()}`);
        } else if (resource === "deleted task") {
          await prisma.task.update({ where: { id: m.task.id }, data: { deletedAt: new Date() } });
        } else if (resource === "deleted project") {
          await prisma.project.update({ where: { id: m.f.project.id }, data: { deletedAt: new Date() } });
        } else {
          actor = actors.outsider;
        }
        const before = await m.f.state();
        for (const payload of [undefined, null, [], {}, { ...m.body, version: "invalid" }]) {
          invalidWithEvidence(await request(m.method, path, actor, payload), 404, `${kind}: ${resource}`);
          expect(await m.f.state()).toEqual(before);
        }
        const malformed = await rawRequest(path, {
          method: m.method,
          headers: { Authorization: `Bearer ${actor.token}`, "Content-Type": "application/json" },
          body: "{",
        });
        expect(malformed.status).toBe(404);
        expect((await malformed.json() as { success: boolean }).success).toBe(false);
        expect(await m.f.state()).toEqual(before);
      });
    }
  }
});

describe("Expected version on every existing-task mutation, including DELETE JSON", () => {
  for (const kind of mutations) {
    it(`${kind} rejects missing/invalid versions without any data or audit write`, async () => {
      const m = await mutationFixture(kind);
      const before = await m.f.state();
      for (const version of [undefined, null, 0, -1, 1.5, "4", 2147483648]) {
        invalid(await request(m.method, m.path, m.actor, { ...m.body, ...(version === undefined ? {} : { version }) }));
        expect(await m.f.state()).toEqual(before);
      }
    });
    it(`${kind} rejects a stale version then increments once with the expected version`, async () => {
      const m = await mutationFixture(kind);
      const before = await m.f.state();
      const conflict = await request(m.method, m.path, m.actor, { ...m.body, version: m.task.version - 1 });
      const latestData = assertConflict(conflict, m.task.id);
      expect(latestData.version).toBe(m.task.version);
      const detail = await request("GET", `/api/tasks/${m.task.id}`, m.actor);
      success(detail);
      expect(permissions(latestData)).toEqual(permissions(detail.body.data));
      expect(await m.f.state()).toEqual(before);
      success(await request(m.method, m.path, m.actor, { ...m.body, version: m.task.version }), m.expected);
      const after = await current(m.task.id);
      expect(after.version).toBe(m.task.version + 1);
      expect(await auditCount(m.task.id)).toBe(1);
      if (kind === "task delete") expect(after.deletedAt).not.toBeNull();
      invalid(await request(m.method, m.path, m.actor, { ...m.body, version: m.task.version }), kind === "task delete" ? 404 : 409);
      expect((await current(m.task.id)).version).toBe(m.task.version + 1);
      expect(await auditCount(m.task.id)).toBe(1);
    });
  }

  it("does not accept a query-string version in place of the DELETE JSON contract", async () => {
    const m = await mutationFixture("dependency delete");
    const before = await m.f.state();
    const result = await request("DELETE", `${m.path}?version=${m.task.version}`, actors.pm);
    invalid(result);
    expect(await m.f.state()).toEqual(before);
  });
});

describe("Serialized project mutations and serializable conflict retries", () => {
  it("races PM details and MEMBER status: exactly one 200 and one 409", async () => {
    const f = await fixture(actors);
    const task = await f.task();
    const results = await Promise.all([
      request("PUT", `/api/tasks/${task.id}`, actors.pm, { version: task.version, title: "Concurrent details" }),
      request("PATCH", `/api/tasks/${task.id}/status`, actors.fe, { version: task.version, status: "IN_PROGRESS" }),
    ]);
    pair(results);
    const final = await current(task.id);
    expect(final.version).toBe(task.version + 1);
    expect(await auditCount(task.id)).toBe(1);
    if (results[0]!.response.status === 200) {
      expect(final.title).toBe("Concurrent details"); expect(final.status).toBe("TODO");
    } else {
      expect(final.title).toBe(task.title); expect(final.status).toBe("IN_PROGRESS");
    }
  });

  it("races two statuses at the same version: exactly one 200 and one 409", async () => {
    const f = await fixture(actors);
    const task = await f.task();
    pair(await Promise.all([1, 2].map(() => request("PATCH", `/api/tasks/${task.id}/status`, actors.fe, { version: task.version, status: "IN_PROGRESS" }))));
    expect((await current(task.id)).version).toBe(task.version + 1);
    expect(await auditCount(task.id)).toBe(1);
  });

  it("races two dependency additions at the same version: exactly one 200 and one 409", async () => {
    const f = await fixture(actors);
    const task = await f.task();
    const [first, second] = await Promise.all([f.task({ status: "DONE" }), f.task({ status: "DONE" })]);
    pair(await Promise.all([first, second].map((prerequisite) => request("POST", `/api/tasks/${task.id}/dependencies`, actors.pm, {
      version: task.version, prerequisiteTaskId: prerequisite.id,
    }))));
    expect((await current(task.id)).version).toBe(task.version + 1);
    expect(await prisma.taskDependency.count({ where: { taskId: task.id, deletedAt: null } })).toBe(1);
    expect(await auditCount(task.id)).toBe(1);
  });

  it("races status versus dependency at the same version without losing a write", async () => {
    const f = await fixture(actors);
    const task = await f.task();
    const prerequisite = await f.task({ status: "DONE" });
    pair(await Promise.all([
      request("PATCH", `/api/tasks/${task.id}/status`, actors.fe, { version: task.version, status: "IN_PROGRESS" }),
      request("POST", `/api/tasks/${task.id}/dependencies`, actors.pm, { version: task.version, prerequisiteTaskId: prerequisite.id }),
    ]));
    expect((await current(task.id)).version).toBe(task.version + 1);
    expect(await auditCount(task.id)).toBe(1);
  });

  it("finishes independent prerequisites concurrently, unblocking once with one audit/version bump", async () => {
    const f = await fixture(actors);
    const first = await f.task({ status: "IN_PROGRESS" });
    const second = await f.task({ status: "IN_PROGRESS", assigneeId: actors.be.user.id, department: "BACKEND" });
    const dependent = await f.task({ status: "BLOCKED", version: 7 });
    await prisma.taskDependency.createMany({ data: [first, second].map((prerequisite) => ({ taskId: dependent.id, prerequisiteTaskId: prerequisite.id })) });
    const results = await Promise.all([
      request("PATCH", `/api/tasks/${first.id}/status`, actors.fe, { version: first.version, status: "DONE" }),
      request("PATCH", `/api/tasks/${second.id}/status`, actors.be, { version: second.version, status: "DONE" }),
    ]);
    results.forEach((result) => success(result));
    const after = await current(dependent.id);
    expect(after.status).toBe("TODO");
    expect(after.version).toBe(dependent.version + 1);
    const logs = await prisma.auditLog.findMany({ where: { taskId: dependent.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: "AUTO_UNBLOCKED", changedColumn: "status", oldValue: "BLOCKED", newValue: "TODO" });
    expect(await auditCount(first.id)).toBe(1);
    expect(await auditCount(second.id)).toBe(1);
  });
});

describe("Dependency validation, atomic creation, and soft-delete uniqueness", () => {
  it("completing a different task preserves an unrelated manual BLOCKED task and its version/audit", async () => {
    const f = await fixture(actors);
    const manual = await f.task({ status: "TODO", version: 13 });
    const completing = await f.task({ status: "IN_PROGRESS", version: 4 });
    success(await request("PATCH", `/api/tasks/${manual.id}/status`, actors.pm, {
      version: manual.version, status: "BLOCKED", note: "Manual release approval required",
    }));
    const manualBefore = await current(manual.id);
    expect(manualBefore.status).toBe("BLOCKED");
    expect(await prisma.taskDependency.count({ where: { taskId: manual.id, deletedAt: null } })).toBe(0);
    const auditsBefore = await prisma.auditLog.findMany({ where: { taskId: manual.id }, orderBy: { id: "asc" } });
    expect(auditsBefore).toHaveLength(1);
    success(await request("PATCH", `/api/tasks/${completing.id}/status`, actors.fe, {
      version: completing.version, status: "DONE",
    }));
    expect(await current(completing.id)).toMatchObject({ status: "DONE", version: completing.version + 1 });
    expect(await current(manual.id)).toEqual(manualBefore);
    expect(await prisma.auditLog.findMany({ where: { taskId: manual.id }, orderBy: { id: "asc" } })).toEqual(auditsBefore);
    expect(await prisma.auditLog.count({ where: { taskId: manual.id, action: "AUTO_UNBLOCKED" } })).toBe(0);
  });

  it("deleting a completed prerequisite bumps TODO dependents once, preserves soft edges/audits and rejects stale writes", async () => {
    const f = await fixture(actors);
    const prerequisite = await f.task({ status: "DONE", version: 4 });
    const remaining = await f.task({ status: "DONE", version: 6 });
    const dependent = await f.task({ status: "TODO", version: 7 });
    const sibling = await f.task({ status: "TODO", version: 11 });
    const edges = [];
    for (const task of [dependent, sibling]) edges.push(await prisma.taskDependency.create({
      data: { taskId: task.id, prerequisiteTaskId: prerequisite.id },
    }));
    const remainingEdge = await prisma.taskDependency.create({ data: { taskId: dependent.id, prerequisiteTaskId: remaining.id } });
    const historical = await prisma.taskDependency.create({ data: {
      taskId: dependent.id, prerequisiteTaskId: prerequisite.id, deletedAt: new Date("2026-01-01T00:00:00Z"),
    } });
    success(await request("DELETE", `/api/tasks/${prerequisite.id}`, actors.pm, { version: prerequisite.version }));
    const deleted = await current(prerequisite.id);
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.version).toBe(prerequisite.version + 1);
    for (const [index, task] of [dependent, sibling].entries()) {
      expect(await current(task.id)).toMatchObject({ status: "TODO", version: task.version + 1 });
      const edge = await prisma.taskDependency.findUniqueOrThrow({ where: { id: edges[index]!.id } });
      expect(edge).toMatchObject({ taskId: task.id, prerequisiteTaskId: prerequisite.id });
      expect(edge.deletedAt).toEqual(deleted.deletedAt);
      const logs = await prisma.auditLog.findMany({ where: { taskId: task.id } });
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        action: "DEPENDENCY_REMOVED", changedColumn: "dependencies", oldValue: prerequisite.id,
        metadata: { deletedTaskId: prerequisite.id },
      });
    }
    expect(await prisma.taskDependency.findUniqueOrThrow({ where: { id: historical.id } })).toEqual(historical);
    expect(await prisma.taskDependency.findUniqueOrThrow({ where: { id: remainingEdge.id } })).toEqual(remainingEdge);
    expect(await current(remaining.id)).toEqual(remaining);
    expect(await prisma.taskDependency.count({ where: { task: { projectId: f.project.id } } })).toBe(4);
    expect(await prisma.taskDependency.count({ where: { task: { projectId: f.project.id }, deletedAt: null } })).toBe(1);
    const afterDeletion = await f.state();
    for (const task of [dependent, sibling]) {
      const conflict = assertConflict(await request("PUT", `/api/tasks/${task.id}`, actors.pm, {
        version: task.version, title: "Stale dependent details must not commit",
      }), task.id);
      expect(conflict.version).toBe(task.version + 1);
      expect(conflict.status).toBe("TODO");
      expect(await f.state()).toEqual(afterDeletion);
    }
  });

  it("deleting an incomplete prerequisite auto-unblocks its dependent exactly once with audit", async () => {
    const f = await fixture(actors);
    const prerequisite = await f.task({ status: "TODO", version: 4 });
    const dependent = await f.task({ status: "BLOCKED", version: 7 });
    const child = await f.task({ status: "BLOCKED", version: 11 });
    const edge = await prisma.taskDependency.create({ data: { taskId: dependent.id, prerequisiteTaskId: prerequisite.id } });
    const childEdge = await prisma.taskDependency.create({ data: { taskId: child.id, prerequisiteTaskId: dependent.id } });
    success(await request("DELETE", `/api/tasks/${prerequisite.id}`, actors.pm, { version: prerequisite.version }));
    const deleted = await current(prerequisite.id);
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.version).toBe(prerequisite.version + 1);
    expect(await current(dependent.id)).toMatchObject({ status: "TODO", version: dependent.version + 1 });
    expect((await prisma.taskDependency.findUniqueOrThrow({ where: { id: edge.id } })).deletedAt).toEqual(deleted.deletedAt);
    const logs = await prisma.auditLog.findMany({ where: { taskId: dependent.id } });
    expect(logs).toHaveLength(2);
    expect(logs.filter((log) => log.action === "DEPENDENCY_REMOVED")).toHaveLength(1);
    const unblocked = logs.filter((log) => log.action === "AUTO_UNBLOCKED");
    expect(unblocked).toHaveLength(1);
    expect(unblocked[0]).toMatchObject({ changedColumn: "status", oldValue: "BLOCKED", newValue: "TODO" });
    const detail = await request("GET", `/api/tasks/${dependent.id}`, actors.fe);
    success(detail);
    expect(detail.body.data.isBlocked).toBe(false);
    expect(permissions(detail.body.data).canStart).toBe(true);
    // The direct dependent is unblocked, not completed: its own child must stay blocked.
    expect(await current(child.id)).toEqual(child);
    expect(await prisma.taskDependency.findUniqueOrThrow({ where: { id: childEdge.id } })).toEqual(childEdge);
    expect(await auditCount(child.id)).toBe(0);
  });

  it("adding an incomplete dependency automatically BLOCKS and audits the task", async () => {
    const f = await fixture(actors);
    const task = await f.task({ status: "TODO", version: 4 });
    const prerequisite = await f.task({ status: "TODO" });
    success(await request("POST", `/api/tasks/${task.id}/dependencies`, actors.pm, {
      version: task.version, prerequisiteTaskId: prerequisite.id,
    }));
    expect(await current(task.id)).toMatchObject({ status: "BLOCKED", version: task.version + 1 });
    expect(await current(prerequisite.id)).toEqual(prerequisite);
    expect(await prisma.taskDependency.count({ where: { taskId: task.id, prerequisiteTaskId: prerequisite.id, deletedAt: null } })).toBe(1);
    const logs = await prisma.auditLog.findMany({ where: { taskId: task.id } });
    expect(logs).toHaveLength(2);
    expect(logs.filter((log) => log.action === "DEPENDENCY_ADDED")).toHaveLength(1);
    const blocked = logs.filter((log) => log.action === "AUTO_BLOCKED");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ changedColumn: "status", oldValue: "TODO", newValue: "BLOCKED" });
    const detail = await request("GET", `/api/tasks/${task.id}`, actors.fe);
    success(detail);
    expect(permissions(detail.body.data)).toMatchObject({ canStart: false, canComplete: false });
  });

  it("reopening a completed prerequisite blocks downstream tasks once across multiple paths", async () => {
    const f = await fixture(actors);
    const root = await f.task({ status: "DONE", version: 4 });
    const middle = await f.task({ status: "DONE", version: 7 });
    const downstream = await f.task({ status: "IN_PROGRESS", version: 11 });
    const independent = await f.task({ status: "DONE", version: 13 });
    await prisma.taskDependency.createMany({ data: [
      { taskId: middle.id, prerequisiteTaskId: root.id },
      { taskId: downstream.id, prerequisiteTaskId: middle.id },
      { taskId: downstream.id, prerequisiteTaskId: root.id },
    ] });
    success(await request("PATCH", `/api/tasks/${root.id}/status`, actors.pm, { version: root.version, status: "TODO" }));
    expect(await current(root.id)).toMatchObject({ status: "TODO", version: root.version + 1 });
    for (const task of [middle, downstream]) {
      expect(await current(task.id)).toMatchObject({ status: "BLOCKED", version: task.version + 1 });
      const logs = await prisma.auditLog.findMany({ where: { taskId: task.id } });
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ action: "AUTO_BLOCKED", changedColumn: "status", oldValue: task.status, newValue: "BLOCKED" });
      const detail = await request("GET", `/api/tasks/${task.id}`, actors.fe);
      success(detail);
      expect(permissions(detail.body.data)).toMatchObject({ canStart: false, canComplete: false });
    }
    expect(await current(independent.id)).toEqual(independent);
    expect(await auditCount(independent.id)).toBe(0);
    const rootLogs = await prisma.auditLog.findMany({ where: { taskId: root.id } });
    expect(rootLogs).toHaveLength(1);
    expect(rootLogs[0]).toMatchObject({ action: "STATUS_CHANGED", changedColumn: "status", oldValue: "DONE", newValue: "TODO" });
    expect(await prisma.taskDependency.count({ where: { task: { projectId: f.project.id }, deletedAt: null } })).toBe(3);
  });

  it("removing the final blocker automatically unblocks and audits the task", async () => {
    const f = await fixture(actors);
    const task = await f.task({ status: "BLOCKED", version: 4 });
    const prerequisite = await f.task({ status: "TODO" });
    const edge = await prisma.taskDependency.create({ data: { taskId: task.id, prerequisiteTaskId: prerequisite.id } });
    success(await request("DELETE", `/api/tasks/${task.id}/dependencies/${prerequisite.id}`, actors.pm, { version: task.version }));
    expect(await current(task.id)).toMatchObject({ status: "TODO", version: task.version + 1 });
    expect(await current(prerequisite.id)).toEqual(prerequisite);
    expect((await prisma.taskDependency.findUniqueOrThrow({ where: { id: edge.id } })).deletedAt).not.toBeNull();
    const logs = await prisma.auditLog.findMany({ where: { taskId: task.id } });
    expect(logs).toHaveLength(2);
    expect(logs.filter((log) => log.action === "DEPENDENCY_REMOVED")).toHaveLength(1);
    const unblocked = logs.filter((log) => log.action === "AUTO_UNBLOCKED");
    expect(unblocked).toHaveLength(1);
    expect(unblocked[0]).toMatchObject({ changedColumn: "status", oldValue: "BLOCKED", newValue: "TODO" });
  });

  it("removing one of two blockers does not emit a premature auto-unblock audit", async () => {
    const f = await fixture(actors);
    const task = await f.task({ status: "BLOCKED", version: 4 });
    const first = await f.task(); const second = await f.task();
    await prisma.taskDependency.createMany({ data: [first, second].map((prerequisite) => ({ taskId: task.id, prerequisiteTaskId: prerequisite.id })) });
    success(await request("DELETE", `/api/tasks/${task.id}/dependencies/${first.id}`, actors.pm, { version: task.version }));
    expect(await current(task.id)).toMatchObject({ status: "BLOCKED", version: task.version + 1 });
    expect(await auditCount(task.id)).toBe(1);
    expect(await prisma.auditLog.count({ where: { taskId: task.id, action: "AUTO_UNBLOCKED" } })).toBe(0);
    success(await request("DELETE", `/api/tasks/${task.id}/dependencies/${second.id}`, actors.pm, { version: task.version + 1 }));
    expect(await current(task.id)).toMatchObject({ status: "TODO", version: task.version + 2 });
    expect(await prisma.auditLog.count({ where: { taskId: task.id, action: "AUTO_UNBLOCKED" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { taskId: task.id, action: "DEPENDENCY_REMOVED" } })).toBe(2);
  });
  it("rejects self, foreign-project, deleted, and missing prerequisites without writes", async () => {
    const f = await fixture(actors);
    const other = await fixture(actors);
    const task = await f.task();
    const foreign = await other.task();
    const deleted = await f.task({ deletedAt: new Date() });
    const before = await f.state();
    for (const prerequisiteTaskId of [task.id, foreign.id, deleted.id, randomUUID()]) {
      const result = await request("POST", `/api/tasks/${task.id}/dependencies`, actors.pm, { version: task.version, prerequisiteTaskId });
      expect([400, 404]).toContain(result.response.status);
      expect(result.body.success).toBe(false);
      expect(await f.state()).toEqual(before);
    }
  });

  it("rejects cycles, including longer paths, atomically", async () => {
    const f = await fixture(actors);
    const a = await f.task(); const b = await f.task(); const c = await f.task();
    await prisma.taskDependency.createMany({ data: [
      { taskId: b.id, prerequisiteTaskId: a.id }, { taskId: c.id, prerequisiteTaskId: b.id },
    ] });
    const before = await f.state();
    invalid(await request("POST", `/api/tasks/${a.id}/dependencies`, actors.pm, { version: a.version, prerequisiteTaskId: c.id }));
    expect(await f.state()).toEqual(before);
  });

  it("serializes opposite dependency requests so a concurrent cycle cannot form", async () => {
    const f = await fixture(actors);
    const a = await f.task(); const b = await f.task();
    const results = await Promise.all([
      request("POST", `/api/tasks/${a.id}/dependencies`, actors.pm, { version: a.version, prerequisiteTaskId: b.id }),
      request("POST", `/api/tasks/${b.id}/dependencies`, actors.pm, { version: b.version, prerequisiteTaskId: a.id }),
    ]);
    expect(results.filter((result) => result.response.status === 200)).toHaveLength(1);
    expect(results.filter((result) => result.response.status === 400)).toHaveLength(1);
    expect(await prisma.taskDependency.count({ where: { task: { projectId: f.project.id }, deletedAt: null } })).toBe(1);
  });

  it("retains a deleted edge and permits re-adding its pair through the partial unique index", async () => {
    const f = await fixture(actors);
    const task = await f.task(); const prerequisite = await f.task({ status: "DONE" });
    success(await request("POST", `/api/tasks/${task.id}/dependencies`, actors.pm, { version: 1, prerequisiteTaskId: prerequisite.id }));
    const edge = await prisma.taskDependency.findFirstOrThrow({ where: { taskId: task.id, deletedAt: null } });
    success(await request("DELETE", `/api/tasks/${task.id}/dependencies/${prerequisite.id}`, actors.pm, { version: 2 }));
    expect((await prisma.taskDependency.findUniqueOrThrow({ where: { id: edge.id } })).deletedAt).not.toBeNull();
    success(await request("POST", `/api/tasks/${task.id}/dependencies`, actors.pm, { version: 3, prerequisiteTaskId: prerequisite.id }));
    const edges = await prisma.taskDependency.findMany({ where: { taskId: task.id, prerequisiteTaskId: prerequisite.id } });
    expect(edges).toHaveLength(2);
    expect(edges.filter((row) => row.deletedAt === null)).toHaveLength(1);
    expect((await current(task.id)).version).toBe(4);
    expect(await auditCount(task.id)).toBe(3);
    const before = await f.state();
    invalid(await request("POST", `/api/tasks/${task.id}/dependencies`, actors.pm, { version: 4, prerequisiteTaskId: prerequisite.id }), 409);
    expect(await f.state()).toEqual(before);
  });

  it("the partial index itself rejects two active instances but allows historical rows", async () => {
    const f = await fixture(actors);
    const task = await f.task(); const prerequisite = await f.task();
    await prisma.taskDependency.create({ data: { taskId: task.id, prerequisiteTaskId: prerequisite.id, deletedAt: new Date() } });
    await prisma.taskDependency.create({ data: { taskId: task.id, prerequisiteTaskId: prerequisite.id } });
    // Bun's rejection matcher requires a native Promise, not Prisma's lazy thenable.
    await expect(Promise.resolve(prisma.taskDependency.create({ data: { taskId: task.id, prerequisiteTaskId: prerequisite.id } }))).rejects.toThrow();
    expect(await prisma.taskDependency.count({ where: { taskId: task.id } })).toBe(2);
  });

  it("deleted edges neither block start nor appear in dependency responses", async () => {
    const f = await fixture(actors);
    const task = await f.task(); const prerequisite = await f.task();
    const edge = await prisma.taskDependency.create({ data: { taskId: task.id, prerequisiteTaskId: prerequisite.id, deletedAt: new Date() } });
    const detail = await request("GET", `/api/tasks/${task.id}`, actors.fe);
    success(detail);
    expect(JSON.stringify(detail.body.data)).not.toContain(edge.id);
    expect(detail.body.data.isBlocked).toBe(false);
    success(await request("PATCH", `/api/tasks/${task.id}/status`, actors.fe, { version: task.version, status: "IN_PROGRESS" }));
  });

  for (const kind of ["foreign", "missing", "deleted", "duplicate"]) {
    it(`task creation with ${kind} prerequisite leaves no task, edge, or audit`, async () => {
      const f = await fixture(actors);
      const other = await fixture(actors);
      const valid = await f.task({ status: "DONE" });
      const foreign = await other.task();
      const deleted = await f.task({ deletedAt: new Date() });
      const badId = kind === "foreign" ? foreign.id : kind === "deleted" ? deleted.id : kind === "missing" ? randomUUID() : valid.id;
      const before = await f.state();
      const result = await request("POST", "/api/tasks", actors.pm, {
        projectId: f.project.id, title: `Atomic create ${randomUUID()}`, department: "FRONTEND", assigneeId: actors.fe.user.id,
        prerequisiteTaskIds: [valid.id, badId],
      });
      expect([400, 404, 409]).toContain(result.response.status);
      expect(result.body.success).toBe(false);
      expect(await f.state()).toEqual(before);
    });
  }

  it("creates a valid dependent task and audit in one request", async () => {
    const f = await fixture(actors);
    const prerequisite = await f.task();
    const result = await request("POST", "/api/tasks", actors.pm, {
      projectId: f.project.id, title: "Create dependent", department: "FRONTEND",
      assigneeId: actors.fe.user.id, prerequisiteTaskIds: [prerequisite.id],
    });
    success(result, 201);
    expect(result.body.data.status).toBe("BLOCKED");
    expect(await prisma.taskDependency.count({ where: { taskId: result.body.data.id, prerequisiteTaskId: prerequisite.id, deletedAt: null } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { taskId: result.body.data.id, action: "TASK_CREATED" } })).toBe(1);
  });
});

describe("Attachment metadata validation, authorization and soft deletion", () => {
  const maxAttachmentSize = 25 * 1024 * 1024;
  const invalidMetadata: Array<{ field: string; values: unknown[] }> = [
    {
      field: "fileUrl",
      values: [
        "http://example.com/proof.pdf", "ftp://example.com/proof.pdf", "file:///C:/proof.pdf",
        "javascript:alert(1)", "data:text/plain,proof",
        "https://user:password@example.com/proof.pdf", "https://user@example.com/proof.pdf", "https://:password@example.com/proof.pdf",
        "https://localhost/proof.pdf", "https://LOCALHOST:443/proof.pdf", "https://sub.localhost/proof.pdf", "https://localhost./proof.pdf",
        "https://127.0.0.1/proof.pdf", "https://192.168.1.2/proof.pdf", "https://8.8.8.8/proof.pdf",
        "https://[::1]/proof.pdf", "https://[2001:4860:4860::8888]/proof.pdf",
        "https://2130706433/proof.pdf", "https://0x7f000001/proof.pdf",
        "https://example.com/\nproof.pdf", "https://example.com/\rproof.pdf", "https://example.com/\tproof.pdf", "https://example.com/\u0000proof.pdf",
      ],
    },
    {
      field: "fileName",
      values: [
        "", "   ", ".", "..", "../proof.pdf", "folder/proof.pdf", "folder\\proof.pdf", "/tmp/proof.pdf", "C:\\fakepath\\proof.pdf",
        "proof\u0000.pdf", "proof\n.pdf", "proof\r.pdf", "proof\t.pdf", "proof\u007f.pdf",
      ],
    },
    {
      field: "fileType",
      values: ["", "pdf", "exe", "text", "text/", "/plain", "text\\plain", "text/plain/extra", "text/plain\n", "image/\u0000png", 123, null],
    },
    { field: "fileSize", values: [-1, 1.5, maxAttachmentSize + 1, Number.MAX_SAFE_INTEGER, "0", "26214400", null] },
  ];
  for (const { field, values } of invalidMetadata) {
    it(`rejects invalid ${field} without writing attachments, task version or audit`, async () => {
      const f = await fixture(actors);
      const task = await f.task({ version: 4 });
      const before = await f.state();
      for (const [caseIndex, value] of values.entries()) {
        invalidWithEvidence(await request("POST", `/api/tasks/${task.id}/attachments`, actors.fe, {
          version: task.version, fileName: "proof.pdf", fileUrl: "https://example.com/proof.pdf",
          fileType: "application/pdf", fileSize: 1024, [field]: value,
        }), 400, `attachment ${field} case ${caseIndex}`);
        expect(await f.state()).toEqual(before);
      }
    });
  }

  it("accepts HTTPS links/MIME types and inclusive size boundaries 0 and 25 MiB", async () => {
    const f = await fixture(actors);
    const task = await f.task({ version: 4 });
    const validMetadata: Array<{ fileType?: string; fileSize?: number }> = [
      { fileType: "link", fileSize: 0 }, { fileType: "application/pdf", fileSize: maxAttachmentSize },
      { fileType: "image/svg+xml", fileSize: 1024 }, { fileType: "text/plain", fileSize: 1 },
      { fileType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }, {},
    ];
    for (const [index, metadata] of validMetadata.entries()) {
      const result = await request("POST", `/api/tasks/${task.id}/attachments`, actors.fe, {
        version: task.version + index, fileName: "proof.pdf",
        fileUrl: "https://files.example.com/proof.pdf?signature=test#receipt", ...metadata,
      });
      success(result, 201);
      const stored = await prisma.taskAttachment.findUniqueOrThrow({ where: { id: result.body.data.id } });
      expect(stored.fileType).toBe(metadata.fileType ?? "link");
      expect(stored.fileSize).toBe(metadata.fileSize ?? null);
      expect(stored.fileUrl).toBe("https://files.example.com/proof.pdf?signature=test#receipt");
      expect((await current(task.id)).version).toBe(task.version + index + 1);
      expect(await auditCount(task.id)).toBe(index + 1);
    }
    expect(await prisma.taskAttachment.count({ where: { taskId: task.id, deletedAt: null } })).toBe(validMetadata.length);
  });
  it("denies foreign-project add/delete even when task and attachment IDs are known", async () => {
    const foreign = await fixture(actors, { members: [actors.pm, actors.be], client: actors.otherClient });
    const task = await foreign.task({ assigneeId: actors.be.user.id });
    const attachment = await prisma.taskAttachment.create({
      data: { taskId: task.id, uploaderId: actors.be.user.id, fileName: "private.txt", fileUrl: "https://example.com/private.txt" },
    });
    const before = await foreign.state();
    for (const actor of [actors.fe, actors.client, actors.outsider]) {
      denied(await request("POST", `/api/tasks/${task.id}/attachments`, actor, { version: task.version, fileName: "attack.txt", fileUrl: "https://example.com/attack.txt" }));
      denied(await request("DELETE", `/api/tasks/${task.id}/attachments/${attachment.id}`, actor, { version: task.version }));
    }
    expect(await foreign.state()).toEqual(before);
  });

  it("cannot delete an attachment through a different task's URL", async () => {
    const f = await fixture(actors);
    const first = await f.task(); const second = await f.task();
    const attachment = await prisma.taskAttachment.create({
      data: { taskId: second.id, uploaderId: actors.fe.user.id, fileName: "second.txt", fileUrl: "https://example.com/second.txt" },
    });
    const before = await f.state();
    invalid(await request("DELETE", `/api/tasks/${first.id}/attachments/${attachment.id}`, actors.fe, { version: first.version }), 404);
    expect(await f.state()).toEqual(before);
  });

  it("soft-deletes an attachment, preserves history, and omits it from list/detail", async () => {
    const f = await fixture(actors);
    const task = await f.task();
    const added = await request("POST", `/api/tasks/${task.id}/attachments`, actors.fe, {
      version: 1, fileName: "proof.txt", fileUrl: "https://example.com/proof.txt", fileType: "text/plain",
    });
    success(added, 201);
    success(await request("DELETE", `/api/tasks/${task.id}/attachments/${added.body.data.id}`, actors.fe, { version: 2 }));
    expect((await prisma.taskAttachment.findUniqueOrThrow({ where: { id: added.body.data.id } })).deletedAt).not.toBeNull();
    for (const path of [`/api/tasks/${task.id}`, `/api/tasks?projectId=${f.project.id}`]) {
      const result = await request("GET", path, actors.pm);
      success(result);
      const data = Array.isArray(result.body.data) ? result.body.data[0] : result.body.data;
      expect(data.attachments).toEqual([]);
    }
    expect(await auditCount(task.id)).toBe(2);
    expect((await current(task.id)).version).toBe(3);
  });
});

/** PostgreSQL trigger failure proves audit writes use the same transaction as the mutation. */
async function rejectAuditForProject(
  projectId: string,
  work: () => Promise<void>,
  options: { action?: string; projectKey?: string } = {},
): Promise<void> {
  database.assertIsolated();
  if (!/^[a-f0-9-]{36}$/.test(projectId)) throw new Error("Invalid fixture UUID.");
  if (options.action && !/^[A-Z_]+$/.test(options.action)) throw new Error("Invalid fixture audit action.");
  if (options.projectKey && !/^[A-Z0-9-]{2,10}$/.test(options.projectKey)) throw new Error("Invalid fixture project key.");
  const name = `test_reject_${randomUUID().replaceAll("-", "")}`;
  const schema = database.schema;
  const projectCondition = options.projectKey
    ? `EXISTS (SELECT 1 FROM "${schema}"."projects" WHERE "id" = NEW."projectId" AND "key" = '${options.projectKey}')`
    : `NEW."projectId" = '${projectId}'`;
  const actionCondition = options.action ? ` AND NEW."action" = '${options.action}'` : "";
  let functionCreated = false;
  let triggerCreated = false;
  try {
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${schema}"."${name}"() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog AS $audit_test$
      BEGIN
        IF ${projectCondition}${actionCondition} THEN
          RAISE EXCEPTION 'isolated test audit rejection' USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END;
      $audit_test$
    `);
    functionCreated = true;
    await prisma.$executeRawUnsafe(`CREATE TRIGGER "${name}" BEFORE INSERT ON "${schema}"."audit_logs" FOR EACH ROW EXECUTE FUNCTION "${schema}"."${name}"()`);
    triggerCreated = true;
    await work();
  } finally {
    try {
      if (triggerCreated) await prisma.$executeRawUnsafe(`DROP TRIGGER "${name}" ON "${schema}"."audit_logs"`);
    } finally {
      if (functionCreated) await prisma.$executeRawUnsafe(`DROP FUNCTION "${schema}"."${name}"()`);
    }
  }
}

describe("Atomic audit rollback and append-only migration guards", () => {
  for (const kind of mutations) {
    it(`rolls back ${kind}, version and related rows when audit insertion fails`, async () => {
      const m = await mutationFixture(kind);
      const before = await m.f.state();
      await rejectAuditForProject(m.f.project.id, async () => {
        invalid(await request(m.method, m.path, m.actor, { ...m.body, version: m.task.version }), 500);
        expect(await m.f.state()).toEqual(before);
      });
      // Cleanup is observable: a subsequent mutation can now audit and commit normally.
      success(await request(m.method, m.path, m.actor, { ...m.body, version: m.task.version }), m.expected);
    });
  }

  it("rolls back task creation, its dependencies and audit when audit insertion fails", async () => {
    const f = await fixture(actors);
    const prerequisite = await f.task();
    const before = await f.state();
    await rejectAuditForProject(f.project.id, async () => {
      invalid(await request("POST", "/api/tasks", actors.pm, {
        projectId: f.project.id, title: "Must roll back", department: "FRONTEND",
        assigneeId: actors.fe.user.id, prerequisiteTaskIds: [prerequisite.id],
      }), 500);
      expect(await f.state()).toEqual(before);
    });
  });

  it("rolls back project soft-delete when audit insertion fails", async () => {
    const f = await fixture(actors);
    const before = await f.state();
    await rejectAuditForProject(f.project.id, async () => {
      invalid(await request("DELETE", `/api/projects/${f.project.id}`, actors.pm), 500);
      expect(await f.state()).toEqual(before);
    });
  });

  for (const action of ["STATUS_CHANGED", "AUTO_UNBLOCKED"]) {
    it(`rolls back completion AND auto-unblocking when ${action} audit insertion fails`, async () => {
      const f = await fixture(actors);
      const prerequisite = await f.task({ status: "IN_PROGRESS" });
      const dependent = await f.task({ status: "BLOCKED" });
      await prisma.taskDependency.create({ data: { taskId: dependent.id, prerequisiteTaskId: prerequisite.id } });
      const before = await f.state();
      await rejectAuditForProject(f.project.id, async () => {
        invalid(await request("PATCH", `/api/tasks/${prerequisite.id}/status`, actors.fe, { version: prerequisite.version, status: "DONE" }), 500);
        expect(await f.state()).toEqual(before);
      }, { action });
    });
  }

  it("rolls back project creation, memberships and audit on audit-insert rejection", async () => {
    const key = `R${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
    const body = { key, name: "Atomic project creation", clientId: actors.client.user.id, memberIds: [actors.pm.user.id, actors.fe.user.id] };
    const membersBefore = await prisma.projectMember.count();
    const auditsBefore = await prisma.auditLog.count();
    await rejectAuditForProject(randomUUID(), async () => {
      invalid(await request("POST", "/api/projects", actors.pm, body), 500);
      expect(await prisma.project.findUnique({ where: { key } })).toBeNull();
      expect(await prisma.projectMember.count()).toBe(membersBefore);
      expect(await prisma.auditLog.count()).toBe(auditsBefore);
    }, { projectKey: key });
    const committed = await request("POST", "/api/projects", actors.pm, body);
    success(committed, 201);
    expect(await prisma.projectMember.count({ where: { projectId: committed.body.data.id } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { projectId: committed.body.data.id, action: "PROJECT_CREATED" } })).toBe(1);
  });

  it("rejects direct audit UPDATE, DELETE and TRUNCATE and preserves every row", async () => {
    database.assertIsolated();
    const f = await fixture(actors);
    const log = await prisma.auditLog.create({ data: { projectId: f.project.id, userId: actors.pm.user.id, action: "TEST_APPEND_ONLY" } });
    const before = await prisma.auditLog.count();
    await expect(Promise.resolve(prisma.auditLog.update({ where: { id: log.id }, data: { action: "TAMPERED" } }))).rejects.toThrow();
    await expect(Promise.resolve(prisma.auditLog.delete({ where: { id: log.id } }))).rejects.toThrow();
    await expect(Promise.resolve(prisma.$executeRawUnsafe(`TRUNCATE TABLE "${database.schema}"."audit_logs"`))).rejects.toThrow();
    expect(await prisma.auditLog.count()).toBe(before);
    expect(await prisma.auditLog.findUniqueOrThrow({ where: { id: log.id } })).toEqual(log);
    // Append-only means inserts still work, not a blanket write prohibition.
    await prisma.auditLog.create({ data: { projectId: f.project.id, userId: actors.pm.user.id, action: "TEST_APPEND_ALLOWED" } });
  });
});

describe("CLIENT JSON omission and safe visible-only metrics", () => {
  it("masks internal/cross-project prerequisite identities across all client read endpoints", async () => {
    const f = await fixture(actors);
    const foreign = await fixture(actors, { client: actors.otherClient });
    const internal = await f.task({ title: `Secret internal ${randomUUID()}`, isClientVisible: false });
    const crossProject = await foreign.task({ title: `Secret foreign ${randomUUID()}` });
    const visible = await f.task({ title: "Public deliverable", status: "BLOCKED" });
    const publicPrerequisite = await f.task({ title: "Public prerequisite", status: "DONE" });
    // Inject legacy bad data directly to exercise read masking, not the validated writer.
    await prisma.taskDependency.createMany({ data: [internal, crossProject, publicPrerequisite].map((task) => ({ taskId: visible.id, prerequisiteTaskId: task.id })) });
    const attachment = await prisma.taskAttachment.create({
      data: { taskId: visible.id, uploaderId: actors.fe.user.id, fileName: "public.pdf", fileUrl: "https://example.com/public.pdf" },
    });
    await prisma.auditLog.create({ data: {
      projectId: f.project.id, taskId: visible.id, userId: actors.pm.user.id,
      action: "TEST_PRIVATE_AUDIT", metadata: { privateMarker: "secret-audit-marker" },
    } });
    const forbidden = [
      ...[actors.pm, actors.fe, actors.be, actors.client].flatMap((actor) => [actor.user.id, actor.user.name, actor.user.email]),
      internal.id, internal.title, internal.taskCode, crossProject.id, crossProject.title, crossProject.taskCode,
      foreign.project.id, "secret-audit-marker",
    ];
    const paths = [
      "/api/projects?rows=100", `/api/projects/${f.project.id}`, `/api/projects/${f.project.id}/metrics`,
      `/api/tasks?projectId=${f.project.id}`, `/api/tasks/${visible.id}`, "/api/tasks?rows=100",
    ];
    for (const path of paths) {
      const result = await request("GET", path, actors.client);
      success(result);
      assertClientDTO(result.body, forbidden);
      if (path === `/api/tasks/${visible.id}`) {
        expect(result.body.data.attachments.map((row: any) => row.id)).toContain(attachment.id);
        expect(result.body.data.isBlocked).toBe(true);
      }
    }
    for (const path of [`/api/tasks/${internal.id}`, `/api/tasks/${crossProject.id}`, `/api/audit?projectId=${f.project.id}`, `/api/audit?taskId=${visible.id}`, `/api/audit/standup-summary/${f.project.id}`, "/api/audit"]) {
      const result = await request("GET", path, actors.client);
      denied(result);
      assertClientDTO(result.body, forbidden);
    }
  });

  it("counts only visible active tasks and omits department/member/client breakdowns", async () => {
    const f = await fixture(actors);
    await f.task({ status: "DONE" }); await f.task({ status: "TODO" }); await f.task({ status: "BLOCKED" });
    await f.task({ status: "IN_PROGRESS", isClientVisible: false });
    await f.task({ status: "DONE", isClientVisible: false });
    await f.task({ status: "DONE", deletedAt: new Date() });
    const result = await request("GET", `/api/projects/${f.project.id}/metrics`, actors.client);
    success(result);
    expect(result.body.data).toMatchObject({ totalTasks: 3, completedTasks: 1, todoTasks: 1, blockedTasks: 1, inProgressTasks: 0, percentageComplete: 33 });
    assertClientDTO(result.body);
    const pm = await request("GET", `/api/projects/${f.project.id}/metrics`, actors.pm);
    success(pm);
    expect(pm.body.data.totalTasks).toBe(5);
  });

  it("forbids identity/department/visibility filters and sorting as client side channels", async () => {
    const f = await fixture(actors);
    for (const params of [
      { filters: { assigneeId: actors.fe.user.id } }, { filters: { creatorId: actors.pm.user.id } },
      { filters: { department: "FRONTEND" } }, { filters: { isClientVisible: false } },
      { searchFilters: { description: "internal" } }, { orderKey: "department" }, { orderKey: "version" },
      { rangedFilters: [{ key: "version", start: 1, end: 9 }] },
    ]) invalid(await request("GET", query("/api/tasks", { projectId: f.project.id, ...params }), actors.client));
  });
});

describe("Audit access, unscoped isolation, and date-safe standup", () => {
  it("denies other-project audit and standup even when IDs or filters are supplied", async () => {
    const own = await fixture(actors);
    const foreign = await fixture(actors, { members: [actors.pm, actors.be] });
    const ownTask = await own.task(); const foreignTask = await foreign.task();
    const ownLog = await prisma.auditLog.create({ data: { projectId: own.project.id, taskId: ownTask.id, userId: actors.pm.user.id, action: "TEST_OWN" } });
    const foreignLog = await prisma.auditLog.create({ data: { projectId: foreign.project.id, taskId: foreignTask.id, userId: actors.pm.user.id, action: "TEST_PRIVATE" } });
    for (const path of [`/api/audit?projectId=${foreign.project.id}`, `/api/audit?taskId=${foreignTask.id}`, `/api/audit/standup-summary/${foreign.project.id}`]) {
      denied(await request("GET", path, actors.fe));
    }
    const unscoped = await request("GET", "/api/audit?rows=100", actors.fe);
    success(unscoped);
    expect(unscoped.body.data.map((row: any) => row.id)).toContain(ownLog.id);
    expect(unscoped.body.data.map((row: any) => row.id)).not.toContain(foreignLog.id);
    expect(JSON.stringify(unscoped.body)).not.toContain(foreignTask.id);
    const byFilter = await request("GET", query("/api/audit", { filters: { projectId: foreign.project.id } }), actors.fe);
    expect([200, 403, 404]).toContain(byFilter.response.status);
    if (byFilter.response.status === 200) {
      expect(byFilter.body.data).toEqual([]);
      expect(byFilter.body.meta?.total).toBe(0);
    }
  });

  it("validates real YYYY-MM-DD dates rather than accepting date rollover or timestamps", async () => {
    const f = await fixture(actors);
    for (const date of ["not-a-date", "2026-02-30", "2025-02-29", "2026-13-01", "2026-00-01", "2026-10-01T00:00:00Z", "2026-1-1", ""]) {
      invalid(await request("GET", query(`/api/audit/standup-summary/${f.project.id}`, { date }), actors.pm));
    }
    success(await request("GET", query(`/api/audit/standup-summary/${f.project.id}`, { date: "2024-02-29" }), actors.pm));
  });

  it("uses UTC day boundaries and excludes deleted tasks from completion/current summaries", async () => {
    const f = await fixture(actors);
    const before = await f.task({ title: "Outside before", status: "DONE" });
    const first = await f.task({ title: "At UTC midnight", status: "DONE" });
    const last = await f.task({ title: "At UTC day end", status: "DONE" });
    const after = await f.task({ title: "Outside after", status: "DONE" });
    const deleted = await f.task({ title: "Deleted summary task", status: "DONE", deletedAt: new Date() });
    for (const [task, timestamp] of [
      [before, "2026-09-30T23:59:59.999Z"], [first, "2026-10-01T00:00:00.000Z"],
      [last, "2026-10-01T23:59:59.999Z"], [after, "2026-10-02T00:00:00.000Z"], [deleted, "2026-10-01T12:00:00.000Z"],
    ] as const) await prisma.auditLog.create({ data: {
      projectId: f.project.id, taskId: task.id, userId: actors.fe.user.id,
      action: "STATUS_CHANGED", changedColumn: "status", oldValue: "IN_PROGRESS", newValue: "DONE", timestamp: new Date(timestamp),
    } });
    const result = await request("GET", `/api/audit/standup-summary/${f.project.id}?date=2026-10-01`, actors.pm);
    success(result);
    expect(result.body.data.summary.completedYesterday.FRONTEND.map((row: any) => row.title).sort()).toEqual([first.title, last.title].sort());
    for (const task of [before, after, deleted]) expect(JSON.stringify(result.body.data)).not.toContain(task.title);
    expect(result.body.data.markdown).toContain("Daily Standup Summary");
  });
});

describe("Soft-deleted actors/projects/tasks cannot regain access", () => {
  it("rejects login and all existing sessions after user soft deletion", async () => {
    const actor = await extraActor();
    const f = await fixture(actors, { members: [actors.pm, actor] });
    const task = await f.task({ assigneeId: actor.user.id });
    await prisma.user.update({ where: { id: actor.user.id }, data: { deletedAt: new Date() } });
    invalid(await request("POST", "/api/auth/login", undefined, { email: actor.user.email, password: process.env.SEED_PASSWORD }), 401);
    for (const path of ["/api/auth/me", "/api/projects", `/api/projects/${f.project.id}`, `/api/tasks/${task.id}`, "/api/audit"]) {
      invalid(await request("GET", path, actor), 401);
    }
    invalid(await request("PATCH", `/api/tasks/${task.id}/status`, actor, { version: task.version, status: "IN_PROGRESS" }), 401);
  });

  it("rejects active children of a deleted project for PM, MEMBER and CLIENT", async () => {
    const f = await fixture(actors);
    const task = await f.task(); const prerequisite = await f.task({ status: "DONE" });
    await prisma.project.update({ where: { id: f.project.id }, data: { deletedAt: new Date() } });
    const before = await f.state();
    for (const actor of [actors.pm, actors.fe, actors.client]) {
      for (const path of [`/api/projects/${f.project.id}`, `/api/projects/${f.project.id}/metrics`, `/api/tasks/${task.id}`, `/api/audit?projectId=${f.project.id}`]) {
        denied(await request("GET", path, actor));
      }
      denied(await request("PATCH", `/api/tasks/${task.id}/status`, actor, { version: task.version, status: "IN_PROGRESS" }));
    }
    denied(await request("PUT", `/api/tasks/${task.id}`, actors.pm, { version: task.version, title: "Dead project" }));
    denied(await request("POST", `/api/tasks/${task.id}/dependencies`, actors.pm, { version: task.version, prerequisiteTaskId: prerequisite.id }));
    denied(await request("DELETE", `/api/tasks/${task.id}`, actors.pm, { version: task.version }));
    denied(await request("POST", "/api/tasks", actors.pm, { projectId: f.project.id, title: "No resurrection", department: "FRONTEND" }));
    expect(await f.state()).toEqual(before);
  });

  it("rejects all reads/mutations of a deleted task and hides it in lists", async () => {
    const f = await fixture(actors);
    const task = await f.task({ deletedAt: new Date() }); const prerequisite = await f.task();
    const before = await f.state();
    for (const actor of [actors.pm, actors.fe, actors.client]) {
      invalid(await request("GET", `/api/tasks/${task.id}`, actor), 404);
      const list = await request("GET", `/api/tasks?projectId=${f.project.id}`, actor);
      success(list);
      expect(list.body.data.map((row: any) => row.id)).not.toContain(task.id);
    }
    invalid(await request("PUT", `/api/tasks/${task.id}`, actors.pm, { version: task.version, title: "Restore attempt" }), 404);
    invalid(await request("PATCH", `/api/tasks/${task.id}/status`, actors.fe, { version: task.version, status: "IN_PROGRESS" }), 404);
    invalid(await request("POST", `/api/tasks/${task.id}/dependencies`, actors.pm, { version: task.version, prerequisiteTaskId: prerequisite.id }), 404);
    invalid(await request("POST", `/api/tasks/${task.id}/attachments`, actors.fe, { version: task.version, fileName: "x", fileUrl: "https://example.com/x" }), 404);
    invalid(await request("DELETE", `/api/tasks/${task.id}`, actors.pm, { version: task.version }), 404);
    invalid(await request("DELETE", `/api/tasks/${task.id}/dependencies/${prerequisite.id}`, actors.pm, { version: task.version }), 404);
    invalid(await request("DELETE", `/api/tasks/${task.id}/attachments/${randomUUID()}`, actors.fe, { version: task.version }), 404);
    expect(await f.state()).toEqual(before);
  });

  it("rejects deleted users as assignees on both task create and update", async () => {
    const actor = await extraActor();
    const f = await fixture(actors, { members: [actors.pm, actors.fe, actor] });
    const task = await f.task();
    await prisma.user.update({ where: { id: actor.user.id }, data: { deletedAt: new Date() } });
    const before = await f.state();
    invalid(await request("POST", "/api/tasks", actors.pm, { projectId: f.project.id, title: "Deleted assignee", department: "FRONTEND", assigneeId: actor.user.id }));
    invalid(await request("PUT", `/api/tasks/${task.id}`, actors.pm, { version: task.version, assigneeId: actor.user.id }));
    expect(await f.state()).toEqual(before);
  });
});

describe("Strict query whitelists and stable date/pagination ordering", () => {
  const badQueries: Array<Record<string, unknown>> = [
    { filters: "{" }, { filters: [] }, { filters: null }, { filters: { OR: [] } },
    { filters: { deletedAt: null } }, { filters: { "project.members": [] } }, { filters: { password: "x" } },
    { filters: '{"__proto__":{"polluted":true}}' }, { filters: { constructor: {} } },
    { searchFilters: { email: "secret" } }, { orderKey: "password" }, { orderRule: "sideways" },
    { include: "user" }, { page: "0" }, { page: "-1" }, { page: "1.5" }, { page: "1e2" },
    { rows: "0" }, { rows: "101" }, { rows: "9007199254740992" }, { page: "100001", rows: "100" },
    { rangedFilters: [{ key: "createdAt", start: "bad-date", end: "2026-10-01T00:00:00Z" }] },
    { rangedFilters: [{ key: "createdAt", start: "2026-10-02T00:00:00Z", end: "2026-10-01T00:00:00Z" }] },
    { rangedFilters: [{ key: "password", start: 1, end: 2 }] },
  ];
  for (const endpoint of ["tasks", "projects", "audit"]) {
    it(`${endpoint} rejects malformed filters, unknown fields, unsafe paging and sorting`, async () => {
      for (const params of badQueries) invalid(await request("GET", query(`/api/${endpoint}`, params), actors.pm));
      invalid(await request("GET", `/api/${endpoint}?page=1&page=2`, actors.pm));
      invalid(await request("GET", query(`/api/${endpoint}`, { filters: "x".repeat(8193) }), actors.pm));
    });
  }

  it("rejects typed task-filter violations and invalid UUID scoping", async () => {
    for (const params of [
      { filters: { status: "NOT_A_STATUS" } }, { filters: { priority: "CRITICAL" } },
      { filters: { isClientVisible: "true" } }, { projectId: "not-a-uuid" },
      { filters: { assigneeId: "not-a-uuid" } }, { rangedFilters: [{ key: "version", start: 1.5, end: 3 }] },
    ]) invalid(await request("GET", query("/api/tasks", params), actors.pm));
  });

  it("preserves actor scope when caller filters request another project", async () => {
    const foreign = await fixture(actors, { members: [actors.pm, actors.be], client: actors.otherClient });
    await foreign.task();
    for (const actor of [actors.fe, actors.client]) {
      const result = await request("GET", query("/api/tasks", { filters: { projectId: foreign.project.id } }), actor);
      success(result);
      expect(result.body.data).toEqual([]);
      expect(result.body.meta?.total).toBe(0);
    }
  });

  it("supports exact/search/date filters and stable id tie-breaks across task pages", async () => {
    const f = await fixture(actors);
    const timestamp = new Date("2026-10-01T12:00:00.000Z");
    const rows = [];
    for (let index = 0; index < 5; index += 1) rows.push(await f.task({ title: `Pagination needle ${index}`, status: "DONE", createdAt: timestamp }));
    await f.task({ title: "Other state", status: "TODO", createdAt: timestamp });
    await f.task({ title: "Pagination needle outside date", status: "DONE", createdAt: new Date("2026-09-30T12:00:00Z") });
    await f.task({ title: "Pagination needle deleted", status: "DONE", createdAt: timestamp, deletedAt: new Date() });
    for (const orderRule of ["asc", "desc"]) {
      const ids: string[] = [];
      for (const page of [1, 2, 3]) {
        const result = await request("GET", query("/api/tasks", {
          projectId: f.project.id, filters: { status: "DONE" }, searchFilters: { title: "pagination NEEDLE" },
          rangedFilters: [{ key: "createdAt", start: "2026-10-01T00:00:00Z", end: "2026-10-01T23:59:59.999Z" }],
          orderKey: "createdAt", orderRule, page: String(page), rows: "2",
        }), actors.pm);
        success(result);
        expect(result.body.meta).toMatchObject({ page, rows: 2, total: 5, totalPages: 3 });
        expect(result.body.data).toHaveLength(page === 3 ? 1 : 2);
        ids.push(...result.body.data.map((row: any) => row.id));
      }
      const expected = rows.map((row) => row.id).sort();
      if (orderRule === "desc") expected.reverse();
      expect(ids).toEqual(expected);
      expect(new Set(ids).size).toBe(5);
    }
  });

  it("applies project query policy and stable project pagination rather than task fields", async () => {
    const actor = await extraActor();
    const createdAt = new Date("2026-10-01T12:00:00Z");
    const rows = [];
    for (let index = 0; index < 3; index += 1) {
      const f = await fixture(actors, { members: [actors.pm, actor] });
      rows.push(await prisma.project.update({ where: { id: f.project.id }, data: { createdAt, name: `Query sentinel ${index}` } }));
    }
    const ids: string[] = [];
    for (const page of [1, 2]) {
      const result = await request("GET", query("/api/projects", {
        searchFilters: { name: "query SENTINEL" }, orderKey: "createdAt", orderRule: "asc", page: String(page), rows: "2",
      }), actor);
      success(result);
      expect(result.body.meta).toMatchObject({ total: 3, totalPages: 2, page, rows: 2 });
      ids.push(...result.body.data.map((row: any) => row.id));
    }
    expect(ids).toEqual(rows.map((row) => row.id).sort());
    invalid(await request("GET", query("/api/projects", { filters: { status: "DONE" } }), actors.pm));
  });

  it("applies audit timestamp ranges and stable id tie-breaks across pages", async () => {
    const f = await fixture(actors);
    const timestamp = new Date("2026-10-01T12:00:00Z");
    const rows = [];
    for (let index = 0; index < 5; index += 1) rows.push(await prisma.auditLog.create({
      data: { projectId: f.project.id, userId: actors.pm.user.id, action: "TEST_PAGINATION", timestamp },
    }));
    await prisma.auditLog.create({ data: { projectId: f.project.id, userId: actors.pm.user.id, action: "TEST_PAGINATION", timestamp: new Date("2026-09-30T12:00:00Z") } });
    const ids: string[] = [];
    for (const page of [1, 2, 3]) {
      const result = await request("GET", query("/api/audit", {
        projectId: f.project.id, filters: { action: "TEST_PAGINATION" },
        rangedFilters: [{ key: "timestamp", start: "2026-10-01T00:00:00Z", end: "2026-10-01T23:59:59.999Z" }],
        orderKey: "timestamp", orderRule: "asc", rows: "2", page: String(page),
      }), actors.pm);
      success(result);
      expect(result.body.meta).toMatchObject({ total: 5, totalPages: 3, rows: 2, page });
      ids.push(...result.body.data.map((row: any) => row.id));
    }
    expect(ids).toEqual(rows.map((row) => row.id).sort());
  });
});

describe("Internal deliverable comments with server-side client masking", () => {
  it("creates comments, records an immutable audit entry, and lists them with ezfilter", async () => {
    const f = await fixture(actors);
    const task = await f.task();
    const versionBefore = task.version;

    const first = await request("POST", "/api/comments", actors.fe, {
      taskId: task.id, body: "Handoff ready for review.",
    });
    success(first, 201);
    expect(first.body.data.body).toBe("Handoff ready for review.");
    expect(first.body.data.taskId).toBe(task.id);
    expect(first.body.data.projectId).toBe(f.project.id);
    expect(first.body.data.author.id).toBe(actors.fe.user.id);
    expect(first.body.data.canDelete).toBe(true);

    const second = await request("POST", "/api/comments", actors.pm, {
      taskId: task.id, body: "Looks good, ship it.",
    });
    success(second, 201);
    expect(second.body.data.author.id).toBe(actors.pm.user.id);

    const stored = await prisma.comment.findMany({ where: { taskId: task.id } });
    expect(stored).toHaveLength(2);
    const audits = await prisma.auditLog.findMany({ where: { taskId: task.id, action: "COMMENT_ADDED" } });
    expect(audits).toHaveLength(2);
    expect(audits.map((row) => row.newValue)).toContain("Handoff ready for review.");
    // Comments are decoupled from the optimistic-lock version they annotate.
    expect((await current(task.id)).version).toBe(versionBefore);

    const list = await request("GET", `/api/comments?taskId=${task.id}`, actors.be);
    success(list);
    expect(list.body.meta).toMatchObject({ total: 2, page: 1, rows: 20 });
    expect(new Set(list.body.data.map((row: any) => row.id))).toEqual(
      new Set([first.body.data.id, second.body.data.id]),
    );

    const search = await request("GET", query("/api/comments", {
      taskId: task.id, searchFilters: { body: "ship" },
    }), actors.be);
    success(search);
    expect(search.body.data).toHaveLength(1);
    expect(search.body.data[0].id).toBe(second.body.data.id);
  });

  it("allows only the author or a PM to soft-delete while retaining history", async () => {
    const f = await fixture(actors);
    const task = await f.task();
    const created = await request("POST", "/api/comments", actors.fe, {
      taskId: task.id, body: "Temporary note",
    });
    success(created, 201);
    const commentId = created.body.data.id;

    // A same-project peer cannot delete another member's comment.
    denied(await request("DELETE", `/api/comments/${commentId}`, actors.be));
    expect((await prisma.comment.findUniqueOrThrow({ where: { id: commentId } })).deletedAt).toBeNull();

    success(await request("DELETE", `/api/comments/${commentId}`, actors.fe), 204);
    const deleted = await prisma.comment.findUniqueOrThrow({ where: { id: commentId } });
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.body).toBe("Temporary note");
    expect(await prisma.auditLog.count({ where: { taskId: task.id, action: "COMMENT_DELETED" } })).toBe(1);

    const list = await request("GET", `/api/comments?taskId=${task.id}`, actors.pm);
    success(list);
    expect(list.body.data).toEqual([]);

    const moderated = await request("POST", "/api/comments", actors.fe, {
      taskId: task.id, body: "Moderate me",
    });
    success(moderated, 201);
    success(await request("DELETE", `/api/comments/${moderated.body.data.id}`, actors.pm), 204);
  });

  it("never exposes comment history or author identities to a client guest", async () => {
    const f = await fixture(actors);
    const task = await f.task({ isClientVisible: true });
    const created = await request("POST", "/api/comments", actors.fe, {
      taskId: task.id, body: "Secret internal debate",
    });
    success(created, 201);

    for (const path of [
      `/api/comments?taskId=${task.id}`,
      `/api/comments?projectId=${f.project.id}`,
      "/api/comments",
    ]) {
      denied(await request("GET", path, actors.client));
    }
    denied(await request("POST", "/api/comments", actors.client, { taskId: task.id, body: "client injection" }));
    denied(await request("DELETE", `/api/comments/${created.body.data.id}`, actors.client));

    const detail = await request("GET", `/api/tasks/${task.id}`, actors.client);
    success(detail);
    expect(detail.body.data).not.toHaveProperty("comments");
    assertClientDTO(detail.body.data, ["Secret internal debate", actors.fe.user.name, "COMMENT"]);

    const internal = await request("GET", `/api/comments?taskId=${task.id}`, actors.fe);
    success(internal);
    expect(internal.body.data).toHaveLength(1);
  });

  it("scopes comments to accessible projects and rejects cross-project task ids", async () => {
    const foreign = await fixture(actors, { members: [actors.pm, actors.be], client: actors.otherClient });
    const foreignTask = await foreign.task({ assigneeId: actors.be.user.id });
    const created = await request("POST", "/api/comments", actors.be, {
      taskId: foreignTask.id, body: "Foreign internal note",
    });
    success(created, 201);

    denied(await request("GET", `/api/comments?taskId=${foreignTask.id}`, actors.fe));
    denied(await request("POST", "/api/comments", actors.fe, { taskId: foreignTask.id, body: "intrusion" }));
    denied(await request("DELETE", `/api/comments/${created.body.data.id}`, actors.fe));

    const own = await request("GET", query("/api/comments", { filters: { projectId: foreign.project.id } }), actors.be);
    success(own);
    expect(own.body.data).toHaveLength(1);
  });

  it("validates payloads and query params without writing rows or audit entries", async () => {
    const f = await fixture(actors);
    const task = await f.task();
    const before = await f.state();
    for (const payload of [
      { taskId: task.id, body: "   " },
      { taskId: task.id, body: "" },
      { taskId: task.id, body: "x".repeat(4001) },
      { taskId: task.id },
      { body: "missing task id" },
      { taskId: task.id, body: "ok", extra: true },
      { taskId: "not-a-uuid", body: "ok" },
    ]) invalid(await request("POST", "/api/comments", actors.fe, payload));
    invalid(await request("GET", "/api/comments?taskId=not-a-uuid", actors.fe));
    invalid(await request("GET", query("/api/comments", { orderKey: "password" }), actors.fe));
    invalid(await request("GET", query("/api/comments", { filters: { body: "x" } }), actors.fe));

    expect(await f.state()).toEqual(before);
    expect(await prisma.comment.count({ where: { taskId: task.id } })).toBe(0);
  });
});
