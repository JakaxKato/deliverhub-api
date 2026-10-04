import type { Department, Priority, Role, TaskStatus } from "@prisma/client";

export interface AuthUser {
  sessionId: string;
  userId: string;
  email: string;
  role: Role;
  department: Department;
  name: string;
}

// Compatibility for existing authorization consumers; these are DB values, not JWT claims.
export type JwtPayload = AuthUser;

export interface AccessTokenClaims {
  sub: string;
  jti: string;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

// Session identity is separate from the refreshed authorization actor.
declare module "hono" {
  interface ContextVariableMap {
    user: AuthUser;
    sessionId: string;
  }
}

export type { Department, Priority, Role, TaskStatus };
