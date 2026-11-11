-- Authentication for the self-hosted server (M1-7). Additive only: no table of 0001 to 0003 is changed.
-- Single-author product: ONE owner per library database, and no user, role or sharing tables.
-- The runner wraps this file in one transaction: do not add BEGIN or COMMIT.

-- The owner account. password_hash is a self-describing string, `scrypt$v1$N=..,r=..,p=..$<salt>$<key>` (base64),
-- so the cost can be raised later without a migration. Created once, by the first-run setup.
CREATE TABLE owner (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  password_hash text NOT NULL CHECK (length(password_hash) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
-- A library database has exactly one owner.
CREATE UNIQUE INDEX owner_single_row ON owner ((true));

-- Browser and app sessions. The cookie holds a random 256-bit token; only its SHA-256 (hex) is stored, so a database
-- dump or backup cannot be replayed as a login. expires_at is the absolute limit; the idle limit is last_seen_at plus
-- the server's idle timeout.
CREATE TABLE session (
  token_hash sha256_hex PRIMARY KEY,
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX session_expires_at ON session (expires_at);

-- Failed sign-ins, kept in the database so a restart does not reset the rate limit. Holds no password and no guess.
CREATE TABLE login_failure (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL
);
CREATE INDEX login_failure_at ON login_failure (at);
