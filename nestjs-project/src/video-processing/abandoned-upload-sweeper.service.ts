import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { ABANDONED_UPLOAD_AFTER_MS } from '../videos/videos.constants';

/** `processing_error` recorded for drafts whose upload never completed (TD-12). */
export const UPLOAD_ABANDONED_REASON = 'upload_abandoned';

/**
 * Gives abandoned drafts a terminal state and frees their multipart data
 * (phase-03-videos/TD-12). Portable: MinIO-family storage rejects the
 * `AbortIncompleteMultipartUpload` lifecycle rule, AWS needs one — this works
 * on both.
 */
@Injectable()
export class AbandonedUploadSweeperService {
  private readonly logger = new Logger(AbandonedUploadSweeperService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {}

  /** Returns how many drafts were marked abandoned. */
  async sweep(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - ABANDONED_UPLOAD_AFTER_MS);
    const stale = await this.videoRepository.find({
      where: { status: VideoStatus.DRAFT, created_at: LessThan(cutoff) },
    });

    let swept = 0;
    for (const video of stale) {
      if (video.upload_id) {
        // Already purged by the storage's own stale-upload expiry is fine.
        await this.storageService.abortMultipartUpload(
          video.storage_key,
          video.upload_id,
        );
      }
      // Conditional update: a draft completed meanwhile is left alone.
      const result = await this.videoRepository.update(
        { id: video.id, status: VideoStatus.DRAFT },
        {
          status: VideoStatus.FAILED,
          processing_error: UPLOAD_ABANDONED_REASON,
          upload_id: null,
        },
      );
      swept += result.affected ?? 0;
    }
    if (swept > 0)
      this.logger.log(`Marked ${swept} abandoned upload(s) failed`);
    return swept;
  }
}
