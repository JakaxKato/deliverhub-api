import { Prisma } from "@prisma/client";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { prisma } from "../db/prisma";

export async function serializableTransaction<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await prisma.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10000,
        timeout: 20000,
      });
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== "P2034" ||
        attempt >= 3
      )
        throw error;
      await Bun.sleep(15 * 2 ** attempt + Math.floor(Math.random() * 15));
    }
  }
}

export function withProjectTransaction<T>(
  projectId: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  z.string().uuid().parse(projectId);
  return serializableTransaction(async (tx) => {
    // All graph/status/details writes take the same parent lock. The graph check and
    // automatic transitions therefore cannot race a different endpoint in this project.
    const projects = await tx.$queryRaw<
      { id: string }[]
    >`SELECT "id" FROM "projects" WHERE "id" = ${projectId} AND "deletedAt" IS NULL FOR UPDATE`;
    if (projects.length === 0) throw new HTTPException(404, { message: "Project not found." });
    return work(tx);
  });
}
