import { Role } from "@prisma/client";
import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../../db/prisma";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { checkProjectAccess, requireRole } from "../../middlewares/rbac.middleware";
import { recordAuditLog } from "../../utils/audit.helper";
import { buildPrismaQuery, parseQueryParams } from "../../utils/ezfilter.helper";

const projectRoutes = new Hono();

projectRoutes.use("*", authMiddleware);

const createProjectSchema = z.object({
  key: z.string().min(2).max(10).toUpperCase(),
  name: z.string().min(3),
  description: z.string().optional(),
  clientId: z.string().uuid().optional().nullable(),
  memberIds: z.array(z.string().uuid()).optional(),
});

// List Projects (with ezfilter support and multi-tenant isolation)
projectRoutes.get("/", async (c) => {
  const user = c.get("user");
  const filteringQuery = parseQueryParams(c);

  const baseQuery = buildPrismaQuery(filteringQuery);

  // Access control scoping:
  const accessFilter: any = {
    deletedAt: null,
  };

  if (user.role === Role.CLIENT) {
    accessFilter.clientId = user.userId;
  } else if (user.role === Role.MEMBER) {
    accessFilter.members = {
      some: {
        userId: user.userId,
      },
    };
  }

  // Merge access filter with ezfilter where conditions
  const where = {
    AND: [accessFilter, baseQuery.where || {}],
  };

  const [projects, total] = await Promise.all([
    prisma.project.findMany({
      where,
      orderBy:
        baseQuery.orderBy && Object.keys(baseQuery.orderBy).length > 0
          ? baseQuery.orderBy
          : { createdAt: "desc" },
      skip: baseQuery.skip,
      take: baseQuery.take,
      include: {
        client: {
          select: { id: true, name: true, email: true },
        },
        members: {
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
          select: { tasks: { where: { deletedAt: null } } },
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
      totalPages: Math.ceil(total / (filteringQuery.rows || 20)),
    },
  });
});

// Get Project Details
projectRoutes.get("/:id", async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("id");

  const hasAccess = await checkProjectAccess(user.userId, user.role, projectId);
  if (!hasAccess) {
    return c.json(
      { success: false, error: "Forbidden", message: "You do not have access to this project." },
      403,
    );
  }

  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    include: {
      client: {
        select: { id: true, name: true, email: true },
      },
      members: {
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

  const hasAccess = await checkProjectAccess(user.userId, user.role, projectId);
  if (!hasAccess) {
    return c.json(
      { success: false, error: "Forbidden", message: "You do not have access to this project." },
      403,
    );
  }

  // If Client, calculate metrics ONLY for client-visible tasks!
  const taskWhere: any = {
    projectId,
    deletedAt: null,
  };

  if (user.role === Role.CLIENT) {
    taskWhere.isClientVisible = true;
  }

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

  // Department breakdown
  const departmentBreakdown: Record<
    string,
    { total: number; completed: number; inProgress: number }
  > = {};
  for (const t of tasks) {
    if (!departmentBreakdown[t.department]) {
      departmentBreakdown[t.department] = { total: 0, completed: 0, inProgress: 0 };
    }
    departmentBreakdown[t.department].total += 1;
    if (t.status === "DONE") departmentBreakdown[t.department].completed += 1;
    if (t.status === "IN_PROGRESS") departmentBreakdown[t.department].inProgress += 1;
  }

  return c.json({
    success: true,
    data: {
      projectId,
      totalTasks,
      completedTasks,
      inProgressTasks,
      blockedTasks,
      todoTasks,
      percentageComplete,
      percentageFormatted: `${percentageComplete}% Complete`,
      departmentBreakdown,
    },
  });
});

// Create Project (PM only)
projectRoutes.post("/", requireRole(Role.PM), async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const data = createProjectSchema.parse(body);

  const existingKey = await prisma.project.findUnique({
    where: { key: data.key },
  });

  if (existingKey) {
    return c.json(
      {
        success: false,
        error: "Conflict",
        message: `Project key '${data.key}' is already in use.`,
      },
      409,
    );
  }

  const project = await prisma.project.create({
    data: {
      key: data.key,
      name: data.name,
      description: data.description,
      clientId: data.clientId,
      members: {
        create: (data.memberIds || [user.userId]).map((id) => ({
          userId: id,
        })),
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

  await recordAuditLog({
    projectId: project.id,
    userId: user.userId,
    action: "PROJECT_CREATED",
    changedColumn: "project",
    newValue: project.name,
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

// Soft Delete Project (PM only)
projectRoutes.delete("/:id", requireRole(Role.PM), async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("id");

  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
  });

  if (!project) {
    return c.json({ success: false, error: "Not Found", message: "Project not found." }, 404);
  }

  await prisma.project.update({
    where: { id: projectId },
    data: { deletedAt: new Date() },
  });

  await recordAuditLog({
    projectId,
    userId: user.userId,
    action: "PROJECT_SOFT_DELETED",
    changedColumn: "deletedAt",
    newValue: new Date().toISOString(),
  });

  return c.json({
    success: true,
    message: "Project soft-deleted successfully",
  });
});

export { projectRoutes };
