---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: test/videos-upload-complete.e2e-spec.ts
---

# Video Upload Completion Endpoint Test Plan

## Application Overview

`POST /videos/:urlId/upload/complete` closes the multipart upload after verifying the parts in storage itself (never trusting client ETags), moves the video to `processing` and publishes one idempotent `process-video` job (`jobId = videoId`) for the worker (phase-03-videos/TD-04, TD-10).

## Test Scenarios

### 1. POST /videos/:urlId/upload/complete

**Setup:** `beforeEach` runs `cleanAllTables` and obliterates the test-prefixed `video-processing` queue (`QUEUE_PREFIX=streamtube-test`, so the Compose worker never consumes these jobs); each scenario logs in a confirmed user and creates a 12-byte draft with `POST /videos`; `uploadSinglePart` presigns part 1 and PUTs the bytes straight to storage.

#### 1.1. complete-upload-marks-processing-and-enqueues-once

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-15T04:21:32Z

**Steps:**
  1. PUT the 12 bytes to the presigned URL of part 1
    - expect: storage answers 200
  2. POST /videos/:urlId/upload/complete as the owner
    - expect: HTTP 200 with body `{ urlId, status: "processing" }`
    - expect: the `videos` row has `status = 'processing'`
    - expect: exactly one job with id = video id exists in the queue (looked up in every state)

#### 1.2. complete-upload-rejects-missing-parts

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-15T04:21:32Z

**Steps:**
  1. POST /videos/:urlId/upload/complete without uploading any part
    - expect: HTTP 409 with `error: "UPLOAD_INCOMPLETE"`
    - expect: the row stays `draft`

#### 1.3. complete-upload-rejects-non-draft

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-15T04:21:32Z

**Steps:**
  1. Upload part 1 and complete once
    - expect: HTTP 200
  2. POST /videos/:urlId/upload/complete again
    - expect: HTTP 409 with `error: "VIDEO_NOT_UPLOADABLE"`
