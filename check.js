// Pre-flight check: run "npm run check" before a demo.
const pool = require('./db');
const { S3Client, HeadBucketCommand } = require('@aws-sdk/client-s3');

(async () => {
  let ok = true;

  const missing = ['DATABASE_URL', 'JWT_SECRET', 'AWS_REGION', 'S3_BUCKET'].filter((k) => !process.env[k]);
  if (missing.length) { ok = false; console.log('ENV FAILED, missing:', missing.join(', ')); }
  else console.log('ENV OK');

  try {
    await pool.query('SELECT starred, deleted_at FROM files LIMIT 1');
    await pool.query('SELECT expires_at FROM shares LIMIT 1');
    await pool.query('SELECT path FROM folders LIMIT 1');
    console.log('DB OK');
  } catch (e) {
    ok = false;
    console.log('DB FAILED:', e.message);
    if (/timeout|ETIMEDOUT/i.test(e.message)) console.log('  -> Add your current IP to the RDS security group (port 5432).');
    if (/does not exist/i.test(e.message)) console.log('  -> Run: npm run setup-db');
  }

  try {
    await new S3Client({ region: process.env.AWS_REGION }).send(new HeadBucketCommand({ Bucket: process.env.S3_BUCKET }));
    console.log('S3 OK:', process.env.S3_BUCKET);
  } catch (e) { ok = false; console.log('S3 FAILED:', e.name, e.message); }

  await pool.end();
  console.log(ok ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED');
  process.exitCode = ok ? 0 : 1;
})();
