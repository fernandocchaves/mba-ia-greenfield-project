import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { StorageUploadNotFoundError } from '../storage/storage.errors';
import { StorageService, UploadedPart } from '../storage/storage.service';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { generateUrlId } from './url-id.util';
import { VideoProcessingProducer } from './video-processing.producer';
import {
  InvalidPartNumberException,
  UploadExpiredException,
  UploadIncompleteException,
  VideoNotFoundException,
  VideoNotUploadableException,
  VideoTooLargeException,
} from './video.exceptions';
import {
  MAX_PARTS_PER_REQUEST,
  MAX_VIDEO_SIZE_BYTES,
  UPLOAD_PART_SIZE_BYTES,
  UPLOAD_PART_URL_TTL_SECONDS,
  sourceKeyFor,
} from './videos.constants';
import type {
  CompleteUploadResult,
  InitiateUploadResult,
  PresignedPartsResult,
} from './videos.types';

const PG_UNIQUE_VIOLATION = '23505';
const URL_ID_MAX_ATTEMPTS = 5;

function isUrlIdCollision(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const e = error as QueryFailedError & { code?: string; detail?: string };
  return e.code === PG_UNIQUE_VIOLATION && !!e.detail?.includes('url_id');
}

/** Throws when parts 1..N are not all present or their sizes don't add up. */
function assertUploadComplete(parts: UploadedPart[], sizeBytes: number): void {
  const expected = partCountFor(sizeBytes);
  const numbers = new Set(parts.map((p) => p.partNumber));
  const missing: number[] = [];
  for (let n = 1; n <= expected; n++) {
    if (!numbers.has(n)) missing.push(n);
  }
  if (missing.length > 0) {
    throw new UploadIncompleteException(
      `missing part(s) ${missing.slice(0, 10).join(', ')}`,
    );
  }
  if (parts.length !== expected) {
    throw new UploadIncompleteException(
      `expected ${expected} part(s), found ${parts.length}`,
    );
  }
  const total = parts.reduce((sum, p) => sum + p.size, 0);
  if (total !== sizeBytes) {
    throw new UploadIncompleteException(
      `uploaded ${total} bytes, declared ${sizeBytes}`,
    );
  }
}

export function partCountFor(sizeBytes: number): number {
  return Math.ceil(sizeBytes / UPLOAD_PART_SIZE_BYTES);
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    private readonly processingProducer: VideoProcessingProducer,
  ) {}

  /**
   * Pre-registers the video as a draft and opens an S3 multipart upload; the
   * client then uploads parts straight to storage (phase-03-videos/TD-04).
   */
  async initiateUpload(
    userId: string,
    dto: InitiateUploadDto,
  ): Promise<InitiateUploadResult> {
    if (dto.sizeBytes > MAX_VIDEO_SIZE_BYTES) {
      throw new VideoTooLargeException(MAX_VIDEO_SIZE_BYTES);
    }
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new Error(`User ${userId} has no channel`);
    }

    const id = randomUUID();
    const storageKey = sourceKeyFor(id);
    const uploadId = await this.storageService.createMultipartUpload(
      storageKey,
      dto.contentType,
    );

    let video: Video;
    try {
      video = await this.insertWithUniqueUrlId({
        id,
        channel_id: channel.id,
        title: dto.title,
        status: VideoStatus.DRAFT,
        original_filename: dto.filename,
        content_type: dto.contentType,
        size_bytes: dto.sizeBytes,
        storage_key: storageKey,
        upload_id: uploadId,
      });
    } catch (error) {
      await this.storageService.abortMultipartUpload(storageKey, uploadId);
      throw error;
    }

    return {
      urlId: video.url_id,
      status: video.status,
      partSize: UPLOAD_PART_SIZE_BYTES,
      partCount: partCountFor(video.size_bytes),
      maxPartsPerRequest: MAX_PARTS_PER_REQUEST,
    };
  }

  /** Presigns `UploadPart` URLs for the owner's draft (phase-03-videos/TD-04, TD-11). */
  async presignUploadParts(
    userId: string,
    urlId: string,
    partNumbers: number[],
  ): Promise<PresignedPartsResult> {
    const video = await this.getUploadableVideo(userId, urlId);
    const partCount = partCountFor(video.size_bytes);
    if (partNumbers.some((n) => n < 1 || n > partCount)) {
      throw new InvalidPartNumberException(partCount);
    }

    const expiresAt = new Date(
      Date.now() + UPLOAD_PART_URL_TTL_SECONDS * 1000,
    ).toISOString();
    const parts = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await this.storageService.presignUploadPart(
          video.storage_key,
          video.upload_id!,
          partNumber,
          UPLOAD_PART_URL_TTL_SECONDS,
        ),
      })),
    );
    return { parts, expiresAt };
  }

  /**
   * Completes the multipart upload after verifying the parts in storage itself
   * (never trusting client-sent ETags), moves the video to `processing` and
   * enqueues it (phase-03-videos/TD-04, TD-10).
   */
  async completeUpload(
    userId: string,
    urlId: string,
  ): Promise<CompleteUploadResult> {
    const video = await this.getUploadableVideo(userId, urlId);
    const uploadId = video.upload_id!;

    let parts: UploadedPart[];
    try {
      parts = await this.storageService.listUploadedParts(
        video.storage_key,
        uploadId,
      );
      assertUploadComplete(parts, video.size_bytes);
      await this.storageService.completeMultipartUpload(
        video.storage_key,
        uploadId,
        parts,
      );
    } catch (error) {
      if (error instanceof StorageUploadNotFoundError) {
        throw new UploadExpiredException();
      }
      throw error;
    }

    video.status = VideoStatus.PROCESSING;
    video.upload_id = null;
    await this.videoRepository.save(video);
    await this.processingProducer.enqueueProcessing(video.id);

    return { urlId: video.url_id, status: video.status };
  }

  /** Owner-only lookup; other users get 404 (phase-03-videos/TD-09). */
  async findOwnedVideo(userId: string, urlId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { url_id: urlId, channel: { user_id: userId } },
    });
    if (!video) throw new VideoNotFoundException();
    return video;
  }

  private async getUploadableVideo(
    userId: string,
    urlId: string,
  ): Promise<Video> {
    const video = await this.findOwnedVideo(userId, urlId);
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new VideoNotUploadableException();
    }
    return video;
  }

  private async insertWithUniqueUrlId(
    fields: Omit<Partial<Video>, 'url_id'>,
  ): Promise<Video> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({ ...fields, url_id: generateUrlId() }),
        );
      } catch (error) {
        if (!isUrlIdCollision(error) || attempt >= URL_ID_MAX_ATTEMPTS) {
          throw error;
        }
      }
    }
  }
}
