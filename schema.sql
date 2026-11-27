-- Safe to run more than once: creates missing tables and upgrades older ones.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS files (
  id SERIAL PRIMARY KEY,
  owner_id INT REFERENCES users(id),
  name TEXT NOT NULL,
  folder TEXT DEFAULT '/',
  s3_key TEXT NOT NULL,
  size BIGINT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shares (
  id SERIAL PRIMARY KEY,
  file_id INT REFERENCES files(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id),
  token TEXT UNIQUE,
  can_download BOOLEAN DEFAULT true,
  revoked BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS logs (
  id SERIAL PRIMARY KEY,
  user_id INT,
  action TEXT,
  detail TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS folders (
  id SERIAL PRIMARY KEY,
  owner_id INT NOT NULL REFERENCES users(id),
  path TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (owner_id, path)
);

-- starred files, trash and link expiry
ALTER TABLE files ADD COLUMN IF NOT EXISTS starred BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE files ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE shares ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- older tables stored UTC times without a time zone
DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'created_at'
      AND data_type = 'timestamp without time zone'
      AND table_name IN ('users', 'files', 'shares', 'logs')
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE ''UTC''', t);
  END LOOP;
END $$;

-- store every folder as /name or /name/sub
UPDATE files SET folder = '/' || trim(both '/' from coalesce(folder, ''))
WHERE folder IS DISTINCT FROM '/' || trim(both '/' from coalesce(folder, ''));

CREATE INDEX IF NOT EXISTS files_owner_idx ON files (owner_id);
CREATE INDEX IF NOT EXISTS shares_user_idx ON shares (user_id);
CREATE INDEX IF NOT EXISTS logs_user_idx ON logs (user_id);
