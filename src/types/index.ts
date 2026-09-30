import type { Department, Priority, Role, TaskStatus } from "@prisma/client";

export interface JwtPayload {
  userId: string;
  email: string;
  role: Role;
  department: Department;
  name: string;
}

declare module "hono" {
  interface ContextVariableMap {
    user: JwtPayload;
  }
}

export type { Department, Priority, Role, TaskStatus };
