import type { VideoStatus } from './entities/video.entity';

export interface InitiateUploadResult {
  urlId: string;
  status: VideoStatus;
  partSize: number;
  partCount: number;
  maxPartsPerRequest: number;
}

export interface PresignedPart {
  partNumber: number;
  url: string;
}

export interface PresignedPartsResult {
  parts: PresignedPart[];
  expiresAt: string;
}
