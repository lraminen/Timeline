# @chronicle/server

The Chronicle API server: accounts, projects with drafts and published revisions, collaborators, media uploads, public embeds and server-rendered timeline pages.

- **Runtime:** Node.js ≥ 20.6, Fastify 5
- **Database:** PostgreSQL via Drizzle ORM. Without `DATABASE_URL` it runs an embedded [PGlite](https://pglite.dev) (Postgres compiled to WebAssembly) — persisted in `DATA_DIR`, or in memory.
- **Storage:** local filesystem (default) or any S3-compatible store (AWS S3, Cloudflare R2, MinIO).

## Running

```bash
pnpm build                                   # from the repo root
cd packages/server
DATA_DIR=./data CORS_ORIGINS=http://localhost:5174 pnpm start
# → http://127.0.0.1:3000
```

`pnpm dev` runs from source with reload. Migrations run automatically at start-up. After changing `src/db/schema.ts`, run `pnpm db:generate` and commit the new file in `drizzle/`.

To point the editor at a server, serve a `config.json` next to the editor build:

```json
{ "apiUrl": "https://timelines.example.org" }
```

(or set `VITE_CHRONICLE_API_URL` at build time). Without either, the editor runs in local-only mode. The editor and API must be the **same site** (same registrable domain; ports don't matter), because the session cookie is `SameSite=Strict` — e.g. `editor.example.org` + `api.example.org`, or both on `localhost`.

## Configuration

| Variable                                                                                                   | Default                                    | Notes                                                                                   |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                                                                 | `development`                              | `production` enforces the two settings below                                            |
| `PUBLIC_URL`                                                                                               | `http://HOST:PORT`                         | **Required in production.** Used for links, OG tags, cookies                            |
| `JWT_SECRET`                                                                                               | dev placeholder                            | **Required in production**, ≥ 32 random characters. Signs access tokens and share links |
| `HOST` / `PORT`                                                                                            | `127.0.0.1` / `3000`                       |                                                                                         |
| `DATABASE_URL`                                                                                             | —                                          | `postgres://…`; unset = embedded PGlite                                                 |
| `DATA_DIR`                                                                                                 | —                                          | PGlite data directory; unset = in-memory                                                |
| `CORS_ORIGINS`                                                                                             | —                                          | Comma-separated editor origins allowed to call the API with credentials                 |
| `EMBED_ORIGINS`                                                                                            | `*`                                        | Who may fetch embeds and iframe public pages (`frame-ancestors`)                        |
| `STORAGE_DRIVER`                                                                                           | `fs`                                       | `fs` or `s3`                                                                            |
| `STORAGE_DIR`                                                                                              | `./storage`                                | For `fs`                                                                                |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` |                                            | For `s3` (R2: region `auto` + endpoint; MinIO: path style)                              |
| `MEDIA_PUBLIC_URL`                                                                                         | —                                          | CDN base for media URLs; unset = served by this server at `/media/…`                    |
| `MAX_UPLOAD_MB`                                                                                            | `25`                                       |                                                                                         |
| `CLAMAV_ADDRESS`                                                                                           | —                                          | `host:port` of clamd; uploads are scanned and **rejected if clamd is unreachable**      |
| `MEDIA_PROXY_HOSTS`                                                                                        | `upload.wikimedia.org,images.unsplash.com` | Hosts the image proxy may fetch from                                                    |
| `ACCESS_TOKEN_TTL_SECONDS` / `REFRESH_TOKEN_TTL_DAYS`                                                      | `900` / `30`                               |                                                                                         |
| `RATE_LIMIT_PER_MINUTE` / `AUTH_RATE_LIMIT_PER_MINUTE`                                                     | `300` / `10`                               | Per user (or IP when anonymous) / per IP on auth routes                                 |
| `TRUST_PROXY`                                                                                              | `false`                                    | Set behind a reverse proxy so client IPs are correct                                    |

## API (`/api/v1`)

Authenticate with `Authorization: Bearer <access token>` or an API key (`Authorization: Bearer chr_…` or `X-API-Key`).

|                                                                                            |                                                                                    |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `POST /auth/register`, `POST /auth/login`                                                  | Returns an access token; sets the refresh cookie                                   |
| `POST /auth/refresh`, `POST /auth/logout`                                                  | Cookie-based; rotates / revokes the session                                        |
| `GET /me`                                                                                  |                                                                                    |
| `GET/POST /api-keys`, `DELETE /api-keys/:id`                                               | Session only (an API key cannot manage keys)                                       |
| `GET/POST /projects`, `GET/PATCH/DELETE /projects/:id`                                     | `PATCH` slug/visibility: owner                                                     |
| `GET/PUT /projects/:id/draft`                                                              | `PUT` requires `If-Match: "<draftVersion>"`; `412` returns the current server copy |
| `GET/POST /projects/:id/events`, `GET/PATCH/DELETE /projects/:id/events/:eventId`          | Fine-grained edits; concurrency-safe                                               |
| `GET/POST /projects/:id/revisions`, `GET /projects/:id/revisions/:version`                 | `POST` publishes the draft                                                         |
| `POST /projects/:id/rollback/:version`                                                     | Republishes an old version as a new one and resets the draft                       |
| `GET/POST /projects/:id/collaborators`, `PATCH/DELETE /projects/:id/collaborators/:userId` | Roles: `editor`, `viewer`                                                          |
| `GET/POST /projects/:id/media`, `DELETE /projects/:id/media/:mediaId`                      | Multipart field `file`                                                             |
| `POST /projects/:id/share-links`, `DELETE /projects/:id/share-links`                       | Expiring links for private timelines; `DELETE` revokes all                         |
| `GET /projects/:id/audit`                                                                  | Owner only                                                                         |
| `GET /embed/:slug`, `GET /embed/:slug/v/:version`                                          | Public JSON (`?token=` for private)                                                |
| `GET /media-proxy?url=`                                                                    | Allowlisted image proxy                                                            |

Public, outside `/api/v1`: `GET /timeline/:slug[/v/:version]` (server-rendered page), `GET /embed.js` (web component), `GET /media/…`, `GET /healthz`.

Errors are always `{ "error": { "code", "message", "details"? } }`.

## Security model

- **Passwords:** Argon2id (19 MiB, t=2). Login takes the same time and returns the same error for unknown emails.
- **Sessions:** 15-minute JWT access tokens held in memory by clients; opaque refresh tokens stored hashed, `httpOnly; SameSite=Strict; Path=/api/v1/auth`, rotated on every use. Replaying a used token revokes the whole session family. Refresh/logout also check `Origin` (CSRF).
- **API keys:** `chr_<prefix>_<secret>`, stored as SHA-256, shown once, revocable, optionally expiring.
- **Authorisation:** owner / editor / viewer per project. Non-members get `404`, never `403`, so private projects can't be discovered.
- **Input:** every document is validated against `@chronicle/schema` (unsafe URL schemes such as `javascript:` are rejected). Queries are parameterised (Drizzle). Rich text is Markdown rendered by a safe renderer — no HTML is ever passed through, so no HTML sanitiser is needed.
- **Pages:** strict CSP (`script-src 'self'`, no inline script); data reaches the web component through an inert JSON `<script>` with `<` escaped; share-link pages are `noindex`.
- **Uploads:** type decided from file bytes; SVG/HTML refused; images re-encoded (EXIF/GPS stripped, originals never stored); size-limited; optional ClamAV scan (fails closed); served with `nosniff` and a sandboxing CSP. Media URLs are unguessable capability URLs — anyone holding one can fetch the file, including media of private timelines.
- **Media proxy:** https only, exact allowlisted hosts, no redirects, image types only, size and time limits.
- **Audit log:** sign-ins (and failures), key changes, visibility/slug changes, publishes, rollbacks, collaborator changes, share links, uploads and rejections.

## Not yet included

- GraphQL (REST covers the editor and integrations; subscriptions belong with real-time collaboration in Phase 6).
- Email: password reset and invitations for people without an account.
- A Docker image.
