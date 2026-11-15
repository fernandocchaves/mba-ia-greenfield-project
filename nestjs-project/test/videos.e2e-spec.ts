import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import {
  clearThrottling,
  createUserAndLogin,
  createVideoTestApp,
} from './helpers/video-test-app';

interface ErrorBody {
  statusCode: number;
  error: string;
}

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;

  const validBody = {
    title: 'My first video',
    filename: 'first.mp4',
    contentType: 'video/mp4',
    sizeBytes: 12,
  };

  beforeAll(async () => {
    app = await createVideoTestApp();
    dataSource = app.get(DataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    clearThrottling(app);
  });

  const http = () => request(app.getHttpServer());

  function initiate(token: string, body = validBody) {
    return http()
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  describe('POST /videos', () => {
    it('returns 201 and pre-registers the video as a draft', async () => {
      const token = await createUserAndLogin(app, 'owner@example.com');

      const res = await initiate(token).expect(201);

      const body = res.body as {
        urlId: string;
        status: string;
        partCount: number;
      };
      expect(body).toEqual({
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

    it('returns 401 without a token', async () => {
      await http().post('/videos').send(validBody).expect(401);
    });

    it('returns 413 VIDEO_TOO_LARGE above 10 GiB', async () => {
      const token = await createUserAndLogin(app, 'big@example.com');
      const res = await initiate(token, {
        ...validBody,
        sizeBytes: 10 * 1024 ** 3 + 1,
      }).expect(413);
      expect((res.body as ErrorBody).error).toBe('VIDEO_TOO_LARGE');
    });

    it('returns 400 VALIDATION_ERROR for a non-video content type', async () => {
      const token = await createUserAndLogin(app, 'pdf@example.com');
      const res = await initiate(token, {
        ...validBody,
        contentType: 'application/pdf',
      }).expect(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /videos/:urlId/upload/parts', () => {
    it('returns presigned URLs for the owner', async () => {
      const token = await createUserAndLogin(app, 'parts@example.com');
      const { urlId } = (await initiate(token).expect(201)).body as {
        urlId: string;
      };

      const res = await http()
        .post(`/videos/${urlId}/upload/parts`)
        .set('Authorization', `Bearer ${token}`)
        .send({ partNumbers: [1] })
        .expect(200);

      const body = res.body as { parts: { partNumber: number; url: string }[] };
      expect(body.parts).toHaveLength(1);
      expect(body.parts[0].partNumber).toBe(1);
      expect(body.parts[0].url).toContain('X-Amz-Signature');
    });

    it('returns 404 VIDEO_NOT_FOUND for another user', async () => {
      const owner = await createUserAndLogin(app, 'a@example.com');
      const other = await createUserAndLogin(app, 'b@example.com');
      const { urlId } = (await initiate(owner).expect(201)).body as {
        urlId: string;
      };

      const res = await http()
        .post(`/videos/${urlId}/upload/parts`)
        .set('Authorization', `Bearer ${other}`)
        .send({ partNumbers: [1] })
        .expect(404);
      expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 400 INVALID_PART_NUMBER beyond the part count', async () => {
      const token = await createUserAndLogin(app, 'range@example.com');
      const { urlId } = (await initiate(token).expect(201)).body as {
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
