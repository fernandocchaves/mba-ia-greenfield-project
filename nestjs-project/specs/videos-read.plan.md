---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.8
target_file: test/videos-read.e2e-spec.ts
---

# Video Read, Playback and Download Endpoints Test Plan

## Application Overview

`GET /videos/:urlId` returns the video and its processing state to the owner of its channel (others get 404). `GET /videos/:urlId/playback` and `GET /videos/:urlId/download` return short-lived presigned URLs (`{ url, expiresAt }`): object storage answers `Range` with `206 Partial Content` for streaming and serves downloads as `attachment` with the original filename (phase-03-videos/TD-08, TD-09). Both require the video to be `ready`.

## Test Scenarios

### 1. GET /videos/:urlId

**Setup:** `beforeEach` runs `cleanAllTables` and obliterates the test-prefixed queue; `seedReadyVideo` writes a 2 KiB object to storage and a `ready` row (duration 1.5 s, no thumbnail) for the logged-in owner, so the read endpoints are tested without depending on the worker.

#### 1.1. get-video-returns-details-to-owner

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-15T04:21:32Z

**Steps:**
  1. GET /videos/:urlId as the owner
    - expect: HTTP 200
    - expect: body includes `urlId`, `title: "Ready"`, `status: "ready"`, `sizeBytes: 2048`, `durationSeconds: 1.5`, `thumbnailUrl: null`, `processingError: null`

#### 1.2. get-video-hides-videos-of-other-users

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-15T04:21:32Z

**Steps:**
  1. GET /videos/:urlId as a different user
    - expect: HTTP 404 with `error: "VIDEO_NOT_FOUND"`

### 2. GET /videos/:urlId/playback

**Setup:** same as group 1.

#### 2.1. playback-url-streams-with-partial-content

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-15T04:21:32Z

**Steps:**
  1. GET /videos/:urlId/playback as the owner
    - expect: HTTP 200 with `{ url, expiresAt }`, `expiresAt` in the future
  2. GET `url` with header `Range: bytes=0-1023`
    - expect: storage answers 206 with `Content-Range: bytes 0-1023/2048` and exactly 1024 bytes

### 3. GET /videos/:urlId/download

**Setup:** same as group 1.

#### 3.1. download-url-serves-attachment

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-15T04:21:32Z

**Steps:**
  1. GET /videos/:urlId/download as the owner
    - expect: HTTP 200 with `{ url, expiresAt }`, `expiresAt` in the future
  2. GET `url`
    - expect: storage answers 200 with `Content-Disposition: attachment; filename="ready.mp4"`

### 4. Not ready

**Setup:** same as group 1, but the video is a fresh `draft` created with `POST /videos`.

#### 4.1. playback-rejects-video-not-ready

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-15T04:21:32Z

**Steps:**
  1. GET /videos/:urlId/playback on a draft
    - expect: HTTP 409 with `error: "VIDEO_NOT_READY"`

#### 4.2. download-rejects-video-not-ready

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-15T04:21:32Z

**Steps:**
  1. GET /videos/:urlId/download on a draft
    - expect: HTTP 409 with `error: "VIDEO_NOT_READY"`
