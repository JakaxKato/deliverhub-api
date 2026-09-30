import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof ZodError) {
    return c.json(
      {
        success: false,
        error: "Validation Error",
        message: "Invalid input payload provided",
        issues: err.issues.map((i) => ({
          field: i.path.join("."),
          message: i.message,
        })),
      },
      400,
    );
  }

  if (err instanceof HTTPException) {
    return c.json(
      {
        success: false,
        error: err.name || "HTTP Error",
        message: err.message,
      },
      err.status,
    );
  }

  console.error("Unhandled Application Error:", err);

  return c.json(
    {
      success: false,
      error: "Internal Server Error",
      message: err.message || "An unexpected error occurred.",
    },
    500,
  );
};
