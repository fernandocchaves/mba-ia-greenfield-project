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
  ErrorBody,
  clearThrottling,
  createUserAndLogin,
  createVideoTestApp,
  startUpload,
} from './helpers/video-test-app';

// Spec: specs/videos-read.plan.md (SI-03.8)
describe('videos-read', () => {
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

  const get = (token: string, path: string) =>
    request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${token}`);

  /** A `ready` video (row + 2 KiB object in storage) owned by `email`. */
  async function seedReadyVideo(email: string): Promise<string> {
    const user = await dataSource
      .getRepository(User)
      .findOneByOrFail({ email });
    const channel = await app.get(ChannelsService).findByUserId(user.id);
    const id = randomUUID();
    const key = `videos/${id}/source`;
    const body = Buffer.alloc(2048, 'v');
    await app.get(StorageService).putObject(key, body, 'video/mp4');
    const video = await dataSource.getRepository(Video).save({
      id,
      url_id: id.replace(/-/g, '').slice(0, 11),
      channel_id: channel!.id,
      title: 'Ready',
      status: VideoStatus.READY,
      original_filename: 'ready.mp4',
      content_type: 'video/mp4',
      size_bytes: body.length,
      storage_key: key,
      upload_id: null,
      duration_seconds: 1.5,
      processed_at: new Date(),
    });
    return video.url_id;
  }

  describe('GET /videos/:urlId', () => {
    it('get-video-returns-details-to-owner', async () => {
      const token = await createUserAndLogin(app, 'reader@example.com');
      const urlId = await seedReadyVideo('reader@example.com');

      const res = await get(token, `/videos/${urlId}`).expect(200);

      expect(res.body).toMatchObject({
        urlId,
        title: 'Ready',
        status: 'ready',
        sizeBytes: 2048,
        durationSeconds: 1.5,
        thumbnailUrl: null,
        processingError: null,
      });
    });

    it('get-video-hides-videos-of-other-users', async () => {
      await createUserAndLogin(app, 'reader@example.com');
      const other = await createUserAndLogin(app, 'stranger@example.com');
      const urlId = await seedReadyVideo('reader@example.com');

      const res = await get(other, `/videos/${urlId}`).expect(404);

      expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('GET /videos/:urlId/playback', () => {
    it('playback-url-streams-with-partial-content', async () => {
      const token = await createUserAndLogin(app, 'player@example.com');
      const urlId = await seedReadyVideo('player@example.com');

      const res = await get(token, `/videos/${urlId}/playback`).expect(200);

      const { url, expiresAt } = res.body as { url: string; expiresAt: string };
      expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
      const media = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
      expect(media.status).toBe(206);
      expect(media.headers.get('content-range')).toBe('bytes 0-1023/2048');
      expect((await media.arrayBuffer()).byteLength).toBe(1024);
    });
  });

  describe('GET /videos/:urlId/download', () => {
    it('download-url-serves-attachment', async () => {
      const token = await createUserAndLogin(app, 'saver@example.com');
      const urlId = await seedReadyVideo('saver@example.com');

      const res = await get(token, `/videos/${urlId}/download`).expect(200);

      const { url, expiresAt } = res.body as { url: string; expiresAt: string };
      expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
      const media = await fetch(url);
      expect(media.status).toBe(200);
      expect(media.headers.get('content-disposition')).toBe(
        'attachment; filename="ready.mp4"',
      );
    });
  });

  describe('Not ready', () => {
    it.each(['playback', 'download'])(
      '%s-rejects-video-not-ready',
      async (path) => {
        const token = await createUserAndLogin(
          app,
          `early-${path}@example.com`,
        );
        const { urlId } = (await startUpload(app, token).expect(201)).body as {
          urlId: string;
        };

        const res = await get(token, `/videos/${urlId}/${path}`).expect(409);

        expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_READY');
      },
    );
  });
});
