import { Department, Priority, Prisma, PrismaClient, Role, TaskStatus } from "@prisma/client";
import bcrypt from "bcryptjs";
import { env } from "../src/config/env";

const prisma = new PrismaClient();
const accountSpecs = [
  { name: "Sarah Jenkins", email: "pm@nodewave.id", role: Role.PM, department: Department.PRODUCT },
  {
    name: "Alex Rivera",
    email: "uiux@nodewave.id",
    role: Role.MEMBER,
    department: Department.UIUX,
  },
  {
    name: "David Chen",
    email: "fe@nodewave.id",
    role: Role.MEMBER,
    department: Department.FRONTEND,
  },
  {
    name: "Michael Scott",
    email: "be@nodewave.id",
    role: Role.MEMBER,
    department: Department.BACKEND,
  },
  {
    name: "Elena Rostova",
    email: "client@acmecorp.com",
    role: Role.CLIENT,
    department: Department.CLIENT,
  },
];

export async function main(): Promise<void> {
  if (env.NODE_ENV === "production" && !env.ALLOW_PRODUCTION_SEED) {
    throw new Error("Production seeding requires explicit ALLOW_PRODUCTION_SEED=true consent.");
  }
  if (!env.SEED_PASSWORD) throw new Error("Set SEED_PASSWORD explicitly before seeding.");
  const password = await bcrypt.hash(env.SEED_PASSWORD, 10);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const message = await prisma.$transaction(
        async (tx) => {
          const users = [];
          for (const spec of accountSpecs) {
            const existing = await tx.user.findUnique({ where: { email: spec.email } });
            // Never reset passwords, roles, profiles, or deletion state of existing accounts.
            users.push(existing ?? (await tx.user.create({ data: { ...spec, password } })));
          }
          const existingProject = await tx.project.findUnique({ where: { key: "NW-CORE" } });
          if (existingProject) return "Existing NW-CORE project and all its data left unchanged.";

          if (
            users.some((user, index) => {
              const spec = accountSpecs[index];
              return (
                !spec ||
                user.deletedAt !== null ||
                user.role !== spec.role ||
                user.department !== spec.department
              );
            })
          ) {
            return "Demo project skipped: existing demo accounts are inactive or have incompatible roles/departments.";
          }
          const [pm, uiux, frontend, backend, client] = users;
          if (!pm || !uiux || !frontend || !backend || !client)
            throw new Error("Incomplete demo account set.");
          const project = await tx.project.create({
            data: {
              key: "NW-CORE",
              name: "Enterprise Deliverable Management Engine",
              description:
                "Sample project demonstrating dependencies, roles, and client-visible deliverables.",
              clientId: client.id,
              members: {
                create: [pm, uiux, frontend, backend].map((user) => ({ userId: user.id })),
              },
            },
          });
          await tx.auditLog.create({
            data: {
              projectId: project.id,
              userId: pm.id,
              action: "PROJECT_CREATED",
              changedColumn: "project",
              newValue: project.name,
              metadata: { source: "demo-seed" },
            },
          });

          const taskSpecs = [
            {
              title: "Design High-Fidelity UI & State-Aware Flow",
              description: "Design the dependency-aware board and client portal.",
              department: Department.UIUX,
              status: TaskStatus.DONE,
              priority: Priority.HIGH,
              assigneeId: uiux.id,
              isClientVisible: true,
            },
            {
              title: "Implement Core REST API & Optimistic Locking",
              description: "Implement version checks and transactional auditing.",
              department: Department.BACKEND,
              status: TaskStatus.DONE,
              priority: Priority.URGENT,
              assigneeId: backend.id,
              isClientVisible: true,
            },
            {
              title: "Frontend Slicing & Dependency State Enforcement",
              description: "Build the task board with dependency-aware controls.",
              department: Department.FRONTEND,
              status: TaskStatus.IN_PROGRESS,
              priority: Priority.HIGH,
              assigneeId: frontend.id,
              isClientVisible: true,
            },
            {
              title: "Multi-Tenant Data Masking & Client Dashboard",
              description: "Implement the client-facing deliverable view.",
              department: Department.FRONTEND,
              status: TaskStatus.BLOCKED,
              priority: Priority.MEDIUM,
              assigneeId: frontend.id,
              isClientVisible: false,
            },
            {
              title: "Daily Standup Auto-Summary Aggregator",
              description: "Summarize project progress and blockers.",
              department: Department.BACKEND,
              status: TaskStatus.TODO,
              priority: Priority.MEDIUM,
              assigneeId: backend.id,
              isClientVisible: true,
            },
            {
              title: "Audit Trail Cold Storage & Backup Script",
              description: "Prepare internal audit retention and backup operations.",
              department: Department.BACKEND,
              status: TaskStatus.TODO,
              priority: Priority.LOW,
              assigneeId: backend.id,
              isClientVisible: false,
            },
          ];
          const tasks = [];
          for (const [index, spec] of taskSpecs.entries()) {
            const task = await tx.task.create({
              data: {
                ...spec,
                projectId: project.id,
                creatorId: pm.id,
                taskCode: `${project.key}-${String(index + 1).padStart(3, "0")}`,
              },
            });
            tasks.push(task);
            await tx.auditLog.create({
              data: {
                projectId: project.id,
                taskId: task.id,
                userId: pm.id,
                action: "TASK_CREATED",
                changedColumn: "title",
                newValue: task.title,
                metadata: { source: "demo-seed", status: task.status, department: task.department },
              },
            });
          }
          const [designTask, apiTask, frontendTask, portalTask] = tasks;
          if (!designTask || !apiTask || !frontendTask || !portalTask)
            throw new Error("Incomplete demo task set.");
          for (const [taskId, prerequisiteTaskId] of [
            [frontendTask.id, designTask.id],
            [frontendTask.id, apiTask.id],
            [portalTask.id, frontendTask.id],
          ] as const) {
            await tx.taskDependency.create({ data: { taskId, prerequisiteTaskId } });
            await tx.auditLog.create({
              data: {
                projectId: project.id,
                taskId,
                userId: pm.id,
                action: "DEPENDENCY_ADDED",
                changedColumn: "dependencies",
                newValue: prerequisiteTaskId,
                metadata: { source: "demo-seed" },
              },
            });
          }
          const commentSpecs = [
            {
              taskId: designTask.id,
              authorId: uiux.id,
              body: "High-fidelity states and empty/error views are ready for handoff.",
            },
            {
              taskId: apiTask.id,
              authorId: backend.id,
              body: "Optimistic locking and append-only audit writes are merged.",
            },
            {
              taskId: frontendTask.id,
              authorId: pm.id,
              body: "Still blocked until the UI/UX and API prerequisites are marked Done.",
            },
          ];
          for (const spec of commentSpecs) {
            const comment = await tx.comment.create({
              data: { ...spec, projectId: project.id },
            });
            await tx.auditLog.create({
              data: {
                projectId: project.id,
                taskId: spec.taskId,
                userId: spec.authorId,
                action: "COMMENT_ADDED",
                changedColumn: "comment",
                newValue: spec.body,
                metadata: { source: "demo-seed", commentId: comment.id },
              },
            });
          }
          return "Created demo accounts, project, tasks, dependencies, comments, and append-only audit entries.";
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000 },
      );
      console.log(message);
      return;
    } catch (error) {
      if (
        attempt < 2 &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === "P2034" || error.code === "P2002")
      )
        continue;
      throw error;
    }
  }
}

if (import.meta.main) {
  main()
    .catch((error) => {
      console.error("Seeding failed:", error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
