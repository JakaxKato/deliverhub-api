import { type Prisma, Role } from "@prisma/client";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { prisma } from "../../db/prisma";
import { authMiddleware } from "../../middlewares/auth.middleware";
import type { AuthUser } from "../../types";
import { recordAuditLog } from "../../utils/audit.helper";
import {
  assertActiveActor,
  requireInternal,
  requireTask,
  taskAccessWhere,
} from "../../utils/authorization.helper";
import { buildPrismaQuery, parseQueryParams } from "../../utils/ezfilter.helper";
import { serializableTransaction } from "../../utils/transaction.helper";

const commentRoutes = new Hono();
commentRoutes.use("*", authMiddleware);

const commentInclude = {
  author: { select: { id: true, name: true, role: true, department: true, avatarUrl: true } },
} satisfies Prisma.CommentInclude;
type LoadedComment = Prisma.CommentGetPayload<{ include: typeof commentInclude }>;

const createCommentSchema = z
  .object({ taskId: z.string().uuid(), body: z.string().trim().min(1).max(4000) })
  .strict();

function commentDto(comment: LoadedComment, user: AuthUser) {
  return {
    id: comment.id,
    taskId: comment.taskId,
    projectId: comment.projectId,
    body: comment.body,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    author: {
      id: comment.author.id,
      name: comment.author.name,
      role: comment.author.role,
      department: comment.author.department,
      avatarUrl: comment.author.avatarUrl,
    },
    canDelete: user.role === Role.PM || comment.authorId === user.userId,
  };
}

// Internal discussion on a deliverable. Clients are rejected here and the client
// task DTO never embeds this relation, so comment history is masked by omission.
commentRoutes.get("/", async (c) => {
  const user = c.get("user");
  requireInternal(user);

  const filteringQuery = parseQueryParams(c, "comments");
  const baseQuery = buildPrismaQuery(filteringQuery);

  const taskId =
    c.req.query("taskId") ??
    (typeof filteringQuery.filters?.taskId === "string"
      ? filteringQuery.filters.taskId
      : undefined);
  const projectId =
    c.req.query("projectId") ??
    (typeof filteringQuery.filters?.projectId === "string"
      ? filteringQuery.filters.projectId
      : undefined);
  if (taskId) await requireTask(prisma, user, taskId);

  const whereConditions: Prisma.CommentWhereInput[] = [
    { deletedAt: null },
    { task: { is: taskAccessWhere(user) } },
  ];
  if (taskId) whereConditions.push({ taskId });
  if (projectId) whereConditions.push({ projectId });
  if (baseQuery.where) whereConditions.push(baseQuery.where);
  const where: Prisma.CommentWhereInput = { AND: whereConditions };

  const [comments, total] = await Promise.all([
    prisma.comment.findMany({
      where,
      orderBy: baseQuery.orderBy as Prisma.CommentOrderByWithRelationInput[],
      skip: baseQuery.skip,
      take: baseQuery.take,
      include: commentInclude,
    }),
    prisma.comment.count({ where }),
  ]);

  return c.json({
    success: true,
    data: comments.map((comment) => commentDto(comment, user)),
    meta: {
      page: filteringQuery.page,
      rows: filteringQuery.rows,
      total,
      totalPages: Math.ceil(total / filteringQuery.rows),
    },
  });
});

commentRoutes.post("/", async (c) => {
  const user = c.get("user");
  requireInternal(user);

  const body: unknown = await c.req.json().catch(() => {
    throw new HTTPException(400, { message: "A valid JSON mutation body is required." });
  });
  const payload = createCommentSchema.parse(body);
  const task = await requireTask(prisma, user, payload.taskId);

  const comment = await serializableTransaction(async (tx) => {
    await assertActiveActor(tx, user);
    const created = await tx.comment.create({
      data: {
        taskId: task.id,
        projectId: task.projectId,
        authorId: user.userId,
        body: payload.body,
      },
      include: commentInclude,
    });
    await recordAuditLog(
      {
        projectId: task.projectId,
        taskId: task.id,
        userId: user.userId,
        action: "COMMENT_ADDED",
        changedColumn: "comment",
        newValue: payload.body.slice(0, 200),
        metadata: { commentId: created.id },
      },
      tx,
    );
    return created;
  });

  return c.json({ success: true, data: commentDto(comment, user) }, 201);
});

commentRoutes.delete("/:id", async (c) => {
  const user = c.get("user");
  requireInternal(user);

  const id = c.req.param("id");
  // Soft delete is mandatory: historical comments remain for the audit trail.
  const comment = await prisma.comment.findFirst({
    where: { AND: [{ id, deletedAt: null }, { task: { is: taskAccessWhere(user) } }] },
  });
  if (!comment) throw new HTTPException(404, { message: "Comment not found." });
  if (user.role !== Role.PM && comment.authorId !== user.userId) {
    throw new HTTPException(403, {
      message: "Only the author or a project manager may delete this comment.",
    });
  }

  await serializableTransaction(async (tx) => {
    await assertActiveActor(tx, user);
    const result = await tx.comment.updateMany({
      where: { id, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count !== 1) throw new HTTPException(404, { message: "Comment not found." });
    await recordAuditLog(
      {
        projectId: comment.projectId,
        taskId: comment.taskId,
        userId: user.userId,
        action: "COMMENT_DELETED",
        changedColumn: "comment",
        oldValue: comment.body.slice(0, 200),
        metadata: { commentId: id },
      },
      tx,
    );
  });

  return c.body(null, 204);
});

export { commentRoutes };
