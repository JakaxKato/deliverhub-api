import type { MiddlewareHandler } from "hono";
import type { Role } from "../types";

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
