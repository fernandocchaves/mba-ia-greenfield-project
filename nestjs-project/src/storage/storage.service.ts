import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import {
  STORAGE_INTERNAL_CLIENT,
  STORAGE_PRESIGN_CLIENT,
} from './storage.constants';
import { StorageUploadNotFoundError } from './storage.errors';

export interface UploadedPart {
  partNumber: number;
  eTag: string;
  size: number;
}

export interface PresignGetOptions {
  expiresInSeconds: number;
  /** When set, the storage answers with `Content-Disposition: attachment`. */
  downloadFilename?: string;
}

const BUCKET_BOOTSTRAP_ATTEMPTS = 10;
const BUCKET_BOOTSTRAP_DELAY_MS = 500;

function isNoSuchUpload(error: unknown): boolean {
  return (error as { name?: string })?.name === 'NoSuchUpload';
}

function isMissingBucket(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}

/**
 * Single entry point to the S3-compatible object storage (phase-03-videos/TD-02).
 * Server-side operations use the internal client; URLs handed to clients are
 * signed with the public client (TD-11).
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);

  constructor(
    @Inject(STORAGE_INTERNAL_CLIENT) private readonly client: S3Client,
    @Inject(STORAGE_PRESIGN_CLIENT) private readonly presigner: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  get bucket(): string {
    return this.config.bucket;
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
  }

  /** Creates the bucket when missing; retries while the storage container starts. */
  async ensureBucket(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
        return;
      } catch (error) {
        if (isMissingBucket(error)) {
          await this.client.send(
            new CreateBucketCommand({ Bucket: this.bucket }),
          );
          this.logger.log(`Created storage bucket "${this.bucket}"`);
          return;
        }
        if (attempt >= BUCKET_BOOTSTRAP_ATTEMPTS) throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, BUCKET_BOOTSTRAP_DELAY_MS),
        );
      }
    }
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const result = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!result.UploadId) {
      throw new Error(`Storage returned no UploadId for "${key}"`);
    }
    return result.UploadId;
  }

  presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds: number,
  ): Promise<string> {
    return getSignedUrl(
      this.presigner,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: expiresInSeconds },
    );
  }

  /** Lists every uploaded part (paginated), sorted by part number. */
  async listUploadedParts(
    key: string,
    uploadId: string,
  ): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;
    try {
      for (;;) {
        const page = await this.client.send(
          new ListPartsCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumberMarker: marker,
          }),
        );
        for (const part of page.Parts ?? []) {
          parts.push({
            partNumber: part.PartNumber!,
            eTag: part.ETag!,
            size: part.Size ?? 0,
          });
        }
        if (!page.IsTruncated) break;
        marker = page.NextPartNumberMarker;
      }
    } catch (error) {
      if (isNoSuchUpload(error)) throw new StorageUploadNotFoundError(key);
      throw error;
    }
    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<void> {
    try {
      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.map((p) => ({
              PartNumber: p.partNumber,
              ETag: p.eTag,
            })),
          },
        }),
      );
    } catch (error) {
      if (isNoSuchUpload(error)) throw new StorageUploadNotFoundError(key);
      throw error;
    }
  }

  /** Aborts a multipart upload; an upload the storage already dropped is not an error. */
  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (error) {
      if (!isNoSuchUpload(error)) throw error;
    }
  }

  presignGetObject(key: string, options: PresignGetOptions): Promise<string> {
    const filename = options.downloadFilename?.replace(/["\\\r\n]/g, '_');
    return getSignedUrl(
      this.presigner,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(filename !== undefined && {
          ResponseContentDisposition: `attachment; filename="${filename}"`,
        }),
      }),
      { expiresIn: options.expiresInSeconds },
    );
  }

  /** Streams an object to a local file without buffering it in memory. */
  async downloadToFile(key: string, filePath: string): Promise<void> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!(result.Body instanceof Readable)) {
      throw new Error(`Storage returned no readable body for "${key}"`);
    }
    await pipeline(result.Body, createWriteStream(filePath));
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }
}
