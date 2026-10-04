import type { Prisma } from "@prisma/client";

export async function wouldCreateCycle(
  tx: Prisma.TransactionClient,
  projectId: string,
  downstreamTaskId: string,
  upstreamTaskId: string,
): Promise<boolean> {
  if (downstreamTaskId === upstreamTaskId) return true;
  const edges = await tx.taskDependency.findMany({
    where: {
      deletedAt: null,
      task: { projectId, deletedAt: null },
      prerequisiteTask: { projectId, deletedAt: null },
    },
    select: { taskId: true, prerequisiteTaskId: true },
  });
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const neighbors = adjacency.get(edge.taskId) ?? [];
    neighbors.push(edge.prerequisiteTaskId);
    adjacency.set(edge.taskId, neighbors);
  }
  const visited = new Set<string>();
  const stack = [upstreamTaskId];
  while (stack.length) {
    const current = stack.pop();
    if (!current) break;
    if (current === downstreamTaskId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    stack.push(...(adjacency.get(current) ?? []));
  }
  return false;
}
