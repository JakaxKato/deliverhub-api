import { Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { prisma } from "../../db/prisma";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { issueSession, revokeSession } from "../../utils/session.helper";

const authRoutes = new Hono();
const emailSchema = z.string().trim().toLowerCase().email().max(254);
const passwordSchema = z
  .string()
  .min(8)
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= 72,
    "Password must be at most 72 UTF-8 bytes for bcrypt",
  );

const registerSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    name: z.string().trim().min(2).max(100),
    role: z.literal("MEMBER").optional(),
    department: z.enum(["UIUX", "FRONTEND", "BACKEND"]),
  })
  .strict();

const loginSchema = z
  .object({
    email: emailSchema,
    password: z
      .string()
      .min(1)
      .refine((value) => Buffer.byteLength(value, "utf8") <= 72),
  })
  .strict();

const publicUserSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  department: true,
  avatarUrl: true,
  createdAt: true,
} as const;

function invalidCredentials(): HTTPException {
  return new HTTPException(401, { message: "Invalid email or password." });
}

// A valid dummy hash prevents nonexistent accounts from skipping the bcrypt work.
const dummyPasswordHash = bcrypt.hashSync(crypto.randomUUID(), 10);

authRoutes.post("/register", async (c) => {
  const data = registerSchema.parse(await c.req.json());
  const password = await bcrypt.hash(data.password, 10);
  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: data.email,
        password,
        name: data.name,
        role: Role.MEMBER,
        department: data.department,
      },
      select: publicUserSelect,
    });
    const session = await issueSession(tx, user.id);
    return { user, ...session };
  });
  return c.json({ success: true, message: "Account registered successfully", data: result }, 201);
});

authRoutes.post("/login", async (c) => {
  const data = loginSchema.parse(await c.req.json());
  const credentials = await prisma.user.findFirst({
    where: { email: data.email, deletedAt: null },
    select: { id: true, password: true },
  });
  const matches = await bcrypt.compare(data.password, credentials?.password ?? dummyPasswordHash);
  if (!credentials || !matches) throw invalidCredentials();

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findFirst({
      where: { id: credentials.id, deletedAt: null, password: credentials.password },
      select: publicUserSelect,
    });
    if (!user) throw invalidCredentials();
    const session = await issueSession(tx, user.id);
    return { user, ...session };
  });
  return c.json({ success: true, message: "Login successful", data: result });
});

authRoutes.post("/logout", authMiddleware, async (c) => {
  await prisma.$transaction(async (tx) => {
    await revokeSession(tx, c.get("user").userId, c.get("sessionId"));
  });
  return c.body(null, 204);
});

authRoutes.get("/me", authMiddleware, async (c) => {
  const actor = c.get("user");
  const user = await prisma.user.findFirst({
    where: { id: actor.userId, deletedAt: null },
    select: {
      ...publicUserSelect,
      projectMemberships: {
        where: { deletedAt: null, project: { deletedAt: null } },
        select: {
          id: true,
          projectId: true,
          userId: true,
          assignedAt: true,
          project: { select: { id: true, name: true, key: true } },
        },
      },
      clientProjects: {
        where: { deletedAt: null },
        select: { id: true, name: true, key: true },
      },
    },
  });
  if (!user) throw new HTTPException(401, { message: "Invalid or expired session." });
  return c.json({ success: true, data: user });
});

// These former impersonation endpoints are disabled in every environment, without touching the DB.
authRoutes.all("/seeded-users", (c) => c.json({ success: false, error: "Not Found" }, 404));
authRoutes.all("/quick-login", (c) => c.json({ success: false, error: "Not Found" }, 404));

export { authRoutes };
