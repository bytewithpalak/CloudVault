const fs = require('fs');
const path = require('path');
const pool = require('./db');

pool
  .query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'))
  .then(() => pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'"))
  .then((r) => {
    console.log('Database ready, tables:', r.rows.map((x) => x.table_name).join(', '));
    process.exit(0);
  })
  .catch((e) => {
    console.error('FAILED:', e.message);
    process.exit(1);
  });
