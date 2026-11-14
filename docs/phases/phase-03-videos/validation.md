---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 12
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-14T19:51:19-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-14T19:07:05-03:00"
issues:
  - id: OQ-1
    status: open
    summary: "TD-01 pending — Message Queue Technology"
  - id: OQ-2
    status: open
    summary: "TD-02 pending — Object Storage Client and Key Layout"
  - id: OQ-3
    status: open
    summary: "TD-03 pending — Local S3-Compatible Storage Container Image"
  - id: OQ-4
    status: open
    summary: "TD-04 pending — Large-File (10 GB) Upload Strategy"
  - id: OQ-5
    status: open
    summary: "TD-05 pending — Worker Deployment Model"
  - id: OQ-6
    status: open
    summary: "TD-06 pending — Media Probing and Thumbnail Tooling"
  - id: OQ-7
    status: open
    summary: "TD-07 pending — Unique Video URL Identifier"
  - id: OQ-8
    status: open
    summary: "TD-08 pending — Playback (Streaming) and Download Delivery"
  - id: OQ-9
    status: open
    summary: "TD-09 pending — Access Policy for Playback and Download in This Phase"
  - id: OQ-10
    status: open
    summary: "TD-10 pending — Video Status Lifecycle and Processing-Failure Handling"
  - id: MD-1
    status: open
    summary: "Canonical storage/queue env-var key set (internal vs public endpoint) undecided"
  - id: MD-2
    status: open
    summary: "No cleanup policy for abandoned multipart uploads and stale drafts"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

- **MD-1** — The phase introduces two infrastructure integrations (object storage and queue broker) read by two processes (API and worker) and validated by the Joi schema. No TD fixes the canonical environment-variable key set. TD-08 (phase-03-videos/TD-08) says presigned URLs need "a public storage endpoint setting (`STORAGE_PUBLIC_ENDPOINT`) distinct from the internal `minio:9000`". TD-04 (phase-03-videos/TD-04) also hands presigned `UploadPart` URLs to clients but does not say which host signs them. A presigned URL's signature covers the host, so it cannot be rewritten after signing. This is a cross-component contract (`src/config/env.validation.ts` + `compose.yaml` + `.env.example` + both entrypoints), per the research skill's "canonical set of environment variable keys" rule. Explicit choice: decide the key set (storage internal endpoint, public/presign endpoint, credentials, region, bucket, queue host/port) and whether *every* presigned URL (TD-04 parts and TD-08 playback/download) uses the public endpoint.
- **MD-2** — Capability "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance" (phase-03-videos/TD-04): the TD's own Cons state that "abandoned uploads leave incomplete multipart data, which needs a cleanup policy (storage lifecycle rule or abort on failure)", but no TD decides that policy. Without it, incomplete parts of up to 10 GB accumulate in storage indefinitely, and the draft rows created by "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload" have no defined end state. Explicit choice: decide how incomplete multipart uploads are reclaimed (bucket lifecycle rule, explicit abort endpoint, scheduled sweep) and what happens to the corresponding draft rows in this phase.

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

- **OQ-1** — TD-01 pending — Message Queue Technology. Resolution: fill the **Decision:** field of TD-01 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate 03.
- **OQ-2** — TD-02 pending — Object Storage Client and Key Layout. Resolution: fill the **Decision:** field of TD-02 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate 03.
- **OQ-3** — TD-03 pending — Local S3-Compatible Storage Container Image. Resolution: fill the **Decision:** field of TD-03 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate 03.
- **OQ-4** — TD-04 pending — Large-File (10 GB) Upload Strategy. Resolution: fill the **Decision:** field of TD-04 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate 03.
- **OQ-5** — TD-05 pending — Worker Deployment Model. Resolution: fill the **Decision:** field of TD-05 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate 03.
- **OQ-6** — TD-06 pending — Media Probing and Thumbnail Tooling. Resolution: fill the **Decision:** field of TD-06 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate 03.
- **OQ-7** — TD-07 pending — Unique Video URL Identifier. Resolution: fill the **Decision:** field of TD-07 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate 03.
- **OQ-8** — TD-08 pending — Playback (Streaming) and Download Delivery. Resolution: fill the **Decision:** field of TD-08 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate 03.
- **OQ-9** — TD-09 pending — Access Policy for Playback and Download in This Phase. Resolution: fill the **Decision:** field of TD-09 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate 03.
- **OQ-10** — TD-10 pending — Video Status Lifecycle and Processing-Failure Handling. Resolution: fill the **Decision:** field of TD-10 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate 03.

### UI Coverage Gaps

_None._

## Resolved Issues

_No issues resolved yet._
