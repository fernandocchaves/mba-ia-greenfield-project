import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../videos/videos.constants';
import { VideoProcessingProcessor } from './video-processing.processor';
import { WorkerModule } from './worker.module';

const execFileAsync = promisify(execFile);

async function waitForStatus(
  repo: Repository<Video>,
  id: string,
  expected: VideoStatus,
  timeoutMs = 30_000,
): Promise<Video> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const video = await repo.findOneByOrFail({ id });
    if (video.status === expected) return video;
    if (Date.now() > deadline) {
      throw new Error(
        `Video ${id} stuck in ${video.status}, expected ${expected}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe('WorkerModule (integration — real DB, Redis, storage, FFmpeg)', () => {
  let app: INestApplicationContext;
  let queue: Queue;
  let dataSource: DataSource;
  let videos: Repository<Video>;
  let storage: StorageService;
  let clip: Buffer;

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(WorkerModule, {
      logger: false,
    });
    queue = app.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    await queue.obliterate({ force: true });
    dataSource = app.get(DataSource);
    videos = dataSource.getRepository(Video);
    storage = app.get(StorageService);

    const dir = await mkdtemp(join(tmpdir(), 'worker-it-'));
    await execFileAsync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=320x240:rate=25',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      join(dir, 'clip.mp4'),
    ]);
    clip = await readFile(join(dir, 'clip.mp4'));
    await rm(dir, { recursive: true, force: true });
  }, 60_000);

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  it('boots the worker context with the queue consumer and the test prefix', () => {
    expect(app.get(VideoProcessingProcessor)).toBeInstanceOf(
      VideoProcessingProcessor,
    );
    expect(queue.opts.prefix).toBe('streamtube-test');
  });

  let counter = 0;
  async function enqueueVideo(body: Buffer): Promise<string> {
    counter++;
    const user = await dataSource.getRepository(User).save({
      email: `worker_${counter}@example.com`,
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: `worker${counter}`,
      nickname: `worker_${counter}`,
      user_id: user.id,
    });
    const id = randomUUID();
    const key = `videos/${id}/source`;
    await storage.putObject(key, body, 'video/mp4');
    await videos.save({
      id,
      url_id: id.replace(/-/g, '').slice(0, 11),
      channel_id: channel.id,
      title: 'Worker clip',
      status: VideoStatus.PROCESSING,
      original_filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: body.length,
      storage_key: key,
      upload_id: null,
    });
    await queue.add(
      PROCESS_VIDEO_JOB,
      { videoId: id },
      { jobId: id, attempts: 3 },
    );
    return id;
  }

  it('consumes a real job and takes the video to ready', async () => {
    const id = await enqueueVideo(clip);

    const ready = await waitForStatus(videos, id, VideoStatus.READY);

    expect(ready.duration_seconds).toBeCloseTo(2, 0);
    expect(ready.thumbnail_key).toBe(`videos/${id}/thumbnail.jpg`);
  }, 40_000);

  it('marks an invalid file failed without retrying', async () => {
    const id = await enqueueVideo(Buffer.from('this is not a video'));

    const failed = await waitForStatus(videos, id, VideoStatus.FAILED);

    expect(failed.processing_error).toMatch(/^Invalid media/);
    const job = await queue.getJob(id);
    expect(job?.attemptsMade).toBe(1);
  }, 40_000);
});
