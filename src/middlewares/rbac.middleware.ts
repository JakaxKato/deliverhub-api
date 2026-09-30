import type { MiddlewareHandler } from "hono";
import { prisma } from "../db/prisma";
import type { Department, Role } from "../types";

export function requireRole(...allowedRoles: Role[]): MiddlewareHandler {
  return async (c, next) => {
    const user = c.get("user");
    if (!user) {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }

    if (!allowedRoles.includes(user.role)) {
      return c.json(
        {
          success: false,
          error: "Forbidden",
          message: `Access denied. Role '${user.role}' is not authorized to perform this action.`,
        },
        403,
      );
    }

    await next();
  };
}

export function requireDepartment(...allowedDepartments: Department[]): MiddlewareHandler {
  return async (c, next) => {
    const user = c.get("user");
    if (!user) {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }

    if (user.role !== "PM" && !allowedDepartments.includes(user.department)) {
      return c.json(
        {
          success: false,
          error: "Forbidden",
          message: `Access denied. Department '${user.department}' is not authorized for this operation.`,
        },
        403,
      );
    }

    await next();
  };
}

export async function checkProjectAccess(userId: string, userRole: Role, projectId: string) {
  if (userRole === "PM") {
    return true; // PM has full project access
  }

  const project = await prisma.project.findFirst({
    where: {
      id: projectId,
      deletedAt: null,
    },
    include: {
      members: true,
    },
  });

  if (!project) {
    return false;
  }

  if (userRole === "CLIENT") {
    return project.clientId === userId;
  }

  // Internal team member must be an assigned member of this project
  return project.members.some((m) => m.userId === userId);
}
