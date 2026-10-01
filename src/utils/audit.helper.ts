import type { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma";

export interface CreateAuditLogParams {
  projectId: string;
  taskId?: string;
  userId: string;
  action: string;
  changedColumn?: string;
  oldValue?: string | null;
  newValue?: string | null;
  metadata?: Prisma.InputJsonValue;
}

export async function recordAuditLog(params: CreateAuditLogParams) {
  try {
    return await prisma.auditLog.create({
      data: {
        projectId: params.projectId,
        taskId: params.taskId,
        userId: params.userId,
        action: params.action,
        changedColumn: params.changedColumn,
        oldValue: params.oldValue !== undefined ? String(params.oldValue) : null,
        newValue: params.newValue !== undefined ? String(params.newValue) : null,
        metadata: params.metadata ?? undefined,
      },
    });
  } catch (error) {
    console.error("Failed to create immutable audit log:", error);
    // Audit log failure shouldn't crash the server but should be logged
  }
}
