# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 1/13 completed

### SI-03.1 — Infraestrutura base: dependências, FFmpeg, Redis e storage no Compose
- **Status:** completed
- **Tests:** no tests (Infra)
- **Observations:** 
  - Clean-clone check: `redis` and `minio` (pgsty/silo pinned by digest) reach `healthy` without any registry login; `ffmpeg`/`ffprobe` 5.1.9 available in the `nestjs-api` image.
  - Baseline before any phase code: `src/database/migrations.integration-spec.ts` fails with `type "verification_tokens_type_enum" already exists` (its setup drops tables but not enum types). Its `afterAll` then throws before `dataSource.destroy()`, and the leaked connection keeps Jest from exiting, so `npm test` hangs. The fix belongs to SI-03.4, which already owns this test file.
  - `test:e2e` now runs with `--runInBand`, matching what `nestjs-project/CLAUDE.md` already documented.

### SI-03.2 — Configuração de storage e fila (namespaces e contrato de env)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.3 — StorageModule e StorageService (S3-compatível)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.4 — Entidade Video, migration e identificador de URL
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.5 — Exceções de domínio, módulo de fila e produtor de jobs
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.6 — Início do upload: pré-cadastro e URLs das partes
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Conclusão do upload e enfileiramento do processamento
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — Consulta, playback (streaming) e download
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — Sonda de mídia: duração, metadados e thumbnail com FFmpeg
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — Pipeline de processamento do vídeo
- **Status:** pending
- **Tests:** —
- **Observations:** none

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
