-- Extensions — run via docker-entrypoint as superuser (postgres)
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
