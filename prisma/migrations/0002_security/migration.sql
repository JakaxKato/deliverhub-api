BEGIN;

CREATE TABLE "sessions" (
    "jti" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    CONSTRAINT "sessions_pkey" PRIMARY KEY ("jti")
);

CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_members" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "task_dependencies" ADD COLUMN "deletedAt" TIMESTAMP(3);

DROP INDEX "task_dependencies_taskId_prerequisiteTaskId_key";
CREATE INDEX "task_dependencies_taskId_prerequisiteTaskId_idx"
    ON "task_dependencies"("taskId", "prerequisiteTaskId");
-- Preserve historical edges while allowing only one active instance of a pair.
CREATE UNIQUE INDEX "task_dependencies_active_pair_key"
    ON "task_dependencies"("taskId", "prerequisiteTaskId") WHERE "deletedAt" IS NULL;

ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_projectId_fkey";
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_taskId_fkey";
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_userId_fkey";
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "reject_audit_log_mutation"() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS '
BEGIN
    RAISE EXCEPTION ''audit_logs is append-only; UPDATE, DELETE and TRUNCATE are prohibited''
        USING ERRCODE = ''55000'';
END;
';

CREATE TRIGGER "audit_logs_append_only"
    BEFORE UPDATE OR DELETE OR TRUNCATE ON "audit_logs"
    FOR EACH STATEMENT EXECUTE FUNCTION "reject_audit_log_mutation"();

COMMIT;
