# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis (queue broker):** `docker compose exec redis redis-cli ping` — expect `PONG`
- **Object storage:** `docker compose ps minio` — expect `healthy` (healthcheck runs `mc ready local`)
- **Video worker:** `docker compose logs worker` — expect `Video worker started — consuming the "video-processing" queue`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP capture, ports `1025` (SMTP) / `8025` (UI)
- `redis` — BullMQ broker, port `6379`
- `minio` — S3-compatible object storage (`pgsty/silo` image), ports `9000` (API) / `9001` (console), user/password `streamtube`
- `worker` — video worker (`npm run start:worker`), no ports; see "Videos (Phase 03)" below

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.

## Videos (Phase 03)

Plan and decisions: `docs/phases/phase-03-videos/phase-03-videos.md`, `docs/decisions/technical-decisions-phase-03-videos.md` (TDs referenced below as `TD-NN`).

### Modules

| Path | Responsibility |
|------|----------------|
| `src/storage/` | `StorageModule` / `StorageService` — the only gateway to S3-compatible storage: bucket bootstrap (`onModuleInit`), multipart (`createMultipartUpload`, `presignUploadPart`, `listUploadedParts`, `completeMultipartUpload`, `abortMultipartUpload`), `presignGetObject`, `downloadToFile`, `putObject`. Two `S3Client`s: internal (`STORAGE_ENDPOINT`) for server calls and presigner (`STORAGE_PUBLIC_ENDPOINT`) for URLs handed to clients (TD-11). |
| `src/queue/` | `QueueModule` — BullMQ root connection + key `prefix`, imported by API and worker (TD-01). |
| `src/videos/` | HTTP side: `Video` entity, `VideosController`, `VideosService`, `VideoProcessingProducer`, DTOs, domain exceptions (`video.exceptions.ts`), constants (`videos.constants.ts`), `generateUrlId` (`url-id.util.ts`). |
| `src/video-processing/` | Worker-side domain: `MediaProbeService` (system `ffprobe`/`ffmpeg` via `execFile`, TD-06), `VideoProcessingService` (download → probe → thumbnail → `ready`), `AbandonedUploadSweeperService` (TD-12). |
| `src/worker/` | `WorkerModule` (headless root), `VideoProcessingProcessor` (queue consumer), `WorkerSchedulerService` (registers the hourly sweep). Entrypoint: `src/main.worker.ts`. |
| `src/database/typeorm-options.ts` | `buildTypeOrmOptions` — TypeORM options shared by `AppModule` and `WorkerModule`. |

### Endpoints (all require the bearer token; owner-only, others get `404`)

| Method | Path | Effect |
|--------|------|--------|
| `POST` | `/videos` | Pre-registers a `draft`, opens a multipart upload; returns `urlId`, `partSize` (64 MiB), `partCount`, `maxPartsPerRequest`. `413 VIDEO_TOO_LARGE` above 10 GiB. |
| `POST` | `/videos/:urlId/upload/parts` | Body `{ partNumbers }` (≤100) → presigned `UploadPart` URLs (1 h). The client `PUT`s each part **directly to storage**. |
| `POST` | `/videos/:urlId/upload/complete` | Lists parts in storage, requires parts `1..N` and the exact declared size, completes, sets `processing`, enqueues `process-video`. |
| `GET` | `/videos/:urlId` | Details + presigned `thumbnailUrl`. |
| `GET` | `/videos/:urlId/playback` | `{ url, expiresAt }` — presigned GET (15 min); storage answers `Range` with `206` (streaming). `409 VIDEO_NOT_READY` unless `ready`. |
| `GET` | `/videos/:urlId/download` | `{ url, expiresAt }` — presigned GET served as `attachment` with the original filename. |

Video bytes never pass through the API. Status lifecycle (`videos.status`, TD-10/TD-12): `draft → processing → ready | failed`; drafts older than 24 h become `failed` with `processing_error = 'upload_abandoned'`.

### Queue and worker

- Queue `video-processing`; jobs `process-video` (`{ videoId }`, `jobId = videoId`, 3 attempts, exponential backoff 5 s) and `sweep-abandoned-uploads` (scheduler `abandoned-upload-sweep`, every hour, upserted on worker boot).
- Invalid media throws `UnrecoverableError` (no retries); on the final failure the processor calls `markFailed`. The `ready` update is conditional on `processing`, and `markFailed` never overwrites `ready`.
- The worker runs from the same image and code as the API (`worker` service, `npm run start:worker`, ts-node). **It does not hot-reload**: after changing worker code run `docker compose restart worker`.
- On a fresh clone the `worker` container starts before `npm install`; it restarts (`restart: unless-stopped`) until dependencies exist.

### Environment (`.env.example`, validated in `src/config/env.validation.ts`)

`STORAGE_ENDPOINT` (internal, `http://minio:9000`), `STORAGE_PUBLIC_ENDPOINT` (host embedded in presigned URLs; defaults to `STORAGE_ENDPOINT` — set `http://localhost:9000` when a browser on the host consumes them), `STORAGE_REGION`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_BUCKET`, `REDIS_HOST`, `REDIS_PORT`, `QUEUE_PREFIX`.

### Testing notes

- `test/setup-queue-prefix.ts` (Jest `setupFiles` in both configs) sets `QUEUE_PREFIX=streamtube-test`, so the Compose `worker` (prefix `streamtube`) never consumes jobs created by tests. Queue assertions should still look a job up in every state, not only `waiting`.
- Storage, Redis and FFmpeg are exercised for real (integration suites under `src/storage`, `src/videos`, `src/video-processing`, `src/worker`); `test/helpers/video-test-app.ts` boots the app and logs in a confirmed user for e2e.
- `src/database/migrations.integration-spec.ts` drops tables **and** enum types (`verification_tokens_type_enum`, `videos_status_enum`) before re-running migrations.

### Gotchas

- Presigned URLs embed the signing host; it cannot be rewritten after signing (SigV4). Use `STORAGE_PUBLIC_ENDPOINT`, never string-replace hosts.
- `@aws-sdk` ≥ 3.729 adds CRC32 checksums to requests and presigned URLs by default; the clients set `requestChecksumCalculation`/`responseChecksumValidation: 'WHEN_REQUIRED'` so plain `PUT`s to part URLs work on S3-compatible storage.
- `@nestjs/bullmq` is pinned to 11.x: 12.x is ESM-only and cannot load in this CommonJS build/Jest. `bullmq@6` needs `ioredis` installed explicitly (optional peer).
- MinIO-family storage rejects the `AbortIncompleteMultipartUpload` lifecycle rule (it purges stale multipart uploads after 24 h itself); abandoned uploads are handled by the worker sweep instead.

