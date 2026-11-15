---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: test/videos-upload.e2e-spec.ts
---

# Video Upload Initiation Endpoints Test Plan

## Application Overview

`POST /videos` pre-registers a video as a `draft` in the caller's channel and opens an S3 multipart upload; `POST /videos/:urlId/upload/parts` returns presigned `UploadPart` URLs so the client sends the file straight to object storage. Video bytes never pass through the API, which is what makes 10 GiB uploads viable (phase-03-videos/TD-04). Only the owner of the channel can act on a video (TD-09).

## Test Scenarios

### 1. POST /videos

**Setup:** `beforeEach` runs `cleanAllTables` and obliterates the test-prefixed `video-processing` queue; `createVideoTestApp()` boots `AppModule` with the `main.ts` pipes/filters; `createUserAndLogin` creates a confirmed user + channel and logs in via `/auth/login`.

#### 1.1. initiate-upload-creates-draft

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-15T04:21:32Z

**Steps:**
  1. POST /videos with bearer token and body `{ title: "My first video", filename: "first.mp4", contentType: "video/mp4", sizeBytes: 12 }`
    - expect: HTTP 201
    - expect: body equals `{ urlId: <11 chars base64url>, status: "draft", partSize: 67108864, partCount: 1, maxPartsPerRequest: 100 }`
    - expect: a `videos` row with that `url_id` exists with `status = 'draft'` and the given title

#### 1.2. initiate-upload-accepts-exactly-10-gib

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-15T04:21:32Z

**Steps:**
  1. POST /videos with `sizeBytes: 10737418240`
    - expect: HTTP 201
    - expect: `partCount` is 160

#### 1.3. initiate-upload-rejects-above-10-gib

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-15T04:21:32Z

**Steps:**
  1. POST /videos with `sizeBytes: 10737418241`
    - expect: HTTP 413 with `error: "VIDEO_TOO_LARGE"`
    - expect: no row in `videos`

#### 1.4. initiate-upload-requires-token

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-15T04:21:32Z

**Steps:**
  1. POST /videos with a valid body and no Authorization header
    - expect: HTTP 401

#### 1.5. initiate-upload-rejects-non-video-content-type

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-15T04:21:32Z

**Steps:**
  1. POST /videos with `contentType: "application/pdf"`
    - expect: HTTP 400 with `error: "VALIDATION_ERROR"` (proves `ValidationPipe` wiring on `InitiateUploadDto`)

### 2. POST /videos/:urlId/upload/parts

**Setup:** same as group 1; each scenario first creates a draft with `POST /videos` (`sizeBytes: 12` → 1 part).

#### 2.1. presign-parts-returns-one-url-per-part

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-15T04:21:32Z

**Steps:**
  1. POST /videos/:urlId/upload/parts as the owner with `{ partNumbers: [1] }`
    - expect: HTTP 200
    - expect: `parts` has exactly one entry with `partNumber: 1` and a URL containing `X-Amz-Signature`
    - expect: `expiresAt` is an ISO date in the future

#### 2.2. presign-parts-hides-videos-of-other-users

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-15T04:21:32Z

**Steps:**
  1. User A creates a draft; user B calls POST /videos/:urlId/upload/parts with `{ partNumbers: [1] }`
    - expect: HTTP 404 with `error: "VIDEO_NOT_FOUND"`

#### 2.3. presign-parts-rejects-part-beyond-part-count

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-15T04:21:32Z

**Steps:**
  1. POST /videos/:urlId/upload/parts as the owner with `{ partNumbers: [2] }` on a 1-part draft
    - expect: HTTP 400 with `error: "INVALID_PART_NUMBER"`
