import type { Prisma } from "@prisma/client";

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

export function recordAuditLog(params: CreateAuditLogParams, tx: Prisma.TransactionClient) {
  // A failed append must abort the enclosing mutation transaction.
  return tx.auditLog.create({
    data: {
      ...params,
      oldValue: params.oldValue ?? null,
      newValue: params.newValue ?? null,
      metadata: params.metadata ?? undefined,
    },
  });
}
