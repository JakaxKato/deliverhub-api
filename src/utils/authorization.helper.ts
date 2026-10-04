import { type Department, type Prisma, Role, type Task, TaskStatus } from "@prisma/client";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AuthUser } from "../types";

export function projectAccessWhere(
  user: Pick<AuthUser, "role" | "userId">,
): Prisma.ProjectWhereInput {
  const active: Prisma.ProjectWhereInput = { deletedAt: null };
  if (user.role === Role.PM) return active;
  if (user.role === Role.CLIENT) return { ...active, clientId: user.userId };
  if (user.role === Role.MEMBER) {
    return {
      ...active,
      members: { some: { userId: user.userId, deletedAt: null, user: { deletedAt: null } } },
    };
  }
  return { ...active, id: { in: [] } };
}

export function taskAccessWhere(user: Pick<AuthUser, "role" | "userId">): Prisma.TaskWhereInput {
  return {
    deletedAt: null,
    project: { is: projectAccessWhere(user) },
    ...(user.role === Role.CLIENT ? { isClientVisible: true } : {}),
  };
}

export async function requireProject(db: Prisma.TransactionClient, user: AuthUser, id: string) {
  z.string().uuid().parse(id);
  const project = await db.project.findFirst({
    where: { AND: [{ id }, projectAccessWhere(user)] },
  });
  if (!project) throw new HTTPException(404, { message: "Project not found." });
  return project;
}

export async function requireTask(db: Prisma.TransactionClient, user: AuthUser, id: string) {
  z.string().uuid().parse(id);
  const task = await db.task.findFirst({ where: { AND: [{ id }, taskAccessWhere(user)] } });
  if (!task) throw new HTTPException(404, { message: "Task not found." });
  return task;
}

export async function assertActiveActor(tx: Prisma.TransactionClient, user: AuthUser) {
  // Shared locks hold identity/session validity until commit. A revocation or
  // demotion that wins the race is observed again on every serialization retry.
  const users = await tx.$queryRaw<
    { role: string; department: string }[]
  >`SELECT "role", "department" FROM "users" WHERE "id" = ${user.userId} AND "deletedAt" IS NULL FOR SHARE`;
  const sessions = await tx.$queryRaw<
    { jti: string }[]
  >`SELECT "jti" FROM "sessions" WHERE "jti" = ${user.sessionId} AND "userId" = ${user.userId} AND "revokedAt" IS NULL AND "expiresAt" > ${new Date()} FOR SHARE`;
  if (
    users.length !== 1 ||
    sessions.length !== 1 ||
    users[0]?.role !== user.role ||
    users[0]?.department !== user.department
  ) {
    throw new HTTPException(401, { message: "Session authorization changed. Sign in again." });
  }
}

export function requireInternal(user: AuthUser) {
  if (user.role !== Role.PM && user.role !== Role.MEMBER) {
    throw new HTTPException(403, { message: "Clients are read-only." });
  }
}

export function taskPermissions(user: AuthUser, task: Task, isBlocked: boolean) {
  const pm = user.role === Role.PM;
  const member = user.role === Role.MEMBER;
  const executor = member && task.assigneeId === user.userId;
  return {
    canEdit: pm,
    canStart: executor && task.status === TaskStatus.TODO && !isBlocked,
    canComplete: executor && task.status === TaskStatus.IN_PROGRESS && !isBlocked,
    canChangeStatus: pm || executor,
    canManageDependencies: pm,
    canAttach: pm || member,
    canDelete: pm,
  };
}

export async function validateTaskAssignee(
  db: Prisma.TransactionClient,
  projectId: string,
  assigneeId: string | null | undefined,
  department: Department,
) {
  if (!assigneeId) return;
  const assignee = await db.user.findFirst({
    where: {
      id: assigneeId,
      deletedAt: null,
      role: Role.MEMBER,
      department,
      projectMemberships: { some: { projectId, deletedAt: null } },
    },
    select: { id: true },
  });
  if (!assignee)
    throw new HTTPException(400, {
      message: "Assignee must be an active member of this project and task department.",
    });
}
