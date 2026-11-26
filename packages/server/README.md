# @chronicle/server

The Chronicle API server: accounts, projects with drafts and published revisions, collaborators, media uploads, public embeds, server-rendered timeline pages, and optional AI assistive endpoints.

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

Rules for migrations:

- **Never edit or rename a migration that has been committed.** Databases that already applied it would not run the replacement. Add a new migration instead.
- **Check the `when` timestamp in `drizzle/meta/_journal.json` after generating.** Drizzle applies a migration only if its `when` is later than the last one the database applied. Each new entry must be later than every entry above it, so raise it by hand if `drizzle-kit` stamps an earlier time. `0001_ai_usage` was stamped ahead of the clock, which is why `0002` is set by hand to one minute after it.
- **Data migrations** (`src/db/data-migrations.ts`) rewrite stored documents. They run after the SQL migrations, each once per database, recorded in the `data_migrations` table. Each runs in one transaction under a Postgres advisory lock, so instances starting together don't run it twice. Start-up logs one `data migration applied` line per migration with its counts.
- **`2026-11-timeline-date-calendar-validation`** migrates dates that older releases accepted but the schema now rejects. It rewrites drafts and published revisions with `repairTimelineDates` from `@chronicle/schema`:
  - `1969-7-20` → `1969-07-20`, `2024-07-04 12:00` → `2024-07-04T12:00`, `+2024` → `2024`
  - year `0000` → `-0001` (1 BCE)
  - an impossible day or month (`1969-02-31`) is dropped, the date is marked `uncertain`, and the original text is kept as `displayOverride`
  - `draftVersion` is not bumped, because the editor applies the same migration when it loads a draft
  - dates it cannot recognise are left unchanged and counted, and validation still reports them

  The web component, the editor (local drafts and JSON import) and `validateDocument` apply the same migration on load, so copies outside the database are covered too.

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
| `AI_PROVIDER`                                                                                              | `none`                                     | `none`, `openai`, `gemini`, `anthropic`, or `ollama`                                    |
| `AI_API_KEY`                                                                                               | —                                          | Required when `AI_PROVIDER` is `openai`, `gemini`, or `anthropic`                       |
| `AI_MODEL`                                                                                                 | provider default                           | Optional model override (e.g. `claude-sonnet-5-5`, `gpt-5-mini`, `gemini-2.5-flash`)    |
| `AI_BASE_URL`                                                                                              | provider default                           | Custom API base URL (useful for Ollama or proxies)                                      |
| `AI_DAILY_REQUEST_LIMIT` / `AI_DAILY_TOKEN_LIMIT`                                                          | `100` / `500000`                           | Per-user daily UTC quota enforced atomically across pending/completed/failed calls      |
| `AI_MAX_CONCURRENT_PER_USER`                                                                               | `2`                                        | Maximum simultaneous in-flight AI requests per user                                     |
| `AI_MAX_DOCUMENT_KB`                                                                                       | `1024`                                     | Upload / text / URL document size cap in KB for `/ai/extract`                           |
| `AI_ALLOW_URL_FETCH`                                                                                       | `false`                                    | Enable server-side URL fetching in `POST /ai/extract` (SSRF-hardened when enabled)      |

## API (`/api/v1`)

Authenticate with `Authorization: Bearer <access token>` or an API key (`Authorization: Bearer chr_…` or `X-API-Key`).

|                                                                                                             |                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/register`, `POST /auth/login`                                                                   | Returns an access token; sets the refresh cookie                                                                             |
| `POST /auth/refresh`, `POST /auth/logout`                                                                   | Cookie-based; rotates / revokes the session                                                                                  |
| `GET /me`                                                                                                   |                                                                                                                              |
| `GET/POST /api-keys`, `DELETE /api-keys/:id`                                                                | Session only (an API key cannot manage keys)                                                                                 |
| `GET/POST /projects`, `GET/PATCH/DELETE /projects/:id`                                                      | `PATCH` slug/visibility: owner                                                                                               |
| `GET/PUT /projects/:id/draft`                                                                               | `PUT` requires `If-Match: "<draftVersion>"`; `412` returns the current server copy                                           |
| `GET/POST /projects/:id/events`, `GET/PATCH/DELETE /projects/:id/events/:eventId`                           | Fine-grained edits; concurrency-safe                                                                                         |
| `GET/POST /projects/:id/revisions`, `GET /projects/:id/revisions/:version`                                  | `POST` publishes the draft                                                                                                   |
| `POST /projects/:id/rollback/:version`                                                                      | Republishes an old version as a new one and resets the draft                                                                 |
| `GET/POST /projects/:id/collaborators`, `PATCH/DELETE /projects/:id/collaborators/:userId`                  | Roles: `editor`, `viewer`                                                                                                    |
| `GET/POST /projects/:id/media`, `DELETE /projects/:id/media/:mediaId`                                       | Multipart field `file`                                                                                                       |
| `POST /projects/:id/share-links`, `DELETE /projects/:id/share-links`                                        | Expiring links for private timelines; `DELETE` revokes all                                                                   |
| `GET /projects/:id/audit`                                                                                   | Owner only                                                                                                                   |
| `GET /projects/:id/export.zip[?version=n]`                                                                  | Static site archive of the draft or a published version (see `@chronicle/static`); copies own uploads and allowlisted images |
| `WS /projects/:id/collab`, `POST /projects/:id/sync`                                                        | Live collaboration (Yjs) and its HTTP fallback                                                                               |
| `GET/POST /projects/:id/comments`, `PATCH/DELETE /projects/:id/comments/:commentId`                         | Threaded event comments                                                                                                      |
| `GET/POST /projects/:id/webhooks`, `PATCH/DELETE …/:webhookId`, `…/test`, `…/rotate-secret`, `…/deliveries` | Signed outgoing webhooks (owner only)                                                                                        |
| `GET /embed/:slug`, `GET /embed/:slug/v/:version`                                                           | Public JSON with `pageUrl` (`?token=` for private; `?include=fallback` adds `fallbackHtml`, the no-JS event list)            |
| `GET /media-proxy?url=`                                                                                     | Allowlisted image proxy                                                                                                      |
| `GET /ai/status`                                                                                            | Returns provider readiness, today's request/token usage, and active quotas                                                   |
| `POST /ai/extract`                                                                                          | Extracts dated event candidates (with citations & `sourceText`) from text, multipart file, or allowlisted URL                |
| `POST /ai/summarize`                                                                                        | Suggests a concise event description summary (`editor` role if `projectId` supplied)                                         |
| `POST /ai/alt-text`                                                                                         | Suggests accessibility alt text from `imageDataUrl`, `/media/...` key, or allowlisted `https://` URL                         |
| `POST /ai/normalize-date`                                                                                   | Deterministic date parser with optional LLM fallback                                                                         |
| `POST /ai/detect-conflicts`                                                                                 | Deterministic structural checks plus optional LLM semantic contradiction analysis (`viewer`+ if `projectId`)                 |

Public, outside `/api/v1`: `GET /timeline/:slug[/v/:version]` (server-rendered page), `GET /embed.js` (web component), `GET /media/…`, `GET /healthz`.

Errors are always `{ "error": { "code", "message", "details"? } }`.

## AI assistive features

AI features are **off by default** (`AI_PROVIDER=none`) and strictly human-in-the-loop: the server never auto-mutates drafts, revisions, or media metadata.

- **Reserve-and-settle quotas:** every LLM call inserts a `pending` row in `ai_usage` up front and settles final tokens, micro-dollar cost, and status (`completed` / `failed`) in `finally` — counting partial tokens if a multi-chunk extraction fails midway and capping parallel bursts via `AI_MAX_CONCURRENT_PER_USER`. For `/ai/extract` the reservation is taken before the document is parsed or the URL fetched, so a document that fails to parse still uses one daily request, and a user who has hit their quota or in-flight cap is refused before any parsing starts. The quota check and the insert run in one transaction holding a per-user Postgres advisory lock, so the limits hold across several server instances. A `pending` row stops counting as in flight after 15 minutes, which is longer than the slowest possible request.
- **Document parsing isolation:** PDF (`unpdf`), DOCX (`fflate` with uncompressed size and 100:1 ratio caps), and HTML buffers run inside a Node worker thread with a 10 s timeout and linear $O(n)$ text cleanup. Each worker has a 256 MB heap limit. Up to 4 workers run at once process-wide (fewer on small machines), up to 16 more requests wait, and any beyond that get `503 parser_busy`.
- **SSRF protection:** URL extraction in `POST /ai/extract` is disabled by default (`AI_ALLOW_URL_FETCH=false`). When enabled, DNS is resolved and checked at socket connection time via an `undici` dispatcher (blocking loopback, RFC1918, CGNAT, IPv4-mapped IPv6, NAT64, redirects, and unbounded response streams).
- **Image byte sniffing:** `POST /ai/alt-text` checks actual file magic bytes (`fileTypeFromBuffer`) across `imageDataUrl`, local `/media/...`, and `MEDIA_PROXY_HOSTS` fetches before forwarding to a multimodal model.
- **Error redaction:** upstream provider error bodies are logged server-side (`request.log.warn`) and replaced with a generic `502`/`504` error message for clients.
- **Privacy & opt-in:** only explicit user triggers call `/api/v1/ai/*`. Extracted candidates arrive unchecked with verbatim citation offsets for review.

## Security model

- **Passwords:** Argon2id (19 MiB, t=2). Login takes the same time and returns the same error for unknown emails.
- **Sessions:** 15-minute JWT access tokens held in memory by clients; opaque refresh tokens stored hashed, `httpOnly; SameSite=Strict; Path=/api/v1/auth`, rotated on every use. Replaying a used token revokes the whole session family. Refresh/logout also check `Origin` (CSRF).
- **API keys:** `chr_<prefix>_<secret>`, stored as SHA-256, shown once, revocable, optionally expiring.
- **Authorisation:** owner / editor / viewer per project (`projectId` checked on AI endpoints too: `editor` for write-side helpers, `viewer` for conflict checks). Non-members get `404`, never `403`, so private projects can't be discovered.
- **Input:** every document is validated against `@chronicle/schema` (unsafe URL schemes such as `javascript:` and invalid calendar dates are rejected). Queries are parameterised (Drizzle). Rich text is Markdown rendered by a safe renderer — no HTML is ever passed through, so no HTML sanitiser is needed.
- **Pages:** strict CSP (`script-src 'self'`, no inline script); data reaches the web component through an inert JSON `<script>` with `<` escaped; share-link pages are `noindex`.
- **Uploads:** type decided from file bytes; SVG/HTML refused; images re-encoded (EXIF/GPS stripped, originals never stored); size-limited; optional ClamAV scan (fails closed); served with `nosniff` and a sandboxing CSP. Media URLs are unguessable capability URLs — anyone holding one can fetch the file, including media of private timelines.
- **Media proxy:** https only, exact allowlisted hosts, no redirects, image types only, size and time limits.
- **Audit log:** sign-ins (and failures), key changes, visibility/slug changes, publishes, rollbacks, collaborator changes, share links, uploads, rejections, and AI invocations (`ai.*`).

## Not yet included

- GraphQL (REST and the collaboration WebSocket cover current clients).
- Email: password reset and invitations for people without an account.
- A Docker image.
