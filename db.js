// One place for the database connection, shared by the app and the scripts.
require('dotenv').config({ quiet: true });
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 10 * 60 * 1000,
    keepAlive: true
});

// A dropped idle connection must not crash the app.
pool.on('error', (err) => console.error('Database connection lost:', err.message));

module.exports = pool;
