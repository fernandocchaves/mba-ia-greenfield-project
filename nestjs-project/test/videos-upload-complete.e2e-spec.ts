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
  uploadSinglePart,
} from './helpers/video-test-app';

// Spec: specs/videos-upload-complete.plan.md (SI-03.7)
describe('videos-upload-complete', () => {
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

  const complete = (token: string, urlId: string) =>
    request(app.getHttpServer())
      .post(`/videos/${urlId}/upload/complete`)
      .set('Authorization', `Bearer ${token}`);

  async function draftFor(email: string) {
    const token = await createUserAndLogin(app, email);
    const { urlId } = (await startUpload(app, token).expect(201)).body as {
      urlId: string;
    };
    return { token, urlId };
  }

  describe('POST /videos/:urlId/upload/complete', () => {
    it('complete-upload-marks-processing-and-enqueues-once', async () => {
      const { token, urlId } = await draftFor('complete@example.com');
      expect(
        await uploadSinglePart(app, token, urlId, Buffer.from('hello world!')),
      ).toBe(200);

      const res = await complete(token, urlId).expect(200);

      expect(res.body).toEqual({ urlId, status: 'processing' });
      const video = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ url_id: urlId });
      expect(video.status).toBe(VideoStatus.PROCESSING);
      // Look the job up in every state, so the assertion does not depend on
      // whether a worker consumes it (the test prefix isolates it anyway).
      const jobs = await queue.getJobs([
        'waiting',
        'active',
        'delayed',
        'completed',
        'failed',
      ]);
      expect(jobs.filter((j) => j.id === video.id)).toHaveLength(1);
    });

    it('complete-upload-rejects-missing-parts', async () => {
      const { token, urlId } = await draftFor('missing@example.com');

      const res = await complete(token, urlId).expect(409);

      expect((res.body as ErrorBody).error).toBe('UPLOAD_INCOMPLETE');
      const video = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ url_id: urlId });
      expect(video.status).toBe(VideoStatus.DRAFT);
    });

    it('complete-upload-rejects-non-draft', async () => {
      const { token, urlId } = await draftFor('twice@example.com');
      await uploadSinglePart(app, token, urlId, Buffer.from('hello world!'));
      await complete(token, urlId).expect(200);

      const res = await complete(token, urlId).expect(409);

      expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_UPLOADABLE');
    });
  });
});
