import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageUploadNotFoundError } from './storage.errors';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageService (integration — real S3-compatible storage)', () => {
  let module: TestingModule;
  let storage: StorageService;
  const prefix = `integration-tests/${randomUUID()}`;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    await module.init(); // runs onModuleInit → ensureBucket
    storage = module.get(StorageService);
  });

  afterAll(async () => {
    await module.close();
  });

  const uploadSingleObject = async (key: string, body: Buffer) => {
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const url = await storage.presignUploadPart(key, uploadId, 1, 60);
    const res = await fetch(url, { method: 'PUT', body: new Uint8Array(body) });
    expect(res.status).toBe(200);
    const parts = await storage.listUploadedParts(key, uploadId);
    await storage.completeMultipartUpload(key, uploadId, parts);
  };

  it('ensureBucket is idempotent', async () => {
    await expect(storage.ensureBucket()).resolves.toBeUndefined();
    await expect(storage.ensureBucket()).resolves.toBeUndefined();
  });

  it('accepts a part PUT on a presigned URL without checksum headers, then lists and completes it', async () => {
    const key = `${prefix}/multipart`;
    const body = Buffer.from('hello multipart upload');
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

    const url = await storage.presignUploadPart(key, uploadId, 1, 60);
    expect(url).not.toMatch(/x-amz-checksum|x-amz-sdk-checksum/i);
    const res = await fetch(url, { method: 'PUT', body: new Uint8Array(body) });
    expect(res.status).toBe(200);

    const parts = await storage.listUploadedParts(key, uploadId);
    expect(parts).toEqual([
      expect.objectContaining({ partNumber: 1, size: body.length }),
    ]);

    await storage.completeMultipartUpload(key, uploadId, parts);

    const dir = await mkdtemp(join(tmpdir(), 'storage-it-'));
    try {
      await storage.downloadToFile(key, join(dir, 'out'));
      expect(await readFile(join(dir, 'out'))).toEqual(body);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('abortMultipartUpload is idempotent and later list raises StorageUploadNotFoundError', async () => {
    const key = `${prefix}/aborted`;
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

    await storage.abortMultipartUpload(key, uploadId);
    await expect(
      storage.abortMultipartUpload(key, uploadId),
    ).resolves.toBeUndefined();
    await expect(
      storage.listUploadedParts(key, uploadId),
    ).rejects.toBeInstanceOf(StorageUploadNotFoundError);
  });

  it('serves a presigned GET with Range as 206 Partial Content', async () => {
    const key = `${prefix}/range`;
    await uploadSingleObject(key, Buffer.from('0123456789abcdefghij'));

    const url = await storage.presignGetObject(key, { expiresInSeconds: 60 });
    const res = await fetch(url, { headers: { Range: 'bytes=0-9' } });

    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-9/20');
    expect(await res.text()).toBe('0123456789');
  });

  it('signs downloads as attachments with the given filename', async () => {
    const key = `${prefix}/download`;
    await uploadSingleObject(key, Buffer.from('download me'));

    const url = await storage.presignGetObject(key, {
      expiresInSeconds: 60,
      downloadFilename: 'My "clip".mp4',
    });
    const res = await fetch(url);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="My _clip_.mp4"',
    );
  });

  it('putObject stores a thumbnail that can be read back', async () => {
    const key = `${prefix}/thumbnail.jpg`;
    await storage.putObject(key, Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg');

    const url = await storage.presignGetObject(key, { expiresInSeconds: 60 });
    const res = await fetch(url);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(
      Buffer.from([0xff, 0xd8, 0xff]),
    );
  });
});
