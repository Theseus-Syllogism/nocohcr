-- Run as the postgres superuser AFTER PostgreSQL 16 is installed and TLS keys
-- are in place under /etc/postgresql/16/main/ssl/.
--
--   sudo -u postgres psql -f /opt/blindvault/deploy/postgres/init.sql
--
-- Then reload pg_hba.conf so that the role is forced into TLS-only.

-- Single dedicated role with a strong, externally-injected password.
-- The bootstrap script generates and writes /etc/blindvault/api.env.
\set bv_pass `echo "$BLINDVAULT_DB_PASSWORD"`

CREATE ROLE blindvault LOGIN PASSWORD :'bv_pass';

-- Owner role for migrations; never used by the API at runtime.
CREATE ROLE blindvault_admin LOGIN PASSWORD :'bv_pass' CREATEDB;

CREATE DATABASE blindvault OWNER blindvault_admin
    ENCODING 'UTF8'
    LC_COLLATE 'C.UTF-8'
    LC_CTYPE   'C.UTF-8'
    TEMPLATE template0;

\c blindvault

GRANT CONNECT ON DATABASE blindvault TO blindvault;
GRANT USAGE ON SCHEMA public TO blindvault;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO blindvault;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO blindvault;

-- Belt-and-braces: deny direct schema modification by the runtime role.
REVOKE CREATE ON SCHEMA public FROM blindvault;
