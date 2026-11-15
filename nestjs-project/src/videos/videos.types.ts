import type { VideoMetadata, VideoStatus } from './entities/video.entity';

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

export interface CompleteUploadResult {
  urlId: string;
  status: VideoStatus;
}

export interface VideoDetails {
  urlId: string;
  title: string;
  status: VideoStatus;
  originalFilename: string;
  contentType: string;
  sizeBytes: number;
  durationSeconds: number | null;
  metadata: VideoMetadata | null;
  thumbnailUrl: string | null;
  processingError: string | null;
  createdAt: string;
  processedAt: string | null;
}

export interface SignedUrl {
  url: string;
  expiresAt: string;
}
