import { describe, it, expect, beforeAll } from 'bun:test';
import { app } from '../src/index';
import { prisma } from '../src/db/prisma';
import { main as seedDatabase } from '../prisma/seed';

let pmToken: string;
let feToken: string;
let clientToken: string;
let projectId: string;
let task1Id: string; // UI/UX (DONE)
let task2Id: string; // Backend (DONE)
let task3Id: string; // Frontend (IN_PROGRESS)
let task4Id: string; // Blocked Frontend (BLOCKED by Task 3)

beforeAll(async () => {
  // Reset database to the canonical seeded state so tests are idempotent
  // and never depend on leftovers from previous runs.
  await seedDatabase();

  // 1. Get tokens for seeded users
  const pmRes = await app.request('/api/auth/quick-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'pm@nodewave.id' }),
  });
  const pmData = (await pmRes.json()) as any;
  pmToken = pmData.data.token;

  const feRes = await app.request('/api/auth/quick-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'fe@nodewave.id' }),
  });
  const feData = (await feRes.json()) as any;
  feToken = feData.data.token;

  const clientRes = await app.request('/api/auth/quick-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'client@acmecorp.com' }),
  });
  const clientData = (await clientRes.json()) as any;
  clientToken = clientData.data.token;

  // Retrieve seeded project and tasks
  const project = await prisma.project.findFirst({
    where: { key: 'NW-CORE' },
    include: { tasks: true },
  });

  projectId = project!.id;
  task1Id = project!.tasks.find((t) => t.taskCode === 'NW-CORE-001')!.id;
  task2Id = project!.tasks.find((t) => t.taskCode === 'NW-CORE-002')!.id;
  task3Id = project!.tasks.find((t) => t.taskCode === 'NW-CORE-003')!.id;
  task4Id = project!.tasks.find((t) => t.taskCode === 'NW-CORE-004')!.id;
});

describe('1. State-Based Permissions & Dependency Rules', () => {
  it('BLOCKED task cannot be moved to IN_PROGRESS if prerequisites are not DONE', async () => {
    // Task 4 depends on Task 3, which is currently IN_PROGRESS (not DONE)
    const task4 = await prisma.task.findUnique({ where: { id: task4Id } });

    const res = await app.request(`/api/tasks/${task4Id}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${feToken}`,
      },
      body: JSON.stringify({
        status: 'IN_PROGRESS',
        version: task4!.version,
      }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as any;
    expect(body.success).toBe(false);
    expect(body.error).toBe('TaskBlocked');
    expect(body.message).toContain('incomplete prerequisite dependencies');
  });

  it('Product Manager CANNOT move an IN_PROGRESS task to DONE (only executor can)', async () => {
    // Task 3 is IN_PROGRESS
    const task3 = await prisma.task.findUnique({ where: { id: task3Id } });

    const res = await app.request(`/api/tasks/${task3Id}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${pmToken}`,
      },
      body: JSON.stringify({
        status: 'DONE',
        version: task3!.version,
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.success).toBe(false);
    expect(body.message).toContain('Product Managers cannot mark tasks as Done');
  });

  it('Assigned Engineer CAN move their IN_PROGRESS task to DONE', async () => {
    const task3 = await prisma.task.findUnique({ where: { id: task3Id } });

    const res = await app.request(`/api/tasks/${task3Id}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${feToken}`,
      },
      body: JSON.stringify({
        status: 'DONE',
        version: task3!.version,
        note: 'Completed frontend slicing and verification.',
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('DONE');

    // After Task 3 is DONE, verify dependent Task 4 was automatically unblocked to TODO!
    const task4Updated = await prisma.task.findUnique({ where: { id: task4Id } });
    expect(task4Updated!.status).toBe('TODO');
  });
});

describe('2. Concurrency & Optimistic Locking', () => {
  it('Rejects conflicting concurrent updates with 409 Conflict', async () => {
    const task = await prisma.task.findUnique({ where: { id: task1Id } });
    const currentVersion = task!.version;

    // First update succeeds
    const res1 = await app.request(`/api/tasks/${task1Id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${pmToken}`,
      },
      body: JSON.stringify({
        version: currentVersion,
        description: 'First concurrent update by PM',
      }),
    });
    expect(res1.status).toBe(200);

    // Second update with stale version must be rejected with 409 Conflict
    const res2 = await app.request(`/api/tasks/${task1Id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${pmToken}`,
      },
      body: JSON.stringify({
        version: currentVersion, // Stale version!
        description: 'Second concurrent update with old version',
      }),
    });

    expect(res2.status).toBe(409);
    const body2 = (await res2.json()) as any;
    expect(body2.success).toBe(false);
    expect(body2.error).toBe('Conflict');
  });
});

describe('3. Circular Dependency Detection (DAG)', () => {
  it('Prevents circular dependencies from being added', async () => {
    // Task 1 and Task 2 are prerequisites for Task 3.
    // If PM tries to make Task 1 depend on Task 3, it should fail due to cycle (Task 1 -> Task 3 -> Task 1)
    const res = await app.request(`/api/tasks/${task1Id}/dependencies`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${pmToken}`,
      },
      body: JSON.stringify({
        prerequisiteTaskId: task3Id,
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.success).toBe(false);
    expect(body.error).toBe('CircularDependency');
  });
});

describe('4. Client Isolation & Data Masking', () => {
  it('Client Guest only sees client-visible tasks and masked internal data', async () => {
    const res = await app.request(`/api/tasks?projectId=${projectId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${clientToken}`,
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);

    // All returned tasks must have isClientVisible === true
    for (const task of body.data) {
      expect(task.isClientVisible).toBe(true);
      // Engineer email, avatar, and specific internal identities must NOT be exposed
      expect(task.department).toBeUndefined();
      if (task.assignee) {
        expect(task.assignee.name).toBe('Assigned Specialist');
        expect(task.assignee.email).toBeUndefined();
      }
      expect(task.auditLogs).toEqual([]);
    }
  });

  it('Client Guest can access aggregate project metrics', async () => {
    const res = await app.request(`/api/projects/${projectId}/metrics`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${clientToken}`,
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.data.percentageFormatted).toBeDefined();
    expect(body.data.completedTasks).toBeGreaterThanOrEqual(0);
  });
});

describe('5. NodeWave Standard Filtering & Searching', () => {
  it('Filters tasks by status using exact match JSON filters', async () => {
    const filtersParam = encodeURIComponent(JSON.stringify({ status: 'DONE' }));
    const res = await app.request(`/api/tasks?projectId=${projectId}&filters=${filtersParam}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${pmToken}`,
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    for (const task of body.data) {
      expect(task.status).toBe('DONE');
    }
  });

  it('Searches tasks by partial title using searchFilters', async () => {
    const searchParam = encodeURIComponent(JSON.stringify({ title: 'Design' }));
    const res = await app.request(`/api/tasks?projectId=${projectId}&searchFilters=${searchParam}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${pmToken}`,
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data[0].title).toContain('Design');
  });
});

describe('6. Daily Standup Auto-Summary', () => {
  it('Generates structured standup summary by department', async () => {
    const res = await app.request(`/api/audit/standup-summary/${projectId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${pmToken}`,
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.data.summary.completedYesterday).toBeDefined();
    expect(body.data.summary.blockedToday).toBeDefined();
    expect(body.data.summary.inProgressToday).toBeDefined();
    expect(body.data.markdown).toContain('Daily Standup Summary');
  });
});
