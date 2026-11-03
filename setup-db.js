require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool
  .query(fs.readFileSync('schema.sql', 'utf8'))
  .then(() => pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'"))
  .then((r) => {
    console.log('tables created:', r.rows.map((x) => x.table_name).join(', '));
    process.exit(0);
  })
  .catch((e) => {
    console.error('FAILED:', e.message);
    process.exit(1);
  });