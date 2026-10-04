import { Prisma } from "@prisma/client";
import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { env } from "../config/env";

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof ZodError) {
    return c.json(
      {
        success: false,
        error: "Validation Error",
        message: "Invalid input payload provided",
        issues: err.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      },
      400,
    );
  }

  if (err instanceof HTTPException) {
    return c.json(
      {
        success: false,
        error: "HTTP Error",
        message:
          err.status >= 500 && env.NODE_ENV === "production"
            ? "An unexpected error occurred."
            : err.message,
      },
      err.status,
    );
  }

  if (err instanceof SyntaxError && err.message.includes("JSON")) {
    return c.json(
      { success: false, error: "Validation Error", message: "Invalid JSON payload" },
      400,
    );
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002" || err.code === "P2034") {
      return c.json(
        {
          success: false,
          error: "Conflict",
          message: "The operation conflicts with existing data. Refresh and retry.",
        },
        409,
      );
    }
    if (err.code === "P2025") {
      return c.json({ success: false, error: "Not Found", message: "Resource not found." }, 404);
    }
  }

  console.error("Unhandled application error:", err);
  return c.json(
    {
      success: false,
      error: "Internal Server Error",
      message: env.NODE_ENV === "production" ? "An unexpected error occurred." : err.message,
    },
    500,
  );
};
