CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS files (
  id SERIAL PRIMARY KEY,
  owner_id INT REFERENCES users(id),
  name TEXT NOT NULL,
  folder TEXT DEFAULT '/',
  s3_key TEXT NOT NULL,
  size BIGINT,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shares (
  id SERIAL PRIMARY KEY,
  file_id INT REFERENCES files(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id),
  token TEXT UNIQUE,
  can_download BOOLEAN DEFAULT true,
  revoked BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS logs (
  id SERIAL PRIMARY KEY,
  user_id INT,
  action TEXT,
  detail TEXT,
  created_at TIMESTAMP DEFAULT now()
);