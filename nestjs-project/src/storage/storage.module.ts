import { S3Client } from '@aws-sdk/client-s3';
import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import {
  STORAGE_INTERNAL_CLIENT,
  STORAGE_PRESIGN_CLIENT,
} from './storage.constants';
import { StorageService } from './storage.service';

/**
 * Builds an S3 client for an S3-compatible endpoint.
 *
 * - `forcePathStyle`: MinIO-family servers address buckets by path.
 * - Checksums `WHEN_REQUIRED`: since @aws-sdk v3.729 the SDK adds CRC32
 *   checksums by default, also to presigned URLs; clients that PUT raw parts
 *   cannot satisfy them and S3-compatible servers reject them
 *   (see docs/phases/phase-03-videos/library-refs.md).
 */
function buildClient(
  endpoint: string,
  cfg: ConfigType<typeof storageConfig>,
): S3Client {
  return new S3Client({
    endpoint,
    region: cfg.region,
    credentials: {
      accessKeyId: cfg.accessKey,
      secretAccessKey: cfg.secretKey,
    },
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

@Module({
  providers: [
    {
      provide: STORAGE_INTERNAL_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (cfg: ConfigType<typeof storageConfig>) =>
        buildClient(cfg.endpoint, cfg),
    },
    {
      provide: STORAGE_PRESIGN_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (cfg: ConfigType<typeof storageConfig>) =>
        buildClient(cfg.publicEndpoint, cfg),
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
