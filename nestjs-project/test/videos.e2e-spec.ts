import { randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ChannelsService } from '../src/channels/channels.service';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../src/videos/videos.constants';
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
  let queue: Queue;

  const validBody = {
    title: 'My first video',
    filename: 'first.mp4',
    contentType: 'video/mp4',
    sizeBytes: 12,
  };

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

  describe('POST /videos/:urlId/upload/complete', () => {
    async function uploadAllParts(token: string, urlId: string, body: Buffer) {
      const res = await http()
        .post(`/videos/${urlId}/upload/parts`)
        .set('Authorization', `Bearer ${token}`)
        .send({ partNumbers: [1] })
        .expect(200);
      const { parts } = res.body as { parts: { url: string }[] };
      const put = await fetch(parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(body),
      });
      expect(put.status).toBe(200);
    }

    it('completes the upload directly sent to storage, marks processing and enqueues one job', async () => {
      const token = await createUserAndLogin(app, 'complete@example.com');
      const { urlId } = (await initiate(token).expect(201)).body as {
        urlId: string;
      };
      await uploadAllParts(token, urlId, Buffer.from('hello world!'));

      const res = await http()
        .post(`/videos/${urlId}/upload/complete`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body).toEqual({ urlId, status: 'processing' });
      const video = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ url_id: urlId });
      expect(video.status).toBe(VideoStatus.PROCESSING);
      // Look the job up in every state: it is never consumed here (isolated test
      // prefix), but the assertion must not depend on that.
      const jobs = await queue.getJobs([
        'waiting',
        'active',
        'delayed',
        'completed',
        'failed',
      ]);
      expect(jobs.filter((j) => j.id === video.id)).toHaveLength(1);
    });

    it('returns 409 UPLOAD_INCOMPLETE when parts are missing', async () => {
      const token = await createUserAndLogin(app, 'missing@example.com');
      const { urlId } = (await initiate(token).expect(201)).body as {
        urlId: string;
      };

      const res = await http()
        .post(`/videos/${urlId}/upload/complete`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);
      expect((res.body as ErrorBody).error).toBe('UPLOAD_INCOMPLETE');
    });

    it('returns 409 VIDEO_NOT_UPLOADABLE when completing twice', async () => {
      const token = await createUserAndLogin(app, 'twice@example.com');
      const { urlId } = (await initiate(token).expect(201)).body as {
        urlId: string;
      };
      await uploadAllParts(token, urlId, Buffer.from('hello world!'));
      await http()
        .post(`/videos/${urlId}/upload/complete`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const res = await http()
        .post(`/videos/${urlId}/upload/complete`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);
      expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_UPLOADABLE');
    });
  });

  describe('GET /videos/:urlId, /playback, /download', () => {
    async function seedReadyVideo(email: string): Promise<string> {
      const user = await dataSource
        .getRepository(User)
        .findOneByOrFail({ email });
      const channel = await app.get(ChannelsService).findByUserId(user.id);
      const id = randomUUID();
      const key = `videos/${id}/source`;
      await app
        .get(StorageService)
        .putObject(key, Buffer.from('0123456789'), 'video/mp4');
      const video = await dataSource.getRepository(Video).save({
        id,
        url_id: id.replace(/-/g, '').slice(0, 11),
        channel_id: channel!.id,
        title: 'Ready',
        status: VideoStatus.READY,
        original_filename: 'ready.mp4',
        content_type: 'video/mp4',
        size_bytes: 10,
        storage_key: key,
        upload_id: null,
        duration_seconds: 1.5,
        processed_at: new Date(),
      });
      return video.url_id;
    }

    it('GET /videos/:urlId returns the video to its owner and 404 to others', async () => {
      const token = await createUserAndLogin(app, 'reader@example.com');
      const other = await createUserAndLogin(app, 'stranger@example.com');
      const urlId = await seedReadyVideo('reader@example.com');

      const res = await http()
        .get(`/videos/${urlId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body).toMatchObject({
        urlId,
        title: 'Ready',
        status: 'ready',
        sizeBytes: 10,
        durationSeconds: 1.5,
        thumbnailUrl: null,
      });

      const denied = await http()
        .get(`/videos/${urlId}`)
        .set('Authorization', `Bearer ${other}`)
        .expect(404);
      expect((denied.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
    });

    it('GET /videos/:urlId/playback returns a URL that streams with 206', async () => {
      const token = await createUserAndLogin(app, 'player@example.com');
      const urlId = await seedReadyVideo('player@example.com');

      const res = await http()
        .get(`/videos/${urlId}/playback`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const { url, expiresAt } = res.body as { url: string; expiresAt: string };
      expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

      const media = await fetch(url, { headers: { Range: 'bytes=0-3' } });
      expect(media.status).toBe(206);
      expect(await media.text()).toBe('0123');
    });

    it('GET /videos/:urlId/download returns an attachment URL', async () => {
      const token = await createUserAndLogin(app, 'saver@example.com');
      const urlId = await seedReadyVideo('saver@example.com');

      const res = await http()
        .get(`/videos/${urlId}/download`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const media = await fetch((res.body as { url: string }).url);
      expect(media.headers.get('content-disposition')).toBe(
        'attachment; filename="ready.mp4"',
      );
    });

    it('playback and download return 409 VIDEO_NOT_READY for a draft', async () => {
      const token = await createUserAndLogin(app, 'early@example.com');
      const { urlId } = (await initiate(token).expect(201)).body as {
        urlId: string;
      };

      for (const path of ['playback', 'download']) {
        const res = await http()
          .get(`/videos/${urlId}/${path}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(409);
        expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_READY');
      }
    });
  });
});
