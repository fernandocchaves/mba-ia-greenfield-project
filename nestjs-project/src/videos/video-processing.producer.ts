import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  PROCESS_VIDEO_JOB,
  PROCESS_VIDEO_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
} from './videos.constants';

export interface ProcessVideoJobData {
  videoId: string;
}

/** Publishes processing jobs (Events/Messages → `process-video`). */
@Injectable()
export class VideoProcessingProducer {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * `jobId = videoId` makes the enqueue idempotent: BullMQ ignores a second
   * job with an existing id (phase-03-videos/TD-10).
   */
  async enqueueProcessing(videoId: string): Promise<void> {
    const data: ProcessVideoJobData = { videoId };
    await this.queue.add(PROCESS_VIDEO_JOB, data, {
      ...PROCESS_VIDEO_JOB_OPTIONS,
      jobId: videoId,
    });
  }
}
