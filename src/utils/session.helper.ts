import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { HTTPException } from "hono/http-exception";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../config/env";
import type { AccessTokenClaims, AuthUser } from "../types";

const claimsSchema = z
  .object({
    sub: z.string().uuid(),
    jti: z.string().uuid(),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
    iss: z.literal(env.JWT_ISSUER),
    aud: z.literal(env.JWT_AUDIENCE),
  })
  .strict();

function unauthorized(): HTTPException {
  return new HTTPException(401, { message: "Invalid or expired session." });
}

export function verifyAccessToken(token: string, now = new Date()): AccessTokenClaims {
  try {
    const seconds = Math.floor(now.getTime() / 1000);
    const payload = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ["HS256"],
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      clockTimestamp: seconds,
      maxAge: env.JWT_TTL_SECONDS,
    });
    const claims = claimsSchema.parse(payload);
    if (
      claims.iat > seconds ||
      claims.exp <= claims.iat ||
      claims.exp <= seconds ||
      claims.exp - claims.iat > env.JWT_TTL_SECONDS
    ) {
      throw unauthorized();
    }
    return claims;
  } catch {
    throw unauthorized();
  }
}

export async function issueSession(
  tx: Prisma.TransactionClient,
  userId: string,
  now = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const user = await tx.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: { id: true },
  });
  if (!user) throw unauthorized();

  const jti = randomUUID();
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + env.JWT_TTL_SECONDS;
  const expiresAt = new Date(exp * 1000);
  await tx.session.create({ data: { jti, userId, expiresAt } });
  const token = jwt.sign({ iat, exp }, env.JWT_SECRET, {
    algorithm: "HS256",
    subject: userId,
    jwtid: jti,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  });
  return { token, expiresAt };
}

export async function loadActiveActor(
  db: Pick<Prisma.TransactionClient, "session">,
  claims: AccessTokenClaims,
  now = new Date(),
): Promise<AuthUser> {
  const session = await db.session.findFirst({
    where: {
      jti: claims.jti,
      userId: claims.sub,
      revokedAt: null,
      expiresAt: { gt: now },
      user: { deletedAt: null },
    },
    select: {
      expiresAt: true,
      user: { select: { id: true, email: true, name: true, role: true, department: true } },
    },
  });
  if (!session || session.expiresAt.getTime() !== claims.exp * 1000) throw unauthorized();
  return {
    sessionId: claims.jti,
    userId: session.user.id,
    email: session.user.email,
    role: session.user.role,
    department: session.user.department,
    name: session.user.name,
  };
}

export async function revokeSession(
  tx: Prisma.TransactionClient,
  userId: string,
  jti: string,
  now = new Date(),
): Promise<void> {
  await tx.session.updateMany({
    where: { jti, userId, revokedAt: null },
    data: { revokedAt: now },
  });
}
