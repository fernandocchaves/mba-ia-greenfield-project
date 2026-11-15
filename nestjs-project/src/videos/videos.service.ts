import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { generateUrlId } from './url-id.util';
import {
  InvalidPartNumberException,
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
