require('dotenv').config({ quiet: true });

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const pool = require('./db');

const {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
    HeadBucketCommand
} = require('@aws-sdk/client-s3');

const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const { checkEmail } = require('./lib/email');
const { cleanName, cleanFolder, previewType, disposition } = require('./lib/files');
const rateLimit = require('./lib/rate-limit');

const MAX_FILE_MB = 20;
const QUOTA_BYTES = (Number(process.env.STORAGE_QUOTA_MB) || 500) * 1024 * 1024;
const BUCKET = process.env.S3_BUCKET;

const app = express();
const s3 = new S3Client({ region: process.env.AWS_REGION });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1 },
    defParamCharset: 'utf8' // keeps non-English filenames readable
});

const loginLimit = rateLimit({ max: 8, windowMs: 15 * 60 * 1000 });
const signupLimit = rateLimit({ max: 20, windowMs: 60 * 60 * 1000 });

// ---------- helpers ----------

// An error whose message is safe to show to the user.
function fail(status, message) {
    return Object.assign(new Error(message), { status, expose: true });
}

async function log(userId, action, detail) {
    console.log(JSON.stringify({ time: new Date().toISOString(), userId, action, detail }));

    try {
        await pool.query(
            'INSERT INTO logs(user_id, action, detail) VALUES($1, $2, $3)',
            [userId, action, detail]
        );
    } catch (err) {
        // The action already happened, so a logging problem must not report it as failed.
        console.error('Could not write log:', err.message);
    }
}

function auth(req, res, next) {
    const token = (req.headers.authorization || '').replace('Bearer ', '');

    try {
        req.user = jwt.verify(token, process.env.JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ error: 'Please log in' });
    }
}

function toId(value) {
    const id = Number(value);
    if (!Number.isInteger(id) || id < 1 || id > 2147483647) throw fail(404, 'File not found');
    return id;
}

// A file that belongs to the user. `trashed` picks between live files and the trash.
async function ownFile(req, { trashed = false } = {}) {
    const f = (
        await pool.query(
            `SELECT * FROM files WHERE id=$1 AND owner_id=$2
             AND deleted_at IS ${trashed ? 'NOT NULL' : 'NULL'}`,
            [toId(req.params.id), req.user.id]
        )
    ).rows[0];

    if (!f) throw fail(403, 'Only the owner can do that');
    return f;
}

// Authorization: owner, or someone the file was shared with (not revoked or expired)
async function getAccess(fileId, userId) {
    const f = (
        await pool.query('SELECT * FROM files WHERE id=$1 AND deleted_at IS NULL', [fileId])
    ).rows[0];

    if (!f) return null;
    if (f.owner_id === userId) return { file: f, canDownload: true };

    const s = (
        await pool.query(
            `SELECT * FROM shares WHERE file_id=$1 AND user_id=$2 AND revoked=false
             AND (expires_at IS NULL OR expires_at > now())
             ORDER BY id DESC LIMIT 1`,
            [fileId, userId]
        )
    ).rows[0];

    return s ? { file: f, canDownload: s.can_download } : null;
}

function signedUrl(file, { download }) {
    const preview = previewType(file.name);

    return getSignedUrl(
        s3,
        new GetObjectCommand({
            Bucket: BUCKET,
            Key: file.s3_key,
            ResponseContentDisposition: disposition(download ? 'attachment' : 'inline', file.name),
            ResponseContentType: download || !preview ? 'application/octet-stream' : preview.mime
        }),
        { expiresIn: download ? 60 : 300 }
    );
}

async function usedBytes(userId) {
    const r = await pool.query(
        'SELECT coalesce(sum(size), 0) AS used FROM files WHERE owner_id=$1',
        [userId]
    );
    return Number(r.rows[0].used);
}

async function removeForever(file) {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: file.s3_key }));
    await pool.query('DELETE FROM files WHERE id=$1', [file.id]);
}

// ---------- authentication ----------

app.post('/api/signup', async (req, res) => {
    const { email: rawEmail, password } = req.body || {};

    if (!signupLimit.allow(req.ip)) throw fail(429, 'Too many sign-ups. Try again later.');
    signupLimit.hit(req.ip);

    const { email, error } = await checkEmail(rawEmail);
    if (error) throw fail(400, error);

    if (typeof password !== 'string' || password.length < 8 || !/[a-z]/i.test(password) || !/\d/.test(password)) {
        throw fail(400, 'Password needs at least 8 characters, with a letter and a number');
    }
    if (Buffer.byteLength(password) > 72) throw fail(400, 'Password is too long');

    const taken = await pool.query('SELECT 1 FROM users WHERE lower(email)=$1', [email]);
    if (taken.rowCount) throw fail(409, 'That email is already registered');

    const hash = await bcrypt.hash(password, 10);

    let r;
    try {
        r = await pool.query(
            'INSERT INTO users(email, password_hash) VALUES($1, $2) RETURNING id',
            [email, hash]
        );
    } catch (err) {
        if (err.code === '23505') throw fail(409, 'That email is already registered');
        throw err;
    }

    await log(r.rows[0].id, 'SIGNUP', email);
    res.json({ ok: true });
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body || {};

    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
        throw fail(400, 'Enter your email and password');
    }

    const address = email.trim().toLowerCase();
    const key = `${req.ip}|${address}`;

    if (!loginLimit.allow(key)) {
        throw fail(429, 'Too many failed attempts. Try again in 15 minutes.');
    }

    // an exact match wins, for accounts created before emails were lower-cased
    const u = (
        await pool.query(
            'SELECT * FROM users WHERE lower(email)=$1 ORDER BY (email=$2) DESC LIMIT 1',
            [address, email.trim()]
        )
    ).rows[0];

    if (!u || !(await bcrypt.compare(password, u.password_hash))) {
        loginLimit.hit(key);
        await log(u ? u.id : null, 'LOGIN_FAILED', address);
        throw fail(401, 'Wrong email or password');
    }

    loginLimit.reset(key);
    await log(u.id, 'LOGIN', u.email);

    res.json({
        token: jwt.sign({ id: u.id, email: u.email }, process.env.JWT_SECRET, { expiresIn: '8h' })
    });
});

app.post('/api/password', auth, async (req, res) => {
    const { current, next } = req.body || {};

    if (typeof next !== 'string' || next.length < 8 || !/[a-z]/i.test(next) || !/\d/.test(next) || Buffer.byteLength(next) > 72) {
        throw fail(400, 'New password needs 8 to 72 characters, with a letter and a number');
    }

    const key = `password|${req.user.id}`;
    if (!loginLimit.allow(key)) throw fail(429, 'Too many failed attempts. Try again in 15 minutes.');

    const u = (await pool.query('SELECT * FROM users WHERE id=$1', [req.user.id])).rows[0];

    if (!u || !(await bcrypt.compare(String(current || ''), u.password_hash))) {
        loginLimit.hit(key);
        throw fail(400, 'Current password is wrong');
    }

    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(next, 10), u.id]);
    await log(u.id, 'PASSWORD_CHANGE', u.email);
    res.json({ ok: true });
});

// ---------- files ----------

// Everything the dashboard needs in one request.
app.get('/api/files', auth, async (req, res) => {
    const [mine, shared, folders] = await Promise.all([
        pool.query(
            `SELECT f.id, f.name, f.folder, f.size, f.starred, f.created_at, f.deleted_at,
                    EXISTS (SELECT 1 FROM shares s WHERE s.file_id=f.id AND s.revoked=false
                            AND (s.expires_at IS NULL OR s.expires_at > now())) AS is_shared
             FROM files f WHERE f.owner_id=$1 ORDER BY f.created_at DESC`,
            [req.user.id]
        ),
        pool.query(
            `SELECT * FROM (
                SELECT DISTINCT ON (f.id) f.id, f.name, f.size, s.can_download,
                       s.created_at, u.email AS owner
                FROM shares s
                JOIN files f ON f.id = s.file_id
                JOIN users u ON u.id = f.owner_id
                WHERE s.user_id=$1 AND s.revoked=false AND f.deleted_at IS NULL
                  AND (s.expires_at IS NULL OR s.expires_at > now())
                ORDER BY f.id, s.id DESC
             ) latest ORDER BY created_at DESC`,
            [req.user.id]
        ),
        pool.query('SELECT path FROM folders WHERE owner_id=$1 ORDER BY path', [req.user.id])
    ]);

    res.json({
        email: req.user.email,
        mine: mine.rows.filter((f) => !f.deleted_at),
        trash: mine.rows.filter((f) => f.deleted_at),
        shared: shared.rows,
        folders: folders.rows.map((r) => r.path),
        usage: {
            used: mine.rows.reduce((sum, f) => sum + Number(f.size), 0),
            quota: QUOTA_BYTES
        },
        maxFileBytes: MAX_FILE_MB * 1024 * 1024
    });
});

app.post('/api/files', auth, upload.single('file'), async (req, res) => {
    if (!req.file) throw fail(400, 'No file');

    const name = cleanName(req.file.originalname);
    if (!name) throw fail(400, 'That file name is not allowed');

    const folder = cleanFolder(req.body.folder);
    if (!folder) throw fail(400, 'That folder name is not allowed');

    if ((await usedBytes(req.user.id)) + req.file.size > QUOTA_BYTES) {
        throw fail(413, 'Not enough storage space. Empty your trash or delete some files.');
    }

    const key = `${req.user.id}/${crypto.randomUUID()}`;

    await s3.send(
        new PutObjectCommand({
            Bucket: BUCKET,
            Key: key,
            Body: req.file.buffer,
            ContentType: req.file.mimetype
        })
    );

    let r;
    try {
        r = await pool.query(
            'INSERT INTO files(owner_id, name, folder, s3_key, size) VALUES($1, $2, $3, $4, $5) RETURNING id',
            [req.user.id, name, folder, key, req.file.size]
        );
    } catch (err) {
        // do not leave an orphaned object in S3
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })).catch(() => {});
        throw err;
    }

    await log(req.user.id, 'UPLOAD', name);
    res.json({ id: r.rows[0].id });
});

// rename, move or star
app.patch('/api/files/:id', auth, async (req, res) => {
    const f = await ownFile(req);
    const body = req.body || {};

    const name = body.name === undefined ? f.name : cleanName(body.name);
    if (!name) throw fail(400, 'That file name is not allowed');

    const folder = body.folder === undefined ? f.folder : cleanFolder(body.folder);
    if (!folder) throw fail(400, 'That folder name is not allowed');

    const starred = body.starred === undefined ? f.starred : body.starred === true;

    await pool.query(
        'UPDATE files SET name=$1, folder=$2, starred=$3 WHERE id=$4',
        [name, folder, starred, f.id]
    );

    if (name !== f.name) await log(req.user.id, 'RENAME', `${f.name} -> ${name}`);
    if (folder !== f.folder) await log(req.user.id, 'MOVE', `${name} -> ${folder}`);

    res.json({ ok: true });
});

app.get('/api/files/:id/download', auth, async (req, res) => {
    const a = await getAccess(toId(req.params.id), req.user.id);

    if (!a) throw fail(403, 'No access');
    if (!a.canDownload) throw fail(403, 'This file was shared as view only');

    const url = await signedUrl(a.file, { download: true });
    await log(req.user.id, 'DOWNLOAD', a.file.name);
    res.json({ url });
});

app.get('/api/files/:id/preview', auth, async (req, res) => {
    const a = await getAccess(toId(req.params.id), req.user.id);

    if (!a) throw fail(403, 'No access');

    const preview = previewType(a.file.name);
    if (!preview) return res.json({ kind: null });

    const url = await signedUrl(a.file, { download: false });
    await log(req.user.id, 'VIEW', a.file.name);
    res.json({ kind: preview.kind, url });
});

// move to trash
app.delete('/api/files/:id', auth, async (req, res) => {
    const f = await ownFile(req);

    await pool.query('UPDATE files SET deleted_at=now() WHERE id=$1', [f.id]);
    await log(req.user.id, 'TRASH', f.name);
    res.json({ ok: true });
});

app.post('/api/files/:id/restore', auth, async (req, res) => {
    const f = await ownFile(req, { trashed: true });

    await pool.query('UPDATE files SET deleted_at=NULL WHERE id=$1', [f.id]);
    await log(req.user.id, 'RESTORE', f.name);
    res.json({ ok: true });
});

app.delete('/api/files/:id/permanent', auth, async (req, res) => {
    const f = await ownFile(req, { trashed: true });

    await removeForever(f);
    await log(req.user.id, 'DELETE', f.name);
    res.json({ ok: true });
});

app.delete('/api/trash', auth, async (req, res) => {
    const r = await pool.query(
        'SELECT * FROM files WHERE owner_id=$1 AND deleted_at IS NOT NULL',
        [req.user.id]
    );

    for (const f of r.rows) await removeForever(f);

    await log(req.user.id, 'EMPTY_TRASH', `${r.rowCount} file(s)`);
    res.json({ deleted: r.rowCount });
});

// ---------- folders ----------

app.post('/api/folders', auth, async (req, res) => {
    const folder = cleanFolder((req.body || {}).path);
    if (!folder || folder === '/') throw fail(400, 'That folder name is not allowed');

    await pool.query(
        'INSERT INTO folders(owner_id, path) VALUES($1, $2) ON CONFLICT DO NOTHING',
        [req.user.id, folder]
    );

    await log(req.user.id, 'NEW_FOLDER', folder);
    res.json({ path: folder });
});

// removes a folder; the files inside go to the trash
app.delete('/api/folders', auth, async (req, res) => {
    const folder = cleanFolder((req.body || {}).path);
    if (!folder || folder === '/') throw fail(400, 'That folder cannot be deleted');

    const inside = [req.user.id, folder, `${folder}/`];

    await pool.query(
        `UPDATE files SET deleted_at=now() WHERE owner_id=$1 AND deleted_at IS NULL
         AND (folder=$2 OR starts_with(folder, $3))`,
        inside
    );
    await pool.query(
        'DELETE FROM folders WHERE owner_id=$1 AND (path=$2 OR starts_with(path, $3))',
        inside
    );

    await log(req.user.id, 'DELETE_FOLDER', folder);
    res.json({ ok: true });
});

// ---------- sharing ----------

app.get('/api/files/:id/shares', auth, async (req, res) => {
    const f = await ownFile(req);

    const r = await pool.query(
        `SELECT s.id, s.token, s.can_download, s.expires_at, u.email
         FROM shares s LEFT JOIN users u ON u.id = s.user_id
         WHERE s.file_id=$1 AND s.revoked=false
           AND (s.expires_at IS NULL OR s.expires_at > now())
         ORDER BY s.id DESC`,
        [f.id]
    );

    res.json(
        r.rows.map((s) => ({
            id: s.id,
            email: s.email,
            link: s.token ? `/s/${s.token}` : null,
            canDownload: s.can_download,
            expiresAt: s.expires_at
        }))
    );
});

app.post('/api/files/:id/share', auth, async (req, res) => {
    const f = await ownFile(req);
    const { email, canDownload = true, expiresInDays } = req.body || {};

    if (typeof canDownload !== 'boolean') throw fail(400, 'Choose view only or download');

    const days = Number(expiresInDays || 0);
    if (![0, 1, 7, 30].includes(days)) throw fail(400, 'Choose a valid expiry');
    const expiresAt = days ? new Date(Date.now() + days * 86400000) : null;

    if (email) {
        const address = String(email).trim().toLowerCase();
        const u = (
            await pool.query('SELECT id, email FROM users WHERE lower(email)=$1 LIMIT 1', [address])
        ).rows[0];

        if (!u) throw fail(404, 'No CloudVault user has that email');
        if (u.id === req.user.id) throw fail(400, 'You already own this file');

        // sharing again updates the existing permission instead of adding a duplicate
        const updated = await pool.query(
            'UPDATE shares SET can_download=$1, expires_at=$2, revoked=false WHERE file_id=$3 AND user_id=$4',
            [canDownload, expiresAt, f.id, u.id]
        );

        if (!updated.rowCount) {
            await pool.query(
                'INSERT INTO shares(file_id, user_id, can_download, expires_at) VALUES($1, $2, $3, $4)',
                [f.id, u.id, canDownload, expiresAt]
            );
        }

        await log(req.user.id, 'SHARE_USER', `${f.name} -> ${u.email}`);
        return res.json({ ok: true });
    }

    const token = crypto.randomBytes(24).toString('hex');

    await pool.query(
        'INSERT INTO shares(file_id, token, can_download, expires_at) VALUES($1, $2, $3, $4)',
        [f.id, token, canDownload, expiresAt]
    );

    await log(req.user.id, 'SHARE_LINK', f.name);
    res.json({ link: `/s/${token}` });
});

// remove one person or one link
app.delete('/api/files/:id/shares/:shareId', auth, async (req, res) => {
    const f = await ownFile(req);

    // also revoke older duplicate rows for the same person
    await pool.query(
        `UPDATE shares SET revoked=true WHERE file_id=$1 AND (id=$2 OR user_id =
            (SELECT user_id FROM shares WHERE id=$2 AND file_id=$1))`,
        [f.id, toId(req.params.shareId)]
    );

    await log(req.user.id, 'REVOKE', f.name);
    res.json({ ok: true });
});

// remove all access
app.post('/api/files/:id/revoke', auth, async (req, res) => {
    const f = await ownFile(req);

    await pool.query('UPDATE shares SET revoked=true WHERE file_id=$1', [f.id]);
    await log(req.user.id, 'REVOKE', `${f.name} (all access)`);
    res.json({ ok: true });
});

app.get('/s/:token', async (req, res) => {
    const row = (
        await pool.query(
            `SELECT f.name, f.s3_key, s.can_download
             FROM shares s JOIN files f ON f.id = s.file_id
             WHERE s.token=$1 AND s.revoked=false AND f.deleted_at IS NULL
               AND (s.expires_at IS NULL OR s.expires_at > now())`,
            [req.params.token]
        )
    ).rows[0];

    if (!row) return res.status(404).send('This link is invalid, expired or revoked.');

    if (!row.can_download && !previewType(row.name)) {
        return res.status(403).send('This file is view only and cannot be previewed in a browser.');
    }

    const url = await signedUrl(row, { download: row.can_download });
    await log(null, 'LINK_ACCESS', row.name);
    res.redirect(url);
});

// ---------- activity logs & health ----------

app.get('/api/logs', auth, async (req, res) => {
    const r = await pool.query(
        'SELECT action, detail, created_at FROM logs WHERE user_id=$1 ORDER BY id DESC LIMIT 100',
        [req.user.id]
    );
    res.json(r.rows);
});

// quick check for load balancers
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// full check: is the database and the bucket reachable?
app.get('/health/full', async (req, res) => {
    const test = (promise) => promise.then(() => 'ok', () => 'down');

    const [database, storage] = await Promise.all([
        test(pool.query('SELECT 1')),
        test(s3.send(new HeadBucketCommand({ Bucket: BUCKET })))
    ]);

    const healthy = database === 'ok' && storage === 'ok';

    res.status(healthy ? 200 : 503).json({
        status: healthy ? 'ok' : 'degraded',
        database,
        storage,
        uptimeSeconds: Math.round(process.uptime())
    });
});

// ---------- errors ----------

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);

    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `File is larger than ${MAX_FILE_MB} MB` });
    }
    if (err.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Invalid request' });
    }
    if (err.expose && err.status < 500) {
        return res.status(err.status).json({ error: err.message });
    }

    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
});

app.listen(process.env.PORT || 3000, () => {
    console.log(`CloudVault running on http://localhost:${process.env.PORT || 3000}`);
});
