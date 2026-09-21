-- media_catalog grants baseline (RH-0026): turns the DDL-locked sync role
-- into a DML-capable role for tables created by the later catalog migrations,
-- without ever granting DDL. Runs as the catalog owner/migrator role.
--
-- The media_catalog database is a SEPARATE database from reelhouse
-- (docs/ARCHITECTURE.md); default privileges are per database, so this
-- baseline is required here even though the reelhouse database has its own.
-- {{app_role}} is substituted by the migration runner (MEDIA_CATALOG_APP_ROLE,
-- or the MEDIA_CATALOG_DATABASE_URL user). No other placeholders exist.
--
-- Default privileges without FOR ROLE apply to objects created by the role
-- executing this migration — the same role that applies every later catalog
-- migration — so sync writes follow automatically wherever the schema
-- evolves, on any deployment, regardless of the owner role's name.

GRANT USAGE ON SCHEMA public TO {{app_role}};

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {{app_role}};

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO {{app_role}};

-- Migration bookkeeping is visible to the sync role for readiness
-- diagnostics, but never writable by it (the runner re-asserts this every
-- pass in case the table is recreated).
GRANT SELECT ON public.schema_migrations TO {{app_role}};
