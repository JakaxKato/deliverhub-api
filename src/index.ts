import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";
import { env } from "./config/env";
import { errorHandler } from "./middlewares/error.middleware";
import { auditRoutes } from "./modules/audit/audit.routes";
import { authRoutes } from "./modules/auth/auth.routes";
import { projectRoutes } from "./modules/projects/projects.routes";
import { taskRoutes } from "./modules/tasks/tasks.routes";

const app = new Hono();

// Global Middlewares
app.use("*", logger());
app.use("*", prettyJSON());
app.use(
  "*",
  cors({
    origin: (origin) => {
      // Allow localhost and any production domain
      return origin || "*";
    },
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    exposeHeaders: ["Content-Length", "X-Kuma-Revision"],
    maxAge: 600,
    credentials: true,
  }),
);

// Health check
app.get("/health", (c) => {
  return c.json({
    status: "healthy",
    service: "NodeWave Deliverable Platform API",
    runtime: "Bun",
    framework: "Hono",
    timestamp: new Date().toISOString(),
  });
});

// Mount Routes
app.route("/api/auth", authRoutes);
app.route("/api/projects", projectRoutes);
app.route("/api/tasks", taskRoutes);
app.route("/api/audit", auditRoutes);

// Global Error Handler
app.onError(errorHandler);

// 404 Handler
app.notFound((c) => {
  return c.json(
    {
      success: false,
      error: "Not Found",
      message: `The route ${c.req.method} ${c.req.path} was not found on this server.`,
    },
    404,
  );
});

console.log(`🚀 NodeWave Backend Engine running on http://localhost:${env.PORT}`);

export { app };
export default {
  port: env.PORT,
  fetch: app.fetch,
};
