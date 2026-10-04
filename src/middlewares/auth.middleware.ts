import type { MiddlewareHandler } from "hono";
import { prisma } from "../db/prisma";
import { loadActiveActor, verifyAccessToken } from "../utils/session.helper";

export const authMiddleware: MiddlewareHandler = async (c, next) => {
  const authHeader = c.req.header("Authorization");
  const match = authHeader && authHeader.length <= 8192 ? /^Bearer (\S+)$/i.exec(authHeader) : null;
  const token = match?.[1];
  if (!token) {
    return c.json(
      { success: false, error: "Unauthorized", message: "A Bearer token is required." },
      401,
    );
  }

  const claims = verifyAccessToken(token);
  // DB errors intentionally propagate to the error handler rather than masquerading as bad credentials.
  const user = await loadActiveActor(prisma, claims);
  c.set("user", user);
  c.set("sessionId", claims.jti);
  await next();
};
