# CloudVault

**A secure cloud-based file storage and sharing platform**, a Google Drive / Dropbox-style web app built on AWS.

Users can sign up, upload files into folders, download them, and share them with other users or through secure links, with view-only or download permissions that the owner can revoke at any time. Every important action is recorded in an activity log.

> Course project for Cloud Computing, Thapar Institute of Engineering and Technology.


---

## Features

- **Authentication:** sign-up with email checks, bcrypt-hashed passwords, JWT sessions (8-hour expiry), password change and a limit on repeated failed logins
- **File management:** drag-and-drop upload (up to 20 MB per file), rename, move, star, search, filter, sort and multi-select
- **Previews:** images, PDFs, video, audio and text files
- **Folders and trash:** create folders; restore or permanently delete trashed files
- **Sharing:** share with another user by email or through a secure link, view-only or download, with optional expiry
- **Revoke:** remove one person, one link or all access
- **Storage:** per-user quota (500 MB by default) broken down by file type
- **Private storage:** files are served from S3 through short-lived pre-signed URLs (60 seconds for downloads, 5 minutes for previews)
- **Activity log:** actions are stored in the database and printed as JSON lines
- **Interface:** list and grid views, dark mode, mobile layout
- **Health checks:** `/health` and `/health/full` (database and S3)

## Architecture

```
 Browser (HTML + JS)
        |
        v
 EC2: Node.js + Express API  ----->  S3 (private, encrypted bucket)
        |                              ^
        |                              |  pre-signed URLs (60 s)
        v
 RDS: PostgreSQL (users, files, folders, shares, logs)
```

| Component | Technology | AWS service |
|---|---|---|
| Frontend | Plain HTML, CSS and JavaScript served by the backend | n/a |
| Backend / API | Node.js, Express | EC2 |
| Object storage | Private bucket, SSE-S3 encryption, public access blocked | S3 |
| Database | PostgreSQL | RDS |
| Authentication and authorization | bcrypt, JWT, an access check on every file action | App code |
| Server permissions | IAM role attached to the instance (no keys on the server) | IAM |
| Logging | `logs` table plus JSON console logs | App code |

## Project structure

```
CloudVault/
├── server.js        # Express API
├── db.js            # Database connection
├── lib/             # Email checks, file rules, rate limit
├── schema.sql       # Creates and upgrades the tables
├── setup-db.js      # Runs schema.sql
├── check.js         # Tests settings, database and S3
├── public/          # Frontend (index.html, app.js, styles.css)
├── test/            # Unit tests
└── .env             # Local secrets (never committed)
```

## Database schema

| Table | Purpose |
|---|---|
| `users` | id, email (unique), password_hash, created_at |
| `files` | id, owner_id, name, folder, s3_key, size, starred, deleted_at, created_at |
| `folders` | id, owner_id, path, created_at |
| `shares` | id, file_id, user_id, token, can_download, revoked, expires_at, created_at |
| `logs` | id, user_id, action, detail, created_at |

## API overview

All routes under `/api` need a login token, except sign-up and login.

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/signup`, `/api/login`, `/api/password` | Create account, log in, change password |
| GET, POST | `/api/files` | List files and storage usage; upload a file |
| PATCH, DELETE | `/api/files/:id` | Rename, move or star; move to trash |
| GET | `/api/files/:id/preview`, `/api/files/:id/download` | Get a pre-signed URL |
| POST, DELETE | `/api/files/:id/restore`, `/api/files/:id/permanent` | Restore or permanently delete |
| DELETE | `/api/trash` | Empty the trash |
| POST, DELETE | `/api/folders` | Create or delete a folder |
| GET, POST | `/api/files/:id/shares`, `/api/files/:id/share` | List access; share with a user or link |
| DELETE, POST | `/api/files/:id/shares/:shareId`, `/api/files/:id/revoke` | Remove one or all access |
| GET | `/s/:token` | Open a shared link (no login) |
| GET | `/api/logs` | Your last 100 activity entries |
| GET | `/health`, `/health/full` | Health checks |

## Getting started (local)

### Prerequisites

- Node.js 20 or later
- An AWS account with an S3 bucket and an RDS PostgreSQL instance
- AWS CLI configured (`aws configure`) with access to the bucket

### 1. Clone and install

```bash
git clone https://github.com/bytewithpalak/CloudVault.git
cd CloudVault
npm install
```

### 2. Create a `.env` file

```
PORT=3000
DATABASE_URL=postgres://USER:PASSWORD@YOUR-RDS-ENDPOINT:5432/DBNAME
AWS_REGION=ap-south-1
S3_BUCKET=your-bucket-name
JWT_SECRET=a-long-random-string
```

Use only letters and numbers in the database password, or URL-encode special characters. The `.env` file is listed in `.gitignore` and must never be committed.

### 3. Prepare the AWS resources

- **S3:** create a bucket with *Block all public access* on and default encryption (SSE-S3).
- **RDS:** create a PostgreSQL instance and allow inbound TCP 5432 from your IP (or from your EC2 security group).

### 4. Create or upgrade the tables and check connections

```bash
npm run setup-db   # creates missing tables and upgrades older ones
npm run check      # expect: ALL CHECKS PASSED
```

### 5. Run

```bash
npm start
```

Open `http://localhost:3000`. Run `npm test` for the unit tests.

## Deployment on AWS

1. **EC2:** launch an Amazon Linux 2023 instance (t3.micro). Open ports 22 and 3000 in its security group (80 and 443 if you use Nginx with HTTPS).
2. **IAM role:** attach a role with S3 access to the instance so the server needs no access keys.
3. **Database access:** change the RDS inbound rule so PostgreSQL (5432) is allowed only from the EC2 security group.
4. **Install and run:**
   ```bash
   sudo dnf install -y nodejs22 git   # Node.js 20 or newer is required
   git clone https://github.com/bytewithpalak/CloudVault.git
   cd CloudVault
   npm install
   nano .env                      # paste your values
   sudo npm install -g pm2
   npm run setup-db && npm run check
   pm2 start server.js --name cloudvault
   pm2 startup && pm2 save        # restart automatically after a reboot
   ```
5. **Stable address (optional):** attach an Elastic IP and point a DNS name at it.
6. **HTTPS (optional):** put Nginx in front of the app and get a free Let's Encrypt certificate.

To update the app later:

```bash
cd CloudVault && git pull && npm install && npm run setup-db && pm2 restart cloudvault
```

## Security design

- Passwords are hashed with bcrypt and never stored in plain text.
- JWT authentication protects every file route.
- Each file action checks that the user is the **owner** or has an **active share**; only owners can delete, share or revoke.
- The S3 bucket blocks all public access. Downloads use pre-signed URLs that expire after 60 seconds (previews after 5 minutes).
- Files are encrypted at rest (SSE-S3).
- The EC2 server uses an **IAM role**, so no AWS keys are stored on it.
- The database accepts connections only from the application server's security group once deployed.
- Failed logins are logged.

## Limitations

- Files are encrypted at rest, **not end-to-end**. The AWS account administrator can technically access stored files.
- View-only is enforced by the link type and the browser. A determined user could still save what they can see; true DRM is out of scope.
- No email verification or password-reset flow. The login limit is held in memory.
- The database connection is encrypted, but the server certificate is not verified.
- Uploads are limited to 20 MB and are buffered in server memory.
- HTTPS is available only if you set up Nginx with a certificate; the base deployment serves plain HTTP on port 3000.
- This is a student project. Do not upload sensitive or private files.

## Future work

- End-to-end (client-side) encryption
- Amazon Cognito for authentication
- HTTPS with a load balancer or Nginx by default
- Email verification and password reset
- S3 versioning and large-file multipart uploads
- CloudWatch dashboards and alarms for system metrics
- File versioning and team workspaces

