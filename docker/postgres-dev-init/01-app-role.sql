-- Runs once on first init of the disposable local PostgreSQL 18 profile
-- (docker-compose.dev-db.yml). Mirrors the least-privilege role split used
-- in production; see docs/DATABASE.md.

-- Runtime application role: DML only. No createdb, no superuser, no role
-- administration, and zero table privileges until RH-0003 migrations grant
-- them per schema.
CREATE ROLE reelhouse_app LOGIN PASSWORD 'reelhouse_app_dev';
GRANT CONNECT ON DATABASE reelhouse TO reelhouse_app;
