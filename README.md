# DeliverHub API

TypeScript, Bun, Hono, Prisma 6.4.1, and PostgreSQL. Authentication uses bcrypt and
HS256 JWTs backed by persisted, revocable sessions. Query construction retains
`@nodewave/prisma-ezfilter`, behind application-owned input whitelists.

## Setup

```bash
bun install
cp .env.example .env
# Supply a real DATABASE_URL, a fresh random JWT_SECRET, and exact CORS_ORIGIN values.
bun run db:generate
bun run db:migrate
bun run dev
```

There are no default database credentials or JWT signing secrets. Generate a new
secret with a cryptographically secure generator (for example, `openssl rand -hex 32`)
and store it in your environment or secret manager, never in source control.

`bun run start` validates configuration, applies committed migrations, then starts
the server. It never seeds. The Docker image sets `NODE_ENV=production`, generates
Prisma during build, and follows the same startup path. Build does not apply DB
migrations; provide runtime secrets through your deployment platform.

### Configuration

| Variable | Contract |
| --- | --- |
| `DATABASE_URL` | Required PostgreSQL URL for the intended database |
| `JWT_SECRET` | Required fresh secret, at least 32 characters; legacy fallback rejected |
| `JWT_EXPIRES_IN` | Positive seconds or `s`/`m`/`h`/`d` duration; default `7d`, maximum 30 days |
| `JWT_ISSUER`, `JWT_AUDIENCE` | Nonempty; defaults `nodewave-api`, `nodewave-web` |
| `CORS_ORIGIN` | Required comma-separated exact HTTP(S) origins; no wildcard, paths, or trailing slashes |
| `PORT` | Integer 1–65535; default 4000 |
| `NODE_ENV` | `development`, `test`, or `production`; default development outside Docker |
| `SEED_PASSWORD` | Required only for explicit seeding; 12+ characters, at most 72 UTF-8 bytes |
| `ALLOW_PRODUCTION_SEED` | Literal `true` required to consent to production demo seeding; defaults false |

Leave optional `SEED_PASSWORD` unset when not seeding. An explicitly empty value is
invalid. CORS uses exact origin matching and does not enable cookie credentials;
clients authenticate with the Authorization bearer header. Production unexpected
errors return generic messages, not Prisma, JWT, or connection details.

## Authentication

- `POST /api/auth/register`: `email`, `password`, `name`, and `department`.
  Only `UIUX`, `FRONTEND`, and `BACKEND` departments are accepted. Role is always
  persisted as `MEMBER`; optional `role: "MEMBER"` is accepted for compatibility.
  Privileged roles and unknown payload fields are rejected.
- `POST /api/auth/login`: email/password login. Passwords are never included in DTOs.
  Registration and login return `data.user`, `data.token`, and `data.expiresAt`.
- `GET /api/auth/me`: requires an active session and returns active project relations.
- `POST /api/auth/logout`: requires an active bearer session, revokes its `jti`, and
  returns 204. Subsequent use of that token is unauthorized. Other sessions are unaffected.
- `/api/auth/quick-login` and `/api/auth/seeded-users`: always 404 in every environment.
  There is no demo/evaluator bypass flag.

JWTs require UUID `sub` and `jti`, integer `iat`/`exp`, the configured issuer/audience,
and HS256. Every protected request checks the DB session, matching subject, expiry,
revocation, and active user. The authorization actor's role and department are freshly
loaded from the DB. Session expiry and JWT expiry use the same configured TTL.
Legacy tokens without persisted sessions are rejected: existing users must log in again.
Rotate any previously deployed fallback signing secret and review privileged accounts
created through the old public registration path. Email inputs are trimmed and lowercased;
review legacy mixed-case addresses and case-colliding accounts before rollout.

## Migrations and existing databases

Use `bun run db:migrate` (`prisma migrate deploy`), not `db push`, for setup and deployment.
`0001_init` is the original schema; `0002_security` hardens it and `0003_comments`
adds internal task comments. `0002_security` adds:

- `sessions` keyed by UUID-valued `jti`, linked to the user, with expiry/revocation.
- `deletedAt` on project memberships and dependency edges.
- A partial unique dependency index for active `(taskId, prerequisiteTaskId)` pairs.
  Historical soft-deleted pairs may coexist. Prisma models the ordinary lookup index;
  the partial unique index is intentionally maintained in SQL.
- Restrictive audit project/task/user foreign keys, including restricted ID updates.
- A PostgreSQL statement-level trigger rejecting audit UPDATE, DELETE, and TRUNCATE.

`0003_comments` adds the `comments` table (`taskId`, `projectId`, `authorId`, `body`,
`createdAt`, `updatedAt`, `deletedAt`) with task/project cascades and a restricted author
foreign key. Comments are soft-deleted, never hard-deleted.

Audit records are insert-only once this migration is applied. Business mutations
must insert their audit records in the same transaction, with insertion failures
propagated; DB immutability does not itself make separate application writes atomic.
Use a restricted runtime DB role that cannot alter tables, disable triggers, or
change replication settings. Migration privileges belong to a separate operator
role where your deployment permits it. Do not delete records referenced by audits;
soft-delete them instead. Test cleanup must not disable the audit trigger.

### Database previously created with `prisma db push`

Do not mark migrations applied blindly. Back up the database and verify its schema
matches `0001_init` exactly (including constraints/indexes) and lacks `0002_security`.
Use Prisma migration diff/introspection with operator-reviewed output to verify this.
Only for that verified original schema, baseline the initial migration:

```bash
bun run prisma migrate resolve --applied 0001_init
bun run db:migrate
bun run db:generate
```

If it already includes security changes, or differs from either schema, stop and
prepare a reviewed reconciliation/baseline procedure; do not run the above recipe
or rewrite an applied migration. Clean databases need no resolve step.

## Explicit, additive demo seed

Set `SEED_PASSWORD` to a password you supply, then run `bun run db:seed` explicitly.
Production additionally requires `ALLOW_PRODUCTION_SEED=true`; do not leave seed
consent/password enabled in the runtime environment afterward.

The seed never clears tables, modifies existing users/passwords/roles, restores
soft-deleted records, or resets tasks. It creates missing demo accounts. An existing
`NW-CORE` project is left entirely unchanged. A new sample project is created only
when the reused demo accounts are active and have their expected roles/departments.
Creation is transactional and safely retryable. Existing accounts keep their actual
passwords, not necessarily the configured seed password.

| Demo account | Role | Department |
| --- | --- | --- |
| `pm@nodewave.id` | PM | PRODUCT |
| `uiux@nodewave.id` | MEMBER | UIUX |
| `fe@nodewave.id` | MEMBER | FRONTEND |
| `be@nodewave.id` | MEMBER | BACKEND |
| `client@acmecorp.com` | CLIENT | CLIENT |

Use normal password login. Seed audit events are marked `source: "demo-seed"` and
record creation; there is no fabricated/backdated completion history.

## Internal comments (masked from clients)

- `POST /api/comments` — `{ taskId, body }`; internal team/PM on an accessible task.
  Inserts the comment and a `COMMENT_ADDED` audit row in one serializable transaction.
- `GET /api/comments?taskId=<uuid>` — paginated via the `comments` query policy.
  Internal actors only; scoped by the same project/task access predicate.
- `DELETE /api/comments/:id` — soft delete (author or PM), appends `COMMENT_DELETED`.
- Clients receive 403 on every comment endpoint and the client task DTO never embeds
  comments or author identities, so internal discussion is masked by omission.

## Query helper contract

```ts
type QueryPolicy = "tasks" | "clientTasks" | "projects" | "audit" | "comments";
parseQueryParams(c: Context, policy?: QueryPolicy): ParsedFilteringQuery;
buildPrismaQuery(query: FilteringQuery): PrismaFilterQuery;
```

The default is `tasks` for compatibility. Route owners must choose `clientTasks`
for CLIENT requests, `projects` for project lists, and `audit` for audit lists.
Apply the same authorization predicate to returned rows and count queries; query
validation is not authorization. Dedicated project/task IDs only narrow access.

| Policy | Exact filters | Search | Range | Sort |
| --- | --- | --- | --- | --- |
| `tasks` | id, projectId, taskCode, status, priority, department, assigneeId, creatorId, isClientVisible | taskCode, title, description | createdAt, updatedAt, dueDate, version | id, taskCode, title, status, priority, dueDate, createdAt, updatedAt, department, version |
| `clientTasks` | id, projectId, taskCode, status, priority | taskCode, title | createdAt, updatedAt, dueDate | id, taskCode, title, status, priority, dueDate, createdAt, updatedAt |
| `projects` | id, key, name, clientId | key, name | createdAt, updatedAt | id, key, name, createdAt, updatedAt |
| `audit` | id, projectId, taskId, userId, action, changedColumn | action, changedColumn | timestamp | id, timestamp, action |
| `comments` | id, projectId, taskId, authorId | body | createdAt | id, createdAt |

`filters`, `searchFilters`, and `rangedFilters` are JSON query values. Exact filters
accept only typed scalar values (not null, arrays, objects, Prisma operators, or
relation paths). Searches are nonempty bounded strings. Ranges have exactly
`key`, `start`, and `end`, with ISO datetime or integer types and start ≤ end.
UUIDs and task enums are validated. Unknown fields/parameters, duplicate parameters,
malformed JSON, invalid ranges, and unsupported ordering return 400.

`page` is a positive integer; `rows` is 1–100 (default 20; audit 25). Maximum offset
is 100000. Order defaults to createdAt descending (audit timestamp descending),
and adds an id tie-breaker. Build returns an **orderBy array**, not a single object.
Metadata must use the normalized page/rows from the parsed query.

```text
GET /api/tasks?projectId=<authorized-project-uuid>&filters={"status":"DONE"}
GET /api/tasks?page=2&rows=10&orderKey=createdAt&orderRule=desc
GET /api/tasks?rangedFilters=[{"key":"version","start":1,"end":5}]
```

URL-encode JSON values when constructing actual URLs.

## Deployment

The API builds as a portable Docker image (`Dockerfile`, base `oven/bun:1`), so any
container host works. The reference deployment runs on **Render** as a Docker web service
with a managed PostgreSQL instance:

- Required env: `DATABASE_URL`, `JWT_SECRET` (>= 32 chars), `CORS_ORIGIN` (exact origins,
  no wildcards). Optional: `JWT_ISSUER`, `JWT_AUDIENCE`, `JWT_EXPIRES_IN`. Do not set
  `PORT` where the host injects it (Render does).
- Health check path: `/health`.
- On boot `bun scripts/start.ts` validates configuration, runs `prisma migrate deploy`,
  then serves. It **never seeds**. Create the demo accounts with a one-off
  `bun run db:seed` (set `SEED_PASSWORD`, and `ALLOW_PRODUCTION_SEED=true` in production),
  then remove those variables.

## Commands and validation

- `bun run dev`: watch-mode development server (does not migrate or seed).
- `bun run start`: validate, migrate, serve; no automatic seed.
- `bun run db:generate` / `db:migrate` / `db:validate`: Prisma operations.
- `bun run db:seed`: explicit additive sample data.
- `bun run typecheck`: TypeScript no-emit check.
- `bun run lint`: Biome check, without writes.
- `bun test`: integration suite; use only a dedicated disposable test database.

Do not point integration tests at production or a shared development database.
Fixtures must be additive or use a separately provisioned temporary database; they
must never clear audit history or disable its trigger. The legacy quick-login-based
suite requires normal-login/session fixtures and independent test state after this
security change. Applying migrations, integration tests, and production provisioning
are separate operator/test-owner actions, not side effects of static checks.
