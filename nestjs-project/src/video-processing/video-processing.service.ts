import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { UnrecoverableError } from 'bullmq';
import { Not, Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { thumbnailKeyFor } from '../videos/videos.constants';
import { InvalidMediaError } from './media.errors';
import { MediaProbeService, thumbnailTimeFor } from './media-probe.service';

export type ProcessOutcome = 'processed' | 'skipped';

/**
 * Processes one uploaded video in the worker (phase-03-videos/TD-05, TD-06, TD-10):
 * download → probe → thumbnail → `ready`.
 */
@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly mediaProbe: MediaProbeService,
  ) {}

  /**
   * Idempotent: anything not in `processing` (already ready/failed, or still a
   * draft) is skipped, so at-least-once delivery cannot double-process.
   * An unreadable file raises `UnrecoverableError` so the queue does not retry.
   */
  async process(videoId: string): Promise<ProcessOutcome> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video || video.status !== VideoStatus.PROCESSING) {
      this.logger.warn(`Skipping video ${videoId}: not in processing`);
      return 'skipped';
    }

    const workDir = await mkdtemp(join(tmpdir(), `video-${videoId}-`));
    try {
      const sourcePath = join(workDir, 'source');
      await this.storageService.downloadToFile(video.storage_key, sourcePath);

      let probe: Awaited<ReturnType<MediaProbeService['probe']>>;
      try {
        probe = await this.mediaProbe.probe(sourcePath);
      } catch (error) {
        if (error instanceof InvalidMediaError) {
          throw new UnrecoverableError(error.message);
        }
        throw error;
      }

      const thumbnailPath = join(workDir, 'thumbnail.jpg');
      await this.mediaProbe.extractThumbnail(
        sourcePath,
        thumbnailTimeFor(probe.durationSeconds),
        thumbnailPath,
      );
      const thumbnailKey = thumbnailKeyFor(video.id);
      await this.storageService.putObject(
        thumbnailKey,
        await readFile(thumbnailPath),
        'image/jpeg',
      );

      await this.videoRepository.update(
        { id: video.id, status: VideoStatus.PROCESSING },
        {
          status: VideoStatus.READY,
          duration_seconds: probe.durationSeconds,
          metadata: probe.metadata,
          thumbnail_key: thumbnailKey,
          processing_error: null,
          processed_at: new Date(),
        },
      );
      this.logger.log(`Video ${video.id} ready (${probe.durationSeconds}s)`);
      return 'processed';
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /** Marks the video `failed` unless it already reached `ready` (TD-10). */
  async markFailed(videoId: string, reason: string): Promise<void> {
    await this.videoRepository.update(
      { id: videoId, status: Not(VideoStatus.READY) },
      { status: VideoStatus.FAILED, processing_error: reason },
    );
  }
}
