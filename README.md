# CloudVault

**A secure cloud-based file storage and sharing platform**, a Google Drive / Dropbox-style web app built on AWS.

Users can sign up, upload files into folders, download them, and share them with other users or through secure links, with view-only or download permissions that the owner can revoke at any time. Every important action is recorded in an activity log.

> Course project for Cloud Computing, Thapar Institute of Engineering and Technology.


---

## Features

- **Authentication:** sign-up and login with bcrypt-hashed passwords and JWT sessions (8-hour expiry)
- **File management:** upload (up to 20 MB), download, delete, and folder names
- **Sharing:** share a file with another user by email, or generate a secure link
- **Permissions:** choose *view-only* or *download* for each share
- **Revoke:** the owner can revoke all shares of a file; revoked users and links stop working immediately
- **Private storage:** files live in a private, encrypted S3 bucket and are served only through short-lived pre-signed URLs (60 seconds)
- **Activity log:** sign-ups, logins, failed logins, uploads, downloads, views, shares, revokes and deletes are stored in the database and printed as JSON lines for log shipping
- **Health check:** `GET /health` for monitoring

## Architecture

```
 Browser (HTML + JS)
        |
        v
 EC2: Node.js + Express API  ----->  S3 (private, encrypted bucket)
        |                              ^
        |                              |  pre-signed URLs (60 s)
        v
 RDS: PostgreSQL (users, files, shares, logs)
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
├── server.js        # Express API: auth, files, sharing, logs, health
├── schema.sql       # Database tables
├── setup-db.js      # Creates the tables from schema.sql
├── check.js         # Tests the database and S3 connections
├── public/
│   └── index.html   # Frontend
├── package.json
└── .env             # Local secrets (never committed)
```

## Database schema

| Table | Purpose |
|---|---|
| `users` | id, email (unique), password_hash, created_at |
| `files` | id, owner_id, name, folder, s3_key, size, created_at |
| `shares` | id, file_id, user_id, token, can_download, revoked, created_at |
| `logs` | id, user_id, action, detail, created_at |

## API overview

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/signup` | No | Create an account |
| POST | `/api/login` | No | Log in and receive a JWT |
| GET | `/api/files` | Yes | List your files and files shared with you |
| POST | `/api/files` | Yes | Upload a file (multipart form) |
| GET | `/api/files/:id/download` | Yes | Get a 60-second pre-signed URL (owner or shared user) |
| DELETE | `/api/files/:id` | Yes | Delete a file (owner only) |
| POST | `/api/files/:id/share` | Yes | Share with a user (email) or create a secure link (owner only) |
| POST | `/api/files/:id/revoke` | Yes | Revoke all shares of a file (owner only) |
| GET | `/s/:token` | No | Open a file through a secure link |
| GET | `/api/logs` | Yes | Your last 50 activity entries |
| GET | `/health` | No | Health check |

## Getting started (local)

### Prerequisites

- Node.js 18 or later
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

### 4. Create the tables and check connections

```bash
node setup-db.js   # expect: tables created: users, files, shares, logs
node check.js      # expect: DB OK and S3 OK
```

### 5. Run

```bash
node server.js
```

Open `http://localhost:3000`.

## Deployment on AWS

1. **EC2:** launch an Amazon Linux 2023 instance (t3.micro). Open ports 22 and 3000 in its security group (80 and 443 if you use Nginx with HTTPS).
2. **IAM role:** attach a role with S3 access to the instance so the server needs no access keys.
3. **Database access:** change the RDS inbound rule so PostgreSQL (5432) is allowed only from the EC2 security group.
4. **Install and run:**
   ```bash
   sudo dnf install -y nodejs git
   git clone https://github.com/bytewithpalak/CloudVault.git
   cd CloudVault
   npm install
   nano .env                      # paste your values
   sudo npm install -g pm2
   pm2 start server.js --name cloudvault
   pm2 startup && pm2 save        # restart automatically after a reboot
   ```
5. **Stable address (optional):** attach an Elastic IP and point a DNS name at it.
6. **HTTPS (optional):** put Nginx in front of the app and get a free Let's Encrypt certificate.

To update the app later:

```bash
cd CloudVault && git pull && npm install && pm2 restart cloudvault
```

## Security design

- Passwords are hashed with bcrypt and never stored in plain text.
- JWT authentication protects every file route.
- Each file action checks that the user is the **owner** or has a **non-revoked share**; only owners can delete, share or revoke.
- The S3 bucket blocks all public access. Downloads use pre-signed URLs that expire after 60 seconds.
- Files are encrypted at rest (SSE-S3).
- The EC2 server uses an **IAM role**, so no AWS keys are stored on it.
- The database accepts connections only from the application server's security group once deployed.
- Failed logins are logged.

## Limitations

- Files are encrypted at rest, **not end-to-end**. The AWS account administrator can technically access stored files.
- View-only is enforced by the link type and the browser. A determined user could still save what they can see; true DRM is out of scope.
- Basic JWT authentication with no rate limiting or password-reset flow.
- Uploads are limited to 20 MB and are buffered in server memory.
- HTTPS is available only if you set up Nginx with a certificate; the base deployment serves plain HTTP on port 3000.
- This is a student project. Do not upload sensitive or private files.

## Future work

- End-to-end (client-side) encryption
- Amazon Cognito for authentication
- HTTPS with a load balancer or Nginx by default
- Rate limiting and account lockout
- S3 versioning and large-file multipart uploads
- CloudWatch dashboards and alarms for system metrics
- Expiry dates for share links

