---
libs:
  "bullmq":
    version: "^6.7.6"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-11-14T19:56:18-03:00"
  "@nestjs/bullmq":
    version: "^12.0.2"
    context7_id: "/websites/nestjs"
    fetched_at: "2026-11-14T19:56:18-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1169.0"
    context7_id: "/websites/aws_amazon_awsjavascriptsdk_v3"
    fetched_at: "2026-11-14T19:56:18-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1169.0"
    context7_id: "/websites/aws_amazon_sdk-for-javascript_v3_developer-guide"
    fetched_at: "2026-11-14T19:56:18-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-14T19:55:10-03:00"
---

# Library References — Phase 03 (Videos)

Distilled from Context7 (library IDs in the frontmatter) and the official pages it cites, restricted to the surfaces the phase-03 TDs use. Compatibility with the installed stack (`@nestjs/common`/`core` 11.1.16, CommonJS build, Node 25 in `Dockerfile.dev`): `@nestjs/bullmq@12.0.2` peers are `@nestjs/common ^10 || ^11 || ^12` and `bullmq ^3 || ^4 || ^5 || ^6`, and both AWS SDK packages require Node ≥ 20.

### @nestjs/bullmq

Used by phase-03-videos/TD-01, TD-05, TD-10, TD-12.

- **Root connection:** `BullModule.forRootAsync({ imports: [ConfigModule], inject: [queueConfig.KEY], useFactory: (cfg) => ({ connection: { host: cfg.host, port: cfg.port } }) })`. Use the Compose service name (`redis`) as the host.
- **Queue registration:** `BullModule.registerQueue({ name: 'video-processing' })`. The name is the injection token.
- **Producer:** `constructor(@InjectQueue('video-processing') private readonly queue: Queue)` (with `Queue` imported from `bullmq`).
- **Consumer:** `@Processor('video-processing') class X extends WorkerHost { async process(job: Job): Promise<unknown> { … } }`. The class must be registered as a provider in the module that the **worker** entrypoint boots, and the return value is stored on the job. BullMQ has no per-name `@Process()`, so dispatch on `job.name` inside `process()` (needed because TD-12 adds a second job type on the same queue).
- **Worker events:** `@OnWorkerEvent('failed')` inside the `@Processor` class receives `(job, error)` for each failed attempt. Check `job.attemptsMade >= (job.opts.attempts ?? 1)` to detect the final failure (TD-10).

### bullmq

Used by phase-03-videos/TD-01, TD-10, TD-12.

- **Retries:** `queue.add(name, data, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } })`.
- **Stop retrying:** throw `new UnrecoverableError(message)` (exported by `bullmq`) inside the processor. The job moves to `failed` immediately, overriding `attempts`. Use it for files ffprobe cannot read (TD-10).
- **One job per video:** `{ jobId: videoId }`. "The id must be unique within the queue; otherwise the job is ignored". Avoid `:` and digit-only ids, which a UUID satisfies. Caveat: if `removeOnComplete`/`removeOnFail` removes the job, the same id can be added again.
- **Repeatable sweep (TD-12):** `queue.upsertJobScheduler('abandoned-upload-sweep', { every: 3_600_000 }, { name: 'sweep-abandoned-uploads', data: {} })` is idempotent per scheduler id, so it is safe to call on every worker boot. `every` and `pattern` are mutually exclusive.
- **Inspection in tests:** `queue.getJob(id)` and `job.getState()`, or `queue.getJobs(['waiting','active','delayed','completed','failed'])`. Assertions must not assume a job stays `waiting`, because the Compose `worker` may already be consuming the queue.

### @aws-sdk/client-s3

Used by phase-03-videos/TD-02, TD-04, TD-12.

- **Client for an S3-compatible endpoint:** `new S3Client({ endpoint, region, credentials: { accessKeyId, secretAccessKey }, forcePathStyle: true, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' })`.
  - `forcePathStyle: true` is required for MinIO-family servers (`http://minio:9000/<bucket>/<key>`).
  - **Checksum defaults (since v3.729.0):** the SDK computes a CRC32 checksum for every upload by default (`WHEN_SUPPORTED`) and adds `x-amz-checksum-crc32` / `x-amz-sdk-checksum-algorithm` to requests **and to presigned URLs**. Third-party S3 servers reject or mis-handle these, and a client `PUT`ting raw bytes to a presigned `UploadPart` URL cannot satisfy a checksum it never computed. `WHEN_REQUIRED` for both settings is the AWS-documented opt-out (aws/aws-sdk-js-v3#6810). Real AWS S3 does not require CRC32 on these operations.
- **Multipart (TD-04):** `CreateMultipartUploadCommand({ Bucket, Key, ContentType })` returns `UploadId`. `UploadPartCommand({ Bucket, Key, UploadId, PartNumber })` is presigned per part, never sent by the server. `ListPartsCommand({ Bucket, Key, UploadId })` returns at most 1000 parts per page, so paginate with `PartNumberMarker`/`IsTruncated` (10 GiB / 64 MiB = 160 parts fits one page, but write the loop anyway). Then `CompleteMultipartUploadCommand({ …, MultipartUpload: { Parts: [{ PartNumber, ETag }] } })` with the parts in ascending order, and `AbortMultipartUploadCommand` for cleanup.
- **S3 limits (AWS docs, "multipart upload limits"):** part size 5 MiB to 5 GiB (the last part has no minimum), part numbers 1 to 10 000, maximum object size 48.8 TiB.
- **Errors:** a missing upload surfaces as an error named `NoSuchUpload`, and a missing object as `NoSuchKey`/`NotFound`. Match on `error.name`. TD-12 treats `NoSuchUpload` on abort as success, because the storage may already have purged the upload.
- **Bucket bootstrap:** `HeadBucketCommand`, then `CreateBucketCommand` when missing. Do **not** send `PutBucketLifecycleConfiguration` with `AbortIncompleteMultipartUpload`, which MinIO-family servers reject with `400` (see TD-12).
- **Worker I/O:** `GetObjectCommand` returns `Body` as a Node `Readable` (`sdkStreamMixin`), so pipe it to a temp file for FFmpeg instead of buffering 10 GB. `PutObjectCommand({ Body: Buffer, ContentType: 'image/jpeg' })` uploads the thumbnail.

### @aws-sdk/s3-request-presigner

Used by phase-03-videos/TD-04, TD-08, TD-11.

- `getSignedUrl(client, command, { expiresIn })`, where `expiresIn` is in seconds: 3600 for upload parts (TD-04) and 900 for playback/download (TD-08).
- **Signing client (TD-11):** sign with an `S3Client` whose `endpoint` is `STORAGE_PUBLIC_ENDPOINT`. The host is part of the SigV4 signature, so a URL signed for `minio:9000` cannot be rewritten to `localhost:9000` afterwards.
- **Download as attachment (TD-08):** `new GetObjectCommand({ Bucket, Key, ResponseContentDisposition: 'attachment; filename="<name>"' })` makes the storage return `Content-Disposition: attachment`. For inline playback, omit it (optionally set `ResponseContentType`).
- The storage, not the API, answers `Range: bytes=…` requests on the presigned `GET` with `206 Partial Content` + `Content-Range`, which is the streaming mechanism of TD-08.
