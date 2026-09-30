import type { MiddlewareHandler } from "hono";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { prisma } from "../db/prisma";
import type { JwtPayload } from "../types";

export const authMiddleware: MiddlewareHandler = async (c, next) => {
  const authHeader = c.req.header("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json(
      {
        success: false,
        error: "Unauthorized",
        message: "Missing or invalid Authorization header. Expected Bearer token.",
      },
      401,
    );
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as JwtPayload;

    // Check if user exists and is not soft deleted
    const user = await prisma.user.findFirst({
      where: {
        id: decoded.userId,
        deletedAt: null,
      },
    });

    if (!user) {
      return c.json(
        {
          success: false,
          error: "Unauthorized",
          message: "User account not found or has been deactivated.",
        },
        401,
      );
    }

    c.set("user", {
      userId: user.id,
      email: user.email,
      role: user.role,
      department: user.department,
      name: user.name,
    });

    await next();
  } catch (err: any) {
    return c.json(
      {
        success: false,
        error: "Unauthorized",
        message: "Invalid or expired token.",
        details: err.message,
      },
      401,
    );
  }
};
