import type { JobsOptions } from 'bullmq';

/** Queue consumed by the video worker (phase-03-videos/TD-01, TD-05). */
export const VIDEO_PROCESSING_QUEUE = 'video-processing';

/** Job: process one uploaded video. Payload `{ videoId }`. */
export const PROCESS_VIDEO_JOB = 'process-video';

/** Job: reclaim abandoned drafts (phase-03-videos/TD-12). Payload `{}`. */
export const SWEEP_ABANDONED_UPLOADS_JOB = 'sweep-abandoned-uploads';

/** Scheduler id of the repeatable sweep. */
export const ABANDONED_UPLOAD_SWEEP_SCHEDULER = 'abandoned-upload-sweep';

/** Retry policy of PROCESS_VIDEO_JOB (phase-03-videos/TD-10). */
export const PROCESS_VIDEO_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
};

/** 10 GiB — maximum declared size (phase-03-videos/TD-04). */
export const MAX_VIDEO_SIZE_BYTES = 10 * 1024 ** 3;

/** 64 MiB — multipart part size; 10 GiB → 160 parts (phase-03-videos/TD-04). */
export const UPLOAD_PART_SIZE_BYTES = 64 * 1024 ** 2;

/** Maximum part URLs returned by one presign request. */
export const MAX_PARTS_PER_REQUEST = 100;

/** TTL of presigned UploadPart URLs (phase-03-videos/TD-04). */
export const UPLOAD_PART_URL_TTL_SECONDS = 3600;

/** TTL of presigned playback/download/thumbnail URLs (phase-03-videos/TD-08). */
export const VIDEO_URL_TTL_SECONDS = 900;

/** Drafts older than this are abandoned (phase-03-videos/TD-12). */
export const ABANDONED_UPLOAD_AFTER_MS = 24 * 60 * 60 * 1000;

/** Interval of the abandoned-upload sweep (phase-03-videos/TD-12). */
export const ABANDONED_UPLOAD_SWEEP_EVERY_MS = 60 * 60 * 1000;

/** Storage key of a video's uploaded file (phase-03-videos/TD-02). */
export const sourceKeyFor = (videoId: string): string =>
  `videos/${videoId}/source`;

/** Storage key of a video's generated thumbnail (phase-03-videos/TD-02). */
export const thumbnailKeyFor = (videoId: string): string =>
  `videos/${videoId}/thumbnail.jpg`;
