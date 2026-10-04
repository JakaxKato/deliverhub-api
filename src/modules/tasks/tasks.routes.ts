import { Department, Priority, Prisma, Role, type Task, TaskStatus } from "@prisma/client";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { prisma } from "../../db/prisma";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { errorHandler } from "../../middlewares/error.middleware";
import { requireRole } from "../../middlewares/rbac.middleware";
import type { AuthUser } from "../../types";
import { recordAuditLog } from "../../utils/audit.helper";
import {
  assertActiveActor,
  requireInternal,
  requireProject,
  requireTask,
  taskAccessWhere,
  taskPermissions,
  validateTaskAssignee,
} from "../../utils/authorization.helper";
import { wouldCreateCycle } from "../../utils/cycle-detector";
import { buildPrismaQuery, parseQueryParams } from "../../utils/ezfilter.helper";
import { withProjectTransaction } from "../../utils/transaction.helper";

const taskRoutes = new Hono();
taskRoutes.use("*", authMiddleware);
const versionSchema = z.number().int().min(1).max(2147483647);
const versionBody = z.object({ version: versionSchema }).strict();
const departmentSchema = z.enum([Department.UIUX, Department.FRONTEND, Department.BACKEND]);
const requireTaskManager: MiddlewareHandler = async (c, next) => {
  await requireTask(prisma, c.get("user"), c.req.param("id") ?? "");
  if (c.get("user").role !== Role.PM)
    throw new HTTPException(403, {
      message: "Only project managers may manage task details and dependencies.",
    });
  await next();
};

const taskInclude = {
  project: { select: { id: true, name: true, key: true } },
  assignee: { select: { id: true, name: true, email: true, department: true, avatarUrl: true } },
  creator: { select: { id: true, name: true, email: true, department: true } },
  dependencies: {
    where: { deletedAt: null, prerequisiteTask: { deletedAt: null, project: { deletedAt: null } } },
    include: { prerequisiteTask: true },
  },
  dependents: {
    where: { deletedAt: null, task: { deletedAt: null, project: { deletedAt: null } } },
    include: {
      task: { select: { id: true, taskCode: true, title: true, status: true, department: true } },
    },
  },
  attachments: {
    where: { deletedAt: null },
    include: { uploader: { select: { id: true, name: true } } },
  },
} satisfies Prisma.TaskInclude;
type LoadedTask = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;

function prerequisiteDto(task: Task) {
  return { id: task.id, taskCode: task.taskCode, title: task.title, status: task.status };
}

function taskDto(task: LoadedTask, user: AuthUser) {
  const pending = task.dependencies
    .map((edge) => edge.prerequisiteTask)
    .filter((p) => p.status !== TaskStatus.DONE);
  const isBlocked = pending.length > 0;
  if (user.role === Role.CLIENT) {
    const visible = task.dependencies
      .map((edge) => edge.prerequisiteTask)
      .filter((p) => p.projectId === task.projectId && p.isClientVisible);
    const hiddenBlocker = pending.some((p) => p.projectId !== task.projectId || !p.isClientVisible);
    return {
      id: task.id,
      taskCode: task.taskCode,
      projectId: task.projectId,
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      isClientVisible: task.isClientVisible,
      dueDate: task.dueDate,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      attachments: task.attachments.map((attachment) => ({
        id: attachment.id,
        fileName: attachment.fileName,
        fileUrl: attachment.fileUrl,
        fileType: attachment.fileType,
        fileSize: attachment.fileSize,
        createdAt: attachment.createdAt,
      })),
      dependencies: visible.map(prerequisiteDto),
      isBlocked,
      blockedReason: isBlocked
        ? hiddenBlocker
          ? "Blocked by an incomplete prerequisite."
          : "Awaiting completion of visible prerequisites."
        : null,
      pendingPrerequisites: visible
        .filter((p) => p.status !== TaskStatus.DONE)
        .map(prerequisiteDto),
    };
  }
  const internalPending = pending
    .filter((p) => p.projectId === task.projectId)
    .map((p) => ({ ...prerequisiteDto(p), department: p.department }));
  return {
    ...task,
    dependencies: task.dependencies
      .filter((edge) => edge.prerequisiteTask.projectId === task.projectId)
      .map((edge) => ({
        id: edge.id,
        taskId: edge.taskId,
        prerequisiteTaskId: edge.prerequisiteTaskId,
        createdAt: edge.createdAt,
        prerequisiteTask: {
          ...prerequisiteDto(edge.prerequisiteTask),
          department: edge.prerequisiteTask.department,
        },
      })),
    isBlocked,
    pendingPrerequisites: internalPending,
    blockedReason: isBlocked
      ? `Blocked by: ${internalPending.map((p) => `${p.taskCode} (${p.title})`).join(", ") || "an incomplete prerequisite"}`
      : null,
    permissions: taskPermissions(user, task, isBlocked),
  };
}

async function loadTaskDto(db: Prisma.TransactionClient, user: AuthUser, taskId: string) {
  const task = await db.task.findFirst({
    where: { AND: [{ id: taskId }, taskAccessWhere(user)] },
    include: taskInclude,
  });
  if (!task) throw new HTTPException(404, { message: "Task not found." });
  return taskDto(task, user);
}

export async function getTaskDependencyStatus(
  taskId: string,
  db: Prisma.TransactionClient = prisma,
) {
  const task = await db.task.findFirst({
    where: { id: taskId, deletedAt: null, project: { deletedAt: null } },
  });
  if (!task) throw new HTTPException(404, { message: "Task not found." });
  const edges = await db.taskDependency.findMany({
    where: {
      taskId,
      deletedAt: null,
      prerequisiteTask: {
        deletedAt: null,
        projectId: task.projectId,
        project: { deletedAt: null },
      },
    },
    include: {
      prerequisiteTask: {
        select: { id: true, taskCode: true, title: true, status: true, department: true },
      },
    },
  });
  const dependencies = edges.map((edge) => edge.prerequisiteTask);
  const pendingPrerequisites = dependencies.filter((p) => p.status !== TaskStatus.DONE);
  return {
    dependencies,
    pendingPrerequisites,
    isBlocked: pendingPrerequisites.length > 0,
    blockedReason: pendingPrerequisites.length
      ? `Blocked by: ${pendingPrerequisites.map((p) => `${p.taskCode} (${p.title})`).join(", ")}`
      : null,
  };
}

class TaskConflict extends Error {
  constructor(
    readonly taskId: string,
    readonly clientVersion: number,
    message = "This task was modified concurrently. Reload and review the latest version.",
  ) {
    super(message);
  }
}

taskRoutes.onError(async (error, c) => {
  if (error instanceof TaskConflict) {
    try {
      const latestData = await loadTaskDto(prisma, c.get("user"), error.taskId);
      if (!("version" in latestData))
        throw new HTTPException(403, { message: "Clients are read-only." });
      return c.json(
        {
          success: false,
          error: "Conflict",
          message: error.message,
          latestData,
          serverVersion: latestData.version,
          clientVersion: error.clientVersion,
        },
        409,
      );
    } catch (lookupError) {
      return errorHandler(
        lookupError instanceof Error ? lookupError : new Error("Snapshot unavailable"),
        c,
      );
    }
  }
  if (
    error instanceof HTTPException &&
    error.status === 422 &&
    error.message.startsWith("TaskBlocked:")
  ) {
    return c.json({ success: false, error: "TaskBlocked", message: error.message }, 422);
  }
  if (
    error instanceof HTTPException &&
    error.status === 400 &&
    error.message.startsWith("Circular dependency")
  ) {
    return c.json({ success: false, error: "CircularDependency", message: error.message }, 400);
  }
  return errorHandler(error, c);
});

function checkVersion(task: Task, version: number) {
  if (task.version !== version) throw new TaskConflict(task.id, version);
}

async function bumpTask(
  tx: Prisma.TransactionClient,
  user: AuthUser,
  task: Task,
  version: number,
  data: Prisma.TaskUpdateManyMutationInput = {},
) {
  const result = await tx.task.updateMany({
    where: { AND: [{ id: task.id, version }, taskAccessWhere(user)] },
    data: { ...data, version: { increment: 1 } },
  });
  if (result.count !== 1) throw new TaskConflict(task.id, version);
}

async function taskMutation<T>(
  user: AuthUser,
  taskId: string,
  version: number,
  work: (tx: Prisma.TransactionClient, task: Task) => Promise<T>,
) {
  const resolved = await requireTask(prisma, user, taskId);
  try {
    return await withProjectTransaction(resolved.projectId, async (tx) => {
      await assertActiveActor(tx, user);
      const task = await requireTask(tx, user, taskId);
      checkVersion(task, version);
      return work(tx, task);
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034")
      throw new TaskConflict(
        taskId,
        version,
        "Concurrent mutation could not be committed. Reload before retrying.",
      );
    throw error;
  }
}

async function mutationBody<T>(c: Context, schema: z.ZodType<T>) {
  await requireTask(prisma, c.get("user"), c.req.param("id") ?? "");
  requireInternal(c.get("user"));
  // Resource resolution intentionally precedes payload validation, so deleted or
  // inaccessible tasks cannot become an input-validation/existence oracle.
  const body: unknown = await c.req.json().catch(() => {
    throw new HTTPException(400, { message: "A valid JSON mutation body is required." });
  });
  return schema.parse(body);
}

async function statusAudit(
  tx: Prisma.TransactionClient,
  user: AuthUser,
  task: Task,
  next: TaskStatus,
  action: string,
) {
  await recordAuditLog(
    {
      projectId: task.projectId,
      taskId: task.id,
      userId: user.userId,
      action,
      changedColumn: "status",
      oldValue: task.status,
      newValue: next,
    },
    tx,
  );
}

// Recompute in topological order, so diamond graphs block/unblock each affected
// task once. Project locking prevents concurrent graph edits and auto-transitions.
async function syncProjectBlocking(
  tx: Prisma.TransactionClient,
  user: AuthUser,
  projectId: string,
  sourceIds: string[],
  includeSources = false,
) {
  const tasks = await tx.task.findMany({ where: { projectId, deletedAt: null } });
  const edges = await tx.taskDependency.findMany({
    where: {
      deletedAt: null,
      task: { projectId, deletedAt: null },
      prerequisiteTask: { projectId, deletedAt: null },
    },
  });
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const prerequisites = new Map<string, string[]>();
  const affected = new Set<string>(includeSources ? sourceIds : []);
  const queue = [...sourceIds];
  const sources = new Set(sourceIds);
  while (queue.length) {
    const source = queue.shift();
    for (const edge of edges) {
      if (edge.prerequisiteTaskId !== source || affected.has(edge.taskId)) continue;
      affected.add(edge.taskId);
      queue.push(edge.taskId);
    }
  }
  if (!includeSources) for (const id of sources) affected.delete(id);
  for (const edge of edges) {
    const ids = prerequisites.get(edge.taskId) ?? [];
    ids.push(edge.prerequisiteTaskId);
    prerequisites.set(edge.taskId, ids);
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const ordered: Task[] = [];
  function visit(task: Task) {
    if (visited.has(task.id)) return;
    if (visiting.has(task.id))
      throw new HTTPException(400, { message: "Dependency graph contains a cycle." });
    visiting.add(task.id);
    for (const id of prerequisites.get(task.id) ?? []) {
      const prerequisite = byId.get(id);
      if (prerequisite) visit(prerequisite);
    }
    visiting.delete(task.id);
    visited.add(task.id);
    ordered.push(task);
  }
  for (const task of tasks) visit(task);
  for (const task of ordered) {
    if (!affected.has(task.id)) continue;
    const blocked = (prerequisites.get(task.id) ?? []).some(
      (id) => byId.get(id)?.status !== TaskStatus.DONE,
    );
    const next = blocked
      ? TaskStatus.BLOCKED
      : task.status === TaskStatus.BLOCKED
        ? TaskStatus.TODO
        : task.status;
    if (next === task.status) continue;
    await bumpTask(tx, user, task, task.version, { status: next });
    await statusAudit(tx, user, task, next, blocked ? "AUTO_BLOCKED" : "AUTO_UNBLOCKED");
    task.status = next;
    task.version += 1;
  }
}

async function requirePrerequisite(
  tx: Prisma.TransactionClient,
  task: Task,
  prerequisiteId: string,
) {
  if (task.id === prerequisiteId)
    throw new HTTPException(400, { message: "A task cannot depend on itself." });
  const prerequisite = await tx.task.findFirst({
    where: { id: prerequisiteId, deletedAt: null, project: { deletedAt: null } },
  });
  if (!prerequisite) throw new HTTPException(404, { message: "Prerequisite not found." });
  if (prerequisite.projectId !== task.projectId)
    throw new HTTPException(400, { message: "Prerequisites must belong to the same project." });
  return prerequisite;
}

function auditValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

taskRoutes.get("/", async (c) => {
  const user = c.get("user");
  const query = parseQueryParams(c, user.role === Role.CLIENT ? "clientTasks" : "tasks");
  const plan = buildPrismaQuery(query);
  const projectId = c.req.query("projectId");
  if (projectId) await requireProject(prisma, user, projectId);
  const where: Prisma.TaskWhereInput = {
    AND: [taskAccessWhere(user), projectId ? { projectId } : {}, plan.where ?? {}],
  };
  const [tasks, total] = await Promise.all([
    prisma.task.findMany({
      where,
      orderBy: plan.orderBy as Prisma.TaskOrderByWithRelationInput[],
      skip: plan.skip,
      take: plan.take,
      include: taskInclude,
    }),
    prisma.task.count({ where }),
  ]);
  return c.json({
    success: true,
    data: tasks.map((task) => taskDto(task, user)),
    meta: { page: query.page, rows: query.rows, total, totalPages: Math.ceil(total / query.rows) },
  });
});

taskRoutes.get("/:id", async (c) => {
  const user = c.get("user");
  const task = await requireTask(prisma, user, c.req.param("id"));
  const data = await loadTaskDto(prisma, user, task.id);
  if (user.role === Role.CLIENT) return c.json({ success: true, data });
  const auditLogs = await prisma.auditLog.findMany({
    where: { taskId: task.id, projectId: task.projectId },
    orderBy: [{ timestamp: "desc" }, { id: "desc" }],
    take: 50,
    include: {
      user: { select: { id: true, name: true, role: true, department: true, avatarUrl: true } },
    },
  });
  return c.json({ success: true, data: { ...data, auditLogs } });
});

const createTaskSchema = z
  .object({
    projectId: z.string().uuid(),
    title: z.string().trim().min(3).max(300),
    description: z.string().max(20000).optional(),
    department: departmentSchema,
    priority: z.nativeEnum(Priority).default(Priority.MEDIUM),
    isClientVisible: z.boolean().default(false),
    assigneeId: z.string().uuid().nullable().optional(),
    dueDate: z.string().datetime({ offset: true }).nullable().optional(),
    prerequisiteTaskIds: z
      .array(z.string().uuid())
      .max(100)
      .default([])
      .refine((ids) => new Set(ids).size === ids.length, "Prerequisite IDs must be unique."),
  })
  .strict();

taskRoutes.post("/", requireRole(Role.PM), async (c) => {
  const user = c.get("user");
  const data = createTaskSchema.parse(await c.req.json());
  await requireProject(prisma, user, data.projectId);
  const result = await withProjectTransaction(data.projectId, async (tx) => {
    await assertActiveActor(tx, user);
    const project = await requireProject(tx, user, data.projectId);
    await validateTaskAssignee(tx, project.id, data.assigneeId, data.department);
    // Count includes historical rows; collision probing also tolerates imported codes.
    let number = (await tx.task.count({ where: { projectId: project.id } })) + 1;
    let taskCode = `${project.key}-${String(number).padStart(3, "0")}`;
    while (
      await tx.task.findFirst({ where: { projectId: project.id, taskCode }, select: { id: true } })
    ) {
      number += 1;
      taskCode = `${project.key}-${String(number).padStart(3, "0")}`;
    }
    const task = await tx.task.create({
      data: {
        projectId: project.id,
        taskCode,
        title: data.title,
        description: data.description,
        department: data.department,
        priority: data.priority,
        isClientVisible: data.isClientVisible,
        assigneeId: data.assigneeId,
        creatorId: user.userId,
        dueDate: data.dueDate ? new Date(data.dueDate) : null,
      },
    });
    await recordAuditLog(
      {
        projectId: project.id,
        taskId: task.id,
        userId: user.userId,
        action: "TASK_CREATED",
        changedColumn: "title",
        newValue: task.title,
        metadata: {
          description: task.description,
          department: task.department,
          priority: task.priority,
          assigneeId: task.assigneeId,
          dueDate: task.dueDate?.toISOString() ?? null,
          isClientVisible: task.isClientVisible,
        },
      },
      tx,
    );
    for (const id of data.prerequisiteTaskIds) {
      const prerequisite = await requirePrerequisite(tx, task, id);
      if (await wouldCreateCycle(tx, project.id, task.id, id))
        throw new HTTPException(400, { message: "Circular dependency detected." });
      await tx.taskDependency.create({ data: { taskId: task.id, prerequisiteTaskId: id } });
      await recordAuditLog(
        {
          projectId: project.id,
          taskId: task.id,
          userId: user.userId,
          action: "DEPENDENCY_ADDED",
          changedColumn: "dependencies",
          newValue: prerequisite.id,
        },
        tx,
      );
    }
    const dependency = await getTaskDependencyStatus(task.id, tx);
    if (dependency.isBlocked) {
      await tx.task.update({ where: { id: task.id }, data: { status: TaskStatus.BLOCKED } });
      await statusAudit(tx, user, task, TaskStatus.BLOCKED, "AUTO_BLOCKED");
    }
    return loadTaskDto(tx, user, task.id);
  });
  return c.json({ success: true, message: "Task created successfully", data: result }, 201);
});

const detailsSchema = z
  .object({
    version: versionSchema,
    title: z.string().trim().min(3).max(300).optional(),
    description: z.string().max(20000).nullable().optional(),
    department: departmentSchema.optional(),
    priority: z.nativeEnum(Priority).optional(),
    isClientVisible: z.boolean().optional(),
    assigneeId: z.string().uuid().nullable().optional(),
    dueDate: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

taskRoutes.put("/:id", requireTaskManager, async (c) => {
  const user = c.get("user");
  const data = await mutationBody(c, detailsSchema);
  const result = await taskMutation(user, c.req.param("id"), data.version, async (tx, task) => {
    await validateTaskAssignee(
      tx,
      task.projectId,
      data.assigneeId === undefined ? task.assigneeId : data.assigneeId,
      data.department ?? task.department,
    );
    const { version: _version, dueDate, ...fields } = data;
    const changes = {
      ...fields,
      ...(dueDate === undefined ? {} : { dueDate: dueDate === null ? null : new Date(dueDate) }),
    };
    const changedColumns = (Object.keys(changes) as (keyof typeof changes)[]).filter(
      (column) => auditValue(task[column]) !== auditValue(changes[column]),
    );
    if (changedColumns.length === 0)
      throw new HTTPException(422, { message: "No task fields changed." });
    await bumpTask(tx, user, task, data.version, changes);
    for (const column of changedColumns) {
      const oldValue = auditValue(task[column]);
      const newValue = auditValue(changes[column]);
      if (oldValue !== newValue)
        await recordAuditLog(
          {
            projectId: task.projectId,
            taskId: task.id,
            userId: user.userId,
            action: "TASK_UPDATED",
            changedColumn: column,
            oldValue,
            newValue,
          },
          tx,
        );
    }
    return loadTaskDto(tx, user, task.id);
  });
  return c.json({ success: true, message: "Task updated successfully", data: result });
});

const statusSchema = z
  .object({
    version: versionSchema,
    status: z.nativeEnum(TaskStatus),
    note: z.string().max(2000).optional(),
  })
  .strict();
taskRoutes.patch("/:id/status", async (c) => {
  const user = c.get("user");
  const data = await mutationBody(c, statusSchema);
  const result = await taskMutation(user, c.req.param("id"), data.version, async (tx, task) => {
    if (data.status === TaskStatus.IN_PROGRESS || data.status === TaskStatus.DONE) {
      if (user.role === Role.PM || task.assigneeId !== user.userId)
        throw new HTTPException(403, {
          message:
            "Only the assigned member may start or complete execution. Product Managers cannot mark tasks as Done.",
        });
      const dependency = await getTaskDependencyStatus(task.id, tx);
      if (dependency.isBlocked)
        throw new HTTPException(422, {
          message: "TaskBlocked: task has incomplete prerequisite dependencies.",
        });
      if (
        (data.status === TaskStatus.IN_PROGRESS && task.status !== TaskStatus.TODO) ||
        (data.status === TaskStatus.DONE && task.status !== TaskStatus.IN_PROGRESS)
      )
        throw new HTTPException(422, {
          message: "Invalid status transition. Start a TODO task before completing it.",
        });
    } else if (user.role === Role.MEMBER && task.assigneeId !== user.userId) {
      throw new HTTPException(403, {
        message: "Only the assigned member may change this task status.",
      });
    }
    if (task.status === data.status)
      throw new HTTPException(422, { message: "Task already has this status." });
    const dependency = await getTaskDependencyStatus(task.id, tx);
    if (data.status === TaskStatus.TODO && dependency.isBlocked)
      throw new HTTPException(422, {
        message: "TaskBlocked: task has incomplete prerequisite dependencies.",
      });
    await bumpTask(tx, user, task, data.version, { status: data.status });
    await recordAuditLog(
      {
        projectId: task.projectId,
        taskId: task.id,
        userId: user.userId,
        action: "STATUS_CHANGED",
        changedColumn: "status",
        oldValue: task.status,
        newValue: data.status,
        metadata: { note: data.note ?? null },
      },
      tx,
    );
    await syncProjectBlocking(tx, user, task.projectId, [task.id]);
    return loadTaskDto(tx, user, task.id);
  });
  return c.json({ success: true, message: "Task status updated successfully", data: result });
});

const dependencySchema = z
  .object({ version: versionSchema, prerequisiteTaskId: z.string().uuid() })
  .strict();
taskRoutes.post("/:id/dependencies", requireTaskManager, async (c) => {
  const user = c.get("user");
  const data = await mutationBody(c, dependencySchema);
  const result = await taskMutation(user, c.req.param("id"), data.version, async (tx, task) => {
    const prerequisite = await requirePrerequisite(tx, task, data.prerequisiteTaskId);
    if (await wouldCreateCycle(tx, task.projectId, task.id, prerequisite.id))
      throw new HTTPException(400, { message: "Circular dependency detected." });
    if (
      await tx.taskDependency.findFirst({
        where: { taskId: task.id, prerequisiteTaskId: prerequisite.id, deletedAt: null },
      })
    )
      throw new TaskConflict(task.id, data.version, "Dependency already exists.");
    await tx.taskDependency.create({
      data: { taskId: task.id, prerequisiteTaskId: prerequisite.id },
    });
    const blocked = (await getTaskDependencyStatus(task.id, tx)).isBlocked;
    const status = blocked ? TaskStatus.BLOCKED : task.status;
    await bumpTask(tx, user, task, data.version, { status });
    await recordAuditLog(
      {
        projectId: task.projectId,
        taskId: task.id,
        userId: user.userId,
        action: "DEPENDENCY_ADDED",
        changedColumn: "dependencies",
        newValue: prerequisite.id,
      },
      tx,
    );
    if (status !== task.status) await statusAudit(tx, user, task, status, "AUTO_BLOCKED");
    await syncProjectBlocking(tx, user, task.projectId, [task.id]);
    return loadTaskDto(tx, user, task.id);
  });
  return c.json({ success: true, message: "Dependency added successfully", data: result });
});

taskRoutes.delete("/:id/dependencies/:prereqId", requireTaskManager, async (c) => {
  const user = c.get("user");
  const data = await mutationBody(c, versionBody);
  const prerequisiteId = z.string().uuid().parse(c.req.param("prereqId"));
  const result = await taskMutation(user, c.req.param("id"), data.version, async (tx, task) => {
    await requirePrerequisite(tx, task, prerequisiteId);
    const edge = await tx.taskDependency.findFirst({
      where: { taskId: task.id, prerequisiteTaskId: prerequisiteId, deletedAt: null },
    });
    if (!edge) throw new HTTPException(404, { message: "Dependency not found." });
    await tx.taskDependency.update({ where: { id: edge.id }, data: { deletedAt: new Date() } });
    const blocked = (await getTaskDependencyStatus(task.id, tx)).isBlocked;
    const status = !blocked && task.status === TaskStatus.BLOCKED ? TaskStatus.TODO : task.status;
    await bumpTask(tx, user, task, data.version, { status });
    await recordAuditLog(
      {
        projectId: task.projectId,
        taskId: task.id,
        userId: user.userId,
        action: "DEPENDENCY_REMOVED",
        changedColumn: "dependencies",
        oldValue: prerequisiteId,
      },
      tx,
    );
    if (status !== task.status) await statusAudit(tx, user, task, status, "AUTO_UNBLOCKED");
    await syncProjectBlocking(tx, user, task.projectId, [task.id]);
    return loadTaskDto(tx, user, task.id);
  });
  return c.json({ success: true, message: "Dependency removed successfully", data: result });
});

function safeLink(value: string) {
  if (
    [...value].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)
  )
    return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      host.includes(".") &&
      !host.endsWith(".") &&
      !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) &&
      !host.includes(":") &&
      !["localhost", "local", "internal", "test", "invalid"].some(
        (suffix) => host === suffix || host.endsWith(`.${suffix}`),
      )
    );
  } catch {
    return false;
  }
}
const attachmentSchema = z
  .object({
    version: versionSchema,
    fileName: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine(
        (value) =>
          !value.includes("/") &&
          !value.includes("\\") &&
          !value.includes("..") &&
          value !== "." &&
          [...value].every(
            (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
          ),
        "Use a plain filename, not a path.",
      ),
    fileUrl: z
      .string()
      .max(4096)
      .refine(safeLink, "Use an HTTPS link to a public hostname without credentials.")
      .url(),
    fileType: z
      .string()
      .max(127)
      .regex(/^(?:link|[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*)$/)
      .default("link"),
    fileSize: z
      .number()
      .int()
      .min(0)
      .max(25 * 1024 * 1024)
      .optional(),
  })
  .strict();

taskRoutes.post("/:id/attachments", async (c) => {
  const user = c.get("user");
  const data = await mutationBody(c, attachmentSchema);
  const result = await taskMutation(user, c.req.param("id"), data.version, async (tx, task) => {
    requireInternal(user);
    await bumpTask(tx, user, task, data.version);
    const attachment = await tx.taskAttachment.create({
      data: {
        taskId: task.id,
        uploaderId: user.userId,
        fileName: data.fileName,
        fileUrl: data.fileUrl,
        fileType: data.fileType,
        fileSize: data.fileSize,
      },
      include: { uploader: { select: { id: true, name: true } } },
    });
    await recordAuditLog(
      {
        projectId: task.projectId,
        taskId: task.id,
        userId: user.userId,
        action: "ATTACHMENT_ADDED",
        changedColumn: "attachments",
        newValue: attachment.id,
        metadata: { fileName: attachment.fileName },
      },
      tx,
    );
    return attachment;
  });
  return c.json(
    { success: true, message: "Attachment link added successfully", data: result },
    201,
  );
});

taskRoutes.delete("/:id/attachments/:attachmentId", async (c) => {
  const user = c.get("user");
  const data = await mutationBody(c, versionBody);
  const attachmentId = z.string().uuid().parse(c.req.param("attachmentId"));
  await taskMutation(user, c.req.param("id"), data.version, async (tx, task) => {
    requireInternal(user);
    const attachment = await tx.taskAttachment.findFirst({
      where: { id: attachmentId, taskId: task.id, deletedAt: null },
    });
    if (!attachment) throw new HTTPException(404, { message: "Attachment not found." });
    if (user.role !== Role.PM && attachment.uploaderId !== user.userId)
      throw new HTTPException(403, {
        message: "Only the uploader or a PM may remove this attachment link.",
      });
    await bumpTask(tx, user, task, data.version);
    await tx.taskAttachment.update({
      where: { id: attachment.id },
      data: { deletedAt: new Date() },
    });
    await recordAuditLog(
      {
        projectId: task.projectId,
        taskId: task.id,
        userId: user.userId,
        action: "ATTACHMENT_DELETED",
        changedColumn: "attachments",
        oldValue: attachment.id,
      },
      tx,
    );
  });
  return c.json({ success: true, message: "Attachment link soft-deleted successfully" });
});

taskRoutes.delete("/:id", requireTaskManager, async (c) => {
  const user = c.get("user");
  const data = await mutationBody(c, versionBody);
  await taskMutation(user, c.req.param("id"), data.version, async (tx, task) => {
    const deletedAt = new Date();
    await bumpTask(tx, user, task, data.version, { deletedAt });
    const edges = await tx.taskDependency.findMany({
      where: {
        deletedAt: null,
        task: { projectId: task.projectId },
        OR: [{ taskId: task.id }, { prerequisiteTaskId: task.id }],
      },
    });
    for (const edge of edges) {
      await tx.taskDependency.update({ where: { id: edge.id }, data: { deletedAt } });
      await recordAuditLog(
        {
          projectId: task.projectId,
          taskId: edge.taskId,
          userId: user.userId,
          action: "DEPENDENCY_REMOVED",
          changedColumn: "dependencies",
          oldValue: edge.prerequisiteTaskId,
          metadata: { deletedTaskId: task.id },
        },
        tx,
      );
    }
    const affectedTasks = [
      ...new Set(edges.filter((edge) => edge.taskId !== task.id).map((edge) => edge.taskId)),
    ];
    for (const id of affectedTasks) {
      const dependent = await requireTask(tx, user, id);
      const dependency = await getTaskDependencyStatus(id, tx);
      const status =
        !dependency.isBlocked && dependent.status === TaskStatus.BLOCKED
          ? TaskStatus.TODO
          : dependent.status;
      await bumpTask(tx, user, dependent, dependent.version, { status });
      if (status !== dependent.status)
        await statusAudit(tx, user, dependent, status, "AUTO_UNBLOCKED");
    }
    await recordAuditLog(
      {
        projectId: task.projectId,
        taskId: task.id,
        userId: user.userId,
        action: "TASK_SOFT_DELETED",
        changedColumn: "deletedAt",
        newValue: deletedAt.toISOString(),
      },
      tx,
    );
    await syncProjectBlocking(tx, user, task.projectId, affectedTasks);
  });
  return c.json({ success: true, message: "Task soft-deleted successfully" });
});

export { taskRoutes };
