import { randomBytes, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient, User } from "@prisma/client";
import type { Hono } from "hono";
import { expect } from "bun:test";

export interface Actor {
  user: User;
  token: string;
}
export interface Actors {
  pm: Actor;
  fe: Actor;
  be: Actor;
  uiux: Actor;
  client: Actor;
  outsider: Actor;
  otherClient: Actor;
}
export interface ApiBody {
  success: boolean;
  // The real JSON boundary is deliberately checked at runtime rather than trusting route types.
  data: any;
  meta?: { page: number; rows: number; total: number; totalPages: number };
  error?: string;
  message?: string;
}
export interface ApiResult {
  response: Response;
  body: ApiBody;
}

export function createHarness(app: Hono, prisma: PrismaClient) {
  async function request(method: string, path: string, actor?: Actor, payload?: unknown): Promise<ApiResult> {
    const response = await app.request(path, {
      method,
      headers: {
        ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}),
        ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const body: ApiBody = response.status === 204
      ? { success: true, data: null }
      : await response.json() as ApiBody;
    return { response, body };
  }
  async function login(email: string, password = process.env.SEED_PASSWORD!): Promise<Actor> {
    const result = await request("POST", "/api/auth/login", undefined, { email, password });
    success(result, 200);
    expect(typeof result.body.data.token).toBe("string");
    expect(result.body.data.user).not.toHaveProperty("password");
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    return { user, token: result.body.data.token };
  }
  async function extraActor(role: User["role"] = "MEMBER"): Promise<Actor> {
    const password = process.env.SEED_PASSWORD!;
    // PM/CLIENT accounts are provisioned fixtures, never created through public registration.
    const { default: bcrypt } = await import("bcryptjs");
    const user = await prisma.user.create({
      data: {
        email: `${randomUUID()}@integration.invalid`, name: `Private actor ${randomUUID()}`,
        role, department: role === "CLIENT" ? "CLIENT" : role === "PM" ? "PRODUCT" : "FRONTEND",
        password: await bcrypt.hash(password, 4),
      },
    });
    return login(user.email, password);
  }
  async function fixture(actors: Actors, options: { members?: Actor[]; client?: Actor | null } = {}) {
    const project = await prisma.project.create({
      data: {
        key: `T${randomBytes(4).toString("hex").toUpperCase()}`,
        name: `Integration project ${randomUUID()}`,
        clientId: options.client === null ? null : (options.client ?? actors.client).user.id,
        members: { create: (options.members ?? [actors.pm, actors.fe, actors.be]).map((actor) => ({ userId: actor.user.id })) },
      },
    });
    async function task(overrides: Partial<Prisma.TaskUncheckedCreateInput> = {}) {
      return prisma.task.create({
        data: {
          projectId: project.id, taskCode: `${project.key}-${randomBytes(4).toString("hex")}`,
          title: `Deliverable ${randomUUID()}`, creatorId: actors.pm.user.id,
          assigneeId: actors.fe.user.id, department: "FRONTEND", status: "TODO", isClientVisible: true,
          ...overrides,
        },
      });
    }
    async function state() {
      return {
        project: await prisma.project.findUnique({ where: { id: project.id } }),
        tasks: await prisma.task.findMany({ where: { projectId: project.id }, orderBy: { id: "asc" } }),
        edges: await prisma.taskDependency.findMany({ where: { task: { projectId: project.id } }, orderBy: { id: "asc" } }),
        attachments: await prisma.taskAttachment.findMany({ where: { task: { projectId: project.id } }, orderBy: { id: "asc" } }),
        audits: await prisma.auditLog.findMany({ where: { projectId: project.id }, orderBy: { id: "asc" } }),
      };
    }
    return { project, task, state };
  }
  return { request, login, extraActor, fixture };
}

export function success(result: ApiResult, status = 200): void {
  expect(result.response.status).toBe(status);
  expect(result.body.success).toBe(true);
}
export function denied(result: ApiResult): void {
  expect([403, 404]).toContain(result.response.status);
  expect(result.body.success).toBe(false);
}
export function invalid(result: ApiResult, status = 400): void {
  expect(result.response.status).toBe(status);
  expect(result.body.success).toBe(false);
}
export function query(path: string, params: Record<string, unknown>): string {
  const values = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    values.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  return `${path}?${values}`;
}

export const permissionKeys = [
  "canEdit", "canStart", "canComplete", "canChangeStatus", "canManageDependencies", "canAttach", "canDelete",
] as const;
export function permissions(data: any): Record<typeof permissionKeys[number], boolean> {
  expect(Object.keys(data.permissions).sort()).toEqual([...permissionKeys].sort());
  for (const key of permissionKeys) expect(typeof data.permissions[key]).toBe("boolean");
  return data.permissions;
}

const privateKeys = new Set([
  "assignee", "assigneeId", "creator", "creatorId", "uploader", "uploaderId", "user", "userId",
  "email", "password", "nameOfAssignee", "assigneeName", "completedBy", "avatarUrl", "department",
  "departmentBreakdown", "audit", "auditLogs", "auditLog", "client", "clientId", "members",
  "projectMemberships", "clientProjects", "metadata", "identity", "identities", "dept",
  "actor", "actorId", "role", "creatorName", "uploaderName", "memberIds", "userName",
  "createdBy", "createdById", "updatedBy", "updatedById", "PRODUCT", "UIUX", "FRONTEND", "BACKEND",
]);
/** Checks omitted keys, not merely null values or "Assigned Specialist" placeholders. */
export function assertClientSafe(value: unknown, forbiddenValues: string[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((item) => assertClientSafe(item, forbiddenValues));
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      expect(privateKeys.has(key) ? key : undefined).toBeUndefined();
      assertClientSafe(item, forbiddenValues);
    }
  } else if (typeof value === "string") {
    for (const forbidden of forbiddenValues) expect(value).not.toContain(forbidden);
  }
}
