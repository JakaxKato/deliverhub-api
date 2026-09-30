import { Department, Role, TaskStatus } from "@prisma/client";
import { Hono } from "hono";
import { prisma } from "../../db/prisma";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { checkProjectAccess } from "../../middlewares/rbac.middleware";
import { buildPrismaQuery, parseQueryParams } from "../../utils/ezfilter.helper";
import { getTaskDependencyStatus } from "../tasks/tasks.routes";

const auditRoutes = new Hono();

auditRoutes.use("*", authMiddleware);

// List Audit Logs
auditRoutes.get("/", async (c) => {
  const user = c.get("user");
  if (user.role === Role.CLIENT) {
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
  const filteringQuery = parseQueryParams(c);
  const baseQuery = buildPrismaQuery(filteringQuery);

  const whereConditions: any[] = [];
  if (projectId) whereConditions.push({ projectId });
  if (taskId) whereConditions.push({ taskId });
  if (baseQuery.where) whereConditions.push(baseQuery.where);

  const where = whereConditions.length > 0 ? { AND: whereConditions } : {};

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { timestamp: "desc" },
      skip: baseQuery.skip,
      take: baseQuery.take || 25,
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
      totalPages: Math.ceil(total / (filteringQuery.rows || 25)),
    },
  });
});

// Daily Standup Auto-Summary for a Project
auditRoutes.get("/standup-summary/:projectId", async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("projectId");

  if (user.role === Role.CLIENT) {
    return c.json(
      {
        success: false,
        error: "Forbidden",
        message: "Standup summaries are internal to the engineering team.",
      },
      403,
    );
  }

  const hasAccess = await checkProjectAccess(user.userId, user.role, projectId);
  if (!hasAccess) {
    return c.json(
      { success: false, error: "Forbidden", message: "Access denied to this project." },
      403,
    );
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
  });

  if (!project) {
    return c.json({ success: false, error: "Not Found", message: "Project not found." }, 404);
  }

  // Calculate target date (defaults to yesterday, or custom ?date=YYYY-MM-DD)
  const dateParam = c.req.query("date");
  let targetDate: Date;
  if (dateParam) {
    targetDate = new Date(dateParam);
  } else {
    targetDate = new Date();
    targetDate.setDate(targetDate.getDate() - 1);
  }

  const startOfDay = new Date(targetDate);
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date(targetDate);
  endOfDay.setHours(23, 59, 59, 999);

  // 1. Audit trail entries for target day where status changed to DONE
  const completedYesterdayLogs = await prisma.auditLog.findMany({
    where: {
      projectId,
      timestamp: {
        gte: startOfDay,
        lte: endOfDay,
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
    where: { projectId, deletedAt: null },
    include: {
      assignee: { select: { id: true, name: true } },
    },
  });

  const blockedToday: any[] = [];
  const inProgressToday: any[] = [];

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

  const completedByDept: Record<string, any[]> = {};
  const blockedByDept: Record<string, any[]> = {};
  const inProgressByDept: Record<string, any[]> = {};

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
  }

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
