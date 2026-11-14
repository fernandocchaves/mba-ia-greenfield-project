---
scope_type: phase
related_phases: [3]
status: pending
date: 2026-11-14
scope_description: "Backend foundation for video upload and processing: queue technology, object-storage access and local image, 10GB direct upload, worker deployment, FFmpeg tooling, unique URL ids, playback/download delivery and access, and the video status lifecycle."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — receives the videos module, the storage and queue integrations, the video worker entrypoint, the `videos` migration, and the new Compose services (object storage, queue broker, worker).
- `next-frontend/` — no open decision in this document. The challenge scopes Phase 03 as backend-only ("a interface de vídeo não faz parte do escopo desta fase"). The two handshakes the frontend will consume later (upload — TD-04; playback/download — TD-08) are decided here as `Cross-layer` contracts, so the future UI phase inherits them instead of reopening them.

_Inherited constraints (not reopened):_ storage is S3-compatible (`docs/diagrams/software-arch.mermaid` → "Object Storage — S3 or MinIO"; challenge brief: MinIO locally, S3 in production). Auth is a bearer access token in the `Authorization` header with a global JWT guard (`technical-decisions-phase-02-auth.md` TD-02, TD-09). Errors use the domain-exception envelope `{ statusCode, error, message }` (phase-02-auth TD-07). Validation uses class-validator (phase-02-auth TD-06). Env vars are validated with Joi in `src/config/env.validation.ts`.

_Installed stack checked (`nestjs-project/package-lock.json`):_ `@nestjs/common`/`core` 11.1.16, `typeorm` 0.3.28, `@nestjs/config` 4.0.3, `joi` 18.1.2. Runtime image `node:25.6.0-slim` (`Dockerfile.dev`). The module system is CommonJS (no `"type": "module"`).

---

## TD-01: Message Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** `docs/project-plan.md` and the architecture diagram leave the queue as **TBD**. It is the main stack decision of the phase. The API publishes one job per uploaded video and a separate worker consumes it. Processing a large video takes minutes, so the queue needs retries with backoff, a way to avoid duplicate jobs for the same video, and visibility of failed jobs. The broker must run as a Compose service and be exercisable by integration tests.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Redis-backed job queue with first-party NestJS integration (`@nestjs/bullmq@12.0.2` accepts `@nestjs/common ^11` and `bullmq ^6`). Producers inject a `Queue`; consumers extend `WorkerHost` with `@Processor`.
- **Pros:** Built-in `attempts` + exponential `backoff`, custom `jobId`/deduplication (one job per video), delayed jobs, failed-job retention and events. Official Nest recipe, so the module pattern matches the rest of the app. Redis is a single lightweight container.
- **Cons:** Adds Redis as new infrastructure. Redis is not a durable log: jobs live in memory with optional AOF/RDB persistence, which is acceptable for re-creatable processing jobs.

### Option B: RabbitMQ (`amqplib` / `@golevelup/nestjs-rabbitmq`)
- AMQP broker. The API publishes to an exchange and the worker consumes from a durable queue, with retries modeled through dead-letter exchanges + TTL.
- **Pros:** Durable, protocol-standard broker with routing flexibility. Good fit if many services exchange events later.
- **Cons:** Retries with backoff, delayed redelivery and per-video deduplication must be assembled by hand (DLX/TTL topology, idempotency keys). Heavier container and more operational concepts than this phase needs. The Nest integration is community-maintained.

### Option C: pg-boss (queue inside PostgreSQL)
- Job queue implemented on PostgreSQL tables with `SKIP LOCKED`. It reuses the existing `db` service.
- **Pros:** No new infrastructure. Jobs are transactional with the same database that stores the video row.
- **Cons:** Puts polling load and job churn on the primary database that serves the whole app. No first-party Nest module. Deviates from the architecture diagram, which models the queue as its own container. `pg-boss@12` requires Node ≥ 22.12.

**Recommendation:** **Option A (BullMQ + Redis)**. Retries with exponential backoff and one-job-per-video deduplication are native features, which is exactly what TD-10 needs. Option B would require building them by hand, and Option C would load the primary database with queue traffic. The extra Redis container is the cost, and it matches the diagram's separate "Message Queue" container.

**Decision:** _[pending]_

---

## TD-02: Object Storage Client and Key Layout

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The storage service is given (S3-compatible). What remains open is how the API and the worker talk to it and how objects are organized. The client choice also determines presigned-URL support (needed by TD-04 and TD-08) and portability between MinIO-compatible storage locally and AWS S3 in production.

**Options:**

### Option A: AWS SDK for JavaScript v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)
- Official modular S3 client. Points at the local storage with `endpoint` + `forcePathStyle: true` and at AWS with the defaults. Presigning is done with `getSignedUrl(client, command)`.
- **Pros:** The same code runs against local storage and AWS S3, so only env vars change. Presigns any command (`UploadPart`, `GetObject` with response overrides), which covers TD-04 and TD-08 with one library. Typed commands for multipart (`CreateMultipartUpload`, `ListParts`, `CompleteMultipartUpload`, `AbortMultipartUpload`).
- **Cons:** Verbose command-object API. Larger dependency tree, partly mitigated by modular packages.

### Option B: MinIO JavaScript SDK (`minio@8`)
- MinIO's own S3 client with convenience methods (`presignedPutObject`, `presignedGetObject`, `fPutObject`).
- **Pros:** Concise API for single-object operations.
- **Cons:** Ties the code to a MinIO-branded client while production targets AWS S3. The vendor archived the MinIO community edition in 2026, and the package's last release was February 2026. Presigning individual multipart parts is not exposed as a first-class method.

**Key layout:** a single bucket (`STORAGE_BUCKET`) with per-video prefixes keyed by the immutable primary key: `videos/{videoId}/source` for the uploaded file and `videos/{videoId}/thumbnail.jpg` for the generated frame. Keying by `videoId` instead of the public URL id (TD-07) keeps storage paths unaffected by anything public-facing.

**Recommendation:** **Option A (AWS SDK v3)**. It is the only option that presigns multipart parts as first-class operations and that is portable to AWS S3 without code changes, which is the explicit intent of the "MinIO locally, S3 in production" constraint.

**Decision:** _[pending]_

---

## TD-03: Local S3-Compatible Storage Container Image

**Scope:** Repo-wide

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The brief says to run MinIO locally in Docker. However, the MinIO community images are no longer pullable anonymously. The `minio/minio` and `minio/mc` repositories were removed from Docker Hub in September 2026 (`docker pull minio/minio` → "repository does not exist"; verified on this machine on 2026-11-14). The `quay.io/minio/minio` mirror requires authentication since 2026-09-24 and is frozen at a September 2025 release. A clean clone must be able to run `docker compose up`, so the image choice is a real decision. It is cross-component: it involves `compose.yaml`, the healthcheck, and the env vars read by the app.

**Options:**

### Option A: `quay.io/minio/minio` (official mirror)
- Same official binary, served from Quay instead of Docker Hub.
- **Pros:** Upstream MinIO, a one-line registry change.
- **Cons:** Anonymous pulls return `401`, so a clean clone still fails. Frozen at `RELEASE.2025-09-07T16-13-09Z` without the CVE-2025-62506 fix.

### Option B: `pgsty/silo` (maintained MinIO fork)
- A fork of the MinIO server. Its entrypoint accepts the same `server /data --console-address ":9001"` command and reads the same `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` variables. The image ships `mc` and `curl` for healthchecks.
- **Pros:** Publicly pullable, published with build provenance, and behaviorally identical to MinIO for the S3 features this phase uses (multipart, presigning, `Range`). The service can keep the name `minio`, so `STORAGE_ENDPOINT=http://minio:9000` matches the brief.
- **Cons:** A community fork, not the original vendor. Pin it by digest so a tag move cannot change behavior silently.

### Option C: RustFS (`rustfs/rustfs`, 1.0 GA)
- An Apache-2.0 S3-compatible server written in Rust and designed as a MinIO replacement on port 9000.
- **Pros:** Actively developed, permissive license, and a long-term destination if MinIO forks fade.
- **Cons:** It is a different implementation, so multipart and presign behavior must be re-validated. Its environment variables, command and healthcheck differ from MinIO's, so the brief's "MinIO" setup and docs no longer map one-to-one.

**Recommendation:** **Option B (`pgsty/silo`, pinned by digest)**. It is the only option that pulls anonymously today and keeps MinIO's exact behavior and configuration surface, so the brief's "MinIO locally" setup holds with a different image. Option C stays the documented exit path if the fork stops being maintained.

**Decision:** _[pending]_

---

## TD-04: Large-File (10 GB) Upload Strategy

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** A 10 GB file must not tie up the API: no request may hold the bytes, block the event loop, or buffer to the container disk. The upload must also start by pre-registering the video as a draft. This is a handshake that a client (future frontend, scripts, tests) and the backend must implement identically, so it is cross-layer even though the UI is out of scope for this phase.

**Options:**

### Option A: Presigned S3 multipart upload (direct to storage)
- `POST` creates the draft video and an S3 multipart upload. The client asks for presigned `UploadPart` URLs, `PUT`s each part straight to storage, then calls a complete endpoint. The API only exchanges small JSON messages.
- **Pros:** Zero video bytes pass through the API, so the API stays responsive under any number of concurrent uploads. Native S3 feature: parts are 5 MiB to 5 GiB with up to 10,000 parts, which covers 10 GB with ample headroom. Parts can be retried individually, and the same flow works against AWS S3.
- **Cons:** A three-step client handshake. Browsers need CORS on the bucket in a deployed setup. Abandoned uploads leave incomplete multipart data, which needs a cleanup policy (storage lifecycle rule or abort on failure).

### Option B: tus resumable protocol (`@tus/server` with an S3 store)
- A tus endpoint in the API receives `PATCH` chunks and forwards them to S3 through the S3 store.
- **Pros:** Standard resumable protocol with mature clients (`tus-js-client`, Uppy) and resume after disconnect out of the box.
- **Cons:** Every byte still flows through the API process, so 10 GB uploads consume API bandwidth and connections. Adds a protocol server inside Nest and a client library dependency.

### Option C: Streamed multipart/form-data through the API
- The API parses the request with a streaming parser (e.g., busboy) and pipes the file to S3 (`@aws-sdk/lib-storage` `Upload`).
- **Pros:** Simplest client: one `POST` with a file.
- **Cons:** A single long request for 10 GB holds an API connection for the whole transfer, cannot resume, and is sensitive to proxy and request timeouts. This is the approach the brief explicitly calls wrong.

**Policy parameters (part of the contract):** maximum declared size `10 GiB` (10 737 418 240 bytes), with `sizeBytes` validated at initiation. Part size `64 MiB`, so a 10 GiB file is 160 parts, far from the 10,000-part limit. Presigned URL TTL of 1 hour. On completion the server lists the uploaded parts itself (`ListParts`) instead of trusting client-sent ETags, so clients do not need the `ETag` header exposed through CORS. It rejects the upload if the assembled size differs from the declared size.

**Recommendation:** **Option A (presigned S3 multipart)**. It is the only option in which the API never carries video bytes, which is what "sem impacto na performance" requires. It reuses TD-02's client and matches the diagram, where clients reach storage directly. Server-side `ListParts` keeps the client contract to "upload parts, then call complete".

**Decision:** _[pending]_

---

## TD-05: Worker Deployment Model

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The diagram models the Video Worker as a separate container. Processing (download from storage, FFmpeg) is CPU- and IO-heavy and must not compete with HTTP requests. The worker needs the same entities, config and storage client as the API.

**Options:**

### Option A: Separate Compose service, same codebase, headless Nest application context
- A second entrypoint (`src/main.worker.ts`) boots `NestFactory.createApplicationContext(WorkerModule)`, without an HTTP server, and registers the queue consumer. Compose runs it as a `worker` service built from the same image.
- **Pros:** Process isolation (a crashing or busy worker never affects the API) and independent scaling (`docker compose up --scale worker=N`). Shares entities, config and the storage service without duplicating code.
- **Cons:** Two entrypoints to keep wired, and a module boundary (`WorkerModule`) that must import only what the worker needs.

### Option B: In-process consumer inside the API
- The `@Processor` lives in the API module, so the same process serves HTTP and consumes jobs.
- **Pros:** Simplest wiring, with one process.
- **Cons:** FFmpeg runs and storage downloads share CPU and memory with request handling, which defeats the purpose of queuing. Contradicts the diagram's separate worker container.

### Option C: Separate subproject (own `package.json`)
- A new top-level `video-worker/` project with its own dependencies and Dockerfile.
- **Pros:** Strongest separation, and the worker could use another language.
- **Cons:** Duplicates the entity definitions, config validation and storage client, so the contract can drift. Doubles tooling (lint, tsc, tests) for one consumer.

**Recommendation:** **Option A (separate service, same codebase)**. It gets the isolation the diagram asks for without duplicating the domain model, and it scales horizontally through Compose.

**Decision:** _[pending]_

---

## TD-06: Media Probing and Thumbnail Tooling

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The worker must read duration and metadata (codec, resolution, bitrate) and extract one frame as a JPEG. FFmpeg/ffprobe are the de-facto tools. The open question is how Node invokes them. The most popular wrapper, `fluent-ffmpeg`, is **deprecated on npm ("Package no longer supported") and its GitHub repository was archived in May 2025**.

**Options:**

### Option A: `fluent-ffmpeg` over system FFmpeg
- A chainable wrapper API (`ffprobe(path, cb)`, `.screenshots(...)`).
- **Pros:** Familiar API with many examples.
- **Cons:** Deprecated and archived, so it gets no fixes for new FFmpeg versions or security issues. Adding a dead dependency in a greenfield phase is debt from day one.

### Option B: Spawn system `ffprobe`/`ffmpeg` directly (`node:child_process`)
- FFmpeg is installed in the image (`apt install ffmpeg`). The worker calls `ffprobe -v error -print_format json -show_format -show_streams <file>` and `ffmpeg -ss <t> -i <file> -frames:v 1 -vf scale=... <out.jpg>` through `execFile` (no shell).
- **Pros:** No third-party wrapper. ffprobe's JSON output is a stable, documented format. `execFile` with an argument array avoids shell injection. A thin, fully typed service of a few dozen lines.
- **Cons:** The project owns argument building and output parsing, with timeouts and error mapping.

### Option C: Bundled binaries (`ffmpeg-static`/`ffprobe-static`) or `ffmpeg.wasm`
- Ship FFmpeg as an npm-delivered binary, or run the WebAssembly build inside Node.
- **Pros:** No apt dependency in the image.
- **Cons:** Large binaries in `node_modules` per architecture. The WASM build is much slower and memory-limited for multi-GB files, which makes it unsuitable for 10 GB videos.

**Thumbnail policy:** capture the frame at 10% of the duration (falling back to 0 s for very short clips), scaled to 1280 px wide while preserving the aspect ratio, JPEG.

**Recommendation:** **Option B (spawn system ffprobe/ffmpeg)**. It avoids a deprecated, archived dependency, relies on FFmpeg's stable CLI and JSON contract, and keeps the integration small and testable against the real binary in the container.

**Decision:** _[pending]_

---

## TD-07: Unique Video URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a public, URL-safe identifier that never collides with another video's. The primary key is a UUID, so the question is whether to expose it or generate a dedicated short id.

**Options:**

### Option A: Expose the UUID primary key
- Use `videos.id` in URLs.
- **Pros:** No extra column, and unique by construction.
- **Cons:** Long (36 chars) and leaks the internal key to public URLs. Ties future storage or DB refactors to public links.

### Option B: `nanoid`
- Random URL-safe ids from the `nanoid` package.
- **Pros:** Well-known, configurable alphabet and length.
- **Cons:** `nanoid@6` is ESM-only and requires Node ^22/^24/≥26, while the project compiles to CommonJS, so it needs an older major or ESM interop. It is an extra dependency for something `node:crypto` already does.

### Option C: `node:crypto` random id + unique constraint + retry
- Generate 8 random bytes and encode them as 11-char base64url (YouTube-style). Store the id in `videos.url_id` with a `UNIQUE` constraint, and on the rare unique violation regenerate and retry (bounded attempts).
- **Pros:** No dependency. 64 bits of entropy make collisions negligible, and the DB constraint makes uniqueness a guarantee rather than a probability. Short, opaque and decoupled from the primary key.
- **Cons:** One extra indexed column and a small retry loop to maintain.

**Recommendation:** **Option C**. The database constraint turns "sem conflito" into a hard guarantee, the id is short and opaque, and it avoids an ESM-only dependency in a CommonJS build.

**Decision:** _[pending]_

---

## TD-08: Playback (Streaming) and Download Delivery

**Scope:** Cross-layer

**Capability:** Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Streaming requires HTTP `Range` support (`206 Partial Content`) so players can seek without downloading the whole file. Download must deliver the file as an attachment. Auth is a bearer header (phase-02-auth TD-02/TD-09), and an HTML `<video src>` element cannot attach headers. The diagram also says the frontend streams **from Object Storage**, not through the API. The client and the backend must agree on the shape.

**Options:**

### Option A: API proxies the bytes with `Range` support
- `GET /videos/:urlId/stream` reads the `Range` header, calls `GetObject` with that range and pipes the body with `206` + `Content-Range`.
- **Pros:** Storage stays fully private, and the access check happens on every request.
- **Cons:** All playback bandwidth flows through the API, the same performance problem TD-04 avoids for uploads. It contradicts the diagram, and the auth header still does not reach `<video src>`.

### Option B: `302` redirect to a presigned `GET` URL
- The endpoint checks access and redirects. Storage serves the bytes and honors `Range` natively.
- **Pros:** No bytes through the API, and native `206` from storage.
- **Cons:** The redirecting request must carry the bearer header, which `<video src>` cannot send, so a browser player cannot use it directly. Redirects also hide the URL's expiry from the client.

### Option C: Endpoints that return a short-lived presigned URL as JSON
- `GET /videos/:urlId/playback` returns `{ url, expiresAt }` for an inline `GetObject`, and `GET /videos/:urlId/download` returns `{ url, expiresAt }` signed with `ResponseContentDisposition: attachment; filename="..."`. The client puts `url` in the player or follows it to download. Storage serves `Range`/`206` natively.
- **Pros:** Works with the existing bearer-header auth (the JSON call carries the header; the media URL needs none). No bytes through the API, and it matches the diagram. Expiry is explicit to the client. A REST-style JSON contract consistent with the rest of the API.
- **Cons:** Presigned URLs are bearer-like for their TTL (mitigated by a short TTL, 15 minutes). The presigned host must be reachable by the client, which requires a public storage endpoint setting (`STORAGE_PUBLIC_ENDPOINT`) distinct from the internal `minio:9000`.

**Recommendation:** **Option C (JSON presigned URLs)**. It is the only option that works with the bearer-header contract inherited from Phase 02 while keeping playback bytes off the API, as the diagram prescribes. Range/206 comes from S3 itself.

**Decision:** _[pending]_

---

## TD-09: Access Policy for Playback and Download in This Phase

**Scope:** Backend

**Capability:** Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Phase 03 produces videos, but publishing (draft → published, public vs unlisted) is Phase 04, and the public watch page is Phase 05 (`docs/project-plan.md`). Phase 03 must still serve playback and download, so it must decide who may obtain the URLs. Depends on TD-08.

**Options:**

### Option A: Owner-only until publishing exists
- Playback/download URLs and video details are returned only to the authenticated owner of the video's channel. Other users get `404` (not `403`), so unpublished videos do not reveal their existence.
- **Pros:** Never exposes content that the owner has not published, a capability that only arrives in Phase 04. Phase 04 widens the policy (e.g., public + `ready` + published) without retracting anything.
- **Cons:** Anonymous viewing, a project goal, is not reachable until Phase 04/05.

### Option B: Public for any `ready` video by URL id
- Anyone holding the URL id can obtain playback/download URLs once processing finishes.
- **Pros:** Immediately exercises anonymous viewing.
- **Cons:** Effectively publishes every processed video before a publish flow exists. Phase 04 would have to retract access already granted.

**Recommendation:** **Option A (owner-only, 404 for others)**. It is the conservative default while publishing does not exist, and it lets Phase 04 add visibility rules without breaking expectations created here.

**Decision:** _[pending]_

---

## TD-10: Video Status Lifecycle and Processing-Failure Handling

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The video row is created as a draft when the upload starts and must reflect processing progress and outcome in the database. Processing can fail transiently (storage hiccup) or permanently (corrupt file, not a video). Depends on TD-01 (retry primitives).

**Options:**

### Option A: Status enum on `videos` + queue retries, `failed` as terminal
- `status` ∈ `draft` (pre-registered, upload in progress) → `processing` (upload completed, job enqueued) → `ready` | `failed`. The worker retries transient errors with the queue's `attempts: 3` + exponential backoff. After the last attempt it sets `failed` with a `processing_error` message. A file that ffprobe cannot read fails immediately, without retries. The job id is the video id, so re-enqueueing is idempotent.
- **Pros:** One source of truth in the row that clients read. Retries and backoff come for free from TD-01, and failures are visible and explainable.
- **Cons:** No per-attempt history in the database (it lives in the queue's job record).

### Option B: Separate `video_processing_jobs` table
- Each attempt is a row with timestamps and errors, and the video status is derived from it.
- **Pros:** Full audit trail in SQL.
- **Cons:** Duplicates what the queue already tracks, and adds a table and joins with no capability asking for history.

### Option C: Status enum + dead-letter queue
- Like A, but exhausted jobs are moved to a separate DLQ for manual replay.
- **Pros:** Explicit operational queue for failures.
- **Cons:** BullMQ already retains failed jobs, so a second queue adds wiring without a requirement behind it.

**Recommendation:** **Option A**. The four-state enum is exactly what the brief asks for (rascunho → processando → pronto/erro), TD-01 provides retries, and permanent failures become visible in the same row without extra tables.

**Decision:** _[pending]_

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Message Queue Technology | BullMQ + Redis | _[pending]_ |
| TD-02 | Backend | Object Storage Client and Key Layout | AWS SDK v3, single bucket `videos/{videoId}/…` | _[pending]_ |
| TD-03 | Repo-wide | Local S3-Compatible Storage Image | `pgsty/silo` (MinIO fork) pinned by digest | _[pending]_ |
| TD-04 | Cross-layer | Large-File (10 GB) Upload Strategy | Presigned S3 multipart, 64 MiB parts, server-side `ListParts` | _[pending]_ |
| TD-05 | Backend | Worker Deployment Model | Separate Compose service, same codebase | _[pending]_ |
| TD-06 | Backend | Media Probing and Thumbnail Tooling | Spawn system ffprobe/ffmpeg | _[pending]_ |
| TD-07 | Backend | Unique Video URL Identifier | `node:crypto` 11-char base64url + unique + retry | _[pending]_ |
| TD-08 | Cross-layer | Playback and Download Delivery | JSON presigned URLs (storage serves Range/206) | _[pending]_ |
| TD-09 | Backend | Access Policy for Playback and Download | Owner-only, 404 for others | _[pending]_ |
| TD-10 | Backend | Video Status Lifecycle and Failure Handling | Status enum + queue retries, `failed` terminal | _[pending]_ |
