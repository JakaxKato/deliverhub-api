import { PrismaClient, Role, Department, TaskStatus, Priority } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

export async function main() {
  console.log('🌱 Starting database seeding...');

  // Clean existing data
  await prisma.auditLog.deleteMany({});
  await prisma.taskAttachment.deleteMany({});
  await prisma.taskDependency.deleteMany({});
  await prisma.task.deleteMany({});
  await prisma.projectMember.deleteMany({});
  await prisma.project.deleteMany({});
  await prisma.user.deleteMany({});

  const hashedPassword = await bcrypt.hash('Password123!', 10);

  // 1. Create Users
  const pm = await prisma.user.create({
    data: {
      name: 'Sarah Jenkins',
      email: 'pm@nodewave.id',
      password: hashedPassword,
      role: Role.PM,
      department: Department.PRODUCT,
      avatarUrl: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150&auto=format&fit=crop&q=80',
    },
  });

  const uiux = await prisma.user.create({
    data: {
      name: 'Alex Rivera',
      email: 'uiux@nodewave.id',
      password: hashedPassword,
      role: Role.MEMBER,
      department: Department.UIUX,
      avatarUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80',
    },
  });

  const fe = await prisma.user.create({
    data: {
      name: 'David Chen',
      email: 'fe@nodewave.id',
      password: hashedPassword,
      role: Role.MEMBER,
      department: Department.FRONTEND,
      avatarUrl: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop&q=80',
    },
  });

  const be = await prisma.user.create({
    data: {
      name: 'Michael Scott',
      email: 'be@nodewave.id',
      password: hashedPassword,
      role: Role.MEMBER,
      department: Department.BACKEND,
      avatarUrl: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&auto=format&fit=crop&q=80',
    },
  });

  const client = await prisma.user.create({
    data: {
      name: 'Elena Rostova',
      email: 'client@acmecorp.com',
      password: hashedPassword,
      role: Role.CLIENT,
      department: Department.CLIENT,
      avatarUrl: 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=150&auto=format&fit=crop&q=80',
    },
  });

  console.log('✅ Created 5 seeded users across all roles');

  // 2. Create Project
  const project = await prisma.project.create({
    data: {
      key: 'NW-CORE',
      name: 'Enterprise Deliverable Management Engine',
      description: 'Mission-critical operational backbone for high-value client deliverables with state-based permissions and strict multi-tenant isolation.',
      clientId: client.id,
      members: {
        create: [
          { userId: pm.id },
          { userId: uiux.id },
          { userId: fe.id },
          { userId: be.id },
        ],
      },
    },
  });

  console.log(`✅ Created project: ${project.name} (${project.key})`);

  // 3. Create Tasks
  // Task 1: UI/UX (DONE)
  const task1 = await prisma.task.create({
    data: {
      taskCode: 'NW-CORE-001',
      projectId: project.id,
      title: 'Design High-Fidelity UI & State-Aware Flow',
      description: 'Create complete Figma specification for dependency-aware board, state locks, and client isolation screens.',
      status: TaskStatus.DONE,
      department: Department.UIUX,
      priority: Priority.HIGH,
      isClientVisible: true,
      creatorId: pm.id,
      assigneeId: uiux.id,
      version: 2,
    },
  });

  // Task 2: Backend API (DONE)
  const task2 = await prisma.task.create({
    data: {
      taskCode: 'NW-CORE-002',
      projectId: project.id,
      title: 'Implement Core REST API & Optimistic Locking',
      description: 'Develop Hono backend with version-based concurrency checks (409 Conflict) and immutable audit trail.',
      status: TaskStatus.DONE,
      department: Department.BACKEND,
      priority: Priority.URGENT,
      isClientVisible: true,
      creatorId: pm.id,
      assigneeId: be.id,
      version: 2,
    },
  });

  // Task 3: Frontend Slicing (IN_PROGRESS) - Depends on Task 1 & 2 (both are DONE, so allowed!)
  const task3 = await prisma.task.create({
    data: {
      taskCode: 'NW-CORE-003',
      projectId: project.id,
      title: 'Frontend Slicing & Dependency State Enforcement',
      description: 'Build Next.js 16 interactive Kanban board with client-side & API-side lock guards and TanStack Query.',
      status: TaskStatus.IN_PROGRESS,
      department: Department.FRONTEND,
      priority: Priority.HIGH,
      isClientVisible: true,
      creatorId: pm.id,
      assigneeId: fe.id,
      version: 1,
    },
  });

  // Task 4: Client Portal (BLOCKED) - Depends on Task 3 (which is IN_PROGRESS, not DONE!)
  const task4 = await prisma.task.create({
    data: {
      taskCode: 'NW-CORE-004',
      projectId: project.id,
      title: 'Multi-Tenant Data Masking & Client Dashboard',
      description: 'Deliver the client-facing view with aggregate percentage metrics and absolute identity masking.',
      status: TaskStatus.BLOCKED,
      department: Department.FRONTEND,
      priority: Priority.MEDIUM,
      isClientVisible: false,
      creatorId: pm.id,
      assigneeId: fe.id,
      version: 1,
    },
  });

  // Task 5: Daily Standup Summary (TODO)
  const task5 = await prisma.task.create({
    data: {
      taskCode: 'NW-CORE-005',
      projectId: project.id,
      title: 'Daily Standup Auto-Summary Aggregator',
      description: 'Aggregate yesterday audit trail entries and categorize into Completed Yesterday and Blocked Today per department.',
      status: TaskStatus.TODO,
      department: Department.BACKEND,
      priority: Priority.MEDIUM,
      isClientVisible: true,
      creatorId: pm.id,
      assigneeId: be.id,
      version: 1,
    },
  });

  // Task 6: Internal DevOps Audit Archival (TODO - internal only)
  const task6 = await prisma.task.create({
    data: {
      taskCode: 'NW-CORE-006',
      projectId: project.id,
      title: 'Audit Trail Cold Storage & Backup Script',
      description: 'Ensure immutable audit logs are persisted and replicated with zero data loss.',
      status: TaskStatus.TODO,
      department: Department.BACKEND,
      priority: Priority.LOW,
      isClientVisible: false,
      creatorId: pm.id,
      assigneeId: be.id,
      version: 1,
    },
  });

  console.log('✅ Created 6 initial tasks demonstrating various states');

  // 4. Create Task Dependencies
  // Task 3 depends on Task 1 and Task 2
  await prisma.taskDependency.createMany({
    data: [
      { taskId: task3.id, prerequisiteTaskId: task1.id },
      { taskId: task3.id, prerequisiteTaskId: task2.id },
      // Task 4 depends on Task 3 (making Task 4 BLOCKED!)
      { taskId: task4.id, prerequisiteTaskId: task3.id },
    ],
  });

  console.log('✅ Created task dependencies (Task 3 requires 1 & 2; Task 4 requires 3)');

  // 5. Create Attachments
  await prisma.taskAttachment.createMany({
    data: [
      {
        taskId: task1.id,
        uploaderId: uiux.id,
        fileName: 'Figma UI Specification v2.0',
        fileUrl: 'https://www.figma.com/design/nodewave-deliverable-platform',
        fileType: 'link/figma',
      },
      {
        taskId: task2.id,
        uploaderId: be.id,
        fileName: 'Pull Request #42: Optimistic Locking & Audit Trail',
        fileUrl: 'https://github.com/nodewave/core-api/pull/42',
        fileType: 'link/github_pr',
      },
    ],
  });

  console.log('✅ Created task deliverables and work attachments');

  // 6. Create Audit Trail Logs (some for yesterday to test Standup Summary!)
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(15, 30, 0, 0);

  const twoDaysAgo = new Date();
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

  await prisma.auditLog.createMany({
    data: [
      {
        projectId: project.id,
        taskId: task1.id,
        userId: pm.id,
        action: 'TASK_CREATED',
        changedColumn: 'status',
        oldValue: null,
        newValue: 'TODO',
        timestamp: twoDaysAgo,
      },
      {
        projectId: project.id,
        taskId: task1.id,
        userId: uiux.id,
        action: 'STATUS_CHANGED',
        changedColumn: 'status',
        oldValue: 'IN_PROGRESS',
        newValue: 'DONE',
        timestamp: yesterday,
        metadata: { note: 'Finalized Figma handoff tokens and components.' },
      },
      {
        projectId: project.id,
        taskId: task2.id,
        userId: be.id,
        action: 'STATUS_CHANGED',
        changedColumn: 'status',
        oldValue: 'IN_PROGRESS',
        newValue: 'DONE',
        timestamp: yesterday,
        metadata: { note: 'Merged PR #42 with optimistic locking tests.' },
      },
      {
        projectId: project.id,
        taskId: task3.id,
        userId: fe.id,
        action: 'STATUS_CHANGED',
        changedColumn: 'status',
        oldValue: 'TODO',
        newValue: 'IN_PROGRESS',
        timestamp: new Date(),
        metadata: { note: 'Prerequisites met. Started board slicing.' },
      },
      {
        projectId: project.id,
        taskId: task4.id,
        userId: pm.id,
        action: 'DEPENDENCY_ADDED',
        changedColumn: 'dependencies',
        oldValue: 'None',
        newValue: 'NW-CORE-003',
        timestamp: new Date(),
        metadata: { note: 'Blocked by NW-CORE-003 until frontend slicing is done.' },
      },
    ],
  });

  console.log('✅ Created immutable audit trail entries');
  console.log('🎉 Seeding successfully completed!');
}

if (import.meta.main) {
  main()
    .catch((e) => {
      console.error('❌ Seeding failed:', e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
