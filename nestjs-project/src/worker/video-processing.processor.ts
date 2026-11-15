import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { AbandonedUploadSweeperService } from '../video-processing/abandoned-upload-sweeper.service';
import { VideoProcessingService } from '../video-processing/video-processing.service';
import type { ProcessVideoJobData } from '../videos/video-processing.producer';
import {
  PROCESS_VIDEO_JOB,
  SWEEP_ABANDONED_UPLOADS_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../videos/videos.constants';

/** True when this failure is final: no retries left, or the error forbids them. */
export function isFinalFailure(job: Job, error: Error): boolean {
  return (
    error instanceof UnrecoverableError ||
    error.name === 'UnrecoverableError' ||
    job.attemptsMade >= (job.opts.attempts ?? 1)
  );
}

/**
 * Consumer of the `video-processing` queue, running only in the worker process
 * (phase-03-videos/TD-05). BullMQ has no per-name handlers, so it dispatches on
 * `job.name` (see library-refs.md → @nestjs/bullmq).
 */
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    private readonly processingService: VideoProcessingService,
    private readonly sweeper: AbandonedUploadSweeperService,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case PROCESS_VIDEO_JOB:
        return this.processingService.process(
          (job.data as ProcessVideoJobData).videoId,
        );
      case SWEEP_ABANDONED_UPLOADS_JOB:
        return this.sweeper.sweep(new Date());
      default:
        throw new UnrecoverableError(`Unknown job name "${job.name}"`);
    }
  }

  /** After the last attempt (or an unrecoverable error) the video becomes `failed` (TD-10). */
  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, error: Error): Promise<void> {
    if (!job || job.name !== PROCESS_VIDEO_JOB) return;
    if (!isFinalFailure(job, error)) {
      this.logger.warn(
        `Video job ${job.id} failed (attempt ${job.attemptsMade}), will retry: ${error.message}`,
      );
      return;
    }
    const { videoId } = job.data as ProcessVideoJobData;
    this.logger.error(`Video ${videoId} failed permanently: ${error.message}`);
    await this.processingService.markFailed(videoId, error.message);
  }
}
