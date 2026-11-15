# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 10/13 completed

### SI-03.1 — Infraestrutura base: dependências, FFmpeg, Redis e storage no Compose
- **Status:** completed
- **Tests:** no tests (Infra)
- **Observations:** 
  - Clean-clone check: `redis` and `minio` (pgsty/silo pinned by digest) reach `healthy` without any registry login; `ffmpeg`/`ffprobe` 5.1.9 available in the `nestjs-api` image.
  - Baseline before any phase code: `src/database/migrations.integration-spec.ts` fails with `type "verification_tokens_type_enum" already exists` (its setup drops tables but not enum types). Its `afterAll` then throws before `dataSource.destroy()`, and the leaked connection keeps Jest from exiting, so `npm test` hangs. The fix belongs to SI-03.4, which already owns this test file.
  - `test:e2e` now runs with `--runInBand`, matching what `nestjs-project/CLAUDE.md` already documented.

### SI-03.2 — Configuração de storage e fila (namespaces e contrato de env)
- **Status:** completed
- **Tests:** 12/12 passing (env.validation.integration-spec.ts)
- **Observations:** 
  - `.env.example` had `MAIL_FROM="StreamTube" <noreply@streamtube.com>` with an unquoted `<`, so Docker Compose refused to parse a `.env` copied from it (the failure mode `nestjs-project/CLAUDE.md` warns about). Fixed it to `MAIL_FROM="StreamTube <noreply@streamtube.com>"` because this SI already edits the file.
  - The base env of `env.validation.integration-spec.ts` gained the three storage keys that are now required; otherwise the pre-existing SWAGGER_ENABLED cases would fail on unrelated validation.

### SI-03.3 — StorageModule e StorageService (S3-compatível)
- **Status:** completed
- **Tests:** 7/7 passing (storage.module.spec.ts, storage.service.integration-spec.ts — real S3-compatible storage from Compose)
- **Observations:** 
  - Verified against the real storage: a presigned `UploadPart` URL carries no `x-amz-checksum` parameters and accepts a plain `PUT`; a presigned GET with `Range` returns `206` + `Content-Range`; download URLs return `Content-Disposition: attachment` (quotes and line breaks in filenames are replaced).
  - Baseline lint debt found before any phase code: `npm run lint` reports 157 errors in files from phases 01/02 (mostly `no-unsafe-*` on `any` values from supertest/Jest in tests, plus `channels.service.ts` and `create-test-data-source.ts`). The Definition of Done requires lint to pass, so it is scheduled for SI-03.13 (DoD SI). Files created in this phase are kept lint-clean as they are written.

### SI-03.4 — Entidade Video, migration e identificador de URL
- **Status:** completed
- **Tests:** 8/8 passing (video.entity.integration-spec.ts, url-id.util.spec.ts, migrations.integration-spec.ts); full suites re-run: 165/165 unit+integration, 52/52 e2e
- **Observations:** 
  - Migration generated with `npm run migration:generate` (`1794699126435-CreateVideos.ts`) and applied; formatted by `eslint --fix`.
  - Entity follows the project's snake_case property convention (`user_id`, `created_at` in `Channel`/`User`) instead of camelCase with column-name mapping.
  - Fixed the baseline migrations test: tables are dropped sequentially and the enum types (`verification_tokens_type_enum`, `videos_status_enum`) are dropped too. Its 'revert last migration' case now targets `CreateVideos`, which is the last migration. With `afterAll` no longer throwing, `npm test` exits normally again (~7 s).
  - Adding the required inverse side `Channel.videos` means every DataSource that registers `Channel` must also register `Video`: added `Video` to the `ALL_ENTITIES` list of 10 existing test files.
  - Pulled forward from SI-03.6: a minimal `VideosModule` with `TypeOrmModule.forFeature([Video])`, registered in `AppModule`. Without it `autoLoadEntities` does not load `Video`, so the app (and the e2e suites) fail on the `Channel.videos` relation. SI-03.6 extends this module.
  - Fix to SI-03.2: `test/jest-e2e.json` has `rootDir` = `test/`, so the setup file path is `<rootDir>/setup-queue-prefix.ts`. The e2e run surfaced it; SI-03.2 had only run the unit config.
  - Dev database had drifted (baseline migrations test dropped `migrations` while other suites re-created tables via `synchronize`); reset with `DROP SCHEMA public CASCADE` and `migration:run`, as the migrations rule prescribes.

### SI-03.5 — Exceções de domínio, módulo de fila e produtor de jobs
- **Status:** completed
- **Tests:** 4/4 passing (queue.module.spec.ts, video-processing.producer.integration-spec.ts — real Redis, test prefix)
- **Observations:** 
  - `@nestjs/bullmq@12` is published ESM-only and cannot be loaded by this CommonJS build/Jest (`SyntaxError: Unexpected token 'export'`). Pinned `@nestjs/bullmq@^11.0.5` (CommonJS, peers `bullmq ^6` + Nest 11), recorded as a Revision of TD-01 and propagated to library-refs, context, validation and the plan.
  - `bullmq@6` declares `ioredis` as an *optional* peer and fails at runtime without it; installed `ioredis@^5.11.1` explicitly (TD-01 Libraries + Revision).
  - Domain exceptions live in `src/videos/video.exceptions.ts` (extending the shared `DomainException`), so the videos domain owns its errors instead of growing `common/exceptions/domain.exception.ts`.

### SI-03.6 — Início do upload: pré-cadastro e URLs das partes
- **Status:** completed
- **Tests:** 19 passing — 12 unit/integration (videos.service.spec.ts, videos.service.integration-spec.ts, videos.module.spec.ts) + 7 e2e (test/videos.e2e-spec.ts); full suites: 181/181 unit+integration, 59/59 e2e
- **Observations:** 
  - Added `test/helpers/video-test-app.ts` (boots `AppModule` with the `main.ts` pipes/filters; creates a confirmed user + channel in the DB and logs in through the real `/auth/login`), so video e2e tests don't need to mock the mailer like the auth suite does.
  - `ChannelsService.findByUserId` added to the channels module (channel resolution belongs to its owner module, per the single-responsibility principle in CLAUDE.md).
  - Owner check is a single query (`url_id` + `channel.user_id`), so non-owners get `404 VIDEO_NOT_FOUND` without a separate existence lookup (TD-09).

### SI-03.7 — Conclusão do upload e enfileiramento do processamento
- **Status:** completed
- **Tests:** 38 passing in the video suites — 28 unit/integration (videos.service.spec.ts, videos.service.integration-spec.ts, videos.module.spec.ts, producer) + 10 e2e (test/videos.e2e-spec.ts)
- **Observations:** 
  - Completion validates parts against storage (`ListParts`): parts 1..N present, exact count, sum equals the declared `size_bytes`; client-sent ETags are never trusted (TD-04).
  - Order of effects: complete multipart → save `processing` → enqueue. Enqueue is idempotent (`jobId = videoId`). If Redis were down after the save, the video would stay `processing` with no job; re-publishing it is an operational action, not part of this phase's scope.
  - e2e assertion looks the job up in every queue state, so it doesn't depend on whether a worker consumes it (lesson from the reference review).

### SI-03.8 — Consulta, playback (streaming) e download
- **Status:** completed
- **Tests:** 51 passing in the video suites — 37 unit/integration + 14 e2e (test/videos.e2e-spec.ts)
- **Observations:** 
  - Verified end to end on the real storage: the playback URL answers `Range: bytes=0-3` with `206` and only those bytes; the download URL answers with `Content-Disposition: attachment; filename="…"`.
  - Read endpoints use the same owner-scoped query as uploads, so non-owners get `404` (TD-09); playback/download require `ready` (`409 VIDEO_NOT_READY` otherwise).

### SI-03.9 — Sonda de mídia: duração, metadados e thumbnail com FFmpeg
- **Status:** completed
- **Tests:** 10/10 passing (media-probe.service.spec.ts, media-probe.service.integration-spec.ts — real FFmpeg 5.1 in the container)
- **Observations:** 
  - Parsing of ffprobe's JSON is a pure exported function (`parseProbeOutput`), unit-tested with fixtures; the integration test generates a real 2 s `testsrc` clip and checks duration, 320×240, h264/aac, 25 fps and a JPEG thumbnail (magic bytes).
  - Binaries are invoked with `execFile` and argument arrays (no shell), with timeouts and a raised `maxBuffer` for large ffprobe outputs (TD-06).

### SI-03.10 — Pipeline de processamento do vídeo
- **Status:** completed
- **Tests:** 21 passing in src/video-processing (video-processing.service.spec.ts, video-processing.service.integration-spec.ts + SI-03.9 suites) — real DB, storage and FFmpeg
- **Observations:** 
  - The integration test runs the whole pipeline on a generated 2 s clip: the row becomes `ready` with duration≈2 s, 320×240/h264 metadata, `processed_at` and a JPEG thumbnail readable from storage; a second delivery of the same job is skipped.
  - The `ready` update is conditional on `status = processing` and `markFailed` on `status <> ready`, so a late failure event can never downgrade a processed video (TD-10).
  - Work files live in a per-video temp dir removed in `finally`, so multi-GB sources don't accumulate on the worker's disk.

### SI-03.11 — Worker: entrypoint, consumidor da fila e serviço no Compose
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.12 — Varredura de uploads abandonados
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.13 — Documentação de IA e Definition of Done
- **Status:** pending
- **Tests:** —
- **Observations:** none
