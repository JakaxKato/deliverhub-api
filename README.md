# DeliverHub API (NodeWave Deliverable Platform Backend)

Operational backbone API for managing deliverables of high-value projects. Built with
**TypeScript + Bun + Hono + Prisma + PostgreSQL**, enforcing state-based permissions
(RBAC + ABAC), inter-task dependencies, optimistic locking, immutable audit trails, and
multi-tenant client isolation.

## Stack

- Runtime: Bun
- HTTP framework: Hono
- ORM: Prisma (PostgreSQL)
- Auth: JWT (`jsonwebtoken`) + `bcryptjs`
- Validation: Zod
- Filtering / Pagination / Search: `@nodewave/prisma-ezfilter`
- Lint / Format: Biome
- Git hooks: Husky + Commitlint (Conventional Commits)

## Getting Started

```bash
bun install
cp .env.example .env   # fill DATABASE_URL + JWT_SECRET
bun run db:generate
bun run db:push
bun run db:seed        # creates demo users, project, tasks, dependencies, audit logs
bun run dev            # http://localhost:4000
```

## Scripts

| Script          | Description                                    |
| --------------- | ---------------------------------------------- |
| `bun run dev`   | Start with watch mode                          |
| `bun run start` | Start without watch                            |
| `bun run build` | Bundle to `dist/`                              |
| `bun test`      | Run integration tests (auto re-seeds DB)       |
| `bun run lint`  | Biome check on `src/`                          |
| `bun run db:push` / `db:seed` / `db:generate` | Prisma helpers |

## Seeded Accounts

All seeded accounts share the password `Password123!`.

| Role          | Email                  | Department |
| ------------- | ---------------------- | ---------- |
| Product Manager | `pm@nodewave.id`     | PRODUCT    |
| UI/UX Engineer  | `uiux@nodewave.id`   | UIUX       |
| Frontend Engineer | `fe@nodewave.id`   | FRONTEND   |
| Backend Engineer  | `be@nodewave.id`    | BACKEND    |
| Client Guest   | `client@acmecorp.com`  | CLIENT     |

## Core Business Logic

- **State-Based Permissions** — PM cannot move `IN_PROGRESS → DONE`; members can only
  act on tasks assigned to them or matching their department; clients are read-only.
- **Dependency-Aware Blocking** — a task with incomplete prerequisites cannot move to
  `IN_PROGRESS`/`DONE` (422 `TaskBlocked`), auto-unblocks when prerequisites complete,
  and cycle detection guards the dependency graph.
- **Optimistic Locking** — every mutation carries a `version`; stale writes get `409 Conflict`.
- **Immutable Audit Trail & Soft Deletes** — all field changes are logged
  (`audit_logs`) and no entity is hard-deleted.
- **Multi-Tenant Isolation & Masking** — clients only see their own project's
  client-visible tasks, with internal identities stripped at the API layer.
- **Daily Standup Summary** — `GET /api/audit/standup-summary/:projectId` aggregates
  "completed yesterday" and "blocked today" per department.

## Standard Filtering Contract (ezfilter)

Every list endpoint accepts `filters`, `searchFilters`, `rangedFilters`, `page`,
`rows`, `orderKey`, and `orderRule` query parameters (JSON-serialized objects), e.g.:

```
GET /api/tasks?projectId=<id>&filters={"status":"DONE"}&searchFilters={"title":"Design"}
GET /api/tasks?projectId=<id>&page=2&rows=10&orderKey=createdAt&orderRule=desc
GET /api/tasks?projectId=<id>&rangedFilters=[{"key":"version","start":1,"end":5}]
```

## Tests

`bun test` runs 10 integration tests covering state permissions, dependency blocking,
concurrency (409), cycle detection, client masking, ezfilter, and the standup summary.
The suite resets the database to the canonical seed before running, so it is safe to
re-run any number of times.
