import { Department, Priority, type Prisma, Role, TaskStatus } from "@prisma/client";
import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../../db/prisma";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { checkProjectAccess, requireRole } from "../../middlewares/rbac.middleware";
import { recordAuditLog } from "../../utils/audit.helper";
import { wouldCreateCycle } from "../../utils/cycle-detector";
import { buildPrismaQuery, parseQueryParams } from "../../utils/ezfilter.helper";

const taskRoutes = new Hono();

taskRoutes.use("*", authMiddleware);

/**
 * Checks if a task is blocked by incomplete prerequisites.
 */
export async function getTaskDependencyStatus(taskId: string) {
  const dependencies = await prisma.taskDependency.findMany({
    where: { taskId },
    include: {
      prerequisiteTask: {
        select: {
          id: true,
          taskCode: true,
          title: true,
          status: true,
          department: true,
        },
      },
    },
  });

  const pendingPrerequisites = dependencies
    .map((d) => d.prerequisiteTask)
    .filter((p) => p.status !== TaskStatus.DONE);

  const isBlocked = pendingPrerequisites.length > 0;

  return {
    dependencies: dependencies.map((d) => d.prerequisiteTask),
    pendingPrerequisites,
    isBlocked,
    blockedReason: isBlocked
      ? `Blocked by: ${pendingPrerequisites.map((p) => `${p.taskCode} (${p.title})`).join(", ")}`
      : null,
  };
}

/**
 * Masks internal identities and comments for Client Guest users.
 * Only a whitelist of safe fields is returned — identities, departments,
 * and internal audit trails are stripped at the API level.
 */
interface MaskableAttachment {
  id: string;
  fileName: string;
  fileUrl: string;
  fileType: string | null;
  createdAt: Date;
}

interface MaskableDependency {
  prerequisiteTask: {
    id: string;
    taskCode: string;
    title: string;
    status: string;
  } | null;
}

interface MaskableTask {
  id: string;
  taskCode: string;
  projectId: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  isClientVisible: boolean;
  dueDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
  assignee: { name: string } | null;
  attachments: MaskableAttachment[];
  dependencies: MaskableDependency[];
  isBlocked: boolean;
  blockedReason: string | null;
  pendingPrerequisites: { id: string; taskCode: string; title: string; status: string }[];
}

function maskTaskForClient(task: MaskableTask) {
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
    version: task.version,
    // Strictly masked identities:
    department: undefined,
    assignee: task.assignee ? { name: "Assigned Specialist" } : null,
    creator: { name: "NodeWave Team" },
    attachments: (task.attachments || []).map((att: MaskableAttachment) => ({
      id: att.id,
      fileName: att.fileName,
      fileUrl: att.fileUrl,
      fileType: att.fileType,
      createdAt: att.createdAt,
    })),
    dependencies: (task.dependencies || []).map((dep: MaskableDependency) => ({
      id: dep.prerequisiteTask?.id,
      taskCode: dep.prerequisiteTask?.taskCode,
      title: dep.prerequisiteTask?.title,
      status: dep.prerequisiteTask?.status,
    })),
    // Internal audit trail omitted for client!
    auditLogs: [],
    isBlocked: task.isBlocked,
    blockedReason: task.blockedReason,
    pendingPrerequisites: task.pendingPrerequisites,
  };
}

// 1. List Tasks (ezfilter support, search, range, status filter, masking)
taskRoutes.get("/", async (c) => {
  const user = c.get("user");
  const projectId = c.req.query("projectId");
  const filteringQuery = parseQueryParams(c);
  const baseQuery = buildPrismaQuery(filteringQuery);

  const whereConditions: Prisma.TaskWhereInput[] = [{ deletedAt: null }];

  if (projectId) {
    const hasAccess = await checkProjectAccess(user.userId, user.role, projectId);
    if (!hasAccess) {
      return c.json(
        { success: false, error: "Forbidden", message: "You do not have access to this project." },
        403,
      );
    }
    whereConditions.push({ projectId });
  } else {
    // If no specific projectId passed, filter accessible projects
    if (user.role === Role.CLIENT) {
      whereConditions.push({
        project: { clientId: user.userId, deletedAt: null },
      });
    } else if (user.role === Role.MEMBER) {
      whereConditions.push({
        project: {
          members: { some: { userId: user.userId } },
          deletedAt: null,
        },
      });
    }
  }

  // Client isolation: Client can ONLY see client-visible tasks!
  if (user.role === Role.CLIENT) {
    whereConditions.push({ isClientVisible: true });
  }

  // Add ezfilter conditions
  if (baseQuery.where) {
    whereConditions.push(baseQuery.where);
  }

  const where = { AND: whereConditions };

  const [tasks, total] = await Promise.all([
    prisma.task.findMany({
      where,
      orderBy:
        baseQuery.orderBy && Object.keys(baseQuery.orderBy).length > 0
          ? baseQuery.orderBy
          : { createdAt: "desc" },
      skip: baseQuery.skip,
      take: baseQuery.take,
      include: {
        project: {
          select: { id: true, name: true, key: true },
        },
        assignee: {
          select: { id: true, name: true, email: true, department: true, avatarUrl: true },
        },
        creator: {
          select: { id: true, name: true, email: true, department: true },
        },
        dependencies: {
          include: {
            prerequisiteTask: {
              select: { id: true, taskCode: true, title: true, status: true, department: true },
            },
          },
        },
        dependents: {
          include: {
            task: {
              select: { id: true, taskCode: true, title: true, status: true, department: true },
            },
          },
        },
        attachments: {
          where: { deletedAt: null },
          include: {
            uploader: {
              select: { id: true, name: true },
            },
          },
        },
      },
    }),
    prisma.task.count({ where }),
  ]);

  // Compute dynamic blocked status for each task
  const enrichedTasks = tasks.map((task) => {
    const pendingPrerequisites = task.dependencies
      .map((d) => d.prerequisiteTask)
      .filter((p) => p.status !== TaskStatus.DONE);

    const isBlocked = pendingPrerequisites.length > 0;
    const blockedReason = isBlocked
      ? `Blocked by: ${pendingPrerequisites.map((p) => `${p.taskCode} (${p.title})`).join(", ")}`
      : null;

    const enriched = {
      ...task,
      isBlocked,
      pendingPrerequisites,
      blockedReason,
    };

    if (user.role === Role.CLIENT) {
      return maskTaskForClient(enriched);
    }

    return enriched;
  });

  return c.json({
    success: true,
    data: enrichedTasks,
    meta: {
      page: filteringQuery.page,
      rows: filteringQuery.rows,
      total,
      totalPages: Math.ceil(total / (filteringQuery.rows || 20)),
    },
  });
});

// 2. Get Single Task Detail
taskRoutes.get("/:id", async (c) => {
  const user = c.get("user");
  const taskId = c.req.param("id");

  const task = await prisma.task.findFirst({
    where: { id: taskId, deletedAt: null },
    include: {
      project: {
        select: { id: true, name: true, key: true, clientId: true },
      },
      assignee: {
        select: { id: true, name: true, email: true, department: true, avatarUrl: true },
      },
      creator: {
        select: { id: true, name: true, email: true, department: true },
      },
      dependencies: {
        include: {
          prerequisiteTask: {
            select: { id: true, taskCode: true, title: true, status: true, department: true },
          },
        },
      },
      dependents: {
        include: {
          task: {
            select: { id: true, taskCode: true, title: true, status: true, department: true },
          },
        },
      },
      attachments: {
        where: { deletedAt: null },
        include: {
          uploader: {
            select: { id: true, name: true },
          },
        },
      },
      auditLogs: {
        orderBy: { timestamp: "desc" },
        take: 20,
        include: {
          user: {
            select: { id: true, name: true, role: true, department: true, avatarUrl: true },
          },
        },
      },
    },
  });

  if (!task) {
    return c.json({ success: false, error: "Not Found", message: "Task not found." }, 404);
  }

  const hasAccess = await checkProjectAccess(user.userId, user.role, task.projectId);
  if (!hasAccess) {
    return c.json(
      { success: false, error: "Forbidden", message: "You do not have access to this task." },
      403,
    );
  }

  // Client visibility check
  if (user.role === Role.CLIENT && !task.isClientVisible) {
    return c.json(
      { success: false, error: "Forbidden", message: "This task is not visible to clients." },
      403,
    );
  }

  const depStatus = await getTaskDependencyStatus(task.id);
  const enriched = {
    ...task,
    isBlocked: depStatus.isBlocked,
    pendingPrerequisites: depStatus.pendingPrerequisites,
    blockedReason: depStatus.blockedReason,
  };

  if (user.role === Role.CLIENT) {
    return c.json({
      success: true,
      data: maskTaskForClient(enriched),
    });
  }

  return c.json({
    success: true,
    data: enriched,
  });
});

// 3. Create Task (PM Only)
const createTaskSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(3),
  description: z.string().optional(),
  department: z.nativeEnum(Department),
  priority: z.nativeEnum(Priority).default(Priority.MEDIUM),
  isClientVisible: z.boolean().default(false),
  assigneeId: z.string().uuid().optional().nullable(),
  dueDate: z.string().datetime().optional().nullable(),
  prerequisiteTaskIds: z.array(z.string().uuid()).optional(),
});

taskRoutes.post("/", requireRole(Role.PM), async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const data = createTaskSchema.parse(body);

  const project = await prisma.project.findFirst({
    where: { id: data.projectId, deletedAt: null },
  });

  if (!project) {
    return c.json({ success: false, error: "Not Found", message: "Project not found." }, 404);
  }

  // Generate unique task code e.g. "NW-CORE-007"
  const taskCount = await prisma.task.count({
    where: { projectId: project.id },
  });
  const taskCode = `${project.key}-${String(taskCount + 1).padStart(3, "0")}`;

  const task = await prisma.task.create({
    data: {
      taskCode,
      projectId: project.id,
      title: data.title,
      description: data.description,
      department: data.department,
      priority: data.priority,
      isClientVisible: data.isClientVisible,
      assigneeId: data.assigneeId,
      creatorId: user.userId,
      dueDate: data.dueDate ? new Date(data.dueDate) : null,
      status: TaskStatus.TODO,
    },
  });

  // Attach prerequisites if provided
  if (data.prerequisiteTaskIds && data.prerequisiteTaskIds.length > 0) {
    for (const prereqId of data.prerequisiteTaskIds) {
      const cycle = await wouldCreateCycle(task.id, prereqId);
      if (!cycle) {
        await prisma.taskDependency.create({
          data: {
            taskId: task.id,
            prerequisiteTaskId: prereqId,
          },
        });
      }
    }

    // Check if prerequisites are incomplete -> mark BLOCKED
    const depStatus = await getTaskDependencyStatus(task.id);
    if (depStatus.isBlocked) {
      await prisma.task.update({
        where: { id: task.id },
        data: { status: TaskStatus.BLOCKED },
      });
      task.status = TaskStatus.BLOCKED;
    }
  }

  await recordAuditLog({
    projectId: project.id,
    taskId: task.id,
    userId: user.userId,
    action: "TASK_CREATED",
    changedColumn: "title",
    newValue: task.title,
    metadata: {
      taskCode: task.taskCode,
      department: task.department,
      priority: task.priority,
    },
  });

  return c.json(
    {
      success: true,
      message: "Task created successfully",
      data: task,
    },
    201,
  );
});

// 4. Update Core Task Details (PM ONLY) with Optimistic Locking
const updateTaskDetailsSchema = z.object({
  version: z.number().int().min(1),
  title: z.string().min(3).optional(),
  description: z.string().optional().nullable(),
  department: z.nativeEnum(Department).optional(),
  priority: z.nativeEnum(Priority).optional(),
  isClientVisible: z.boolean().optional(),
  assigneeId: z.string().uuid().optional().nullable(),
  dueDate: z.string().datetime().optional().nullable(),
});

taskRoutes.put("/:id", requireRole(Role.PM), async (c) => {
  const user = c.get("user");
  const taskId = c.req.param("id");
  const body = await c.req.json();
  const data = updateTaskDetailsSchema.parse(body);

  const currentTask = await prisma.task.findFirst({
    where: { id: taskId, deletedAt: null },
  });

  if (!currentTask) {
    return c.json({ success: false, error: "Not Found", message: "Task not found." }, 404);
  }

  // Optimistic Locking Check
  if (currentTask.version !== data.version) {
    return c.json(
      {
        success: false,
        error: "Conflict",
        message:
          "This task was modified concurrently by another user. Please refresh and review latest changes.",
        serverVersion: currentTask.version,
        clientVersion: data.version,
        latestData: currentTask,
      },
      409,
    );
  }

  const updatePayload: Prisma.TaskUncheckedUpdateInput = {
    version: { increment: 1 },
  };

  const auditChanges: { column: string; oldVal: string; newVal: string }[] = [];

  if (data.title !== undefined && data.title !== currentTask.title) {
    updatePayload.title = data.title;
    auditChanges.push({ column: "title", oldVal: currentTask.title, newVal: data.title });
  }

  if (data.description !== undefined && data.description !== currentTask.description) {
    updatePayload.description = data.description;
    auditChanges.push({
      column: "description",
      oldVal: currentTask.description || "",
      newVal: data.description || "",
    });
  }

  if (data.department !== undefined && data.department !== currentTask.department) {
    updatePayload.department = data.department;
    auditChanges.push({
      column: "department",
      oldVal: currentTask.department,
      newVal: data.department,
    });
  }

  if (data.priority !== undefined && data.priority !== currentTask.priority) {
    updatePayload.priority = data.priority;
    auditChanges.push({ column: "priority", oldVal: currentTask.priority, newVal: data.priority });
  }

  if (data.isClientVisible !== undefined && data.isClientVisible !== currentTask.isClientVisible) {
    updatePayload.isClientVisible = data.isClientVisible;
    auditChanges.push({
      column: "isClientVisible",
      oldVal: String(currentTask.isClientVisible),
      newVal: String(data.isClientVisible),
    });
  }

  if (data.assigneeId !== undefined && data.assigneeId !== currentTask.assigneeId) {
    updatePayload.assigneeId = data.assigneeId;
    auditChanges.push({
      column: "assigneeId",
      oldVal: currentTask.assigneeId || "None",
      newVal: data.assigneeId || "None",
    });
  }

  if (data.dueDate !== undefined) {
    updatePayload.dueDate = data.dueDate ? new Date(data.dueDate) : null;
    auditChanges.push({
      column: "dueDate",
      oldVal: currentTask.dueDate?.toISOString() || "None",
      newVal: data.dueDate || "None",
    });
  }

  // Execute update using version condition
  const result = await prisma.task.updateMany({
    where: {
      id: taskId,
      version: data.version,
      deletedAt: null,
    },
    data: updatePayload,
  });

  if (result.count === 0) {
    const latest = await prisma.task.findUnique({ where: { id: taskId } });
    return c.json(
      {
        success: false,
        error: "Conflict",
        message: "Optimistic locking race condition: Record was updated in another transaction.",
        latestData: latest,
      },
      409,
    );
  }

  const updatedTask = await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      assignee: { select: { id: true, name: true, department: true } },
    },
  });

  // Record audit logs for each changed field
  for (const change of auditChanges) {
    await recordAuditLog({
      projectId: currentTask.projectId,
      taskId: currentTask.id,
      userId: user.userId,
      action: "TASK_UPDATED",
      changedColumn: change.column,
      oldValue: change.oldVal,
      newValue: change.newVal,
    });
  }

  return c.json({
    success: true,
    message: "Task updated successfully",
    data: updatedTask,
  });
});

// 5. Update Task Status (STATE-BASED ACCESS CONTROL + OPTIMISTIC LOCKING)
const updateStatusSchema = z.object({
  status: z.nativeEnum(TaskStatus),
  version: z.number().int().min(1),
  note: z.string().optional(),
});

taskRoutes.patch("/:id/status", async (c) => {
  const user = c.get("user");
  const taskId = c.req.param("id");
  const body = await c.req.json();
  const data = updateStatusSchema.parse(body);

  const task = await prisma.task.findFirst({
    where: { id: taskId, deletedAt: null },
    include: { project: true },
  });

  if (!task) {
    return c.json({ success: false, error: "Not Found", message: "Task not found." }, 404);
  }

  const hasAccess = await checkProjectAccess(user.userId, user.role, task.projectId);
  if (!hasAccess) {
    return c.json(
      { success: false, error: "Forbidden", message: "You do not have access to this task." },
      403,
    );
  }

  // Client cannot change status
  if (user.role === Role.CLIENT) {
    return c.json(
      { success: false, error: "Forbidden", message: "Client guests cannot modify task status." },
      403,
    );
  }

  // CRITICAL RULE 1: PM CANNOT move a task from IN_PROGRESS to DONE!
  // "Has full read/write access to projects and tasks, but cannot move a task status from In Progress to Done (only the executor can complete it)."
  if (
    user.role === Role.PM &&
    task.status === TaskStatus.IN_PROGRESS &&
    data.status === TaskStatus.DONE
  ) {
    return c.json(
      {
        success: false,
        error: "Forbidden",
        message:
          "Product Managers cannot mark tasks as Done. Only the assigned executor / internal team member can complete an in-progress deliverable.",
      },
      403,
    );
  }

  // CRITICAL RULE 2: Internal Team members can only change status for their relevant tasks
  // (Either assigned directly, or matching their department)
  if (user.role === Role.MEMBER) {
    if (task.assigneeId && task.assigneeId !== user.userId && task.department !== user.department) {
      return c.json(
        {
          success: false,
          error: "Forbidden",
          message: `You are not the assignee or from department ${task.department} for this task.`,
        },
        403,
      );
    }
  }

  // CRITICAL RULE 3: DEPENDENCY ENFORCEMENT & BLOCKED STATE
  // "A Frontend Engineer can only change a task status to In Progress if the UI/UX task it depends on is already Done. If not, the action button must be locked both in UI and API protection."
  if (data.status === TaskStatus.IN_PROGRESS || data.status === TaskStatus.DONE) {
    const depStatus = await getTaskDependencyStatus(task.id);
    if (depStatus.isBlocked) {
      return c.json(
        {
          success: false,
          error: "TaskBlocked",
          message: `Cannot transition task to ${data.status}: It has incomplete prerequisite dependencies.`,
          pendingPrerequisites: depStatus.pendingPrerequisites,
          blockedReason: depStatus.blockedReason,
        },
        422,
      );
    }
  }

  // CRITICAL RULE 4: OPTIMISTIC LOCKING / RACE CONDITION CHECK
  if (task.version !== data.version) {
    return c.json(
      {
        success: false,
        error: "Conflict",
        message:
          "Concurrency conflict: This task status was changed by another user. Please reload.",
        serverVersion: task.version,
        clientVersion: data.version,
        latestData: task,
      },
      409,
    );
  }

  // Perform atomic update with version check
  const updateResult = await prisma.task.updateMany({
    where: {
      id: taskId,
      version: data.version,
      deletedAt: null,
    },
    data: {
      status: data.status,
      version: { increment: 1 },
    },
  });

  if (updateResult.count === 0) {
    const latest = await prisma.task.findUnique({ where: { id: taskId } });
    return c.json(
      {
        success: false,
        error: "Conflict",
        message: "Conflict: Task was modified concurrently by another user.",
        latestData: latest,
      },
      409,
    );
  }

  // If marked DONE, automatically check if any dependent tasks can now be unblocked!
  if (data.status === TaskStatus.DONE) {
    const dependents = await prisma.taskDependency.findMany({
      where: { prerequisiteTaskId: taskId },
      select: { taskId: true },
    });

    for (const dep of dependents) {
      const depCheck = await getTaskDependencyStatus(dep.taskId);
      if (!depCheck.isBlocked) {
        // All prerequisites are now DONE! If the dependent task was BLOCKED, transition it to TODO
        const dependentTask = await prisma.task.findUnique({ where: { id: dep.taskId } });
        if (dependentTask && dependentTask.status === TaskStatus.BLOCKED) {
          await prisma.task.update({
            where: { id: dep.taskId },
            data: {
              status: TaskStatus.TODO,
              version: { increment: 1 },
            },
          });

          await recordAuditLog({
            projectId: task.projectId,
            taskId: dep.taskId,
            userId: user.userId,
            action: "AUTO_UNBLOCKED",
            changedColumn: "status",
            oldValue: TaskStatus.BLOCKED,
            newValue: TaskStatus.TODO,
            metadata: { unblockedBy: task.taskCode },
          });
        }
      }
    }
  }

  // Record Audit Trail
  await recordAuditLog({
    projectId: task.projectId,
    taskId: task.id,
    userId: user.userId,
    action: "STATUS_CHANGED",
    changedColumn: "status",
    oldValue: task.status,
    newValue: data.status,
    metadata: {
      note: data.note || null,
      updatedByRole: user.role,
      updatedByDepartment: user.department,
    },
  });

  const updatedTask = await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      assignee: { select: { id: true, name: true, department: true } },
    },
  });

  return c.json({
    success: true,
    message: `Task status updated from ${task.status} to ${data.status}`,
    data: updatedTask,
  });
});

// 6. Manage Task Dependencies (PM Only)
taskRoutes.post("/:id/dependencies", requireRole(Role.PM), async (c) => {
  const user = c.get("user");
  const taskId = c.req.param("id");
  const { prerequisiteTaskId } = await c.req.json();

  if (!prerequisiteTaskId || taskId === prerequisiteTaskId) {
    return c.json(
      { success: false, error: "Validation Error", message: "A task cannot depend on itself." },
      400,
    );
  }

  const [task, prereq] = await Promise.all([
    prisma.task.findFirst({ where: { id: taskId, deletedAt: null } }),
    prisma.task.findFirst({ where: { id: prerequisiteTaskId, deletedAt: null } }),
  ]);

  if (!task || !prereq) {
    return c.json(
      { success: false, error: "Not Found", message: "Task or prerequisite not found." },
      404,
    );
  }

  if (task.projectId !== prereq.projectId) {
    return c.json(
      {
        success: false,
        error: "Validation Error",
        message: "Prerequisites must belong to the same project.",
      },
      400,
    );
  }

  // Check DAG cycle
  const hasCycle = await wouldCreateCycle(taskId, prerequisiteTaskId);
  if (hasCycle) {
    return c.json(
      {
        success: false,
        error: "CircularDependency",
        message: `Circular dependency detected: Adding '${prereq.taskCode}' as prerequisite for '${task.taskCode}' creates an infinite cycle.`,
      },
      400,
    );
  }

  const existing = await prisma.taskDependency.findUnique({
    where: {
      taskId_prerequisiteTaskId: {
        taskId,
        prerequisiteTaskId,
      },
    },
  });

  if (existing) {
    return c.json(
      { success: false, error: "Conflict", message: "Dependency already exists." },
      409,
    );
  }

  await prisma.taskDependency.create({
    data: { taskId, prerequisiteTaskId },
  });

  // If newly added prerequisite is NOT DONE, automatically set task status to BLOCKED if it's currently TODO or IN_PROGRESS
  if (prereq.status !== TaskStatus.DONE) {
    if (task.status === TaskStatus.TODO || task.status === TaskStatus.IN_PROGRESS) {
      await prisma.task.update({
        where: { id: taskId },
        data: { status: TaskStatus.BLOCKED, version: { increment: 1 } },
      });
    }
  }

  await recordAuditLog({
    projectId: task.projectId,
    taskId: task.id,
    userId: user.userId,
    action: "DEPENDENCY_ADDED",
    changedColumn: "dependencies",
    oldValue: null,
    newValue: prereq.taskCode,
    metadata: { prerequisiteTitle: prereq.title },
  });

  return c.json({
    success: true,
    message: `Added dependency: ${task.taskCode} now depends on ${prereq.taskCode}`,
  });
});

// Remove Dependency (PM Only)
taskRoutes.delete("/:id/dependencies/:prereqId", requireRole(Role.PM), async (c) => {
  const user = c.get("user");
  const taskId = c.req.param("id");
  const prereqId = c.req.param("prereqId");

  const dep = await prisma.taskDependency.findUnique({
    where: {
      taskId_prerequisiteTaskId: {
        taskId,
        prerequisiteTaskId: prereqId,
      },
    },
    include: {
      task: true,
      prerequisiteTask: true,
    },
  });

  if (!dep) {
    return c.json(
      { success: false, error: "Not Found", message: "Dependency does not exist." },
      404,
    );
  }

  await prisma.taskDependency.delete({
    where: {
      taskId_prerequisiteTaskId: {
        taskId,
        prerequisiteTaskId: prereqId,
      },
    },
  });

  // If removing this prerequisite leaves no incomplete prerequisites, unblock task
  const depStatus = await getTaskDependencyStatus(taskId);
  if (!depStatus.isBlocked && dep.task.status === TaskStatus.BLOCKED) {
    await prisma.task.update({
      where: { id: taskId },
      data: { status: TaskStatus.TODO, version: { increment: 1 } },
    });
  }

  await recordAuditLog({
    projectId: dep.task.projectId,
    taskId: dep.taskId,
    userId: user.userId,
    action: "DEPENDENCY_REMOVED",
    changedColumn: "dependencies",
    oldValue: dep.prerequisiteTask.taskCode,
    newValue: null,
  });

  return c.json({
    success: true,
    message: `Removed dependency: ${dep.task.taskCode} no longer depends on ${dep.prerequisiteTask.taskCode}`,
  });
});

// 7. Work Attachments (Internal Team & PM)
const createAttachmentSchema = z.object({
  fileName: z.string().min(2),
  fileUrl: z.string().url(),
  fileType: z.string().optional(),
});

taskRoutes.post("/:id/attachments", async (c) => {
  const user = c.get("user");
  const taskId = c.req.param("id");
  const body = await c.req.json();
  const data = createAttachmentSchema.parse(body);

  if (user.role === Role.CLIENT) {
    return c.json(
      { success: false, error: "Forbidden", message: "Clients cannot upload attachments." },
      403,
    );
  }

  const task = await prisma.task.findFirst({
    where: { id: taskId, deletedAt: null },
  });

  if (!task) {
    return c.json({ success: false, error: "Not Found", message: "Task not found." }, 404);
  }

  const attachment = await prisma.taskAttachment.create({
    data: {
      taskId: task.id,
      uploaderId: user.userId,
      fileName: data.fileName,
      fileUrl: data.fileUrl,
      fileType: data.fileType || "link",
    },
    include: {
      uploader: { select: { id: true, name: true } },
    },
  });

  await recordAuditLog({
    projectId: task.projectId,
    taskId: task.id,
    userId: user.userId,
    action: "ATTACHMENT_ADDED",
    changedColumn: "attachments",
    newValue: attachment.fileName,
    metadata: { fileUrl: attachment.fileUrl },
  });

  return c.json(
    {
      success: true,
      message: "Attachment uploaded successfully",
      data: attachment,
    },
    201,
  );
});

// Soft Delete Task (PM Only)
taskRoutes.delete("/:id", requireRole(Role.PM), async (c) => {
  const user = c.get("user");
  const taskId = c.req.param("id");

  const task = await prisma.task.findFirst({
    where: { id: taskId, deletedAt: null },
  });

  if (!task) {
    return c.json({ success: false, error: "Not Found", message: "Task not found." }, 404);
  }

  await prisma.task.update({
    where: { id: taskId },
    data: { deletedAt: new Date() },
  });

  await recordAuditLog({
    projectId: task.projectId,
    taskId: task.id,
    userId: user.userId,
    action: "TASK_SOFT_DELETED",
    changedColumn: "deletedAt",
    oldValue: null,
    newValue: new Date().toISOString(),
  });

  return c.json({
    success: true,
    message: "Task soft-deleted successfully",
  });
});

export { taskRoutes };
