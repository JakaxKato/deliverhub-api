import { type Prisma, Role } from "@prisma/client";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { prisma } from "../../db/prisma";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { requireRole } from "../../middlewares/rbac.middleware";
import type { AuthUser } from "../../types";
import { recordAuditLog } from "../../utils/audit.helper";
import {
  assertActiveActor,
  projectAccessWhere,
  requireProject,
  taskAccessWhere,
} from "../../utils/authorization.helper";
import { buildPrismaQuery, parseQueryParams } from "../../utils/ezfilter.helper";
import { serializableTransaction, withProjectTransaction } from "../../utils/transaction.helper";

const projectRoutes = new Hono();

projectRoutes.use("*", authMiddleware);

const projectMemberIdsSchema = z
  .array(z.string().uuid())
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "Duplicate memberIds are not allowed.",
  });

const createProjectSchema = z.object({
  key: z.string().min(2).max(10).toUpperCase(),
  name: z.string().min(3),
  description: z.string().optional(),
  clientId: z.string().uuid().optional().nullable(),
  memberIds: projectMemberIdsSchema.optional(),
});

// Keys remain immutable so existing task codes retain their project prefix.
const updateProjectSchema = z
  .object({
    name: z.string().min(3).optional(),
    description: z.string().nullable().optional(),
    clientId: z.string().uuid().nullable().optional(),
    memberIds: projectMemberIdsSchema.optional(),
  })
  .strict();

function clientProjectSelect(user: AuthUser) {
  return {
    id: true,
    key: true,
    name: true,
    description: true,
    createdAt: true,
    updatedAt: true,
    _count: { select: { tasks: { where: taskAccessWhere(user) } } },
  } satisfies Prisma.ProjectSelect;
}

// List Projects (with ezfilter support and multi-tenant isolation)
projectRoutes.get("/", async (c) => {
  const user = c.get("user");
  const filteringQuery = parseQueryParams(c, "projects");
  if (
    user.role === Role.CLIENT &&
    filteringQuery.filters &&
    Object.hasOwn(filteringQuery.filters, "clientId")
  ) {
    throw new HTTPException(400, { message: "Clients cannot filter projects by clientId." });
  }

  const baseQuery = buildPrismaQuery(filteringQuery);
  const where: Prisma.ProjectWhereInput = {
    AND: [projectAccessWhere(user), baseQuery.where || {}],
  };
  const query = {
    where,
    orderBy: baseQuery.orderBy as Prisma.ProjectOrderByWithRelationInput[],
    skip: baseQuery.skip,
    take: baseQuery.take,
  };

  const [projects, total] = await Promise.all([
    user.role === Role.CLIENT
      ? prisma.project.findMany({ ...query, select: clientProjectSelect(user) })
      : prisma.project.findMany({
          ...query,
          include: {
            client: {
              select: { id: true, name: true, email: true },
            },
            members: {
              where: { deletedAt: null, user: { deletedAt: null } },
              include: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                    role: true,
                    department: true,
                    avatarUrl: true,
                  },
                },
              },
            },
            _count: {
              select: { tasks: { where: taskAccessWhere(user) } },
            },
          },
        }),
    prisma.project.count({ where }),
  ]);

  return c.json({
    success: true,
    data: projects,
    meta: {
      page: filteringQuery.page,
      rows: filteringQuery.rows,
      total,
      totalPages: Math.ceil(total / filteringQuery.rows),
    },
  });
});

// Get Project Details
projectRoutes.get("/:id", async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("id");

  await requireProject(prisma, user, projectId);
  const where: Prisma.ProjectWhereInput = { AND: [{ id: projectId }, projectAccessWhere(user)] };
  if (user.role === Role.CLIENT) {
    const project = await prisma.project.findFirst({ where, select: clientProjectSelect(user) });
    if (!project) throw new HTTPException(404, { message: "Project not found." });
    return c.json({ success: true, data: project });
  }

  const project = await prisma.project.findFirst({
    where,
    include: {
      client: {
        select: { id: true, name: true, email: true },
      },
      members: {
        where: { deletedAt: null, user: { deletedAt: null } },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              role: true,
              department: true,
              avatarUrl: true,
            },
          },
        },
      },
    },
  });

  if (!project) {
    return c.json({ success: false, error: "Not Found", message: "Project not found." }, 404);
  }

  return c.json({
    success: true,
    data: project,
  });
});

// Get Project Aggregate Metrics (for Client and Executive view)
projectRoutes.get("/:id/metrics", async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("id");

  await requireProject(prisma, user, projectId);

  const taskWhere: Prisma.TaskWhereInput = {
    AND: [{ projectId }, taskAccessWhere(user)],
  };

  const tasks = await prisma.task.findMany({
    where: taskWhere,
    select: {
      id: true,
      status: true,
      department: true,
      isClientVisible: true,
    },
  });

  const totalTasks = tasks.length;
  const completedTasks = tasks.filter((t) => t.status === "DONE").length;
  const inProgressTasks = tasks.filter((t) => t.status === "IN_PROGRESS").length;
  const blockedTasks = tasks.filter((t) => t.status === "BLOCKED").length;
  const todoTasks = tasks.filter((t) => t.status === "TODO").length;

  const percentageComplete = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  const metrics = {
    projectId,
    totalTasks,
    completedTasks,
    inProgressTasks,
    blockedTasks,
    todoTasks,
    percentageComplete,
    percentageFormatted: `${percentageComplete}% Complete`,
  };
  if (user.role === Role.CLIENT) {
    return c.json({ success: true, data: metrics });
  }

  // Department breakdown is internal only.
  const departmentBreakdown: Record<
    string,
    { total: number; completed: number; inProgress: number }
  > = {};
  for (const t of tasks) {
    let entry = departmentBreakdown[t.department];
    if (!entry) {
      entry = { total: 0, completed: 0, inProgress: 0 };
      departmentBreakdown[t.department] = entry;
    }
    entry.total += 1;
    if (t.status === "DONE") entry.completed += 1;
    if (t.status === "IN_PROGRESS") entry.inProgress += 1;
  }

  return c.json({
    success: true,
    data: { ...metrics, departmentBreakdown },
  });
});

// Create Project (PM only)
projectRoutes.post("/", requireRole(Role.PM), async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const data = createProjectSchema.parse(body);

  const memberIds = data.memberIds ?? [user.userId];
  const project = await serializableTransaction(async (tx) => {
    await assertActiveActor(tx, user);
    const existingKey = await tx.project.findUnique({ where: { key: data.key } });
    if (existingKey) {
      throw new HTTPException(409, { message: `Project key '${data.key}' is already in use.` });
    }

    if (data.clientId) {
      const client = await tx.user.findFirst({
        where: { id: data.clientId, role: Role.CLIENT, deletedAt: null },
        select: { id: true },
      });
      if (!client) {
        throw new HTTPException(400, { message: "clientId must identify an active client." });
      }
    }

    const members = await tx.user.findMany({
      where: { id: { in: memberIds }, role: { in: [Role.PM, Role.MEMBER] }, deletedAt: null },
      select: { id: true },
    });
    if (members.length !== memberIds.length) {
      throw new HTTPException(400, {
        message: "memberIds must identify active project managers or members.",
      });
    }

    const created = await tx.project.create({
      data: {
        key: data.key,
        name: data.name,
        description: data.description,
        clientId: data.clientId,
        members: {
          create: memberIds.map((id) => ({ userId: id })),
        },
      },
      include: {
        members: {
          include: {
            user: {
              select: { id: true, name: true, email: true, role: true, department: true },
            },
          },
        },
      },
    });

    await recordAuditLog(
      {
        projectId: created.id,
        userId: user.userId,
        action: "PROJECT_CREATED",
        changedColumn: "project",
        newValue: created.name,
      },
      tx,
    );
    return created;
  });

  return c.json(
    {
      success: true,
      message: "Project created successfully",
      data: project,
    },
    201,
  );
});

// Update Project Details and Memberships (PM only)
projectRoutes.put("/:id", requireRole(Role.PM), async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("id");
  const data = updateProjectSchema.parse(await c.req.json());

  const project = await withProjectTransaction(projectId, async (tx) => {
    await assertActiveActor(tx, user);
    const current = await requireProject(tx, user, projectId);

    if (data.clientId) {
      const client = await tx.user.findFirst({
        where: { id: data.clientId, role: Role.CLIENT, deletedAt: null },
        select: { id: true },
      });
      if (!client) {
        throw new HTTPException(400, { message: "clientId must identify an active client." });
      }
    }

    if (data.memberIds !== undefined) {
      const members = await tx.user.findMany({
        where: {
          id: { in: data.memberIds },
          role: { in: [Role.PM, Role.MEMBER] },
          deletedAt: null,
        },
        select: { id: true },
      });
      if (members.length !== data.memberIds.length) {
        throw new HTTPException(400, {
          message: "memberIds must identify active project managers or members.",
        });
      }
    }

    const fieldChanges = (["name", "description", "clientId"] as const)
      .filter((field) => data[field] !== undefined && data[field] !== current[field])
      .map((field) => ({ field, oldValue: current[field], newValue: data[field] ?? null }));
    const memberships =
      data.memberIds === undefined ? [] : await tx.projectMember.findMany({ where: { projectId } });
    const membershipsByUser = new Map(memberships.map((member) => [member.userId, member]));
    const requestedMembers = new Set(data.memberIds ?? []);
    const removedMembers = memberships.filter(
      (member) => member.deletedAt === null && !requestedMembers.has(member.userId),
    );
    const addedMemberIds = (data.memberIds ?? []).filter((id) => {
      const membership = membershipsByUser.get(id);
      return !membership || membership.deletedAt !== null;
    });

    if (fieldChanges.length === 0 && removedMembers.length === 0 && addedMemberIds.length === 0) {
      throw new HTTPException(422, { message: "No project changes were supplied." });
    }

    const changedAt = new Date();
    for (const member of removedMembers) {
      await tx.projectMember.update({
        where: { id: member.id },
        data: { deletedAt: changedAt },
      });
      await recordAuditLog(
        {
          projectId,
          userId: user.userId,
          action: "MEMBER_REMOVED",
          changedColumn: "members",
          oldValue: member.userId,
          newValue: null,
          metadata: { membershipId: member.id, deletedAt: changedAt.toISOString() },
        },
        tx,
      );
    }

    for (const memberId of addedMemberIds) {
      const previous = membershipsByUser.get(memberId);
      // Reuse the unique membership row; immutable audit entries retain each removal.
      const membership = previous
        ? await tx.projectMember.update({
            where: { projectId_userId: { projectId, userId: memberId } },
            data: { deletedAt: null, assignedAt: changedAt },
          })
        : await tx.projectMember.create({
            data: { projectId, userId: memberId, assignedAt: changedAt },
          });
      await recordAuditLog(
        {
          projectId,
          userId: user.userId,
          action: "MEMBER_ADDED",
          changedColumn: "members",
          oldValue: null,
          newValue: memberId,
          metadata: {
            membershipId: membership.id,
            reactivated: previous !== undefined,
            previousDeletedAt: previous?.deletedAt?.toISOString() ?? null,
            previousAssignedAt: previous?.assignedAt.toISOString() ?? null,
          },
        },
        tx,
      );
    }

    const updated = await tx.project.update({
      where: { id: projectId },
      data: {
        name: data.name,
        description: data.description,
        clientId: data.clientId,
        updatedAt: changedAt,
      },
      include: {
        client: { select: { id: true, name: true, email: true } },
        members: {
          where: { deletedAt: null, user: { deletedAt: null } },
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                role: true,
                department: true,
                avatarUrl: true,
              },
            },
          },
        },
      },
    });
    for (const change of fieldChanges) {
      await recordAuditLog(
        {
          projectId,
          userId: user.userId,
          action: "PROJECT_UPDATED",
          changedColumn: change.field,
          oldValue: change.oldValue,
          newValue: change.newValue,
        },
        tx,
      );
    }
    return updated;
  });

  return c.json({ success: true, message: "Project updated successfully", data: project });
});

// Soft Delete Project (PM only)
projectRoutes.delete("/:id", requireRole(Role.PM), async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("id");

  await withProjectTransaction(projectId, async (tx) => {
    await assertActiveActor(tx, user);
    await requireProject(tx, user, projectId);
    const deletedAt = new Date();
    await tx.project.update({
      where: { id: projectId },
      data: { deletedAt },
    });

    await recordAuditLog(
      {
        projectId,
        userId: user.userId,
        action: "PROJECT_SOFT_DELETED",
        changedColumn: "deletedAt",
        newValue: deletedAt.toISOString(),
      },
      tx,
    );
  });

  return c.json({
    success: true,
    message: "Project soft-deleted successfully",
  });
});

export { projectRoutes };
