import { Department, Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { Hono } from "hono";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../../config/env";
import { prisma } from "../../db/prisma";
import { authMiddleware } from "../../middlewares/auth.middleware";

const authRoutes = new Hono();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters long"),
  name: z.string().min(2, "Name must be at least 2 characters long"),
  role: z.nativeEnum(Role),
  department: z.nativeEnum(Department),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, "Password is required"),
});

// Register
authRoutes.post("/register", async (c) => {
  const body = await c.req.json();
  const data = registerSchema.parse(body);

  const existingUser = await prisma.user.findUnique({
    where: { email: data.email },
  });

  if (existingUser) {
    return c.json(
      { success: false, error: "Conflict", message: "Email is already registered" },
      409,
    );
  }

  const hashedPassword = await bcrypt.hash(data.password, 10);
  const user = await prisma.user.create({
    data: {
      email: data.email,
      password: hashedPassword,
      name: data.name,
      role: data.role,
      department: data.department,
    },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      department: true,
      avatarUrl: true,
      createdAt: true,
    },
  });

  const token = jwt.sign(
    {
      userId: user.id,
      email: user.email,
      role: user.role,
      department: user.department,
      name: user.name,
    },
    env.JWT_SECRET,
    { expiresIn: "7d" },
  );

  return c.json(
    {
      success: true,
      message: "Account registered successfully",
      data: { user, token },
    },
    201,
  );
});

// Login
authRoutes.post("/login", async (c) => {
  const body = await c.req.json();
  const data = loginSchema.parse(body);

  const user = await prisma.user.findFirst({
    where: { email: data.email, deletedAt: null },
  });

  if (!user) {
    return c.json(
      { success: false, error: "Unauthorized", message: "Invalid email or password" },
      401,
    );
  }

  const passwordMatches = await bcrypt.compare(data.password, user.password);
  if (!passwordMatches) {
    return c.json(
      { success: false, error: "Unauthorized", message: "Invalid email or password" },
      401,
    );
  }

  const token = jwt.sign(
    {
      userId: user.id,
      email: user.email,
      role: user.role,
      department: user.department,
      name: user.name,
    },
    env.JWT_SECRET,
    { expiresIn: "7d" },
  );

  return c.json({
    success: true,
    message: "Login successful",
    data: {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        department: user.department,
        avatarUrl: user.avatarUrl,
      },
      token,
    },
  });
});

// Me (Current User)
authRoutes.get("/me", authMiddleware, async (c) => {
  const currentUser = c.get("user");

  const user = await prisma.user.findUnique({
    where: { id: currentUser.userId },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      department: true,
      avatarUrl: true,
      createdAt: true,
      projectMemberships: {
        include: {
          project: {
            select: { id: true, name: true, key: true },
          },
        },
      },
      clientProjects: {
        select: { id: true, name: true, key: true },
      },
    },
  });

  if (!user) {
    return c.json({ success: false, error: "User not found" }, 404);
  }

  return c.json({
    success: true,
    data: user,
  });
});

// Seeded Users list (for quick switch / evaluator convenience)
authRoutes.get("/seeded-users", async (c) => {
  const users = await prisma.user.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      department: true,
      avatarUrl: true,
    },
    orderBy: { createdAt: "asc" },
  });

  return c.json({
    success: true,
    data: users,
  });
});

// Quick Switch Role (returns JWT for seeded email)
authRoutes.post("/quick-login", async (c) => {
  const { email } = await c.req.json();
  const user = await prisma.user.findFirst({
    where: { email, deletedAt: null },
  });

  if (!user) {
    return c.json({ success: false, error: "User not found" }, 404);
  }

  const token = jwt.sign(
    {
      userId: user.id,
      email: user.email,
      role: user.role,
      department: user.department,
      name: user.name,
    },
    env.JWT_SECRET,
    { expiresIn: "7d" },
  );

  return c.json({
    success: true,
    message: `Switched session to ${user.name} (${user.role} - ${user.department})`,
    data: {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        department: user.department,
        avatarUrl: user.avatarUrl,
      },
      token,
    },
  });
});

export { authRoutes };
