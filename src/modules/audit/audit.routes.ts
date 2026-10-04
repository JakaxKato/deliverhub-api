import { Department, type Prisma, Role, TaskStatus } from "@prisma/client";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { prisma } from "../../db/prisma";
import { authMiddleware } from "../../middlewares/auth.middleware";
import {
  projectAccessWhere,
  requireProject,
  requireTask,
  taskAccessWhere,
} from "../../utils/authorization.helper";
import { buildPrismaQuery, parseQueryParams } from "../../utils/ezfilter.helper";
import { getTaskDependencyStatus } from "../tasks/tasks.routes";

interface CompletedItem {
  taskCode?: string;
  title?: string;
  completedBy: string;
  timestamp: Date;
}

interface InProgressItem {
  id: string;
  taskCode: string;
  title: string;
  department: string;
  assigneeName: string;
}

interface BlockedItem extends InProgressItem {
  blockedReason: string;
  pendingPrerequisites: {
    id: string;
    taskCode: string;
    title: string;
    status: string;
    department: string;
  }[];
}

const auditRoutes = new Hono();

auditRoutes.use("*", authMiddleware);

// List Audit Logs
auditRoutes.get("/", async (c) => {
  const user = c.get("user");
  if (user.role !== Role.PM && user.role !== Role.MEMBER) {
    return c.json(
      {
        success: false,
        error: "Forbidden",
        message: "Internal audit trails are not accessible to clients.",
      },
      403,
    );
  }

  const projectId = c.req.query("projectId");
  const taskId = c.req.query("taskId");
  const filteringQuery = parseQueryParams(c, "audit");
  const baseQuery = buildPrismaQuery(filteringQuery);

  for (const id of new Set([projectId, filteringQuery.filters?.projectId])) {
    if (typeof id === "string") await requireProject(prisma, user, id);
  }
  for (const id of new Set([taskId, filteringQuery.filters?.taskId])) {
    if (typeof id === "string") await requireTask(prisma, user, id);
  }

  const whereConditions: Prisma.AuditLogWhereInput[] = [
    { project: { is: projectAccessWhere(user) } },
  ];
  if (projectId) whereConditions.push({ projectId });
  if (taskId) whereConditions.push({ taskId });
  if (baseQuery.where) whereConditions.push(baseQuery.where);

  const where: Prisma.AuditLogWhereInput = { AND: whereConditions };

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: baseQuery.orderBy as Prisma.AuditLogOrderByWithRelationInput[],
      skip: baseQuery.skip,
      take: baseQuery.take,
      include: {
        user: {
          select: { id: true, name: true, role: true, department: true, avatarUrl: true },
        },
        task: {
          select: { id: true, taskCode: true, title: true, department: true },
        },
      },
    }),
    prisma.auditLog.count({ where }),
  ]);

  return c.json({
    success: true,
    data: logs,
    meta: {
      page: filteringQuery.page,
      rows: filteringQuery.rows,
      total,
      totalPages: Math.ceil(total / filteringQuery.rows),
    },
  });
});

// Daily Standup Auto-Summary for a Project
auditRoutes.get("/standup-summary/:projectId", async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("projectId");

  if (user.role !== Role.PM && user.role !== Role.MEMBER) {
    return c.json(
      {
        success: false,
        error: "Forbidden",
        message: "Standup summaries are internal to the engineering team.",
      },
      403,
    );
  }

  const project = await requireProject(prisma, user, projectId);

  // A date denotes one complete UTC day, regardless of the server timezone.
  const dateParam = c.req.query("date");
  let targetDate: Date;
  if (dateParam !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      throw new HTTPException(400, {
        message: "date must be a valid UTC date in YYYY-MM-DD format.",
      });
    }
    targetDate = new Date(`${dateParam}T00:00:00.000Z`);
    if (
      !Number.isFinite(targetDate.getTime()) ||
      targetDate.toISOString().slice(0, 10) !== dateParam
    ) {
      throw new HTTPException(400, {
        message: "date must be a valid UTC date in YYYY-MM-DD format.",
      });
    }
  } else {
    targetDate = new Date();
    targetDate.setUTCHours(0, 0, 0, 0);
    targetDate.setUTCDate(targetDate.getUTCDate() - 1);
  }

  const startOfDay = targetDate;
  const endOfDay = new Date(startOfDay);
  endOfDay.setUTCDate(endOfDay.getUTCDate() + 1);

  // 1. Audit trail entries for target day where status changed to DONE
  const completedYesterdayLogs = await prisma.auditLog.findMany({
    where: {
      projectId,
      task: { is: { AND: [{ projectId }, taskAccessWhere(user)] } },
      timestamp: {
        gte: startOfDay,
        lt: endOfDay,
      },
      action: "STATUS_CHANGED",
      changedColumn: "status",
      newValue: TaskStatus.DONE,
    },
    include: {
      task: {
        select: { id: true, taskCode: true, title: true, department: true },
      },
      user: {
        select: { id: true, name: true, department: true },
      },
    },
  });

  // 2. Current tasks that are currently BLOCKED
  const allTasks = await prisma.task.findMany({
    where: { AND: [{ projectId }, taskAccessWhere(user)] },
    include: {
      assignee: { select: { id: true, name: true } },
    },
  });

  const blockedToday: BlockedItem[] = [];
  const inProgressToday: InProgressItem[] = [];

  for (const t of allTasks) {
    if (t.status === TaskStatus.IN_PROGRESS) {
      inProgressToday.push({
        id: t.id,
        taskCode: t.taskCode,
        title: t.title,
        department: t.department,
        assigneeName: t.assignee?.name || "Unassigned",
      });
    }

    const depStatus = await getTaskDependencyStatus(t.id);
    if (t.status === TaskStatus.BLOCKED || depStatus.isBlocked) {
      blockedToday.push({
        id: t.id,
        taskCode: t.taskCode,
        title: t.title,
        department: t.department,
        assigneeName: t.assignee?.name || "Unassigned",
        blockedReason: depStatus.blockedReason || "Blocked by incomplete prerequisites",
        pendingPrerequisites: depStatus.pendingPrerequisites,
      });
    }
  }

  // Group by department
  const departments = [
    Department.PRODUCT,
    Department.UIUX,
    Department.FRONTEND,
    Department.BACKEND,
  ];

  const completedByDept: Record<string, CompletedItem[]> = {};
  const blockedByDept: Record<string, BlockedItem[]> = {};
  const inProgressByDept: Record<string, InProgressItem[]> = {};

  // Generate clean Markdown summary for Slack/Discord
  const dateFormatted = targetDate.toISOString().split("T")[0];
  let markdown = `📋 **Daily Standup Summary: ${project.name} (${dateFormatted})**\n\n`;

  for (const dept of departments) {
    completedByDept[dept] = completedYesterdayLogs
      .filter((l) => l.task?.department === dept)
      .map((l) => ({
        taskCode: l.task?.taskCode,
        title: l.task?.title,
        completedBy: l.user.name,
        timestamp: l.timestamp,
      }));

    blockedByDept[dept] = blockedToday.filter((t) => t.department === dept);
    inProgressByDept[dept] = inProgressToday.filter((t) => t.department === dept);

    const completed = completedByDept[dept] ?? [];
    const blocked = blockedByDept[dept] ?? [];
    const inProgress = inProgressByDept[dept] ?? [];

    if (completed.length === 0 && blocked.length === 0 && inProgress.length === 0) continue;

    markdown += `### 🔹 Department: ${dept}\n`;
    if (completed.length > 0) {
      markdown += `**✅ Completed Yesterday:**\n`;
      completed.forEach((c) => {
        markdown += `  - [${c.taskCode}] ${c.title} (by ${c.completedBy})\n`;
      });
    }
    if (inProgress.length > 0) {
      markdown += `**⏳ In Progress:**\n`;
      inProgress.forEach((ip) => {
        markdown += `  - [${ip.taskCode}] ${ip.title} (${ip.assigneeName})\n`;
      });
    }
    if (blocked.length > 0) {
      markdown += `**🚫 Currently Blocked:**\n`;
      blocked.forEach((b) => {
        markdown += `  - [${b.taskCode}] ${b.title} ⚠️ *${b.blockedReason}*\n`;
      });
    }
    markdown += `\n`;
  }

  return c.json({
    success: true,
    data: {
      projectId: project.id,
      projectName: project.name,
      date: dateFormatted,
      summary: {
        completedYesterday: completedByDept,
        blockedToday: blockedByDept,
        inProgressToday: inProgressByDept,
      },
      markdown,
    },
  });
});

export { auditRoutes };
