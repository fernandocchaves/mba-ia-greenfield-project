import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  ABANDONED_UPLOAD_SWEEP_EVERY_MS,
  ABANDONED_UPLOAD_SWEEP_SCHEDULER,
  SWEEP_ABANDONED_UPLOADS_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../videos/videos.constants';

/**
 * Registers the hourly abandoned-upload sweep when the worker boots
 * (phase-03-videos/TD-12). `upsertJobScheduler` is idempotent per scheduler id,
 * so restarts and multiple workers never duplicate it.
 */
@Injectable()
export class WorkerSchedulerService implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE) private readonly queue: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      ABANDONED_UPLOAD_SWEEP_SCHEDULER,
      { every: ABANDONED_UPLOAD_SWEEP_EVERY_MS },
      { name: SWEEP_ABANDONED_UPLOADS_JOB, data: {} },
    );
  }
}
