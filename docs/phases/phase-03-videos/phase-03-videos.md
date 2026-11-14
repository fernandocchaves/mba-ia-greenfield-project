---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-14T19:58:10-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-14T19:56:18-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-14T19:58:10-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o upload de vídeos de até 10GB direto para o object storage (sem passar bytes pela API), com pré-cadastro do vídeo como rascunho, processamento automático em uma fila consumida por um worker FFmpeg (duração, metadados e thumbnail), URL única por vídeo, reprodução via streaming e download — com storage, fila e worker reais subindo no Docker Compose.

---

## Step Implementations

### SI-03.1 — Infraestrutura base: dependências, FFmpeg, Redis e storage no Compose

**Description:** Prepara o ambiente que todos os SIs seguintes usam: bibliotecas novas, FFmpeg na imagem e os serviços `redis` e `minio` no Compose. O serviço `worker` só entra no SI-03.11, quando seu entrypoint existir.

**Technical actions:**

1. Instalar `bullmq@^6.7.6`, `@nestjs/bullmq@^12.0.2`, `@aws-sdk/client-s3@^3.1169.0` e `@aws-sdk/s3-request-presigner@^3.1169.0` dentro do container (per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`)
2. Atualizar `nestjs-project/Dockerfile.dev` — `apt install -y procps curl ffmpeg` (per `phase-03-videos/TD-06`)
3. Adicionar em `nestjs-project/compose.yaml` o serviço `redis` (`redis:7`, healthcheck `redis-cli ping`) e o serviço `minio` com a imagem `pgsty/silo` fixada por digest, `command: server /data --console-address ":9001"`, `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`, portas 9000/9001, volume nomeado `minio-data` e healthcheck `mc ready local`; `nestjs-api.depends_on` passa a incluir ambos como `service_healthy` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`)
4. Corrigir `package.json` → `test:e2e` passa a rodar com `--runInBand` (as suítes e2e compartilham o banco; o `nestjs-project/CLAUDE.md` já declara esse requisito, mas o script não o aplicava)

**Tests:** _(empty — Infra; smoke-gated by AC)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` deixa `db`, `mailpit`, `redis` e `minio` em `running (healthy)` num clone limpo, sem login em registry
- `docker compose exec nestjs-api ffmpeg -version` e `ffprobe -version` respondem com código 0
- As suítes existentes continuam verdes (`npm test -- --runInBand`, `npm run test:e2e`)

---

### SI-03.2 — Configuração de storage e fila (namespaces e contrato de env)

**Description:** Materializa o contrato de variáveis do TD-11 (com a revisão `QUEUE_PREFIX`) como namespaces de config validados por Joi, e isola as filas dos testes.

**Technical actions:**

1. Criar `src/config/storage.config.ts` — `registerAs('storage')` com `endpoint` (`STORAGE_ENDPOINT`), `publicEndpoint` (`STORAGE_PUBLIC_ENDPOINT`, cai para `STORAGE_ENDPOINT` quando ausente), `region`, `accessKey`, `secretKey`, `bucket` (per `phase-03-videos/TD-11`)
2. Criar `src/config/queue.config.ts` — `registerAs('queue')` com `host` (`REDIS_HOST`), `port` (`REDIS_PORT`), `prefix` (`QUEUE_PREFIX`) (per `phase-03-videos/TD-11` revisão 2026-11-14)
3. Estender `src/config/env.validation.ts` — `STORAGE_ENDPOINT` (uri, required), `STORAGE_PUBLIC_ENDPOINT` (uri, opcional), `STORAGE_REGION` (default `us-east-1`), `STORAGE_ACCESS_KEY` e `STORAGE_SECRET_KEY` (required), `STORAGE_BUCKET` (default `streamtube-videos`), `REDIS_HOST` (default `redis`), `REDIS_PORT` (default `6379`), `QUEUE_PREFIX` (default `streamtube`); registrar os dois namespaces no `ConfigModule.forRoot({ load })` do `AppModule`
4. Atualizar `nestjs-project/.env.example` com as chaves acima, usando os nomes de serviço do Compose como host
5. Criar `test/setup-queue-prefix.ts` — define `process.env.QUEUE_PREFIX ??= 'streamtube-test'` e registrar em `setupFiles` (depois de `dotenv/config`) tanto no jest do `package.json` quanto em `test/jest-e2e.json` (per `phase-03-videos/TD-11` revisão 2026-11-14)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` | Integration: chaves obrigatórias e defaults de storage/fila | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** SI-03.1 — os valores do `.env.example` apontam para os serviços criados ali

**Acceptance criteria:**

- A aplicação recusa subir sem `STORAGE_ENDPOINT`, `STORAGE_ACCESS_KEY` ou `STORAGE_SECRET_KEY`
- Sem `STORAGE_PUBLIC_ENDPOINT`, `storage.publicEndpoint` é igual a `storage.endpoint`
- Dentro do Jest, `queue.prefix` vale `streamtube-test`; fora dele, `streamtube`

---

### SI-03.3 — StorageModule e StorageService (S3-compatível)

**Description:** Encapsula todo o acesso ao object storage num serviço reutilizado pela API e pelo worker: bootstrap do bucket, multipart, URLs pré-assinadas e I/O de objetos.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` — provê dois `S3Client`: o interno (`storage.endpoint`) para operações do servidor e o de assinatura (`storage.publicEndpoint`) só para presign; ambos com `forcePathStyle: true`, `requestChecksumCalculation: 'WHEN_REQUIRED'` e `responseChecksumValidation: 'WHEN_REQUIRED'` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-11`, `library-refs.md` → `@aws-sdk/client-s3`)
2. Criar `src/storage/storage.service.ts` — `onModuleInit` garante o bucket (`HeadBucket` → `CreateBucket`, com retentativas curtas para a corrida de startup do Compose); multipart: `createMultipartUpload(key, contentType)`, `presignUploadPart(key, uploadId, partNumber, expiresInSeconds)`, `listUploadedParts(key, uploadId)` (paginado por `PartNumberMarker`), `completeMultipartUpload(key, uploadId, parts)` e `abortMultipartUpload(key, uploadId)`, que trata `NoSuchUpload` como sucesso (per `phase-03-videos/TD-04`, `phase-03-videos/TD-12`)
3. No mesmo serviço — `presignGetObject(key, { expiresInSeconds, downloadFilename? })` (com `ResponseContentDisposition: attachment` quando `downloadFilename` vier), `downloadToFile(key, filePath)` em stream e `putObject(key, body, contentType)` (per `phase-03-videos/TD-06`, `phase-03-videos/TD-08`)
4. Criar `src/storage/storage.errors.ts` — `StorageUploadNotFoundError`, que o serviço lança quando o storage responde `NoSuchUpload` em `listUploadedParts`/`completeMultipartUpload` (erro interno, sem status HTTP; o módulo de vídeos traduz para domínio)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageModule` | Unit: compilation test | `src/storage/storage.module.spec.ts` |
| `StorageService` | Integration: storage real do Compose — bucket idempotente, multipart com PUT em URL pré-assinada, list/complete, abort idempotente, presigned GET com `Range` → 206 e `attachment` | `src/storage/storage.service.integration-spec.ts` |

**Dependencies:** SI-03.2 — usa o namespace `storage`

**Acceptance criteria:**

- Um `PUT` feito com `fetch` numa URL de `presignUploadPart` responde 200 sem enviar cabeçalhos de checksum
- `abortMultipartUpload` sobre um upload já inexistente não lança erro
- Um `GET` numa URL de `presignGetObject` com `Range: bytes=0-9` responde `206` com `Content-Range`
- Com `downloadFilename`, o `GET` traz `Content-Disposition: attachment; filename="..."`

---

### SI-03.4 — Entidade Video, migration e identificador de URL

**Description:** Cria a tabela de vídeos ligada ao canal, com o ciclo de status e o identificador público único.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — `@Entity('videos')` conforme `### Data Model → Video`; `@ManyToOne(() => Channel, (channel) => channel.videos, { onDelete: 'CASCADE' })` com `@JoinColumn({ name: 'channel_id' })` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-10`)
2. Atualizar `src/channels/entities/channel.entity.ts` — lado inverso `@OneToMany(() => Video, (video) => video.channel) videos`
3. Criar `src/videos/url-id.util.ts` — `generateUrlId(): string` com `randomBytes(8).toString('base64url')` (11 caracteres) (per `phase-03-videos/TD-07`)
4. Gerar a migration pelo CLI — `npm run migration:generate -- src/database/migrations/CreateVideos` — e aplicá-la com `npm run migration:run`
5. Atualizar `src/test/create-test-data-source.ts` (`cleanAllTables` apaga `videos` antes de `channels`) e `src/database/migrations.integration-spec.ts` (inclui a migration nova e remove o tipo `videos_status_enum` no setup)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: unique `url_id`, default `draft`, `bigint` sem perda, cascade ao apagar o canal | `src/videos/entities/video.entity.integration-spec.ts` |
| `generateUrlId` | Unit: 11 caracteres, alfabeto base64url, sem repetição em 10 000 ids | `src/videos/url-id.util.spec.ts` |
| Migrations | Integration: aplicar e reverter todas, inclusive `CreateVideos` | `src/database/migrations.integration-spec.ts` |

**Dependencies:** SI-03.1 — `migration:run` roda no banco do Compose

**Acceptance criteria:**

- `npm run migration:run` cria `videos` e o tipo `videos_status_enum`; `migration:revert` remove ambos
- Inserir dois vídeos com o mesmo `url_id` falha por violação de unicidade
- Apagar o canal apaga seus vídeos

---

### SI-03.5 — Exceções de domínio, módulo de fila e produtor de jobs

**Description:** Define os erros do domínio de vídeos, a conexão compartilhada com o Redis e o produtor que publica um job por vídeo.

**Technical actions:**

1. Criar `src/videos/video.exceptions.ts` — exceções que estendem `DomainException` conforme `### Error Catalog` (o filtro global já as converte para `{ statusCode, error, message }`)
2. Criar `src/videos/videos.constants.ts` — nome da fila `video-processing`, nomes de job `process-video` e `sweep-abandoned-uploads`, opções `{ attempts: 3, backoff: { type: 'exponential', delay: 5000 } }`, limite `10737418240` bytes, parte de `67108864` bytes, TTLs `3600`/`900` s, limiar de abandono 24h e intervalo da varredura 1h (per `phase-03-videos/TD-01`, `phase-03-videos/TD-04`, `phase-03-videos/TD-08`, `phase-03-videos/TD-10`, `phase-03-videos/TD-12`)
3. Criar `src/queue/queue.module.ts` — `BullModule.forRootAsync` com `connection` e `prefix` vindos do namespace `queue`; importado pela API e pelo worker (per `phase-03-videos/TD-01`, `phase-03-videos/TD-11`)
4. Criar `src/videos/video-processing.producer.ts` — `VideoProcessingProducer` com `@InjectQueue('video-processing')`; `enqueueProcessing(videoId)` publica `process-video` com `{ videoId }`, `jobId: videoId` e as opções de retry (per `phase-03-videos/TD-10`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` | Unit: compilation test | `src/queue/queue.module.spec.ts` |
| `VideoProcessingProducer` | Integration: Redis real com prefixo de teste — um único job por `videoId`, opções de retry gravadas no job | `src/videos/video-processing.producer.integration-spec.ts` |

**Dependencies:** SI-03.2 — usa o namespace `queue`

**Acceptance criteria:**

- Chamar `enqueueProcessing` duas vezes para o mesmo vídeo resulta em um único job
- O job publicado tem `attempts: 3` e backoff exponencial de 5 s
- Os jobs dos testes ficam sob o prefixo `streamtube-test`, fora do alcance do worker do Compose

---

### SI-03.6 — Início do upload: pré-cadastro e URLs das partes

**Description:** Abre o upload: registra o vídeo como rascunho, cria o multipart no storage e entrega as URLs pré-assinadas das partes, sem que bytes passem pela API.

**Technical actions:**

1. Adicionar `findByUserId(userId)` em `src/channels/channels.service.ts` (a resolução do canal pertence ao módulo de canais)
2. Criar `src/videos/dto/initiate-upload.dto.ts` (`InitiateUploadDto`) e `src/videos/dto/presign-parts.dto.ts` (`PresignPartsDto`) conforme `#### Validation Rules`
3. Criar `src/videos/videos.service.ts` — `initiateUpload(userId, dto)`: recusa tamanho acima do limite, resolve o canal, gera o `id` (`randomUUID`) e o `storage_key` `videos/{id}/source`, cria o multipart, persiste o rascunho com `generateUrlId()` e até 5 tentativas em colisão de `url_id`, e aborta o multipart se a persistência falhar; `presignUploadParts(userId, urlId, partNumbers)` valida dono, estado e faixa das partes (per `phase-03-videos/TD-04`, `phase-03-videos/TD-07`, `phase-03-videos/TD-09`)
4. Criar `src/videos/videos.controller.ts` — `POST /videos` (201) e `POST /videos/:urlId/upload/parts` (200), com `@ApiTags('videos')`, `@ApiBearerAuth('access-token')` e respostas de erro via `ApiErrorEnvelope`
5. Criar `src/videos/videos.module.ts` (TypeORM `Video`, `StorageModule`, `QueueModule`, `BullModule.registerQueue`, `ChannelsModule`) e registrá-lo no `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` | Unit: limite de tamanho, colisão de `url_id`, abort em falha de persistência, validação de partes | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration: rascunho persistido no banco e multipart existente no storage | `src/videos/videos.service.integration-spec.ts` |
| `VideosController` + DTOs | E2E: `POST /videos` e `POST /videos/:urlId/upload/parts` | `test/videos.e2e-spec.ts` |
| `VideosModule` | Unit: compilation test | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.3, SI-03.4, SI-03.5

**Acceptance criteria:**

- `POST /videos` com corpo válido retorna `201` com `urlId`, `status: "draft"`, `partSize` e `partCount`, e cria a linha em `videos` com `status = 'draft'`
- `POST /videos` com `sizeBytes` acima de `10737418240` retorna `413` com `error: "VIDEO_TOO_LARGE"`; sem token, `401`; com `contentType` fora de `video/*`, `400` com `error: "VALIDATION_ERROR"`
- `POST /videos/:urlId/upload/parts` retorna uma URL por parte pedida e `expiresAt`; para vídeo de outro usuário, `404` com `error: "VIDEO_NOT_FOUND"`; parte acima de `partCount`, `400` com `error: "INVALID_PART_NUMBER"`

---

### SI-03.7 — Conclusão do upload e enfileiramento do processamento

**Description:** Fecha o upload multipart validando as partes no próprio storage, move o vídeo para `processing` e publica o job.

**Technical actions:**

1. Implementar `VideosService.completeUpload(userId, urlId)` — exige dono e `draft`; lista as partes no storage (sem confiar no cliente), exige as partes `1..partCount` e a soma igual a `size_bytes`; traduz `StorageUploadNotFoundError` para `UploadExpiredException`; completa o multipart, grava `status = 'processing'` e `upload_id = null` e chama `VideoProcessingProducer.enqueueProcessing` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-10`)
2. Adicionar `POST /videos/:urlId/upload/complete` (200) em `VideosController`, com documentação OpenAPI

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: partes faltando, tamanho divergente, upload expirado, estado inválido | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration: multipart real concluído e job publicado na fila de teste | `src/videos/videos.service.integration-spec.ts` |
| `POST /videos/:urlId/upload/complete` | E2E: fluxo iniciar → PUT pré-assinado → concluir | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.6

**Acceptance criteria:**

- Depois do `PUT` das partes nas URLs pré-assinadas, `POST /videos/:urlId/upload/complete` retorna `200` com `status: "processing"`; a linha muda para `processing` e existe exatamente um job `process-video` com o id do vídeo
- Concluir sem todas as partes retorna `409` com `error: "UPLOAD_INCOMPLETE"`
- Concluir um vídeo que não está em `draft` retorna `409` com `error: "VIDEO_NOT_UPLOADABLE"`

---

### SI-03.8 — Consulta, playback (streaming) e download

**Description:** Expõe os dados do vídeo ao dono e entrega URLs pré-assinadas de curta duração para reproduzir em streaming e baixar, com o storage servindo os bytes.

**Technical actions:**

1. Implementar `VideosService.getOwnedVideo(userId, urlId)` — 404 para inexistente ou de outro canal; resposta conforme `### API Contracts → GET /videos/:urlId`, com `thumbnailUrl` pré-assinada quando houver thumbnail (per `phase-03-videos/TD-09`)
2. Implementar `getPlaybackUrl` e `getDownloadUrl` — exigem `ready`; download assinado com `attachment` e o `original_filename` (per `phase-03-videos/TD-08`)
3. Adicionar `GET /videos/:urlId`, `GET /videos/:urlId/playback` e `GET /videos/:urlId/download` em `VideosController`, com documentação OpenAPI

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` (leitura) | Unit: dono vs. outro canal, `ready` vs. demais estados | `src/videos/videos.service.spec.ts` |
| `VideosService` (leitura) | Integration: URL de playback responde `206` a `Range`; URL de download traz `attachment` | `src/videos/videos.service.integration-spec.ts` |
| Endpoints de leitura | E2E: formas de resposta, 404 e 409 | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.6

**Acceptance criteria:**

- `GET /videos/:urlId` do dono retorna `200` com `urlId`, `title`, `status` e os campos de processamento; de outro usuário, `404`
- Para vídeo `ready`, `GET /videos/:urlId/playback` retorna `{ url, expiresAt }` e um `GET` em `url` com `Range: bytes=0-1023` responde `206 Partial Content`
- `GET /videos/:urlId/download` retorna `{ url, expiresAt }` e a URL responde com `Content-Disposition: attachment`
- Para vídeo que não está `ready`, playback e download retornam `409` com `error: "VIDEO_NOT_READY"`

---

### SI-03.9 — Sonda de mídia: duração, metadados e thumbnail com FFmpeg

**Description:** Isola a chamada aos binários `ffprobe`/`ffmpeg` do sistema num serviço pequeno e tipado.

**Technical actions:**

1. Criar `src/video-processing/media-probe.service.ts` — `probe(filePath)` chama `ffprobe -v error -print_format json -show_format -show_streams` via `execFile` (sem shell, com timeout) e devolve `{ durationSeconds, metadata }`; sem stream de vídeo, sem duração ou com saída diferente de 0 → `InvalidMediaError` (per `phase-03-videos/TD-06`)
2. No mesmo serviço — `extractThumbnail(filePath, atSeconds, outputPath)` com `ffmpeg -ss <t> -i <file> -frames:v 1 -vf scale='min(1280,iw)':-2 -q:v 3 <out.jpg>` e `thumbnailTimeFor(durationSeconds)` (10% da duração, 0 para clipes curtos)
3. Criar `src/video-processing/media.errors.ts` — `InvalidMediaError`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `MediaProbeService` | Unit: parsing do JSON do ffprobe, erros, cálculo do instante da thumbnail | `src/video-processing/media-probe.service.spec.ts` |
| `MediaProbeService` | Integration: FFmpeg real com clipe `testsrc` gerado no teste; arquivo inválido → `InvalidMediaError` | `src/video-processing/media-probe.service.integration-spec.ts` |

**Dependencies:** SI-03.1 — FFmpeg instalado na imagem

**Acceptance criteria:**

- Para um clipe de 2 s em 320x240, `probe` devolve duração ≈ 2 s, `width: 320`, `height: 240` e o codec de vídeo
- `extractThumbnail` gera um JPEG não vazio
- Um arquivo que não é vídeo resulta em `InvalidMediaError`

---

### SI-03.10 — Pipeline de processamento do vídeo

**Description:** Orquestra o processamento de um vídeo: baixa do storage, sonda, gera e sobe a thumbnail e grava o resultado no banco.

**Technical actions:**

1. Criar `src/video-processing/video-processing.service.ts` — `process(videoId)`: ignora vídeos fora de `processing` (idempotência); baixa o arquivo para um diretório temporário; `InvalidMediaError` vira `UnrecoverableError` (sem retentativa); gera a thumbnail, faz upload em `videos/{id}/thumbnail.jpg` e grava `status = 'ready'`, `duration_seconds`, `metadata`, `thumbnail_key`, `processed_at`; sempre remove o diretório temporário (per `phase-03-videos/TD-06`, `phase-03-videos/TD-10`)
2. No mesmo serviço — `markFailed(videoId, reason)` grava `failed` e `processing_error`, sem sobrescrever um vídeo já `ready`
3. Criar `src/video-processing/video-processing.module.ts` — TypeORM `Video`, `StorageModule`, `MediaProbeService`, `VideoProcessingService`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingService` | Unit: ignora estados ≠ `processing`, mídia inválida → `UnrecoverableError`, `markFailed` não sobrescreve `ready` | `src/video-processing/video-processing.service.spec.ts` |
| `VideoProcessingService` | Integration: banco + storage + FFmpeg reais — clipe gerado vira `ready` com duração, metadados e objeto de thumbnail | `src/video-processing/video-processing.service.integration-spec.ts` |

**Dependencies:** SI-03.3, SI-03.4, SI-03.9

**Acceptance criteria:**

- Um vídeo em `processing` com clipe válido no storage termina `ready`, com `duration_seconds`, `metadata` e `thumbnail_key` preenchidos e o JPEG presente no bucket
- Um arquivo que não é vídeo leva a `UnrecoverableError`; após `markFailed`, a linha fica `failed` com o motivo em `processing_error`

---

### SI-03.11 — Worker: entrypoint, consumidor da fila e serviço no Compose

**Description:** Sobe o worker como processo separado, com o mesmo código da API, consumindo a fila `video-processing`.

**Technical actions:**

1. Criar `src/database/typeorm-options.ts` — fábrica de opções do TypeORM a partir de `databaseConfig`, usada pelo `AppModule` e pelo `WorkerModule` (convenção herdada: parâmetros de conexão de uma única fonte)
2. Criar `src/worker/worker.module.ts` (mesmo `ConfigModule` validado, TypeORM, `QueueModule`, `BullModule.registerQueue`, `VideoProcessingModule`) e `src/main.worker.ts` (`NestFactory.createApplicationContext(WorkerModule)`, `enableShutdownHooks`) (per `phase-03-videos/TD-05`)
3. Criar `src/worker/video-processing.processor.ts` — `@Processor('video-processing')` estendendo `WorkerHost`; `process(job)` despacha por `job.name`; `@OnWorkerEvent('failed')` chama `markFailed` na última tentativa ou em `UnrecoverableError` (per `phase-03-videos/TD-10`, `library-refs.md` → `@nestjs/bullmq`)
4. Adicionar o script `start:worker` (`ts-node` com override para CommonJS, como o `seed`) e o serviço `worker` em `compose.yaml` (mesmo `build` e volume da API, `command: npm run start:worker`, `depends_on` `db`/`redis`/`minio` saudáveis, `restart: unless-stopped`) (per `phase-03-videos/TD-05`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingProcessor` | Unit: despacho por nome, falha intermediária vs. final | `src/worker/video-processing.processor.spec.ts` |
| `WorkerModule` | Integration: sobe o contexto do worker sobre banco/Redis/storage reais com prefixo de teste e processa um job real até `ready` | `src/worker/worker.module.integration-spec.ts` |

**Dependencies:** SI-03.5, SI-03.10

**Acceptance criteria:**

- `docker compose up -d` deixa `worker` em `running` e o log mostra o consumo da fila `video-processing`
- Um vídeo enviado pela API (SI-03.7) é processado pelo container `worker` até `ready`, sem intervenção
- Depois de 3 tentativas falhas, ou de mídia inválida, o vídeo termina `failed` com `processing_error`

---

### SI-03.12 — Varredura de uploads abandonados

**Description:** Dá estado final aos rascunhos nunca concluídos e libera o multipart no storage.

**Technical actions:**

1. Criar `src/video-processing/abandoned-upload-sweeper.service.ts` — `sweep(now)` busca rascunhos com `created_at` anterior a 24h, aborta o multipart (tolerando `NoSuchUpload`) e grava `status = 'failed'`, `processing_error = 'upload_abandoned'`, `upload_id = null`; devolve a contagem (per `phase-03-videos/TD-12`)
2. Despachar o job `sweep-abandoned-uploads` em `VideoProcessingProcessor`
3. Criar `src/worker/worker-scheduler.service.ts` — no `onApplicationBootstrap` do worker, `upsertJobScheduler('abandoned-upload-sweep', { every: 3600000 }, { name: 'sweep-abandoned-uploads', data: {} })` (idempotente) (per `phase-03-videos/TD-12`, `library-refs.md` → `bullmq`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `AbandonedUploadSweeperService` | Integration: rascunho antigo com multipart vivo vira `failed` e o multipart some; rascunho recente e vídeo `ready` ficam intactos | `src/video-processing/abandoned-upload-sweeper.service.integration-spec.ts` |
| `WorkerSchedulerService` | Integration: scheduler registrado na fila de teste e idempotente | `src/worker/worker-scheduler.service.integration-spec.ts` |

**Dependencies:** SI-03.11

**Acceptance criteria:**

- Um rascunho criado há mais de 24h termina `failed` com `processing_error = 'upload_abandoned'` e seu multipart deixa de existir no storage
- Rascunhos recentes não são tocados
- Reiniciar o worker não duplica o scheduler

---

### SI-03.13 — Documentação de IA e Definition of Done

**Description:** Deixa o `CLAUDE.md` coerente com o código entregue e fecha a fase pela Definition of Done.

**Technical actions:**

1. Adicionar a seção de vídeos em `nestjs-project/CLAUDE.md` — módulos (`videos`, `storage`, `queue`, `video-processing`, `worker`), endpoints, fluxo de upload, fila/worker, serviços do Compose, chaves de env, isolamento por `QUEUE_PREFIX` e FFmpeg
2. Atualizar o `CLAUDE.md` da raiz e `docs/diagrams/software-arch.mermaid` — a fila deixa de ser "TBD" e passa a "BullMQ + Redis" (per `phase-03-videos/TD-01`)
3. Rodar a Definition of Done: suíte completa, e2e, `npx tsc --noEmit` e `npm run lint`

**Tests:** _(empty — documentation + DoD gate; the full suite is the acceptance criterion)_

**Dependencies:** SI-03.6, SI-03.7, SI-03.8, SI-03.11, SI-03.12

**Acceptance criteria:**

- Todo arquivo, endpoint e variável citados no `CLAUDE.md` existem no código
- `npm test -- --runInBand`, `npm run test:e2e`, `npx tsc --noEmit` (código 0) e `npm run lint` passam

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| url_id | varchar(11) | unique, not null — 11-char base64url (per `phase-03-videos/TD-07`) |
| channel_id | uuid | FK → `channels.id`, not null, `ON DELETE CASCADE` |
| title | varchar(100) | not null |
| status | enum `videos_status_enum` (`draft`, `processing`, `ready`, `failed`) | not null, default `draft` (per `phase-03-videos/TD-10`) |
| original_filename | varchar(255) | not null |
| content_type | varchar(127) | not null |
| size_bytes | bigint | not null — declared size, ≤ 10 737 418 240 (per `phase-03-videos/TD-04`) |
| storage_key | varchar(255) | not null — `videos/{videoId}/source` (per `phase-03-videos/TD-02`) |
| upload_id | varchar(255) | nullable — S3 multipart `UploadId` while `draft`; null after completion or abandonment |
| thumbnail_key | varchar(255) | nullable — `videos/{videoId}/thumbnail.jpg` (per `phase-03-videos/TD-02`) |
| duration_seconds | numeric(12,3) | nullable — set when `ready` |
| metadata | jsonb | nullable — `{ formatName, bitRate, width, height, videoCodec, audioCodec, frameRate }` (per `phase-03-videos/TD-06`) |
| processing_error | text | nullable — failure reason; `upload_abandoned` for abandoned drafts (per `phase-03-videos/TD-12`) |
| processed_at | timestamp | nullable |
| created_at | timestamp | default now() |
| updated_at | timestamp | default now() |

**Relations:** `Channel` has many `Video` (one-to-many); `Video` belongs to `Channel`
**Indexes:** unique on `url_id`; on `channel_id`; on `(status, created_at)` for the abandoned-upload sweep

**Status lifecycle (per `phase-03-videos/TD-10`, `phase-03-videos/TD-12`):** `draft` → `processing` (upload completed) → `ready` | `failed`; `draft` → `failed` (`upload_abandoned` after 24h).

### API Contracts

Todos os endpoints exigem `Authorization: Bearer <access_token>` (guard JWT global, herdado da Fase 02) e respondem apenas ao dono do canal do vídeo (per `phase-03-videos/TD-09`). Erros seguem o envelope `{ statusCode, error, message }` (herdado de `phase-02-auth/TD-07`).

#### POST /videos (SI-03.6)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer access token

**Request body:**
- title: string, required — 1 a 100 caracteres
- filename: string, required — 1 a 255 caracteres
- contentType: string, required — deve começar com `video/`
- sizeBytes: integer, required — ≥ 1

**Response 201:**
- urlId: string — 11 caracteres
- status: `"draft"`
- partSize: integer — 67108864
- partCount: integer — `ceil(sizeBytes / partSize)`
- maxPartsPerRequest: integer — 100

**Error responses:**
- 400 VALIDATION_ERROR: corpo inválido
- 401 Unauthorized: sem token válido
- 413 VIDEO_TOO_LARGE: `sizeBytes` > 10737418240

---

#### POST /videos/:urlId/upload/parts (SI-03.6)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer access token

**Request body:**
- partNumbers: integer[], required — 1 a 100 itens, cada um ≥ 1

**Response 200:**
- parts: `{ partNumber: integer, url: string }[]` — URLs pré-assinadas de `UploadPart` (TTL 3600 s), assinadas com `STORAGE_PUBLIC_ENDPOINT` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-11`)
- expiresAt: string (ISO-8601)

**Error responses:**
- 400 VALIDATION_ERROR: corpo inválido
- 400 INVALID_PART_NUMBER: algum número > `partCount`
- 401 Unauthorized
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 409 VIDEO_NOT_UPLOADABLE: vídeo fora de `draft`

O cliente envia cada parte com `PUT <url>` direto ao storage; nenhum byte passa pela API.

---

#### POST /videos/:urlId/upload/complete (SI-03.7)

**Request headers:**
- Authorization: Bearer access token

**Request body:** none

**Response 200:**
- urlId: string
- status: `"processing"`

**Error responses:**
- 401 Unauthorized
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_UPLOADABLE: vídeo fora de `draft`
- 409 UPLOAD_INCOMPLETE: partes faltando ou soma diferente de `sizeBytes` (verificado por `ListParts` no storage)
- 409 UPLOAD_EXPIRED: o storage não tem mais o upload multipart

---

#### GET /videos/:urlId (SI-03.8)

**Request headers:**
- Authorization: Bearer access token

**Response 200:**
- urlId: string
- title: string
- status: `"draft" | "processing" | "ready" | "failed"`
- originalFilename: string
- contentType: string
- sizeBytes: integer
- durationSeconds: number | null
- metadata: object | null
- thumbnailUrl: string | null — URL pré-assinada (TTL 900 s) quando houver thumbnail
- processingError: string | null
- createdAt: string (ISO-8601)
- processedAt: string | null

**Error responses:**
- 401 Unauthorized
- 404 VIDEO_NOT_FOUND

---

#### GET /videos/:urlId/playback (SI-03.8)

**Request headers:**
- Authorization: Bearer access token

**Response 200:**
- url: string — `GET` pré-assinado do arquivo (TTL 900 s); o storage responde `206 Partial Content` a requisições com `Range` (per `phase-03-videos/TD-08`)
- expiresAt: string (ISO-8601)

**Error responses:**
- 401 Unauthorized
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY: vídeo fora de `ready`

---

#### GET /videos/:urlId/download (SI-03.8)

**Request headers:**
- Authorization: Bearer access token

**Response 200:**
- url: string — `GET` pré-assinado com `ResponseContentDisposition: attachment; filename="<originalFilename>"` (TTL 900 s) (per `phase-03-videos/TD-08`)
- expiresAt: string (ISO-8601)

**Error responses:**
- 401 Unauthorized
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY

---

#### Validation Rules — Videos

- `title`: required, string aparada, 1 a 100 caracteres
- `filename`: required, string, 1 a 255 caracteres
- `contentType`: required, casa com `^video\/[\w.+-]+$`
- `sizeBytes`: required, inteiro ≥ 1 (o limite superior gera `413 VIDEO_TOO_LARGE`, não `400`)
- `partNumbers`: required, array de 1 a 100 inteiros ≥ 1, sem repetição

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos | ✗ | ✓ (vídeo criado no próprio canal) | — |
| POST /videos/:urlId/upload/parts | ✗ | ✗ (404) | ✓ |
| POST /videos/:urlId/upload/complete | ✗ | ✗ (404) | ✓ |
| GET /videos/:urlId | ✗ | ✗ (404) | ✓ |
| GET /videos/:urlId/playback | ✗ | ✗ (404) | ✓ |
| GET /videos/:urlId/download | ✗ | ✗ (404) | ✓ |

Para quem não é dono, a resposta é `404`, não `403`, para não revelar a existência de vídeos não publicados (per `phase-03-videos/TD-09`).

### Error Catalog

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_TOO_LARGE | 413 | Início de upload com `sizeBytes` acima de 10 GiB |
| VIDEO_NOT_FOUND | 404 | `urlId` inexistente ou de outro canal |
| INVALID_PART_NUMBER | 400 | Pedido de URL para parte acima de `partCount` |
| VIDEO_NOT_UPLOADABLE | 409 | URLs de parte ou conclusão para vídeo fora de `draft` |
| UPLOAD_INCOMPLETE | 409 | Conclusão com partes faltando ou tamanho divergente do declarado |
| UPLOAD_EXPIRED | 409 | Conclusão de um multipart que o storage já descartou |
| VIDEO_NOT_READY | 409 | Playback ou download de vídeo fora de `ready` |

### Events/Messages

#### process-video

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideoProcessingProducer` (per `phase-03-videos/TD-01`)
**Consumer:** `VideoProcessingProcessor` no container `worker` (per `phase-03-videos/TD-05`)
**Trigger:** `POST /videos/:urlId/upload/complete` concluiu o multipart e moveu o vídeo para `processing`
**Delivery semantics:** at-least-once; `jobId = videoId` impede jobs duplicados e o consumidor ignora vídeos fora de `processing`; `attempts: 3` com backoff exponencial de 5 s; mídia inválida falha sem retentativa (`UnrecoverableError`); após a última falha o vídeo vira `failed` (per `phase-03-videos/TD-10`)

#### sweep-abandoned-uploads

**Payload:**

```json
{}
```

**Producer:** job scheduler `abandoned-upload-sweep` registrado no bootstrap do worker (`every: 3600000`) (per `phase-03-videos/TD-12`)
**Consumer:** `VideoProcessingProcessor` → `AbandonedUploadSweeperService`
**Trigger:** a cada hora
**Delivery semantics:** at-least-once; idempotente (rascunhos já tratados não voltam a `draft`; `NoSuchUpload` é tolerado)

**Fila:** `video-processing`, prefixo de chaves `QUEUE_PREFIX` (`streamtube`; `streamtube-test` no Jest) (per `phase-03-videos/TD-11`).

<!-- phase-a-complete -->

---

## Dependency Map

```
SI-03.1 (no deps)
├── SI-03.2
│   ├── SI-03.3
│   └── SI-03.5
├── SI-03.4
└── SI-03.9

SI-03.3 + SI-03.4 + SI-03.5
└── SI-03.6
    ├── SI-03.7
    └── SI-03.8

SI-03.3 + SI-03.4 + SI-03.9
└── SI-03.10

SI-03.5 + SI-03.10
└── SI-03.11
    └── SI-03.12

SI-03.6 + SI-03.7 + SI-03.8 + SI-03.11 + SI-03.12
└── SI-03.13
```

Linearized implementation order: SI-03.1 → SI-03.2, SI-03.4, SI-03.9 (parallel) → SI-03.3, SI-03.5 (parallel) → SI-03.6 → SI-03.7, SI-03.8, SI-03.10 (parallel) → SI-03.11 → SI-03.12 → SI-03.13

## Deliverables

- [ ] Upload de até 10GB funcional: multipart pré-assinado direto ao storage, sem bytes pela API
- [ ] Pré-cadastro automático do vídeo como rascunho (`draft`) ao iniciar o upload
- [ ] Processamento automático após o upload: duração e metadados via `ffprobe`
- [ ] Thumbnail gerada a partir de um frame (10% da duração) e salva no storage
- [ ] URL única por vídeo (`url_id` de 11 caracteres com restrição `UNIQUE`)
- [ ] Streaming funcionando: URL de playback com `Range` → `206 Partial Content`
- [ ] Download do vídeo com `Content-Disposition: attachment`
- [ ] Ciclo de status `draft → processing → ready | failed` refletido no banco, incluindo rascunhos abandonados
- [ ] `redis`, `minio` e `worker` subindo no `docker compose` junto com a API
- [ ] Migration `CreateVideos` gerada pelo CLI, entidade `Video` ligada a `Channel`
- [ ] `CLAUDE.md` (raiz e `nestjs-project/`) atualizados com a seção de vídeos
- [ ] All SI tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation check passes (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
