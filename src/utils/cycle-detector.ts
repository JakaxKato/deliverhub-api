import { prisma } from "../db/prisma";

/**
 * Checks if adding a dependency (downstreamTaskId depends on upstreamTaskId)
 * would introduce a cycle into the Directed Acyclic Graph (DAG).
 *
 * A cycle would occur if upstreamTaskId already transitively depends on downstreamTaskId.
 */
export async function wouldCreateCycle(
  downstreamTaskId: string,
  upstreamTaskId: string,
): Promise<boolean> {
  if (downstreamTaskId === upstreamTaskId) {
    return true;
  }

  // Load all dependencies in this project or graph
  const allDeps = await prisma.taskDependency.findMany({
    select: {
      taskId: true, // downstream
      prerequisiteTaskId: true, // upstream
    },
  });

  // Build adjacency map: task -> list of its prerequisites
  const adj = new Map<string, string[]>();
  for (const dep of allDeps) {
    if (!adj.has(dep.taskId)) {
      adj.set(dep.taskId, []);
    }
    adj.get(dep.taskId)?.push(dep.prerequisiteTaskId);
  }

  // Also add the prospective edge: downstreamTaskId -> upstreamTaskId
  if (!adj.has(downstreamTaskId)) {
    adj.set(downstreamTaskId, []);
  }
  adj.get(downstreamTaskId)?.push(upstreamTaskId);

  // DFS to check if we can reach downstreamTaskId starting from upstreamTaskId
  const visited = new Set<string>();
  const stack = [upstreamTaskId];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    if (current === downstreamTaskId) {
      return true; // Cycle detected!
    }

    if (!visited.has(current)) {
      visited.add(current);
      const prerequisites = adj.get(current) || [];
      for (const prereq of prerequisites) {
        if (!visited.has(prereq)) {
          stack.push(prereq);
        }
      }
    }
  }

  return false;
}
