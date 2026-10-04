# Isolated PostgreSQL integration tests

These standalone tests exercise the real Hono app with `app.request()` and real Prisma/PostgreSQL transactions. No HTTP listener, mocked ORM, or canonical task reset is used; a PostgreSQL server is required.

## Commands (from `backend`)

- `bun scripts/test.ts --verify-migrations` — deploy migrations into a new empty schema, execute the real additive seed twice, verify exactly five initial accounts and unchanged existing rows, then drop the schema. **Does not import the app or run business tests.**
- `bun scripts/test.ts` — run the complete standalone integration suite with a 30-second per-test timeout.
- `bun test` — run the same suite directly and safely: the test module itself performs isolation before dynamically importing the app. Its bootstrap deploys clean-schema migrations and verifies the additive seed twice before password-login fixtures.

The runner is optional; no package-script change is required for plain `bun test` to be isolated.

## Database/environment safety

Provide an existing PostgreSQL `DATABASE_URL` through the environment/Bun's normal environment loading. The PostgreSQL account needs permission to create schemas and their tables/functions/triggers. Never paste credentials into logs or command arguments. The runner does not display the URL, JWT secret, seed password, or captured migration/seed subprocess output.

Each invocation:

1. Validates the URL without printing it and generates `nodewave_test_<32 random hex characters>` in-process. No schema name is accepted from external input.
2. Creates only that schema and replaces Prisma's `schema` query parameter before any application import.
3. Sets `NODE_ENV=test`, a random JWT secret longer than 32 characters, a random bcrypt-safe seed password, and the exact localhost CORS origin.
4. Executes `bunx prisma migrate deploy` against the isolated URL and checks `current_schema()` for the fixture client and, when running integration tests, the application client.
5. Seeds additively; fixtures then create unique projects/tasks/users instead of mutating canonical seed resources. Login/logout tests create their own sessions.
6. Disconnects application/fixture clients and drops only the internally owned, prefix/format-guarded schema in cleanup, then confirms it no longer exists.

`DROP SCHEMA ... CASCADE` is used only for the randomized owned schema, never an application schema. Audit UPDATE/DELETE/TRUNCATE rejection tests target that schema alone. Conditional audit-insert rejection triggers are schema-qualified, match a single fixture project (and optionally one action), and are removed in `finally`. They do not block schema cleanup.

An abrupt OS termination can bypass cleanup and leave the randomly named test schema behind; it cannot cause application-table cleanup. Do not add broad prefix-based schema deletion, `db push --force-reset`, `migrate reset`, `deleteMany`, or seed resets to this harness. Do not use Bun's concurrent-test mode: concurrency is tested with deliberate `Promise.all` request races inside otherwise sequential test cases.

## Coverage

- Password login for all five seeded users, MEMBER-only registration, disabled impersonation endpoints, jti-backed session revocation/expiry, and live actor role/deletion checks.
- Active membership/clientId scoping for projects, tasks, attachments, audits and unscoped lists; exactly seven permission booleans on internal task DTOs and assignee-MEMBER-only execution. CLIENT DTOs omit `permissions` entirely, including nested data; client mutations remain denied.
- Required expected versions for details/status, dependency add/delete, attachment add/delete, and task delete (DELETE bodies are JSON `{version}`).
- Actual simultaneous request races, cross-operation lost-update prevention, cycle serialization, and two independent completions producing one dependent unblock/version/audit.
- Invalid task/dependency creation rollback, soft-deleted dependency re-add through the PostgreSQL partial index, and attachment ownership checks. Attachment metadata validates public HTTPS URLs without credentials, safe filenames, `link`/MIME types, and inclusive sizes from 0 through 25 MiB.
- Targeted dependency propagation preserves unrelated manual blockers. Deleting a prerequisite retains soft-deleted edges and removal audits, increments each direct dependent once even without a status change, rejects stale dependent writes, and auto-unblocks eligible dependents once without incorrectly unblocking their children.
- Transaction-guard integration captures a real active actor, then demotes or logs out that fixture actor before `assertActiveActor` runs inside a mutation transaction; rejection must be 401 with no task/audit writes. These deterministic stale-context tests do not claim to instrument a queued HTTP request.
- Transactional audit rollback using conditional database triggers for every task mutation, project create/delete, and completion/auto-unblock independently; append-only audit database guards.
- Recursive CLIENT key/value masking, hidden/foreign legacy prerequisites, visible-only metrics, and side-channel filter restrictions.
- Strict query policies, UTC calendar-day validation and bounds, active-only summaries, and stable date/id ordering across task/project/audit pages.

The suite asserts the secured API contracts against the current implementation. Mutation tests require task/access resolution before malformed-payload validation for unavailable resources, and internal Conflict snapshots must include complete permissions without authentication secrets. Migration-only verification remains independent of application imports and API tests.
