
require('dotenv').config();

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const crypto = require('crypto');
const { Pool } = require('pg');

const {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand
} = require('@aws-sdk/client-s3');

const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app = express();

app.use(express.json());
app.use(express.static('public'));

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 }
});

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const s3 = new S3Client({
    region: process.env.AWS_REGION
});

const BUCKET = process.env.S3_BUCKET;

// ---------- helpers ----------

async function log(userId, action, detail) {
    console.log(JSON.stringify({
        time: new Date().toISOString(),
        userId,
        action,
        detail
    }));

    await pool.query(
        'INSERT INTO logs(user_id, action, detail) VALUES($1, $2, $3)',
        [userId, action, detail]
    );
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

// Authorization: owner, or someone the file was shared with (not revoked)

async function getAccess(fileId, userId) {
    const f = (
        await pool.query('SELECT * FROM files WHERE id=$1', [fileId])
    ).rows[0];

    if (!f) return null;

    if (f.owner_id === userId) {
        return {
            file: f,
            owner: true,
            canDownload: true
        };
    }

    const s = (
        await pool.query(
            'SELECT * FROM shares WHERE file_id=$1 AND user_id=$2 AND revoked=false',
            [fileId, userId]
        )
    ).rows[0];

    return s
        ? { file: f, owner: false, canDownload: s.can_download }
        : null;
}

// ---------- authentication ----------

app.post('/api/signup', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password || password.length < 6) {
        return res.status(400).json({
            error: 'Email and 6+ char password required'
        });
    }

    try {
        const hash = await bcrypt.hash(password, 10);

        const r = await pool.query(
            'INSERT INTO users(email, password_hash) VALUES($1, $2) RETURNING id',
            [email, hash]
        );

        await log(r.rows[0].id, 'SIGNUP', email);

        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(400).json({ error: 'Email already used' });
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        const u = (
            await pool.query('SELECT * FROM users WHERE email=$1', [email])
        ).rows[0];

        if (!u || !(await bcrypt.compare(password, u.password_hash))) {
            await log(null, 'LOGIN_FAILED', email);
            return res.status(401).json({
                error: 'Wrong email or password'
            });
        }

        await log(u.id, 'LOGIN', email);

        res.json({
            token: jwt.sign(
                { id: u.id, email: u.email },
                process.env.JWT_SECRET,
                { expiresIn: '8h' }
            )
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Login failed' });
    }
});

// ---------- files ----------

app.post('/api/files', auth, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file' });
        }

        const folder = req.body.folder || '/';

        const key = `${req.user.id}/${crypto.randomUUID()}-${req.file.originalname}`;

        await s3.send(
            new PutObjectCommand({
                Bucket: BUCKET,
                Key: key,
                Body: req.file.buffer,
                ContentType: req.file.mimetype
            })
        );

        const r = await pool.query(
            'INSERT INTO files(owner_id, name, folder, s3_key, size) VALUES($1, $2, $3, $4, $5) RETURNING id',
            [
                req.user.id,
                req.file.originalname,
                folder,
                key,
                req.file.size
            ]
        );

        await log(req.user.id, 'UPLOAD', req.file.originalname);

        res.json({ id: r.rows[0].id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'File upload failed' });
    }
});

app.get('/api/files', auth, async (req, res) => {
    try {
        const mine = await pool.query(
            'SELECT id, name, folder, size, created_at FROM files WHERE owner_id=$1 ORDER BY created_at DESC',
            [req.user.id]
        );

        const shared = await pool.query(
            `SELECT f.id, f.name, f.folder, f.size, s.can_download
             FROM shares s
             JOIN files f ON f.id = s.file_id
             WHERE s.user_id=$1 AND s.revoked=false`,
            [req.user.id]
        );

        res.json({
            mine: mine.rows,
            shared: shared.rows
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not retrieve files' });
    }
});

app.get('/api/files/:id/download', auth, async (req, res) => {
    try {
        const a = await getAccess(+req.params.id, req.user.id);

        if (!a) {
            return res.status(403).json({ error: 'No access' });
        }

        const cmd = new GetObjectCommand({
            Bucket: BUCKET,
            Key: a.file.s3_key,
            ResponseContentDisposition: a.canDownload
                ? `attachment; filename="${a.file.name}"`
                : 'inline'
        });

        await log(
            req.user.id,
            a.canDownload ? 'DOWNLOAD' : 'VIEW',
            a.file.name
        );

        res.json({
            url: await getSignedUrl(s3, cmd, { expiresIn: 60 })
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Download failed' });
    }
});

app.delete('/api/files/:id', auth, async (req, res) => {
    try {
        const a = await getAccess(+req.params.id, req.user.id);

        if (!a || !a.owner) {
            return res.status(403).json({
                error: 'Only the owner can delete'
            });
        }

        await s3.send(
            new DeleteObjectCommand({
                Bucket: BUCKET,
                Key: a.file.s3_key
            })
        );

        await pool.query(
            'DELETE FROM files WHERE id=$1',
            [a.file.id]
        );

        await log(req.user.id, 'DELETE', a.file.name);

        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Delete failed' });
    }
});

// ---------- sharing ----------

app.post('/api/files/:id/share', auth, async (req, res) => {
    try {
        const a = await getAccess(+req.params.id, req.user.id);

        if (!a || !a.owner) {
            return res.status(403).json({
                error: 'Only the owner can share'
            });
        }

        const { email, canDownload = true } = req.body;

        if (email) {
            const u = (
                await pool.query(
                    'SELECT id FROM users WHERE email=$1',
                    [email]
                )
            ).rows[0];

            if (!u) {
                return res.status(404).json({
                    error: 'User not found'
                });
            }

            await pool.query(
                'INSERT INTO shares(file_id, user_id, can_download) VALUES($1, $2, $3)',
                [a.file.id, u.id, canDownload]
            );

            await log(
                req.user.id,
                'SHARE_USER',
                `${a.file.name} -> ${email}`
            );

            return res.json({ ok: true });
        }

        const token = crypto.randomBytes(24).toString('hex');

        await pool.query(
            'INSERT INTO shares(file_id, token, can_download) VALUES($1, $2, $3)',
            [a.file.id, token, canDownload]
        );

        await log(req.user.id, 'SHARE_LINK', a.file.name);

        res.json({ link: `/s/${token}` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Sharing failed' });
    }
});

app.post('/api/files/:id/revoke', auth, async (req, res) => {
    try {
        const a = await getAccess(+req.params.id, req.user.id);

        if (!a || !a.owner) {
            return res.status(403).json({
                error: 'Only the owner can revoke'
            });
        }

        await pool.query(
            'UPDATE shares SET revoked=true WHERE file_id=$1',
            [a.file.id]
        );

        await log(req.user.id, 'REVOKE', a.file.name);

        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Revoke failed' });
    }
});

app.get('/s/:token', async (req, res) => {
    try {
        const s = (
            await pool.query(
                'SELECT * FROM shares WHERE token=$1 AND revoked=false',
                [req.params.token]
            )
        ).rows[0];

        if (!s) {
            return res.status(404).send('Link invalid or revoked');
        }

        const f = (
            await pool.query(
                'SELECT * FROM files WHERE id=$1',
                [s.file_id]
            )
        ).rows[0];

        if (!f) {
            return res.status(404).send('File not found');
        }

        const cmd = new GetObjectCommand({
            Bucket: BUCKET,
            Key: f.s3_key,
            ResponseContentDisposition: s.can_download
                ? `attachment; filename="${f.name}"`
                : 'inline'
        });

        await log(null, 'LINK_ACCESS', f.name);

        res.redirect(
            await getSignedUrl(s3, cmd, { expiresIn: 60 })
        );
    } catch (err) {
        console.error(err);
        res.status(500).send('Could not open shared link');
    }
});

// ---------- activity logs & health ----------

app.get('/api/logs', auth, async (req, res) => {
    try {
        const r = await pool.query(
            'SELECT action, detail, created_at FROM logs WHERE user_id=$1 ORDER BY id DESC LIMIT 50',
            [req.user.id]
        );

        res.json(r.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not retrieve logs' });
    }
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.listen(process.env.PORT || 3000, () => {
    console.log('CloudVault running');
});
