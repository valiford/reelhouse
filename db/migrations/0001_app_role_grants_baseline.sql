-- RH-0030 grants baseline: turns the DDL-locked application role into a
-- DML-capable role for tables created by future migrations, without ever
-- granting DDL. Runs as the owner/migrator role.
--
-- {{app_role}} is substituted by the migration runner from the environment
-- (DATABASE_APP_ROLE, or the DATABASE_URL user). No other placeholders exist.
--
-- Default privileges without FOR ROLE apply to objects created by the role
-- executing this migration — the same role that applies every later
-- migration — so application rows follow automatically wherever the schema
-- evolves, on any deployment, regardless of the owner role's name.
-- Re-running is a no-op: GRANT/ALTER DEFAULT PRIVILEGES are idempotent.

GRANT USAGE ON SCHEMA public TO {{app_role}};

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {{app_role}};

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO {{app_role}};

-- Migration bookkeeping is visible to the application role for readiness
-- diagnostics, but never writable by it.
GRANT SELECT ON public.schema_migrations TO {{app_role}};
