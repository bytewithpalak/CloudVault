require('dotenv').config();
const { Pool } = require('pg');
const { S3Client, HeadBucketCommand } = require('@aws-sdk/client-s3');

(async () => {
  try {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const t = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
    console.log('DB OK, tables:', t.rows.map(r => r.table_name).join(', '));
    await pool.end();
  } catch (e) { console.log('DB FAILED:', e.message); }
  try {
    await new S3Client({ region: process.env.AWS_REGION }).send(new HeadBucketCommand({ Bucket: process.env.S3_BUCKET }));
    console.log('S3 OK:', process.env.S3_BUCKET);
  } catch (e) { console.log('S3 FAILED:', e.message); }
})();