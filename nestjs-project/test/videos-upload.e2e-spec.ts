import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../src/videos/videos.constants';
import {
  ErrorBody,
  clearThrottling,
  createUserAndLogin,
  createVideoTestApp,
  startUpload,
  validUploadBody,
} from './helpers/video-test-app';

// Spec: specs/videos-upload.plan.md (SI-03.6)
describe('videos-upload', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let queue: Queue;

  beforeAll(async () => {
    app = await createVideoTestApp();
    dataSource = app.get(DataSource);
    queue = app.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
    clearThrottling(app);
  });

  const http = () => request(app.getHttpServer());

  describe('POST /videos', () => {
    it('initiate-upload-creates-draft', async () => {
      const token = await createUserAndLogin(app, 'owner@example.com');

      const res = await startUpload(app, token).expect(201);

      const body = res.body as { urlId: string };
      expect(res.body).toEqual({
        urlId: expect.stringMatching(/^[A-Za-z0-9_-]{11}$/) as unknown,
        status: 'draft',
        partSize: 67108864,
        partCount: 1,
        maxPartsPerRequest: 100,
      });
      const video = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ url_id: body.urlId });
      expect(video.status).toBe(VideoStatus.DRAFT);
      expect(video.title).toBe('My first video');
    });

    it('initiate-upload-accepts-exactly-10-gib', async () => {
      const token = await createUserAndLogin(app, 'max@example.com');

      const res = await startUpload(app, token, {
        ...validUploadBody,
        sizeBytes: 10 * 1024 ** 3,
      }).expect(201);

      expect((res.body as { partCount: number }).partCount).toBe(160);
    });

    it('initiate-upload-rejects-above-10-gib', async () => {
      const token = await createUserAndLogin(app, 'big@example.com');

      const res = await startUpload(app, token, {
        ...validUploadBody,
        sizeBytes: 10 * 1024 ** 3 + 1,
      }).expect(413);

      expect((res.body as ErrorBody).error).toBe('VIDEO_TOO_LARGE');
      expect(await dataSource.getRepository(Video).count()).toBe(0);
    });

    it('initiate-upload-requires-token', async () => {
      await http().post('/videos').send(validUploadBody).expect(401);
    });

    it('initiate-upload-rejects-non-video-content-type', async () => {
      const token = await createUserAndLogin(app, 'pdf@example.com');

      const res = await startUpload(app, token, {
        ...validUploadBody,
        contentType: 'application/pdf',
      }).expect(400);

      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /videos/:urlId/upload/parts', () => {
    it('presign-parts-returns-one-url-per-part', async () => {
      const token = await createUserAndLogin(app, 'parts@example.com');
      const { urlId } = (await startUpload(app, token).expect(201)).body as {
        urlId: string;
      };

      const res = await http()
        .post(`/videos/${urlId}/upload/parts`)
        .set('Authorization', `Bearer ${token}`)
        .send({ partNumbers: [1] })
        .expect(200);

      const body = res.body as {
        parts: { partNumber: number; url: string }[];
        expiresAt: string;
      };
      expect(body.parts).toHaveLength(1);
      expect(body.parts[0].partNumber).toBe(1);
      expect(body.parts[0].url).toContain('X-Amz-Signature');
      expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('presign-parts-hides-videos-of-other-users', async () => {
      const owner = await createUserAndLogin(app, 'a@example.com');
      const other = await createUserAndLogin(app, 'b@example.com');
      const { urlId } = (await startUpload(app, owner).expect(201)).body as {
        urlId: string;
      };

      const res = await http()
        .post(`/videos/${urlId}/upload/parts`)
        .set('Authorization', `Bearer ${other}`)
        .send({ partNumbers: [1] })
        .expect(404);

      expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
    });

    it('presign-parts-rejects-part-beyond-part-count', async () => {
      const token = await createUserAndLogin(app, 'range@example.com');
      const { urlId } = (await startUpload(app, token).expect(201)).body as {
        urlId: string;
      };

      const res = await http()
        .post(`/videos/${urlId}/upload/parts`)
        .set('Authorization', `Bearer ${token}`)
        .send({ partNumbers: [2] })
        .expect(400);

      expect((res.body as ErrorBody).error).toBe('INVALID_PART_NUMBER');
    });
  });
});
