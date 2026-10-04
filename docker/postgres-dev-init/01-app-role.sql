-- Runs once on first init of the disposable local PostgreSQL 18 profile
-- (docker-compose.dev-db.yml). Mirrors the least-privilege role split used
-- in production; see docs/DATABASE.md.
--
-- The owner role (POSTGRES_USER above) is the migrator role: it applies the
-- versioned migrations in db/migrations/ via `npm run db:migrate`.
--
-- Runtime application role: DML only. No createdb, no superuser, no role
-- administration, and zero table privileges until migration
-- 0001_app_role_grants_baseline.sql grants them (SELECT/INSERT/UPDATE/DELETE
-- on owner-created tables, plus read-only migration bookkeeping).

CREATE ROLE reelhouse_app LOGIN PASSWORD 'reelhouse_app_dev';
GRANT CONNECT ON DATABASE reelhouse TO reelhouse_app;
